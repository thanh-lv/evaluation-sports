# Design v1.0 (base spec)

> DESIGN.md (v1.1) overrides this file wherever they differ. Sections in DESIGN.md that say "as in v1.0" refer to this file.

# RacketCoach MVP: Complete Implementation Plan

*Version 1.0, dated 2026-10-18. Working name "RacketCoach"; the bundle ID is `com.<company>.racketcoach`.*

---

## 0. Context

Beginners in badminton and pickleball rarely have a coach watching them. This app lets a player upload a short clip of one stroke, filmed of themselves or someone else. The app then:
- extracts 2D body pose on the iPhone with Apple Vision;
- sends a compact joint time-series plus 9 face-blurred key frames to Supabase;
- gets back, in Vietnamese or English:
  - an overall score and 6 sub-scores;
  - strengths and weaknesses, each with timestamped evidence that plays on a skeleton overlay;
  - a drill plan.

The business model is freemium with monthly and yearly auto-renewing subscriptions. The launch market is Vietnam, then international.

**Decisions taken by the user that are kept as-is:**
- Native SwiftUI.
- Hybrid analysis: on-device Vision pose, then backend, then Claude. No full-video upload.
- Supabase for Auth, Postgres, Storage and Deno Edge Functions.
- A full MVP covering both sports, in VI and EN.

**Environment facts checked during planning:**
- No Swift toolchain is installed in the container, and `download.swift.org` returns 403 through the proxy, so Swift code cannot be compiled or tested here.
- The Docker daemon is not running, so `supabase start` and `supabase db lint` cannot run.
- Postgres 16 server binaries are present at `/usr/lib/postgresql/16/bin`.
- Node 22 and Python 3.13 are present.
- The npm registry and JSR are reachable, so Deno can run via `npx deno@2.9.6`.
- GitHub release pages are blocked.

**Consequence:** every algorithm that can live on the server is written in TypeScript. That code is unit-tested here and can be hot-fixed without App Store review. Swift is limited to Apple-API adapters, tracking, UI and thin pure logic in `CoachCore`, which the user tests on the Mac.

---

## 1. Final decisions (conflicts between the research files resolved)

| # | Topic | Decision |
|---|---|---|
| D1 | Where the algorithms run | **Two-stage pipeline.**<br>• The device runs decode, Vision 2D pose, player selection, tracking, quality gate and payload.<br>• The server (TypeScript) runs cleanup, smoothing, stroke segmentation, phases, metrics, checkpoint scoring, best/worst stroke choice and the key-frame plan, including crop rectangles.<br>• The device then renders only the frames the server asked for.<br>Reason: the research's "key frames need on-device segmentation" constraint is solved by one extra cheap round-trip, and about 80% of the logic becomes Linux-testable and hot-fixable. |
| D2 | Who owns the numbers | **Code owns every number.**<br>• The deterministic engine scores the measurable checkpoints.<br>• Claude scores the *visual* checkpoints (level 0–4 or not assessable), chooses which grounded findings to present, and writes all coaching text.<br>• The server composes the 0–100 sub-scores and overall score.<br>This keeps Claude in the scoring loop, as the user decided, while making scores reproducible. Temperature cannot be set on these models (see §8). |
| D3 | Score model | 6 universal sub-scores (Stance & Balance, Footwork, Swing, Contact, Follow-through, Recovery), scored 0–100, with per-skill weights from the sport rubric. The backend research's sport-specific 1–10 LLM dimensions are dropped. |
| D4 | Skill selection | The user picks the skill before analysis. The 12 MVP skills are listed in §2.1. There is no automatic stroke classification. The server does a family sanity check and only issues a warning. |
| D5 | Sampling | One uniform rate per analysis: **60 Hz** if the source is ≥ 50 fps and the device benchmark passes, otherwise **30 Hz**. There is no separate native-rate refine pass (deferred to v1.1). |
| D6 | Smoothing | Server-side, offline, zero-phase: Hampel → gap fill → Savitzky–Golay. The One-Euro filter and EMA are not used. |
| D7 | Contact time | Peak dominant-wrist speed, refined by parabolic interpolation. **No audio** in MVP, so there is no microphone permission. |
| D8 | Confidence gate | A joint with confidence < 0.3 is treated as missing, on both device and server. |
| D9 | Key frames | The same payload for every tier: 2 strokes (best and worst) × 4 phases (`ready`, `bsEnd`, `contact`, `ftStop`), plus 1 full-frame overview, for **9 frames**. Each is 768 px on the long edge, JPEG q 0.8, with **all faces blurred on device**. |
| D10 | Models | Free tier uses `claude-haiku-5-5`. Premium, and the free user's first-ever analysis, use `claude-sonnet-5-5`. Opus 5.5 is **not used at launch**; routing is a table row (`model_routes`), so it can be switched in without a deploy. |
| D11 | Structured output | `output_config.format` with a JSON schema. There is no tool forcing: forced `tool_choice` returns 400 on Sonnet 5.5 and Opus 5.5. |
| D12 | Async job | `submit` returns 202, and the Claude call runs inside `EdgeRuntime.waitUntil`. The client **polls** the row through PostgREST, with no Realtime in MVP. A pg_cron sweeper retries stuck jobs. |
| D13 | Entitlement trust | The App Store Server API (over TLS) is the source of truth. A transaction JWS is decoded only to find the lookup key. Local x5c chain verification is **enforced only** when linking a transaction that has no `appAccountToken`. |
| D14 | Sign-in | Sign in with Apple, Google (native GoogleSignIn-iOS) and email OTP. App Review testing uses Sign in with Apple, a bundled sample clip and an offline demo mode. |
| D15 | In-app language | An in-app picker (System / Tiếng Việt / English).<br>• SwiftUI reads it from `.environment(\.locale)`.<br>• Non-view strings come from the matching `.lproj` bundle.<br>• Claude's output language is fixed per analysis.<br>• Deterministic texts (checkpoint, fault and drill names) are stored in both languages, so they switch instantly. |
| D16 | Local video | The imported or recorded file is copied to `Application Support/Analyses/<id>/source.<ext>`. Import limit is ≤ 5 min and ≤ 1 GB. Analysis segment is 3–30 s (default 20 s). Settings shows "Delete local videos"; results remain without playback. |
| D17 | Prices | VN: **79,000₫/month** and **599,000₫/year**. US base: **$9.99/month** and **$59.99/year**. A 7-day free trial applies to the yearly plan only. |
| D18 | Quotas | **Free:** 3 analyses per calendar month on Haiku, plus a one-time first analysis on Sonnet.<br>**Premium:** 20 per month on Sonnet.<br>**Trial:** 5 in total.<br>All values live in tables. |
| D19 | iOS target | iOS 17.0, SwiftUI with `@Observable`. The app target uses Swift 5 language mode with `SWIFT_STRICT_CONCURRENCY=targeted`, because AV/Vision types are non-Sendable. `CoachCore` uses Swift 6 mode and imports Foundation only. |
| D20 | Package pins | Pin only versions at least 2 weeks old:<br>• `npm:@anthropic-ai/sdk@0.131.0`<br>• `npm:zod@4.6.5`<br>• `npm:@supabase/supabase-js@2.117.2`<br>• `npm:jose@6.2.12`<br>• `npm:@peculiar/asn1-x509@2.10.0`<br>• Deno `2.9.6`<br>• Supabase CLI `2.119.0`<br>The research's pins (sdk 0.135.0, zod 4.6.7, supabase-js 2.118.0) are 3–6 days old. |

### 1.1 Corrections to the research

1. **Vision joints.** `VNDetectHumanBodyPoseRequest` returns 19 joints; that is confirmed. However, `neck` belongs to the **torso** group (neck, shoulders, root, hips), not "head". The face group is nose, eyes and ears. The 3D request returns 17 joints, which is correct. Hand pose (21 joints) is a separate request and is not used.
2. **Sonnet 5.5 cache read** is **$0.20/MTok**, not $0.10. Cache writes are 1.25× input for the 5-minute TTL: Sonnet $2.50, Opus $5, Haiku $0.125. Opus 5.5 reads are $0.20, which is 0.05×.
3. **Image tokens** are about 1 token per 28×28 px patch, so 768×576 ≈ 28×21 ≈ **588 tokens**. The `w·h/750` estimate is close but not the formula.
4. **Sampling parameters.** On Opus 5.5 they return 400. On Sonnet 5.5 and Haiku 5.5, any non-default value returns 400. So there is no temperature 0, and consistency comes from D2.
5. **Effort defaults:** Sonnet 5.5 defaults to `high`; Opus 5.5 and Haiku 5.5 default to `medium`. Set effort explicitly. Sonnet 5.5 cannot use `thinking: disabled`; only `between_tools` turns it off. We leave adaptive thinking on.
6. **Forced `tool_choice`** returns 400 on Opus 5.5 and Sonnet 5.5. Haiku 5.5 is not on that list, but we use `output_config.format` everywhere anyway.
7. **Haiku 5.5 tokenizer** counts about 30% more tokens than Haiku 4.5. The cost estimates in §8.7 include margin for this.
8. **Server-side fallbacks** (`fallbacks:"default"` with beta `server-side-fallback-2026-07-01`) are available for Sonnet 5.5 on the Claude API, but **not for Haiku 5.5**.
9. **Sport-rubric research:** the One-Euro filter is replaced by offline SG (D6), and audio-first contact detection is replaced by the wrist-speed peak (D7). Its free-tier/pro segment-length split is dropped; one 30 s cap applies to everyone.
10. **`NSPhotoLibraryAddUsageDescription` is not needed.** MVP has no save-to-Photos and no share card. No photo-library read permission is needed either, because PhotosPicker runs out of process.
11. **App Store Server API host:** use the long-standing `api.storekit.itunes.apple.com` and `api.storekit-sandbox.itunes.apple.com`, configurable through an env var. The new hosts mentioned in the research are not relied on.
12. **Supabase limits** (150 s Free / 400 s Pro wall clock, 2 s CPU, 256 MB) are taken from search results because supabase.com is blocked here. Re-check them at M6. The **Pro plan is required.**

---

## 2. MVP product scope

### 2.1 Skills (user picks one per clip)

| Sport | Skill ID | EN | VI (app copy) | Recommended view |
|---|---|---|---|---|
| Badminton | `bd.clear_fh` | Forehand overhead clear | Phông cầu thuận tay | Side (S) |
| | `bd.smash` | Smash | Đập cầu | S |
| | `bd.net_shot` | Net shot | Bỏ nhỏ trên lưới | S |
| | `bd.lift` | Net lift | Vẩy cầu (hất cầu) | S |
| | `bd.serve_low` | Low backhand serve | Giao cầu thấp trái tay | S |
| | `bd.serve_high` | High forehand serve | Giao cầu cao sâu thuận tay | S |
| Pickleball | `pb.serve` | Serve | Giao bóng | S |
| | `pb.return` | Return of serve | Trả giao bóng (return) | S |
| | `pb.dink` | Dink | Dink | S |
| | `pb.drop3` | Third-shot drop | Drop cú thứ ba | S |
| | `pb.drive` | Drive | Drive (cú bạt) | S or B |
| | `pb.volley` | Volley / punch volley | Vô-lê | S |

- Ready stance, split step and recovery checkpoints are evaluated **inside every stroke clip**.
- Deferred to v1.1: dedicated footwork, kitchen positioning, rear-court drop, backhand clear, grip photo, and an auto-detect "rally mode".

### 2.2 Screens and flows

1. **Welcome.** Language picker shown first (defaults to VI if the system is VI). Three value cards. Buttons "Bắt đầu" and "Xem phân tích mẫu" (offline demo; no login).
2. **Onboarding.** Profile answers are kept locally until sign-in:
   - Sport: badminton, pickleball or both.
   - Level: beginner, novice, intermediate or advanced.
   - Handedness: right or left.
   - Age band: under 13 is blocked; 13–15 requires a guardian-consent checkbox; 16+.
3. **Sign in.** Sign in with Apple (requests the email scope only), Google, or email + 6-digit OTP. After Apple sign-in the app calls `apple-auth-exchange`. The profile is upserted.
4. **AI consent** (blocking, versioned). Names **Anthropic (Claude)**. Lists what is sent: pose coordinates, about 9 still frames with faces blurred, sport, skill, level, handedness and an optional goal. States that the video is never uploaded, gives retention periods, links the privacy policy, and says consent can be withdrawn in Settings. Shown again when the consent version changes.
5. **Home.**
   - "Analyse a stroke" button.
   - Quota chip, e.g. "Còn 2/3 lượt tháng này".
   - Last result card.
   - Quick links: camera guide and sample clip.
6. **New analysis.** In order:
   1. Skill picker (sport tab → skill grid, each with an illustration and its recommended view).
   2. **Camera setup guide** (per-skill checklist, §10.3; "don't show again").
   3. Source: **Record** (in-app 1080p60, no audio, ≤ 60 s, framing silhouette, landscape) / **Photos** (PhotosPicker) / **Files** (fileImporter, for videos saved from Zalo).
   4. **Trimmer**: filmstrip, two handles, 3–30 s, loop preview. No re-encode; the output is a `CMTimeRange`.
   5. **Session form**:
      - Camera view, with icons: side (racket-hand side) / behind / front / diagonal.
      - Context: singles / doubles / drill.
      - Subject: me / someone else. "Someone else" requires the consent checkbox "Tôi có sự đồng ý của người trong video".
      - Optional goal (≤ 200 characters).
      - A coverage hint appears if the chosen view is not the recommended one, e.g. "Góc này không đo được: chuyển trọng tâm…".
   6. **Select player**: frame at segment start with all detected skeletons and boxes; the user taps the subject. Single-person clips are auto-selected with a confirmation. A "Try another frame" scrubber is available.
