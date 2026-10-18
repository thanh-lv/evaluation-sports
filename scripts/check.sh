#!/usr/bin/env bash
# All Linux-verifiable checks (DESIGN.md §13.1). Runs every step, prints a summary table, exits 1 on any failure.
#
# Deno config: there is ONE config, supabase/functions/deno.json (pinned imports, "@shared/" alias, fmt/lint rules,
# "lock": false). Code outside supabase/functions (scripts/, supabase/tests/) is checked/run with
# `--config supabase/functions/deno.json` so it resolves the same import map.
#
# Optional steps are skipped with a notice until their files exist (SQL tests, iOS resources, Web Lab).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

D="npx -y deno@${DENO_VERSION:-2.9.6}"
CFG=(--config supabase/functions/deno.json)
# List the Deno roots explicitly: with --config pointing inside supabase/functions, `deno fmt/lint supabase` silently
# skips supabase/tests (only files under the config's directory are walked), so a bare `supabase` would hide errors.
DENO_DIRS=(supabase/functions supabase/tests scripts)

names=()
results=()
durations=()
failed=0

run_step() {
  local name="$1"
  shift
  local start end
  start=$(date +%s)
  echo
  echo "==> ${name}"
  if "$@"; then
    results+=("PASS")
  else
    results+=("FAIL")
    failed=1
  fi
  end=$(date +%s)
  names+=("$name")
  durations+=("$((end - start))s")
}

skip_step() {
  echo
  echo "==> $1 (skipped: $2)"
  names+=("$1")
  results+=("SKIP")
  durations+=("-")
}

# Deno type-check targets: every .ts under supabase/functions and supabase/tests, plus scripts/.
ts_targets() {
  find supabase/functions supabase/tests scripts -name '*.ts' -not -path '*/node_modules/*' | sort
}

run_step "deno fmt --check" $D fmt "${CFG[@]}" --check "${DENO_DIRS[@]}"
run_step "deno lint" $D lint "${CFG[@]}" "${DENO_DIRS[@]}"
# shellcheck disable=SC2046
run_step "deno check" $D check "${CFG[@]}" $(ts_targets)
run_step "deno test" $D test -A "${CFG[@]}" supabase/tests
run_step "gen-schemas --check (sync + audit)" $D run -A "${CFG[@]}" scripts/gen-schemas.ts --check
run_step "gen-minimal-fixture --check" $D run -A "${CFG[@]}" scripts/gen-minimal-fixture.ts --check

if [[ -f supabase/tests/sql/run.sh ]]; then
  run_step "sql tests (PG16)" bash supabase/tests/sql/run.sh
else
  skip_step "sql tests (PG16)" "supabase/tests/sql/run.sh not present yet"
fi

if [[ -f scripts/check_ios_resources.py ]]; then
  run_step "ios resources" python3 -I scripts/check_ios_resources.py
else
  skip_step "ios resources" "scripts/check_ios_resources.py not present yet"
fi

if [[ -f weblab/package.json ]]; then
  if [[ -d weblab/node_modules ]]; then
    run_step "weblab tests" npm --prefix weblab test --silent
  else
    skip_step "weblab tests" "run 'npm --prefix weblab ci' first"
  fi
else
  skip_step "weblab tests" "weblab/package.json not present yet"
fi

echo
echo "Summary"
printf '%-40s %-6s %s\n' "STEP" "RESULT" "TIME"
printf '%-40s %-6s %s\n' "----" "------" "----"
for i in "${!names[@]}"; do
  printf '%-40s %-6s %s\n' "${names[$i]}" "${results[$i]}" "${durations[$i]}"
done

if [[ $failed -ne 0 ]]; then
  echo
  echo "check.sh: FAILED"
  exit 1
fi
echo
echo "check.sh: OK"
