# Research: sport-rubric

> Research output from 2026-10-18 (unverified claims marked inside). DESIGN.md is authoritative.

# Coaching Domain Model v0.1: Badminton and Pickleball
*(Built for 2D-pose metric checks plus an LLM rubric. Dated 2026-10-18.)*

Read this first:
- Numbers marked **≈** are starting guesses. Each one needs calibrating on about 20–30 coach-labelled clips per stroke.
- All Vietnamese terminology needs review by a native Vietnamese coach (see §5).
- The rule references were checked against the web on 2026-10-18; see the Sources section.

---

## 0. Shared conventions (both sports)

### 0.1 How each checkpoint can be assessed
| Tag | Meaning | Who scores it |
|---|---|---|
| **M** | Reliably measurable from 2D Vision keypoints when filmed from the listed view | Deterministic code |
| **M~** | Measurable but rough: depends on view, suffers foreshortening and jitter, or needs 60 fps | Code, with reduced confidence |
| **V** | The data is not in the body keypoints, so it is judged from cropped key frames | LLM, on an anchored 0–4 scale, with `not_assessable` allowed |
| **N** | Cannot be assessed from this input. It would need racket, ball or court-line tracking, or a close-up | Neither. The app says "can't check from video" |

**Views:**
- **S** = side-on. The camera is on the sideline, square to the hitting direction, on the player's **racket-hand side**.
- **B** = behind the baseline. A front-on view behaves the same way, mirrored.
- **D** = 45° diagonal. Usable as a fallback, but most M checks drop to M~.

### 0.2 Keypoints Apple Vision provides (`VNDetectHumanBodyPoseRequest`, 19 joints)
- **Available:** nose, L/R eye, L/R ear, neck, L/R shoulder, L/R elbow, L/R wrist, root (pelvis centre), L/R hip, L/R knee, L/R ankle.
- **Not available**, which drives most V/N tags:
  - fingers and hand, so grip is V or N
  - toes and heels, so "on the balls of the feet" and foot direction are V or N
  - racket or paddle, so face angle and "paddle head below wrist" are V
  - shuttle or ball, so trajectory, depth and height over the net are N or V
  - court lines and net, so foot faults and kitchen violations are V or N
- Hand pose detection is unreliable at 3–6 m.
- The iOS 17+ 3D body-pose request could reduce how much joint angles depend on the camera view. Treat it as experimental.

### 0.3 Normalisation and metric primitives
Put these in the backend as pure TypeScript so they can be unit-tested with Deno on Linux. Rubric thresholds go in a versioned JSON file.

Convert Vision's normalised coordinates (origin at bottom-left) to pixels before computing any angle: `X = x·W`, `Y = y·H`, with Y pointing up. Filter each joint with a 1€ (one-euro) filter. Drop joints with confidence < 0.3 and interpolate gaps of 3 frames or fewer.

| Primitive | Definition | Views |
|---|---|---|
| `T` (body unit) | Torso length \|neck−root\| in px, as a rolling median over 1 s. **All lengths are in T.** Anthropometric approximations: shoulders at wristH ≈ 1.0, nose ≈ 1.3, straight arm overhead ≈ 2.0. 1 T/s ≈ 0.5 m/s | all |
| `kneeFlex` | 180° − ∠(hip, knee, ankle). 0° = straight leg | S good, B/D M~ |
| `elbowAng` | ∠(shoulder, elbow, wrist) on the racket arm. 180° = straight. 2D tends to under-read it | S, B (M~) |
| `trunkLean` | Angle of the root→neck vector from vertical. Signed forward/back in S only | S |
| `shinAngle` | Angle of ankle→knee from vertical. + means the knee is ahead of the ankle | S |
| `stanceW` | \|ankleL.X − ankleR.X\| ÷ `SWmax`·T. `SWmax` = 95th percentile of shoulder width/T in the clip | B |
| `stagger` | Fore–aft ankle distance / T | S |
| `turn` (°) | Shoulder-line rotation magnitude. B: acos(SW/T ÷ SWmax); S: asin(SW/T ÷ SWmax). Error ≈ ±15–20°, direction is ambiguous, use magnitude only. `hipTurn` is the same with hip width | B (S) M~ |
| `wristH` | (wrist.Y − root.Y)/T. 0 = hip-joint level | any |
| `reach` | (wrist.Y − shoulder.Y)/Larm, where Larm = 95th percentile of (\|sh−el\| + \|el−wr\|)/T. 1.0 = arm straight up | any |
| `elbowRel` | (elbow.Y − shoulder.Y)/T on the racket side | any |
| `wristFwd` | (wrist.X − racket-shoulder.X)·f/T. f = facing sign (from nose vs ear midpoint in ready frames; fall back to an LLM check on a key frame). + = in front of the body | S |
| `wristLat` | (wrist.X − torso-midline.X)·h/T. h = handedness sign | B |
| `vWrist`, `vyWrist`, `vRoot` | Speed and vertical velocity in T/s, from central differences | any (60 fps strongly preferred) |
| `bsLen` / `ftLen` | Racket-wrist path length from swing start to contact / from contact to stop. Swing start and stop are where `vWrist` < 0.5 T/s, within ±1 s | any; M~ in B because of depth |
| `ftCross` | Racket wrist crosses the neck–root line to the non-racket side within 0.6 s after contact | B / front |
| `wShift` | (root.X − rearAnkle.X)/(frontAnkle.X − rearAnkle.X). 0 = weight over the rear foot, 1 = over the front foot | S |
| `hop` (split step) | Both ankles rise ≥ 0.04 T (≈) within 2 frames of each other, then land 0.1–0.4 s later | S/B M~ |
| `moveOnset` | Horizontal `vRoot` > 0.8 T/s for at least 3 frames | S/B |
| `baseErr` | \|root − base\|/T, where base = median root position during ready frames | B (depth M~), S |
| `crossStep` | The left/right order of the ankles swaps during a lateral move | B |
| `headStill` | Nose displacement /T over [−0.2, +0.1] s around contact | any |

### 0.4 Events
- **Contact frame.**
  - Primary signal: an audio impact transient. The pickleball "pop" is very reliable; a badminton hit is fainter.
  - Use the transient nearest the `vWrist` peak, within ±120 ms.
  - Fallback: the `vWrist` peak for overheads and drives. For dinks and net shots, use audio only, otherwise `not_assessable`.
  - Expected error is ±1–2 frames at 60 fps.
- **Reps.** One rep is the window [contact − 1.2 s, contact + 1.0 s].
- **Phase boundaries.**
  - prep: from `moveOnset`/split landing to `bsEnd`
  - `bsEnd`: the last local minimum of `vWrist` before contact
  - follow-through: contact to `ftStop`
  - recovery: `ftStop` to +1.2 s
- **Stroke type.** **The user picks it before recording** (for example "Forehand clear"). This is more reliable than auto-classification for the MVP. A "Rally" mode can be added later that only scores stance and footwork, with the LLM labelling strokes.
- **Handedness.** The arm with the higher 95th-percentile `vWrist` is the racket arm. The profile can override it. For left-handers, mirror every lateral sign.

### 0.5 Quality gates (run on the iPhone before upload)
- At least 80% of frames inside rep windows have all 12 limb joints at confidence ≥ 0.3.
- Frame rate ≥ 50 fps is preferred. At 30 fps, every velocity- or timing-based metric is downgraded one tier (M→M~, M~→V/N).
- The view classifier (median SW/T in ready frames, plus nose/ear visibility) must match the view the stroke recommends. If not, warn the user and apply the view factor from §3.3.
- Track one person: the user taps themselves, then tracking follows by bounding-box IoU. Vietnamese badminton halls often have several courts in one frame.

---

## 1. BADMINTON

