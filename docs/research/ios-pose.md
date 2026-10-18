# Research: ios-pose

> Research output from 2026-10-18 (unverified claims marked inside). DESIGN.md is authoritative.

# On-Device iOS Pipeline Spec: Badminton/Pickleball Technique Analyzer

## 0. Decisions in this spec (summary)

| Item | Recommendation |
|---|---|
| Deployment target | **iOS 17.0**. It runs on the same hardware as iOS 18 (iPhone XS/XR and later), and it gives you `AVCaptureDevice.RotationCoordinator`, `videoRotationAngle`, 3D body pose, `@Observable` and `SubscriptionStoreView`. |
| 2D pose API | Legacy `VNDetectHumanBodyPoseRequest` (iOS 14+), placed behind a `PoseEstimator` protocol. The iOS 18 Swift API is an optional second implementation and is not needed for the MVP. |
| Recording | A custom `AVCaptureSession` recorder at 1080p60 (falls back to 30), no audio, at most 60 s. |
| Import | `PhotosPicker` + `Transferable` (FileRepresentation), plus `.fileImporter` for videos saved from Zalo or Files. |
| Analysis segment | 3–30 s, picked in a custom trimmer. **No re-encode**: store a `CMTimeRange` and read only that range. |
| Pose sampling | Base pass at 30 Hz. Then a native-rate pass (60/120) over ±0.3 s around each detected contact. |
| Smoothing | Offline zero-phase filtering (Hampel, then Savitzky–Golay). One-Euro is only for live preview. |
| Upload | Track JSON (about 200–450 KB raw) and 8–13 JPEG key frames (768 px) go to Storage. The edge-function body is the summary (about 10–30 KB). |
| Testable core | `Packages/SwingCore`: pure Swift, Foundation only, Double math, `swift-testing`, no simd/CoreGraphics/Accelerate. |

---

## 1. Video import

### 1.1 Photos (PhotosUI, iOS 16+)
- `PhotosPicker(selection: $item, matching: .all(of: [.videos, .not(.livePhotos)]), preferredItemEncoding: .current, photoLibrary: .shared())`.
  - `.current` means "choose the current encoding to avoid transcoding, if possible". This avoids a slow HEVC→H.264 transcode. The other options are `.automatic` and `.compatible`.
  - The picker runs out of process, so the app needs **no `NSPhotoLibraryUsageDescription`**.
- Transferable type. The received file is deleted after the closure returns, so you must copy it:
```swift
struct PickedMovie: Transferable {
  let url: URL
  static var transferRepresentation: some TransferRepresentation {
    FileRepresentation(contentType: .movie) { SentTransferredFile($0.url) } importing: { r in
      let dst = URL.temporaryDirectory.appending(path: "imp-\(UUID().uuidString).\(r.file.pathExtension)")
      try FileManager.default.copyItem(at: r.file, to: dst)
      return Self(url: dst)
    }
  }
}
```
- Use the `loadTransferable(type:completionHandler:) -> Progress` variant. It lets you show progress while iCloud-optimized videos download.
- After import, move the file to Application Support / Analyses/<id>/source.mov. The overlay player needs it later; tmp files get purged. Add a storage-cleanup setting.
- Pitfalls:
  - Importing a 4K60 file is slow, because the copy inside the closure is the bottleneck.
  - **Slo-mo:** developers report that PHPicker re-encodes slo-mo clips and ignores the preferred representation, which likely bakes in the time-stretch. Wrist speeds would then be 4–8x too low. MVP handling: if `nominalFrameRate` is 100 or more, treat the file as native HFR (good). Otherwise show a toggle, "Is this a slow-motion video?", with a factor. **UNCERTAIN; verify on device.**

### 1.2 Files / Zalo
- `.fileImporter(isPresented:, allowedContentTypes: [.movie])`.
- Call `startAccessingSecurityScopedResource()`, copy the file into the container, then call stop.

### 1.3 Camera recording
- The `UIImagePickerController` option (`mediaTypes = [UTType.movie.identifier]`, `videoMaximumDuration`) works but gives no control over frame rate or format. It is likely 30 fps (**unverified**). Not recommended.
- **Recommended:** `AVCaptureSession` + `AVCaptureMovieFileOutput`.
  - Device: `builtInWideAngleCamera` (1x). Avoid the 0.5x lens, because edge distortion skews joint angles.
  - Format: pick from `device.formats` where dimensions are 1920x1080, `videoSupportedFrameRateRanges` has max at least 60, and the format is not binned if possible. Use `sessionPreset = .inputPriority`. Under `lockForConfiguration`, set `activeFormat`, and set `activeVideoMinFrameDuration` and `activeVideoMaxFrameDuration` to `CMTime(1,60)`.
  - Codec: HEVC if `availableVideoCodecTypes` contains `.hevc`.
  - Turn HDR off (`automaticallyAdjustsVideoHDREnabled = false`, `isVideoHDREnabled = false`). This avoids 10-bit HLG handling.
  - Rotation (iOS 17): use `AVCaptureDevice.RotationCoordinator(device:previewLayer:)` and observe `videoRotationAngleForHorizonLevelCapture`. Set it on the movie connection's `videoRotationAngle`. `videoOrientation` is deprecated.
  - `maxRecordedDuration = 60 s`. Stabilization: `.standard` (tripod is recommended anyway).
  - **No audio input.** That avoids the mic permission prompt. Info.plist needs `NSCameraUsageDescription` only, plus `NSPhotoLibraryAddUsageDescription` if you offer "save to Photos".
  - Optional v1.1 "sport shutter": custom exposure of 1/500 s or faster when ISO headroom allows. Vietnam's grid is 50 Hz, so LED or fluorescent banding may appear. Vision tolerates it.
  - Running a live skeleton during recording would need `AVCaptureVideoDataOutput` alongside the movie output. Simultaneous support on iOS is **uncertain**, so the MVP uses a static framing guide (silhouette box plus a "landscape, whole body, 1/3+ of frame height" checklist).

