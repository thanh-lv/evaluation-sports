# CoachCore

Deterministic, Foundation-only Swift package shared by the iOS app and `ios/Tools/PoseDump` (DESIGN.md §5.3–§5.4).
It contains no AVFoundation, Vision or UIKit code, builds in Swift 6 language mode with strict concurrency, and also
builds and tests on Linux. Every public type is a `Sendable` value type.

```
swift test --package-path ios/Packages/CoachCore      # swift-testing; reads shared/fixtures/** in place
```

Platforms: iOS 17, macOS 14. Add it to the app as a local package (`project.yml`: `CoachCore: {path: Packages/CoachCore}`).

## Conventions

- **CFS** (canonical frame space) inside CoachCore is **normalized 0…1** with the origin at the **top-left of the
  upright display frame**. The wire format (`pose.v1`) scales it to integers 0…1000 (`Quantizer`). Clean tracks use
  float 0…1000; `Quantizer.joints(fromRow:)` turns either into 0…1 keypoints.
- Times are **µs on the exported clip's asset timeline** (`Int64`), from the sample buffer's PTS
  (`Timebase.microseconds(value:timescale:)` converts a `CMTime` exactly). Never index ÷ fps.
- All UUIDs leaving the device go through `IDs.lower(_:)`.
- Client → server optionals are **omitted** when nil (synthesized `Codable`); server → client optionals decode from
  `null` **or** a missing key.
- Name clashes: MacTypes declares `Point`/`Rect` and the iOS 18 / macOS 15 Vision Swift API declares `Joint`. In any
  file that imports Vision, qualify (`CoachCore.Joint`) or add module-level aliases once per target
  (`typealias Joint = CoachCore.Joint`, same for `Point` and `Rect`), as PoseDump does in `Options.swift`.

## Public API by folder

### `IDs/`
| API | Notes |
|---|---|
| `IDs.lower(UUID) -> String` | lowercase canonical; use for every path, `analysisId`, `appAccountToken` |
| `IDs.lower(String) -> String?` | parse any-case UUID text |
| `IDs.isLowerCanonical(String) -> Bool`, `IDs.newId() -> String` | |

### `Model/`
- `Joint` (19 cases, payload order: `nose lEye rEye lEar rEar neck lSho rSho lElb rElb lWri rWri root lHip rHip lKne rKne lAnk rAnk`), `.index`, `init?(index:)`, `.limbs`, `.mirrored`. Codable as its raw string; usable as a JSON dictionary key.
- `Keypoint {x, y, c}` (CFS 0…1, confidence 0…1), `Point {x, y}`, `Rect {x, y, w, h}` (also the contract `NormRect`, typealias `NormRect`), `PixelSize {w, h}`, `PixelRect {x, y, w, h}` (`flippedY(imageHeight:)` for Core Image).
- `PersonCandidate {joints: [Joint: Keypoint], bbox: Rect, torso: Double?, meanConfidence}` — one Vision observation in full-frame CFS.
- Wire enums (raw value = JSON string): `Sport` (`Sport.of(skill:)`), `Handedness`, `Level`, `CameraView` (incl. `auto`), `ConfirmedCameraView`, `ViewCode` (S/B/D/F), `Language`, `Subject` (`.oneself` = `"self"`, `.other`), `FrameMode` (`.frames`, `.poseOnly` = `"pose_only"`), `Tier`, `AnalysisKind`, `AnalysisStatus`, `SubScoreKey`, `StrokePhase`, `FramePhase`, `FrameId` (F1–F5, L1–L4; `.isUploadId`), `StrokeRole`, `Severity`, `Confidence`, `SafetyKind`, `AssessTag` (`.mApprox` = `"M~"`), `TipKey` (all `camera.tip.*` String Catalog keys).
- `CoachCoreInfo.algoVersion` (`client.algo`), `CoachCoreInfo.visionPoseApi`.

