# RacketCoach MVP: Implementation Plan (v1.1)

*Revised 2026-10-18 after the technical and product/compliance critiques. Working name "RacketCoach"; the bundle ID is `com.<company>.racketcoach`. Appendix A records how each critique item was handled.*

---

## 0. Context

Beginners in badminton and pickleball rarely have a coach watching them. With this app, a player films a short clip of one stroke, of themselves or someone else. The app then:
- extracts 2D body pose on the iPhone with Apple Vision;
- sends a compact joint time-series and **5 cropped key frames** to Supabase. Faces are blurred on a best-effort basis and other people in the frame are masked;
- gets back, in Vietnamese or English:
  - one priority fix ("Sửa điều này trước"), with a cue and a drill;
  - a score with sub-scores, labelled beta;
  - strengths and weaknesses grounded in measured evidence;
  - a short drill plan.

The business model is freemium with monthly and yearly auto-renewing subscriptions.
- **Phase 1:** Vietnam storefront only.
- **Phase 2:** international (§9.2, §11).

**Decisions taken by the user, kept as-is:**
- Native SwiftUI.
- Hybrid analysis: on-device Vision pose, then the backend, then Claude. The full video is never uploaded.
- Supabase for Auth, Postgres, Storage and Deno Edge Functions.
- A full MVP covering both sports, in VI and EN.

**Environment facts checked in this container:**

| Fact | Consequence |
|---|---|
| No Swift toolchain (`download.swift.org` returns 403) | Swift cannot be compiled here |
| No Docker daemon | No `supabase start` or `db lint` |
| `supabase.com` does not resolve | Supabase docs and the API cannot be reached; the deploy spike runs on the Mac |
| PG16 server binaries present | SQL tests run on a temporary cluster |
| Node 22, Python 3.13, npm and JSR reachable | Deno runs via `npx deno@…` |
| `git ls-remote` and `raw.githubusercontent.com` work; the GitHub API does not | Package versions can be checked from tags and source |

**Consequence:** every algorithm that can run on the server is written in TypeScript. That code is unit-tested here and can be hot-fixed without App Store review. Swift is limited to Apple-API adapters, tracking, UI and thin pure logic (`CoachCore`). The user compiles it on a Mac. A small macOS command-line tool, `PoseDump`, produces real pose fixtures early (M3), so the server algorithms are tuned on real clips and not only on synthetic data.

---

## 1. Final decisions

| # | Topic | Decision |
|---|---|---|
| D1 | Where algorithms run | **Two-stage pipeline.**<br>• Device: decode, pose, tracking, quality gate, payload.<br>• Server (TS): cleanup, resampling, segmentation, phases, metrics, scoring and the frame plan.<br>• Device then renders the requested frames.<br>Re-running `prepare` (view change, excluded strokes, handedness swap) is free and reuses the stored pose. |
| D2 | Who owns numbers | **Code owns every number.** Claude judges the visual checkpoints (0–4 or −1), picks findings from grounded candidates and writes all text. The server composes the scores. |
| D3 | Score model | 6 universal sub-scores, each 0–100, with skill weights from the rubric.<br>**Shown rounded to 5 and labelled "beta".** Exact values stay internal. |
| D4 | Skills | **6 at launch, 3 per sport** (§2.1).<br>• The skill list comes from the server (`/analyze/catalog`), so more skills ship later as rubric data with no App Review.<br>• No auto-classification. Wrong strokes are removed in the "Xác nhận cú đánh" grid. |
| D5 | Sampling | **60 Hz** if the source is ≥ 50 fps and the benchmark passes, otherwise 30 Hz.<br>Timestamps are exact PTS in **µs**.<br>The server resamples onto a uniform grid before filtering. |
| D6 | Smoothing | Server-side, in order:<br>1. Swap fix.<br>2. Hampel on residuals of a local quadratic fit.<br>3. Resample with gap fill (linear ≤ 100 ms, Hermite ≤ 200 ms).<br>4. Zero-phase Savitzky–Golay. |
| D7 | Contact time | Peak wrist speed plus a **per-skill offset fitted to coach-labelled real clips**. The UI presents it as an estimate. No audio, so no microphone permission. |
| D8 | Confidence gate | A joint with c < 0.3 is treated as missing. |
| D9 | Key frames | **5 uploaded** (frame IDs F1–F5):<br>• F1–F4: best stroke at `ready`, `bsEnd`, `contact` and `ftStop`.<br>• F5: an "overview" crop at 2× the target box. There is no full frame.<br>Each is 768 px on the long edge, JPEG q 0.8.<br>• **Masking:** faces blurred best-effort with a pose-derived head box plus the face detector; **every non-target person masked**.<br>• **Local only:** 4 worst-stroke frames (L1–L4) are rendered for evidence display and never uploaded.<br>• **Pose-only:** a subject under 16 gets a pose-only analysis with no frames uploaded. |
| D10 | Models | Free: `claude-haiku-5-5`, except the first-ever analysis.<br>Premium, trial, and the free user's first-ever analysis: `claude-sonnet-5-5`.<br>Opus 5.5 is not used. Routing lives in `model_routes`. |
| D11 | Structured output | `output_config.format` with a **per-sport JSON schema**. Each enum is defined once in `$defs` and referenced with `$ref`. No `tool_choice`. Enum values are compared case-insensitively. |
| D12 | Async job | `submit` returns 202 and the job runs in `EdgeRuntime.waitUntil`.<br>• **One Claude attempt per invocation**; every retry is re-queued.<br>• A pg_cron + pg_net sweeper sends one job per HTTP call to `/analyze/run`.<br>• Lock TTL is 8 min, with attempt-number fencing.<br>• The client polls PostgREST. |
| D13 | Entitlement trust | Apple's App Store Server API is the source of truth.<br>• Linking uses the `appAccountToken` from **Apple's re-fetched** transaction.<br>• On an explicit Restore, the link moves to the current account ("last restore wins", rate-limited).<br>• Apple's Set App Account Token endpoint is used to re-point the token.<br>• The Xcode environment bypasses Apple only in the dev project. |
| D14 | Sign-in | **Supabase anonymous sign-in at first launch.** It drives quota, `appAccountToken`, Storage paths and RLS.<br>• Optional "Lưu lịch sử & dùng trên thiết bị khác" after the first result: Sign in with Apple, or email OTP.<br>• **Google is dropped** (v1.1).<br>• If the identity already exists, the account is merged server-side. |
| D15 | Language | In-app picker: System / Tiếng Việt / English.<br>Defaults to **VI when the storefront is VNM or the region is VN**, whatever the system language.<br>Claude's language is fixed per analysis; catalog text switches instantly. |
| D16 | Local video | In-app recording is ≤ 30 s and needs no trimming.<br>Imports are trimmed to 3–30 s, then a **passthrough export** (no re-encode) of the trimmed segment with 1 s padding becomes `source.mov`. The original is not kept.<br>The folder is `isExcludedFromBackup`. Videos older than 60 days are auto-cleaned, with a notice. |
| D17 | Prices | VN: **79,000₫/month** and **599,000₫/year**. A 7-day free trial applies to yearly only. Phase 2 base: $9.99 / $59.99, with manual SEA and India price points. |
| D18 | Quotas | **Free:** 2 per calendar month (ICT). The first-ever analysis uses Sonnet and counts toward the 2; it is guarded with DeviceCheck.<br>**Trial:** 10 in total, of which the first 5 use Sonnet.<br>**Premium:** **15 per subscription month**, all Sonnet.<br>All values live in `plan_limits` and are shown in the paywall from the server. |
| D19 | iOS target | iOS 17.0; built with the Xcode the App Store currently requires (26.x).<br>• supabase-swift needs swift-tools 6.1.<br>• App target: Swift 5 mode with `SWIFT_STRICT_CONCURRENCY=targeted`.<br>• `CoachCore`: Swift 6, Foundation only.<br>• **iPhone only** (`TARGETED_DEVICE_FAMILY=1`), portrait UI. |
| D20 | Pins (≥ 2 weeks old) | **npm:**<br>• `@anthropic-ai/sdk@0.131.0`<br>• `zod@4.6.5`<br>• `@supabase/supabase-js@2.117.2`<br>• `jose@6.2.12`<br>• `@peculiar/asn1-x509@2.10.0`<br>**Swift:** **supabase-swift `2.55.3`** (2026-09-29; it contains `signInAnonymously` and `linkIdentityWithIdToken`; 2.55.4 is too new).<br>**Tools:** Deno version from the S1 spike (fallback 2.9.6); Supabase CLI 2.119.0. |
| D21 | Minimum user age | **18+ at launch.** Onboarding asks for birth year, plus an attestation when the year is borderline. The value is in `app_config.min_user_age`, so it can drop to 16 after counsel signs off and Anthropic's minor-safeguard requirements are documented. |
| D22 | Analytics | First-party only. An `events` table is written through the `log_event` RPC and by the server. There is no third-party SDK. |

### 1.1 Corrections to the research (still valid, plus new ones)

1. **Vision joints.** Vision returns 19 joints. `neck` belongs to the torso group. The 3D request has 17 joints. Hand pose is not used.
2. **Prices per MTok, verified:**

   | Model | Input | Output | Cache read | Cache write (5 min) | Notes |
   |---|---|---|---|---|---|
   | Haiku 5.5 | $0.10 | $0.50 | $0.01 | $0.125 | Rates for prompts ≤ 100K tokens; the tokenizer counts about 30% more tokens than Haiku 4.5 |
   | Sonnet 5.5 | $2 | $10 | $0.20 | $2.50 | |
   | Opus 5.5 | $4 | $20 | $0.20 | $5 | |
3. **Sampling parameters.** Non-default values return 400 on Sonnet 5.5 and Haiku 5.5, so consistency comes from D2.
4. **Effort.**
   - Sonnet 5.5 defaults to `high`, but its levels are recalibrated. The guidance is `low` for content generation and extraction.
   - Haiku 5.5 defaults to `medium`.
   - Effort is always set explicitly and swept (§8.1).
5. **Structured outputs.**
   - Unsupported: numeric bounds, string length, `minItems` > 1, recursive schemas, complex regex.
   - There are internal grammar-size limits ("Schema is too complex for compilation" returns 400) and a compile timeout of 180 s.
   - A compiled grammar is cached for 24 h after its last use.
   - Enum capitalisation is not guaranteed.
6. **Server-side fallback** (`fallbacks:"default"`, beta `server-side-fallback-2026-07-01`) on Sonnet 5.5 retries only the `cyber` and `frontier_llm` refusal categories. `general_harms`, the likely false positive for images of people, is not retried. Haiku 5.5 has no server-side fallback.
7. **App Store Server API hosts.** Since 2026-05-05 Apple recommends `api.storekit.apple.com` and `api.storekit-sandbox.apple.com`; the old hosts still work.
   - The Set App Account Token endpoint was added on 2025-06-09.
   - Send Consumption Information (v1.19) was added on 2025-12-10.
8. **Supabase limits** (400 s wall clock on Pro, 2 s CPU, `waitUntil` does not extend the limit, hosted runtime announced as Deno 2.1-compatible) are not verifiable here. They are measured in the **S1 spike**.

---

## 2. MVP product scope

### 2.1 Skills

| Sport | Skill ID | EN | VI | Recommended view → also OK |
|---|---|---|---|---|
| Badminton | `bd.clear_fh` | Forehand overhead clear | Phông cầu thuận tay | **D** (back-corner diagonal, raised) → B (behind) → S |
| | `bd.smash` | Smash | Đập cầu | D → B → S |
| | `bd.serve_low` | Low backhand serve | Giao cầu thấp trái tay | S → D |
| Pickleball | `pb.serve` | Serve | Giao bóng | S (from the sideline fence) → D |
| | `pb.dink` | Dink | Dink | S → D |
| | `pb.drop3` | Third-shot drop | Drop cú thứ ba | S → D → B |

- The deferred skills are in the rubric but disabled in `enabled_skills`: `bd.net_shot`, `bd.lift`, `bd.serve_high`, `pb.return`, `pb.drive`, `pb.volley`. Each is enabled after calibration (≥ 20 labelled clips).
- Ready stance, split step and recovery checkpoints are evaluated inside every stroke clip.
- **Solo-friendly** skills (serves) are marked in the picker. The others show "Nhờ bạn đánh cầu/bóng cho bạn".

### 2.2 Screens and flows (first result in about 7 taps)

1. **Welcome.** Language is pre-selected by storefront or region, with a picker link. Three value cards. Buttons: **"Bắt đầu"** and "Xem phân tích mẫu" (offline demo). Anonymous sign-in runs silently and is retried when the device comes online.
2. **About you** (one screen):
   - Birth year (neutral picker). Under 18 is blocked with a polite message.
   - Handedness.
   - Level is optional.
3. **Home.**
   - "Analyze a stroke" button.
   - Quota chip, e.g. "Còn 1/2 lượt tháng này". Premium users see "Lượt mới vào 12/11".
   - Last result.
   - Camera guide and sample clip.
4. **New analysis.**
   1. Skill grid (from the catalog), with the recommended view per skill.
   2. **Camera guide**, first time per sport (§10.3).
   3. Choose the source:
      - **Record**: live framing check (§5.4.0); 3-2-1 countdown or auto-start when green; ≤ 30 s; no trimmer.
      - **Photos** (PhotosPicker).
      - **Files**, or **"Open in RacketCoach"** from the share sheet (Zalo, Messages) through `CFBundleDocumentTypes`.
   4. **Trimmer**, imports only: 3–30 s, followed by the passthrough export.
   5. **Subject**: "Tôi" / "Người khác".
      - "Người khác" requires "Người trong video đã đồng ý cho tôi quay và phân tích".
      - It also asks "Người trong video dưới 16 tuổi?". If yes: a guardian attestation, and the analysis runs **pose-only**.
   6. **Select player** only when the clip is ambiguous: more than one plausible candidate per the §5.4 rule. Otherwise the player is auto-selected silently.
