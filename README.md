# RacketCoach

AI technique coach for badminton and pickleball beginners (iOS, VN storefront first). The iPhone extracts 2D pose
with Apple Vision; a Supabase backend cleans the track, segments strokes, measures and scores them in TypeScript;
Claude judges the visual checkpoints and writes the coaching text (VI/EN). The video itself is never uploaded.

- Spec: [docs/DESIGN.md](docs/DESIGN.md) (v1.1, authoritative) on top of [docs/DESIGN-v1.0.md](docs/DESIGN-v1.0.md)
- Execution plan (VI): [docs/PLAN.vi.md](docs/PLAN.vi.md)

## Repository map

| Path | Contents |
|---|---|
| `supabase/functions/` | Deno Edge Functions; `deno.json` is the single Deno config (pinned imports, `@shared/` alias) |
| `supabase/functions/_shared/contracts/` | Zod data contracts: `pose.v1`, `reprepare.v1`, `prepare.v1`, `clean-track.v1`, per-sport `coach.v1` schema builder, `coach-result.v1`, error catalog |
| `supabase/functions/_shared/rubric/` | Rubric types, JSON data, loader |
| `supabase/functions/_shared/engine/` | Pure TS analysis engine (`metric_catalog.ts` lists the metric keys) |
| `supabase/migrations/`, `supabase/tests/` | SQL migrations; Deno and SQL tests |
| `shared/schemas/` | JSON Schemas generated from the Zod contracts (`make schemas`) |
| `shared/fixtures/` | `pose/`, `prepare/`, `results/`, `claude/`, `labels/` fixtures shared by Deno, Swift and the Web Lab |
| `scripts/` | `check.sh`, `gen-schemas.ts`, fixture generators and dev tools |
| `ios/` | SwiftUI app, `CoachCore` package, `PoseDump` tool (built on a Mac) |
| `weblab/` | Browser lab: MediaPipe → pose.v1 → prepare/submit/result, labeler |
| `docs/` | Design, plan, research, legal and store docs |

## Quick start

```bash
make test      # all Linux-verifiable checks: deno fmt/lint/check/test, schema sync + audit, optional SQL/iOS/Web Lab
make schemas   # regenerate shared/schemas/*.json after changing a contract
make fmt       # format supabase/ and scripts/
make dev       # local Supabase stack + functions (dev-stack milestone)
```

Deno runs through `npx -y deno@2.9.6` (override with `DENO_VERSION`). Scripts and tests outside
`supabase/functions` use `--config supabase/functions/deno.json`.

Mac/iPhone setup (Xcode 26.x, XcodeGen, Supabase project, secrets, Auth settings) is in DESIGN.md §13.2 and will be
expanded here as those milestones land.