7. **Processing.** Steps with progress and cancel:
   1. "Đọc video" (decode).
   2. "Nhận diện tư thế" (pose, %).
   3. "Phân tích chuyển động" (prepare).
   4. "Trích khung hình" (frames).
   5. "Tải lên" (upload).
   6. "HLV AI đang nhận xét" (polling).

   Early rejections show capture tips and use no quota: player not found, player too small, no strokes detected, handedness mismatch (offer to swap).
8. **Results.**
   - **Score ring**: overall 0–100 plus a level label (Mới bắt đầu / Đang tiến bộ / Trung cấp / Nâng cao). "Partial analysis" appears when coverage is below 0.5.
   - **6 sub-score bars** (each can show "Chưa đủ dữ liệu").
   - **Summary** paragraph.
   - **Strengths** and **Weaknesses** cards. Each carries evidence chips ("Cú 2 · 13,91s · khuỷu tay 128° (mục tiêu ≥150°)"). Tapping a chip opens the **overlay player**, seeked to that time, with the relevant joints and angle highlighted.
   - **Overlay player**: video with skeleton, stroke markers on the scrubber, playback at 0.25/0.5/1×, frame step, skeleton toggle.
   - **Improvement plan**: 1–3 priorities, each with "how to fix", cues and 1–2 drills (sets × reps, steps, "Đánh dấu đã tập hôm nay").
   - **Rule-check badges** (serve legality, "tham khảo") and **Safety notes**, both from fixed catalog text.
   - "Cannot assess" list and recording tips.
   - Thumbs up/down feedback.
   - **Free tier** shows: overall score, sub-scores, the first 2 strengths and 2 weaknesses, and improvement #1. Everything else is blurred, with an "Mở khóa Premium" button.
9. **History.** Grouped by sport and skill: date, score and local thumbnail. Swipe to delete (removes the storage folder and the row). Opening an item reopens Results.
10. **Progress** (Premium). Swift Charts line chart of overall and sub-scores per skill, with personal best and "most improved" sub-score. Free users see a teaser with the paywall.
11. **Paywall.** `SubscriptionStoreView` with:
    - monthly and yearly options, with the trial shown on yearly;
    - restore, redeem code, and Terms/Privacy policy links;
    - VI/EN marketing header and a feature list.

    It opens when the quota is exhausted, when a locked section or Progress is tapped, or from Settings.
12. **Settings.**
    - Account (email, provider, sign out).
    - Subscription: status, Manage (`manageSubscriptionsSheet`), Restore, Redeem code.
    - Language.
    - Profile: sport, level, handedness.
    - Privacy: AI consent status with withdraw, "What we send".
    - Storage: local video size, delete local videos.
    - Legal: Privacy policy, Terms, the line "Không phải lời khuyên y tế".
    - Support email.
    - **Delete account.**
    - Version.

### 2.3 Out of scope for MVP (v1.1+)
- Share cards
- Push when done
- Translation of the narrative into the other language
- Refine pass at native fps
- Crop-follow for small players
- Torso-colour tracking cue
- Audio contact detection
- Grip photo
- Footwork and kitchen skills
- Rally mode
- Opus "deep" analysis
- Coach sharing
- Android

---

## 3. Architecture

```
iPhone (SwiftUI)                              Supabase ap-southeast-1 (Pro)                 Anthropic
───────────────                               ─────────────────────────────                 ─────────
Import/Record → Trim → Form → Tap player
AVAssetReader(30|60 Hz) → Vision 2D pose → Tracker → QualityGate → pose.v1 JSON
   ── POST /functions/v1/analyze/prepare (pose.v1, ≤1.2 MB) ──▶ engine: normalize→clean→SG→segment
                                                                 →phases→metrics→checkpoints
                                                                 →rank strokes→frame plan
                                                                 store pose.raw/clean.json, row=prepared
   ◀── strokes, warnings, frameRequests[9] (t, crop) ───────────  (no quota used)
AVAssetImageGenerator(t, zero tol) → crop → face blur → 768px JPEG
   ── Storage upload analysis-inputs/{uid}/{id}/frames/F1..F9.jpg (RLS) ──▶
   ── POST /analyze/submit {analysisId} ──▶ consent+frames check → reserve_quota → queued → 202
                                          waitUntil(runAnalysis): claim→build prompt ──────────▶ Haiku 5.5 / Sonnet 5.5
                                                                  ◀── coach.v1 JSON ───────────  (structured output)
                                          postprocess→compose scores→analysis_results→commit quota→succeeded
   ◀── poll analyses.status (PostgREST, 2→5 s) ── then fetch analysis_results + pose.clean.json
pg_cron (2 min) → /cron sweep (retry stuck/queued) ; daily → retention, orphans, App Store reconcile
StoreKit 2 → /verify-subscription ; Apple ASSN v2 → /appstore-webhook ; Delete → /delete-account
```

---

## 4. Repository layout (monorepo)

```
/
├─ README.md                      # setup: Mac (Xcode, xcodegen), Supabase, secrets
├─ scripts/
│  ├─ check.sh                    # runs every Linux-verifiable check (§13.1)
│  ├─ gen-schemas.ts              # Zod → shared/schemas/*.json (+ diff check)
│  ├─ gen-synthetic-pose.ts       # synthetic swings with known contact times
│  ├─ replay.ts                   # pose.v1 → prepare → prompt → (mock|live) Claude → final result
│  ├─ bench-engine.ts             # 30 s @60 Hz prepare must stay < 300 ms
│  ├─ eval.ts                     # re-run labelled fixtures, MAE vs coach labels
│  ├─ smoke-claude.ts             # LIVE, costs money, needs approval: 1 call per model, prints usage
│  ├─ gen-test-certs.sh           # openssl test CA chain (P-384 root, intermediate OID, P-256 leaf)
│  └─ check_ios_resources.py      # xcstrings completeness, xcprivacy plist, .storekit IDs, Info keys
├─ shared/
│  ├─ schemas/                    # pose.v1, prepare-response.v1, coach-output.v1, coach-result.v1 (.schema.json)
│  └─ fixtures/
│     ├─ pose/                    # synthetic_bd_clear_60hz.json, synthetic_pb_dink_30hz.json, device_*.json
│     ├─ prepare/                 # golden prepare responses
│     ├─ claude/                  # mocked model outputs: ok, refusal, max_tokens, invalid_ids, medical_terms
│     └─ results/                 # golden coach-result.v1 (also used by SwiftUI previews)
├─ ios/
│  ├─ project.yml                 # XcodeGen
│  ├─ Config/  Base.xcconfig, Debug.xcconfig, Release.xcconfig, Secrets.example.xcconfig
│  ├─ RacketCoach/
│  │  ├─ App/        RacketCoachApp.swift, AppModel.swift, RootView.swift, Router.swift, Dependencies.swift
│  │  ├─ Features/   Welcome/ Onboarding/ Auth/ Consent/ Home/ Capture/(Guide, Recorder, Import, Trimmer, SessionForm)
│  │  │              PlayerSelect/ Processing/ Results/(ScoreRing, SubScores, Findings, OverlayPlayer, Plan)
│  │  │              History/ Progress/ Paywall/ Settings/ Demo/
│  │  ├─ Services/   Video/(AssetInfo, VideoImporter, CameraRecorder, FrameReader, KeyFrameExtractor, FaceBlurrer)
│  │  │              Pose/(PoseEstimator, VisionPoseEstimator) Pipeline/(AnalysisPipeline, PipelineEvent)
│  │  │              Backend/(SupabaseProvider, AnalysisAPI, ProfileAPI, QuotaAPI)
│  │  │              Auth/(AppleSignIn, GoogleSignInService, EmailOTP) Purchases/(StoreService)
│  │  │              Local/(LocalAnalysisStore, StorageMaintenance) L10n/(AppLanguage, L10n)
│  │  ├─ DesignSystem/ Theme.swift, ScoreRing.swift, Chips.swift, LockedOverlay.swift
│  │  └─ Resources/  Localizable.xcstrings, InfoPlist.xcstrings, PrivacyInfo.xcprivacy, Products.storekit,
│  │                 Assets.xcassets (view illustrations, silhouettes), Samples/(bd_clear.mov, pb_dink.mov,
│  │                 *.result.json, *.pose.clean.json)
│  ├─ RacketCoachTests/           # view-model tests with protocol mocks
│  └─ Packages/CoachCore/         # Package.swift (tools 6.0; iOS 17, macOS 14), Sources/CoachCore, Tests/CoachCoreTests
├─ supabase/
│  ├─ config.toml
│  ├─ seed.sql                    # plan_limits, model_routes
│  ├─ migrations/
│  │  ├─ 20261020000100_core.sql          # profiles, analyses, results, drill_logs, feedback
│  │  ├─ 20261020000200_billing.sql       # plan_limits, model_routes, entitlements, subscriptions, usage, ledger
│  │  ├─ 20261020000300_private.sql       # private schema tables
│  │  ├─ 20261020000400_functions.sql     # quota/entitlement/progress SQL functions
│  │  ├─ 20261020000500_rls.sql           # RLS + grants
│  │  ├─ 20261020000600_storage.sql       # buckets + storage.objects policies
│  │  └─ 20261020000700_cron.sql          # pg_cron + pg_net + vault (skipped by Linux test runner)
│  ├─ functions/
│  │  ├─ deno.json                         # imports (pinned), tasks, lint/fmt config
│  │  ├─ _shared/
│  │  │  ├─ http.ts errors.ts log.ts env.ts auth.ts db.ts storage.ts crypto.ts quota.ts budget.ts
│  │  │  ├─ contracts/  pose_v1.ts prepare_v1.ts coach_output_v1.ts coach_result_v1.ts
│  │  │  ├─ rubric/     types.ts badminton.json pickleball.json drills.json glossary.json load.ts
│  │  │  ├─ engine/     normalize.ts cleanup.ts filters.ts(hampel, savgol, hermite) segment.ts phases.ts
│  │  │  │              metrics.ts checkpoints.ts score.ts rank.ts frameplan.ts viewcheck.ts handedness.ts prepare.ts
│  │  │  ├─ claude/     client.ts prompts/base_system.ts prompts/rubric_text.ts build_request.ts
│  │  │  │              run.ts postprocess.ts medical_filter.ts compose.ts
│  │  │  └─ apple/      jwt.ts api.ts jws.ts linking.ts siwa.ts
│  │  ├─ analyze/index.ts               # routes /prepare, /submit
│  │  ├─ cron/index.ts
│  │  ├─ verify-subscription/index.ts
│  │  ├─ appstore-webhook/index.ts
│  │  ├─ apple-auth-exchange/index.ts
│  │  └─ delete-account/index.ts
│  └─ tests/
│     ├─ engine/*.test.ts  claude/*.test.ts  apple/*.test.ts  functions/*.test.ts  rubric/*.test.ts
│     └─ sql/ shim.sql, assertions/*.sql, run.sh     # temp PG16 cluster
└─ docs/
   ├─ camera-guide.vi.md / .en.md
   ├─ glossary.md                      # VI terminology, "(?)" items for coach review
   ├─ legal/ privacy.vi.md privacy.en.md terms.vi.md terms.en.md ai-disclosure.md pdpl-ctia-checklist.md
   ├─ appstore/ metadata.vi.md metadata.en.md review-notes.md privacy-label.md
   └─ rubric/ calibration.md           # labelling protocol, thresholds tuning log
```

`docs/legal/*.md` is published as static pages on an official domain (any static host). The URLs go into `Config/*.xcconfig` and into App Store Connect.

---

## 5. iOS app

### 5.1 Project configuration (`ios/project.yml`, XcodeGen)

**Project options:**
- `name: RacketCoach`
- `options.deploymentTarget.iOS: "17.0"`
- `developmentLanguage: en`, with `knownRegions: [en, vi]`

**Packages:**
- `CoachCore: {path: Packages/CoachCore}`
- `Supabase: {url: https://github.com/supabase/supabase-swift, exactVersion: <latest 2.x ≥ 2 weeks old>}`
- `GoogleSignIn: {url: https://github.com/google/GoogleSignIn-iOS, exactVersion: <latest 8.x>}`
- Both versions are pinned at M9 and recorded in the README.

**Target `RacketCoach`:**
- Dependencies: `CoachCore`, `Supabase`, `GoogleSignIn`, `GoogleSignInSwift`.
- Entitlements: `com.apple.developer.applesignin: [Default]`.
- `configFiles` for Debug and Release.

Info properties:

| Key | Value |
|---|---|
| `NSCameraUsageDescription` | Localized in `InfoPlist.xcstrings` |
| `ITSAppUsesNonExemptEncryption` | `NO` |
| `CFBundleLocalizations` | `[en, vi]` |
| `UILaunchScreen` | `{}` |
| `UISupportedInterfaceOrientations` | portrait and landscape; the app UI locks portrait except the Recorder and the full-screen player |
| `GIDClientID`, `CFBundleURLTypes` | Google reversed client ID |
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `LEGAL_PRIVACY_URL`, `LEGAL_TERMS_URL`, `SUBSCRIPTION_GROUP_ID` | from xcconfig |

Not added: no microphone key, no photo-library keys, no background modes.

**Scheme `RacketCoach`:**
- `run.storeKitConfiguration: RacketCoach/Resources/Products.storekit`
- The test target is `RacketCoachTests`. CoachCore tests run with `swift test`.