5. **First-submit consent** (just in time; blocking; versioned):
   - **(a) Required: processing and cross-border transfer.** Pose data and frames are stored by Supabase in Singapore.
   - **(b) Required: AI processing by Anthropic (Claude, USA).** It lists:
     - what is sent: pose coordinates, up to 5 still frames with faces automatically blurred (best effort) and other people masked, sport, skill, handedness, level;
     - that the video itself is never uploaded;
     - retention: key frames deleted after the analysis, at most 72 h;
     - Anthropic's API retention period, as published at M16;
     - how to withdraw consent.
   - **(c) Optional, unticked: "Cho phép dùng dữ liệu đã ẩn danh để cải thiện độ chính xác"** (calibration and eval use).
   - **(d) Optional, unticked:** sharing usage information with Apple when a refund is requested (consumption consent).
   - Shown again whenever the consent version changes.
6. **Processing:**
   1. "Đọc video".
   2. "Nhận diện tư thế" (%).
   3. "Phân tích chuyển động".

   Shown throughout: "Hãy giữ ứng dụng mở". Early rejections show tips and use no quota.
7. **Xác nhận cú đánh** (after `prepare`; free):
   - A grid with one local thumbnail per detected stroke at its estimated contact. The user unticks wrong strokes.
   - The camera view, pre-filled from `viewGuess`. A confirmation is shown only if confidence is below 0.7.
   - The handedness suggestion, if any.

   Any change re-runs `prepare` with `reprepare.v1`. Then the frames are extracted, uploaded and submitted, and the screen shows "HLV AI đang nhận xét".
8. **Results** (top to bottom):
   1. **Hero "Sửa điều này trước".** One issue, a plain-language observation, one cue and one drill, plus the key frame with the skeleton and the relevant joints drawn on it.
   2. **Score ring:** overall rounded to 5, a level label and a **"beta"** chip. A partial result shows "Chưa đủ dữ liệu — không tính lượt" with no number.
   3. **6 sub-score bars**, rounded to 5, or "Chưa đủ dữ liệu".
   4. **Strengths**, then the other **weaknesses**. Evidence chips use plain language ("khuỷu tay còn gập khi chạm cầu"). Tapping a chip opens the matching key frame with the skeleton; degrees appear under "Chi tiết".
   5. **Plan:** up to 3 priorities, each with cues and 1–2 drills (sets × reps, steps).
   6. "Không đánh giá được từ video", recording tips, the static **rules tip card** and fixed safety notes.
   7. Footer: **"Nhận xét do AI tạo, có thể chưa chính xác · Không phải lời khuyên y tế. Dừng tập nếu đau."**
   8. Thumbs feedback, and "Nhắc tôi quay lại sau 7 ngày" (local notification, requested on tap).
   9. **Free tier** sees the hero, overall and sub-scores, and 1 strength. Everything else is locked with a count ("Còn 2 điểm cần cải thiện, kế hoạch 3 bước…") and "Mở khóa Premium". Upgrading unlocks past reports through the server RPC.
   10. **Video player with plain skeleton overlay** (0.25/0.5/1×, frame step): Premium only.
9. **History.** Free users see the last 3 in full; older items show as locked stubs. Delete removes the row and its files.
10. **Progress** (Premium or trial). Covers `subject=self` only. Swift Charts of overall and sub-scores per skill.
11. **Paywall.** Opens on an exhausted free quota, a locked section or Progress, or from Settings.
    - Trial and Premium users at their cap see "Lượt mới vào <ngày>", never the paywall.
    - `SubscriptionStoreView(productIDs:)`.
    - Server-driven feature list with exact numbers: "Premium: 15 phân tích nâng cao/tháng", "Dùng thử 7 ngày: tối đa 10 phân tích (5 nâng cao)", "Miễn phí: 2/tháng".
    - The yearly per-month figure is a small caption computed from `Product.price / 12` with `priceFormatStyle`.
12. **Settings.** Contents:
    - **Account:** anonymous / Apple / email; "Lưu lịch sử" (link); sign out.
    - **Subscription:** status, Manage, Restore, Redeem.
    - **Language**, with a note that system sheets follow the iOS language.
    - **Profile.**
    - **Privacy:** consents and withdrawal, "What we send", calibration opt-in, consumption-sharing toggle.
    - **Storage:** size, delete local videos.
    - **Legal:** Privacy, Terms (EULA), "Không phải lời khuyên y tế".
    - **Support page link.**
    - **Delete account**, also for anonymous users.
    - Version.

### 2.3 Out of scope (v1.1+)

- Google sign-in
- `BGContinuedProcessingTask` (iOS 26)
- App Attest
- Share cards
- Push notifications
- Translation of the narrative into the other language
- Native-fps refine pass
- Audio contact detection
- Grip photo
- Footwork and kitchen skills
- Rally mode
- Opus "deep" analysis
- Coach sharing
- Drill logs
- Level hysteresis
- Serve-legality badges
- Android
- International storefronts (Phase 2)

---

## 3. Architecture

```
iPhone (SwiftUI)                                     Supabase ap-southeast-1 (Pro)                    Anthropic
Anonymous session (signInAnonymously) ─ all IDs lowercased ─ functions invoked with region ap-southeast-1
Record(live framing)/Import→passthrough export → [tap if ambiguous]
AVAssetReaderVideoCompositionOutput (Rec.709, upright) → Vision 2D pose (ROI = tracked box) → Tracker → QualityGate
  ── POST /analyze/prepare (pose.v1, tUs exact PTS) ──▶ engine: normalize→swap→Hampel(resid)→resample+gapfill→SG
                                                         →segment(+contact offset)→phases→metrics→checkpoints
                                                         →rank→frame plan (snapped to sampled PTS)
                                                         ownership-safe upsert; store pose.raw/clean.json
  ◀── strokes, viewGuess, frameRequests (5 upload + 4 local) ── (no quota)
"Xác nhận cú đánh" → (optional) POST /analyze/prepare reprepare.v1 {view, excludedStrokeIds}
AVAssetImageGenerator(±0.45 frame) → mask non-targets + head blur → crop → 768px JPEG
  ── Storage analysis-inputs/{uid}/{id}/frames/F1..F5.jpg (RLS, bucket-scoped) ──▶
  ── POST /analyze/submit {analysisId, deviceCheckToken?} ──▶ consents ✓ frames ✓ budget ✓
                                         reserve_for_submit (advisory lock: in-flight + quota + ledger + queued) → 202
                                         waitUntil(runOnce): claim(attempt#) → 1 Claude call ───────────▶ Haiku 5.5 / Sonnet 5.5
                                                                                      ◀── coach.v1 (per-sport schema)
                                         postprocess → finalize(attempt#: results+commit|refund+status) → delete frames
  ◀── poll analyses.status (2→5 s, 5 min cap) ── then rpc get_result(id) (tier-redacted) + pose.clean.json
pg_cron 1 min: dispatch_due_jobs() → net.http_post per job → /analyze/run (202, waitUntil runOnce)
pg_cron daily: /cron daily (202) → retention, recursive orphan cleanup, notif history (Prod+Sandbox), schema warm, spend alerts
StoreKit 2 → /verify-subscription ; ASSN v2 → /appstore-webhook ; /account-merge ; /delete-account ; /apple-auth-exchange
```

---

## 4. Repository layout (monorepo)

```
/
├─ README.md                        # Mac setup (Xcode 26.x, xcodegen), Supabase, secrets, Auth settings
├─ scripts/
│  ├─ check.sh                      # all Linux-verifiable checks (§13.1)
│  ├─ gen-schemas.ts                # Zod → shared/schemas/*.json (+ --check, keyword audit)
│  ├─ gen-synthetic-pose.ts         # synthetic swings (realistic 20–30 T/s, sharp reversals, VFR gaps)
│  ├─ replay.ts                     # pose.v1 → prepare → prompt → (mock|live) Claude → coach-result
│  ├─ bench-engine.ts               # includes JSON.parse + Zod of 1.2 MB payload
│  ├─ fit-contact-offsets.ts        # labels/*.csv → per-skill offsets + report
│  ├─ eval.ts                       # labelled fixtures: MAE vs coach, test–retest SD
│  ├─ smoke-claude.ts               # LIVE (approval): schema compile × model × sport, cost, cache read
│  ├─ warm-schemas.ts               # post-deploy grammar warm-up (tiny calls)
│  ├─ gen-test-certs.sh             # openssl test CA chain for jws tests
│  └─ check_ios_resources.py        # xcstrings vi/en, xcprivacy, Info keys, xcconfig "//" ban, banned APIs, storekit IDs (if file present)
├─ tools/labeler/index.html         # static page (Mac): video + pose JSON, mark contact frames → labels CSV
├─ shared/
│  ├─ schemas/                      # pose.v1, reprepare.v1, prepare-response.v1, coach-output.{badminton,pickleball}.v1, coach-result.v1
│  └─ fixtures/
│     ├─ pose/                      # synthetic_*.json, real_<skill>_<n>.json (PoseDump), device_*.json (M13)
│     ├─ labels/                    # real_*.csv (coach contact labels)
│     ├─ prepare/  claude/  results/
├─ ios/
│  ├─ project.yml                   # XcodeGen
│  ├─ Config/ Base.xcconfig Debug.xcconfig Release.xcconfig Secrets.example.xcconfig   # hosts only, never "//"
│  ├─ RacketCoach/
│  │  ├─ App/ Features/(Welcome, AboutYou, Consent, Home, Capture/{Guide,Recorder,LiveFraming,Import,Trimmer,Subject},
│  │  │       PlayerSelect, Processing, ConfirmStrokes, Results/{Hero,ScoreRing,SubScores,Findings,KeyFrameView,Plan,Locked},
│  │  │       Player, History, Progress, Paywall, Settings, Demo)
│  │  ├─ Services/ Video/(AssetInfo, ClipExporter, CompositionFrameReader, KeyFrameExtractor, PrivacyMasker)
│  │  │            Pose/(PoseEstimator, VisionPoseEstimator) Pipeline/(AnalysisPipeline, PipelineCheckpoint)
│  │  │            Backend/(SupabaseProvider, AnalysisAPI, StatusAPI, EventLogger) Auth/(AnonAuth, AppleSignIn, EmailOTP, AccountLinker)
│  │  │            Purchases/(StoreService) Device/(DeviceCheckService) Local/(LocalAnalysisStore, StorageMaintenance)
│  │  │            L10n/(AppLanguage, L10n) Notify/(ReminderScheduler)
│  │  ├─ DesignSystem/  Resources/(Localizable.xcstrings, InfoPlist.xcstrings, PrivacyInfo.xcprivacy, Assets, Samples/)
│  ├─ RacketCoachTests/
│  ├─ Packages/CoachCore/           # Package.swift (tools 6.0; iOS 17, macOS 14)
│  └─ Tools/PoseDump/               # SwiftPM macOS executable → pose.v1 from a video file (uses CoachCore + Vision)
├─ supabase/
│  ├─ config.toml  seed.sql
│  ├─ migrations/ 20261020000100_core.sql 0200_billing.sql 0300_private.sql 0400_functions.sql
│  │              0500_rls.sql 0600_storage.sql 0700_analytics_config.sql 0900_cron.sql (not run on Linux)
│  ├─ functions/
│  │  ├─ deno.json                  # imports (pinned), "lock": false
│  │  ├─ _shared/ http errors log env auth db storage crypto budget events
│  │  │   contracts/ rubric/(types, badminton.json, pickleball.json, drills.json, glossary.json, load.ts)
│  │  │   engine/(normalize, swapfix, hampel, resample, savgol, segment, phases, metrics, checkpoints, score,
│  │  │           rank, frameplan, viewcheck, handedness, prepare)
│  │  │   claude/(client, prompts/base_system, prompts/rubric_text, schema_per_sport, build_request, run_once,
│  │  │           postprocess, medical_filter, compose)
│  │  │   jobs/(claim, finalize, requeue)   apple/(jwt, api, jws, linking, siwa, devicecheck)
│  │  ├─ analyze/index.ts           # /catalog /prepare /submit /run
│  │  ├─ cron/index.ts  verify-subscription/  appstore-webhook/  apple-auth-exchange/  account-merge/  delete-account/
│  │  └─ spike/index.ts             # S1 only; deleted after M0
│  └─ tests/ engine/ claude/ apple/ jobs/ functions/ rubric/   sql/(shim.sql, assertions/*.sql, concurrency.sh, run.sh)
└─ docs/ camera-guide.{vi,en}.md glossary.md legal/(privacy, terms(EULA), ai-disclosure, dpia, ctia, pdpl-checklist)
         appstore/(metadata.{vi,en}.md, review-notes.md, privacy-label.md, age-rating.md) support/index.{vi,en}.md
         rubric/calibration.md  economics.md
```

`docs/legal/*` and `docs/support/*` are published as static pages. The xcconfig files hold **hosts only**, for example `LEGAL_HOST = racketcoach.app`. URLs are built in code.

---

## 5. iOS app

### 5.1 Project configuration (`ios/project.yml`)

**Project options:**
- `name: RacketCoach`
- `options.deploymentTarget.iOS: "17.0"`
- `developmentLanguage: en`
- No `knownRegions` key. The `vi` region comes from the String Catalogs; it is verified in the generated project at M0.

**Packages:**
- `CoachCore` (local path).
- `Supabase: {url: https://github.com/supabase/supabase-swift, exactVersion: 2.55.3}`.
- No Google.

**Target `RacketCoach`:**
- `TARGETED_DEVICE_FAMILY: "1"`.
- Entitlement: `com.apple.developer.applesignin: [Default]`.