### `Geometry/`
- `VideoTransform {a, b, c, d, tx, ty}` — build from `preferredTransform` (`.isMirrored` = det < 0).
- `OrientationMapper.orientation(for:) -> ImageOrientation` (EXIF raw values; 0° up=1, 90° right=6, 180° down=3, −90° left=8, mirrored 2/7/4/5), `exifOrientation(a:b:c:d:)`, `rotationDegrees`, `isMirrored`, `displaySize(natural:transform:)`, `renderSize(display:maxLongEdge: 1920)`, `renderScale(display:)`. Frames are rendered upright by the composition, so Vision always uses `.up`; the mapper provides metadata and the `video.mirrored` flag.
- `RoiMapper`: `visionRegion(fromCFS:)` (for `regionOfInterest`, bottom-left origin), `cfsRegion(fromVision:)`, `cfs(fromVision:)`, `vision(fromCFS:)`, `full(fromRoi:roi:)`, `roi(fromFull:roi:)`, and the one the pose adapter needs: `cfsPoint(fromVisionPoint:cfsRoi:roiRelative: true)` (+ inverse `visionPoint(fromCFSPoint:cfsRoi:roiRelative:)`). `roiRelative` exists because Vision's ROI-relative output must be verified on device.

### `Sampling/`
- `FrameScheduler(targetHz:srcFps:)`; `mutating shouldKeep(ptsUs:) -> Bool`. Keeps a frame if `pts ≥ nextT − 0.5/srcFps`, then `nextT = max(nextT, pts) + 1/targetHz` (no burst after a VFR gap); non-increasing PTS are dropped. `resume(afterUs:)` for a new reader after a background resume. Codable.
- `RateChooser(srcFps:segmentSec:)`; `recordVisionCall(milliseconds:)` (calls 1–5 are warm-up, 6–25 timed), `isComplete`, `msPerFrame`, `decide(thermal:) -> 30|60`; pure `RateChooser.choose(srcFps:msPerFrame:segmentSec:thermal:)`; `RateChooser.sourceFpsVerdict(_:) -> .ok | .warn (<30) | .reject (<24)`. `ThermalLevel` mirrors `ProcessInfo.ThermalState` (map it in the app).
- `Timebase.microseconds(value:timescale:) -> Int64?`, `Timebase.milliseconds(fromMicroseconds:)`.

### `Tracking/`
- `CandidateBuilder.build(joints: [Joint: Keypoint], aspect: Double) -> PersonCandidate?` — box = joints with c ≥ 0.3, padded 10 %, plus 0.5 torso headroom; needs ≥ 4 such joints. `aspect` = display width / height.
- `TargetSelector.autoSelect(candidates:) -> Int?` (nil → show the tap screen), `select(tap:candidates:aspect:) -> Int?`, `isInSelectionWindow(tUs:segmentStartUs:)` (first 3 s).
- `Tracker(initial:tUs:aspect:)`; `mutating step(tUs:candidates:) -> TrackStep`; `roi` (CFS ROI for the next frame); `state` (`tracking/coasting/lost`); `resets`; `predictedBox(atUs:)`; static `roi(around:)`. Codable, so it can be stored in `PipelineCheckpoint`.
- `TrackStep {index?, box?, coasted, reacquired, ambiguous, lost, roi, flags}`; `TrackFlags` (`.coasted` = 1, `.reacquired` = 2).

