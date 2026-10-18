# Coach labels (`*.csv`)

Contact-frame labels from the coach, used by `scripts/fit-contact-offsets.ts` to fit each skill's
`contactOffsetMs` (DESIGN.md D7, M4b) and, later, by the calibration evals (M17).

## Format

One CSV file per labelling session, any name ending in `.csv` (for example `coach_2026-11-02.csv`). UTF-8,
comma-separated, no quoting. The first non-comment line is the header:

```csv
# lines starting with # are comments; blank lines are ignored
clip,frame_tUs,label
real_bd_clear_01,13910583,contact
real_bd_clear_01,16402250,contact
real_pb_dink_03,5233416,contact
```

| Column | Meaning |
|---|---|
| `clip` | Stem of the pose fixture in `shared/fixtures/pose/` (`real_bd_clear_01` → `shared/fixtures/pose/real_bd_clear_01.json`). Letters, digits, `_`, `-`, `.` only. The skill, sport, handedness and view come from that pose file. |
| `frame_tUs` | PTS of the labelled video frame in integer microseconds on the exported clip's timeline: the same clock as `track.tUs` in the pose file. It should be one of the pose's `track.tUs` values (the labeler exports the PTS of the frame the coach picked); other values are used but warned about. |
| `label` | `contact` (the frame where racket and shuttle/ball touch). Other labels are reserved and ignored by the offset fit. |

One row per stroke. Strokes the coach could not judge are simply left out.

## How the fit uses them

For each clip, the engine runs with `contactOffsetMs = 0`; each `contact` label is matched one-to-one to the nearest
racket-wrist speed peak within ±250 ms. The fitted offset of a skill is the median of (label − peak) over all its
matched labels. `--check` fails when the rubric's `contactOffsetMs` is more than one frame (at the fastest analysis
rate among that skill's clips) away from the fit. With no labels the check passes and prints a notice.

The M4b targets per skill (on real clips): median contact error ≤ 1 frame at 60 Hz after the offset, recall ≥ 90 %,
precision ≥ 90 %. The script prints all three.