### 1.4 Limits

| Limit | Value |
|---|---|
| Import | ≤ 10 min and ≤ 2 GB (warn above 1 GB); reject < 3 s; .mov/.mp4, H.264/HEVC |
| Segment | min 3 s, max 30 s, default the first 15 s. Optional product lever: free tier capped at 15 s, Pro at 30 s. |
| Recording | ≤ 60 s |

Reference sizes: 1080p60 HEVC is about 100 MB/min; 4K60 is about 400 MB/min.

### 1.5 Trimmer UI (custom SwiftUI)
- **Preview:** an AVPlayerLayer-backed view.
- **Filmstrip:** 10–14 thumbnails from `AVAssetImageGenerator.images(for:)` with `maximumSize ≈ 160 px` and a loose tolerance (±0.5 s) for speed.
- **Range slider:** two `DragGesture` handles over the filmstrip, with the region outside the range dimmed. Show the label "12.4 s – 27.9 s (15.5 s)" and enforce min/max length.
- **Scrubbing while dragging:** seek with zero tolerance using the "chase time" pattern (Apple QA1820). Only issue the next seek after the previous one has completed.
- **Loop preview:** set `playerItem.forwardPlaybackEndTime = end` and seek back to start on `AVPlayerItemDidPlayToEndTime`. Alternatively, use `AVPlayerLooper(player:templateItem:timeRange:)` once the handles are released.
- **Output:** a `CMTimeRange` on the draft. **No export.** `AVAssetExportSession` is unnecessary because the full video is not uploaded.
- **Accessibility:** add VoiceOver adjustable actions on the handles.

### 1.6 Session metadata (form before analysis)
- Sport.
- Stroke hint:
  - Badminton: `serve_short, serve_long, clear, smash, drop, drive, net_shot, lift, backhand_clear, defense, shadow_footwork, auto`.
  - Pickleball: `serve, return, dink, drive, third_shot_drop, volley, overhead, lob, reset, auto`.
- Handedness (from profile).
- Skill level.
- Camera view: `side_left | side_right | behind | front | diagonal`, with illustrated icons.
- Context: `singles | doubles | drill`.
- Subject: `self | other`. For `other`, require a consent checkbox, since key frames contain faces.
- Optional subject height in cm. This enables metric units.

---

## 2. Frame extraction

### 2.1 AVAssetReader vs AVAssetImageGenerator
- **AVAssetReader is used for the pose pass.** It decodes sequentially in hardware and is the fastest option. **AVAssetImageGenerator is used only for random-access key frames and thumbnails.**
- Loading (iOS 16+ async):
  - `let asset = AVURLAsset(url:)`. `AVAsset(url:)` is deprecated as of iOS 18.
  - `let track = try await asset.loadTracks(withMediaType: .video).first`.
  - `let (size, t, fps) = try await track.load(.naturalSize, .preferredTransform, .nominalFrameRate)`.
- Reader setup:
```swift
let out = AVAssetReaderTrackOutput(track: track, outputSettings:
  [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange])
out.alwaysCopiesSampleData = false
out.supportsRandomAccess = true          // enables reset(forReadingTimeRanges:) for refine windows
reader.timeRange = segment               // must be set before startReading()
```
  - For refine windows: drain to `nil`, then call `out.reset(forReadingTimeRanges: [...])`, then `markConfigurationAsFinal()` when finished. A reader cannot be restarted, so create a new reader per pass if you don't use random access.
  - Scaling during decode via `kCVPixelBufferWidthKey`/`HeightKey` is **not guaranteed**: `AVVideoScalingModeKey` is unsupported on track outputs. Don't rely on it. Vision resizes internally anyway, and cropping (section 3.3) is what helps accuracy.
- Timestamps: always use `CMSampleBufferGetPresentationTimeStamp`.
  - iPhone files can be **VFR**, so never compute time as index/fps.
  - Store **asset-timeline PTS** rather than segment-relative time, so the overlay syncs with AVPlayer even with edit lists or a non-zero start.
- Decimation to the target rate: keep a frame if `pts >= nextT - 0.5/srcFps`, then `nextT += 1/targetHz`.

### 2.2 Sampling rate
- Badminton forward swing (max backswing to contact) is about 60–120 ms. That is 2–3 frames at 30 fps and 4–7 at 60 fps. The contact frame is usually motion-blurred and the wrist joint is often lost.
- Policy:
  - Base pass at **30 Hz**. Use 15–20 Hz if the measured pose latency is above 45 ms/frame or `thermalState >= .serious`.
  - **Refine pass** at native rate (if source is 50 fps or more) over [t_contact − 0.3 s, t_contact + 0.2 s] for each stroke.
- UX: recommend recording at 60 fps, and warn if the source is below 30 fps.
- Pickleball: 30 Hz is fine for dinks and drops. Drives and overheads benefit from 60.

### 2.3 Orientation
- AVAssetReader buffers come in **encoded orientation, not rotated**. Pass a `CGImagePropertyOrientation` derived from `preferredTransform` to Vision. Vision's normalized results are then in the upright image space.
- Mapping (by rotation angle `atan2(b, a)`, mirrored if `a*d − b*c < 0`):
  - 0° → `.up`
  - 90° → `.right` (normal portrait recording)
  - 180° → `.down`
  - −90° → `.left`
  - Mirrored variants: `.upMirrored` etc. **Verify the mirrored cases on device.**