### 1.1 Skill taxonomy (beginner → intermediate)
| ID | Skill | VI (app copy) | Level | Primary / secondary view | Assessability |
|---|---|---|---|---|---|
| bd.grip | Forehand (handshake) and backhand (thumb) grip | Cầm vợt thuận tay / trái tay | L1 | Close-up photo | V / N |
| bd.ready | Ready stance (defensive / attacking) | Tư thế chuẩn bị (thế thủ / thế công) | L1 | B / S | M |
| bd.split | Split step | Bật nhún (split step) | L1–L2 | B / S | M~ |
| bd.footwork | Front / rear corners, 6-corner shadow | Bộ pháp, di chuyển 6 góc | L1–L3 | B / S | M, M~ |
| bd.clear.fh | Forehand overhead clear | Phông cầu thuận tay (đánh cầu cao sâu) | L1 | S / B | M + V |
| bd.smash | Smash (standing → jump) | Đập cầu (đập đứng / nhảy đập) | L2 (jump L3) | S / B | M + V |
| bd.drop | Overhead drop (plain → slice) | Bỏ nhỏ cuối sân / chém cầu | L2 | S | M~ + V |
| bd.net | Net shot and net lift | Bỏ nhỏ trên lưới / vẩy cầu (hất cầu) | L1 | S | M + V |
| bd.clear.bh | Backhand overhead clear | Phông cầu trái tay | L2–L3 | B | M~ + V |
| bd.serve.low | Low backhand serve | Giao cầu thấp (ngắn) trái tay | L1 | S | M + V |
| bd.serve.high | High forehand serve (singles) | Giao cầu cao sâu thuận tay | L1 | S | M + V |
| *(v2)* | Drive, push, block, smash defence, net kill, round-the-head | Tạt cầu, đẩy cầu, chặn cầu, đỡ đập, chụp lưới, đánh vòng đầu | L2–L3 | B/S | M~ + V |

### 1.2 Grip (bd.grip): V or N only
In normal clips the hand is roughly 20 px wide. **Recommended feature:** an optional "Grip photo" step. The user photographs their hand on the racket from 30–50 cm, once with the forehand grip and once with the backhand grip, and the LLM judges the photos.

| ID | Checkpoint | Tag | LLM anchors (0 / 2 / 4) |
|---|---|---|---|
| G1 | Forehand handshake grip, V-shape on the correct bevel | V (photo), N (clip) | 0 = clear panhandle ("cán chảo") / 2 = handshake but fist-tight or choked / 4 = handshake, correct bevel, relaxed fingers |
| G2 | Backhand: thumb pad flat on the wide back bevel | V/N | 0 = forehand grip used for backhand / 4 = clear thumb grip |
| G3 | Relaxed pressure, gap between palm and handle | V/N | — |
| G4 | Changes grip between forehand and backhand | N in clips | — |

| Common fault | Fix cue | Drill |
|---|---|---|
| Panhandle grip | "Shake hands with the racket edge" | Lay the racket on its edge, pick it up by the handle: 3×10. Check in a mirror |
| Death grip | "Hold it like a bird; squeeze only at contact" | Shadow swing as relax→squeeze→relax: 3×10 |
| Never changes grip | "Thumb up for backhand" | Grip twirl forehand↔backhand: 3×20 |

### 1.3 Ready stance (bd.ready)
| ID | Checkpoint | Tag (view) | Metric | Target ≈ | Tol |
|---|---|---|---|---|---|
| R1 | Feet slightly wider than shoulders | M (B) | stanceW | 1.0–1.6 | 0.3 |
| R2 | Knees softly bent | M (S), M~ (B) | kneeFlex, both knees | 15–45° | 10° |
| R3 | Slight forward lean | M (S) | trunkLean forward | 10–30° | 10° |
| R4 | Racket up, in front | M (wristH), M~ (S, wristFwd) | wristH; wristFwd | 0.5–1.3; ≥ 0.2 | 0.3 |
| R5 | Centred balance | M~ (B) | root offset from ankle midpoint ÷ span | ≤ 0.25 | 0.2 |
| R6 | On the balls of the feet, heels light | N (V if feet are large in frame) | — | — | — |
| R7 | Racket head up | V | — | — | — |

| Fault | Detected by | Fix | Drill |
|---|---|---|---|
| Standing tall, straight legs | R2, R3 low | "Sit slightly, chest over knees" | 3×30 s ready-hold, then 10 reaction starts on a partner's "go" |
| Racket dropped to the knees | R4 | "Racket up like you're about to catch" | Partner tosses a shuttle, you tap it with the racket face: 3×15 |
| Feet together | R1 | "Feet just wider than shoulders" | Hop and land in stance: 3×10 |
| Weight back on the heels | R3 < 0, root behind the ankles (S) | "Nose over toes" | 3×20 s forward-weight holds plus 10 quick first steps |

### 1.4 Split step (bd.split)
| ID | Checkpoint | Tag | Metric | Target ≈ | Tol |
|---|---|---|---|---|---|
| S1 | Split before each movement | M~ (B/S, 60 fps) | `hop` within 0.6 s before `moveOnset` | ≥ 70% of movements | — |
| S2 | Timing | M~ | landing → moveOnset gap; or landing vs the opponent-hit audio onset | 0–0.25 s; −0.05…+0.2 s | 0.15 s |
| S3 | Small, quick hop | M~ | ankle rise | 0.04–0.2 T | 0.1 T |
| S4 | Lands wide and flexed | M~ | stanceW at landing vs ready; kneeFlex gain | ≥ 1.1×; ≥ +10° | — |

| Fault | Fix | Drill |
|---|---|---|
| No split step (flat-footed) | "Small hop as the opponent hits" | Partner claps at random, you split and move to the pointed corner: 3×20 |
| Splits too early, then waits (S2 gap > 0.4 s) | "Land as they hit" | Split on the feeder's racket contact: 3×10 per side |
| Hop too high (S3 > 0.3 T) | "Bounce, don't jump" | Low jump-rope bounces: 3×30 s |
| Lands narrow (S4) | "Land wider than you started" | Split-and-freeze, check the width: 3×10 |

### 1.5 Footwork (bd.footwork)
| ID | Checkpoint | Tag | Metric | Target ≈ | Tol |
|---|---|---|---|---|---|
| FW1 | Returns to base after each shot | M~ (B lateral M; depth M~) | baseErr before the next split | ≤ 0.6 T | 0.6 |
| FW2 | Front corners: lunges with the racket leg | M (S), M~ (B) | front ankle on the racket side | ≥ 80% of reps | — |
| FW3 | Lunge depth and posture | M (S) | front kneeFlex; shinAngle; trunkLean | 50–100°; ≤ 30°; ≤ 35° | 15° |
| FW4 | Knee tracks over the foot (no inward collapse) | M~ (front / B) | knee.X within hip–ankle line ± 0.15 T | pass | **injury flag** |
| FW5 | Rear court: turns side-on, no backpedalling while facing the net | M~ (B) | turn ≥ 45° during backward travel | pass | — |
| FW6 | Stays low and stable while moving | M~ | root vertical peak-to-peak (no jump) | ≤ 0.25 T | 0.15 |
| FW7 | Efficiency | M~ | step count (ankle speed peaks), cycle time | **personal trend only** | not scored vs. absolute |

| Fault | Fix | Drill |
|---|---|---|
| Backpedals facing the net (FW5) | "Turn side-on first, then chassé" | Shadow "turn–chassé–scissor" to each rear corner: 3×8 |
| Wrong lunge leg (FW2) | "Racket leg lands last, in front" | Lunge to touch a shuttle on the floor at each front corner: 3×10 |
| Collapsing lunge: trunk folded, knee far past the foot (FW3/4) | "Chest up, knee over the foot, push back through the heel" | Slow lunge-and-push-back: 3×8 per side |
| Doesn't return to base (FW1) | "Every shot: back to centre, split" | 6-corner shadow with random calls: 4×12 movements, 45 s rest |
| Bobs up between steps (FW6) | "Move like there's a low ceiling" | Chassé ladder: 3×2 lengths |

### 1.6 Forehand overhead clear (bd.clear.fh)
**Phases:**
- Prep: turn side-on, both arms up, get behind the shuttle.
- Backswing: elbow up and back into a "throwing" position, weight on the rear leg.
- Contact: highest point, slightly in front and to the racket side, arm nearly straight, forearm pronation.
- Follow-through: racket continues down and across to the non-racket hip, trunk rotates through.
- Recovery: scissor kick brings the rear leg through, push back to base, racket up.

