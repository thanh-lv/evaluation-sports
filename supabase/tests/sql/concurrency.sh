#!/usr/bin/env bash
# Concurrency proof for private.reserve_for_submit (DESIGN.md §6.5, M5): two psql sessions call it at the same time;
# each keeps its transaction open for a moment after the call, so without the per-user advisory lock both would read
# the same counters/in-flight state and double-book. Scenarios, ROUNDS times each (default 3):
#   1. in-flight race   two prepared analyses → exactly one queued, the other gets in_flight
#   2. quota race       1 free analysis left (max_in_flight raised to 5) → one ok, one quota_exceeded, used = 2
#   3. bonus race       first-ever bonus offered to both → exactly one standard analysis
#   4. same analysis    two submits of one analysis → one reservation, one idempotent answer, used = 1
# Needs the local stack with the migrations applied (run.sh does that). Test users use @concurrency.test emails and
# are deleted at the end; free.max_in_flight is restored even on failure. Exit status 1 on any failure.
set -euo pipefail
# shellcheck source=supabase/tests/sql/_lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

ROUNDS="${ROUNDS:-3}"
HOLD_S="${HOLD_S:-1}"
WORK="$(mktemp -d)"
ORIG_IN_FLIGHT="$(psql_value -c "select max_in_flight from public.plan_limits where tier = 'free'")"

cleanup() {
  psql_local -c "update public.plan_limits set max_in_flight = ${ORIG_IN_FLIGHT:-1} where tier = 'free'" >/dev/null || true
  psql_local -c "delete from auth.users where email like '%@concurrency.test'" >/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# new_user <label> → user id (profile created by the auth trigger)
new_user() {
  psql_value -c "insert into auth.users (instance_id, id, aud, role, email, raw_app_meta_data, raw_user_meta_data,
      created_at, updated_at)
    values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
      '$1-' || gen_random_uuid() || '@concurrency.test', '{}', '{}', now(), now())
    returning id"
}

# new_analysis <user id> → analysis id (status prepared)
new_analysis() {
  psql_value -c "insert into public.analyses (id, user_id, sport, skill)
    values (gen_random_uuid(), '$1', 'badminton', 'bd.clear_fh') returning id"
}

# reserve_pair <user> <analysis 1> <analysis 2> <bonus 1> <bonus 2>: both sessions start together and hold their
# transaction HOLD_S seconds after the call. Prints the two `code-or-kind` answers, sorted.
reserve_pair() {
  local i
  for i in 1 2; do
    local aid="$2" bonus="$4"
    if [[ $i == 2 ]]; then aid="$3" bonus="$5"; fi
    psql_value >"$WORK/s$i.out" 2>"$WORK/s$i.err" <<SQL &
begin;
select coalesce(r ->> 'code', (r ->> 'kind') || case when (r ->> 'idempotent')::boolean then ':idempotent' else '' end)
from private.reserve_for_submit('$1', '$aid', $bonus) r;
select pg_sleep($HOLD_S);
commit;
SQL
  done
  wait
  for i in 1 2; do
    if [[ -s "$WORK/s$i.err" ]]; then
      echo "session $i error: $(cat "$WORK/s$i.err")" >&2
    fi
  done
  sort <(grep -v '^$' "$WORK/s1.out") <(grep -v '^$' "$WORK/s2.out") | paste -s -d ' ' -
}

counters() { # user → "used/used_standard" of the current period
  psql_value -c "select coalesce(max(used), 0) || '/' || coalesce(max(used_standard), 0) from public.usage_counters
    where user_id = '$1' and period_key <> 'lifetime'"
}
ledger_rows() {
  psql_value -c "select count(*) from public.quota_ledger where user_id = '$1'"
}

echo "concurrency.sh: $ROUNDS round(s), sessions hold their transaction ${HOLD_S}s"
for round in $(seq 1 "$ROUNDS"); do
  echo "round $round"

  # 1. in-flight race (production limits: max_in_flight = 1)
  psql_local -c "update public.plan_limits set max_in_flight = ${ORIG_IN_FLIGHT} where tier = 'free'" >/dev/null
  u="$(new_user inflight)"
  a1="$(new_analysis "$u")"
  a2="$(new_analysis "$u")"
  expect_eq "in-flight race: one basic reservation, one in_flight" "basic in_flight" \
    "$(reserve_pair "$u" "$a1" "$a2" false false)"
  expect_eq "in-flight race: one analysis queued" "1" \
    "$(psql_value -c "select count(*) from public.analyses where user_id = '$u' and status = 'queued'")"
  expect_eq "in-flight race: counters 1/0, one ledger row" "1/0 1" "$(counters "$u") $(ledger_rows "$u")"

  # 2-3 isolate the quota and bonus logic from the in-flight cap
  psql_local -c "update public.plan_limits set max_in_flight = 5 where tier = 'free'" >/dev/null

  # 2. quota race: 1 of 2 left this month
  u="$(new_user quota)"
  psql_local -c "insert into public.usage_counters (user_id, period_key, used)
    values ('$u', to_char(now() at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM'), 1),
           ('$u', 'lifetime', 1)" >/dev/null
  a1="$(new_analysis "$u")"
  a2="$(new_analysis "$u")"
  expect_eq "quota race: one reservation, one quota_exceeded" "basic quota_exceeded" \
    "$(reserve_pair "$u" "$a1" "$a2" false false)"
  expect_eq "quota race: counter used = 2 (limit), one ledger row" "2/0 1" "$(counters "$u") $(ledger_rows "$u")"

  # 3. bonus race: first-ever standard offered to both submits
  u="$(new_user bonus)"
  a1="$(new_analysis "$u")"
  a2="$(new_analysis "$u")"
  expect_eq "bonus race: exactly one standard" "basic standard" "$(reserve_pair "$u" "$a1" "$a2" true true)"
  expect_eq "bonus race: used 2, standard 1, bonus recorded once" "2/1 t" \
    "$(counters "$u") $(psql_value -c "select bonus_used from public.usage_counters
      where user_id = '$u' and period_key = 'lifetime'")"

  # 4. the same analysis submitted twice at once
  psql_local -c "update public.plan_limits set max_in_flight = ${ORIG_IN_FLIGHT} where tier = 'free'" >/dev/null
  u="$(new_user same)"
  a1="$(new_analysis "$u")"
  expect_eq "same analysis: one reservation, one idempotent answer" "basic basic:idempotent" \
    "$(reserve_pair "$u" "$a1" "$a1" false false)"
  expect_eq "same analysis: counted once" "1/0 1" "$(counters "$u") $(ledger_rows "$u")"
done

if [[ $FAILURES -ne 0 ]]; then
  echo "concurrency.sh: $FAILURES failure(s)"
  exit 1
fi
echo "concurrency.sh: OK"