- Display size = `|naturalSize.applying(t)|`.
- AVAssetImageGenerator: set `appliesPreferredTrackTransform = true` so key frames come out upright too.
- Canonical frame space (CFS): upright, origin **top-left**, x,y ∈ [0,1]. Vision returns origin bottom-left, so `y_cfs = 1 − y_vision`.

### 2.4 HDR / color
- iPhone 12+ default recordings are 10-bit HLG. Requesting 8-bit 420f from the reader works for pose (the image looks flat, which is fine).
- For key frames, set `AVAssetImageGenerator.dynamicRangePolicy` to force SDR (property exists; **iOS version: verify, believed iOS 17+**).
- Render the JPEG in sRGB.

### 2.5 Performance and memory
- Pose latency, anecdotal only: about 40 ms/frame on iPhone 11 (2021 forum report; reducing input resolution did not help). Probably 10–20 ms on A16+. **Benchmark on device.**
- Budget for a 20 s clip at 30 Hz (600 frames): about 20–30 s on an iPhone 11 and about 8–12 s on an iPhone 15. Adaptive rule: time the first 20 frames, then choose 30 or 15 Hz so that ETA ≤ 2x clip length.
- Memory and threading:
  - Wrap each frame in `autoreleasepool`.
  - Never retain `CVPixelBuffer`s; reader pool exhaustion stalls decoding. Re-fetch key frames later with the generator.
  - Run one decode thread and one Vision thread with a bounded queue of 2. Parallel Vision calls do not add throughput.

---

## 3. Pose estimation

### 3.1 VNDetectHumanBodyPoseRequest (iOS 14+), primary
- **Joints: 19.**
  - Head: `nose, leftEye, rightEye, leftEar, rightEar, neck`.
  - Arms: `leftShoulder, rightShoulder, leftElbow, rightElbow, leftWrist, rightWrist`.
  - Waist: `root` (hip center).
  - Legs: `leftHip, rightHip, leftKnee, rightKnee, leftAnkle, rightAnkle`.
- Groups: `.face, .torso, .leftArm, .rightArm, .leftLeg, .rightLeg, .all`.
- Left/right are **the subject's anatomical sides**.
- Supports **multiple people**: one `VNHumanBodyPoseObservation` per person. There is no bounding box, so derive it from the joints.
- Per frame: `VNImageRequestHandler(cvPixelBuffer:orientation:options:)`, reusing a single request instance. Read `recognizedPoints(.all)`, which gives `VNRecognizedPoint{location, confidence}`.
- **Map joint names explicitly** in an adapter `switch`. Raw string values are internal identifiers such as `"left_hand_joint"`, so never persist them (exact raw strings **unverified**).
- Swift 6: use `@preconcurrency import Vision`. VN* objects are not Sendable, so create and use them inside one task.
- Simulator behavior is **unreliable/unverified**. Test pose on a device.

### 3.2 Alternatives
- **iOS 18 Swift API:**
  - `DetectHumanBodyPoseRequest` (struct, Sendable). Has `detectsHands: Bool`, `supportedJointNames`, and `Revision`.
  - `try await req.perform(on: CVPixelBuffer | CMSampleBuffer | CGImage | CIImage | URL | Data, orientation:)` returns `[HumanBodyPoseObservation]`.
  - The observation has `joint(for: .leftWrist) -> Joint?` (`location: NormalizedPoint`, `confidence: Float`), `allJoints(in:)`, `leftHand`/`rightHand: HumanHandPoseObservation?`, and `keypoints: MLMultiArray`. It is Codable.
  - `NormalizedPoint` has `verticallyFlipped()`, `toImageCoordinates(_:origin:)`, and `toImageCoordinates(from: NormalizedRect, ...)` for ROI-relative points.
  - Presumably the same model as the legacy request, so **no expected accuracy gain (unverified)**.
  - Hand landmarks while gripping a racket are likely unreliable, so skip them in the MVP.
  - Implement as `VisionPoseEstimator18` behind `#available(iOS 18, *)` only if needed.
- **3D, `VNDetectHumanBodyPose3DRequest` (iOS 17+; Swift `DetectHumanBodyPose3DRequest` iOS 18):**
  - 17 joints: `topHead, centerHead, centerShoulder, leftShoulder, rightShoulder, leftElbow, rightElbow, leftWrist, rightWrist, root, spine, leftHip, rightHip, leftKnee, rightKnee, leftAnkle, rightAnkle`.
  - Positions are **in meters, root-relative**. `localPosition` is parent-relative. Also exposes `cameraOriginMatrix` and `pointInImage(_:)` (2D projection).
  - `bodyHeight` + `heightEstimation`: measured if depth is available, otherwise a reference of 1.8 m.
  - **Returns only one skeleton, for the most prominent person.**
  - Depth (`AVDepthData`) is optional and used "if the system allows". **No LiDAR requirement.**
  - Subclass of `VNStatefulRequest`.
  - Use: an optional enrichment run **on contact key frames only**, accepted when `pointInImage(root)` falls inside the tracked target bbox. Provides true trunk rotation, shoulder abduction and elbow angle.
  - Accuracy on fast swings is **unknown**. Keep it behind a feature flag and log for evaluation.
- **Not needed:** `VNDetectHumanRectanglesRequest` and `VNTrackObjectRequest` (correlation tracker; drifts on deformable bodies).

### 3.3 Crop-follow (small, distant players)
- A player filmed from behind the baseline is often less than 20% of frame height. Vision downsamples internally, so keypoints degrade.
- Per frame:
  1. Predict the target bbox (section 3.4).
  2. Crop = bbox expanded **2.0x** (clamped to the frame, min 25% of frame height), plus extra headroom of 1.4·L above the wrist for overhead strokes.
  3. Run pose on the crop and map back.
  4. If the crop yields no candidate passing the gating, rerun on the full frame.
