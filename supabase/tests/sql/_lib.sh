#!/usr/bin/env bash
# Shared helpers for the SQL test scripts (sourced, not executed). No .sql files live in this folder on purpose:
# `supabase test db` runs every *.sql under supabase/tests as a pgTAP file.

SQL_TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SQL_TESTS_DIR/../../.." && pwd)"
SUPABASE_CLI_VERSION="${SUPABASE_CLI_VERSION:-2.119.0}"
SB=(npx -y "supabase@${SUPABASE_CLI_VERSION}")
DB_URL="${DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
PROJECT_ID="$(sed -n 's/^project_id = "\(.*\)"/\1/p' "$REPO_ROOT/supabase/config.toml")"

# psql against the local stack: the host psql when installed, otherwise the one inside the db container (Mac users
# often have no psql). Extra arguments are passed through; SQL comes on stdin or via -c.
psql_local() {
  if command -v psql >/dev/null 2>&1; then
    psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 "$@"
  else
    docker exec -i "supabase_db_${PROJECT_ID}" psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 "$@"
  fi
}

# Single value (tuples only, unaligned).
psql_value() {
  psql_local -t -A "$@"
}

# `supabase status -o env` value, e.g. sb_env API_URL.
sb_env() {
  (cd "$REPO_ROOT" && "${SB[@]}" status -o env 2>/dev/null) | sed -n "s/^$1=\"\(.*\)\"$/\1/p"
}

FAILURES=0
pass() { printf '  ok   %s\n' "$1"; }
fail() {
  printf '  FAIL %s\n' "$1"
  FAILURES=$((FAILURES + 1))
}
# expect_eq <description> <expected> <actual>
expect_eq() {
  if [[ "$2" == "$3" ]]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi
}
