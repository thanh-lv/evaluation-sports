#!/usr/bin/env bash
# M5 database suite on the real local Supabase stack (DESIGN.md §13.1 `bash supabase/tests/sql/run.sh`):
#   1. start the stack if it is not running (SUPABASE_INTERNAL_IMAGE_REGISTRY and other env pass through untouched)
#   2. supabase db reset            migrations 0100–0900 + seed.sql
#   3. supabase test db             pgTAP files in supabase/tests/database
#   4. concurrency.sh               two concurrent psql sessions on reserve_for_submit
#   5. fixtures.sh                  free redaction vs shared/fixtures/results
#   6. api_smoke.sh                 GoTrue / PostgREST / Storage through the local gateway
# Every step runs; the exit status is 1 if any failed. The stack is left RUNNING (no `supabase stop`).
#
# Env: SUPABASE_CLI_VERSION (2.119.0), SUPABASE_START_EXCLUDE (services skipped by `start`), SKIP_RESET=1 to test
# the current database without a reset, ROUNDS / HOLD_S for concurrency.sh, DB_URL.
# WARNING: `db reset` wipes the local database (users, analyses) — other local work included.
set -uo pipefail
# shellcheck source=supabase/tests/sql/_lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
cd "$REPO_ROOT"

EXCLUDE="${SUPABASE_START_EXCLUDE-studio,logflare,vector,imgproxy,realtime,postgres-meta,supavisor}"

names=()
results=()
step() {
  local name="$1"
  shift
  echo
  echo "==> $name"
  if "$@"; then results+=("PASS"); else results+=("FAIL"); fi
  names+=("$name")
}

ensure_stack() {
  if "${SB[@]}" status >/dev/null 2>&1; then
    echo "local stack already running"
    return 0
  fi
  if [[ -n "$EXCLUDE" ]]; then
    "${SB[@]}" start -x "$EXCLUDE"
  else
    "${SB[@]}" start
  fi
}

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "run.sh: Docker is not available; start Docker (Docker Desktop / OrbStack / Colima) first"
  exit 1
fi

step "supabase start (if needed)" ensure_stack
if [[ "${results[0]}" != "PASS" ]]; then
  echo "run.sh: the local stack did not start"
  exit 1
fi
if [[ "${SKIP_RESET:-0}" != "1" ]]; then
  step "supabase db reset" "${SB[@]}" db reset
  if [[ "${results[${#results[@]}-1]}" != "PASS" ]]; then  # bash 3.2 (macOS): no negative indices
    echo "run.sh: db reset failed (a migration or seed.sql error is printed above); not running the tests"
    exit 1
  fi
fi
step "supabase test db (pgTAP)" "${SB[@]}" test db supabase/tests/database
step "concurrency.sh" bash "$SQL_TESTS_DIR/concurrency.sh"
step "fixtures.sh" bash "$SQL_TESTS_DIR/fixtures.sh"
step "api_smoke.sh" bash "$SQL_TESTS_DIR/api_smoke.sh"

echo
echo "SQL suite summary"
failed=0
for i in "${!names[@]}"; do
  printf '  %-30s %s\n' "${names[$i]}" "${results[$i]}"
  [[ "${results[$i]}" == "PASS" ]] || failed=1
done
if [[ $failed -ne 0 ]]; then
  echo "run.sh: FAILED"
  exit 1
fi
echo "run.sh: OK (stack left running)"
