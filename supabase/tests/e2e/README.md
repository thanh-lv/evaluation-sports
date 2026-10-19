# End-to-end flow (local stack, mock Claude)

`flow.test.ts` drives the whole MVP server path the way the app does:

1. anonymous sign-in (GoTrue), then the profile's birth year and the current consent versions;
2. `GET /analyze/catalog`;
3. `POST /analyze/prepare` with a synthetic `pose.v1` (`shared/fixtures/pose/synthetic_bd_clear_fh_60.json`);
4. upload of the 5 requested JPEG frames to `analysis-inputs/{uid}/{id}/frames/`;
5. `POST /analyze/submit` → 202, then polling `analyses.status` until `succeeded`;
6. `rpc get_result` → a valid `coach-result.v1` with the free redaction, frames deleted, `pose.clean.json` readable;
7. a second free analysis uses the quota (`my_status`), the third gets 402 `quota_exceeded` and stays `prepared`;
8. `/analyze/run` and `/cron` refuse callers without their secrets and answer 202 with them.

The model is the deterministic mock (`CLAUDE_MODE=mock`): no network, no cost.

## Run it

```bash
npx -y supabase@2.119.0 start            # once; the test is skipped when the stack is not running
npx -y deno@2.9.6 test -A --config supabase/functions/deno.json supabase/tests/e2e/
```

The test writes a temporary mock-mode env file (random `INTERNAL_SECRET` / `CRON_SECRET`), starts
`npx supabase functions serve --env-file <file> --no-verify-jwt` itself, waits for the `analyze` worker to boot (the
first boot downloads the npm packages, up to a few minutes), and stops it at the end. The test user and its Storage
objects are deleted afterwards. It takes about 25 s once the packages are cached.

| Variable                                        | Effect                                                                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `RC_SKIP_E2E=1`                                 | Skip the test (for example inside `scripts/check.sh` runs that should not start the edge runtime)                  |
| `RC_E2E_ENV_FILE=supabase/functions/.env.local` | Serve with your own env file instead of the generated one (it must set `CLAUDE_MODE=mock`)                         |
| `RC_E2E_SERVE=0`                                | Do not start `functions serve`; use the one you already run (pass `RC_E2E_ENV_FILE` so the test knows the secrets) |
| `SUPABASE_CLI_VERSION`                          | CLI version for `npx supabase` (default 2.119.0)                                                                   |

`supabase/functions/.env.local` is gitignored. A minimal one for manual runs:

```
CLAUDE_MODE=mock
ANTHROPIC_API_KEY=
INTERNAL_SECRET=local-internal-secret
CRON_SECRET=local-cron-secret
TOKEN_ENC_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
AUDIT_PEPPER=local-pepper
```

## pg_cron dispatch locally (Vault secrets)

`submit` runs the job directly (`EdgeRuntime.waitUntil`); the per-minute dispatcher (`private.dispatch_due_jobs`) and
the daily `/cron` call only reach the functions when Vault holds `project_url`, `internal_secret` and `cron_secret`.
For local development:

```bash
bash supabase/tests/e2e/vault_secrets.sh supabase/functions/.env.local   # same secrets as the served functions
npx -y supabase@2.119.0 functions serve --env-file supabase/functions/.env.local --no-verify-jwt
```

The script refuses non-local databases, uses `http://supabase_kong_<project_id>:8000` as `project_url` (Kong as seen
from the db container; override with `PROJECT_URL`) and is idempotent. `supabase db reset` removes the secrets. To
check the path by hand: `select private.call_cron_task('daily');` and watch the `functions serve` log.

## Behind a TLS-intercepting proxy

The edge runtime container downloads npm packages itself and does not use the host's CA bundle, so behind a
TLS-intercepting proxy the worker fails to boot (`invalid peer certificate: UnknownIssuer`). Fill its Deno cache
volume from the host once (the host's Deno trusts the proxy CA), then serve again:

```bash
V=$(docker volume inspect supabase_edge_runtime_racketcoach --format '{{.Mountpoint}}')
DENO_DIR=$V npx -y deno@2.9.6 cache --config supabase/functions/deno.json \
  supabase/functions/analyze/index.ts supabase/functions/cron/index.ts
# the runtime also resolves its own @types/node; cache the versions its boot error names, e.g.:
(cd /tmp && DENO_DIR=$V npx -y deno@2.9.6 cache --no-config npm:@types/node@22.5.4 npm:undici-types@6.19.8)
```
