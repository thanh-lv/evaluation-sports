#!/usr/bin/env bash
# All Linux-verifiable checks (DESIGN.md §13.1). Runs every step, prints a summary table, exits 1 on any failure.
#
# Deno config: there is ONE config, supabase/functions/deno.json (pinned imports, "@shared/" alias, fmt/lint rules,
# "lock": false). Code outside supabase/functions (scripts/, supabase/tests/) is checked/run with
# `--config supabase/functions/deno.json` so it resolves the same import map.
#
# Optional steps are skipped with a notice when their tool or files are missing:
# - SQL suite (supabase/tests/sql/run.sh): needs a running Docker daemon. It starts the local Supabase stack if needed
#   and runs `supabase db reset`, which WIPES the local database; set SKIP_SQL=1 to skip it, or SKIP_RESET=1 to test
#   the current database without a reset.
# - e2e flow (supabase/tests/e2e): needs Docker and a running local stack (the SQL step starts it). It serves the
#   functions in mock mode (`supabase functions serve`, CLAUDE_MODE=mock) and drives prepare → frames → submit →
#   result → quota. Set SKIP_E2E=1 to skip it. The plain `deno test` step ignores supabase/tests/e2e.
# - CoachCore Swift tests: need `swift` on PATH (Xcode on a Mac, or a Linux Swift 6 toolchain).
# - iOS resources, Web Lab: until their files exist.
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
run_step "deno test" $D test -A "${CFG[@]}" --ignore=supabase/tests/e2e supabase/tests
run_step "gen-schemas --check (sync + audit)" $D run -A "${CFG[@]}" scripts/gen-schemas.ts --check
run_step "gen-minimal-fixture --check" $D run -A "${CFG[@]}" scripts/gen-minimal-fixture.ts --check
run_step "gen-synthetic-pose --check" $D run -A "${CFG[@]}" scripts/gen-synthetic-pose.ts --check
run_step "replay --golden --check" $D run -A "${CFG[@]}" scripts/replay.ts --golden --check
run_step "fit-contact-offsets --check" $D run -A "${CFG[@]}" scripts/fit-contact-offsets.ts --check

docker_ready() {
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1
}

if [[ "${SKIP_SQL:-0}" == "1" ]]; then
  skip_step "sql tests (local Supabase)" "SKIP_SQL=1"
elif ! docker_ready; then
  skip_step "sql tests (local Supabase)" "Docker is not available; start it to run supabase/tests/sql/run.sh"
else
  run_step "sql tests (local Supabase)" bash supabase/tests/sql/run.sh
fi

stack_ready() {
  command -v curl >/dev/null 2>&1 &&
    curl -fs -o /dev/null --max-time 5 "${SUPABASE_URL:-http://127.0.0.1:54321}/auth/v1/health"
}

if [[ "${SKIP_E2E:-0}" == "1" || "${RC_SKIP_E2E:-0}" == "1" ]]; then
  skip_step "e2e flow (local stack, mock Claude)" "SKIP_E2E=1"
elif ! docker_ready; then
  skip_step "e2e flow (local stack, mock Claude)" "Docker is not available"
elif ! stack_ready; then
  skip_step "e2e flow (local stack, mock Claude)" "local Supabase stack not running (npx supabase start)"
else
  # RC_E2E_REQUIRE=1: the test fails instead of skipping itself when it cannot reach the stack.
  run_step "e2e flow (local stack, mock Claude)" env RC_E2E_REQUIRE=1 $D test -A "${CFG[@]}" supabase/tests/e2e
fi

if command -v swift >/dev/null 2>&1; then
  run_step "CoachCore swift test" swift test --package-path ios/Packages/CoachCore
else
  skip_step "CoachCore swift test" "swift not on PATH (build on a Mac or with a Swift 6 toolchain)"
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
