# RacketCoach

AI technique coach for badminton and pickleball beginners (iOS, VN storefront first). The iPhone extracts 2D pose
with Apple Vision; a Supabase backend cleans the track, segments strokes, measures and scores them in TypeScript;
Claude judges the visual checkpoints and writes the coaching text (VI/EN). The video itself is never uploaded.

- Spec: [docs/DESIGN.md](docs/DESIGN.md) (v1.1, authoritative) on top of [docs/DESIGN-v1.0.md](docs/DESIGN-v1.0.md)
- Execution plan (VI): [docs/PLAN.vi.md](docs/PLAN.vi.md)

## Repository map

| Path | Contents |
|---|---|
| `supabase/functions/deno.json` | The single Deno config: pinned imports, `@shared/` alias, fmt/lint rules |
| `supabase/functions/_shared/contracts/` | Zod data contracts: `pose.v1`, `reprepare.v1`, `prepare.v1`, `clean-track.v1`, per-sport `coach.v1` schema builder, `coach-result.v1`, small API bodies (`api_v1.ts`), error catalog. Cheat sheet: [docs/CONTRACTS.md](docs/CONTRACTS.md) |
| `supabase/functions/_shared/rubric/` | Rubric types and Zod schema, `badminton.json` / `pickleball.json` (12 skills), `drills.json`, `glossary.json`, loader |
| `supabase/functions/_shared/engine/` | Pure TS analysis engine: signal pipeline, segmentation, metrics, scoring, candidates, frame plan; `prepare` / `reprepare` / `composeScores` in `index.ts` |
| `supabase/functions/<name>/` | Edge Functions: `analyze` (catalog/prepare/submit/run), `cron`, `verify-subscription`, `appstore-webhook`, `apple-auth-exchange`, `account-merge`, `delete-account`. Thin routers with injected dependencies; API reference in [docs/CONTRACTS.md](docs/CONTRACTS.md#server-api-edge-functions) |
| `supabase/functions/_shared/` (rest) | Server plumbing (`http`, `errors`, `log`, `env`, `auth`, `db`, `storage`, `crypto`, `events`, `budget`), the Claude module (`claude/`), the analyze job and cron tasks (`jobs/`), Apple (`apple/`: JWS, App Store Server API, SIWA, DeviceCheck), test fakes (`testing/`) |
| `supabase/migrations/`, `supabase/seed.sql` | Postgres schema, RPCs, RLS, storage, cron; config rows (`plan_limits`, `model_routes`, `app_config`, `enabled_skills`). Reference: [docs/database.md](docs/database.md) |
| `supabase/config.toml`, `supabase/templates/` | Local Supabase stack config and the OTP email templates |
| `supabase/tests/contracts/`, `rubric/`, `engine/`, `claude/`, `jobs/`, `functions/`, `server/`, `apple/`, `accounts/` | Deno tests (contracts, schema sync, SQL/seed ↔ contract consistency, rubric integrity, engine, Claude module, jobs, every function handler with fakes; a few tests also hit the local stack when it runs) |
| `supabase/tests/e2e/` | End-to-end flow on the local stack with the functions served in mock mode ([README](supabase/tests/e2e/README.md)) |
| `supabase/tests/database/`, `supabase/tests/sql/` | pgTAP files and the shell suite (`run.sh`: db reset, pgTAP, concurrency, fixtures, API smoke) on the local stack |
| `shared/schemas/` | JSON Schemas generated from the Zod contracts (`make schemas`), incl. the server-internal `prepared.v1.json` |
| `shared/fixtures/` | `pose/` (synthetic clips + truth), `prepare/` (golden prepare responses), `results/`, `claude/`, `labels/` fixtures shared by Deno, Swift and the Web Lab |
| `scripts/` | `check.sh`, `gen-schemas.ts`, `gen-minimal-fixture.ts`, `gen-synthetic-pose.ts`, `replay.ts` (engine + Claude-step replay, goldens), `smoke-claude.ts` and `warm-schemas.ts` (live API, `--yes-spend`), `bench-engine.ts`, `fit-contact-offsets.ts` |
| `ios/Packages/CoachCore/` | Swift package: sampling, tracking, quality gate, pose.v1 payload, crop/overlay math, Codable contracts (tests run on Linux too) |
| `ios/Tools/PoseDump/` | macOS CLI: video → pose.v1 with Apple Vision (built on a Mac) |
| `weblab/` | Browser lab: MediaPipe → pose.v1 → prepare/submit/result, labeler (planned) |
| `docs/` | Design, plan, contracts, database, research, legal, App Store and support docs ([index](docs/README.md)) |

## Quick start

```bash
make test      # bash scripts/check.sh: every Linux-verifiable check (table below), prints a summary, exits 1 on failure
make schemas   # regenerate shared/schemas/*.json after changing a contract
make fixtures  # regenerate the minimal pose fixture
make sql       # only the SQL suite on the local Supabase stack (needs Docker; WIPES the local DB with db reset)
make fmt       # format supabase/ and scripts/
make dev       # local Supabase stack + functions (dev-stack milestone; until then see Backend below)
```

`make test` runs these steps:

| Step | Notes |
|---|---|
| `deno fmt --check`, `deno lint`, `deno check` | `supabase/functions`, `supabase/tests`, `scripts` |
| `deno test` | everything under `supabase/tests` except `e2e/` |
| `gen-schemas --check` | `shared/schemas` in sync with the Zod contracts, Claude output schemas pass the audit |
| `gen-minimal-fixture`, `gen-synthetic-pose`, `replay --golden`, `fit-contact-offsets` (`--check`) | generated fixtures in sync |
| SQL suite (`supabase/tests/sql/run.sh`) | runs when Docker is available, otherwise skipped with a notice. Starts the local stack if needed and runs `supabase db reset` (wipes local data). `SKIP_SQL=1` skips it, `SKIP_RESET=1` keeps the current database |
| e2e flow (`supabase/tests/e2e`) | runs when Docker is available and the local stack answers (the SQL step starts it). Serves the functions with `CLAUDE_MODE=mock` and drives prepare → frames → submit → result → quota. `SKIP_E2E=1` skips it |
| `swift test` (CoachCore) | runs when `swift` is on PATH, otherwise skipped |
| iOS resources, Web Lab tests | skipped until those milestones add them |

Deno runs through `npx -y deno@2.9.6` (override with `DENO_VERSION`). Scripts and tests outside
`supabase/functions` use `--config supabase/functions/deno.json`.

Mac/iPhone setup (Xcode 26.x, XcodeGen, Supabase project, secrets, Auth settings) is in DESIGN.md §13.2 and will be
expanded here as those milestones land.

## Backend (Supabase)

Postgres (schema, RPCs, RLS, Storage buckets, pg_cron) and seven Deno Edge Functions. API reference (routes, auth,
bodies, error codes, env vars): [docs/CONTRACTS.md › Server API](docs/CONTRACTS.md#server-api-edge-functions);
database reference: [docs/database.md](docs/database.md).

Local stack (Docker):

```bash
npx -y supabase@2.119.0 start                     # Postgres, Auth, Storage, REST, Kong, edge runtime
cp supabase/functions/.env.example supabase/functions/.env.local   # CLAUDE_MODE=mock: no API key, no cost
npx -y supabase@2.119.0 functions serve --env-file supabase/functions/.env.local --no-verify-jwt
bash supabase/tests/e2e/vault_secrets.sh supabase/functions/.env.local   # optional: lets pg_cron call /analyze/run and /cron
```

- **Flow:** the app signs in (anonymous first), sets its birth year and consents on `profiles`, calls
  `GET /analyze/catalog`, `POST /analyze/prepare` with `pose.v1`, uploads the requested JPEG frames to
  `analysis-inputs/{uid}/{analysisId}/frames/`, calls `POST /analyze/submit`, polls `analyses.status`, then reads
  `rpc get_result`. `supabase/tests/e2e/flow.test.ts` does exactly this.
- **Jobs:** submit starts the job in the background; the pg_cron dispatcher retries due jobs through `/analyze/run`
  (needs the Vault secrets), and the daily `/cron` task does retention and alerts.
- **Claude:** `CLAUDE_MODE=mock` gives deterministic canned output. Live mode needs `ANTHROPIC_API_KEY`; mock is never
  chosen implicitly. `scripts/smoke-claude.ts --yes-spend` makes one live call.
- **Secrets:** the template is `supabase/functions/.env.example`. For a hosted project use `supabase secrets set` with
  the same names, and store `project_url`, `internal_secret` and `cron_secret` in Vault (docs/database.md).
  Apple keys are optional until the Apple functions are used; a function missing one answers 500 and logs its name.
- `verify_jwt` is `false` for every function in `supabase/config.toml`; each function checks the user JWT (or its
  shared secret) itself.