**Build settings:**
- `SWIFT_VERSION 5.0`
- `SWIFT_STRICT_CONCURRENCY targeted`
- `LOCALIZATION_PREFERS_STRING_CATALOGS YES`
- `SWIFT_EMIT_LOC_STRINGS YES`

### 5.2 App target modules

| Module | Responsibilities | Key types / APIs |
|---|---|---|
| App | DI container and root routing: onboarding, auth, consent, main tabs (Home, History, Progress, Settings). Global `AppModel` (`@Observable @MainActor`) holds session, profile, entitlement and quota | `Dependencies` (protocols for every service, so previews and tests use mocks) |
| L10n | App language, locale environment, bundle lookup for non-view strings | `AppLanguage {system, vi, en}` in `@AppStorage`; `L10n.string(_ key: String.LocalizationValue)` uses `Bundle(path: vi.lproj/en.lproj)`; root `.environment(\.locale, AppLanguage.locale)` plus `.id(lang)` |
| Auth | Apple (nonce: SHA-256 of a random string; `signInWithIdToken(.apple)`, then `apple-auth-exchange` with `authorizationCode`), Google (`GIDSignIn` → `signInWithIdToken(.google, idToken, accessToken)`), email OTP (`signInWithOTP`, `verifyOTP(type: .email)`) | `AuthService` |
| Capture | Camera guide, recorder, importer, trimmer, session form | `CameraRecorder` (`AVCaptureSession`, `.inputPriority`, 1920×1080 format with max fps ≥ 60, `activeVideoMin/MaxFrameDuration = 1/60`, HEVC if available, HDR off, `RotationCoordinator` → `videoRotationAngle`, `maxRecordedDuration 60 s`, `builtInWideAngleCamera` back only, no audio input); `VideoImporter` (`PhotosPicker(matching: .all(of:[.videos, .not(.livePhotos)]), preferredItemEncoding: .current)`, `Transferable` `FileRepresentation` copying into the container; `.fileImporter([.movie])` with security-scoped copy); `TrimmerModel` (`AVAssetImageGenerator.images(for:)` filmstrip with `maximumSize` 160, chase-time seeking, `forwardPlaybackEndTime` loop) |
| Video | Asset metadata, frame reading, key frames | `AssetInfo.load(url)` → `nominalFrameRate`, `preferredTransform`, `naturalSize`, `duration` using `AVURLAsset`; `FrameReader` (`AVAssetReader`, `420YpCbCr8BiPlanarFullRange`, `alwaysCopiesSampleData=false`, `reader.timeRange = segment`, PTS-based decimation through `CoachCore.FrameScheduler`, `autoreleasepool` per frame, no pixel-buffer retention); `KeyFrameExtractor` (`AVAssetImageGenerator` with zero tolerances, `appliesPreferredTrackTransform=true`, SDR dynamic-range policy where available; crop by server rect; scale to long edge 768 without upscaling; `FaceBlurrer` using `VNDetectFaceRectanglesRequest` + `CIPixellate` scale 24 on each face rect × 1.3; ImageIO JPEG quality 0.8, sRGB, no metadata) |
| Pose | Vision adapter behind a protocol | `protocol PoseEstimator { func detect(_ pb: CVPixelBuffer, orientation: CGImagePropertyOrientation) throws -> [CoachCore.PersonCandidate] }`; `VisionPoseEstimator` reuses one `VNDetectHumanBodyPoseRequest` and maps `JointName` → `CoachCore.Joint` with an explicit `switch` (raw values are never persisted); `@preconcurrency import Vision`; Vision objects stay confined to the pipeline task |
| Pipeline | Orchestration | `AnalysisPipeline.run(draft) -> AsyncThrowingStream<PipelineEvent>`. Events: `.benchmark(hz)`, `.decoding(p)`, `.pose(p)`, `.preparing`, `.rejected(code,tips)`, `.handednessSuggestion`, `.frames(p)`, `.uploading(p)`, `.queued`, `.done(result)`. Runs in `Task.detached(priority: .userInitiated)`; `Task.checkCancellation()` per frame; `isIdleTimerDisabled` while running; on scene background: `beginBackgroundTask`; if the reader fails, resume from the last processed PTS with a new reader |
| Backend | Supabase calls | `AnalysisAPI.prepare(PoseV1) -> PrepareResponse` (`functions.invoke("analyze/prepare")`); `uploadFrames` (Storage `analysis-inputs`, `upsert: true`); `submit(id)`; `poll(id)` (PostgREST `analyses?select=status,failure_code`, 2 s → 5 s backoff, 5 min cap, then "Still working, it will appear in History"); `fetchResult(id)`; `downloadCleanTrack(id)`; `QuotaAPI.status()` (`rpc("quota_status")`); `ProfileAPI` |
| Purchases | StoreKit 2 | `StoreService`: loads `Product.products(for:)`; starts the `Transaction.updates` listener at launch; `sync(reason:)` posts each `jwsRepresentation` to `verify-subscription` and only then calls `finish()`; launch sync of `Transaction.currentEntitlements` when the server says free; `restore()` calls `AppStore.sync()` then sync |
| Local | On-device history index and videos | `LocalAnalysisStore` (Codable JSON index in Application Support: id, local video path, thumbnail path, segment, cached result, cached `pose.clean.json`); `StorageMaintenance` (size, delete videos, uses `FileManager` attributes) |
| Results | Rendering coach-result.v1 | `ResultsViewModel`, `ScoreRing` (Canvas arc), `SubScoreBar`, `FindingCard`, `EvidenceChip` → `OverlayPlayerView(seekTo:highlight:)`, `PlanView`, `LockedOverlay` (free gating), `FeedbackBar` |
| Overlay | Skeleton playback | `PlayerView: UIView` with `layerClass = AVPlayerLayer` and `.resizeAspect`; `CAShapeLayer` bones and joints; maps by `playerLayer.videoRect`; `CADisplayLink` + `AVPlayerItemVideoOutput.itemTime(forHostTime:)`; a periodic observer for paused/seek states; `CATransaction.setDisableActions(true)`; poses from `CoachCore.PoseTimeline` |
| Progress | Charts | Swift Charts line chart from `rpc("get_progress", {sport, skill})` |
| Demo | Offline sample | Plays `Samples/*.mov` and runs the real on-device pose pass for the animation, then loads the bundled `*.result.json` and `*.pose.clean.json`. No network |

### 5.3 `CoachCore` (local Swift package: Foundation only, Swift 6, deterministic)

| Folder | Types / functions | Notes |
|---|---|---|
| `Model/` | `enum Joint: String, CaseIterable` with 19 cases (`nose, lEye, rEye, lEar, rEar, neck, lSho, rSho, lElb, rElb, lWri, rWri, root, lHip, rHip, lKne, rKne, lAnk, rAnk`; order = payload `jointOrder`); `Keypoint {x,y,c: Double}` in CFS; `PersonCandidate {joints: [Joint: Keypoint], bbox: Rect}`; `Rect`, `Point` | Joint names are our own, never Vision raw strings |
| `Geometry/` | `OrientationMapper.exifOrientation(a:b:c:d:) -> UInt32` (angle = atan2(b,a): 0°→`.up`(1), 90°→`.right`(6), 180°→`.down`(3), −90°→`.left`(8); det < 0 → mirrored variants 2/7/4/5); `displaySize(natural:transform:)`; `VisionToCFS.convert(x,y) = (x, 1−y)` | Mirrored cases are verified on device |
| `Sampling/` | `FrameScheduler(targetHz)`: keep a frame if `pts ≥ nextT − 0.5/srcFps`, then `nextT += 1/targetHz`; `RateChooser.choose(srcFps, msPerFrame, segmentSec, thermal) -> 30 or 60` | Rule in §5.4 |
| `Tracking/` | `CandidateBuilder` (bbox = min/max of joints with c ≥ 0.3, padded 10% plus 0.5·torso headroom); `TargetSelector.select(tap:candidates:)`, `autoSelect(candidates:)`; `Tracker` (mutating `step(t:candidates:) -> TrackStep {index?, coasted, reacquired, ambiguous}`) | Algorithm in §5.4 |
| `Quality/` | `QualityAccumulator` → `QualityStats {framesTotal, framesWithTarget, meanLimbConf, playerHeightFracMedian, missingPct, trackResets, ambiguousAtMs[]}`; `QualityGate.evaluate(stats) -> [RejectReason]` | Gate thresholds in §5.4 |
| `Payload/` | `PoseV1` (Codable), `Quantizer` (x,y → 0–1000 Int; c → 0–100; c < 0.3 → `0,0,0`); `PoseV1Builder`; `PrepareResponseV1`; `CoachResultV1` (Codable mirror of §7.4) | Encoded fixtures must equal `shared/fixtures` byte for byte (sorted keys) |
| `Crop/` | `CropMath.pixelRect(cropCFS:display:)`, `outputSize(for:longEdge: 768)` (never upscale) | |
| `Overlay/` | `SkeletonGeometry.bones` (14 bones: nose-neck, neck-lSho, neck-rSho, lSho-lElb, lElb-lWri, rSho-rElb, rElb-rWri, neck-root, root-lHip, root-rHip, lHip-lKne, lKne-lAnk, rHip-rKne, rKne-rAnk); `PoseTimeline.pose(at ms) -> [Joint: Point]?` (binary search, linear interpolation, hidden across gaps > 100 ms); `MetricHighlight.joints(for metricKey)` (e.g. `elbowAng` → lSho/lElb/lWri on the racket side) | |
| `Tests/` | swift-testing: orientation table, scheduler with VFR timestamps, tracker with synthetic crossings, quantizer round trip, fixture decode of `shared/fixtures/**` | Runs on the Mac |

### 5.4 On-device algorithms

1. **Rate choice.**
   - If `srcFps < 50`, use 30 Hz.
   - Otherwise, time the first 20 Vision calls and compute `projected = msPerFrame × segmentSec × 60`.
   - Use 60 Hz if `projected ≤ 1.5 × segmentSec × 1000 + 10 000` and `thermalState ≤ .fair`; otherwise restart at 30 Hz.
   - Warn when the source is below 30 fps; reject below 24 fps.
2. **Decode** with `AVAssetReader` over the segment. Timestamps are **asset-timeline PTS** in ms; frame index ÷ fps is never used (videos can be VFR).
3. **Pose.**
   - Orientation comes from `OrientationMapper` using `preferredTransform`.
   - Each frame: `VNImageRequestHandler(cvPixelBuffer:orientation:)`, then all observations → `PersonCandidate`s in CFS (top-left origin, 0–1).
   - Threading: one decode thread and one Vision consumer, with a bounded queue of 2.
4. **Player selection** at the first frame in `[segStart, segStart+3 s]` that contains at least one person.
   - Tap selection: the bbox containing the tap; if several contain it, the nearest centroid.
   - Auto-select only if exactly one candidate has mean confidence ≥ 0.5 and every other candidate's area is < 30% of its area. A confirmation is still shown.
5. **Tracking** (per frame, after selection):
   - Prediction: constant velocity from the last 2 matches.
   - Cost: `(1 − IoU) + 0.5·|Δcentroid|/diag(pred) + 0.2·|ln(area_c/area_pred)|`.
   - Gate: accept if IoU > 0.1 or `|Δcentroid| < 1.5·torsoPx`.
   - Coast for up to 0.5 s, marking frames missing.
   - Re-acquire the nearest candidate to the last position with torso size within ±30%, flagged `reacquired`.
   - If two candidates fall within 15% cost of each other, add `ambiguousAtMs`.
6. **Quality gate** (blocks upload and costs no quota):
   - Target present in < 60% of frames → "player not found".
   - Median player height < 15% of frame → "too far".
   - Mean limb-joint confidence < 0.4 → "poor visibility".
   - Each failure comes with tips.
7. **Key frames** after `prepare`. For each `frameRequest`:
   - get the image at the exact time;
   - crop to `cropCFS` (the `overview` frame is the full frame);
   - blur faces;
   - scale to 768 px long edge;
   - JPEG, about 60–100 KB each.

   All 9 frames are uploaded in parallel, at most 3 at a time.

---

## 6. Backend

### 6.1 Edge functions

| Function | Route | `verify_jwt` | Purpose |
|---|---|---|---|
| `analyze` | `POST /analyze/prepare` | true | Validate pose.v1 (≤ 1.2 MB). Rate limit: 20 per hour per user. Run the engine, upsert `analyses` (status `prepared` or `rejected`), store `pose.raw.json` and `pose.clean.json` in `analysis-derived`, and return §7.2 |
| `analyze` | `POST /analyze/submit` | true | Check consent (`ai_consent_version` = current, else 403 `consent_required`); check the frames listed in `analysis-inputs/{uid}/{id}/frames/`; budget guard (503); in-flight ≤ 1 (429); `reserve_quota` (402 `quota_exceeded {limit, used, resets_at}`); set status `queued`; `EdgeRuntime.waitUntil(runAnalysis(id))`; return 202 `{status:"queued", pollAfterMs:2000}`. Idempotent: if already queued/processing it returns 202; if succeeded, 200 |
| `cron` | `POST /cron {task}` | false; header `x-cron-secret` | `sweep` (every 2 min): run `runAnalysis` for up to 5 sessions that are queued with `next_attempt_at ≤ now()` or processing with `locked_at < now()−6 min`. `daily`: delete key frames older than 30 days; delete `prepared` sessions older than 24 h and their files; delete orphan folders with no row; refresh App Store notification history (last 26 h) and subscriptions expiring within 48 h; recompute expired entitlements |
| `verify-subscription` | `POST` | true | §9.4 |
| `appstore-webhook` | `POST` | false | App Store Server Notifications V2 (§9.5) |
| `apple-auth-exchange` | `POST {authorizationCode}` | true | Build the client-secret JWT (ES256; `iss`=team ID, `sub`=bundle ID, `aud`=`https://appleid.apple.com`, `exp` ≤ 6 months); `POST https://appleid.apple.com/auth/token`; store the refresh token AES-GCM-encrypted in `private.apple_auth_tokens` |
| `delete-account` | `POST {confirm:true}` | true | Each step is idempotent:<br>1. Revoke Sign in with Apple (`/auth/revoke`, `token_type_hint=refresh_token`); if no token is stored, return `siwaManualRevoke:true`.<br>2. Remove `{uid}/` from both buckets via the Storage API, paged, in batches of up to 1000.<br>3. Delete `private.apple_auth_tokens`.<br>4. Null `user_id` and `app_account_token` on `app_store_subscriptions`.<br>5. `auth.admin.deleteUser(uid)` (hard delete; rows cascade).<br>6. Write `private.audit_log` with `sha256(uid + pepper)`.<br>Returns `{deleted, hadActiveSubscription}`; the app then shows "Apple billing continues until you cancel" and `manageSubscriptionsSheet` |