- Two implementations:
  - (a) `regionOfInterest` (normalized, bottom-left origin). Results are **ROI-relative**, as suggested by `VNImagePointForNormalizedPointUsingRegionOfInterest` and the ROI overloads of `NormalizedPoint`. **Verify**, including whether it actually gains detail.
  - (b) Deterministic: `CIImage(cvPixelBuffer:).oriented(o).cropped(to:).transformed(by: translate(−origin))`, passed to `VNImageRequestHandler(ciImage:, orientation: .up, options: [.ciContext: shared])`. Map back with `x_full = (cx + x·cw)/W`, `y_bl = (cy + y·ch)/H`, `y_cfs = 1 − y_bl`.
- A/B test crop vs full frame on recorded fixtures.

### 3.4 Target selection and tracking (pure Swift)
- **First frame.** Find the first frame in [segStart, segStart + 3 s] that has at least one person. Show all skeletons and bboxes; the user taps one.
  - Pick the bbox containing the tap. If several contain it, pick the nearest centroid.
  - Auto-select only when exactly one person has mean confidence ≥ 0.5 and all others are below 30% of its area. Still show a confirmation.
  - If nobody is found, show the error "no player detected".
- **Candidate bbox:** min/max over joints with c ≥ 0.3, padded 10%, plus 0.5·L headroom.
- **Prediction:** constant velocity from the last 2 matched frames.
- **Cost:** `(1 − IoU) + 0.5·|Δcentroid|/diag(pred) + 0.2·|ln(area_c/area_pred)| + 0.3·colorDist`.
  - `colorDist` is optional: torso mean HSV via `CIAreaAverage` over the shoulder–hip quad, computed in the app layer and passed in as a feature vector. This greatly helps doubles crossings.
- **Gating:** accept if IoU > 0.1 or `|Δcentroid| < 1.5·L_px`.
- **Lost track:** coast up to 0.5 s and mark frames missing. Then re-acquire the candidate nearest the last position with similar L_px (±30%).
  - If two candidates are within 15% cost of each other, flag `track_ambiguous@t`.
  - v1.1: prompt a re-tap at t.

### 3.5 Cleanup chain (pure, offline, in this order)
1. Per-joint confidence gate: c < 0.2 → missing. Treat 0.2–0.5 as low trust and ≥ 0.5 as good (thresholds to be tuned).
2. **L/R swap fix** per limb chain (S-E-W and H-K-A). If the swapped assignment's distance to frame t−1 is less than 0.6x the identity distance, swap.
   - Vision may flip labels when the subject faces away, which is the common badminton behind view (**verify**).
   - A front-camera mirrored source (det < 0) → swap all labels.
3. Hampel outlier filter: window 7, 3·MAD, per coordinate.
4. Gap fill: ≤ 100 ms linear; ≤ 200 ms cubic Hermite if both ends are good; longer gaps stay `null`.
5. Zero-phase **Savitzky–Golay** (window 5, order 2 @30 Hz; 9/2 @60 Hz) on positions. Derivatives come from the SG derivative kernel.
   - **EMA is rejected:** its phase lag shifts contact time.
   - **One-Euro is for live overlay only** (minCutoff 1.0 Hz, beta 0.5 in L/s units, dCutoff 1.0; tune).

### 3.6 Normalization
- **Aspect correction is mandatory.** Normalized x and y have different scales, so convert before computing any angle or distance: `P = (x·W/H, 1 − y)` (units of frame height, y up).
- Torso length `L = median_t |P_neck − P_root|`. Use the shoulder midpoint or hip midpoint if neck or root is missing.
- Body space: `B(t) = (P(t) − P_root(t)) / L`. This is used for posture metrics.
- Global scaled `G(t) = P(t)/L` (not centered). This is used for footwork.
- Depth proxy: `s(t) = |P_neck − P_root|(t) / L`, median-filtered over 0.5 s. Smaller means farther from the camera. It is noisy during forward lean.
- Metric units, only if subject height is known: `m_per_L ≈ 0.30·height_m` (anthropometric assumption, **rough**). Otherwise report in L units.

### 3.7 Handedness
- Default from the profile.
- Auto-check: take the top 5 speed peaks across both wrists. If 70% or more belong to the non-profile wrist, ask the user to confirm.
- Store `handedness` and `handednessSource: user|auto|confirmed`.

---

## 4. Metrics (definitions in body space unless noted)