Info properties:

| Key | Value |
|---|---|
| `NSCameraUsageDescription` | Localized (§10.1) |
| `UISupportedInterfaceOrientations` | `[UIInterfaceOrientationPortrait]`. Landscape video is still recorded correctly through `RotationCoordinator` |
| `CFBundleDocumentTypes` | `public.movie`, `public.mpeg-4`, `com.apple.quicktime-movie`; `LSHandlerRank: Alternate` |
| `LSSupportsOpeningDocumentsInPlace` | `NO` |
| `ITSAppUsesNonExemptEncryption` | `NO` |
| `CFBundleLocalizations` | `[en, vi]` |
| `UILaunchScreen` | `{}` |
| `SUPABASE_HOST`, `SUPABASE_PUBLISHABLE_KEY`, `LEGAL_HOST`, `SUPPORT_HOST`, `SUBSCRIPTION_GROUP_ID` | From xcconfig |

Not added: no microphone key, no photo-library keys, no background modes.

**Scheme:** `storeKitConfiguration: RacketCoach/Resources/Products.storekit`. The file is created in Xcode and synced with App Store Connect at M15.

**Build settings:**
- `SWIFT_VERSION 5.0`
- `SWIFT_STRICT_CONCURRENCY targeted`
- `LOCALIZATION_PREFERS_STRING_CATALOGS YES`
- `SWIFT_EMIT_LOC_STRINGS YES`

### 5.2 App target modules

| Module | Responsibilities and key APIs |
|---|---|
| App | `AppModel` (`@Observable @MainActor`): session, profile, status from `my_status()`, catalog. `Dependencies` holds protocols, so previews and tests use mocks. |
| L10n | `AppLanguage {system, vi, en}`. The default comes from `Storefront.current?.countryCode == "VNM"` or `Locale.current.region == .vietnam`. Root `.environment(\.locale)` plus `.id(lang)`. Non-view strings come from `.lproj` bundle lookup. |
| Auth | **AnonAuth:** `auth.signInAnonymously()` on first launch.<br>**AccountLinker:**<br>• Apple: nonce = SHA-256 of a random string, then `auth.linkIdentityWithIdToken(.apple, idToken, nonce)`, then `apple-auth-exchange(authorizationCode)`.<br>• Email: `updateUser(email:)`, then `verifyOTP(type: .emailChange)`.<br>• **If the identity already exists:** keep the anonymous access token, sign in to the existing account (`signInWithIdToken` / `verifyOTP(.email)`), then `POST /account-merge {anonAccessToken}`.<br>All UUIDs are passed through `CoachCore.IDs.lower()`. |
| Capture | **Recorder:** `AVCaptureSession`, 1080p with max fps ≥ 60, fixed 60 fps, HEVC, no audio input, `maxRecordedDuration` 30 s, back wide-angle camera, `RotationCoordinator`.<br>**LiveFraming:** `AVCaptureVideoDataOutput` at 5 fps into Vision body pose. Traffic light: whole body visible, player at 40–70% of frame height, mean luma within range. Record is enabled on green, with a manual override and a 3-2-1 countdown / auto-start.<br>**Import:** PhotosPicker with `FileRepresentation` copy; `.fileImporter([.movie])`; `.onOpenURL` with a security-scoped copy.<br>**Trimmer:** filmstrip, then **ClipExporter** (`AVAssetExportSession` passthrough, `timeRange` ±1 s); the temporary source is deleted. |
| Video | **CompositionFrameReader:** `AVAssetReaderVideoCompositionOutput` with `AVMutableVideoComposition(propertiesOf:)`.<br>• Color properties are Rec.709, so HDR (HLG / Dolby Vision) is tone-mapped to SDR.<br>• Frames come out **upright in display space**, so Vision orientation is `.up`.<br>• `renderSize` = display size, long edge capped at 1920.<br>• Uses PTS of the exported clip.<br>**KeyFrameExtractor:** `AVAssetImageGenerator` with the same composition and tolerance ±0.45/srcFps. It checks `actualTime`; if it is off by ≥ ½ frame, it falls back to a reader decode.<br>**PrivacyMasker:** §5.4 step 9. |
| Pose | `VisionPoseEstimator` reuses one `VNDetectHumanBodyPoseRequest` and sets `regionOfInterest` from the tracker. Coordinates are mapped back with `CoachCore.RoiMapper`. Explicit `JointName` → `Joint` switch. `@preconcurrency import Vision`. |
| Pipeline | `AnalysisPipeline.run(draft) -> AsyncThrowingStream<PipelineEvent>`. Per frame: `Task.checkCancellation()` and `isIdleTimerDisabled`.<br>**On `scenePhase == .background`:** write `PipelineCheckpoint` (last PTS, tracker state, partial track) and stop. On foreground, resume with a new reader and handler.<br>**Pending uploads and submits** persist in `LocalAnalysisStore` and resume on launch, foreground or network change (`NWPathMonitor`). |
| Backend | **`AnalysisAPI`:**<br>• `catalog()`, `prepare(pose)`, `reprepare(...)`.<br>• `uploadFrames`: Storage `analysis-inputs`, `upsert: true`, max 3 parallel.<br>• `submit(id, deviceCheckToken?)`.<br>• `poll(id)`: PostgREST column-limited select.<br>• `result(id)`: `rpc("get_result")`.<br>• `cleanTrack(id)`.<br>**`StatusAPI`:** `rpc("my_status")`.<br>**`EventLogger`:** `rpc("log_event")`, batched.<br>**All** functions are invoked with region `ap-southeast-1`. |
| Purchases | `StoreService`:<br>• Product IDs come from constants.<br>• The `Transaction.updates` listener starts at launch.<br>• `sync(reason:)` posts each JWS to `verify-subscription`.<br>• **`finish()` on any definitive answer** (2xx, 409, other 4xx); retry only on network errors or 5xx.<br>• `restore()` calls `AppStore.sync()` then `sync(reason: .restore)`. |
| Device | `DeviceCheckService`: `DCDevice.current.generateToken()`, attached to the first submit only. Unavailable (e.g. Simulator) means no bonus. |
| Local | `LocalAnalysisStore`: Codable index of id, source path, local key frames (L1–L4 and F1–F5 unblurred), cached redacted result and `pose.clean.json`. `Analyses/` is `isExcludedFromBackup`. `StorageMaintenance` auto-cleans videos older than 60 days. |
| Results | `HeroFixCard`, `ScoreRing`, `SubScoreBar`, `FindingCard`, `EvidenceChip` → `KeyFrameView` (image plus skeleton from `CoachCore.KeyFrameSkeleton`), `PlanView`, `LockedSection(count:)`, `AILabelFooter`, `FeedbackBar`. |
| Player | Premium only. `AVPlayerLayer` with a plain skeleton `CAShapeLayer`, synced with `AVPlayerItemVideoOutput` and `CADisplayLink`. No per-metric highlighting. |
| Progress | Swift Charts from `rpc("get_progress")`. |
| Demo | Bundled samples, `*.result.json` and `*.pose.clean.json`. No network. |

### 5.3 `CoachCore` (Foundation only, Swift 6, deterministic)

| Folder | Contents |
|---|---|
| `IDs/` | `IDs.lower(UUID) -> String`: lowercased canonical form. Used for every path, `analysisId` and `appAccountToken`. Tested. |
| `Model/` | `Joint` (19 cases, payload `jointOrder`), `Keypoint`, `PersonCandidate`, `Rect`, `Point`. |
| `Geometry/` | `OrientationMapper`, used for metadata and the `mirrored` flag only now that frames are rendered upright. `RoiMapper`: ROI-normalised to full-frame normalised to CFS, both directions. |
| `Sampling/` | **`FrameScheduler`:**<br>• Keep a frame if `pts ≥ nextT − 0.5/srcFps`.<br>• Then `nextT = max(nextT, pts) + 1/targetHz`, so there is no burst after a VFR gap.<br>**`RateChooser`:** discards the first 5 Vision calls as warm-up. |
| `Tracking/` | `CandidateBuilder`, `TargetSelector`. `Tracker` also emits the `roi` for the next frame: the tracked box expanded 2×, at least 40% of frame height, reset to the full frame while coasting. |
| `Quality/` | `QualityAccumulator`, `QualityGate` (thresholds in §5.4). |
| `Payload/` | `PoseV1` with `tUs: [Int64]`, `Quantizer`, `PoseV1Builder`, `PrepareResponseV1`, `CoachResultV1`. |
| `Crop/` | `CropMath`. |
| `Overlay/` | `SkeletonGeometry.bones` (14 bones), `PoseTimeline`, `KeyFrameSkeleton`. |
| `Tests/` | swift-testing, covering:<br>• orientation table;<br>• scheduler with VFR gaps (asserts no bursts);<br>• tracker crossings and ROI;<br>• quantizer round trip;<br>• UUID lowercasing.<br>**Fixtures** are loaded via a `#filePath`-relative URL from `shared/fixtures/**` and compared as **decoded values**, not bytes. |

`Tools/PoseDump` is a macOS 14 SwiftPM executable that uses CoachCore and Vision:
```
swift run -c release posedump clip.mov --select auto|x,y --hz 60 --out clip.pose.json
```
It uses the same composition reader logic and the same `PoseV1Builder`, and it produces the real fixtures used from M4 on.

### 5.4 On-device algorithms

0. **Live framing** (recorder only). Pose runs at 5 fps on the preview. Green requires all three:
   - ≥ 15 of the 19 joints with c ≥ 0.3, including both ankles and both wrists;
   - player height 40–70% of the frame;
   - mean luma between 0.25 and 0.85.

   Hints: "Lùi xa hơn", "Thấy cả bàn chân", "Ngược sáng".
1. **Rate choice.** Below 50 fps the rate is 30 Hz. Otherwise:
   - time Vision calls 6–25 (the first 5 are warm-up);
   - `projected = msPerFrame × segSec × 60`;
   - use 60 Hz if `projected ≤ 1.5×segSec×1000 + 10 000` and the thermal state is ≤ `.fair`.

   Below 30 fps, warn; below 24 fps, reject.
2. **Decode.** `CompositionFrameReader` produces upright SDR frames. Timestamps are the exported clip's PTS converted to **µs**.
3. **Pose.** Vision runs with orientation `.up` and ROI from the tracker. The decoder and Vision consumer share a bounded queue of 2.
4. **Player selection** at the first frame in `[0, 3 s]` that contains people:
   - **Auto-select silently** if exactly one candidate has mean confidence ≥ 0.5 and every other candidate's area is < 30% of its area.
   - Otherwise, show the tap screen.
5. **Tracking.** Unchanged:
   - prediction: constant velocity;
   - cost: `(1−IoU) + 0.5·Δc/diag + 0.2·|ln area ratio|`;
   - gate: IoU > 0.1 or Δc < 1.5 torso;
   - coast ≤ 0.5 s;
   - re-acquire within ±30% torso size;
   - flag ambiguity.

   ROI cropping (crop-follow) is on.
6. **Quality gate** (no quota used):
   - target present in < 60% of frames → reject;
   - **median player height < 25%** → reject "too far";
   - 25–35% → warning;
   - mean limb confidence < 0.4 → reject.
7. **Mirroring.** The composition renders frames as displayed. If `preferredTransform` has det < 0, the payload sets `mirrored: true` and the **server swaps L/R exactly once**. This is checked by a device test (M13).
8. **Key frames** after `prepare` or `reprepare`:
   - Each request carries `tUs`, snapped by the server to a sampled frame.
   - The image is generated at ±0.45-frame tolerance, then `actualTime` is verified.
   - All 9 frames are rendered locally (unblurred, kept on device). The 5 with `upload:true` are masked (step 9), cropped, resized to 768 px and saved as JPEG q 0.8 with no metadata.
   - In **pose-only** mode, nothing is uploaded.
9. **PrivacyMasker** (on the full frame, before cropping), fail-closed:
   1. Run body pose, `VNDetectHumanRectanglesRequest` and `VNDetectFaceRectanglesRequest`.
   2. Match the target to the tracked box by IoU.
   3. **Every non-target person:** pixelate the whole body box at scale 32.
   4. **Target head box:** union of the face rects (×1.3) and a pose head box. The pose box covers nose, eyes, ears and neck with c ≥ 0.1; its width is max(ear span, 0.6×shoulder width)×1.6, and it runs from the neck to 0.6× that width above the eyes. Pixelated at scale 24.
   5. If the target has no head joints and no face rect, blur the top 22% of its box.
   6. Any unmatched face rect is blurred.

---

## 6. Backend

### 6.1 Edge functions

