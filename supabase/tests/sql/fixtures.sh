#!/usr/bin/env bash
# Cross-checks the SQL free redaction against the shared contract fixtures: get_result's private.redact_result_free
# applied to shared/fixtures/results/example_full.json must equal example_free.json (CONTRACTS.md "A free result").
set -euo pipefail
# shellcheck source=supabase/tests/sql/_lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

FULL="$REPO_ROOT/shared/fixtures/results/example_full.json"
FREE="$REPO_ROOT/shared/fixtures/results/example_free.json"

echo "fixtures.sh: free redaction vs shared/fixtures/results"
for f in "$FULL" "$FREE"; do
  [[ -f "$f" ]] || { echo "missing $f"; exit 1; }
done

diff_keys="$(psql_value -v full="$(cat "$FULL")" -v free="$(cat "$FREE")" <<'SQL'
select coalesce(string_agg(k, ','), '')
from (
  select k from jsonb_object_keys(private.redact_result_free(:'full'::jsonb) || :'free'::jsonb) k
  where private.redact_result_free(:'full'::jsonb) -> k is distinct from :'free'::jsonb -> k
) d;
SQL
)"
expect_eq "redact_result_free(example_full) = example_free (differing keys: ${diff_keys:-none})" "" "$diff_keys"

expect_eq "the full fixture is stored unchanged apart from access/locked" "t" "$(psql_value -v full="$(cat "$FULL")" <<'SQL'
select (:'full'::jsonb || '{"access": "full", "locked": {"strengths": 0, "weaknesses": 0, "plan": 0}}') = :'full'::jsonb;
SQL
)"

if [[ $FAILURES -ne 0 ]]; then
  echo "fixtures.sh: $FAILURES failure(s)"
  exit 1
fi
echo "fixtures.sh: OK"