| Metric | Definition | Unit | Reliable views | Notes |
|---|---|---|---|---|
| elbowAngle | ∠(S,E,W) for the dominant arm | deg (180 = straight) | side > diagonal > behind | foreshortening in behind view |
| armExtension | \|S→W\| / (\|S→E\|+\|E→W\|) | 0–1 | all | more robust than the angle |
| shoulderElevation | ∠(Hip_ipsi, S, E) | deg (0 down, 180 overhead) | side, behind | abduction/flexion proxy |
| kneeFlexion | 180 − ∠(H,K,A), each side | deg | side | |
| trunkLean | angle(root→neck, vertical), signed | deg | side (fwd), behind (lateral) | |
| shoulderTilt | angle of the non-dom→dom shoulder line vs horizontal | deg | behind/front | |
| trunkRotationProxy | `acos(clamp(w_s(t)/w_s,ref))`, with `w_s` = shoulder distance and ref = 95th percentile over the clip | deg 0–90, unsigned | behind/front (inverted in side view) | Same for hips. A flip in L/R x-order means "past square". |
| hipShoulderSeparation | rot_shoulder − rot_hip | deg | behind/front | X-factor proxy; replaced by 3D when available |
| wristSpeed | \|dG_w/dt\| (global) and \|d(B_w − B_s)/dt\| (arm-relative) | L/s | all | peaks drive segmentation |
| contactHeight | B_w.y − B_head.y (head = nose if c ≥ 0.5, else mean of eyes/ears); also vs. shoulder | L | all | |
| contactFrontBack | (G_w − G_root)·d̂, with d̂ = horizontal unit of wrist velocity at contact | L | side only | |
| racketTipEst | G_w + û_forearm·(racketLen/m_per_L); badminton about 0.67 m, pickleball about 0.40 m | — | low reliability | **flag "est."** |
| stanceWidth | \|A_L − A_R\| / w_s,ref | ratio | behind/front | at ready and at contact |
| COM proxy C | 0.6·hipMid + 0.4·shoulderMid (G space) | L | — | not a segmental model |
| footwork | path length of C, peak \|dC/dt\|, lateral range, depth via s(t), recovery = \|C(end+0.8 s) − C_base\| (C_base = median C in ready periods) | L, L/s | behind best | image plane only |
| weightTransfer | ΔC·d̂ from backswing to follow-through | L | side | |
| readiness | between strokes: mean knee flexion, dom-wrist height vs root ("racket up"), stance width | — | — | common newbie fault |
| nonDomArm | in overhead prep, non-dom wrist above shoulder (bool + value) | L | all | |
| tempo | t_contact − t_backswing, t_follow − t_contact; CV across strokes of the same family | ms, % | all | consistency |
| pickleball serve | wrist below root+0.15·L at contact (navel ≈ slightly above root: **assumption**); dom wrist v_y > 0 (upward arc) | bool + value | side | the paddle-head-below-wrist rule needs the image |

Every metric carries `reliability: high|medium|low`, computed from camera view and joint confidence. The LLM prompt must be told to weight metrics by it.

### 4.1 Stroke segmentation
1. `v(t)`: SG-derivative speed of the dominant wrist (global).
2. Candidates: local maxima with `v ≥ max(Vmin, 2.5·median(v))` and prominence ≥ 0.4·v_peak.
   - Initial Vmin: badminton 4 L/s; pickleball 2 L/s; 1.2 L/s when the hint is `dink`. **Tune on labeled clips.**
3. Non-max suppression: separation 0.8 s (badminton) or 1.0 s (pickleball).
4. Reject a candidate if the dominant wrist is missing in more than 30% of ±0.2 s, if the track was re-acquired inside the window, or if the motion is a non-stroke (wrist stays below the hip with shoulder elevation < 30° and the hint is not underarm).
5. Window: start = last time `v < 0.25·v_peak` within [peak−0.8 s, peak−0.1 s]; end = first time after the peak with `v < 0.25·v_peak`, or peak+0.6 s.
6. `t_contact` = peak refined by 3-point parabolic interpolation, then re-estimated in the native-rate refine pass. Contact is assumed to be at or just after the wrist linear-speed peak (**assumption; pronation can shift it by about 1 frame**).

### 4.2 Phase times
- `prep` = window start.
- `backswing` = `argmax_{t∈[start, t_c)} −(G_w(t) − G_w(t_c))·v̂_c`, i.e. the wrist farthest "behind" its contact direction. For overhead strokes, cross-check against minimum elbow angle.
- `contact` = t_c.
- `follow` = first t > t_c with v < 0.35·v_peak, capped at t_c + 0.35 s.
- Optional: `forwardSwing` = max acceleration between backswing and contact; `recovery` = end + 0.4 s.

### 4.3 Stroke family hint (device side; Claude and the user's choice are final)
- Family:
  - overhead: wrist above head and shoulder elevation > 120°
  - side/drive: between root and head
  - underarm: below root + 0.3·L
- Side: forehand if the dominant wrist is on the dominant side of the shoulder midline at contact, after the camera-view sign flip (behind: image-right = player-right; front: mirrored); otherwise backhand. Side view is ambiguous, so give it low confidence.
- Output `{family, side, conf}`.

### 4.4 Split step (low confidence at 30 Hz)
Event criteria:
- Both ankles rise more than 0.05·L above their 0.5 s rolling median.
- Left and right lift onsets are within 70 ms of each other.
- Airborne duration is 100–400 ms.
- The event is followed within 0.15–0.8 s by `|ΔC| > 0.3·L` or a stroke start.

Output `{detected|not_detected|uncertain, conf, tBeforeMove}`. Timing relative to the opponent's hit is unobservable unless the opponent is tracked (v2).

### 4.5 What can and cannot be inferred
- **Not observable from pose:**
  - grip (forehand/backhand/panhandle)
  - racket or paddle face angle
  - forearm pronation and wrist snap
  - racket-head speed
  - true contact point
  - shuttle/ball trajectory and outcome
- **Inferable:**
  - swing timing and tempo
  - arm extension
  - contact height and relative position
  - preparation (racket arm up early)
  - non-racket arm use
  - rotation (proxy)
  - knee bend and stance
  - weight transfer
  - recovery to base
  - split step
  - consistency across strokes
- High-resolution key-frame crops let Claude partially judge grip and face angle; mark those judgments "visual, low confidence".
- v2 / experimental:
  - `VNDetectTrajectoriesRequest` (iOS 14, parabolic, stateful, needs a static camera): plausible for the pickleball ball; the shuttle decelerates, so it is only approximately parabolic.
  - A Core ML racket/shuttle detector (YOLO, or a TrackNet-style shuttle tracker).
  - Audio-onset contact detection (strong "pop" in pickleball). This would need audio and the mic permission when recording.

**Placement decision (flag for the parent):** cleanup, tracking, segmentation and phases must run on device, because key-frame selection depends on them. Computing the metric table could instead run in the Deno edge function from the uploaded track:
- it is testable on Linux now,
- it can be hot-fixed without App Store review,
- there is one source of truth.