| Function / route | Auth | Purpose |
|---|---|---|
| `GET /analyze/catalog` | JWT | Enabled skills (rubric ∩ `enabled_skills`) with VI/EN names, views with coverage, solo flag, plan copy numbers from `plan_limits`. Cached 1 h. |
| `POST /analyze/prepare` | JWT | **Body:** `pose.v1` (≤ 1.2 MB, ≤ 20/h per user) or `reprepare.v1` (loads the stored `pose.raw.json`).<br>**Ownership:** `INSERT … ON CONFLICT (id) DO UPDATE … WHERE analyses.user_id = excluded.user_id AND status IN ('prepared','rejected')`. Zero rows → **409 `analysis_conflict`**.<br>**Steps:** run the engine, store `pose.raw.json` and `pose.clean.json`, return §7.3. |
| `POST /analyze/submit` | JWT | **Checks, in order:**<br>1. Ownership (uuid compare).<br>2. `pdpl_consent_version` and `ai_consent_version` are current, else 403 `consent_required`.<br>3. Expected frames exist (5, or 0 for pose-only).<br>4. Budget guard (§8.7).<br>5. If a DeviceCheck token came with the first submit, query bit0.<br>**Then:** `private.reserve_for_submit(uid, id, device_bonus_ok)` (§6.5) returns 402 `quota_exceeded` / 429 `in_flight` / ok, followed by 202 and `waitUntil(runOnce(id))`.<br>**Idempotent:** queued or processing → 202; succeeded → 200. |
| `POST /analyze/run` | `x-internal-secret` | Called by pg_net with one job each. Claims with fencing, returns 202, then `waitUntil(runOnce)`. |
| `POST /cron {task}` | `x-cron-secret` | Returns 202 and does the work in `waitUntil`, chunked and idempotent. Task `daily` (§6.6); task `warm`. |
| `POST /verify-subscription` | JWT | §9.4. |
| `POST /appstore-webhook` | none | §9.5. |
| `POST /apple-auth-exchange {authorizationCode}` | JWT | Builds the client-secret JWT, calls `/auth/token`, and stores the refresh token AES-GCM-encrypted. |
| `POST /account-merge {anonAccessToken}` | JWT of the permanent account | **Validates** the anonymous JWT (`is_anonymous`, not expired, issued in the last hour).<br>**In one transaction**, moves `analyses`, `analysis_results`, `feedback`, `events` and `usage_counters` (`used` = sum, capped at the period limit; the bonus flag = OR).<br>**Storage:** moves `{anon}/…` → `{uid}/…` with the Storage `move` API, walked recursively.<br>**Subscriptions:** re-links them and calls Apple's **Set App Account Token**.<br>**Last:** deletes the anonymous user and writes an audit row. |
| `POST /delete-account {confirm:true}` | JWT (anonymous too) | Idempotent steps:<br>1. Revoke SIWA, or return `siwaManualRevoke`.<br>2. **Recursively** remove `{uid}/` from both buckets, in batches of up to 1000.<br>3. Delete the token.<br>4. Null `user_id` and `app_account_token` on subscriptions.<br>5. `auth.admin.deleteUser`.<br>6. Audit with `sha256(uid+pepper)`.<br>Returns `{deleted, hadActiveSubscription}`. |

**Shared modules (`_shared/`):**
- `auth.ts`: `requireUser` via `getClaims()`.
- `db.ts`: service-role client.
- `log.ts`: JSON logs with no PII.
- `crypto.ts`: AES-GCM.
- `events.ts`: server-side events.
- `budget.ts`.
- Every `fetch` has `AbortSignal.timeout`.
- `addEventListener('beforeunload', …)`: best-effort re-queue of the in-flight job. **The guarantee is the 8-minute lock TTL, not this handler.**

**`config.toml` and `deno.json`:**
- `[edge_runtime] policy = "per_worker"` for local runs.
- `verify_jwt` per the table.
- `deno.json` sets `"lock": false`, so no v5 lockfile is deployed.

### 6.2 Analysis engine (pure TypeScript)

**`prepare.ts`:** validate → normalize → swap fix → Hampel → resample with gap fill → SG → handedness → segment → phases → metrics → checkpoints → view guess → rank → frame plan → clean-track export.

1. **Normalize.** Dequantize, aspect-correct to frame-height units with y up. **T** = median |neck − root|, with the shoulder-mid/hip-mid fallback.
2. **Swap fix.**
   - Per limb chain: swap when the swapped distance is < 0.6× the identity distance.
   - **Mirrored source: swap all labels once**, and never anywhere else.
3. **Hampel on residuals.** Fit a local quadratic in time over ±100 ms using the actual `tUs`; flag samples whose residual exceeds 3·MAD of the residuals and set them missing. Real turnarounds survive. Tests use 20–30 T/s wrist speeds and sharp reversals.
4. **Resample and gap fill.**
   - Build a uniform grid at `analysisHz` over `[t₀, t_end]`.
   - Interpolate per joint: linear across gaps ≤ 100 ms, cubic Hermite across gaps ≤ 200 ms when both ends are good; longer gaps stay null.
   - Keep an `interp` mask.
5. **Savitzky–Golay**, zero-phase, order 2, window 5 at 30 Hz or 9 at 60 Hz. Velocities come from the SG derivative.
6. **Handedness check.** Of the top 5 wrist-speed peaks, if ≥ 4 belong to the other wrist, return `handednessSuggestion`.
7. **Segmentation.**
   - Candidates: local maxima of `v` with `v ≥ max(Vmin, 2.5·median)` and prominence ≥ 0.4·peak.
   - NMS spacing per skill.
   - Reject a candidate if the wrist is missing in > 30% of ±0.2 s, or the track was re-acquired in that window, or more than 50% of samples in ±0.1 s are `interp`.
   - **Contact:** `t_contact = parabolic peak + contactOffsetMs[skill]`. Offsets are fitted at M4 from coach labels and start at 0.
   - Limits: 12 strokes; 0 strokes → 422.

   | Skill | Vmin (T/s) | NMS (s) |
   |---|---|---|
   | clear_fh, smash | 4 | 0.8 |
   | serve_low | 1.2 | 2.0 |
   | pb.serve | 2 | 2.0 |
   | dink | 1.2 | 0.8 |
   | drop3 | 1.5 | 1.0 |

   All values are tuned on real clips at M4.
8. **Phases.** `ready`, `bsEnd`, `contact`, `ftStop`, `recovery` and `swingStart` as in v1.0. **Every phase time is snapped to the nearest sampled (non-interpolated) original `tUs`** before it is used in a frame request.
9. **Direction `f` and sign `h`.** As in v1.0.
10. **Metric registry.** As in v1.0, with view factors per S/B/D (front uses the B factors with lateral signs mirrored).
    - **`hop` (split step):** both ankles rise ≥ **0.1 T** above their 0.5 s rolling median, **and root rises ≥ 0.05 T**, onsets ≤ 70 ms apart, landing 0.1–0.4 s later. The threshold is calibrated at M4.
11. **View guess.** The ratio of median shoulder width to SWmax in ready frames, plus the direction of hip-line motion. Returns `{view, confidence}`. Scoring uses the confirmed view.
12. **Ranking.** Best and worst stroke, among those with stroke quality ≥ 0.6, minus any excluded strokes.
13. **Frame plan.**
    - Crop for each chosen stroke: union of target boxes over `[ready, ftStop]` plus wrist ± racket length (1.4 T badminton, 0.8 T pickleball), expanded 1.3×, snapped to 4:3 or 3:4, clamped to the frame.
    - **F1–F4:** best stroke, `upload:true`.
    - **F5:** overview crop at 2× the target box at the best contact, `upload:true`.
    - **L1–L4:** worst stroke, `upload:false`.
14. **Clean track.** `pose.clean.json` on the uniform grid, with `interp`, `strokes` and `phases`.

### 6.3 Rubric data (`_shared/rubric/*.json`, versioned)

The types are the same as v1.0, with these changes:
- `ruleFlag` is removed; MVP has no legality badges.
- `SkillDef` gains:
  - `contactOffsetMs: number`;
  - `views: { recommended: View[]; allowed: View[] }`;
  - `solo: boolean`;
  - `rulesTip: {vi, en}`, a static card.
- `injuryFlag` stays. Its fixed safety text ends with "nếu đau, hãy hỏi HLV/chuyên gia".
- `CheckpointDef.plain: {vi: {low, high}, en: {low, high}}` holds the plain-language evidence templates, e.g. "khuỷu tay còn gập khi chạm cầu".

**Content:**
- 6 launch skills plus the shared ready and split-step checkpoints.
- About 30 drills, bilingual.
- The 6 deferred skills are included but disabled.

**Integrity tests:**
- Weights sum to 100.
- Every `metric.fn` exists in the registry.
- Every fault has ≥ 1 drill and a valid `defaultDrill`.
- Every V checkpoint has 5 anchors.
- Every text has both `vi` and `en`.
- IDs are unique.
- Every enabled skill has `contactOffsetMs` and recommended views.

`rubric_version` = sha256 of the canonical JSON.

### 6.4 Scoring

- **Per metric, per checkpoint, V checkpoints (V share ≤ 35%), sub-scores (shown if coverage ≥ 0.4) and overall:** as in v1.0.
  - Coverage < 0.5 → `partial`, with no overall number.
  - Coverage < 0.8 → overall capped at 85.
- **Display:** `round(x/5)·5`, with a "beta" chip.
- **Level:** from the raw overall, banded 0–39 / 40–59 / 60–79 / 80–100. No hysteresis.
- **Candidates:**
  - Weaknesses: `s < 0.7 ∧ c ≥ 0.4`, ranked by impact; top 6.
  - Strengths: `s ≥ 0.85 ∧ c ≥ 0.6`; top 6.
  - Injury flags become fixed safety notes.
- **Hero** = the top surviving weakness after postprocess (§8.4).

### 6.5 Postgres

Conventions: `text` + `CHECK` instead of enums; RLS on every table; `(select auth.uid())` in policies; UUIDs compared as `uuid`.

**Tables (`public`):**

| Table | Key columns and changes from v1.0 |
|---|---|
| `profiles` | `id` → auth.users CASCADE (anonymous users included), `locale`, `handedness`, `level`, `birth_year` (CHECK against `app_config.min_user_age` via trigger), `age_attested`, `pdpl_consent_version/at`, `ai_consent_version/at`, `calibration_opt_in` (default false), `consumption_consent` (default false), `is_reviewer`. **No `display_name`.** |
| `analyses` | As v1.0, plus:<br>• `subject_minor`, `frame_mode` (`frames` / `pose_only`), `excluded_strokes int[]`, `view_confirmed`.<br>• `status` ∈ {prepared, queued, processing, succeeded, rejected, failed}.<br>• `attempt_count` (fencing), `next_attempt_at`, `locked_at`, `kind`, `max_tokens_mult`.<br>**`context` and `goal` removed.** |
| `analysis_results` | `analysis_id` PK, `user_id`, `sport`, `skill`, `subject`, `overall_score`, `display_score`, `level`, `coverage`, `partial`, `sub_scores`, `result` (coach-result.v1, full). **No direct client SELECT.** |
| `feedback` | (`analysis_id`, `user_id`) PK, `rating`, `comment` ≤ 500. |
| `plan_limits` | `tier` PK (free / trial / premium), `period_type` (`calendar_month` / `trial` / `subscription_month`), `total_limit`, `standard_limit`, `first_ever_standard` bool, `max_in_flight`, `free_retry_limit` (3), `features` jsonb `{full_report, progress, player, history_full_limit}`.<br>**Seed:**<br>• free (calendar_month, 2, 0, true, 1, 3, {false, false, false, 3})<br>• trial (trial, 10, 5, false, 1, 3, full)<br>• premium (subscription_month, 15, 15, false, 1, 3, full) |
| `model_routes` | Seed:<br>• basic → `claude-haiku-5-5` / medium / 12000 / 90 s / no fallbacks<br>• standard → `claude-sonnet-5-5` / **low** (pending the §8.1 sweep) / 12000 / 180 s / fallbacks `"default"` |
| `enabled_skills`, `app_config` | Feature flags; `min_user_age`, `consent_versions`, `budget_usd`. Readable by everyone. |
| `entitlements` | `user_id` PK, `tier`, `is_trial`, `product_id`, **`expires_at` = coalesce(grace_expires_at, expires_at)**, `period_anchor`, `will_renew`, `billing_issue`, `source`. |
| `app_store_subscriptions` | As v1.0, plus `transfer_count_30d`. |
| `usage_counters` | (`user_id`, `period_key`) PK, where `period_key` is `YYYY-MM` (ICT), `trial:<origTx>`, `sub:<origTx>:<windowStart>` or `lifetime`; `used`, `used_standard`, `retries_used`. |
| `quota_ledger` | `analysis_id` PK, `user_id`, `period_key`, `kind`, `state` (reserved / committed / refunded), `refund_reason`. |
| `events` | `id`, `user_id`, `name`, `props` jsonb (≤ 2 KB), `created_at`. 13-month retention. No client SELECT. |

**`private` schema:**
- `appstore_notifications`: `status` ∈ {received, processed, failed}.
- `apple_auth_tokens`.
- `llm_calls`: `model_requested`, `model_served`, `stop_reason`, `refusal_category`, the four usage meters, `cost_usd`, `attempt`.
- `llm_outputs`: raw model output; 90-day retention.
- `daily_spend`.
- `user_monthly_cost`.
- `link_transfers`.
- `audit_log`.

**Functions** (`SECURITY DEFINER SET search_path=''`; service-only unless marked):