| ID | Phase | Checkpoint | Tag (view) | Metric | Target ≈ | Tol |
|---|---|---|---|---|---|---|
| C1 | Prep | Side-on turn | M~ (B best, S) | turn at bsEnd | ≥ 60° | 20° |
| C2 | Prep | Non-racket arm raised and pointing | M (any) | non-racket wristH at bsEnd | ≥ 1.1 | 0.3 |
| C3 | Backswing | Racket elbow up ("throwing" position) | M (S/B) | elbowRel at bsEnd | ≥ −0.15 | 0.2 |
| C4 | Backswing → contact | Weight from rear to front | M~ (S) | wShift at bsEnd → at contact + 0.2 s | ≤ 0.4 → ≥ 0.55 | 0.15 |
| C5 | Contact | Hits at a high point | M (any) | reach at contact | ≥ 0.85 | 0.25 |
| C6 | Contact | Contact slightly in front | M~ (S only) | wristFwd | 0.0–0.6 T | 0.3 |
| C7 | Contact | Arm near-extended | M~ (S/B) | elbowAng | ≥ 150° | 20° |
| C8 | Follow-through | Racket finishes across the body, below the shoulder | M (B/front) | ftCross and wristH < 1.0 within 0.6 s | pass | — |
| C9 | Follow-through | Trunk rotates through | M~ (B) | turn at contact + 0.2 s | ≤ 25° | 15° |
| C10 | Recovery | Scissor / step-through and move to base | M~ (S/B) | root moves toward base within 0.6 s; racket wristH ≥ 0.8 by 1.0 s | pass | — |
| C11 | Contact | Racket face, pronation | N (V if not blurred) | — | not scored | — |
| C12 | Outcome | Shuttle high and deep | N (optional self-report "reached the back tramlines?") | — | — | — |

| Fault | Detected by | Fix | Drill |
|---|---|---|---|
| Facing the net, no turn | C1 | "Point your non-racket shoulder at the shuttle" | Shadow "turn-and-point" 3×10 slow, then 3×10 with a feeder |
| Low elbow, pushing the shuttle | C3, C7 | "Elbow at shoulder height, like throwing a ball" | Overhead throw of a shuttle or ball for distance: 3×15. Towel-snap swings: 3×10 |
| Contact low, late or behind the head | C5, C6 | "Get behind it early; hit at the top, in front" | Shadow under a shuttle hung at reach height: 3×15. Then feeder high serves: 3×10 |
| Non-racket arm limp | C2 | "Point up, then pull down as you swing" | Shadow counting "point–pull": 3×10 |
| Flat-footed, no weight transfer | C4, C10 | "Load the back leg, scissor through" | Shadow scissor-kick clears: 3×10 |
| Swing stops at contact | C8, C9 | "Finish by your opposite hip" | Shadow swings touching the opposite hip with the racket: 3×10 |
| Admires the shot, no recovery | C10 | "Hit, then back to centre" | Feeder clears, recover and touch the centre: 3×8 |

### 1.7 Smash (bd.smash)
Phases are the same as the clear. Prep must look identical to the clear, so C1–C3 are reused.

| ID | Checkpoint | Tag | Metric | Target ≈ | Tol |
|---|---|---|---|---|---|
| SM1 | Clear-like prep | as C1–C3 | — | — | — |
| SM2 | Contact high and further in front than a clear | M (reach), M~ (S, wristFwd) | reach; wristFwd | ≥ 0.75; 0.2–0.9 T | 0.25 |
| SM3 | Arm extends at contact | M~ | elbowAng | ≥ 145° | 20° |
| SM4 | Faster racket arm than own clear | M~ (relative, same session and view) | peak vWrist smash ÷ clear | ≥ 1.15× | **never compare absolute speed across users** |
| SM5 | Body drives forward and down | M (S) | trunkLean forward at contact + 0.2 s; wShift | ≥ 15°; ≥ 0.7 | 10° |
| SM6 | Follow-through down and across | M (B) | wristH at ftStop; ftCross | ≤ 0.6; pass | — |
| SM7 | Soft, balanced landing (jump smash) | M~ | kneeFlex at landing; root inside base within 0.3 s | ≥ 20° | **injury flag if < 10°** |
| SM8 | Recovers forward, racket up | M~ | toward net or base within 0.5 s; wristH ≥ 0.8 by 0.8 s | pass | — |
| SM9 | Steep angle, closed face | N/V | — | — | — |

| Fault | Fix | Drill |
|---|---|---|
| Hits too far behind the body, smash goes flat or long (SM2) | "Hit in front of your head, about 1 o'clock" | Feeder lifts to mid-court, step in and smash: 4×8 |
| All arm, no body (C1, SM5) | "Turn, then uncoil the chest" | Kneeling smash, focusing on upper-body rotation: 3×10 |
| Stiff or off-balance landing (SM7) | "Land on bent knees, under your body" | Jump, land and hold for 2 s: 3×8. Then 3×6 jump smashes |
| Over-swings, recovers slowly (SM8) | "Smash, then step in, racket up" | Smash-and-follow-to-net (feeder pushes to the net): 3×8 |

### 1.8 Overhead drop (bd.drop)
| ID | Checkpoint | Tag | Metric | Target ≈ | Tol |
|---|---|---|---|---|---|
| DR1 | Same prep as the clear (deception) | M~ (relative) | C1–C3 pass, plus \|Δturn\| vs own clear ≤ 15°, \|ΔelbowRel\| ≤ 0.15 | pass | — |
| DR2 | Contact high and in front | M / M~ (S) | reach ≥ 0.75; wristFwd 0.1–0.7 T | — | 0.25 |
| DR3 | Controlled racket speed | M~ (relative) | peak vWrist ÷ own clear | 0.4–0.8× | 0.15 |
| DR4 | No early slow-down (telegraphing) | M~ (relative) | (bsEnd→contact) duration ÷ clear's | ≥ 0.8× | 0.15 |
| DR5 | Moves in after the drop | M~ (S) | root moves toward the net within 0.5 s | pass | — |
| DR6 | Slice and face angle; shuttle falls close to the net | V/N | — | — | — |

If no clear was recorded in the session, DR1, DR3 and DR4 fall back to the absolute C1–C3 checks plus ftLen 0.5–1.8 T.

| Fault | Fix | Drill |
|---|---|---|
| Telegraphs the drop with a slow prep (DR1/4) | "Look exactly like a clear until contact" | Alternate clear and drop off one feed with the same prep: 4×6 |
| Late contact, drop floats (DR2) | "Contact in front, guide down" | Drops into a hoop or towel in the service box: 3×10 |
| Stiff push, no follow-through | "Short, relaxed follow-through" | Shadow 3×10, then feeder 3×10 |
| Stays back after the drop (DR5) | "Drop, then move in to mid-court" | Drop, then split at mid-court: 3×8 |

### 1.9 Net shot and net lift (bd.net)
**Phases:**
- Prep: racket up early.
- Approach: chassé or running steps, finishing in a lunge with the racket leg.
- Contact: early, high, arm extended.
- Follow-through: net shot = minimal "touch"; lift = low-to-high.
- Recovery: push back off the front foot to base.

| ID | Checkpoint | Tag | Metric | Target ≈ | Tol |
|---|---|---|---|---|---|
| NS1 | Racket up before the lunge lands | M | wristH at front-foot landing | ≥ 0.7 | 0.3 |
| NS2 | Racket-leg lunge | M (S) | = FW2 | pass | — |
| NS3 | Lunge depth and posture; knee alignment | M (S); M~ (front) | = FW3, FW4 | — | injury flag |
| NS4 | Early contact, arm extended in front | M~ (S) | wristFwd; elbowAng; wristH | ≥ 0.6 T; ≥ 130°; ≥ 0.6 | 0.3 / 20° |
| NS5 | Net shot: tiny backswing | M~ | bsLen | ≤ 0.4 T | 0.3 |
| NS6 | Net shot: gentle follow-through | M~ | ftLen | ≤ 0.5 T | 0.3 |
| NL5 | Lift: low-to-high finish | M~ | wrist rise from contact to ftStop; ftLen | ≥ 0.6 T; ≥ 1.0 T | 0.3 |
| NS7 | Pushes back to base | M~ | backward vRoot begins within 0.4 s | pass | — |
| NS8 | Face angle, spin, shuttle tight to the tape | V/N | — | — | — |