The payload schema below supports either; `metricsSource: device|server`.

---

## 5. Key frames
- Per stroke: 4 frames (`prep, backswing, contact, follow`). Pro/detailed mode: 6 (+`forwardSwing`, `recovery`).
- Strokes with images: max 3, prioritized by hint match, track confidence, then median-ish peak speed (representative rather than best). All other strokes are sent as metrics only.
- Plus 1 full-frame context image (court position). **Caps:** free 8+1, Pro 12+1.
- Extraction:
  - `AVAssetImageGenerator(asset:)` with `requestedTimeToleranceBefore/After = .zero` and `appliesPreferredTrackTransform = true`, SDR policy, no `maximumSize`. Use `try await image(at:)` or `images(for:)`.
  - For the contact frame, choose the native-fps frame nearest t_c.
- Crop:
  - Region = union of the target bbox over the stroke window, ∪ (wrist ± racketLen/m_per_L in L units, i.e. about 1.4·L badminton or 0.8·L pickleball), expanded 1.3x, snapped to 4:3 or 3:4.
  - All phase frames of a stroke share the same crop, so they are comparable.
  - Resize so the long edge is 768. Never upscale.
- Encode: ImageIO `CGImageDestination` JPEG with `kCGImageDestinationLossyCompressionQuality = 0.75`, sRGB, no metadata. Expect about 60–100 KB each.
- Skeleton overlay variant (CGContext):
  - 2 px bones; dominant arm highlighted; low-confidence bones dashed.
  - Bones: nose-neck, neck-LS, neck-RS, LS-LE, LE-LW, RS-RE, RE-RW, neck-root, root-LH, root-RH, LH-LK, LK-LA, RH-RK, RK-RA.
  - Use it for the UI and sharing.
  - **Default: send clean crops to Claude**, with crop-relative joint coordinates in the JSON. Whether overlays improve Claude's feedback is an eval question; keep a `sendOverlay` flag.
- Privacy: in `subject=other` or doubles clips, blurring non-target faces (`VNDetectFaceRectanglesRequest` + `CIGaussianBlur`) is a v1.1 option.

---

## 6. Payload

### 6.1 Schema v1
Coordinates are quantized integers: x,y in 0–1000 in CFS (top-left), c in 0–100, and 0,0,0 means missing. Time `t` is ms on the **asset timeline**.

```json
{
  "schema": "swing.pose.v1", "algoVersion": "core-1.0.0", "configHash": "a1b2c3",
  "client": {"app":"1.0.0(42)","os":"iOS 18.6","device":"iPhone14,5","poseApi":"VNDetectHumanBodyPoseRequest.r1","locale":"vi-VN"},
  "session": {"sport":"badminton","strokeHint":"clear","handedness":"right","handednessSource":"user",
              "skillLevel":"beginner","cameraView":"behind","context":"singles","subject":"self",
              "subjectHeightCm":170,"language":"vi","isSlowMo":false},
  "video": {"durationMs":47210,"segment":{"startMs":12000,"endMs":32000},"srcFps":59.94,"analysisHz":30,
            "refineHz":60,"display":{"w":1920,"h":1080},"hdr":false},
  "quality": {"meanConf":0.71,"missingPct":6.2,"playerHeightFrac":0.31,"lrSwapsFixed":3,
              "warnings":["player_small","track_ambiguous@18400"]},
  "track": {"jointOrder":["nose","neck","lSho","rSho","lElb","rElb","lWri","rWri","root","lHip","rHip","lKne","rKne","lAnk","rAnk","lEye","rEye","lEar","rEar"],
            "t":[12000,12033],"kp":[[512,233,91, ...57 ints],[...]],"bbox":[[430,180,170,560],[...]]},
  "strokes": [{"id":1,"tStart":13420,"tContact":13910,"tEnd":14300,
     "phases":{"prep":13420,"backswing":13760,"contact":13910,"follow":14120},
     "classGuess":{"family":"overhead","side":"forehand","conf":0.72},
     "metrics":{"elbowAngleContact":{"v":148,"rel":"medium"},"contactHeightL":{"v":1.12,"rel":"high"},
                "shoulderElevContact":{"v":151,"rel":"high"},"trunkRotProxyMax":{"v":63,"rel":"medium"},
                "kneeFlexPrep":{"v":28,"rel":"low"},"wristPeakLps":{"v":17.4,"rel":"high"},
                "nonDomArmUp":{"v":true,"rel":"medium"},"tempoBackToContactMs":150},
     "series10Hz":{"t0":13400,"elbow":[...],"shoElev":[...],"knee":[...],"wristSpd":[...]},
     "keyFrames":["s1_prep","s1_back","s1_contact","s1_follow"],"stroke_quality":{"meanConf":0.78,"missingPct":2}}],
  "movement": {"pathL":14.2,"peakSpeedLps":3.1,"recoveryMeanL":0.6,"splitSteps":[{"t":13010,"conf":0.4}],
               "readiness":{"kneeFlexMean":18,"racketUpPct":35,"stanceRatio":1.3}},
  "keyFrames": [{"id":"s1_contact","strokeId":1,"phase":"contact","t":13911,
                 "path":"{uid}/{analysisId}/s1_contact.jpg","w":768,"h":576,
                 "cropCfs":[380,90,330,620],"kp":[[...crop-relative ints]],"overlay":false}],
  "metricsSource": "device"
}
```

### 6.2 Sizes (estimates)