| Function | Behaviour |
|---|---|
| `private.tier_of(uid)` | Premium or trial if `entitlements.expires_at > now()`. Grace is included because `expires_at` holds the coalesced value. |
| `private.reserve_for_submit(uid, aid, device_bonus_ok)` | **One transaction:**<br>1. `pg_advisory_xact_lock(hashtextextended(uid::text,0))`.<br>2. Verify `analyses.user_id = uid` and status `prepared`; if already queued or later, return idempotently.<br>3. If in-flight count ≥ `max_in_flight`, return `in_flight`.<br>4. Compute `period_key`. Premium uses monthly windows anchored on `period_anchor`.<br>5. `INSERT … ON CONFLICT DO NOTHING` the counter rows (period and lifetime), then `SELECT … FOR UPDATE`.<br>6. Check `total_limit`.<br>7. **Choose the kind:**<br>  • free: `standard` if `first_ever_standard`, lifetime not used and `device_bonus_ok`; otherwise `basic`;<br>  • trial and premium: `standard` while `used_standard < standard_limit`, otherwise `basic`.<br>8. Insert the ledger row (reserved), increment the counters, and set the analysis to `queued`.<br>Returns `{ok, kind, remaining, resets_at}` or an error code. |
| `private.claim_analysis(aid)` | `UPDATE … SET status='processing', locked_at=now(), attempt_count=attempt_count+1 WHERE id=aid AND ((status='queued' AND next_attempt_at<=now()) OR (status='processing' AND locked_at < now()-interval '8 min')) RETURNING attempt_count`. Zero rows means another worker owns the job. |
| `private.finalize_analysis(aid, attempt, result, …)` | Guarded by `WHERE attempt_count=attempt AND status='processing'`. Inserts `analysis_results ON CONFLICT DO NOTHING`, commits or refunds quota per §8.3, sets the status, and returns whether it applied. |
| `private.requeue_analysis(aid, attempt, delay_s, code)` / `private.fail_analysis(aid, attempt, code)` | Fenced the same way. `fail` refunds. |
| `private.refund_quota(aid, reason)` | Infrastructure reasons always refund. `rejected` and `partial` refund only while `retries_used < free_retry_limit`, and then increment `retries_used`. |
| `private.dispatch_due_jobs(n)` | Selects due jobs (queued ≥ 15 s old with `next_attempt_at` reached, or stale processing). Sends one `net.http_post` per job (default 5 s timeout) to `/analyze/run`. |
| `private.recompute_entitlement(uid)`, `private.transfer_subscription(orig_tx, to_uid)` | Transfers are limited to 3 per 30 days per `originalTransactionId`, with an audit row. |
| `my_status()` | Authenticated. Returns `{tier, used, limits, resets_at, bonusAvailable, features, copy}`. |
| `get_result(aid)` | Authenticated. Checks ownership, then **redacts by the current tier**. Free keeps the hero, scores and 1 strength, with counts for the locked parts. Uses `auth.uid()`. |
| `get_history(limit)` | Authenticated. Free gets the last 3 in full and stubs for the rest. |
| `get_progress(sport, skill)` | Authenticated, premium or trial only, `subject='self'` only. Uses `auth.uid()`. |
| `log_event(name, props)` | Authenticated. Names come from an allowlist; props ≤ 2 KB; at most 300 per day per user. |

**RLS and grants:**
- `analyses`: SELECT own, with **column grants** limited to id, sport, skill, status, failure_code, camera_view, subject, created_at, completed_at. DELETE own. No insert or update from clients.
- `analysis_results`, `events`, `model_routes`, `quota_ledger`, `private.*`: no client access.
- `feedback`: INSERT and SELECT own, `WITH CHECK (exists (select 1 from analyses a where a.id = analysis_id and a.user_id = (select auth.uid())))`.
- `profiles`: SELECT and UPDATE own. Column grants allow `locale`, `handedness`, `level`, `birth_year`, `age_attested`, the consents and the opt-ins.
- `entitlements`, `usage_counters`: SELECT own.
- `plan_limits`, `enabled_skills`, `app_config`: SELECT for all.
- `current_tier`-style uid-taking functions are never granted to clients.

**Cron migration** (`0900`):
- `* * * * *` → `private.dispatch_due_jobs(5)`.
- `17 20 * * *` UTC (03:17 ICT) → `/cron {daily}`.
- Secrets come from Vault.

### 6.6 Storage and retention

| Bucket | Paths | Policies (each scoped by `bucket_id`; no `ALTER TABLE storage.objects`) |
|---|---|---|
| `analysis-inputs` (private; 2 MB; `image/jpeg`) | `{uid}/{aid}/frames/F1..F5.jpg` | Authenticated **INSERT, SELECT, UPDATE and DELETE** where `bucket_id='analysis-inputs' AND (storage.foldername(name))[1] = (select auth.uid())::text` (upsert needs SELECT and UPDATE) |
| `analysis-derived` (private; 2 MB; `application/json`) | `{uid}/{aid}/pose.raw.json`, `pose.clean.json` | **SELECT and DELETE only**, `bucket_id='analysis-derived'` and own folder. Writes by the service role only |

**Retention (the `daily` cron task):**

| Data | Rule |
|---|---|
| Key frames | Deleted at finalize. A 72 h cap applies to failed or abandoned jobs |
| `prepared` rows | Deleted after 24 h, together with their files |
| Orphan folders | Removed by a recursive walk |
| Pose JSON | Deleted with the analysis or account, or after **24 months of user inactivity** |
| `llm_outputs` | 90 days |
| `events` | 13 months |

---

## 7. Data contracts

Zod lives in `_shared/contracts`. `gen-schemas.ts` exports `shared/schemas/*.json` and **audits the coach schemas** (§12, M1). Deno tests validate the fixtures; Swift tests decode them by value.

### 7.1 `pose.v1`

Changes from v1.0:
- `track.t` is replaced by **`track.tUs`**: exact asset-timeline PTS of the exported clip, in microseconds, as Int64.
- `session` drops `context` and `goal`, and adds `subjectMinor: bool`.
- `cameraView` may be `"auto"`.
- `analysisId` is lowercase.
- `video.display` is the composition render size.
- `video.mirrored` keeps its meaning.

**Server checks:**
- `subject=other ⇒ subjectConsent`;
- `subjectMinor ⇒ subject=other` (forces `frame_mode=pose_only`);
- the skill is enabled and belongs to the sport;
- `analysisHz ∈ {30, 60}`;
- duration 3–32 s;
- `tUs` strictly increasing.

### 7.2 `reprepare.v1`

```json
{ "schema":"reprepare.v1", "analysisId":"…", "cameraView":"diagonal",
  "excludedStrokeIds":[3], "handedness":"right" }
```

### 7.3 `prepare-response.v1`

```json
{ "schema":"prepare.v1", "analysisId":"…", "status":"prepared", "frameMode":"frames",
  "warnings":["fps_low","view_low_confidence"], "viewGuess":{"view":"diagonal","confidence":0.62},
  "handednessSuggestion":null,
  "strokes":[{"id":1,"tStartUs":13420000,"tContactUs":13910583,"contactIsEstimate":true,"tEndUs":14300000,
              "phases":{"ready":12900000,"bsEnd":13760000,"contact":13910583,"ftStop":14120000},
              "quality":0.82,"role":"best","thumbTUs":13910583}],
  "frameRequests":[{"frameId":"F1","strokeId":1,"phase":"ready","tUs":12900000,"crop":{"x":0.38,"y":0.09,"w":0.33,"h":0.62},"upload":true},
                   {"frameId":"F5","strokeId":1,"phase":"overview","tUs":13910583,"crop":{…2× box…},"upload":true},
                   {"frameId":"L1","strokeId":4,"phase":"ready","tUs":…,"crop":{…},"upload":false}],
  "maxLongEdge":768, "cleanTrackPath":"{uid}/{id}/pose.clean.json",
  "quota":{"tier":"free","remaining":1,"nextKind":"standard","resetsAt":"2026-11-01T00:00:00+07:00"} }
```

Rejection form: 422 `{code, tips[]}`, where each tip is a String Catalog key. Ownership conflict: 409.

### 7.4 Claude output: `coach.v1` (one schema per sport)

The `$defs` hold the enums **once**:
- `CheckpointId`: this sport's checkpoints, about 40.
- `VisualCheckpointId`.
- `FaultId`: plus `"none"`.
- `Evidence`, `Strength`, `Weakness`, `Improvement`.

Properties are `$ref`'d. The schema uses no numeric, length, `minItems` or `pattern` constraints, sets `additionalProperties:false` everywhere, and marks every field required.

Top-level `required`:
- `schema_version`
- `language`
- `input_check`
- `visual_checkpoints`
- `summary`
- `strengths`
- `weaknesses`
- `improvements`
- `safety_notes`
- `not_assessable`
- `recording_tips`

`stroke_notes` is **removed** to save output tokens.

`Evidence` = `{stroke_id, frame_id ("F1".."F5" or ""), metric_key (CheckpointId or ""), observation}`. **`observation` must contain no digits.** The server appends the measured value under "Chi tiết".

### 7.5 Stored result: `coach-result.v1` (returned only through `get_result`)

```ts
{ schema:"coach-result.v1", analysisId, sport, skill, narrativeLanguage, createdAt, status, rejection,
  access: "full"|"free", locked: { strengths:number, weaknesses:number, plan:number },
  aiGenerated: true,
  hero: { checkpointId, faultId, title, observation, cue:{vi,en}, drill:{…}, frameId /* F#|L# */, joints:string[] } | null,
  overall: { displayScore:number|null, level, coverage, partial, beta:true },
  subScores: [{ key, displayScore:number|null, coverage, confidence, name:{vi,en} }],
  checkpoints?: [...]  /* full only */,
  strengths: [...], weaknesses: [...], plan: [...],   // redacted to hero-adjacent items for free
  strokes: [{ id, tStartUs, tContactUs, contactIsEstimate, tEndUs, phases, role }],
  safety:[...], notAssessable:[...], recordingTips:[...], rulesTip:{vi,en}, summary,
  meta:{ model, kind, promptVersion, rubricVersion, algoVersion, schemaVersion } }
// Evidence = { strokeId, tUs, frameId, metricKey, observation, plain:{vi,en}, detail:{valueText,targetText}, joints }
```

---

## 8. Claude integration

### 8.1 Model per tier (`model_routes`)

| Kind | Who | Model | Effort (initial) | max_tokens | Timeout | Fallbacks |
|---|---|---|---|---|---|---|
| `basic` | Free after the first analysis; trial after its 5 standard analyses | `claude-haiku-5-5` | `medium` (set explicitly) | 12000 | 90 s | none (not supported) |
| `standard` | Premium, the first 5 trial analyses, the free first-ever analysis | `claude-sonnet-5-5` | **`low`** | 12000 | 180 s | `"default"` (beta `server-side-fallback-2026-07-01`) |

**Request rules:**
- No sampling parameters, no `thinking` field (adaptive), no prefill, no `tool_choice`.
- SDK `maxRetries: 0`; one call per invocation.
- Response blocks are read by `type`.
- `max_tokens` is multiplied by `analyses.max_tokens_mult` on a retry.

**Effort sweep (M6, then again at M17):**
- Sonnet `low` vs `medium`, and Haiku `low` vs `medium`.
- Measured on the eval set: grounding violations, MAE of visual levels, VI quality as rated by the coach, cost.
- The cheapest level within 2 points of the best on the quality metrics wins.

**Haiku VI quality** gets its own eval (20 outputs rated by the coach). If it fails, the free route moves to Sonnet `low` and the free cap stays at 2.

### 8.2 Request layout (`build_request.ts`)

```ts
{ model, max_tokens, betas?: ["server-side-fallback-2026-07-01"], fallbacks?: "default",
  system: [ { type:"text", text: BASE_SYSTEM_V2 },
            { type:"text", text: RUBRIC_TEXT[sport], cache_control:{type:"ephemeral"} } ],   // prefix per (model × sport) = 4
  messages: [{ role:"user", content: [ /* F1..F5: label text + image (none in pose_only) */, { type:"text", text: userText } ] }],
  output_config: { effort, format: { type:"json_schema", schema: COACH_OUTPUT_V1[sport] } } }
```

**`BASE_SYSTEM_V2`** keeps the v1.0 sections, with these changes:
- Pick findings **only** from `<candidates>` or from visual judgments with confidence ≥ medium.
- `observation` is plain language, **with no numbers or units**.
- In pose-only mode, set every visual checkpoint to −1.
- Contact times are estimates.
- No diagnoses, no medical terms.
- Style: "bạn", ≤ 8-word cues, summary ≤ 3 sentences.
- Write all free text in the "Output language".

The goal field and context are removed.

**`userText` blocks:**
- `<session>`: frame mode and confirmed view.
- `<quality>`.
- `<checkpoints>`.
- `<strokes>`.
- `<candidates>`.
- `<visual_to_judge>`.
- Last line: `Output language: vi|en`.

**Caching:**
- System blocks are byte-identical across languages and users; a snapshot test asserts this.
- Schema and rubric changes are versioned deploy bumps.
- `usage.cache_read_input_tokens` is logged on every call.

**Grammar warm-up:**
- `scripts/warm-schemas.ts` runs after each deploy: per model × sport, a `max_tokens: 64` call with the real schema, accepting `stop_reason: max_tokens`.
- The `cron warm` task repeats it if no call has used that schema in the last 20 h.

### 8.3 `runOnce` outcomes (one Claude attempt per invocation)

**Before calling Claude:** if `analysis_results` already exists for this analysis, only finalize. This covers a crash after the insert.

| Outcome | Action |
|---|---|
| Valid output | Postprocess, then `finalize_analysis` (fenced): status `succeeded`, quota committed, frames deleted |
| `stop_reason:"refusal"` (any category, any model, before or after a fallback) | `fail` with code `model_refusal`. **Full refund**, which does not use the retry allowance. Log `stop_details.category` and `model_served` |
| `max_tokens` | `requeue` with `max_tokens_mult=1.5`, once; a second time → `fail bad_output` with refund |
| Parse or Zod failure | `requeue` once; a second time → `fail bad_output` with refund |
| 429 / 529 / 5xx / timeout / network | `requeue`, delay 30 s·2^attempt; after 3 attempts → `fail upstream_unavailable` with refund |
| 400 (including "Schema is too complex") | `fail bad_request` with refund, plus an operator alert |
| Fencing lost (finalize applies to 0 rows) | Discard the output; the cost is still logged |

Every attempt writes `private.llm_calls`. Cost comes from the four usage meters at the price of `model_served`, and is added to `daily_spend` and `user_monthly_cost`.

### 8.4 Post-processing (`postprocess.ts`, pure)