### `Quality/`
- `QualityAccumulator` — `add(tUs:target:reacquired:ambiguous:)` or `add(tUs:step:candidates:)` per sampled frame (frames before selection count too); `stats -> QualityStats {framesTotal, framesWithTarget, meanLimbConf, playerHeightFracMedian, missingPct, trackResets, ambiguousAtMs, presence}`. Codable.
- `QualityGate.evaluate(_:srcFps:segmentMs:) -> QualityVerdict {rejections, warnings, passed, tips}`. `QualityIssue` raw values are the server error codes (`target_lost`, `player_too_small`, `low_visibility`, `too_few_frames`, `fps_too_low`, `clip_too_short`, `clip_too_long`) plus warnings `player_small`, `fps_low`; `issue.tips` mirrors the server's `REJECTION_TIPS`, so local and server rejections share copy.
- `LiveFraming.evaluate(player:meanLuma:) -> FramingVerdict {isGreen, hints, heightFrac}`, `LiveFraming.mostProminent(_:)`. `FramingHint` raw values are String Catalog keys the app must define: `framing.hint.step_back` ("Lùi xa hơn"), `framing.hint.show_feet` ("Thấy cả bàn chân"), `framing.hint.backlight` ("Ngược sáng"), `framing.hint.move_closer`, `framing.hint.no_player`.

### `Payload/`
- `PoseV1` (+ nested `Client`, `Session`, `Source`, `Segment`, `Display`, `Video`, `Quality(stats:)`, `Track`): `encodedForUpload() throws -> Data` (sorted keys, throws `PoseBuildError.tooLarge` above 1.2 MB), `validate() -> [String]` (client mirror of the server checks), `makeEncoder(pretty:)`.
- `PoseV1Builder(analysisId: UUID|String, client:session:video:)`; `append(tUs:step:candidates:)`, `append(tUs:target:box:flags:)`, `appendMissing(tUs:)`; `build(quality:) throws -> PoseV1`. Missing-target frames get `0,0,0` joints, the coasted flag and a back-filled box. Codable (checkpointable). Errors: `PoseBuildError`.
- `Quantizer`: `coordinate`, `confidence`, `keypoint`, `frame`, `box`, `dequantize(x:y:c:)`, `joints(fromRow:)`, `rect(fromBox:)`.
- `PrepareResponseV1` (+ `ViewGuess`, `PreparedStroke`, `FrameRequest`, `QuotaPreview`; top-level typealiases of the same names), `uploadRequests`, `stroke(id:)`. `PrepareWarning` is an open string type with constants (`.fpsLow`, `.viewLowConfidence`, `.viewMismatch`, `.viewNotRecommended`, `.skillMismatchSuspected`, `.fewStrokes`, `.playerSmall`, `.handednessMismatch`). `StrokePhasesUs.time(of:)`.
- `ReprepareV1(analysisId:cameraView:excludedStrokeIds:handedness:)` (lowercases the id, sorts the ids).
- `CoachResultV1` (+ `Status`, `Access`, `RejectionCode`, `Rejection`, `Locked`, `Evidence`, `EvidenceDetail`, `Drill`, `Dose`, `Hero`, `Overall`, `SubScore`, `Checkpoint`, `PerStrokeValue`, `Strength`, `Weakness`, `PlanItem`, `PlanTarget`, `Stroke`, `SafetyNote`, `NotAssessable`, `Meta`), helpers `isFree`, `stroke(role:)`, `allEvidence`. `LocalizedText {vi, en}.text(for:)`, `LocalizedList`.
- `CleanTrackV1` (+ `Phases`, `Stroke`): `isInterpolated(frame:joint:)`, `joints(at:)`.
- API bodies: `ApiError` (`code` stays a string; `knownCode: ApiErrorCode?` with `httpStatus` and `isPrepareRejection`; `tipKeys`), `CatalogResponseV1`, `CatalogSkill` (`coverage(for:)`), `CatalogPlan`, `SubmitRequest`, `SubmitResponse`, `VerifySubscriptionRequest` (`Reason`), `VerifySubscriptionResponse`, `AppleAuthExchangeRequest`, `AccountMergeRequest`/`Response`, `DeleteAccountRequest()` (always `{confirm: true}`), `DeleteAccountResponse`.