**Shared modules (`_shared/`):**
- `auth.ts`: `requireUser(req)` builds a user-scoped client and calls `auth.getClaims()`.
- `db.ts`: service-role client using the secret key.
- `errors.ts`: typed `{code, http}`.
- `log.ts`: JSON logs (`fn`, `req_id`, `analysis_id`, `step`, `ms`, `model`, `tokens`, `stop_reason`, `code`). Never logs images, coordinates or emails; the user ID is hashed.
- `budget.ts`.
- `crypto.ts`: AES-GCM via WebCrypto.
- Every outbound `fetch` has an `AbortSignal.timeout`.

**`supabase/config.toml`:**
- `[edge_runtime] policy = "per_worker"`, so `waitUntil` completes locally.
- `[functions.<name>] verify_jwt` set as in the table above.
- `import_map = "./functions/deno.json"`.

### 6.2 Analysis engine (`_shared/engine`, pure TypeScript, no Deno APIs)

**Pipeline in `prepare.ts`:** validate → normalize → cleanup → T → handedness check → segment → phases → metrics → checkpoints → view check → rank strokes → frame plan → clean-track export.

1. **Normalize.**
   - Dequantize to CFS.
   - Aspect-correct to `P = (x·W/H, 1 − y)` in frame-height units, with y pointing up.
   - **T** (torso unit) = median over the clip of `|neck − root|`; fall back to shoulder midpoint → hip midpoint when neck or root is missing.
   - All lengths are expressed in T and speeds in T/s. Rough calibration: 1 T ≈ 0.5 m.
2. **Cleanup**, in this order:
   1. Joints with confidence < 0.3 are already missing.
   2. **L/R swap fix** per limb chain (shoulder–elbow–wrist, hip–knee–ankle): swap when the swapped assignment's distance to frame t−1 is < 0.6× the identity distance. If the source was mirrored (det < 0), swap all labels.
   3. **Hampel filter**: window 7 (30 Hz) or 13 (60 Hz), threshold 3·MAD, per coordinate.
   4. **Gap fill**: ≤ 100 ms linear; ≤ 200 ms cubic Hermite when both ends are good; longer gaps stay null.
   5. **Savitzky–Golay** zero-phase, order 2, window 5 (30 Hz) or 9 (60 Hz) for positions. Velocities come from the SG derivative kernel.
3. **Handedness check.** Take the top 5 wrist-speed peaks across both wrists. If 4 or more belong to the non-profile wrist, return `handednessSuggestion`; the app asks the user and re-runs `prepare`, which is free.
4. **Segmentation** on `v(t)`, the dominant-wrist speed in T/s:
   - Candidates: local maxima with `v ≥ max(Vmin_skill, 2.5·median(v))` and prominence ≥ 0.4·peak.
   - Non-max suppression with spacing `nms_skill`.
   - Reject a candidate if the wrist is missing in > 30% of ±0.2 s, or if the track was re-acquired within that window.
   - `t_contact` = peak refined by 3-point parabolic interpolation.
   - Starting values (marked ≈, to be calibrated):

     | Skill | Vmin (T/s) | NMS (s) |
     |---|---|---|
     | clear_fh | 4 | 0.8 |
     | smash | 4 | 0.8 |
     | net_shot | 1.2 | 0.8 |
     | lift | 2 | 0.8 |
     | serve_low | 1.2 | 2.0 |
     | serve_high | 3 | 2.0 |
     | pb.serve | 2 | 2.0 |
     | return | 2 | 1.0 |
     | dink | 1.2 | 0.8 |
     | drop3 | 1.5 | 1.0 |
     | drive | 3 | 1.0 |
     | volley | 1.5 | 0.8 |

   - At most 12 strokes. Zero strokes → 422 `no_strokes_detected`.
5. **Phases** for each stroke:
   - `ready` = median pose over `[tc−1.2 s, tc−0.7 s]`, clipped to start after the previous stroke's `ftStop + 0.3 s`. If less than 0.2 s remains, it is not assessed.
   - `bsEnd` = argmin `v` in `[tc−0.6 s, tc−0.05 s]` (backswing turnaround).
   - `contact` = `tc`.
   - `ftStop` = first `t ∈ (tc, tc+0.8 s]` with `v < max(0.5, 0.2·v_peak)`, otherwise `tc+0.8 s`.
   - `recovery` = `tc + 1.0 s`.
   - `swingStart` = last `t < bsEnd` with `v < 0.5 T/s`, within 1 s.
6. **Hitting direction `f`** (side view): sign of the mean horizontal dominant-wrist velocity over `[tc−0.1, tc+0.1]`, decided by majority vote across strokes. If the vote is weak, fall back to the nose versus the ear midpoint in `ready`.
   - **Handedness sign `h`:** in behind view, image-right = player-right; front view is mirrored; left-handers flip lateral signs.
7. **Metric registry** (`metrics.ts`; each function returns `{value, conf}`, where conf is the mean confidence of the joints used):

| Key | Definition | Unit | View factor S / B / D |
|---|---|---|---|
| `kneeFlex(side)` | 180° − ∠(hip, knee, ankle) | deg | 1 / .6 / .6 |
| `elbowAng` | ∠(shoulder, elbow, wrist), racket arm | deg | .6 / .6 / .6 |
| `trunkLean` | angle of root→neck from vertical, + toward `f` | deg | 1 / .6 (lateral) / .6 |
| `shinAngle` | ankle→knee from vertical, + when the knee is ahead | deg | 1 / 0 / .6 |
| `stanceW` | \|ankL.x − ankR.x\| / (SWmax·T), where SWmax = p95 of shoulder width/T | ratio | 0 / 1 / .6 |
| `stagger` | fore–aft ankle distance / T | T | 1 / 0 / .6 |
| `turn` | B: acos(clamp(SW/SWmax)); S: asin(…); magnitude only, about ±15–20° error | deg | .6 / 1 / 0 |
| `wristH` | (wrist.y − root.y)/T | T | 1 / 1 / 1 |
| `reach` | (wrist.y − shoulder.y)/Larm, where Larm = p95 of (\|sh−el\| + \|el−wr\|)/T | ratio | 1 / 1 / 1 |
| `elbowRel` | (elbow.y − shoulder.y)/T | T | 1 / 1 / 1 |
| `wristFwd` | (wrist.x − racket-shoulder.x)·f/T | T | 1 / 0 / .6 |
| `wristLat` | (wrist.x − torso-midline.x)·h/T | T | 0 / 1 / .6 |
| `vWrist`, `vyWrist`, `vRoot` | SG-derivative speed, vertical velocity, horizontal root speed | T/s | all; × 0.5 confidence at 30 Hz |
| `bsLen`, `ftLen` | wrist path length swingStart→contact and contact→ftStop | T | 1 / .6 / .6 |
| `ftCross` | wrist crosses the neck–root line to the non-racket side within 0.6 s | bool | 0 / 1 / .6 |
| `wShift` | (root.x − rearAnk.x)/(frontAnk.x − rearAnk.x) | 0–1 | 1 / 0 / .6 |
| `feetStill` | max ankle displacement from setup to contact / T | T | 1 / 1 / 1 |
| `hop` (split step) | both ankles rise ≥ 0.04 T above their 0.5 s rolling median, onsets ≤ 70 ms apart, landing 0.1–0.4 s later | event | .6 / .6 / .6 |
| `moveOnset` | horizontal `vRoot` > 0.8 T/s for ≥ 3 frames | event | |
| `baseErr` | \|root − base\|/T, where base = median root in ready frames | T | .6 / 1 / .6 |
| `headStill` | nose displacement / T over [−0.2, +0.1] s around contact | T | 1 / 1 / 1 |

