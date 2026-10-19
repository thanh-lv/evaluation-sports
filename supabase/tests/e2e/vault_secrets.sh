#!/usr/bin/env bash
# Local dev only: stores the Vault secrets the pg_cron jobs need (migration 0900: project_url, internal_secret,
# cron_secret) in the LOCAL database, so `private.dispatch_due_jobs` and `private.call_cron_task` reach the functions
# served by `supabase functions serve`. Values come from the same env file the functions use, so the shared secrets
# match. Re-running updates the values. `supabase db reset` wipes them (run this again afterwards).
#
#   bash supabase/tests/e2e/vault_secrets.sh [env-file]     # default supabase/functions/.env.local, then .env
#
# Never point this at a hosted project: there, set the three secrets in the dashboard (docs/database.md).
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/../../.." && pwd)"
ENV_FILE="${1:-}"
if [[ -z "$ENV_FILE" ]]; then
  for f in "$ROOT/supabase/functions/.env.local" "$ROOT/supabase/functions/.env"; do
    [[ -f "$f" ]] && ENV_FILE="$f" && break
  done
fi
[[ -n "$ENV_FILE" && -f "$ENV_FILE" ]] || { echo "env file not found (pass one, or create supabase/functions/.env.local)" >&2; exit 1; }

value() { sed -n "s/^$1=\(.*\)$/\1/p" "$ENV_FILE" | tail -1 | tr -d '"'; }
INTERNAL="$(value INTERNAL_SECRET)"
CRON="$(value CRON_SECRET)"
[[ -n "$INTERNAL" && -n "$CRON" ]] || { echo "$ENV_FILE must set INTERNAL_SECRET and CRON_SECRET" >&2; exit 1; }

PROJECT_ID="$(sed -n 's/^project_id = "\(.*\)"/\1/p' "$ROOT/supabase/config.toml")"
# Kong as seen from the db container (pg_net runs inside it).
URL="${PROJECT_URL:-http://supabase_kong_${PROJECT_ID}:8000}"
DB_URL="${DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
case "$DB_URL" in
  *@127.0.0.1:*|*@localhost:*) ;;
  *) echo "refusing to write Vault secrets to a non-local database: $DB_URL" >&2; exit 1 ;;
esac

SQL=$(cat <<'EOF'
select vault.create_secret(:'v', :'n') where not exists (select 1 from vault.secrets where name = :'n');
select vault.update_secret(id, :'v') from vault.secrets where name = :'n';
EOF
)

run_psql() {
  if command -v psql >/dev/null 2>&1; then
    psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 "$@"
  else
    docker exec -i "supabase_db_${PROJECT_ID}" psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 "$@"
  fi
}

for pair in "project_url=$URL" "internal_secret=$INTERNAL" "cron_secret=$CRON"; do
  name="${pair%%=*}"
  printf '%s\n' "$SQL" | run_psql -v n="$name" -v v="${pair#*=}" >/dev/null
  echo "vault: $name set"
done
echo "pg_cron will now call $URL/functions/v1/analyze/run and /cron (serve the functions with $ENV_FILE)."