1. **Input check.** If `is_assessable=false`, or `sport_matches=false`, or (`skill_matches=false` ∧ visibility `poor`): status `rejected` with tips. Refund under the retry cap (§6.5).
2. **Case-insensitive enums.** Normalise every enum value (checkpoint, fault, severity, …) against the canonical list; drop values that do not match.
3. **Visual checkpoints.** Keep this skill's V IDs only; clamp the level to −1..4; drop unknown `frame_ids`. In pose-only mode, force −1.
4. **Grounding filter**, as in v1.0 (candidate or confident visual item; valid `metric_key`, `frame_id` and `stroke_id`). Additionally, strip digit and unit tokens from `observation`; if what remains is shorter than 3 words, replace it with the catalog `plain` template.
5. **Deterministic override.** Applies when the top weakness candidate has c ≥ 0.6, its impact is ≥ 1.5× the next candidate's, and Claude omitted it. It is inserted with catalog text and logged.
6. **Hero** = the first surviving weakness. Its frame is the phase frame of the stroke the evidence refers to: best stroke → F#, worst stroke → L#.
7. **Improvements.** At most 3; drill IDs must be in the fault's list, otherwise `defaultDrill`; localized catalog content is attached.
8. **Medical filter.**
   - Text is normalised with NFC and lowercased.
   - Patterns use the `u` flag with `(?<![\p{L}\p{N}])term(?![\p{L}\p{N}])`, so "tear" does not match "teardrop".
   - The EN and VI term lists are reviewed by the coach.
   - A hit is replaced with a generic `see_professional` note and logged.
9. **Compose scores** (§6.4). Coverage < 0.5 → `partial`, refunded under the cap. Attach the injury safety notes and the rules tip.
10. **Finalize.**

### 8.5 Language handling

As in v1.0. If the UI language differs from the narrative language, Results shows "Nhận xét được viết bằng tiếng Anh".

### 8.6 Hallucination controls

As in v1.0, plus:
- no numbers in model text;
- per-sport enums;
- case-insensitive matching;
- schema compile tested live at M6.

### 8.7 Cost estimate (per analysis, VI output, 5 frames)

**Assumptions:**
- Cached system ≈ 7K tokens.
- Uncached input ≈ 6.4K tokens: 5 frames × about 588, plus about 3.5K of tables.
- Output JSON ≈ 2.5K tokens.
- Thinking: Sonnet `low` ≈ 0.8K, Sonnet `medium` ≈ 2.5K, Haiku `medium` ≈ 1.5K.
- Haiku token counts × 1.3.

| Route | Warm cache | Cold cache | ≈ VND (26,000₫/$) |
|---|---|---|---|
| Sonnet 5.5 `low` | 6.4K×2 + 7K×0.20 + 3.3K×10 ≈ **$0.047** | ≈ $0.063 | 1,200–1,650₫ |
| Sonnet 5.5 `medium` | ≈ $0.064 | ≈ $0.080 | 1,650–2,100₫ |
| Haiku 5.5 `medium` | 8.3K×0.10 + 9.1K×0.01 + 5.2K×0.50 ≈ **$0.0035** | ≈ $0.0045 | 90–120₫ |

