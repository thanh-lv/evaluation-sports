# PoseDump

macOS 14+ command-line tool that turns a video file into a `pose.v1` document using **the same CoachCore logic as
the app** (DESIGN.md §5.3, M3). It produces the real fixtures (`shared/fixtures/pose/real_<skill>_<n>.json`) that
tune the server engine before the app exists.

Pipeline: `AVAssetReaderVideoCompositionOutput` (upright, Rec.709 SDR, render long edge ≤ 1920, frame timing from the
source track, PTS in µs) → `FrameScheduler` → `VNDetectHumanBodyPoseRequest` (orientation `.up`, `regionOfInterest`
from the tracker, full-frame retry when the ROI finds nobody) → `CandidateBuilder` / `TargetSelector` / `Tracker` →
`QualityAccumulator` / `QualityGate` → `PoseV1Builder` → JSON.

## Usage

```sh
cd ios/Tools/PoseDump
swift run -c release posedump ~/clips/clear1.mov --skill bd.clear_fh --select auto --hz 60 \
  --out ../../../shared/fixtures/pose/real_bd_clear_fh_1.json
```

| Option | Default | Notes |
|---|---|---|
| `--skill bd.xxx\|pb.xxx` | required | sport is derived from the prefix |
| `--select auto\|x,y` | `auto` | `x,y` = a tap in normalized display coordinates (0…1, top-left), applied at the first frame with people within 3 s of the segment start |
| `--hz 30\|60` | 60 if source ≥ 50 fps, else 30 | the app benchmarks Vision on device; PoseDump does not |
| `--start s --end s` | whole clip | segment on the clip timeline; must be 3–32 s |
| `--out path` | `<clip>.pose.json` | |
| `--handedness right\|left` | `right` | |
| `--view side\|behind\|front\|diagonal\|auto` | `auto` | |
| `--level …`, `--language vi\|en`, `--source recorded\|imported`, `--analysis-id uuid` | none, `vi`, `imported`, random | |
| `--roi on\|off` | `on` | crop-follow `regionOfInterest` |
| `--roi-coords relative\|absolute` | `relative` | how Vision reports points under a ROI (to verify; compare both on a small-player clip) |
| `--pretty`, `--verbose` | off | `--verbose` logs every sampled frame (tracked / coasted / lost / reacquired, ROI) |

Exit codes: `0` written and valid; `1` error (or the written document failed a `pose.v1` check, listed on stderr);
`2` auto-selection was ambiguous (the candidates' centres are printed; rerun with `--select x,y`); `3` written, but
the on-device quality gate would reject it (the reason codes are printed).

Validate a written file against the server's own Zod `pose.v1` (from the repo root, Mac or Linux):

```sh
npx -y deno@2.9.6 eval --config supabase/functions/deno.json \
  "import {PoseV1} from '@shared/contracts/index.ts'; const p = PoseV1.safeParse(JSON.parse(Deno.readTextFileSync(Deno.args[0]))); console.log(p.success ? 'pose.v1 OK' : p.error.issues.slice(0, 10))" \
  shared/fixtures/pose/real_bd_clear_fh_1.json
```

## Notes

- Mirrored sources (front camera, `preferredTransform` det < 0) are rendered as displayed and flagged
  `video.mirrored: true`; the server swaps L/R once.
- HDR (HLG / Dolby Vision) is tone-mapped to SDR by the composition's Rec.709 colour properties.
- Timestamps are the clip's own PTS (`sourceTrackIDForFrameTiming`), so VFR clips keep their real timing.
- The package uses Swift 5 language mode for this target only (AVFoundation / Vision objects are not `Sendable`);
  CoachCore itself is Swift 6.
