# Claude output fixtures (`coach.v1`)

Hand-written examples of what Claude returns for a synthetic clip, used by the Claude module tests
(`supabase/tests/claude/`) and by `scripts/replay.ts --mock-claude <file>`. They follow the per-sport `coach.v1`
schema (`shared/schemas/`, built by `buildCoachOutputSchema`).

| File                     | Pose fixture                         | Language | What it exercises                                                                                                                                                                                                                                      |
| ------------------------ | ------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bd_clear_fh_60.vi.json` | `pose/synthetic_bd_clear_fh_60.json` | vi       | Realistic Vietnamese output with typical quirks: capitalised enums (`"Good"`, `"High"`, `"Medium"`), a number with a unit in one `observation` (stripped by postprocess), a drill from another fault (dropped), worst-stroke evidence without a frame. |
| `pb_dink_60.en.json`     | `pose/synthetic_pb_dink_60.json`     | en       | Clean English output, including a strength that comes from a visual judgment (`pb.dink.DK4`, level 3, confidence high). Postprocess raises no flags.                                                                                                   |

Replay one end to end (prepare → fixture → postprocess → compose):

```sh
deno run -A --config supabase/functions/deno.json scripts/replay.ts \
  shared/fixtures/pose/synthetic_pb_dink_60.json --mock-claude shared/fixtures/claude/pb_dink_60.en.json --lang en
```

Use `--mock` instead of `--mock-claude` for the built-in deterministic generator (`CLAUDE_MODE=mock`). Its output for
two fixtures is kept as golden results in `shared/fixtures/results/replay_*.json` (`scripts/replay.ts --golden`).

Stroke ids, frame ids and checkpoint ids must match what `prepare` produces for the pose fixture; if the engine or
rubric changes them, update these files (the tests will fail first).