| Fault | Fix | Drill |
|---|---|---|
| Wrong lunge leg (NS2) | "Racket foot forward" | Racket-up shadow lunges: 3×10 per front corner |
| Racket low, contact late (NS1/4) | "Meet it at tape height, early" | Feeder hand-throws to the net: 3×12 per side |
| Big swing, net shot pops high (NS5/6) | "Touch and guide, no backswing" | Net shots with the racket starting at contact position: 3×15 |
| Lift falls short (NL5) | "Lift up and through, finish high" | Lifts to the rear-tramline target: 3×10 |
| Bends at the waist (NS3) | "Chest up, legs do the reaching" | Mirror lunges: 3×8 |
| Doesn't recover (NS7) | "Push back with the front foot" | Lunge, push back, split: 3×8 |

### 1.10 Backhand overhead clear (bd.clear.bh)
**Phases:**
- Prep: pivot and turn your back to the net; the last step is the racket foot into the rear backhand corner.
- Backswing: elbow high and leading, pointing at the shuttle.
- Contact: high, arm extending, forearm supination and thumb push.
- Follow-through: short and braked.
- Recovery: turn back and return to base.

| ID | Checkpoint | Tag | Metric | Target ≈ | Tol |
|---|---|---|---|---|---|
| BC1 | Back to the net at contact | M~ (B: face toward camera) | nose and both eyes at confidence ≥ 0.5, plus turn ≥ 60° | pass | — |
| BC2 | Last step with the racket leg toward the corner | M~ (B) | racket-side ankle further toward the corner at contact | pass | — |
| BC3 | Elbow up and leading | M | elbowRel at bsEnd | ≥ 0 | 0.2 |
| BC4 | High contact | M~ | reach | ≥ 0.7 | 0.25 |
| BC5 | Arm extends through contact | M~ | elbowAng | ≥ 140° | 20° |
| BC6 | Short, braked follow-through | M~ | ftLen; wrist stays above shoulder | ≤ 1.2 T | 0.4 |
| BC7 | Turns back and recovers | M~ | toward base within 0.8 s | pass | — |
| BC8 | Thumb grip, supination | V/N | — | — | — |

| Fault | Fix | Drill |
|---|---|---|
| Faces the net (BC1) | "Show your back to the net" | Turn–step–elbow shadow: 3×10 |
| Low elbow (BC3) | "Elbow points at the shuttle" | Backhand frisbee-style shuttle throws: 3×15 |
| Non-racket foot steps last (BC2) | "Racket foot steps to the corner" | Footwork-only shadow: 3×10 |
| Late or low contact (BC4) | "Hit above and slightly ahead" | Feeder lobs to the backhand corner: 3×8 |
| Spins around after the shot (BC6) | "Tap and stop" | Short-brake swings: 3×10 |

Coaching note for beginners: where the shuttle allows it, prefer the round-the-head forehand.

### 1.11 Low backhand serve (bd.serve.low)
**Rules context:**
- BWF Law 9.1.6 (international play): the whole shuttle must be below 1.15 m at contact.
- Many clubs and domestic events still use the waist rule.
- Feet must be stationary and touching the court until the serve is delivered.
- The racket must hit the base of the shuttle first.
- The serve must move forward continuously, with no hesitation.
- The app shows only "likely OK / check"; it never gives an official ruling.

**Phases:** setup → short backswing → contact in front → short push → racket up.

| ID | Checkpoint | Tag | Metric | Target ≈ | Tol |
|---|---|---|---|---|---|
| LS1 | Feet stationary until contact (rule) | M | ankle displacement setup→contact | ≤ 0.08 T | flag |
| LS2 | Compact, balanced stance | M (S) | stagger 0.3–1.2 T; kneeFlex 10–35°; trunkLean 5–25° | — | 10° |
| LS3 | Contact in front | M~ (S) | wristFwd | ≥ 0.3 T | 0.2 |
| LS4 | Contact height (legality **proxy only**) | M~ | wristH at contact | ≤ 0.7 | flag "check" |
| LS5 | Short backswing, no hesitation | M~ | bsLen ≤ 0.3 T; no vWrist stop-and-restart after the swing starts | pass | flag |
| LS6 | Short push | M~ | ftLen | ≤ 0.5 T | 0.3 |
| LS7 | Racket up after serving | M | wristH ≥ 0.9 within 0.6 s | pass | — |
| LS8 | Shuttle skims the tape and lands near the short service line | N/V | — | — | — |

| Fault | Fix | Drill |
|---|---|---|
| Wrist flick or big swing makes the serve rise (LS5/6) | "Push with the thumb, short and smooth" | Serve under a string 10–20 cm above the tape: 5×10 |
| Hesitation or feint after starting (LS5) | "One smooth motion" | Count "1-2" rhythm serves: 3×10 |
| Racket stays low after the serve (LS7) | "Serve, then racket up at the net" | Serve, partner pushes the return, you replay it: 3×10 |
| Feet shuffle during the serve (LS1) | "Plant both feet" | Mirror serves: 3×10 |

### 1.12 High forehand serve (bd.serve.high)
| ID | Checkpoint | Tag | Metric | Target ≈ | Tol |
|---|---|---|---|---|---|
| HS1 | Side-on setup, non-racket foot forward | M~ (S ankle order; B turn ≥ 45°) | — | pass | — |
| HS2 | Feet stationary until contact | M | as LS1 | ≤ 0.08 T | flag |
| HS3 | Weight from rear to front | M~ (S) | wShift at bsEnd → at contact + 0.2 s | ≤ 0.4 → ≥ 0.6 | 0.15 |
| HS4 | Full low-to-high swing | M~ | bsLen ≥ 1.0 T; vyWrist > 0 at contact | pass | 0.3 |
| HS5 | Contact below the waist (proxy) | M~ | wristH at contact | ≤ 0.3 | flag |
| HS6 | High finish over the non-racket shoulder | M (B) | wristH ≥ 1.1 at ftStop; ftCross | pass | 0.3 |
| HS7 | Back to base and ready | M~ | within 1.2 s | pass | — |

| Fault | Fix | Drill |
|---|---|---|
| Misses or mistimes the shuttle drop (V/N) | "Drop, then swing" | Drop the shuttle and hit at knee height: 3×10 |
| Arm-only swing (HS3) | "Rock back, then forward" | Weight-shift shadow swings: 3×10 |
| Low finish, serve too short (HS6) | "Finish high, freeze" | Finish-and-freeze serves: 3×10 |
| Serve not deep (N) | — | Targets on the back tramlines: 3×10 |

---

## 2. PICKLEBALL

### 2.1 Skill taxonomy
| ID | Skill | VI (app copy) | Level | View | Assessability |
|---|---|---|---|---|---|
| pb.grip | Continental grip | Cầm vợt kiểu continental (bắt tay) | L1 | Photo | V/N |
| pb.ready | Ready position (baseline / kitchen) | Tư thế sẵn sàng | L1 | B / S | M |
| pb.move | Split step, shuffle, transition to the kitchen | Split step, bước trượt ngang, lên bếp | L1–L2 | S / B | M~ |
| pb.serve | Volley serve and drop serve (+ legality checks) | Giao bóng (vô-lê / thả bóng) | L1 | S | M + V |
| pb.return | Return of serve | Trả giao bóng | L1 | S | M + V |
| pb.dink | Dink (forehand / backhand) | Dink | L1–L2 | S | M~ + V |
| pb.drop3 | Third-shot drop | Drop cú thứ ba (third shot drop) | L2 | S | M~ + V |
| pb.drive | Drive (incl. third-shot drive) | Drive / cú bạt | L2 | S / B | M + V |
| pb.volley | Volley, punch volley, block | Vô-lê, vô-lê đẩy, chặn bóng | L1–L2 | S | M~ + V |
| pb.kitchen | Kitchen-line positioning, partner spacing | Vị trí ở vạch bếp | L1–L2 | B | V (+M) |
| *(v2)* | Reset, lob, overhead, Erne/ATP | Reset, lốp bóng, đập bóng | L3 | — | V |

### 2.2 Serve legality checks (shown as a "Rule check" badge, not scored)
Assumes the USA Pickleball 2026 rules. Secondary sources say 2026 added "clearly" to all three volley-serve requirements, so borderline serves are faults. Confirm against the official rulebook, and confirm which rulebook Vietnamese tournaments follow.