| Part | Size |
|---|---|
| Track | about 240 B/frame (19×~11 chars + t + bbox). 30 s @30 Hz ≈ **215 KB**; @60 Hz ≈ 430 KB. Raw DEFLATE ≈ 3:1 (70–140 KB). |
| Strokes | about 1.2 KB each (+0.5 KB with series10Hz); ≤ 20 strokes → ~35 KB |
| Key frames | 13 × 60–100 KB → **0.8–1.3 MB** |
| Edge-function body (no track) | about **10–30 KB** |
| Comparison | a 30 s 1080p60 HEVC source is ≈ 50 MB, so the upload is about 40x smaller |
| Claude input | summary 3–6k tokens + images (≈ w·h/750 → 768×576 ≈ 590 tokens each; 13 ≈ 7.7k) ≈ **12–15k input tokens**. **Verify the image-token formula for the chosen model** via the claude-api reference. The raw track is NOT sent to Claude. |

### 6.3 Transport
- Upload JPEGs and `pose.json` to a private Storage bucket at `{uid}/{analysisId}/...` (supabase-swift Storage upload), then call the edge function with `{analysisId, payload minus track}`.
- Compression pitfall: `(data as NSData).compressed(using: .zlib)` emits **raw DEFLATE (RFC 1951), with no zlib or gzip header**. On Deno, decode with `new DecompressionStream("deflate-raw")`. Alternatively, skip compression, since about 200 KB is acceptable.

---

## 7. Skeleton overlay playback
- Pose data is stored in CFS with asset-timeline ms, so it syncs directly with the AVPlayer time.
- **Recommended:** `UIViewRepresentable` → `PlayerView: UIView` with `override class var layerClass { AVPlayerLayer.self }` and `videoGravity = .resizeAspect`.
  - Sublayers: `CAShapeLayer` bones, `CAShapeLayer` joints, and optional angle arcs at contact.
  - In `layoutSubviews`, read `playerLayer.videoRect`. Map `pt = videoRect.origin + (x·videoRect.width, y·videoRect.height)`.
- Sync:
  - `CADisplayLink` → time from `AVPlayerItemVideoOutput.itemTime(forHostTime: CACurrentMediaTime())` (frame-accurate), or `player.currentTime()` (simpler).
  - Plus `addPeriodicTimeObserver(forInterval: CMTime(1,60), queue: .main)` for paused/seek updates.
  - Look up the pose by binary search on `t`. Interpolate linearly between samples, but not across gaps > 100 ms (hide instead).
  - Wrap layer updates in `CATransaction.setDisableActions(true)`.
- Controls (SwiftUI):
  - play/pause; rate 0.25/0.5/1 (mute audio, or use the `.timeDomain` pitch algorithm)
  - frame step via `playerItem.step(byCount: ±1)`
  - a scrubber with stroke markers; tapping a marker seeks to contact with zero tolerance
  - a toggle for skeleton/metrics callouts
- Acceptable simpler alternative: SwiftUI `VideoPlayer(player:videoOverlay:)` + `GeometryReader` + `AVMakeRect(aspectRatio:insideRect:)` + `TimelineView(.animation)` + `Canvas`. It has worse sync and the overlay sits under the system controls.
- v2 shareable export: `AVVideoComposition` + `AVVideoCompositionCoreAnimationTool`.

---

## 8. Package split and testability

```
Packages/SwingCore/   (swift-tools-version 6.0; platforms .iOS(.v17), .macOS(.v14); Linux-buildable)
  Sources/SwingCore/
    Model/      Joint (19-case enum, own names), Keypoint, PoseFrame, PoseTrack, Vec2, Rect (Double)
    Signal/     Hampel, SavitzkyGolay (smooth + derivative), OneEuro, EMA, GapFill, PeakFinder
    Tracking/   TargetSelector (tap), Tracker (IoU/cost/gating/coast), LRSwapFixer, BBoxFromJoints
    Kinematics/ Normalizer (aspect, L, body/global spaces), Angles, MetricCalculators, Reliability
    Strokes/    StrokeSegmenter, PhaseDetector, StrokeClassifier, SportConfig presets
    Movement/   Footwork, SplitStep, Readiness
    KeyFrames/  KeyFramePlanner (times + crop rects + caps), SkeletonGeometry (bones -> segments)
    Payload/    AnalysisPayload v1 (Codable), Quantizer, PayloadBuilder
  Tests/SwingCoreTests/ (swift-testing): synthetic swing generators (sinusoidal arm + noise + dropouts),
    device-recorded fixtures (debug "export pose JSON" menu), golden outputs
App target (Apple-only adapters): FrameReader (AVAssetReader), Orientation, VisionPoseEstimator(+18),
  BodyPose3DEnricher, CropProvider (CIImage), KeyFrameRenderer (AVAssetImageGenerator/CG/ImageIO),
  Recorder, Importer, Trimmer, OverlayPlayerView, AnalysisPipeline
```

- Rules for SwingCore:
  - Imports: `Foundation` only. No `simd`, `CoreGraphics`, `Accelerate`, `os.Logger`, or `Combine`; these are unavailable or different on Linux.
  - Conversions to `CGPoint` live in an app-side `#if canImport(CoreGraphics)` extension.
  - Deterministic: no `Date()` or randomness.
  - Every threshold lives in `SportConfig`, and its hash goes into the payload.
- Shared contract: `shared/schemas/analysis-payload.v1.schema.json` + `shared/fixtures/*.json`. Swift tests encode and compare against them; Deno tests validate the same files, which keeps the client and server in sync.
- XcodeGen: `packages: { SwingCore: { path: Packages/SwingCore } }` and a target dependency `- package: SwingCore`.
- Linux: Swift 6 toolchains for Linux exist (swift.org tarballs / swiftly). Whether they can be installed through this container's proxy is **unverified**. Until then, Swift is review-only, and only the TS/SQL parts are actually executed.