### `Crop/`
- `CropMath.pixelRect(crop:display:) -> PixelRect` (origin floored, far edge ceiled, clamped, ≥ 1 px), `outputSize(for:longEdge: 768)` (never upscales), `normalizedRect(of:display:)`, `imagePoint(_:crop:imageSize:)`, `toleranceSeconds(srcFps:)` (±0.45 frame), `isActualTimeAcceptable(requestedUs:actualUs:srcFps:)` (< ½ frame, else fall back to a reader decode).

### `Overlay/`
- `SkeletonGeometry.bones` (14 `Bone`s: nose–neck, neck–lSho, neck–rSho, lSho–lElb, lElb–lWri, rSho–rElb, rElb–rWri, neck–root, root–lHip, root–rHip, lHip–lKne, lKne–lAnk, rHip–rKne, rKne–rAnk), `dotJoints`, `visibleBones(in:)`.
- `PoseTimeline(cleanTrack:)` / `(pose:)` / `(tUs:poses:)`; `pose(atUs:) -> [Joint: Point]?` (binary search + linear interpolation, hidden across gaps > 100 ms), `nearestPose(atUs:toleranceUs:)`, `nearestIndex(atUs:)`.
- `KeyFrameSkeleton.make(pose:crop:imageSize:highlight:)` and `make(timeline:request:imageSize:highlight:)` → `segments` / `dots` in crop-image pixels, with evidence joints highlighted.

## App pipeline sketch (per sampled frame)

```swift
var scheduler = FrameScheduler(targetHz: hz, srcFps: srcFps)
var builder = PoseV1Builder(analysisId: id, client: client, session: session, video: video)
var quality = QualityAccumulator()
var tracker: Tracker?                                    // nil until a player is selected

// for each decoded frame (PTS in µs):
guard scheduler.shouldKeep(ptsUs: tUs) else { continue }
let roi = tracker?.roi ?? .unit                          // VisionPoseEstimator sets regionOfInterest from it
let people: [PersonCandidate] = try estimator.detect(pixelBuffer, cfsRoi: roi)  // via RoiMapper + CandidateBuilder
if var t = tracker {
    let step = t.step(tUs: tUs, candidates: people); tracker = t
    builder.append(tUs: tUs, step: step, candidates: people)
    quality.add(tUs: tUs, step: step, candidates: people)
} else if people.isEmpty {
    builder.appendMissing(tUs: tUs); quality.add(tUs: tUs, target: nil)
} else if let i = TargetSelector.autoSelect(candidates: people) {   // else: show the tap screen
    tracker = Tracker(initial: people[i], tUs: tUs, aspect: display.aspect)
    builder.append(tUs: tUs, target: people[i], box: people[i].bbox, flags: [])
    quality.add(tUs: tUs, target: people[i])
}

// after the segment:
let verdict = QualityGate.evaluate(quality.stats, srcFps: srcFps, segmentMs: segmentMs)
guard verdict.passed else { /* show verdict.rejections[0] + verdict.tips; no quota used */ }
let body = try builder.build(quality: quality.stats).encodedForUpload()
```

`ios/Tools/PoseDump/Sources/PoseDump/PoseDumpCommand.swift` is a complete working reference of this loop (including
the full-frame retry when the ROI finds nobody).

## Tests

`Tests/CoachCoreTests` (swift-testing): orientation table, ROI mapping, scheduler with VFR gaps (asserts no bursts),
rate chooser warm-up, candidate/box building, auto/tap selection, tracker crossings, ambiguity, coast, loss and
re-acquire, ROI, quality gate thresholds and live framing, quantizer round trip, builder, UUID lowercasing,
decoded-value round trip of every fixture in `shared/fixtures/{pose,prepare,results}` (plus any `clean-track.v1`
fixture found, and an inline clean track), crop math and skeleton/timeline geometry. Fixtures are loaded through a
`#filePath`-relative URL, never copied. The round-trip tests also compare the set of non-null JSON key paths, so a
misspelled optional `CodingKey` cannot pass silently.
