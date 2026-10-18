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
| `supabase/migrations/`, `supabase/seed.sql` | Postgres schema, RPCs, RLS, storage, cron; config rows (`plan_limits`, `model_routes`, `app_config`, `enabled_skills`). Reference: [docs/database.md](docs/database.md) |
| `supabase/config.toml`, `supabase/templates/` | Local Supabase stack config and the OTP email templates |
| `supabase/tests/contracts/`, `rubric/`, `engine/` | Deno tests (contracts, schema sync, SQL/seed ↔ contract consistency, rubric integrity, engine signal/scoring/prepare) |
| `supabase/tests/database/`, `supabase/tests/sql/` | pgTAP files and the shell suite (`run.sh`: db reset, pgTAP, concurrency, fixtures, API smoke) on the local stack |
| `shared/schemas/` | JSON Schemas generated from the Zod contracts (`make schemas`), incl. the server-internal `prepared.v1.json` |
| `shared/fixtures/` | `pose/` (synthetic clips + truth), `prepare/` (golden prepare responses), `results/`, `claude/`, `labels/` fixtures shared by Deno, Swift and the Web Lab |
| `scripts/` | `check.sh`, `gen-schemas.ts`, `gen-minimal-fixture.ts`, `gen-synthetic-pose.ts`, `replay.ts` (engine replay + goldens), `bench-engine.ts`, `fit-contact-offsets.ts` |
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
make dev       # local Supabase stack + functions (dev-stack milestone)
```

`make test` runs these steps:

| Step | Notes |
|---|---|
| `deno fmt --check`, `deno lint`, `deno check` | `supabase/functions`, `supabase/tests`, `scripts` |
| `deno test` | everything under `supabase/tests` (contracts, rubric, engine) |
| `gen-schemas --check` | `shared/schemas` in sync with the Zod contracts, Claude output schemas pass the audit |
| `gen-minimal-fixture`, `gen-synthetic-pose`, `replay --golden`, `fit-contact-offsets` (`--check`) | generated fixtures in sync |
| SQL suite (`supabase/tests/sql/run.sh`) | runs when Docker is available, otherwise skipped with a notice. Starts the local stack if needed and runs `supabase db reset` (wipes local data). `SKIP_SQL=1` skips it, `SKIP_RESET=1` keeps the current database |
| `swift test` (CoachCore) | runs when `swift` is on PATH, otherwise skipped |
| iOS resources, Web Lab tests | skipped until those milestones add them |

Deno runs through `npx -y deno@2.9.6` (override with `DENO_VERSION`). Scripts and tests outside
`supabase/functions` use `--config supabase/functions/deno.json`.

Mac/iPhone setup (Xcode 26.x, XcodeGen, Supabase project, secrets, Auth settings) is in DESIGN.md §13.2 and will be
expanded here as those milestones land.