## 9. Pipeline orchestration
- `AnalysisPipeline.run(draft) -> AsyncThrowingStream<Event>`. Events: `.decoding(pct)`, `.pose(pct)`, `.strokes(n)`, `.keyFrames`, `.uploading(pct)`, `.done`.
- It runs in `Task.detached(priority: .userInitiated)`; VN/AV objects stay task-confined. A `@MainActor @Observable` view model consumes the events.
- Call `Task.checkCancellation()` per frame.
- Set `UIApplication.shared.isIdleTimerDisabled = true` while running.
- On `scenePhase == .background`: hardware decode is likely interrupted and AVAssetReader likely fails (**verify the error code**). Persist processed frames and resume from the last PTS when the app returns. Use `beginBackgroundTask` for a short grace period.
- iOS 26+ option (v1.1): `BGContinuedProcessingTask` / `BGContinuedProcessingTaskRequest`.
  - User-initiated, with progress shown in a Live Activity; it must report progress via `ProgressReporting`.
  - GPU use needs the entitlement `com.apple.developer.background-tasks.continued-processing.gpu`.
- Thermal: observe `ProcessInfo.thermalStateDidChangeNotification`; at `.serious` or above, drop to 15 Hz.

## 10. Pitfall checklist
1. AVAssetReader frames are unrotated: pass the orientation to Vision.
2. Vision origin is bottom-left: flip to CFS.
3. Aspect-correct the coordinates before any angle or distance.
4. Use PTS, not frame index (VFR).
5. Store asset-timeline time (edit lists).
6. HDR 10-bit: request 8-bit for the reader and SDR for key frames.
7. Slo-mo time-stretch.
8. Front-camera mirroring.
9. Don't retain pixel buffers.
10. VN* types are not Sendable.
11. Test pose on a device, not the Simulator.
12. 0.5x lens distortion.
13. Small player: crop-follow plus a warning if the player is below 15% of frame height.
14. L/R label flips in back view.
15. 30 fps misses contact: refine pass plus a 60 fps recommendation.
16. 2D metrics are view-dependent: tag reliability per view.
17. The trimmer must not re-encode.
18. `NSData .zlib` is raw DEFLATE.

## 11. Uncertain / verify on device
- Per-frame Vision latency by device (only anecdotal: about 40 ms on iPhone 11).
- `regionOfInterest`: ROI-relative coordinates and whether it actually gains detail compared with an explicit crop.
- Whether `kCVPixelBufferWidth/HeightKey` scales in `AVAssetReaderTrackOutput`.
- Mirrored `preferredTransform` → orientation mapping.
- iOS version of `AVAssetImageGenerator.dynamicRangePolicy`.
- Slo-mo behavior through PhotosPicker.
- Whether `VNDetectHumanBodyPose3DRequest` holds up on fast swings, and how it behaves per-image given it is stateful.
- Whether the iOS 18 `DetectHumanBodyPoseRequest` uses the same model as the legacy request.
- Vision L/R label behavior in back view.
- Simultaneous `AVCaptureVideoDataOutput` + `AVCaptureMovieFileOutput` (for live framing checks).
- AVAssetReader failure in background.
- Contact time versus wrist-speed peak offset.
- All numeric thresholds (Vmin, prominence, NMS spacing, confidence gates, One-Euro parameters, split-step criteria), which need a labeled clip set of about 30 clips per sport/stroke.
- Anthropometric constants (L ≈ 0.30·height, navel offset).
- Claude image-token formula for the model in use.
- iOS 27 / WWDC26 Vision changes: none found in search; check the release notes.

Sources:
- [DetectHumanBodyPoseRequest](https://developer.apple.com/documentation/vision/detecthumanbodyposerequest)
- [VNHumanBodyPoseObservation.JointName](https://developer.apple.com/documentation/vision/vnhumanbodyposeobservation/jointname)
- [VNDetectHumanBodyPose3DRequest](https://developer.apple.com/documentation/vision/vndetecthumanbodypose3drequest)
- [VNHumanBodyPose3DObservation.JointName](https://developer.apple.com/documentation/vision/vnhumanbodypose3dobservation/jointname)
- [WWDC23 – Explore 3D body pose and person segmentation in Vision](https://developer.apple.com/videos/play/wwdc2023/111241/)
- [HumanBodyPoseObservation](https://developer.apple.com/documentation/vision/humanbodyposeobservation)
- [PoseProviding](https://developer.apple.com/documentation/vision/poseproviding)
- [Joint](https://developer.apple.com/documentation/vision/joint)
- [NormalizedPoint](https://developer.apple.com/documentation/vision/normalizedpoint)
- [VNImageBasedRequest.regionOfInterest](https://developer.apple.com/documentation/vision/vnimagebasedrequest/regionofinterest)
- [VNDetectTrajectoriesRequest](https://developer.apple.com/documentation/vision/vndetecttrajectoriesrequest)
- [PhotosPickerItem.EncodingDisambiguationPolicy](https://developer.apple.com/documentation/photosui/photospickeritem/encodingdisambiguationpolicy)
- [AVAssetImageGenerator](https://developer.apple.com/documentation/avfoundation/avassetimagegenerator)
- [AVAssetReaderTrackOutput](https://developer.apple.com/documentation/avfoundation/avassetreadertrackoutput)
- [BGContinuedProcessingTask](https://developer.apple.com/documentation/backgroundtasks/bgcontinuedprocessingtask)
- [Forum: slow-mo re-encode via PHPicker](https://developer.apple.com/forums/thread/693127)
- [Forum: body pose latency ~40 ms iPhone 11](https://developer.apple.com/forums/thread/679909)
- [Forum: AVAssetReader settings](https://developer.apple.com/forums/thread/768883)