| ID | Rule | Tag | Proxy / metric | Output |
|---|---|---|---|---|
| RS1 | Contact below the waist (navel) | M~ (proxy) | wristH at contact. Navel ≈ +0.2–0.3 T above the hip joints | ≤ 0.1 "likely OK" / 0.1–0.3 "borderline" / > 0.3 "likely fault" |
| RS2 | Arm moving in an upward arc at contact | M (S, 60 fps); M~ at 30 fps | vyWrist over frames −2…+1 | > +0.3 T/s OK; ≤ 0 "likely fault" |
| RS3 | Paddle head clearly below the wrist at contact | **V** (contact key frame; often blurred, so `not_assessable`) | — | — |
| RS4 | One foot behind the baseline, neither touching the line or court at contact | V (if the line is visible) / N | — | — |
| RS5 | Drop serve: ball released, not tossed or thrown; no spin added at release (2026, per secondary sources) | V/N | — | — |
| RS6 | Drop serve: ball bounces before it is hit | M~ (audio: bounce transient, then hit transient) | — | — |

### 2.3 Ready position (pb.ready)
| ID | Checkpoint | Tag | Metric | Target ≈ | Tol |
|---|---|---|---|---|---|
| PR1 | Feet shoulder-width or wider | M (B) | stanceW | 1.0–1.6 | 0.3 |
| PR2 | Knees bent | M (S) | kneeFlex | 15–45° | 10° |
| PR3 | Weight forward | M (S) | trunkLean forward | 10–30° | 10° |
| PR4 | **Paddle up and in front** | M / M~ | wristH 0.5–1.2; wristFwd ≥ 0.3 T (S); \|wristLat\| ≤ 0.5 T (B) | — | 0.3 |
| PR5 | Square to the net at the kitchen line | M~ (B) | turn | ≤ 25° | 15° |
| PR6 | Paddle tip up, face neutral | V | — | — | — |

| Fault | Fix | Drill |
|---|---|---|
| Paddle hanging at the knees (most common) | "Paddle up, chest height, in front" | Paddle-up reaction volleys with a partner: 3×15 |
| Standing tall (PR2/3) | "Athletic stance, knees soft" | 3×30 s holds plus 10 shuffle starts |
| Feet staggered or closed at the kitchen (PR5) | "Both toes to the net" | Mirror check at the kitchen line: 3×10 shuffles |

### 2.4 Movement and transition (pb.move)
| ID | Checkpoint | Tag | Metric | Target ≈ |
|---|---|---|---|---|
| PM1 | Split step as the opponent hits | M~ (audio-aided) | hop landing within −0.05…+0.25 s of the opponent's contact onset | ≥ 70% |
| PM2 | Shuffles without crossing feet at the kitchen | M~ (B) | crossStep = false for moves < 1.5 T | pass |
| PM3 | Moves forward after the return / 3rd shot | M~ (S; B via T shrinkage) | forward root displacement | see RT6, TD7 |
| PM4 | Settled, not running through contact | M~ | vRoot at own contact | ≤ 0.6 T/s |
| PM5 | **No backpedalling for lobs** (fall risk) | M~ (S) | backward vRoot > 1.0 T/s with trunkLean back > 10° | **safety warning** |
| PM6 | Moves with the partner as a unit | V (both players in frame) | — | — |

| Fault | Fix | Drill |
|---|---|---|
| Hits on the run in the transition zone (PM4) | "Split, then hit" | Drop-and-split ladder from 3 depths: 3×6 each |
| Crossover shuffles at the kitchen (PM2) | "Slide, don't cross" | Side-to-side shuffle dinks: 3×1 min |
| Backpedals for lobs (PM5) | "Turn sideways and crossover-step back" | Turn-and-run shadow: 3×6. **Show the safety cue** |

### 2.5 Serve technique (pb.serve)
**Phases:** setup with weight back → pendulum backswing → contact in front, low-to-high → follow-through toward the target → stay back (two-bounce rule).

| ID | Checkpoint | Tag | Metric | Target ≈ | Tol |
|---|---|---|---|---|---|
| SV1 | Weight back at setup | M~ (S) | wShift at bsEnd | ≤ 0.45 | 0.15 |
| SV2 | Pendulum from the shoulder, quiet elbow | M~ | ΔelbowAng from bsEnd to contact | ≤ 35° | 15° |
| SV3 | Contact in front | M~ (S) | wristFwd | ≥ 0.2 T | 0.2 |
| SV4 | Weight transfer forward | M~ (S) | wShift at contact + 0.2 s | ≥ 0.6 | 0.15 |
| SV5 | Follows through to the target | M | wristH at ftStop | ≥ 0.8 | 0.3 |
| SV6 | Stays back after serving | M~ (S) | forward displacement within 1.5 s | ≤ 1.0 T | 0.5 |
| SV7 | Depth and placement | N/V | — | — | — |

| Fault | Fix | Drill |
|---|---|---|
| Sidearm or high contact (RS1/2) | "Low to high, below the belly button" | Slow pendulum swings, finish at eye line: 3×10 |
| Pushes the serve short (SV5) | "Swing through to the target" | Deep target towel 1 m inside the baseline: 5×10 |
| Runs in after serving (SV6) | "Serve, stay back, split" | Serve, then split on the baseline: 3×10 |

### 2.6 Return of serve (pb.return)
| ID | Checkpoint | Tag | Metric | Target ≈ | Tol |
|---|---|---|---|---|---|
| RT1 | Starts deep | V/N | — | — | — |
| RT2 | Splits on the server's contact | M~ | = PM1 | pass | — |
| RT3 | Unit turn, compact backswing | M~ | turn ≥ 30° (B); bsLen 0.5–1.5 T | — | 0.3 |
| RT4 | Contact in front, balanced | M~ (S) | wristFwd ≥ 0.2 T; vRoot ≤ 0.6 T/s | — | 0.2 |
| RT5 | Low-to-high, full finish | M | vyWrist > 0 at contact; wristH ≥ 0.9 at ftStop | — | 0.3 |
| RT6 | **Moves to the kitchen after the return** | M~ (S) | forward displacement within 2.5 s | ≥ 3 T | 1 T |
| RT7 | Return depth | N/V | — | — | — |