8. **View check.** Compare the median shoulder-width/T in ready frames with SWmax: ≈1 suggests B or front, low suggests S. The result is `viewGuess`, which produces a warning only; scoring uses the **user-selected** view factors.
9. **Stroke ranking.** Stroke score = Σ w·c·s / Σ w·c over the M checkpoints, among strokes with stroke-quality ≥ 0.6. Best = highest; worst = lowest. With one stroke there are 4+1 frames.
10. **Frame plan.**
    - For each chosen stroke, the crop is the union of target bboxes over `[ready, ftStop]` ∪ (wrist ± racket length, about 1.4 T for badminton and 0.8 T for pickleball), expanded 1.3×, snapped to 4:3 or 3:4, and clamped to the frame. All phases of a stroke share the same crop.
    - Frame IDs: `F1–F4` (best stroke: ready, bsEnd, contact, ftStop), `F5–F8` (worst stroke), `F9` (full-frame overview at the best stroke's contact).
11. **Clean track export.** `pose.clean.json` uses the same layout as pose.v1 plus `strokes` and `phases`, for the overlay player.

### 6.3 Rubric data (`_shared/rubric/*.json`; the source of truth; versioned)

```ts
type Assess = "M" | "M~" | "V" | "N";
type SubScore = "stance"|"footwork"|"swing"|"contact"|"follow"|"recovery";
interface CheckpointDef { id: string;            // e.g. "bd.clear_fh.C5", shared ready: "bd.ready.R2"
  sport: "badminton"|"pickleball"; skills: string[]; phase: "ready"|"bsEnd"|"contact"|"contact+0.2"|"ftStop"|"recovery"|"window";
  subscore: SubScore; weight: 1|2; assess: Assess;
  metric?: { fn: string; params?: Record<string, unknown>; target: [number|null, number|null] | boolean; tol: number; unit: string; relativeTo?: string };
  views: { S: 0|0.6|1; B: 0|0.6|1; D: 0|0.6|1 }; velocityBased: boolean;
  ruleFlag?: true; injuryFlag?: true; vAnchors?: [string,string,string,string,string]; // EN, sent to Claude
  name: { vi: string; en: string }; faults: string[]; joints: string[] }   // joints → overlay highlight
interface FaultDef { id: string; checkpoint: string; when: "low"|"high"|"false";
  title: {vi,en}; cue: {vi,en}; why: {vi,en}; drills: string[]; defaultDrill: string }
interface DrillDef { id: string; sport: string; dose: { sets: number; reps?: number; seconds?: number };
  title: {vi,en}; steps: {vi: string[]; en: string[]}; safety?: {vi,en} }
interface SkillDef { id: string; weights: Record<SubScore, number> /* sum 100 */; vmin: number; nms: number;
  family: "overhead"|"side"|"underarm"; preferredView: "S"|"B"; checkpoints: string[] }
```

**Content:**
- Use the checkpoints, faults, drills, targets, tolerances and weight matrix from the sport-rubric research, for the 12 MVP skills plus the shared ready and split-step checkpoints.
- Key checkpoints have weight 2: C1, C3, C5, NS2, RT6, DK2, DK3, PR4, VO1.
- About 25 drills per sport.
- Rule flags: LS1, LS4, LS5, HS2, HS5, RS1, RS2.
- Injury flags: FW4, SM7, PM5. Their text is fixed catalog copy that ends "nếu đau, hãy hỏi HLV/chuyên gia".

**Integrity tests (`tests/rubric/*.test.ts`):**
- Weights sum to 100.
- Every `metric.fn` exists in the registry.
- Every fault has ≥ 1 drill and a valid `defaultDrill`.
- Every V checkpoint has 5 anchors.
- Every text field has both `vi` and `en`.
- IDs are unique.

`rubric_version` = sha256 of the canonical JSON.

### 6.4 Scoring (`score.ts`, `compose.ts`)

- **Per metric:**
  - `s = 1` if `lo ≤ v ≤ hi`.
  - Otherwise `s = max(0, 1 − d/tol)`, where d is the distance to the nearer bound.
  - Booleans score 1 or 0.
- **Per checkpoint:**
  - `s` = median across valid strokes (mean if there are only 1–2, with confidence halved).
  - `c = min(1, meanJointConf/0.6) × viewFactor × (velocityBased && hz==30 ? 0.5 : 1)`.
  - A view factor of 0 excludes the checkpoint.
- **V checkpoints:** `s = level/4` and `c` = 0.4 / 0.7 / 1.0 for low / medium / high confidence. `level = −1` excludes the checkpoint. The V share is capped at ≤ 35% of each sub-score's effective weight Σw·c.
- **Sub-score:** `100·Σ(w·c·s)/Σ(w·c)`, with `coverage = Σ(w·c)/Σw`. It is shown only if coverage ≥ 0.4.
- **Overall:**
  - Weighted by the skill weight matrix, renormalized over the sub-scores that are shown.
  - If total coverage < 0.5, the result is `partial` and has no number.
  - If coverage < 0.8, the overall is capped at 85.
- **Level:** 0–39 / 40–59 / 60–79 / 80–100. Hysteresis: the label moves up only when the score is ≥ 3 points over the threshold, or when the mean of the last 3 analyses of the same skill crosses it.
- **Candidates (before Claude):**
  - Weakness candidates: `s < 0.7 ∧ c ≥ 0.4`, ranked by `impact = W_sub·w·(1−s)·c`; top 6.
  - Strength candidates: `s ≥ 0.85 ∧ c ≥ 0.6`, ranked by `W_sub·w·c`; top 6.
  - Rule and injury flags are excluded from both lists and become badges.

### 6.5 Postgres (migrations; `text` + `CHECK` instead of enums; RLS on every table; `(select auth.uid())` in policies)

**Tables (`public`):**

| Table | Key columns |
|---|---|
| `profiles` | `id` PK → auth.users ON DELETE CASCADE, `display_name`, `locale` (vi/en), `preferred_sport`, `skill_level`, `handedness`, `age_band` ('13_15','16_plus'), `guardian_consent` bool, `ai_consent_version`, `ai_consent_at`, timestamps. Created by trigger `handle_new_user()` |
| `analyses` | `id` uuid PK (client-generated), `user_id` → profiles CASCADE, `sport`, `skill`, `camera_view` (side/behind/front/diagonal), `context`, `subject` (self/other), `subject_consent` (CHECK: other ⇒ true), `language`, `handedness`, `status` (prepared/queued/processing/succeeded/rejected/failed), `failure_code`, `kind` (basic/standard), `model`, `effort`, `algo_version`, `rubric_version`, `prompt_version`, `schema_version`, `analysis_hz`, `video_meta` jsonb, `quality` jsonb, `prepared` jsonb (strokes, checkpoint table, candidates, frame plan, warnings), `frame_count`, `attempt_count`, `next_attempt_at`, `locked_at`, `created_at`, `completed_at`. Indexes: (user_id, created_at desc); partial index on status in (queued, processing) |
| `analysis_results` | `analysis_id` PK → analyses CASCADE, `user_id`, `sport`, `skill`, `overall_score` smallint null, `level`, `coverage` real, `sub_scores` jsonb, `result` jsonb (coach-result.v1), `raw_output` jsonb, `created_at`. Index (user_id, sport, skill, created_at) |
| `drill_logs` | `id`, `user_id`, `analysis_id` CASCADE, `drill_id`, `done_on` date; UNIQUE(user_id, analysis_id, drill_id, done_on) |
| `feedback` | (`analysis_id`, `user_id`) PK, `rating` ∈ {−1, 1}, `comment` ≤ 500 |
| `plan_limits` | `tier` PK ('free','premium','trial'), `analyses_per_period` int, `period` ('month'/'trial'), `default_kind`, `first_ever_kind` (free: 'standard'), `max_in_flight` int, `features` jsonb `{progress, full_report}` |
| `model_routes` | `kind` PK, `model`, `effort`, `max_tokens`, `timeout_ms`, `use_fallbacks` bool. Seed: basic → `claude-haiku-5-5` / medium / 12000 / 90000 / false; standard → `claude-sonnet-5-5` / medium / 12000 / 180000 / true |
| `entitlements` | `user_id` PK, `tier`, `is_trial`, `product_id`, `expires_at`, `will_renew`, `billing_issue`, `source`, `updated_at` |
| `app_store_subscriptions` | `original_transaction_id` PK, `user_id` null → ON DELETE SET NULL, `app_account_token` uuid, `environment` (Production/Sandbox/Xcode), `product_id`, `status` smallint (1 active, 2 expired, 3 billing retry, 4 grace, 5 revoked), `auto_renew`, `expires_at`, `grace_expires_at`, `is_trial`, `revoked_at`, `renewal_info` jsonb, `transaction_info` jsonb, `last_verified_at` |
| `usage_counters` | (`user_id`, `period_key`) PK, where period_key is 'YYYY-MM' in Asia/Ho_Chi_Minh, `trial:<origTxId>` or `lifetime`; `used` int |
| `quota_ledger` | `analysis_id` PK, `user_id`, `period_key`, `kind`, `state` (reserved/committed/refunded), timestamps |

**`private` schema** (not exposed; service role only):
- `appstore_notifications` (notification_uuid PK, type, subtype, environment, original_tx, payload, processed_at, status, error)
- `apple_auth_tokens` (user_id PK, ciphertext, created_at)
- `llm_calls` (analysis_id, model_requested, model_served, effort, input_tokens, output_tokens, cache_read, cache_write, cost_usd, latency_ms, stop_reason, request_id, attempt, error)
- `daily_spend` (day PK in ICT, cost_usd)
- `audit_log`

**SQL functions** (`SECURITY DEFINER SET search_path=''`, executable only by service_role unless noted):

| Function | Behaviour |
|---|---|
| `current_tier(uid)` | Returns 'premium' when the entitlement is premium and `expires_at > now()`; returns 'trial' when that holds and `is_trial`; otherwise 'free' |
| `reserve_quota(uid, analysis_id) → jsonb` | Idempotent per analysis. Locks the counter with `FOR UPDATE`. Picks the kind: free + lifetime unused → standard (marks lifetime); free → basic; premium/trial → standard. Returns `{ok, kind, remaining, resets_at}` or `{ok:false, code:'quota_exceeded', …}` |
| `commit_quota(analysis_id)`, `refund_quota(analysis_id)` | Idempotent; refund decrements `used` |
| `quota_status()` | Authenticated caller; uses `auth.uid()`. Returns `{tier, used, limit, resets_at, firstAnalysisBonus, features}` |
| `get_progress(p_sport, p_skill)` | `SECURITY INVOKER`, authenticated. Raises if the tier is free. Returns (analysis_id, created_at, overall, sub_scores) |
| `private.recompute_entitlement(uid)` | Premium if any linked subscription has status ∈ {1, 4}, `coalesce(grace_expires_at, expires_at) > now()`, and no revocation |
| `claim_analysis(id)`, `claim_stale(limit)` | `UPDATE … RETURNING`; zero rows means another worker owns it |

**RLS:**
- `profiles`: select and update own; column grants limit updates to the profile and consent fields.
- `analyses`: select and delete own; no insert or update from clients.
- `analysis_results`: select own.
- `drill_logs`: select, insert and delete own, with check.
- `feedback`: insert and select own.
- `plan_limits`: select for all.
- `entitlements`, `app_store_subscriptions`, `usage_counters`: select own.
- `model_routes`, `quota_ledger`, `private.*`: no client access.

**Cron migration** (`…700_cron.sql`, not applied by the Linux runner):
- pg_cron `*/2 * * * *` → `net.http_post(cron, {task:'sweep'})`.
- `17 20 * * *` UTC (03:17 ICT) → `{task:'daily'}`.
- `x-cron-secret` is read from Vault.

### 6.6 Storage

| Bucket | Access | Limits | Paths | Policies |
|---|---|---|---|---|
| `analysis-inputs` | private | 2 MB; `image/jpeg` | `{uid}/{analysisId}/frames/F1..F9.jpg` | Authenticated users may INSERT, SELECT and DELETE where `(storage.foldername(name))[1] = (select auth.uid())::text` |
| `analysis-derived` | private | 2 MB; `application/json` | `{uid}/{analysisId}/pose.raw.json`, `pose.clean.json` | Writes by service role only; owner may SELECT and DELETE own folder |

Retention: key frames 30 days (daily cron). Pose JSON is kept until the user deletes the analysis or the account.

---

## 7. Data contracts

Each contract is a Zod schema in `_shared/contracts`. `scripts/gen-schemas.ts` exports it to `shared/schemas/*.json`. Deno tests validate the fixtures, and Swift tests decode the same fixtures.

### 7.1 `pose.v1` (body of `POST /analyze/prepare`)

```json
{
  "schema": "pose.v1",
  "analysisId": "7c2d…-uuid",
  "client": { "app": "1.0.0", "build": "42", "os": "iOS 18.6", "device": "iPhone16,1",
              "poseApi": "VNDetectHumanBodyPoseRequest", "algo": "coachcore-1.0.0" },
  "session": { "sport": "badminton", "skill": "bd.clear_fh", "handedness": "right", "level": "beginner",
               "cameraView": "side", "context": "drill", "subject": "self", "subjectConsent": false,
               "language": "vi", "goal": "" },
  "video": { "source": "recorded", "durationMs": 47210, "segment": { "startMs": 12000, "endMs": 32000 },
             "srcFps": 59.94, "analysisHz": 60, "display": { "w": 1920, "h": 1080 }, "mirrored": false },
  "quality": { "framesTotal": 1200, "framesWithTarget": 1164, "meanLimbConf": 0.71, "playerHeightFrac": 0.38,
               "trackResets": 0, "ambiguousAtMs": [] },
  "track": {
    "jointOrder": ["nose","lEye","rEye","lEar","rEar","neck","lSho","rSho","lElb","rElb","lWri","rWri",
                   "root","lHip","rHip","lKne","rKne","lAnk","rAnk"],
    "t":    [12000, 12017],
    "kp":   [[512,233,91, 0,0,0, "…57 ints per frame: x,y ∈ 0..1000 (CFS, top-left), c ∈ 0..100; 0,0,0 = missing"]],
    "bbox": [[430,180,170,560]],
    "flags":[0]
  }
}
```

**Rules:**
- `t` is asset-timeline ms, strictly increasing.
- `kp.length == t.length == bbox.length == flags.length`.
- `flags` bits: 1 = coasted, 2 = reacquired.
- Size ≤ 1.2 MB. `goal` ≤ 200 characters.
- The server checks: `subject=other` ⇒ `subjectConsent=true`; the skill belongs to the sport; `analysisHz ∈ {30, 60}`; the segment is 3–30 s.

### 7.2 `prepare-response.v1`

```json
{ "schema": "prepare.v1", "analysisId": "…", "status": "prepared",
  "warnings": ["view_mismatch:behind", "fps_low", "skill_mismatch_suspected"],
  "handednessSuggestion": null,
  "strokes": [ { "id": 1, "tStart": 13420, "tContact": 13910, "tEnd": 14300,
                 "phases": { "ready": 12900, "bsEnd": 13760, "contact": 13910, "ftStop": 14120 },
                 "quality": 0.82, "role": "best" } ],
  "frameRequests": [ { "frameId": "F1", "strokeId": 1, "phase": "ready", "tMs": 12900,
                       "crop": { "x": 0.38, "y": 0.09, "w": 0.33, "h": 0.62 } },
                     { "frameId": "F9", "strokeId": 1, "phase": "overview", "tMs": 13910, "crop": null } ],
  "maxLongEdge": 768,
  "cleanTrackPath": "{uid}/{id}/pose.clean.json",
  "quota": { "tier": "free", "remaining": 2, "nextKind": "standard", "resetsAt": "2026-11-01T00:00:00+07:00" } }
```

The rejection form is HTTP 422 `{ "code": "no_strokes_detected|player_too_small|low_visibility|invalid_payload", "tips": ["camera.tip.full_body", …] }`. The tip values are String Catalog keys.

### 7.3 Claude output: `coach.v1`

`output_config.format.schema`, generated from Zod. It uses no numeric or length constraints, `additionalProperties:false` everywhere, all fields required, and no unions.

```json
{
 "type":"object","additionalProperties":false,
 "required":["schema_version","language","input_check","visual_checkpoints","summary","strengths","weaknesses","improvements","stroke_notes","safety_notes","not_assessable","recording_tips"],
 "properties":{
  "schema_version":{"type":"string","enum":["coach.v1"]},
  "language":{"type":"string","enum":["vi","en"]},
  "input_check":{"type":"object","additionalProperties":false,
   "required":["is_assessable","sport_matches","skill_matches","subject_visibility","issues","note"],
   "properties":{"is_assessable":{"type":"boolean"},"sport_matches":{"type":"boolean"},"skill_matches":{"type":"boolean"},
     "subject_visibility":{"type":"string","enum":["good","partial","poor"]},
     "issues":{"type":"array","items":{"type":"string","enum":["no_person","wrong_person","subject_cut_off","too_dark","motion_blur","too_far","occlusion","wrong_sport","wrong_skill","camera_angle_limits","other"]}},
     "note":{"type":"string"}}},
  "visual_checkpoints":{"type":"array","items":{"type":"object","additionalProperties":false,
   "required":["checkpoint_id","level","confidence","frame_ids","note"],
   "properties":{"checkpoint_id":{"type":"string","enum":["<generated: every V checkpoint id, both sports>"]},
     "level":{"type":"integer","description":"0-4 per anchors; -1 = not assessable"},
     "confidence":{"type":"string","enum":["low","medium","high"]},
     "frame_ids":{"type":"array","items":{"type":"string"}},"note":{"type":"string"}}}},
  "summary":{"type":"string","description":"2-3 sentences, encouraging"},
  "strengths":{"type":"array","items":{"$ref":"#/$defs/Strength"},"description":"1-3"},
  "weaknesses":{"type":"array","items":{"$ref":"#/$defs/Weakness"},"description":"1-3, most impactful first"},
  "improvements":{"type":"array","items":{"$ref":"#/$defs/Improvement"},"description":"one per weakness, priority 1..n"},
  "stroke_notes":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["stroke_id","note"],
     "properties":{"stroke_id":{"type":"integer"},"note":{"type":"string"}}}},
  "safety_notes":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["kind","message"],
     "properties":{"kind":{"type":"string","enum":["warmup","load","technique_risk","see_professional"]},"message":{"type":"string"}}}},
  "not_assessable":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["aspect","how_to_capture"],
     "properties":{"aspect":{"type":"string"},"how_to_capture":{"type":"string"}}}},
  "recording_tips":{"type":"array","items":{"type":"string"}}
 },
 "$defs":{
  "Evidence":{"type":"object","additionalProperties":false,"required":["stroke_id","t_ms","frame_id","metric_key","observation"],
   "properties":{"stroke_id":{"type":"integer","description":"-1 = whole clip"},"t_ms":{"type":"integer"},
     "frame_id":{"type":"string","description":"F1..F9 or \"\""},"metric_key":{"type":"string","description":"checkpoint id from <checkpoints> or \"\" if visual"},
     "observation":{"type":"string"}}},
  "Strength":{"type":"object","additionalProperties":false,"required":["checkpoint_id","title","detail","evidence"],
   "properties":{"checkpoint_id":{"type":"string","enum":["<generated: all checkpoint ids>"]},"title":{"type":"string"},
     "detail":{"type":"string"},"evidence":{"type":"array","items":{"$ref":"#/$defs/Evidence"}}}},
  "Weakness":{"type":"object","additionalProperties":false,"required":["checkpoint_id","fault_id","severity","title","detail","why_it_matters","evidence"],
   "properties":{"checkpoint_id":{"type":"string","enum":["<all checkpoint ids>"]},"fault_id":{"type":"string","enum":["<all fault ids>","none"]},
     "severity":{"type":"string","enum":["high","medium","low"]},"title":{"type":"string"},"detail":{"type":"string"},
     "why_it_matters":{"type":"string"},"evidence":{"type":"array","items":{"$ref":"#/$defs/Evidence"}}}},
  "Improvement":{"type":"object","additionalProperties":false,"required":["priority","fault_id","title","how_to_fix","cues","drill_ids","goal"],
   "properties":{"priority":{"type":"integer"},"fault_id":{"type":"string","enum":["<all fault ids>","none"]},"title":{"type":"string"},
     "how_to_fix":{"type":"string"},"cues":{"type":"array","items":{"type":"string"}},
     "drill_ids":{"type":"array","items":{"type":"string"},"description":"1-2 ids from the fault's allowed list"},"goal":{"type":"string"}}}
 }
}
```

- Evidence intentionally has **no numeric fields** from the model. The server fills `observed` and `target` from the metric table using `metric_key`, so numbers cannot be hallucinated.
- `drill_ids` are strings validated against the catalog, so drill catalog edits do not change the schema.

### 7.4 Stored result: `coach-result.v1`

The app renders only this document.

```ts
{ schema:"coach-result.v1", analysisId, sport, skill, narrativeLanguage:"vi"|"en", createdAt, status:"succeeded"|"rejected",
  rejection: { code, tips:string[] } | null,
  overall: { score:number|null, level:"beginner"|"improving"|"intermediate"|"advanced"|null, coverage, partial:boolean },
  subScores: [{ key:SubScore, score:number|null, coverage, confidence:"high"|"medium"|"low", name:{vi,en} }],
  checkpoints: [{ id, subscore, assess, s, c, valueText, targetText, perStroke:[{strokeId, value}], name:{vi,en}, joints:string[] }],
  strengths:  [{ checkpointId, title, detail, evidence: Evidence[] }],
  weaknesses: [{ checkpointId, faultId, severity, title, detail, whyItMatters, cue:{vi,en}, evidence: Evidence[] }],
  plan: [{ priority, faultId, title, howToFix, cues:string[], goal, target:{ metricKey, current, goal },
           drills:[{ id, title:{vi,en}, steps:{vi:string[],en:string[]}, dose:{sets, reps?, seconds?} }] }],
  strokes: [{ id, tStart, tContact, tEnd, phases, role:"best"|"worst"|null, note }],
  badges: { rule:[{ checkpointId, verdict:"likely_ok"|"check"|"likely_fault", text:{vi,en} }], injury:[{ checkpointId, text:{vi,en} }] },
  safety:[{kind,message}], notAssessable:[{aspect,howToCapture}], recordingTips:string[], summary,
  meta:{ model, kind, promptVersion, rubricVersion, algoVersion, schemaVersion } }
// Evidence = { strokeId, tMs, frameId, metricKey, observed /*server*/, target /*server*/, observation /*Claude*/, joints:string[] }
```

---

## 8. Claude integration

### 8.1 Model per tier (`model_routes`; switchable without a deploy)

| Kind | Who | Model | Effort | max_tokens | Timeout | Fallbacks |
|---|---|---|---|---|---|---|
| `basic` | Free tier (3/month) | `claude-haiku-5-5` | `medium` | 12000 | 90 s | none (not supported on Haiku 5.5) |
| `standard` | Premium, trial, and the free user's first-ever analysis | `claude-sonnet-5-5` | `medium` (set explicitly; the default is `high`) | 12000 | 180 s | `fallbacks:"default"` + beta `server-side-fallback-2026-07-01` (enabled by default) |

**Request rules:**
- No `temperature`, `top_p` or `top_k`.
- No `thinking` field, so adaptive thinking (the default) applies.
- No prefill and no `tool_choice`.
- SDK `maxRetries: 0`; the job runner owns retries.
- Response blocks are read by `type`, skipping `thinking` blocks.
- Opus 5.5 is unused at launch. If evals show Sonnet falling short, switch the `standard` route at about $0.18 per analysis.

### 8.2 Request layout (`build_request.ts`)

The call goes through `client.beta.messages.create` (`npm:@anthropic-ai/sdk@0.131.0`), the same path for both models:

```ts
{ model, max_tokens, betas?: ["server-side-fallback-2026-07-01"], fallbacks?: "default",
  system: [
    { type:"text", text: BASE_SYSTEM_V1 },                                        // ~1.8K tok, identical for all requests
    { type:"text", text: RUBRIC_TEXT[sport], cache_control:{ type:"ephemeral" } } // ~5K tok; cache prefix per (model × sport) = 4
  ],
  messages: [{ role:"user", content: [
    // images FIRST, each preceded by a label
    { type:"text", text:"F3 · stroke 1 (best) · phase=contact · t=13.91s" }, { type:"image", source:{ type:"base64", media_type:"image/jpeg", data } },
    /* … F1–F9 … */
    { type:"text", text: userText }      // XML blocks below, last line: "Output language: vi"
  ]}],
  output_config: { effort, format: { type:"json_schema", schema: COACH_OUTPUT_V1 } } }
```

**`BASE_SYSTEM_V1` sections:**
1. **Role:** a patient badminton/pickleball technique coach for beginners and improvers.
2. **Inputs:** cropped, face-blurred frames labelled F#; a checkpoint table computed from 2D pose, with value, target, s (0–1) and c (reliability); candidate lists.
3. **Tasks:**
   1. `input_check`.
   2. Judge only the listed visual checkpoints with the anchors; use −1 rather than guessing.
   3. Pick 1–3 strengths and 1–3 weaknesses **only** from `<candidates>` or from the visual judgments.
   4. One improvement per weakness, using drills only from that fault's allowed list.
   5. Summary, generic safety notes, not-assessable items and recording tips.
4. **Grounding:**
   - Never contradict the measured values.
   - Cite `metric_key` and/or `frame_id` in every evidence item.
   - Do not invent numbers.
   - Say "có thể/likely" when c < 0.5.
   - Grip, racket face and pronation are visible only in frames; treat them as low confidence.
5. **Safety:** no diagnosis and no medical terms. Injury-related advice is phrased as "nếu đau, hãy hỏi HLV/chuyên gia".
6. **Style:**
   - Warm second person ("bạn"), one cue per sentence.
   - Length limits: summary ≤ 3 sentences, detail ≤ 2, cues ≤ 8 words.
   - Keep the English words dink, drop, drive, reset.
   - Includes the VI glossary.
7. **Language:** all free text is written in the "Output language" given at the end of the user message.

**`RUBRIC_TEXT[sport]`:**
- Generated deterministically from the rubric JSON.
- Contents: skills and phases; every checkpoint (id, EN description, tag, views); V anchors 0–4; faults (id, cue in EN) with their allowed drill IDs and one-line EN descriptions; sub-score definitions; the sport glossary (VI↔EN).

**`userText`:**
- `<session>`: sport, skill, level, handedness, user view vs `viewGuess`, context, subject, fps and analysisHz, stroke count.
- `<quality>`.
- `<checkpoints>`: rows `id | name | value | target | s | c | tag | per-stroke values`.
- `<strokes>`: phase times and key values.
- `<candidates>`: weakness and strength rows with `fault_id`, `impact`, `allowed_drills`.
- `<visual_to_judge>`.
- `<user_goal>`: declared as data, ≤ 200 characters.
- Last line: `Output language: vi|en`.

**Caching rules:**
- The system blocks are byte-identical across languages and users; a snapshot test asserts this.
- No dates, IDs or flags appear in `system`.
- The schema never varies per tier. A schema or rubric change is a deploy-time version bump that invalidates the cache once.
- Default TTL is 5 minutes.
- `usage.cache_read_input_tokens` is logged per call. Switch to `ttl:"1h"` only if logs show most start-to-start gaps per prefix fall between 5 and 60 minutes.

### 8.3 `runAnalysis` outcomes (`run.ts`)

| Outcome | Action |
|---|---|
| Success | Parse the `text` block → `CoachOutputV1.safeParse` → postprocess |
| `stop_reason: "refusal"` (Haiku, or Sonnet after its fallback also refused) | status `failed`, code `model_refusal`, refund quota |
| `max_tokens` | Retry once with 1.5× `max_tokens` |
| Parse or validation failure | Retry once; on the second failure, `failed / bad_output`, refund |
| 429 / 529 / 5xx / timeout | Back to `queued` with `next_attempt_at = now + 30 s·2^attempt`; after 3 attempts, `failed / upstream_unavailable`, refund |
| 400 | `failed / bad_request`, refund, error log |

Every attempt writes `private.llm_calls`. Cost is computed from the four usage meters at the §8.7 prices and added to `daily_spend`.

### 8.4 Post-processing (`postprocess.ts`, pure)

1. If `input_check.is_assessable=false`, or `sport_matches=false`, or `skill_matches=false` together with `subject_visibility='poor'`: set status `rejected` with localized tips, **refund the quota**, and still store a result whose `rejection` field tells the user how to re-record.
2. **Visual checkpoints:**
   - Keep only IDs that belong to this skill's V list.
   - Clamp the level to −1..4.
   - Drop `frame_ids` that were not sent.
3. **Grounding filter:**
   - A strength is kept only if it is a strength candidate, or a V item with level ≥ 3 and confidence ≥ medium.
   - A weakness is kept only if it is a weakness candidate, or a V item with level ≤ 1 and confidence ≥ medium.
   - An evidence item is kept only if `metric_key` is in the checkpoint table and/or `frame_id` was sent, and `stroke_id` is valid. `t_ms` is snapped to that stroke's phase time.
   - The server fills `observed`, `target` and `joints`.
4. **Deterministic override:** if the top weakness candidate has c ≥ 0.6, its impact is ≥ 1.5× the next candidate's, and Claude omitted it, insert it with catalog text (title, cue, why) in the narrative language and the default drill. This is logged as `override`.
5. **Improvements:** at most 3, re-sorted by priority. `drill_ids` must be in `fault.drills`; otherwise use `defaultDrill`. Attach localized drill content from the catalog.
6. **Medical filter** (EN and VI regexes, e.g. `diagnos|tendinitis|tear|chẩn đoán|viêm gân|rách dây chằng|thoát vị`): a hit replaces the text with a generic `see_professional` note and logs `flag_medical`.
7. **Compose scores** (§6.4) with the V levels; compute level and hysteresis from the last 3 results; attach rule and injury badges.
8. Upsert `analysis_results` (`ON CONFLICT DO NOTHING`), then `commit_quota`, then status `succeeded`.

### 8.5 Language handling

- `analysis.language` is the app language at submit time.
- Claude writes all narrative fields in that language.
- Catalog-sourced text (sub-score, checkpoint, fault and drill names, cues, badges) is stored as `{vi, en}` and follows the current UI language.
- If the UI language later differs from `narrativeLanguage`, Results shows "Nhận xét được viết bằng tiếng Anh". Translation is v1.1.

### 8.6 Hallucination controls (summary)

- Numbers come only from the server.
- IDs are enums.
- Every finding must come from the candidates or a visual judgment with confidence ≥ medium.
- Evidence is validated.
- `not_assessable` is preferred over guessing.
- The deterministic override covers the most important issue.
- Prompt, rubric, schema and model versions are stored with every result.

### 8.7 Cost estimate (per analysis, Vietnamese output)

Verified prices per MTok:

| Model | Input | Output | Cache write (5 min) | Cache read |
|---|---|---|---|---|
| Haiku 5.5 (prompts ≤ 100K) | $0.10 | $0.50 | $0.125 | $0.01 |
| Sonnet 5.5 | $2 | $10 | $2.50 | $0.20 |
| Opus 5.5 | $4 | $20 | $5 | $0.20 |

Assumptions:
- Cached system ≈ 7K tokens.
- Uncached input ≈ 9K tokens: 9 frames × about 588, plus about 3.5K of tables and context.
- Output ≈ 3–3.5K tokens of JSON, plus thinking (about 1.5K at Haiku medium, about 2.5K at Sonnet medium).

| Model | Warm cache | Cold cache | ≈ VND (at 26,000₫/USD) |
|---|---|---|---|
| Haiku 5.5 | 0.9K×0.10 + 7K×0.01 + 5K×0.50 ≈ **$0.0035** | ≈ $0.0044 | ≈ 100₫ |
| Sonnet 5.5 | 9K×2 + 7K×0.20 + 6K×10 ≈ **$0.079** | ≈ $0.095 | ≈ 2,100–2,500₫ |
| Opus 5.5 (reference only, unused) | 9K×4 + 7K×0.20 + 7K×20 ≈ $0.18 | ≈ $0.21 | ≈ 4,700₫ |

The Haiku warm figure counts 9K uncached input tokens (9K × $0.10/MTok = $0.0009); "0.9K×0.10" in the table is that same $0.0009.

**Before trusting these numbers:** run `scripts/smoke-claude.ts` (one call per model with a fixture). It costs money, so it needs the user's approval. Allow ±30% for the Haiku 5.5 tokenizer.

**Spend controls:**
- A global `DAILY_BUDGET_USD` guard (starting at $30) returns 503.
- A dedicated Anthropic workspace with a monthly spend limit.
- Per-user quota and in-flight caps.
- Idempotent submit, so the same `analysisId` is never billed twice.

---

## 9. Subscriptions, quotas, pricing

### 9.1 App Store Connect

**Subscription group "Premium":**
- `com.<company>.racketcoach.premium.monthly` (1 month)
- `com.<company>.racketcoach.premium.yearly` (1 year)

**Configuration:**
- Both products at the **same level**, so switching between them is a crossgrade.
- Introductory offer: **7-day free trial on yearly only**.
- Family Sharing **off**; it cannot be turned off once enabled.
- **Billing Grace Period** on (16 days).
- **Small Business Program**: enrol (15% commission).
- Notifications V2: Production and Sandbox URLs both point to `…/functions/v1/appstore-webhook`.
- Offer Codes are reserved for coach and partner promotions (v1.1). Backend-only unlock codes are never used.

### 9.2 Pricing

Every VND price point must be confirmed in the App Store Connect picker.

| Plan | Vietnam (set manually) | US base (other storefronts auto-equalised) |
|---|---|---|
| Monthly | **79,000₫** | **$9.99** |
| Yearly | **599,000₫**, marketed as "chưa tới 50.000₫/tháng" (smaller than the billed price) | **$59.99** |

### 9.3 Quotas (server-enforced; values in `plan_limits`)

| | Free | Trial (7 days) | Premium |
|---|---|---|---|
| Analyses | 3 per calendar month (ICT), Haiku; the **first-ever** analysis uses Sonnet | 5 total, Sonnet | **20 per month**, Sonnet (fair use) |
| In-flight | 1 | 1 | 1 |
| Report | Score, sub-scores, 2 strengths, 2 weaknesses, improvement #1, overlay | Full | Full |
| Progress charts | Locked | Yes | Yes |

**Unit economics:**

| Case | Calculation |
|---|---|
| Premium worst case | 20 × $0.095 ≈ **$1.90/month** |
| Premium typical | About 6 analyses ≈ **$0.55/month** |
| VN monthly proceeds | ≈ $2.35 (79k₫ with 10% VAT included, 15% commission) |
| VN yearly proceeds | ≈ $1.48/month; heavy users lose slightly, typical users are +$0.9 |
| US proceeds | Monthly $8.49; yearly $4.25/month |

Monitor usage per product and tune `plan_limits` if yearly VN users cluster at the cap.

### 9.4 Entitlement sync flow

1. **Purchase.**
   - `SubscriptionStoreView(groupID:)` with `.inAppPurchaseOptions { _ in [.appAccountToken(userUUID)] }`.
   - Buttons: `.storeButton(.visible, for: .restorePurchases, .redeemCode, .policies)`.
   - Policy links: `.subscriptionStorePolicyDestination(url: termsURL, for: .termsOfService)` and the same for `.privacyPolicy`.
   - `.onInAppPurchaseCompletion` → `StoreService.sync`.
2. **`Transaction.updates` listener**, started at launch. Each verified transaction → `POST /verify-subscription {signedTransaction, reason}` → only on 200 → `transaction.finish()`.
3. **Launch sync** if `currentEntitlements` is non-empty but the server tier is free. **Restore**: `AppStore.sync()` → send every entitlement.
4. **Server side of `verify-subscription`:**
   - Decode the JWS without trusting it: `originalTransactionId`, `environment`, `bundleId` (must equal `APPLE_BUNDLE_ID`), `appAccountToken`.
   - `GET {host}/inApps/v1/subscriptions/{transactionId}` with an ES256 JWT (header `{alg, kid, typ}`; claims `{iss, iat, exp ≤ 60 min, aud:"appstoreconnect-v1", bid}`) on the host for that environment.
   - Decode the returned `signedTransactionInfo` and `signedRenewalInfo`; trust comes from TLS to Apple.
   - **Linking policy:**
     - Token equals the caller → link.
     - No token, and the row is unlinked or linked to a deleted user → link **only if** `jws.ts` verifies the client JWS chain against Apple Root CA G3 (WebCrypto + `@peculiar/asn1-x509`; checks the OIDs `1.2.840.113635.100.6.2.1` and `…6.11.1` and validity at `signedDate`).
     - Linked to a different live user → 409 `linked_to_other_account`.
   - Upsert `app_store_subscriptions`, `recompute_entitlement`, return `{tier, productId, expiresAt, willRenew, inGrace, billingIssue, isTrial}`.
   - `environment = "Xcode"` is accepted only when `ALLOW_XCODE_ENV=true`, which is set in the dev project only.
5. The **app gates features only on `quota_status()`** from the server. StoreKit state only drives the UI.

### 9.5 Webhook (`appstore-webhook`)

Steps:
1. Decode `signedPayload`.
2. `INSERT … ON CONFLICT (notification_uuid) DO NOTHING`; a duplicate returns 200.
3. Extract `originalTransactionId` and **re-fetch the statuses from Apple**.
4. Upsert, recompute, set `processed_at`, return 200.
5. Return 500 only on a transient database or API failure, so Apple retries.

| notificationType (subtype) | Effect |
|---|---|
| SUBSCRIBED, DID_RENEW, OFFER_REDEEMED, DID_CHANGE_RENEWAL_PREF, DID_CHANGE_RENEWAL_STATUS, PRICE_INCREASE, RENEWAL_EXTENDED, REFUND_REVERSED | Re-fetch; premium if status is 1 or 4 |
| DID_FAIL_TO_RENEW (GRACE_PERIOD) | Premium until `grace_expires_at`; `billing_issue=true` (app shows "cập nhật thanh toán") |
| DID_FAIL_TO_RENEW, GRACE_PERIOD_EXPIRED, EXPIRED | Free unless the re-fetch says active |
| REFUND, REVOKE | Free immediately, plus an audit row |
| TEST, CONSUMPTION_REQUEST, REFUND_DECLINED, others | Log only |

The daily cron calls `POST /inApps/v1/notifications/history` for the last 26 hours to catch missed notifications.

### 9.6 StoreKit configuration file

`ios/RacketCoach/Resources/Products.storekit` (JSON) contains the group "Premium" and both products with:
- prices $9.99 and $59.99 (the local test storefront);
- a 1-week free intro offer on yearly;
- `vi` and `en` display names and descriptions.

It is wired through the scheme's `storeKitConfiguration`. `check_ios_resources.py` asserts that its product IDs equal the `StoreService` constants.

---

## 10. Localization

### 10.1 Mechanics

- **`Localizable.xcstrings`**:
  - Source language `en`, plus `vi`.
  - Semantic keys such as `results.subscore.contact.title`, each with a translator comment.
  - English plurals via catalog variations (Vietnamese has none).
  - CI (`check_ios_resources.py`) fails if any key lacks a `vi` or `en` value marked "translated".
- **`InfoPlist.xcstrings`** holds `CFBundleDisplayName` and `NSCameraUsageDescription`:
  - VI: "Ứng dụng dùng camera để quay cú đánh của bạn; video được phân tích ngay trên máy và không bị tải lên."
  - EN: the same meaning.
- **In-app switch**: see D15.
  - System dialogs (camera permission, StoreKit sheets, `SubscriptionStoreView` pricing text) follow the iOS language.
  - Settings shows a note about this and a link to `UIApplication.openSettingsURLString`.
- Numbers, dates and prices use locale formatters. Prices always come from `Product.displayPrice`.
- **Server texts** come from the rubric `{vi,en}` and the String Catalog keys used for tips. Claude's narrative is in the analysis language.

### 10.2 Vietnamese terminology (app copy)

Items marked (?) need review by a native coach before launch (milestone M16).

| EN | VI | EN | VI |
|---|---|---|---|
| Overall score | Điểm tổng | Stance & Balance | Tư thế & Thăng bằng |
| Footwork | Di chuyển (bộ pháp) | Swing mechanics | Kỹ thuật vung vợt |
| Contact point | Điểm chạm cầu / Điểm chạm bóng | Follow-through | Động tác vung theo |
| Recovery | Hồi vị | Strengths / Weaknesses | Điểm mạnh / Cần cải thiện |
| Improvement plan | Kế hoạch cải thiện | Drill | Bài tập |
| Clear | Phông cầu | Smash | Đập cầu |
| Net shot | Bỏ nhỏ trên lưới | Lift | Vẩy cầu (hất cầu) |
| Low serve / high serve | Giao cầu thấp / cao sâu | Split step | Bật nhún (split step) |
| Lunge | Bước lunge (?) | Ready stance | Tư thế chuẩn bị |
| Kitchen (NVZ) | Bếp (vùng cấm vô-lê) | Volley | Vô-lê |
| Return of serve | Trả giao bóng | Third-shot drop | Drop cú thứ ba |
| Dink / drive / reset | Dink / drive / reset (kept in English) | Weight transfer | Chuyển trọng tâm |
| Racket/paddle up | Giơ vợt lên trước ngực | Not enough data | Chưa đủ dữ liệu |
| Beginner / Improving / Intermediate / Advanced | Mới bắt đầu / Đang tiến bộ / Trung cấp / Nâng cao | Not medical advice | Không phải lời khuyên y tế |

**Copy style:**
- "bạn", short imperative cues.
- Fault cards follow the pattern **Vấn đề → Cách sửa → Bài tập (3×10)**.
- Avoid literal calques.
- Never claim a DUPR or club "trình".

### 10.3 Camera guide content (`docs/camera-guide.*.md`, also in the app)

1. Landscape, on a tripod or propped up.
2. 1× lens, never 0.5×.
3. **Side view** on the racket-hand side, level with the hitting spot: 4–6 m for badminton, 3–5 m for pickleball.
4. Phone at waist-to-chest height (1–1.3 m).
5. Whole body in frame, including the racket at full reach. The player should fill ½ to ⅔ of the frame height.
6. 60 fps (Cài đặt › Camera › Quay video › 1080p HD ở 60 fps).
7. Even light, no backlight. Clothes that contrast with the background; knees visible.
8. Ideally only the player in frame; otherwise tap them in the app.
9. 5–10 repetitions of ONE stroke in 20–60 s.

The skill screen shows the recommended view for each skill.

---

## 11. Compliance checklist

| Requirement | Code / artifact | Milestone |
|---|---|---|
| **5.1.2(i)** third-party AI consent | `ConsentView` (names Anthropic/Claude, lists the data sent, retention, links); `profiles.ai_consent_version/at`; `submit` returns 403 `consent_required` when consent is missing or stale; withdraw in Settings (clears consent, blocks analyses) | M9 / M6 |
| Filming others | Session-form checkbox; DB CHECK and server 422; faces blurred in all frames; Terms clause | M11 / M12 |
| **5.1.1(v)** account deletion | Settings → confirm → `delete-account`, including SIWA revoke; subscription notice + `manageSubscriptionsSheet`; manual SIWA revoke instructions when no token exists | M8 / M15 |
| **3.1.2** paywall disclosures | `SubscriptionStoreView` (billed amount most prominent, auto-renew terms) + `.subscriptionStorePolicyDestination` Terms/Privacy + `.storeButton(.visible, for: .restorePurchases, .redeemCode, .policies)`; Restore also in Settings; trial text never larger than the price | M14 |
| **3.1.1** IAP only | StoreKit 2; no external links; promotions only via Apple Offer Codes | M14 |
| **4.8** login | Sign in with Apple beside Google, in HIG style | M9 |
| Privacy manifest | `PrivacyInfo.xcprivacy`:<br>• `NSPrivacyTracking=false`<br>• Collected (all linked, not tracking, purpose App Functionality): EmailAddress, UserID, PhotosorVideos (key frames), OtherUserContent (pose data, goal), Fitness (conservative), PurchaseHistory<br>• Accessed APIs: UserDefaults `CA92.1`, FileTimestamp `C617.1`, DiskSpace `E174.1` (free-space check before record/import)<br>• Use `ContinuousClock`, never `systemUptime`/`mach_absolute_time` (CI grep)<br>• Confirm supabase-swift and GoogleSignIn ship their own manifests | M9 |
| Usage descriptions | Only `NSCameraUsageDescription` (localized). No microphone, no photo-library keys | M9 |
| Export compliance | `ITSAppUsesNonExemptEncryption=NO` | M9 |
| No medical claims | System-prompt rule, `medical_filter.ts`, fixed injury badge text, footer "Không phải lời khuyên y tế. Dừng tập nếu đau.", App Store copy reviewed (no "prevent injury") | M5 / M13 / M15 |
| Age | Onboarding age band: < 13 blocked; 13–15 guardian checkbox; no Kids category | M9 |
| **2.1** reviewability | Demo mode (offline sample results); bundled sample clips usable in the real flow; review notes (sign in with Apple, use the sample clip, sandbox paywall) | M15 |
| App Privacy label | `docs/appstore/privacy-label.md` matching the manifest | M15 |
| Data minimisation and retention | No video upload; face blur; key frames deleted after 30 days; pose JSON deleted with the analysis or account; logs without PII | M6 / M12 |
| Vietnam PDPL | VI privacy notice and consent, never pre-ticked; access/delete rights in-app; `docs/legal/pdpl-ctia-checklist.md` (cross-border transfer impact assessment for Supabase Singapore and Anthropic US, to be filed with the Ministry of Public Security). **Needs local counsel**, outside the code | M15 |

---

## 12. Build order (milestones)

Each milestone is small enough to verify. "Linux" means it is verified in this container; "Mac" means the user verifies it.

| # | Milestone | Done when |
|---|---|---|
| M0 | Monorepo scaffold: tree, `deno.json` pins, `config.toml`, `project.yml` skeleton (empty SwiftUI app + CoachCore with one test), `scripts/check.sh`, README | Linux: `deno check`, `deno lint`, `deno fmt --check` pass; `check.sh` runs. Mac: `xcodegen generate && xcodebuild -scheme RacketCoach build`, `swift test` (CoachCore) |
| M1 | Contracts: Zod pose.v1, prepare.v1, coach-output.v1, coach-result.v1; `gen-schemas.ts`; seed fixtures | Linux: fixtures validate; the generated JSON schemas match the committed ones; coach-output schema has no unsupported keywords (minimum, maximum, minLength, maxLength, non-false additionalProperties) |
| M2 | Rubric JSON for 12 skills + shared ready/split + about 50 drills, bilingual; `load.ts`; rubric text generator | Linux: integrity tests pass; `RUBRIC_TEXT` snapshot; token count estimate ≥ 512 |
| M3a | Engine: normalize, T, cleanup (swap fix, Hampel, Hermite, SG), synthetic generator | Linux: SG/Hampel unit tests against known signals; a synthetic swing with injected dropouts and L/R swaps is restored within tolerance |
| M3b | Segmentation and phases | Linux: synthetic clips with known contacts → contact error ≤ 1 frame, recall 100% and precision ≥ 95% on the synthetic set |
| M3c | Metric registry, checkpoints, scoring, candidates | Linux: hand-computed golden values per metric; scoring formula tests; coverage and cap rules |
| M3d | Ranking, frame plan, clean track, `prepare.ts`; `bench-engine.ts` | Linux: golden prepare responses; 30 s @ 60 Hz runs in < 300 ms |
| M4 | SQL migrations 100–600, seed | Linux: `supabase/tests/sql/run.sh` (temporary PG16 cluster + shim) applies cleanly; assertions on RLS isolation between two users, the quota reserve/commit/refund state machine and its idempotency, `current_tier` expiry, the `subject_consent` check, cascades |
| M5 | Claude module: base prompt, request builder, client wrapper with injected `fetch`, run outcomes, postprocess, medical filter, compose | Linux: system prompt byte-identical for vi and en; request snapshot; mocked refusal, max_tokens, 529 and invalid-ID cases → correct state transitions; grounding filter and override tests; `replay.ts --mock` produces a valid coach-result.v1 |
| M6 | `analyze` (prepare/submit/runAnalysis) and `cron`, behind DB/Storage interfaces; cron migration 700 | Linux: handler tests with in-memory fakes (idempotent submit, 402/403/429/503, stale-lock re-claim). Mac (optional): `supabase start`, `functions serve`, curl end to end |
| M7 | Apple: `jwt.ts`, `api.ts` (mockable), `jws.ts` (decode + chain verify), `linking.ts`, `verify-subscription`, `appstore-webhook` | Linux: openssl test chain → verification passes and tampered chains fail; webhook routing table tests; linking-policy matrix; duplicate notification ignored |
| M8 | `apple-auth-exchange`, `delete-account`, `crypto.ts` | Linux: mocked Apple endpoints; deletion is idempotent on re-run; storage paging (2,500 objects → 3 batches) |
| M9 | iOS shell: navigation, L10n infra, String Catalogs, Info/xcprivacy/entitlements, Supabase provider, Auth (Apple/Google/email OTP), onboarding, consent, profile sync | Linux: `check_ios_resources.py` passes. Mac: build; sign in with all three methods on a device; VI/EN switch updates the UI |
| M10 | CoachCore: models, orientation, scheduler, tracker, quality, payload/quantizer, crop, overlay timeline, result decoding | Mac: `swift test` passes against `shared/fixtures` |
| M11 | Capture: guide, recorder (1080p60, no audio), PhotosPicker and Files import, trimmer, session form | iPhone: record 60 fps (check `nominalFrameRate`); import from Photos (HEVC, iCloud) and Files; trim 3–30 s without re-encode |
| M12 | Pipeline: FrameReader, VisionPoseEstimator, player select, tracking, rate benchmark, prepare, key frames (crop, face blur, JPEG), upload, submit, poll; debug "Export pose JSON" | iPhone: sample clip end to end within budget. **Loop-back:** the exported device pose JSON is copied into `shared/fixtures/pose/device_*.json` and replayed on Linux with `replay.ts` (M3 tests extended) |
| M13 | Results UI (ring, sub-scores, findings, evidence → overlay player seek/highlight, plan, badges, free gating, feedback), History, Progress chart, drill logs | Simulator: previews driven by `shared/fixtures/results/*`; iPhone: overlay sync at 0.25×, frame step |
| M14 | StoreKit: `Products.storekit`, `StoreService`, paywall, restore, manage, quota chip, 402 → paywall | Mac: Xcode StoreKit testing (purchase, renew, expire, refund, ask-to-buy) against a dev Supabase project with `ALLOW_XCODE_ENV=true`. Then sandbox on device: webhook received, entitlement row updated |
| M15 | Settings (language, consent withdraw, storage, delete account, legal), demo mode, docs (camera guide, privacy, terms, ai-disclosure, metadata VI/EN, review notes, privacy label, CTIA checklist) | Run the §11 checklist on a device. Delete-account removes all rows and storage (verified with SQL) |
| M16 | Calibration and beta: at least 10 labelled clips per skill (target 30), threshold tuning, `eval.ts` (MAE vs coach ≤ 10; test–retest overall SD ≤ 3), VI copy review by a coach, live smoke test (approved), TestFlight | TestFlight build; eval report in `docs/rubric/calibration.md` |

---

## 13. Verification

### 13.1 In this Linux container (`scripts/check.sh`)

```bash
npx -y deno@2.9.6 fmt --check supabase scripts && npx -y deno@2.9.6 lint supabase scripts
npx -y deno@2.9.6 check supabase/functions/*/index.ts scripts/*.ts
npx -y deno@2.9.6 test -A supabase/tests                      # engine, rubric, contracts, claude (mocked), apple, functions
npx -y deno@2.9.6 run -A scripts/gen-schemas.ts --check       # schemas in sync with Zod
npx -y deno@2.9.6 run -A scripts/replay.ts shared/fixtures/pose/synthetic_bd_clear_60hz.json \
      --mock-claude shared/fixtures/claude/bd_clear_ok.json   # prints strokes, checkpoints, prompt token estimate, final result
npx -y deno@2.9.6 run -A scripts/bench-engine.ts
bash supabase/tests/sql/run.sh                                # initdb in scratch dir, pg_ctl -p 54329, shim + migrations 100–600, assertions
python3 -I scripts/check_ios_resources.py                     # xcstrings vi/en complete, xcprivacy plist valid, storekit IDs, Info keys, banned APIs grep
bash scripts/gen-test-certs.sh                                # used by apple/jws tests
```

- `tests/sql/shim.sql` creates the Supabase surface:
  - roles `anon`, `authenticated`, `service_role`;
  - schemas `auth` and `storage`, `auth.users`, `auth.uid()` reading `request.jwt.claims`;
  - `storage.objects`, `storage.buckets`, `storage.foldername()`.
  
  The local server is PG16; Supabase runs 15/17. Re-validate on the Mac with `supabase db reset` (Docker).
- **Not possible here:** Swift compile or tests (no toolchain; download blocked), `supabase start` or `db lint` (no Docker daemon), deployed edge runtime behaviour.
- **Live Claude smoke test** (`scripts/smoke-claude.ts`) needs `ANTHROPIC_API_KEY` and **explicit approval**, because it spends money. It sends one fixture call per model twice and prints `input_tokens`, `output_tokens`, `cache_creation_input_tokens` and `cache_read_input_tokens`. The second call must show a cache read.

### 13.2 What the user must verify on Mac and iPhone

1. `brew install xcodegen`, then `cd ios && xcodegen generate`, then build and run on the simulator and a device. Then `swift test --package-path ios/Packages/CoachCore`.
2. Supabase:
   - Create the Pro project in ap-southeast-1 and link it (`supabase link`).
   - `supabase db push`.
   - Set secrets: `ANTHROPIC_API_KEY`, `APPLE_*`, `TOKEN_ENC_KEY`, `CRON_SECRET` (also stored in Vault), `DAILY_BUDGET_USD`, `ALLOW_XCODE_ENV` (dev only), `APPLE_API_HOST_*`.
   - `supabase functions deploy`.
   - Configure Apple, Google and email (custom SMTP) auth providers.
   - **Day-one spike:** deploy `jws.ts` and send Apple's test notification; check WebCrypto P-384 works in the hosted runtime.
3. StoreKit:
   - `Products.storekit` testing in Xcode against the dev backend.
   - App Store Connect products, prices (confirm the VND price points), trial, grace period, Small Business Program, notification URLs.
   - Sandbox purchase, restore, crossgrade, refund (via the StoreKit test environment), webhook rows.
4. **Real-device pose quality** on an older and a recent device (e.g. iPhone 11-class and A17+):
   - ms per frame and the chosen rate;
   - player height;
   - L/R label behaviour in behind view;
   - mirrored files;
   - imported slow-motion clips;
   - background interruption and resume;
   - thermal behaviour on 30 s at 60 Hz.
5. Overlay sync accuracy; face blur coverage, including profile faces; Vietnamese text rendering and truncation.
6. TestFlight with 5–10 real VN players and one coach; collect `feedback` rows.

---

## 14. Risks and mitigations

| Risk | Mitigation |
|---|---|
| **2D pose accuracy from one phone camera** (wrist lost at smash speed, foreshortening) | Prefer 60 fps (rate chooser); flag interpolated contacts; per-checkpoint confidence with view and fps factors; coverage rules hide sub-scores below 0.4; partial-analysis mode; calibration set (M16) |
| **Camera angle variance** | Per-skill recommended view and guide; user-declared view drives view factors (0 excludes); `viewGuess` mismatch warning; coverage preview in the form |
| **No racket or shuttle detection** (face angle, grip, outcome) | Tagged V or N; Claude judges V items from frames with `-1` allowed; N items listed under "Không đánh giá được từ video"; detector work deferred to v2 |
| **LLM hallucination** | Code owns numbers; enum IDs; candidate-only findings; evidence validation; server-filled values; deterministic override; medical filter; stored versions; eval set with test–retest SD ≤ 3 |
| **Score inconsistency** (no temperature control) | Deterministic M items dominate (V capped at 35%); idempotent per analysis; hysteresis on level labels |
| **Thresholds uncalibrated** (all ≈ values) | Rubric is data and hot-fixable; `rubric_version` stored; calibration log; ship with "beta" label on the level |
| **Cost overrun** | Haiku for free; quota tables; one in-flight job; hourly prepare limit; daily budget guard; Anthropic workspace limit; caching; 768 px frames; short-output instructions; effort `medium` |
| **Edge Function limits** (2 s CPU, 400 s wall) | Engine bench < 300 ms; Claude in `waitUntil` with 180 s timeout; cron sweeper retries; Pro plan |
| **Apple JWS verification in Deno** | Not on the main path (TLS re-fetch); enforced only for token-less linking; day-one spike |
| **App Review rejection** (5.1.2(i), 3.1.2, 5.1.1(v), 2.1, 4.8, medical claims) | §11 checklist mapped to code; demo mode and sample clips; review notes; conservative privacy label |
| **Slow-motion or VFR imports distort speeds** | PTS-based timing; ≥ 100 fps files processed at 60 Hz; time-stretched clips usually yield `no_strokes_detected` with a "quay video thường 60 fps" tip; verify on device |
| **Vietnamese terminology and tone** | Glossary in the prompt; coach review of (?) items and 20 sample outputs; feedback table |
| **PDPL and data localisation** (cross-border transfer to Anthropic US and Supabase SG) | Data minimisation (no video, blurred faces, pose only); consent; CTIA checklist; **local counsel before launch** |
| **Vision behaviour differences across iOS versions** | `PoseEstimator` protocol; `poseApi` and `os` recorded in the payload; device fixtures in CI |

---

## 15. Inputs needed from the user (they do not block M0–M8)

1. Company reverse-DNS for the bundle and product IDs; final app name in VI and EN.
2. Apple Developer account (team ID, SIWA key, IAP key), Supabase Pro project, Anthropic workspace and key. The live smoke test needs explicit approval.
3. Legal entity (VN individual, VN company or foreign company): this affects tax, PDPL filing and data localisation; local counsel for the CTIA dossier.
4. A Vietnamese coach (badminton and pickleball) for terminology review and clip labelling, plus about 10 clips per skill recorded per the camera guide.