**M6 live smoke test** (needs the user's approval; about $0.50) measures:
- schema compile on both models and both sports;
- real token counts;
- a cache read on the second call.

The `standard_limit` rule is then applied (§9.3).

**Spend controls:**
- **Daily budget**, `app_config.budget_usd`, starting at $30. At 70%, an alert fires and free standard requests are downgraded to basic. At 100%, free submits get 503 `busy_try_later` and **no quota is reserved**. Paid users, trial users and `is_reviewer` accounts are always served, up to a hard 2× cap.
- **Per user:** an alert when monthly LLM cost exceeds 60% of the estimated proceeds.
- A dedicated Anthropic workspace with a monthly spend limit.
- In-flight caps.
- Idempotent submit.

---

## 9. Subscriptions, quotas, pricing

### 9.1 App Store Connect

**Subscription group "Premium":** `…premium.monthly` and `…premium.yearly`.
- Both products at the same level.
- **7-day free trial on yearly only.**
- Family Sharing off.
- Billing Grace Period: 16 days.
- Small Business Program (15%).
- Notifications V2: Production and Sandbox URLs both point to `/appstore-webhook`.

**Metadata:**
- The **Terms of Use (EULA) link appears in both the VI and EN descriptions**.
- Privacy Policy URL and **Support URL**.
- Category **Sports**.
- The age-rating questionnaire is answered consistently with the in-app 18+ gate; check the **Vietnam rating (Decree 147)** before submission.
- The first submission includes the subscriptions and a paywall screenshot.
- **Availability, Phase 1: Vietnam only.**

### 9.2 Pricing

| Plan | Vietnam (manual) | Phase 2 |
|---|---|---|
| Monthly | **79,000₫** | $9.99 base, with manual lower tiers for ID, MY, TH, PH and IN |
| Yearly | **599,000₫**. The "≈ X/tháng" caption is computed from the `Product`, never hard-coded, and is smaller than the billed price | $59.99 base, same overrides |

**Phase 2 prerequisites:**
- DeclaredAgeRange integration before the US launch (Utah and Louisiana rules);
- China mainland deselected;
- EU skipped until trader status and SCCs covering Anthropic are in place.

### 9.3 Quotas (server-enforced; values in `plan_limits`; shown in the paywall)

| | Free | Trial (7 days) | Premium |
|---|---|---|---|
| Analyses | **2 per calendar month (ICT)**. The first-ever uses Sonnet (labelled "Phân tích nâng cao miễn phí lần đầu"), counts toward the 2, and is DeviceCheck-guarded | **10 total**: first 5 Sonnet, then Haiku | **15 per subscription month**, Sonnet; windows anchored on the purchase day |
| Rejected or partial refunds | Up to 3 per period | 3 | 3 |
| In-flight | 1 | 1 | 1 |
| Report | Hero (#1 fix, cue, drill, key frame), scores, 1 strength | Full | Full |
| Video player, Progress, full history | No (history: last 3) | Yes | Yes |

**Cap messaging:**
- Free users see the paywall.
- Trial and Premium users see "Lượt mới vào <ngày>". A trial user who runs out sees "Gói năm bắt đầu <ngày>".

**`standard_limit` rule (applied after the M6 smoke test and reviewed monthly):**

`standard_limit = min(15, floor(0.8 × VN-yearly proceeds per month ÷ measured p90 Sonnet cost))`.

If the result is below 15, the remainder becomes Haiku analyses, and the paywall copy updates from the server.

**Unit economics** (Apple assumed to deduct 10% VAT, plus 15% commission; re-modelled per legal entity at gate G1):

| Case | Calculation |
|---|---|
| VN monthly proceeds | ≈ 61k₫ ≈ **$2.35** |
| VN yearly proceeds | ≈ 38.6k₫ ≈ **$1.48 per month** |
| Premium worst case | 15 × $0.063 = **$0.95/month**, a 36% margin on yearly VN |
| Premium typical | About 6 analyses ≈ **$0.30** |
| Trial worst case | 5 × $0.063 + 5 × $0.0045 ≈ **$0.34** |
| Free | ≈ $0.07 for the first-ever analysis, then ≈ $0.004 per analysis |

### 9.4 Entitlement sync (`verify-subscription`)

**Client:**
- `SubscriptionStoreView(productIDs: [monthly, yearly])`.
- `.inAppPurchaseOptions { _ in [.appAccountToken(uidLower)] }`.
- `.storeButton(.visible, for: .restorePurchases, .redeemCode, .policies)`.
- `.subscriptionStorePolicyDestination` for both Terms and Privacy.
- `.onInAppPurchaseCompletion` → `sync`.
- The finish policy is in §5.2.

**Server, in order:**
1. **Decode the JWS without trusting it.** Read `transactionId`, `environment`, `bundleId` (must equal `APPLE_BUNDLE_ID`).
2. **Xcode environment.** Allowed only when `ALLOW_XCODE_ENV=true` (dev project). It **skips the Apple API** and uses the decoded payload; optionally it verifies against the Xcode StoreKit test certificate exported at M15.
3. **Otherwise**, call `GET {host}/inApps/v1/subscriptions/{transactionId}`.
   - Hosts default to `api.storekit.apple.com` and `api.storekit-sandbox.apple.com`, overridable by env.
   - Auth is an ES256 JWT.
   - Decode the returned `signedTransactionInfo` and `signedRenewalInfo`; trust comes from TLS to Apple.
4. **Linking policy.** The token always comes from **Apple's fetched transaction**.

   | Case | Action |
   |---|---|
   | Token equals the caller | Link |
   | Token is null, belongs to a deleted user, or belongs to an anonymous user merged into the caller (offer codes usually carry no token) | Verify the **client JWS chain** with `jws.ts` (Apple Root CA G3 plus OIDs). If valid: link, then **Set App Account Token** (`originalTransactionId` → caller uid) |
   | Token belongs to a different live user, and `reason == restore` | `transfer_subscription`: rate-limited (3 per 30 days), audited, both users recomputed, Set App Account Token. Response `{transferred:true}`. The app says "Đã chuyển gói Premium về tài khoản này" |
   | Token belongs to a different live user, any other reason | 409 `linked_to_other_account`. The app says "Gói đang gắn với tài khoản khác — bấm Khôi phục để chuyển về đây". The transaction is still finished |
5. **Persist and answer.** Upsert, `recompute_entitlement` (`expires_at` = coalesce with grace; `period_anchor`). Return `{tier, productId, expiresAt, willRenew, inGrace, billingIssue, isTrial}`.
6. **Gating.** The app gates features only on `my_status()` and `get_result`.

### 9.5 Webhook (`appstore-webhook`)

Steps:
1. Decode `signedPayload`.
2. `INSERT … ON CONFLICT DO NOTHING`. **Short-circuit with 200 only if the existing row has `status='processed'`**; otherwise process again (processing is idempotent).
3. **Act only on Apple's re-fetched status.** A REFUND or REVOKE effect requires status 5 or a `revocationDate` in the re-fetched transaction; the payload alone never downgrades anyone. Verifying the `signedPayload` chain with `jws.ts` is an extra check.
4. Upsert, recompute, set `processed`, return 200. Return 500 only on a transient failure, so Apple retries.

| Type | Effect |
|---|---|
| CONSUMPTION_REQUEST | If `profiles.consumption_consent`, call **Send Consumption Information** with usage data; otherwise log only |
| Everything else | As in v1.0 |

The daily job calls notification history for the last 26 h on **both Production and Sandbox**.

### 9.6 StoreKit configuration file

`Products.storekit` is created in Xcode at M15, **synced with App Store Connect**. It contains the group, both products, the yearly trial and VI/EN names. `check_ios_resources.py` asserts its product IDs equal the `StoreService` constants whenever the file is present.

---

## 10. Localization

### 10.1 Mechanics

- **String Catalogs:** `Localizable.xcstrings` and `InfoPlist.xcstrings`.
  - Semantic keys with translator comments.
  - EN plurals via catalog variations.
  - CI fails if any key is not translated in both VI and EN.
- **`NSCameraUsageDescription`:**
  - **VI:** "Ứng dụng dùng camera để quay cú đánh của bạn. Video được phân tích trên máy và không bị tải lên. Chỉ dữ liệu tư thế và tối đa 5 ảnh tĩnh (đã tự động làm mờ khuôn mặt) được gửi đi để AI phân tích, sau khi bạn đồng ý."
  - **EN:** "RacketCoach uses the camera to record your strokes. The video is analyzed on your iPhone and never uploaded. Only pose data and up to 5 still images (faces automatically blurred) are sent for AI analysis, after you agree."
- **Default language:** VI when the storefront or region is Vietnam. System sheets follow iOS; Settings explains this. Custom paywall copy is kept minimal.
- **Formatting:** locale formatters for numbers and dates; prices from `Product.displayPrice` and `priceFormatStyle`.
- **Spelling and layout:** **US English** ("Analyze"). Dynamic Type supported; tested at XL sizes with long VI strings (M14).

### 10.2 Vietnamese terminology (app copy; every row marked (?) until the coach review at M17)

| EN | VI | EN | VI |
|---|---|---|---|
| Overall score | Điểm tổng | Stance & Balance | Tư thế & Thăng bằng |
| Footwork | Di chuyển (bộ pháp) | Swing mechanics | Kỹ thuật vung vợt |
| Contact point | Điểm chạm cầu / Điểm chạm bóng | Follow-through | **Kết thúc động tác** |
| Recovery | **Về vị trí (hồi vị)** | Strengths / Weaknesses | Điểm mạnh / Cần cải thiện |
| Fix this first | Sửa điều này trước | Drill | Bài tập |
| Clear / Smash | Phông cầu / Đập cầu | Low serve | Giao cầu thấp |
| Split step | Bật nhún (split step) | Ready stance | Tư thế chuẩn bị |
| Kitchen (NVZ) | **Kitchen (vùng cấm vô lê)** | Volley | **Vô lê** |
| Third-shot drop | Drop cú thứ ba | Dink / drive / reset | Kept in English |
| Weight transfer | Chuyển trọng tâm | Not enough data | Chưa đủ dữ liệu |
| Beginner … Advanced | Mới bắt đầu / Đang tiến bộ / Trung cấp / Nâng cao | AI-generated | Nhận xét do AI tạo, có thể chưa chính xác |

**Copy style:**
- "bạn", with short imperative cues.
- Fault cards follow the pattern Vấn đề → Cách sửa → Bài tập.
- Write "chưa đến", not "chưa tới".
- Never claim a DUPR rating or club "trình".
- Never write "chuẩn như HLV" or "phòng chấn thương".

### 10.3 Camera guide (`docs/camera-guide.*.md`, also in the app)

1. Landscape, on a tripod or clamp. **Mounting ideas:** net-post clamp, fence clamp, back-wall shelf.
2. 1× lens.
3. **Badminton:** behind the court, raised (back wall or fence), or at the **back-corner diagonal**. The side view only when there is ≥ 4 m of free space.
4. **Pickleball:** from the sideline fence, level with the hitting spot, 3–5 m away; or diagonal.
5. **"Khi không đặt được máy bên hông"** section: use the behind or diagonal view. The app shows what each view cannot measure.
6. Whole body and racket in frame, with the player filling ½–⅔ of the height. In-app recording checks this live.
7. 60 fps. In-app recording is fixed at 60 fps. For the Camera app, choose 1080p HD at 60 fps and **turn off "FPS tự động"**, which drops to 24/30 fps in dim halls. The Settings path is verified on a VI-language iPhone at M12.
8. Even light, no backlight (outdoor pickleball: keep the sun behind the camera).
9. Only the player in frame if possible; otherwise the app asks you to tap them.
10. 5–10 repetitions of ONE stroke in at most 30 s. "Nhờ bạn đánh cầu/bóng cho bạn"; serves can be practised alone.

---

## 11. Compliance checklist

| Requirement | Code / artifact | Milestone |
|---|---|---|
| **5.1.1(v)**: no forced registration | Anonymous sign-in; IAP works without an account; sign-in is optional for saving history | M10 |
| **5.1.2(i)**: third-party AI consent | JIT consent (§2.2 step 5) naming Anthropic, listing the data, best-effort blur wording, Anthropic retention stated; `submit` returns 403 without it; withdraw in Settings | M10 / M7 |
| Truthful privacy wording | Camera string (§10.1); "best effort" in consent, privacy policy and review notes; never "all faces" | M10 / M16 |
| Bystanders and minors in frames | Non-target masking, head box and fail-closed blur; F5 cropped; subject under 16 → guardian attestation and pose-only; device blur tests | M13 |
| User age | Birth year; 18+ (`app_config`); 16–17 only after counsel sign-off and documented Anthropic minor safeguards | M10 / G2 |
| **5.1.1(v)**: account deletion | `delete-account` for every account type, including the SIWA revoke and the subscription notice | M9 / M16 |
| **3.1.2**: paywall | Billed amount most prominent; computed per-month caption only, smaller; **exact quotas disclosed**; Terms and Privacy in the app; **EULA in App Store metadata**; Restore in the paywall and in Settings | M15 / M16 |
| **3.1.1**: IAP only | StoreKit 2; Offer Codes only | M15 |
| **4.8**: login | Sign in with Apple is offered; the only other method is email | M10 |
| **2.1**: reviewability | Demo mode; sample clip analysis under 90 s; anonymous flow; reviewer flag exempt from the budget; **tested in iPad compatibility mode**; Support URL | M16 |
| Privacy manifest and label | `NSPrivacyTracking=false`. Collected, linked, not tracking:<br>• EmailAddress (if linked)<br>• UserID<br>• PhotosorVideos (key frames)<br>• OtherUserContent (pose)<br>• Fitness<br>• PurchaseHistory<br>• **ProductInteraction**<br>• **OtherUsageData**<br>No Name (not collected).<br>Accessed APIs: UserDefaults `CA92.1`, FileTimestamp `C617.1`, DiskSpace `E174.1`.<br>Confirm supabase-swift ships its own manifest | M10 / M16 |
| Usage descriptions | Camera only | M10 |
| Export compliance | `ITSAppUsesNonExemptEncryption=NO` | M10 |
| No medical claims | Prompt rule; normalised medical filter; fixed safety text; footer; category Sports; App Store copy without "phòng chấn thương" | M6 / M14 / M16 |
| **Vietnam AI Law 134/2025** | "Nhận xét do AI tạo, có thể chưa chính xác" on every result; track the implementing decree | M14 / G2 |
| Vietnam App Store age rating (Decree 147) | Questionnaire answered consistently; VN rating checked | M16 |
| **PDPL / Decree 356** | JIT consent for processing and cross-border transfer (Supabase SG, Anthropic US); separate calibration opt-in; access and deletion in the app; **DPIA and CTIA filed**; retention limits (§6.6); MOIT e-commerce app notification checked with counsel | G2 |
| Data localisation (Cybersecurity Law 116/2025) | Counsel decides at G1. Contingency CT-1: a nightly encrypted export of user tables to VN-hosted object storage | G1 |
| Consumption info (refund requests) | Only with `consumption_consent` | M15 |

**Gates:**
- **G1**, before M15 pricing is final and before launch: legal entity, tax and proceeds model per entity type, data-localisation answer.
- **G2**, before external TestFlight: counsel sign-off on the consent texts, the age policy, the DPIA and CTIA, and MOIT.

---

## 12. Build order (milestones)

"Linux" means verified in this container. "Mac" and "iPhone" mean the user verifies it.

| # | Milestone | Done when |
|---|---|---|
| **S1** | **Deploy spike (day 1, Mac):** `spike` function importing every pinned dependency | Mac: deployed with the CLI and curled. It reports `Deno.version`; WebCrypto ES256 and P-384 verify; `waitUntil` survives 60 s after the response; a `beforeunload` event fires; the region header is honoured; `JSON.parse` + Zod of a 1.2 MB pose takes < 1 s of CPU. Results go into the README, and `check.sh` is pinned to the reported Deno version if npm publishes it |
| M0 | Scaffold: tree, `deno.json` (`"lock": false`), `config.toml`, `project.yml` (iPhone only, portrait, no `knownRegions`), `check.sh`, README | Linux: fmt, lint, check; `check_ios_resources.py` (including the xcconfig `//` ban). Mac: `xcodegen generate`, build; the generated project lists `vi` |
| M1 | Contracts: pose.v1 (`tUs`), reprepare, prepare.v1, per-sport coach.v1, coach-result.v1, `gen-schemas` | Linux: fixtures validate; schemas in sync; **schema audit fails** on minimum/maximum, minLength/maxLength, maxItems, minItems > 1, pattern, `$schema`, recursion, non-false additionalProperties, or a duplicated enum outside `$defs`; the `z.toJSONSchema` output is inspected |
| M2 | Rubric: 6 enabled skills plus 6 disabled, about 30 drills, `plain` templates, rules tips, rubric text | Linux: integrity tests; `RUBRIC_TEXT` snapshot; size estimate |
| M3 | CoachCore core (IDs, Model, Geometry with RoiMapper, Sampling, Tracking, Payload) + **PoseDump** + **labeler**. **User, in parallel:** 20–30 real clips across the 6 skills in 2–3 halls, from the S, B and D views; the coach labels contact frames | Mac: `swift test`; PoseDump writes `real_*.json` into `shared/fixtures`. Linux: real fixtures validate against pose.v1 |
| M4a | Engine: normalize, swap fix, Hampel on residuals, resample with gap fill, SG; synthetic generator (VFR, 20–30 T/s, reversals) | Linux: unit tests; VFR synthetic → speeds within 5% of the uniform-sampled truth |
| M4b | Segmentation, phases, **contact offsets fitted** (`fit-contact-offsets.ts`), hop rule | Linux, on **real labelled clips**: after the offset, median contact error ≤ 1 frame at 60 Hz, recall ≥ 90%, precision ≥ 90% per skill. Synthetic tests are kept as regression tests only |
| M4c | Metrics, checkpoints, scoring, display rounding, candidates | Linux: golden values; coverage and cap rules |
| M4d | Ranking, frame plan (PTS snapping, F/L frames), view guess, `prepare` / `reprepare`, bench | Linux: golden prepare responses; every frame `tUs` is a sampled PTS; bench < 300 ms excluding parse |
| M5 | SQL 0100–0700 + seed | Linux, PG16 with the shim:<br>• RLS isolation; **column grants** (a free user cannot read `result` or `prepared`); `get_result` redaction by tier.<br>• **Concurrency** (`concurrency.sh`: 2 parallel `psql` sessions) on `reserve_for_submit`: no double booking, in-flight enforced, bonus used once.<br>• Claim/finalize **fencing**; refund cap; grace in `tier_of`.<br>• **Storage policy matrix**: bucket-scoped; upsert needs UPDATE; no client writes to `analysis-derived`.<br>• Feedback ownership; cascades |
| M6 | Claude module: base prompt, per-sport schema, request builder, `runOnce`, postprocess (enum case, digit stripping, medical NFC), compose. **Live smoke (approval, ≈ $0.50):** compile on both models and both sports, cost, cache read, initial effort sweep | Linux: prompt byte-identical for VI and EN; request snapshot; mocked outcomes (refusal with category, max_tokens requeue, 529 backoff, invalid IDs, capitalised enums, numbers in `observation`, "teardrop"); `replay.ts --mock` on a real fixture. Live: report saved in `docs/economics.md`; `standard_limit` set by the §9.3 rule |
| M7 | `analyze` (catalog / prepare / submit / run), `cron`, `dispatch_due_jobs`, budget guard, 0900 migration | Linux: handler tests with fakes covering 409 ownership conflict, idempotent submit, 402/403/429/503 without reservation, one attempt per invocation, stale re-claim after 8 min, results-exist → finalize only |
| M8 | Apple subscriptions: `jwt`, `api` (new hosts, Set App Account Token, Send Consumption Information, notification history for both environments), `jws`, `linking`, `verify-subscription`, `appstore-webhook` | Linux: openssl chain pass/fail; **linking matrix** (caller token, null, deleted user, merged anonymous user, other user + restore → transfer, rate limit, offer code); webhook re-processes non-processed duplicates; REFUND without a re-fetched status 5 is a no-op; Xcode env bypass only with the flag |
| M9 | Accounts: `apple-auth-exchange`, **`account-merge`**, `delete-account` (recursive, anonymous included), `devicecheck.ts` | Linux: mocked Apple and Storage; merge moves rows and objects and is idempotent; delete re-run is idempotent; recursive walk (2,500 nested objects → 3 batches) |
| M10 | iOS shell: anonymous auth, L10n (storefront default), catalogs, Info/xcprivacy, About-you, JIT consent, Apple and email linking with the merge path, catalog fetch, events | Linux: resources check. Mac/iPhone: anonymous launch offline and online; link Apple to a fresh account; link to an existing account → merge; VI/EN switch; **lowercase-UUID test** |
| M11 | CoachCore remainder: Quality, Crop, Overlay, `KeyFrameSkeleton`, result decoding | Mac: `swift test` against the fixtures (decoded comparison) |
| M12 | Capture: live framing, recorder (≤ 30 s, 60 fps), Photos/Files/"Open in", trimmer with passthrough export, backup exclusion, auto-clean | iPhone: `nominalFrameRate` ≈ 60; HDR import looks correct; Zalo "Open in" works; exported segment ±1 s; the "FPS tự động" path checked on a VI iPhone; camera placement tested in 3–5 halls |
| M13 | Pipeline: composition reader, ROI tracking, rate benchmark (warm-up discarded), background checkpoint and resume, prepare → Confirm screen → reprepare, key frames (tolerance check), **PrivacyMasker**, upload, submit, poll, offline resume; "Export pose JSON" | iPhone: sample clip end to end; **blur test set** (profile, back of head, far, motion blur, bystanders) reviewed by hand; mirrored clip L/R correct; background resume works. **Loop-back:** device fixtures replayed on Linux |
| M14 | Results (hero, rounded scores, beta, plain evidence → key frame, locked counts, AI label), History, Progress (self only), player, 7-day reminder | Simulator: previews from `results/*` fixtures (free and full); Dynamic Type XL in VI. iPhone: key frame skeleton aligned with the image |
| M15 | StoreKit: `.storekit` created in Xcode and synced, `StoreService` (finish policy), paywall with server copy, restore → transfer, manage sheet, cap messaging, consumption consent | Mac: Xcode StoreKit tests against dev Supabase with `ALLOW_XCODE_ENV`. Sandbox on device: purchase, renew, crossgrade, restore onto another account (transfer), refund (status 5 path), webhook rows |
| M16 | Settings, demo, docs (guide, privacy, terms/EULA, ai-disclosure, DPIA, CTIA, metadata, review notes, privacy label, age rating, support pages) | §11 checklist run on device; deletion verified with SQL; iPad compatibility mode run |
| M17 | Calibration and beta: ≥ 20 labelled clips per launch skill, threshold tuning, `eval.ts` (MAE vs coach ≤ 10; test–retest SD ≤ 3), effort re-sweep, Haiku VI eval, coach review of every (?) term and 20 outputs, TestFlight (after G2) | TestFlight build; `docs/rubric/calibration.md`, `docs/economics.md` |

---

## 13. Verification

### 13.1 In this Linux container (`scripts/check.sh`)

```bash
D="npx -y deno@${DENO_VERSION:-2.9.6}"                       # version from S1
$D fmt --check supabase scripts && $D lint supabase scripts
$D check supabase/functions/*/index.ts scripts/*.ts
$D test -A supabase/tests                                    # engine (synthetic + real fixtures), rubric, contracts, claude (mocked), jobs, apple, functions
$D run -A scripts/gen-schemas.ts --check                     # sync + structured-output keyword/enum audit
$D run -A scripts/replay.ts shared/fixtures/pose/real_bd_clear_01.json --mock-claude shared/fixtures/claude/bd_ok.json
$D run -A scripts/fit-contact-offsets.ts --check             # offsets in rubric match labels within 1 frame
$D run -A scripts/bench-engine.ts
bash supabase/tests/sql/run.sh                               # temp PG16 cluster: shim + 0100–0700, assertions, concurrency.sh
python3 -I scripts/check_ios_resources.py                    # catalogs, xcprivacy, Info keys, xcconfig "//" ban, banned APIs (systemUptime, mach_absolute_time), storekit IDs if present
bash scripts/gen-test-certs.sh
```

- **The SQL shim** provides:
  - roles `anon`, `authenticated`, `service_role`;
  - schemas `auth` and `storage`, with `auth.uid()` and `auth.jwt()` (`is_anonymous`);
  - `storage.objects` and `storage.buckets` with RLS;
  - `storage.foldername()`.

  The server here is PG16; Supabase runs 15 or 17. Re-validate with `supabase db reset` on the Mac.
- **Not possible here:** Swift builds, `supabase start` and `db lint`, the hosted runtime (covered by S1), the live Claude call (needs approval; M6 and M17).

### 13.2 What the user must verify on the Mac and iPhone

1. **S1 spike on day 1.**
   - Supabase Pro project in ap-southeast-1.
   - Auth: enable **anonymous sign-ins** (plus the per-IP rate limit), **manual identity linking**, Apple.
   - Email OTP templates (sign-in **and** change-email) contain `{{ .Token }}`, with OTP length 6.
   - Custom SMTP.
2. **Toolchain.** `brew install xcodegen`; `xcodegen generate`; build; `swift test` (CoachCore); `swift run posedump`.
3. **Backend deploy.** `supabase db push`. Secrets:
   - `ANTHROPIC_API_KEY`;
   - `APPLE_*` (IAP key, SIWA key, **DeviceCheck key**);
   - `TOKEN_ENC_KEY`, `CRON_SECRET`, `INTERNAL_SECRET` (also stored in Vault);
   - `ALLOW_XCODE_ENV` (dev only);
   - the `APPLE_API_HOST_*` overrides.

   Then `functions deploy` and `warm-schemas.ts`.
4. **StoreKit.** Xcode testing, App Store Connect setup (§9.1), sandbox flows including the transfer.
5. **Real devices.** An iPhone 11-class and an A17+ phone:
   - ms per frame and the chosen rate;
   - ROI benefit for small players;
   - mirrored and HDR clips;
   - slow-motion imports;
   - background resume;
   - thermal behaviour on 30 s at 60 Hz;
   - blur coverage;
   - VI text at XL sizes;
   - iPad compatibility mode.
6. **TestFlight** after G2, with 5–10 VN players and one coach.

---

## 14. Risks and mitigations

| Risk | Mitigation |
|---|---|
| 2D pose accuracy (wrist at smash speed, small players) | Live framing; 60 fps; ROI crop-follow; 25% height gate; contact offsets fitted to real labels; contact shown as an estimate; confidence and coverage rules; scores rounded and labelled beta |
| Camera placement in packed VN halls | Behind and diagonal views are first-class; mounting tips; hall tests at M3 and M12; per-view coverage hints |
| Mixed-stroke clips | Confirm-strokes grid; NMS; view and skill warnings |
| LLM hallucination or inconsistency | Code owns the numbers; no digits in model text; per-sport enums; candidate-only findings; override; eval with test–retest SD ≤ 3 |
| Structured-output limits and compile latency | Per-sport schemas with `$defs`; schema audit in CI; live compile at M6; grammar warm-up |
| Job duplication or death (400 s wall clock) | One attempt per invocation; fencing; 8-minute lock; results-exist short-circuit; per-job dispatch; spend logged per attempt |
| Cost overrun / VN margin | 5 frames; Sonnet `low`; `standard_limit` formula; per-user cost alerts; daily budget that never blocks paid users; Haiku for free users |
| Face blur misses | Pose head box + face detector + masking of non-targets; fail-closed; "best effort" wording; pose-only mode for minors |
| Anonymous-account complexity (merge, farming) | `linkIdentityWithIdToken` (pinned 2.55.3); `account-merge` with tests; DeviceCheck bit for the bonus; IP rate limits; App Attest in v1.1 |
| Restore confusion between accounts | Last-restore-wins transfer with rate limit and audit; clear messages; finish on definitive answers |
| Hosted Deno differs from local | S1 spike; tests on the reported version; no lockfile deployed |
| Legal (PDPL, AI law, localisation, tax) | Gates G1 and G2; 18+; consents; DPIA and CTIA; localisation contingency CT-1; local counsel |
| Calibration workload | 6 skills at launch; PoseDump and labeler early; skills enabled per rubric data without App Review |
| Vision differences across iOS versions | `PoseEstimator` protocol; `poseApi` and `os` recorded in the payload; device fixtures in CI |

---

## 15. Inputs needed from the user

1. **Day 1:** a Supabase Pro project and CLI access on the Mac (S1); company reverse-DNS; final VI and EN app names.
2. **By M3:** 20–30 clips across the 6 skills in 2–3 real halls (S, B and D views), and a Vietnamese coach for contact labelling (about 2 hours with the labeler).
3. **By M6:** an Anthropic workspace and key, plus **approval for the ≈ $0.50 live smoke test**.
4. **By M8–M9:** an Apple Developer account with team ID and the SIWA, IAP and **DeviceCheck** keys.
5. **By G1 / G2:** legal entity, tax adviser, counsel (PDPL, AI law, localisation, MOIT, age policy), and a domain for the legal and support pages.

---

## Appendix A: Review notes

**Verdict key:** **A** = accepted as proposed · **A\*** = accepted with a variant · **D** = deferred, with reason. No critique item was rejected outright.

### Technical critique: blockers

| Item | Verdict | Resolution |
|---|---|---|
| UUID casing breaks Storage RLS | A | `IDs.lower` everywhere; server compares UUIDs as `uuid`; Swift test (§5.3, M10) |
| xcconfig `//` truncation | A | Hosts only; URLs built in code; CI ban (§4, §5.1) |
| XcodeGen builds universal | A | `TARGETED_DEVICE_FAMILY "1"`; iPad compatibility test (§5.1, M16) |
| Storage upsert needs SELECT + UPDATE; bucket scoping | A | Full policy set per bucket; no `ALTER storage.objects`; SQL policy matrix (§6.6, M5) |
| `get_progress` permission error | A | Definer RPCs using `auth.uid()`; `tier_of` is service-only (§6.5) |
| Xcode-environment StoreKit cannot use Apple API | A | Dev-only bypass behind `ALLOW_XCODE_ENV`; Sandbox on device for the real flow (§9.4, M15) |

### Technical critique: majors

| Item | Verdict | Resolution |
|---|---|---|
| Empty `SubscriptionStoreView(groupID:)` | A | `productIDs:`; `.storekit` made in Xcode and synced (§9.6) |
| Quota races | A | Advisory lock + insert-on-conflict + `FOR UPDATE` + in-flight check, all in one function. The first-ever bonus **counts toward** the free 2 (§6.5); concurrency test (M5) |
| Cross-user overwrite in `prepare` | A | Ownership-guarded upsert, 409; same check in `submit` (§6.1) |
| Background-job timing | A | One attempt per invocation; 8-minute TTL; attempt fencing; `beforeunload` best-effort; per-job dispatch through pg_net; results-exist check (§6.1, §8.3) |
| Webhook drops Apple's retries | A | Short-circuit only when `processed` (§9.5) |
| Free gating client-side only | A | Column grants; tier-redacting `get_result` and `get_history`; raw output moved to `private` (§6.5) |
| Refund on rejection enables free calls | A\* | Refunds for rejected or partial results are capped at 3 per period; infrastructure failures always refund (§6.5, §8.3) |
| VFR breaks sampling and velocities | A | Scheduler fix; server resamples to a uniform grid with an `interp` mask (§5.3, §6.2) |
| Key frames from the wrong video frame | A | `tUs` exact PTS; server snaps to sampled frames; ±0.45-frame tolerance and `actualTime` check (§5.4, §6.2) |
| Face blur misses faces | A | Pose head box + faces + non-target masking; fail-closed; device tests; "best effort" wording (§5.4, §11) |
| Small players | A | 25% gate; ROI crop-follow in MVP (§5.4) |
| Circular contact tests | A | Real clips via PoseDump and labeler at M3; fitted offsets; hop at 0.1 T plus root rise; contact shown as an estimate (M4b) |
| Structured-output complexity | A | Per-sport schema; enums once in `$defs`; live compile at M6; case-insensitive enums; extended audit; warm-up (§7.4, §8) |
| Deno version mismatch | A | S1 reports the version; tests pinned to it; `"lock": false` (§12) |
| Account-linking gaps | A | Token from Apple's fetched payload; deleted, anonymous and offer-code cases; Set App Account Token; matrix tests (§9.4, M8) |
| Vision work in the background | A | Checkpoint and stop; resume in the foreground (§5.2) |

### Technical critique: minors

| Item | Verdict | Resolution |
|---|---|---|
| Sonnet fallback rarely applies | A\* | Kept (harmless, recommended default); every refusal handled as `model_refusal` with refund; category and served model logged |
| App Store Server API hosts | A | New hosts by default; notification history runs on both environments |
| Webhook trusts the payload | A | Effects come from the re-fetched status only |
| Transactions never finished | A | Finish on any definitive answer |
| Grace lost in `current_tier` | A | `expires_at` stores the coalesced value |
| Hampel damages turnarounds | A | Hampel on residuals; tests at realistic speeds |
| Mirrored L/R double swap | A | Upright rendering plus one server swap; device test |
| Benchmark includes warm-up | A | First 5 calls discarded |
| HDR handling | A | Rec.709 video composition |
| iCloud backup of local videos | A | `isExcludedFromBackup` |
| Per-screen orientation lock | A | Portrait-only UI |
| `knownRegions` | A | Removed; verified in the generated project at M0 |
| Fragile fixture tests | A | `#filePath` loading; decoded comparison |
| GoogleSignIn version | A\* | Google dropped for MVP (see P33) |
| Email OTP template | A | Both templates configured (§13.2) |
| Non-recursive deletion | A | Recursive walk |
| Feedback / drill-log ownership | A | `WITH CHECK` on feedback; drill logs removed |
| Function region | A | `ap-southeast-1` on every invoke |
| Benchmark not hosted | A | S1 measures it |
| Sonnet effort not tuned | A | Starts at `low`; sweep at M6 and M17 |
| 13–15 age band | A\* | 18+ at launch |

### Product and compliance critique

| # | Verdict | Resolution |
|---|---|---|
| 1 Privacy wording | A | §10.1; consent and policy say "best effort" |
| 2 Forced registration | A | Anonymous auth; `linkIdentityWithIdToken` confirmed in supabase-swift 2.55.3; `account-merge` |
| 3 Paywall (3.1.2) | A | Computed per-month caption; exact quotas from the server; EULA in metadata; paywall screenshot attached to the first submission |
| 4 Minors as users | A\* | Minimum **18** (stricter than the suggested 16) until counsel and Anthropic safeguards are documented; birth year |
| 5 Children and bystanders in frames | A | Under-16 subject → guardian attestation + pose-only; full-body masking; F5 cropped |
| 6 Restore looks broken | A | Last-restore-wins transfer, rate-limited, audited |
| 7 VN unit economics | A\* | Subscription-period quota; 5 frames; Sonnet `low`; re-queue retries; served-model cost logging; per-user alerts. Instead of a 10+10 split, Premium is **15 Sonnet**, governed by the `standard_limit` formula, because measured cost (≈ $0.063 cold) fits yearly VN proceeds with a 36% margin |
| 8 Weak paywall | A\* | Free = hero, scores and **1 strength** (one more than suggested, to keep beginners encouraged); the rest locked; free cap 2 per month; first analysis labelled |
| 9 Analytics | A | `events` + `log_event`; label and manifest updated |
| 10 Time to first value | A | Anonymous start; 2 questions; JIT consent; 30 s recordings skip the trimmer; context and goal dropped; view pre-filled; silent auto-select |
| 11 Side view impractical | A | D and B recommended for badminton; guide section; hall tests |
| 12 Live framing | A | §5.4 step 0; countdown and auto-start |
| 13 Mixed strokes | A | Confirm-strokes grid; partner-feed guidance; solo flag |
| 14 Results overload | A | Hero first; rounded scores; beta label; plain evidence with degrees under "Chi tiết" |
| 15 Too many skills | A | 6 at launch; server-driven catalog |
| 16 Serve-legality badges | A | Removed; static rules tip card |
| 17 Entity, tax, localisation | A | Gate G1, CT-1 contingency, DPIA and CTIA at G2, MOIT check |
| 18 VN age rating | A | M16 |
| 19 AI law label | A | Footer on every result |
| 20 International readiness | A | Phase 1 VN storefront only; Phase 2 prerequisites listed (§9.2) |
| 21 Bonus farming | A\* | DeviceCheck bit for the first-ever bonus. **D:** App Attest moves to v1.1, since the Haiku cost at risk is about 100₫ per analysis |
| 22 Refund abuse | A | Send Consumption Information, with consent |
| 23 Global 503 budget guard | A | Tiered guard; paid and reviewer accounts exempt; no quota reserved on 503 |
| 24 Cap messaging | A | "Lượt mới vào…"; trial continues on Haiku |
| 25 Partial results charged | A | Refunded, under the abuse cap |
| 26 Review practicalities | A | Anonymous auth removes the OTP problem; support page; iPad compatibility test; sample analysis under 90 s |
| 27 Privacy and retention gaps | A | No Name collected; ProductInteraction and OtherUsageData declared; Anthropic retention stated; frames deleted at finalize (72 h cap); pose 24 months of inactivity; calibration opt-in |
| 28 Default language | A | Storefront or region rule |
| 29 Copy quality | A | Glossary fixes; every term marked (?); Settings path checked; Haiku VI eval; US spelling; Dynamic Type |
| 30 Medical filter | A | NFC normalisation and Unicode-aware boundaries; category Sports; copy bans |
| 31 Wasteful local storage | A | Passthrough segment export; backup exclusion; auto-clean |
| 32 Processing stops on app switch | A\* | "Keep the app open" notice, checkpoint and resume, offline upload queue. **D:** `BGContinuedProcessingTask` moves to v1.1, because it needs task identifiers and GPU-availability handling, and resume already covers the MVP |
| 33 Scope cuts | A | Hysteresis, drill logs, per-metric overlay, Google, context and goal all cut; evidence opens the key frame |
| 34 Progress mixes people | A | `subject='self'` only |
| 35 Zalo import path | A | `CFBundleDocumentTypes` "Open in"; Files importer kept |
| 36 API host | A | Same as the technical item |