| Fault | Fix | Drill |
|---|---|---|
| **Stays at the baseline after returning** (RT6, the #1 newbie fault) | "Return deep, then run to the kitchen" | Return, race to the kitchen, split: 3×10 |
| Hits hard and low into the net (RT5) | "High, deep, slow is fine" | Half-speed high-arc returns: 3×10 |
| Late contact (RT4) | "Meet it in front" | Feeder serves, focus on early contact: 3×10 |

### 2.7 Dink (pb.dink)
**Phases:** low ready → tiny backswing → contact in front, lifting from the shoulder → short low-to-high follow-through → paddle back to ready.

| ID | Checkpoint | Tag | Metric | Target ≈ | Tol |
|---|---|---|---|---|---|
| DK1 | Low base | M (S) | kneeFlex at contact | 20–50° | 10° |
| DK2 | Bends at the knees, not the waist | M (S) | trunkLean ≤ 35°; fault if > 40° with kneeFlex < 20° | — | 10° |
| DK3 | Compact backswing | M~ | bsLen | ≤ 0.4 T | 0.3 |
| DK4 | Shoulder-driven, quiet arm | M~ / V | ΔelbowAng ≤ 30°; wrist flick = V | — | 15° |
| DK5 | Contact in front | M~ (S) | wristFwd | 0.2–0.7 T | 0.2 |
| DK6 | Gentle low-to-high lift | M~ | wrist rise from contact to ftStop; ftLen | 0.1–0.5 T; ≤ 0.8 T | 0.2 |
| DK7 | Still body and head | M~ | vRoot ≤ 0.5 T/s; headStill ≤ 0.15 T | — | — |
| DK8 | Paddle back to ready | M | PR4 within 0.6 s | pass | — |
| DK9 | Reaching instead of moving the feet | M~ (B) | \|wristLat\| > 1.2 T while vRoot ≈ 0 | fault flag | — |
| DK10 | Paddle face open, ball lands in the kitchen, feet behind the line | V/N | — | — | — |

| Fault | Fix | Drill |
|---|---|---|
| Big backswing, ball pops up (DK3) | "Start the paddle at the contact point" | No-backswing dinks: 3×20 |
| Bends at the waist (DK2) | "Sit down, don't bow" | Cross-court dinks with a knee-bend cue: 3×1 min |
| Wristy flick (DK4) | "Lift with the shoulder, wrist firm" | Pendulum dinks with the paddle taped to the forearm in mind: 3×20 |
| Reaching (DK9) | "Move your feet first" | Shuffle-dink side to side: 3×1 min |
| Paddle drops after each dink (DK8) | "Back to paddle-up" | Dink rally, aiming for 30 in a row: 3 sets |

### 2.8 Third-shot drop (pb.drop3)
| ID | Checkpoint | Tag | Metric | Target ≈ | Tol |
|---|---|---|---|---|---|
| TD1 | Settled at contact | M~ | vRoot | ≤ 0.6 T/s | 0.3 |
| TD2 | Knees bent | M (S) | kneeFlex | 20–45° | 10° |
| TD3 | Contact in front | M~ (S) | wristFwd | ≥ 0.2 T | 0.2 |
| TD4 | Lift from the shoulder | M | wrist rise from contact to ftStop 0.4–1.2 T; wristH at ftStop 0.7–1.3 | — | 0.3 |
| TD5 | Moderate backswing | M~ | bsLen | 0.4–1.0 T | 0.3 |
| TD6 | Quiet wrist, face slightly open | V | — | — | — |
| TD7 | "Drop and go": moves forward and splits before the opponent hits | M~ | forward ≥ 1 T, then a `hop` | pass | — |
| TD8 | Arc peaks on own side, lands in the kitchen | N/V | — | — | — |

| Fault | Fix | Drill |
|---|---|---|
| Hits on the run (TD1) | "Stop, hit, then go" | Drop-and-split: 3×8 |
| Too much swing or wrist, ball floats high (TD5/6) | "Lift, don't hit" | Drop ladder, closest distance first: 3×10 at each of 3 distances |
| Standing tall (TD2) | "Get low to the ball" | Knee-touch drops: 3×10 |
| Stays at the baseline after a good drop (TD7) | "Good drop means move up" | Drop, step forward 2–3 steps, split: 3×8 |

### 2.9 Drive (pb.drive)
| ID | Checkpoint | Tag | Metric | Target ≈ |
|---|---|---|---|---|
| DV1 | Unit turn | M~ (B) | turn at bsEnd | ≥ 45° |
| DV2 | Medium backswing | M~ | bsLen | 0.8–1.8 T |
| DV3 | Contact in front | M~ (S) | wristFwd | 0.2–0.8 T |
| DV4 | Weight forward | M~ (S) | wShift at contact + 0.2 s | ≥ 0.6 |
| DV5 | Low-to-high (topspin) | M~ | wrist rise after contact | 0.3–1.0 T |
| DV6 | Finish across the body | M (B) | ftCross; wristH ≥ 0.9 | pass |
| DV7 | Back to ready | M | PR4 within 0.8 s | pass |

| Fault | Fix | Drill |
|---|---|---|
| Arm-only (DV1) | "Turn the shoulders as one unit" | Unit-turn shadow swings: 3×10 |
| Late, flat contact (DV3) | "Meet it in front" | Baseline drives into a target zone: 3×10 |
| Hits down into the net (DV5) | "Brush up the back of the ball" | Low-to-high shadow swings, then 3×10 live |
| Over-swings, recovers slowly (DV7) | "Hit, then paddle up" | Drive, then a reaction volley: 3×8 |

### 2.10 Volley / punch volley (pb.volley)
| ID | Checkpoint | Tag | Metric | Target ≈ |
|---|---|---|---|---|
| VO1 | Paddle up in front before the opponent hits | M | PR4 | pass |
| VO2 | Little or no backswing | M~ | bsLen | ≤ 0.3 T |
| VO3 | Contact well in front | M~ (S) | wristFwd | ≥ 0.4 T |
| VO4 | Short punch | M~ | ftLen | ≤ 0.6 T |
| VO5 | Stable base | M | kneeFlex 15–45°; vRoot ≤ 0.6 T/s | — |
| VO6 | Doesn't enter the kitchen on the volley or its momentum (rule) | V/N (M~ proxy: forward root ≤ 0.5 T within 0.5 s, only when the line is visible) | — | flag |
| VO7 | Backhand elbow not "chicken-winged"; firm wrist; face angle | V | — | — |

| Fault | Fix | Drill |
|---|---|---|
| Swings at volleys (VO2) | "Punch, don't swing" | Volley-to-volley at the kitchen line: 3×1 min |
| Paddle down, late (VO1) | "Paddle up before they hit" | Paddle-up reaction drill: 3×15 |
| Steps into the kitchen after volleying (VO6) | "Freeze your feet after the volley" | Volley, freeze 1 s, check feet: 3×10 |
| Leans back (VO5) | "Weight forward" | Wall punch volleys: 3×30 |

### 2.11 Kitchen-line positioning (pb.kitchen)
| ID | Checkpoint | Tag | Notes |
|---|---|---|---|
| KP1 | Feet just behind the kitchen line (not 1–2 m back) | V | Needs the line visible (B view) |
| KP2 | Low ready with paddle up | M | PR1–PR4 |
| KP3 | Partner spacing; move together (shift with the ball) | V | Both players in frame, B view |
| KP4 | Returns to the line after each shot | V / M~ | baseErr against the kitchen-line position marked by the LLM |
| KP5 | Out of the kitchen when volleying | V/N | Rule |

| Fault | Fix | Drill |
|---|---|---|
| Hangs back in the transition zone | "Toes near the line" | Dink rally from the line, partner calls "line!": 3×1 min |
| Partners split apart | "Move like there's a rope between you" | Shadow team shuffle following the coach's ball: 3×10 |

### 2.12 Grip (pb.grip)
- Continental or handshake grip only. Assessed V (photo) or N, as in §1.2.
- Common fault: Western or "frying-pan" grip, which weakens the backhand. Fix with a "hammer the nail" grip check: 20×.
- Common fault: death grip, which makes dinks pop up. Fix with "grip pressure 3/10" dinks: 3×20.

---

## 3. Scoring rubric

### 3.1 Sub-scores (0–100)
| Sub-score | VI label | Covers |
|---|---|---|
| Stance & Balance | Tư thế & Thăng bằng | ready posture, base width, knee bend, trunk, root inside base |
| Footwork | Di chuyển (Bộ pháp) | split step, lunge or shuffle, approach, steps, transition |
| Swing Mechanics | Kỹ thuật vung vợt | prep, turn, elbow, backswing length, weight transfer, sequencing |
| Contact Point | Điểm chạm cầu / bóng | height, in-front, arm extension, stillness at contact |
| Follow-through | Động tác vung theo (kết thúc) | path, finish position, length |
| Recovery | Hồi vị / Về tư thế sẵn sàng | return to base or kitchen, racket/paddle up, stay back after serving |

Rule-check and injury flags are separate badges and are **not** part of the score.

### 3.2 Weight matrix per skill (each row sums to 100)
| Skill | Stance | Footwork | Swing | Contact | Follow | Recovery |
|---|---|---|---|---|---|---|
| bd.ready / pb.ready | 80 | 20 | – | – | – | – |
| bd.split | 30 | 70 | – | – | – | – |
| bd.footwork | 20 | 60 | – | – | – | 20 |
| bd.clear.fh | 10 | 15 | 30 | 20 | 10 | 15 |
| bd.smash | 10 | 10 | 30 | 25 | 10 | 15 |
| bd.drop | 10 | 15 | 25 | 25 | 10 | 15 |
| bd.net (shot / lift) | 15 | 30 / 25 | 10 / 20 | 30 / 20 | 5 / 10 | 10 |
| bd.clear.bh | 10 | 20 | 25 | 25 | 10 | 10 |
| bd.serve.low | 30 | – | 25 | 25 | 15 | 5 |
| bd.serve.high | 20 | – | 30 | 20 | 20 | 10 |
| pb.serve | 15 | – | 30 | 25 | 20 | 10 |
| pb.return | 10 | 20 | 25 | 20 | 10 | 15 |
| pb.dink | 25 | 10 | 20 | 25 | 10 | 10 |
| pb.drop3 | 20 | 10 | 25 | 20 | 15 | 10 |
| pb.drive | 15 | 10 | 30 | 20 | 15 | 10 |
| pb.volley | 20 | 10 | 20 | 30 | 10 | 10 |
| pb.kitchen / pb.move | 30 | 50 | – | – | – | 20 |

Within each sub-score, every checkpoint has weight 1, and key checkpoints have weight 2. The key checkpoints are C1, C3, C5, FW2, NS2, RT6, DK3, DK2, PR4 and VO1.

### 3.3 Formulas (deterministic, run server-side)
**Per-metric score:**
- `s = 1` if `lo ≤ v ≤ hi`.
- Otherwise `s = max(0, 1 − d/tol)`, where `d` is the distance to the nearer bound.
- Boolean metrics score 1 or 0.

**Per-checkpoint score:**
- The **median** across valid reps. Ask for 5 or more reps; the minimum is 3.
- With only 1–2 reps, use the mean and halve the confidence.

**Confidence:**
- `c = min(1, meanJointConf/0.6) × viewFactor`.
- viewFactor = 1.0 for the preferred view, 0.6 for an acceptable view, 0 for an unsupported view (the checkpoint is then excluded).
- At 30 fps, velocity and timing metrics are additionally multiplied by 0.5.

**V items (LLM):**
- The LLM returns a level of 0–4 plus a confidence of low, medium or high, mapped to c = 0.4 / 0.7 / 1.0.
- Score: s = level/4.
- `not_assessable` items are excluded.
- **V items are capped at ≤ 35% of any sub-score's effective weight.**

**Sub-score:**
- `Sub = 100·Σ(w·c·s)/Σ(w·c)`.
- `coverage = Σ(w·c)/Σw`.
- Show the sub-score only if coverage ≥ 0.4; otherwise show "Not enough data / Chưa đủ dữ liệu".

**Overall:**
- The weighted mean of the displayed sub-scores, with weights renormalised.
- If total coverage < 0.5, show "Partial analysis" with no overall number.
- Cap the overall at 85 when coverage < 0.8.

**Fault priority (deterministic):**
- `impact = W_sub × w_cp × (1 − s) × c`.
- The top 3 faults by impact become the "Weaknesses".
- The top 3 checkpoints with s ≥ 0.85 and high c become the "Strengths".
- Drills come **only from the drill library, by ID**.

### 3.4 Levels
| Overall | EN | VI |
|---|---|---|
| 0–39 | Beginner | Mới bắt đầu |
| 40–59 | Improving | Đang tiến bộ |
| 60–79 | Intermediate | Trung cấp |
| 80–100 | Advanced | Nâng cao |

- **Hysteresis:** the label moves up only when the score is at least 3 points over the threshold, or when the mean of the last 3 analyses of the same skill and view crosses it.
- **Disclaimer:** the level describes *measurable technique checkpoints*. It is not a playing rating such as DUPR or a club level.

### 3.5 LLM rubric contract (consistency)
1. **Code owns every number.** The LLM never produces sub-scores or the overall score. It receives the metric table (value, target, s, c) as facts and must not contradict an M item.
2. **Constrained output.** The LLM answers through a tool call with a JSON schema. Checkpoint IDs are enums. Each V item gets a level from 0–4 or `not_assessable`, plus `evidence_frame` and a confidence. Fault and drill IDs must come from the library. Free text is limited to coaching narrative in VI or EN.
3. **Anchored descriptors.** Every V checkpoint ships 5 anchor texts (0–4) in the prompt; see G1 for an example. The prompt tells the model to choose `not_assessable` rather than guess.
4. **Key frames.** For the best and the worst rep, send 5 phase frames each (bsEnd, contact −2, contact, ftStop, recovery), cropped to the player's box plus 20%, about 768 px on the long side, plus one overview frame. The pose overlay is optional and should go in a separate image from the raw crop.
5. **Pin everything.** Store `rubric_version`, `prompt_version`, the model ID (for example `claude-sonnet-5-5`) and the sampling settings with each analysis. Use the lowest supported temperature for the model; check the current API docs. Re-baseline whenever any of these change.
6. **Idempotency.** Cache results by `hash(pose JSON + frame hashes + versions + model)`. The same input returns the same result.
7. **Calibration and CI.**
   - Golden pose fixtures make the metric engine deterministic and Deno-tested.
   - An eval set of about 30 coach-labelled clips per skill tracks: mean absolute error vs. the coach ≤ 10 points; test–retest on the same clip ≤ 3 points; different clips from the same session ≤ 8 points; V-item agreement with the coach ≥ 70%, within ±1 level.

---

## 4. Camera setup

### 4.1 User-facing instructions (EN / VI)
| # | EN | VI |
|---|---|---|
| 1 | Use a tripod or prop the phone on something stable. Film in **landscape**. | Dùng chân máy hoặc dựng điện thoại thật chắc. Quay **ngang**. |
| 2 | Use the **1×** lens, not 0.5×. | Dùng ống kính **1×**, không dùng 0.5×. |
| 3 | **Side view:** place the phone on the sideline on your **racket-hand side**, level with where you hit, 4–6 m away (badminton) or 3–5 m (pickleball). | **Góc ngang:** đặt điện thoại ở biên dọc, **phía tay cầm vợt**, ngang chỗ bạn đánh, cách 4–6 m (cầu lông) / 3–5 m (pickleball). |
| 4 | Phone height: waist to chest (about 1–1.3 m). | Độ cao: ngang thắt lưng đến ngực (khoảng 1–1,3 m). |
| 5 | Keep your whole body in frame, with space above the racket at full reach and below your feet. You should fill ½ to ⅔ of the frame height. | Toàn thân trong khung hình, chừa khoảng trống trên đầu vợt khi vươn cao nhất và dưới bàn chân; người chiếm khoảng ½–⅔ chiều cao khung hình. |
| 6 | Record at **60 fps** (Settings › Camera › Record Video › 1080p HD at 60 fps). | Quay **60 fps** (Cài đặt › Camera › Quay video › 1080p HD ở 60 fps). |
| 7 | Use bright, even light. Don't film toward windows or the sun. Wear clothes that contrast with the background, and shorts or fitted pants so your knees are visible. | Ánh sáng đủ, đều; không quay ngược sáng (cửa sổ, mặt trời). Mặc đồ khác màu phông nền; quần short hoặc quần ôm để thấy rõ đầu gối. |
| 8 | Only you fully in frame if possible. Otherwise, tap yourself in the app. | Chỉ mình bạn trong khung hình nếu được; nếu không, hãy chạm chọn bạn trong ứng dụng. |
| 9 | Record **5–10 reps of ONE stroke** (20–60 s). | Quay **5–10 lần của MỘT kỹ thuật** (20–60 giây). |
| 10 | **Footwork and positioning:** place the phone behind the baseline, centred, as high as possible (1.5–2.5 m), with the whole half-court visible. | **Di chuyển & vị trí:** đặt điện thoại sau vạch cuối sân, chính giữa, càng cao càng tốt (1,5–2,5 m), thấy cả nửa sân. |

Optional: iPhone slow-motion at 120 or 240 fps for single-stroke clips gives better contact and timing data, at the cost of bigger files and longer processing.

### 4.2 Recommended view per skill
| Primary view: S | Primary view: B | Either view |
|---|---|---|
| bd.clear.fh*, bd.smash*, bd.drop, bd.net, serves (both sports), pb.return, pb.dink, pb.drop3, pb.volley | bd.footwork, bd.split, bd.clear.bh, pb.kitchen, pb.move (shuffle) | ready stance; pb.drive |

\* A secondary B clip unlocks C1, C8, C9 and SM6.

### 4.3 Which metrics depend on which view
| Metric | S | B / front | D (45°) |
|---|---|---|---|
| kneeFlex, trunkLean, shinAngle | ✔ | ~ (lean only lateral) | ~ |
| stanceW, R5 balance, crossStep | ✖ | ✔ | ~ |
| turn (shoulder/hip rotation) | ~ | ✔ | ✖ |
| wristH, reach, elbowRel (vertical) | ✔ | ✔ | ✔ |
| wristFwd (contact in front), wShift, stagger, lead leg | ✔ | ✖ | ~ |
| wristLat, ftCross | ✖ | ✔ | ~ |
| elbowAng | ~ | ~ | ~ (always foreshortened) |
| vyWrist (serve arc), bsLen, ftLen | ✔ | ~ (depth lost) | ~ |
| split hop, moveOnset | ✔ | ✔ | ✔ |
| baseErr / forward movement to the net | ✔ | ~ (from T shrinkage) | ~ |
| Knee valgus (FW4) | ✖ | ✔ (front best) | ✖ |

---

## 5. Vietnamese terminology
These terms come from general knowledge of Vietnamese player usage. **(?)** marks terms that need verification by a native coach. Web sources only partly confirmed them.

### 5.1 Badminton strokes
| EN | Preferred VI in the app | Alternatives / slang |
|---|---|---|
| Serve | giao cầu | phát cầu |
| Low / short serve | giao cầu thấp (ngắn) | giao cầu sát lưới |
| Backhand / forehand serve | giao cầu trái tay / thuận tay | — |
| High (long) serve | giao cầu cao sâu | giao cầu bổng |
| Flick serve | giao cầu hất / vẩy (?) | — |
| Clear | phông cầu | đánh cầu cao sâu (formal) |
| Smash / jump smash | đập cầu / nhảy đập | bật nhảy đập cầu |
| Rear-court drop / slice drop | bỏ nhỏ (từ cuối sân) / chém cầu | cắt cầu |
| Net shot / spinning net shot | bỏ nhỏ (trên lưới) / bỏ nhỏ xoáy | gài cầu (?) |
| Lift | vẩy cầu | hất cầu, ve cầu (regional?) |
| Net kill | chụp lưới (?) | chụp cầu |
| Push / drive / block | đẩy cầu / tạt cầu / chặn cầu | — |
| Smash defence | đỡ đập | phòng thủ |
| Round-the-head | đánh vòng đầu (?) | — |

### 5.2 Badminton technique and court
| EN | VI |
|---|---|
| Grip (forehand / backhand / panhandle) | cầm vợt (thuận tay kiểu bắt tay / trái tay / kiểu cán chảo (?)) |
| Ready stance (defensive / attacking) | tư thế chuẩn bị (thế thủ / thế công) |
| Footwork | bộ pháp, di chuyển, bước chân |
| Split step / chassé / crossover / lunge / scissor kick | bật nhún (split step) / bước trượt, bước đệm (?) / bước chéo / bước lunge, bước dài lên lưới (?) / đổi chân trên không (?) |
| 6-corner footwork | di chuyển 6 góc |
| Base / centre | vị trí trung tâm, giữa sân |
| Front / mid / rear court, corner | trên lưới / giữa sân / cuối sân, góc sân |
| Contact point / highest point | điểm chạm cầu / điểm cao nhất |
| Swing / backswing / follow-through / recovery | vung vợt / đưa vợt ra sau (lấy đà) / vung theo / về vị trí (hồi vị) |
| Pronation / supination | xoay cẳng tay vào trong / ra ngoài |
| Wrist snap | lực cổ tay, bẻ cổ tay (beginner usage; don't over-emphasise it) |
| Weight transfer / balance / lower your centre | chuyển trọng tâm / thăng bằng / hạ trọng tâm |
| Racket head / face / handle / strings | đầu vợt / mặt vợt / cán vợt / dây (cước) |

### 5.3 Body parts (both sports)
| EN | VI |
|---|---|
| shoulder, elbow, wrist | vai, khuỷu tay, cổ tay |
| forearm, arm | cẳng tay, cánh tay |
| hip, torso / upper body, back | hông, thân người / thân trên, lưng |
| knee, ankle, foot, heel, toes / ball of foot | đầu gối, mắt cá chân, bàn chân, gót chân, mũi chân / mũi bàn chân |
| racket (paddle) hand / non-racket hand | tay cầm vợt (tay thuận) / tay không cầm vợt |
| bend the knees | khuỵu gối, chùng gối |
| on your toes | nhón gót, dồn trọng tâm lên mũi chân |

### 5.4 Pickleball
Vietnamese players code-switch heavily, so **keep English for dink, drop, drive, reset, Erne, ATP and stacking**.

| EN | VI |
|---|---|
| Paddle / ball | vợt / bóng |
| Kitchen (NVZ) / kitchen line | bếp (vùng bếp), formally vùng cấm vô-lê / vạch bếp |
| Baseline / sideline / centreline | vạch cuối sân / biên dọc / vạch giữa |
| Serve / volley serve / drop serve | giao bóng (phát bóng) / giao bóng vô-lê / giao bóng thả (drop serve) |
| Return of serve | trả giao bóng (return) |
| Two-bounce rule | luật hai lần nảy |
| Third-shot drop | drop cú thứ ba (third shot drop) |
| Dink | dink (gloss: "đánh nhẹ vào bếp") |
| Drive | drive, cú bạt |
| Volley / punch volley / block | vô-lê / vô-lê đẩy (punch) / chặn bóng |
| Lob / overhead | lốp bóng / đập bóng (smash) |
| Ready position / split step | tư thế sẵn sàng / split step (bật nhún) |
| Transition zone | vùng chuyển tiếp (giữa sân) |
| Fault / foot fault / kitchen fault | lỗi / lỗi chân / lỗi bếp |
| Topspin / slice | xoáy lên (topspin) / cắt bóng |
| Two-handed backhand | trái tay hai tay |
| Doubles / singles / partner | đánh đôi / đánh đơn / đồng đội |

### 5.5 Copy style
- Use second person "bạn" in a warm coach tone: "Hãy…", "Thử…", "Mẹo:".
- Keep sentences short with one cue each (for example "Giơ vợt lên trước ngực.").
- Avoid literal calques such as "theo-xuyên" for follow-through.
- Each fault card follows the pattern: **Vấn đề → Cách sửa → Bài tập (3×10)**.

---

## 6. Data model and open risks
- **Definitions as data:** `CheckpointDef`, `FaultDef` and `DrillDef` live in versioned JSON with fields for both languages.
  - `CheckpointDef`: `id, sport, skill, phase, subscore, weight, assess(M|M~|V|N), metric{fn, params, target[lo,hi], tol, unit, relativeTo?}, views{S,B,D:0|0.6|1}, ruleFlag?, injuryFlag?, vAnchors[5]?, text{en,vi}, faults[]`
  - `FaultDef`: `id, detect{checkpoint, when}, cue{en,vi}, drillId`
  - `DrillDef`: `id, sets, reps|seconds, text{en,vi}`
- **Risks:**
  1. Every ≈ target is a heuristic and needs coach calibration.
  2. Vision loses or smears the wrist at smash speed. 60 fps is strongly advised; flag interpolated contact frames.
  3. Facing-sign and turn estimates are ambiguous. Fall back to the LLM on a key frame.
  4. Rules are versioned. The BWF Laws in force are the 2025 edition until a new version takes effect on 4 Jan 2027. The USA Pickleball 2026 "clearly" wording is confirmed only by secondary sources. Re-review both rule sets on those dates.
  5. The Vietnamese terms marked (?) need native review.
  6. Injury flags must be phrased as advice, not diagnosis ("nếu đau, hãy hỏi HLV/chuyên gia").

**Sources:**
- [2026 USA Pickleball rule changes – PlayPickleball](https://www.playpickleball.com/2026-usa-pickleball-rule-changes-whats-changing-this-year/)
- [USA Pickleball rule changes 2026 – The Kitchen](https://thekitchenpickle.com/blogs/news/usa-pickleball-rule-changes-2026)
- [Pickleball serve rules 2026 – MyPickleballConnect](https://www.mypickleballconnect.com/guides/pickleball-serve-rules-2026/)
- [Drop serve vs volley serve 2026 – MyPickleballConnect](https://www.mypickleballconnect.com/guides/drop-serve-vs-volley-serve-2026/)
- [Laws of Badminton – worldbadminton.com](https://worldbadminton.com/laws/index.html)
- [Badminton serving rules – badminton-insight](https://badminton-insight.com/badminton-serving-rules-with-pictures/)
- [How to dink – pickleball.com](https://pickleball.com/docs/en/article/how-to-dink-in-pickleball.html)
- [Basics of the third shot drop – USA Pickleball](https://usapickleball.org/pickleball-training-tips/basics-of-the-third-shot-drop/page/6)
- [Đập cầu – ĐH Duy Tân (PDF)](https://files01.duytan.edu.vn/svruploads/gdtcqp-duytan/638561371309726393Các%20bước%20tập%20luyện%20ban%20đầu%20kỹ%20thuậy%20đập%20cầu.pdf)
