# Design review (critiques of plan v1.0)

These critiques were addressed in DESIGN.md v1.1 (see its Appendix A).


===== CRITIQUE: technical =====
- **[blocker] Swift UUID casing breaks Storage RLS and frame lookup.** Swift's `UUID().uuidString` (and `session.user.id.uuidString`) is uppercase, but `auth.uid()::text` and the server-built paths `{uid}/{id}/…` are lowercase. With the uppercase form, the `(storage.foldername(name))[1] = auth.uid()::text` check rejects every frame upload. Even if an upload got through, `submit` would not find `analysis-inputs/{uid}/{id}/frames/`. **Fix:** lowercase every UUID string on the client (paths, `analysisId`, `appAccountToken`). Add a CoachCore test for this, and have the server compare UUIDs as UUIDs, not as text.

- **[blocker] The `//` in xcconfig URLs truncates them.** In `.xcconfig`, `//` starts a comment, so `SUPABASE_URL = https://x.supabase.co` becomes `https:`. The same happens to `LEGAL_PRIVACY_URL` and `LEGAL_TERMS_URL`. The app cannot reach the backend and the policy links are broken. **Fix:** write `https:/$()/x.supabase.co`, or store only the host and build the URL in code. Have `check_ios_resources.py` fail on a `//` inside an xcconfig value.

- **[blocker] XcodeGen builds a universal (iPhone + iPad) app by default.** XcodeGen's iOS preset sets `TARGETED_DEVICE_FAMILY: '1,2'` ([preset](https://raw.githubusercontent.com/yonaskolb/XcodeGen/master/SettingPresets/Platforms/iOS.yml)). An iPad build with a restricted `UISupportedInterfaceOrientations` and no `UIRequiresFullScreen` fails upload validation (iPad multitasking needs all four orientations). It also brings iPad review and screenshot requirements. **Fix:** set `TARGETED_DEVICE_FAMILY: "1"` explicitly in `project.yml`.

- **[blocker] Storage `upsert: true` needs SELECT and UPDATE policies, not only INSERT.** Supabase requires INSERT + SELECT + UPDATE on `storage.objects` for upsert ([Storage access control](https://supabase.com/docs/guides/storage/security/access-control.md)). The plan grants INSERT, SELECT and DELETE, so any re-upload fails with an RLS error (retry, re-run of `prepare` after a handedness swap, resume). **Fix:**
  - Add an UPDATE policy, or upload with `upsert:false` and delete before re-uploading.
  - Every policy must also include `bucket_id = 'analysis-inputs'`. Otherwise the uid-folder INSERT policy also lets clients write into `analysis-derived/{uid}/…`.
  - Do not `ALTER TABLE storage.objects` in migrations; that table is not owned by `postgres` on hosted Supabase.

- **[blocker] `get_progress` will fail with a permission error.** It is `SECURITY INVOKER` for `authenticated`, but it calls `current_tier(uid)`, which only `service_role` may execute. The Progress screen gets "permission denied". **Fix:** make `get_progress` `SECURITY DEFINER SET search_path=''` and derive the uid from `auth.uid()` inside it. Or add a no-argument `my_tier()` that `authenticated` can execute. Never grant the uid-taking `current_tier` to clients.

- **[blocker] Xcode-environment StoreKit testing cannot use the App Store Server API.** In local `.storekit` testing, transactions have environment `Xcode` and are signed by Xcode's local certificate. Apple's API has no record of them, so `GET /inApps/v1/subscriptions/{id}` 404s and M14 "Xcode StoreKit testing against dev Supabase" cannot pass as designed. **Fix:** when `ALLOW_XCODE_ENV=true` and `environment=="Xcode"`, skip the Apple API. Either verify the JWS against the StoreKit testing certificate exported from Xcode, or trust the decoded payload (dev project only). Test the real flow with Sandbox on a device.

- **[major] `SubscriptionStoreView(groupID:)` will show an empty paywall under local StoreKit testing.** A hand-written `Products.storekit` has its own subscription-group ID, which will not equal the App Store Connect group ID in `SUBSCRIPTION_GROUP_ID`. **Fix:** use `SubscriptionStoreView(productIDs:)`, or create the `.storekit` file in Xcode synced with App Store Connect. Hand-authoring the `.storekit` JSON on Linux is fragile, so create or validate it on the Mac at M14.

- **[major] Quota reservation has race conditions.**
  - `reserve_quota`'s `FOR UPDATE` locks nothing when the month's `usage_counters` row does not exist yet. Two parallel submits can both pass, or one fails on a unique violation.
  - The in-flight ≤ 1 check (429) is a separate check-then-act step in the edge function, so two submits for different `analysisId`s both pass it.
  - The `lifetime` first-analysis bonus has the same race.

  **Fix:** in one transaction, take `pg_advisory_xact_lock(hashtextextended(uid::text,0))`, `INSERT … ON CONFLICT DO NOTHING` the counter rows, then `SELECT … FOR UPDATE`, check in-flight count and limit, and write the ledger. Or use an atomic `UPDATE … SET used=used+1 WHERE used < limit RETURNING`. Also state whether the first-ever Sonnet bonus counts toward the 3/month.

- **[major] `prepare` lets one user overwrite another user's analysis row.** The service role bypasses RLS, and `analysisId` is client-generated. A client that reuses another user's UUID makes the `analyses` upsert overwrite that user's row (status, prepared JSON, `user_id`). **Fix:** use `INSERT … ON CONFLICT (id) DO UPDATE … WHERE analyses.user_id = excluded.user_id`, return 409 when 0 rows change, and apply the same check in `submit`.

- **[major] Background-job timing can kill jobs mid-call or run the same Claude call twice.**
  - Supabase's 400 s wall-clock limit applies to the worker, which can serve several requests. `EdgeRuntime.waitUntil` does not extend it ([Background tasks](https://supabase.com/docs/guides/functions/background-tasks.md), [worker timeouts](https://supabase.com/docs/guides/troubleshooting/edge-functions-worker-timeouts-and-websocket-drops)).
  - A worker that has already served `prepare`/`submit` traffic can kill a Sonnet call mid-flight.
  - The inline retries add up past the limit: 180 s, then a 1.5× `max_tokens` retry, then a parse retry.
  - The sweeper reclaims `processing` jobs after 6 min (360 s), which is less than 400 s, so a job that is still running can be claimed again: a duplicate Claude call, paid twice.
  - pg_net's default HTTP timeout is about 5 s, and running 5 jobs inside one cron invocation shares one worker's 400 s.

  **Fix:**
  - Allow one Claude attempt per invocation; send every retry back to `queued` with `next_attempt_at`.
  - Set the lock TTL to at least 8 min and fence with an attempt token: the final write uses `WHERE attempt_count = :mine`.
  - In a `beforeunload` handler, re-queue the job.
  - Make `cron` return 202 at once and dispatch one job per invocation.
  - Before calling Claude, check whether `analysis_results` already exists and only finalize if so (this also covers a crash between the upsert and `commit_quota`).

- **[major] Webhook de-duplication silently drops Apple's retries.** The flow inserts `notification_uuid` with `ON CONFLICT DO NOTHING` and returns 200 on duplicates, then returns 500 on transient failure. Apple's retry of that same notification hits the duplicate path, gets 200, and is never processed. **Fix:** short-circuit only when the existing row has `status='processed'`; otherwise process it again (the processing is idempotent).

- **[major] Free-tier gating is client-side only.** `analysis_results` is "select own", so a free user can read the full `result` (all strengths, the whole plan) and `raw_output` through PostgREST. `raw_output` also keeps the text that the medical filter replaced, and the free tier can read all score history for the Progress chart. **Fix:** revoke column SELECT on `result`/`raw_output` from `authenticated`. Serve results through a `SECURITY DEFINER` RPC that redacts by current tier, so upgrading unlocks old reports. Keep `raw_output` in `private`.

- **[major] Refund-on-rejection allows unlimited free Claude calls.** A rejected result (`is_assessable=false`, `sport_matches=false`) refunds quota. A user can submit junk frames over and over and get Sonnet/Haiku calls for free. **Fix:** count rejected-after-Claude analyses in their own capped counter (e.g. 3 per period), or refund only device-side rejections.

- **[major] Variable frame rate breaks both sampling and velocities.**
  - `FrameScheduler` keeps a frame if `pts ≥ nextT − 0.5/srcFps`, then `nextT += 1/targetHz`. After a gap in a VFR file (Zalo/WhatsApp exports, dropped frames), `nextT` lags behind and every frame is kept until it catches up. That produces a burst at native rate.
  - The server runs Hampel and Savitzky–Golay with fixed windows counted in samples, which assumes uniform sampling, so speeds and contact times come out wrong.

  **Fix:** set `nextT = max(nextT, pts) + 1/targetHz`. On the server, resample every joint onto a uniform 30/60 Hz grid, after gap filling and before Hampel/SG, and keep a mask of which samples were interpolated.

- **[major] Key frames can come from the wrong video frame.**
  - `t` is integer milliseconds, while frames sit at fractional times (59.94 fps gives e.g. 13910.58 ms). `AVAssetImageGenerator` with zero tolerance at 13910 ms returns the previous frame.
  - `tContact` is refined to a sub-frame time by parabolic interpolation, so it is not a decoded frame time at all.

  At smash speed one frame off is a different image. **Fix:** carry exact PTS in `pose.v1` (CMTime value/timescale, or microseconds). Make the server snap every frame request to a sampled `t`. On the client, request with ±½-frame tolerance, or decode that exact PTS with AVAssetReader.

- **[major] Face blurring will miss faces, against an explicit consent promise.** `VNDetectFaceRectanglesRequest` misses profile faces (the default side view), backs of heads, small or far faces and motion-blurred faces. The consent screen and Terms promise all faces are blurred. **Fix:**
  - Also run `VNDetectHumanBodyPoseRequest` on each key frame and blur a padded head box built from nose/eyes/ears/neck for every detected person.
  - Fail closed: when a person bbox has no head joints, blur its top ~20%.
  - Add device tests for profile and far faces.

- **[major] Small players get poor pose accuracy.** The quality gate rejects only below 15% of frame height, which is about 160 px tall in 1080p. Vision downsamples the full frame internally, so wrist and ankle keypoints at that size are mostly noise. **Fix:** raise the gate to about 25%. Set `regionOfInterest` on `VNDetectHumanBodyPoseRequest` to the expanded tracked bbox. That is a one-line crop-follow and should not wait for v1.1.

- **[major] The contact-detection tests are circular.**
  - M3b's synthetic set defines contact as the wrist-speed peak, so "≤ 1 frame error, 100% recall" proves nothing.
  - In overhead strokes the wrist joint's linear speed peaks before impact, because the racket head is driven by forearm rotation and the wrist itself is not tracked.
  - For dink, net shot and low serve the peak barely rises above noise (Vmin 1.2 T/s).
  - Split-step `hop` ≥ 0.04 T (about 2 cm) is inside keypoint jitter.

  **Fix:** bring part of M16 forward. Label contact frames on 20–30 real clips during M3, fit per-skill contact offsets, raise the hop threshold to about 0.1 T and require root rise too, and present contact as an estimate.

- **[major] The structured-output schema risks the API's complexity limits.** The API enforces internal grammar-size limits ("Schema is too complex for compilation" → 400) and has extra compile latency on first use ([Structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs.md)). The plan repeats large enums (every checkpoint ID and fault ID for both sports) in 3–4 places. The docs also say returned enum values may differ only in capitalization. **Fix:**
  - Use one schema per sport. Caching is already per (model × sport), so this costs nothing.
  - Define each enum once in `$defs` and `$ref` it.
  - Run a live compile smoke test for both models at M5, not M16.
  - Compare enum values case-insensitively in `postprocess`.
  - Extend the M1 keyword check to `maxItems`, `minItems` > 1 and unsupported regex.
  - Check what `z.toJSONSchema` actually emits (`$schema`, any integer bounds).

- **[major] Testing on Deno 2.9.6 may not match what Supabase hosts.** Supabase's hosted runtime was announced as Deno 2.1-compatible ([changelog](https://supabase.com/changelog/37941-all-regions-now-run-deno-2-1-compatible-release)). A `deno.lock` v5, or APIs newer than 2.1, can pass `deno check`/`test` locally and fail at deploy or run time. This is a likely risk, not confirmed. **Fix:**
  - Check the deployed runtime's Deno version in the M0 deploy spike, using a hello function that imports every pinned npm dependency.
  - Run tests on the matching Deno version.
  - Do not deploy a v5 lockfile from `supabase/functions` (`"lock": false` for functions, a separate lock for tests).

- **[major] Account linking has gaps.**
  1. "Token equals caller" must use the `appAccountToken` from Apple's fetched `signedTransactionInfo`, never the one in the unverified client JWS.
  2. There is no branch for a token that points to a deleted user. After delete-account the same Apple ID re-subscribes, but the token is still the old uid, so restore fails.
  3. Offer-code redemptions carry no token.

  **Fix:** treat "token belongs to a deleted or unlinked user" like the no-token case: verify the chain, then call Apple's **Set App Account Token** endpoint (added 2025-06-09) to write the new uid. Add the missing cases to the linking test matrix.

- **[major] Vision work while the app is in the background will fail.** `beginBackgroundTask` gives about 30 s, and Vision's GPU/ANE work is not allowed in the background. Pose extraction fails or falls back to slow CPU, not only the AVAssetReader that the plan already handles. **Fix:** on `scenePhase == .background`, checkpoint the last processed PTS and stop. Resume in the foreground with a new reader and a new request handler.

- **[minor] Sonnet's server-side fallback will practically never apply here.** With `fallbacks:"default"`, Sonnet 5.5 only retries `cyber` and `frontier_llm` declines (on Sonnet 5). `general_harms`, `bio` and `reasoning_extraction` declines are not retried, and `general_harms` is the likely false positive for images of people. **Fix:** handle every refusal as `model_refusal` with a refund. Keep the beta only if it helps, and log `stop_details.category`.

- **[minor] The App Store Server API host is outdated.** Since 2026-05-05 Apple recommends `api.storekit.apple.com` and `api.storekit-sandbox.apple.com`; the old hosts are still supported ([changelog](https://developer.apple.com/documentation/appstoreserverapi/app-store-server-api-changelog.md)). **Fix:** make the new hosts the default and keep the env override. The daily notification-history job must query both Production and Sandbox.

- **[minor] The webhook acts on unverified payload content.** REFUND/REVOKE are set to "free immediately" from the payload, so a forged POST can downgrade users and trigger Apple API calls. **Fix:** decide from the re-fetched status (5 / `revocationDate`) only, or verify the `signedPayload` chain with the existing `jws.ts`.

- **[minor] Transactions that never get a 200 are never finished.** `finish()` happens only on HTTP 200, so a 409 or 4xx transaction is re-delivered on every launch forever. **Fix:** finish on any definitive server answer (2xx, 409, 4xx); retry only on network errors and 5xx.

- **[minor] Grace periods can be lost in `current_tier`.** It checks `entitlements.expires_at > now()`, which is already past during billing grace. **Fix:** store `coalesce(grace_expires_at, expires_at)` in `entitlements.expires_at`, or check both columns.

- **[minor] Hampel can damage real swing turnarounds.** On positions with a 200 ms window at 60 Hz, Hampel can flag genuine sharp reversals (backswing end, follow-through stop) as outliers and flatten them. **Fix:** apply the spike test to residuals from a local polynomial fit. Add synthetic tests at realistic wrist speeds (20–30 T/s) and sharp reversals.

- **[minor] Mirrored clips may have their left/right labels swapped twice.** If the EXIF orientation passed to Vision already includes mirroring, Vision returns anatomical labels, and "swap all labels if det < 0" swaps them back. **Fix:** do exactly one correction, chosen by device test.

- **[minor] The rate benchmark includes Vision warm-up.** The first Vision calls include model load, so timing the first 20 calls inflates ms/frame. **Fix:** discard the first 3–5 calls.

- **[minor] HDR imports need SDR handling.** iPhone recordings imported from Photos are usually 10-bit HLG or Dolby Vision. 8-bit 420f output and key frames come out without tone-mapping (washed out). **Fix:** use an `AVVideoComposition` with Rec.709 color properties on iOS 17, or `dynamicRangePolicy` where the OS has it.

- **[minor] Local videos will be included in iCloud backups.** Videos up to 1 GB under Application Support are backed up by default. **Fix:** set `isExcludedFromBackup` on `Analyses/`.

- **[minor] Per-screen orientation lock is not a SwiftUI feature.** It needs an AppDelegate orientation mask plus `requestGeometryUpdate`. **Fix:** keep the whole UI portrait. `AVCaptureDevice.RotationCoordinator` already records landscape video correctly.

- **[minor] `knownRegions` is not an XcodeGen option.** XcodeGen derives it from `.lproj` folders and the locales in String Catalogs, so the key is silently ignored. **Fix:** remove it, and make sure both catalogs contain `vi` entries.

- **[minor] The CoachCore fixture tests are fragile.** SwiftPM resources cannot point at `../../shared/fixtures`, which is outside the package. Byte-for-byte JSON equality between Swift and JS also breaks: Swift escapes `/` as `\/` unless told not to, number formatting differs, and `JSON.stringify` does not sort keys. **Fix:** load fixtures through a `#filePath`-relative URL and compare decoded values.

- **[minor] GoogleSignIn-iOS "8.x" is outdated.** The latest tags are 9.x and 10.0.0. **Fix:** pin the latest major that is at least 2 weeks old and check its minimum iOS version. For Supabase Google sign-in, pass a nonce or enable "skip nonce check".

- **[minor] Email OTP needs Supabase configuration.** The default template sends a magic link, not a 6-digit code. **Fix:** edit the template to include `{{ .Token }}` and set OTP length 6. Custom SMTP is required, as the plan notes.

- **[minor] Account deletion and orphan cleanup will miss nested files.** Storage `list()` is not recursive, so files under `{uid}/{id}/frames/` are left behind. **Fix:** walk the folders recursively and remove in batches of up to 1000.

- **[minor] `feedback` and `drill_logs` inserts don't check analysis ownership.** The foreign key alone lets a user attach rows to another user's `analysis_id`. **Fix:** add `WITH CHECK (exists (select 1 from analyses a where a.id = analysis_id and a.user_id = (select auth.uid())))`.

- **[minor] Edge functions run in the region nearest the caller, not the database.** For users outside Asia, every DB and Storage call crosses to Singapore. **Fix:** invoke with region `ap-southeast-1` (`x-region` / the client's region option).

- **[minor] The engine benchmark may not hold on Supabase.** The < 300 ms figure is from this container and excludes `JSON.parse` of 1.2 MB, Zod validation of about 100k numbers, and two JSON uploads, all on slower hosted CPU with a 2 s limit. **Fix:** measure `prepare` end to end on the hosted runtime in the M6 spike.

- **[minor] Sonnet effort is not tuned.** Sonnet 5.5's effort levels are recalibrated, and the suggested starting point for extraction or generation work is `low`. **Fix:** sweep `low` against `medium` for the `standard` route on the eval set before fixing `medium`.

- **[minor] The 13–15 age band needs legal checks.** Images of minors go to Anthropic, Anthropic has its own requirements for products used by minors, and Vietnamese law treats under-16s as children. A guardian checkbox alone may not be enough. **Fix:** launch 16+ only, or get counsel's sign-off on verified parental consent and Anthropic's minors requirements. The consent screen should also state Anthropic's own API retention period.

===== CRITIQUE: product-compliance =====
1. **[Blocker] The privacy wording does not match what the app actually sends (5.1.1, 5.1.2(i), PDPL).**
   - **What is wrong:**
     - The Vietnamese `NSCameraUsageDescription` (§10.1) says the video is "phân tích ngay trên máy và không bị tải lên" (analysed on the phone, never uploaded). In fact, 9 frames taken from that video go to Supabase and then to Anthropic.
     - D9 and §11 promise "all faces blurred". `VNDetectFaceRectanglesRequest` cannot promise that: it misses faces in profile, the back of the head, small background faces and motion-blurred faces.
     - A reviewer will see the privacy label listing "Photos or Videos" collected, which contradicts the permission text.
   - **Fix:**
     - Rewrite the camera string, VI: "…Chỉ dữ liệu tư thế và tối đa 9 ảnh tĩnh (đã tự động làm mờ khuôn mặt) được gửi đi để AI phân tích, sau khi bạn đồng ý." Write the matching EN.
     - Change the consent screen, privacy policy and review notes to say "we automatically blur faces (best effort)", never "all".

2. **[Blocker] Sign-in is required before the first analysis and before buying (5.1.1(v)).**
   - **What is wrong:**
     - Sign-in is step 3 of the flow, and the paywall needs `appAccountToken(userUUID)`.
     - App Review routinely rejects apps that "require users to register before purchasing in-app purchase products that are not account based". Registration must be optional ([Apple forum 731471](https://developer.apple.com/forums/thread/731471), [747700](https://developer.apple.com/forums/thread/747700)).
   - **Fix:**
     - Use Supabase anonymous sign-in at first launch. The anonymous uid drives quota, `appAccountToken`, Storage paths and RLS.
     - Offer Apple, Google or email sign-in after the first result, framed as "Lưu lịch sử & dùng trên thiết bị khác".
     - Check that supabase-swift can link an Apple or Google ID-token identity to an anonymous user. If it cannot, merge the two accounts server-side.
     - `delete-account` must also work for anonymous users.

3. **[Blocker] Paywall and metadata gaps under 3.1.2.**
   - **What is wrong:**
     - "chưa tới 50.000₫/tháng" (§9.2) is a hard-coded VND string. It is wrong in every other storefront and goes stale whenever Apple re-prices VND. The per-month figure must sit below the billed amount in position and size ([forum 807082](https://developer.apple.com/forums/thread/807082), [841626](https://developer.apple.com/forums/thread/841626)).
     - The usage caps are never disclosed: Premium is "20 per month, fair use" and the trial is "5 total". Apple requires you to say exactly what the user gets for the price.
     - The Terms of Use (EULA) link must appear in App Store Connect metadata, not only inside the app. Missing it is a very common rejection.
   - **Fix:**
     - Compute the per-month price from `Product.price / 12` with `priceFormatStyle`, and show it only in the yearly row, in smaller text.
     - Add a VI/EN feature list with exact numbers: "20 phân tích/tháng", "Dùng thử 7 ngày: tối đa 5 phân tích", "Miễn phí: 3/tháng".
     - Put the EULA link (Apple standard or your own Terms) in both the VI and EN descriptions.
     - Attach the subscriptions and a paywall screenshot to the first binary submission.

4. **[Blocker] Account holders aged 13–15 are allowed with only a guardian checkbox (D14, §2.2 step 2, §11 "Age").**
   - **What is wrong:**
     - Vietnamese law treats under-16s as children. Processing their data needs parental consent (and the child's own consent from age 7) with real verification. Sources disagree on the exact thresholds under Law 91/2025 and [Decree 356/2025](https://www.vietnam-briefing.com/news/vietnam-personal-data-protection-regulation-decree-356.html), so counsel must confirm.
     - [Anthropic's guidance for products serving minors](https://support.claude.com/en/articles/9307344-responsible-use-of-anthropic-s-models-guidelines-for-organizations-serving-minors) expects age verification, moderation, monitoring, an AI disclosure and a public statement of child-privacy compliance.
     - A checkbox meets neither standard.
   - **Fix:**
     - Set the MVP minimum age to 16, using a neutral birth-year question instead of pre-labelled bands.
     - Either document Anthropic's minor safeguards for users aged 16–17, or set the minimum to 18 if counsel prefers.

5. **[Major] Children and bystanders appear in the frames sent to the AI.**
   - **What is wrong:**
     - The most common real use in Vietnam is a parent or coach filming a child at a club. The "someone else + checkbox" path sends images of children to Anthropic.
     - F9, the full-frame overview, captures neighbouring courts and spectators.
   - **Fix:**
     - Ask "Người trong video dưới 16 tuổi?". If yes, require a guardian attestation and run a pose-only analysis: no frames, and visual (V) checkpoints are marked not assessable.
     - In every frame, mask each non-target person's whole body box using the Vision body detections, not just their face.
     - Build head boxes from the pose keypoints (nose, eyes, ears, neck) and combine them with the face detector's boxes.
     - Crop F9 to the target player or drop it.
     - Test blur coverage on device fixtures.

6. **[Major] The subscription linking policy will make Restore look broken (3.1.1, 2.1).**
   - **What is wrong:** `verify-subscription` returns 409 `linked_to_other_account` in two common cases:
     - A reviewer reuses a sandbox Apple ID that bought the subscription under an earlier review account.
     - A user signed in with Google on one device and with Apple on another.

     Either way, "Restore didn't work", and the user hits a dead end.
   - **Fix:**
     - On an explicit Restore, move the link to the current account ("last restore wins") and remove premium from the old account.
     - Rate-limit transfers (for example 3 per 30 days) and write an audit row.
     - Show a clear message instead of a dead end.

7. **[Major] VN unit economics: heavy users lose money, and the calendar-month quota doubles usage in the first paid month.**
   - **What is wrong:**
     - Yearly VN proceeds are about $1.48 per month, against 20 × $0.095 = $1.90 for a user at the cap. The Claude prices in §8.7 do match the current API reference (Haiku 5.5 $0.10/$0.50, Sonnet 5.5 $2/$10, cache read $0.20), so this gap is real.
     - With a calendar-month reset (D18), someone who subscribes on the 28th can run 20 analyses in four days and 20 more in the next month.
     - On a refusal, the Sonnet fallback may bill at the fallback model's price.
     - Retries for `max_tokens` and parse failures run inline inside one `waitUntil`: 180 s, then up to 270 s. That can exceed the 400 s wall clock. [`waitUntil` does not extend that limit](https://supabase.com/docs/guides/functions/background-tasks.md), so the worker dies after the tokens are billed, and the sweeper re-runs the job, billing it twice.
   - **Fix:**
     - Key the premium quota period on the subscription period (from `expires_at`), not the calendar month.
     - Define "20 per month" as 10 Sonnet analyses and the rest on Haiku, or cap yearly VN at about 12 per month.
     - Cut Sonnet input to 5 frames (best stroke plus overview), and test effort `low`.
     - Run retries as a re-queue (a new invocation), never inline.
     - Log the cost of the fallback model, and alert when one user's monthly LLM cost goes above 60% of their proceeds.

8. **[Major] The free tier gives away almost everything, so the paywall is weak.**
   - **What is wrong:**
     - Claude returns only 1–3 strengths and weaknesses. Free already shows 2 + 2, improvement #1 and the overlay, which is about 80% of the value. Premium adds only the third item and Progress.
     - 3 free analyses a month already covers how often a casual beginner records.
     - Haiku costs about 100₫ per analysis, so the free cap is a conversion lever, not a cost control.
     - The first free analysis runs on Sonnet and the rest on Haiku, so free users will notice a quality drop.
   - **Fix:**
     - Free shows the overall score, sub-scores, the #1 weakness with its cue, and one drill.
     - Lock the evidence and overlay, the full plan and drills, Progress, and history beyond the last 3.
     - Test 2 free analyses per month and label the first one "Phân tích nâng cao miễn phí lần đầu".

9. **[Major] There is no product analytics.**
   - **What is wrong:** All quota and price values sit in tables (D18), but nothing measures the funnel, reject reasons, paywall-to-trial-to-paid, or retention, so there is no basis for tuning them.
   - **Fix:**
     - Add a first-party server-side `events` table with no third-party SDK. Track: onboarding step, capture source, quality and prepare rejects (with code), result viewed, paywall shown (with trigger), and purchase.
     - Declare "Product Interaction" in the privacy label and manifest (linked, not tracking).

10. **[Major] It takes about 12 screens to reach the first value.**
    - **What is wrong:** The path is Welcome → language → 4 profile questions → sign-in → blocking consent → Home → skill → guide → source → trimmer → a 4-field form → player tap → 1–3 minutes of processing.
    - **Fix:**
      - Use anonymous auth (see item 2).
      - Ask only age and handedness; make level optional.
      - Show AI consent just in time, at the first submit, not as a wall in front of the whole app.
      - Cap in-app recordings at 30 s so they skip the trimmer.
      - Drop "context" and "goal" from the MVP session form.
      - Pre-fill the camera view from `viewGuess` and confirm only when it is uncertain.
      - Auto-select a single player without a confirmation step unless the choice is ambiguous.

11. **[Major] Side view at 4–6 m is often physically impossible in Vietnamese halls.**
    - **What is wrong:**
      - Badminton courts are packed side by side, so a phone 4–6 m to the side stands on the next court.
      - Outdoor pickleball is often backlit by the sun.
      - All 12 skills recommend the side view.
    - **Fix:**
      - Test camera placement in 3–5 real halls during M11–M12.
      - For badminton, make "behind" (from the back wall or fence, raised) and the back-corner diagonal first-class views, with their own view factors.
      - Add a "khi không đặt được máy bên hông" section to the guide, with mounting tips (net-post clamp, fence clamp).

12. **[Major] There is no live framing check before recording.**
    - **What is wrong:** Bad framing (too far, feet cut off, racket out of frame, dark or backlit) will be the top cause of failed analyses. The plan shows only a static silhouette and rejects the clip after full processing.
    - **Fix:**
      - Run Vision body pose on the preview at about 5 fps for 2–3 s, with traffic-light hints: whole body visible, player at 40–70% of frame height, brightness OK.
      - Record only on green, with a manual override.
      - Add a 3-2-1 countdown or auto-start so a solo player can walk into position.

13. **[Major] Real clips will not be single-skill drills.**
    - **What is wrong:**
      - Beginners film matches and doubles rallies, so a clip has mixed strokes. Segmentation then picks the wrong strokes, or the result says `skill_mismatch`.
      - Clears, smashes and dinks need a partner feeding the shuttle or ball.
    - **Fix:**
      - After `prepare`, show a "Xác nhận cú đánh" grid: one local thumbnail per detected stroke at contact. The user unticks the wrong ones before frames are extracted. This uses no quota.
      - The guide should say "nhờ bạn đánh cầu/bóng cho bạn" and flag which skills can be practised alone (serves).

14. **[Major] The Results screen is overloaded and too technical for beginners.**
    - **What is wrong:**
      - It shows about 12 blocks.
      - Chips like "128° (mục tiêu ≥150°)" come from 2D pose, which has ±10–20° error. Numbers that look precise destroy trust when they are wrong.
    - **Fix:**
      - Lead with "Sửa điều này trước": one issue, one cue, one drill, one key frame with the skeleton drawn on it.
      - Put scores below that, rounded to 5, with a "beta" label.
      - Use plain-language evidence ("khuỷu tay còn gập khi chạm cầu"), and keep the degrees in an expandable detail.

15. **[Major] 12 skills cannot be calibrated in time for MVP.**
    - **What is wrong:** M16 needs 10–30 labelled clips per skill, which is 120–360 coach-labelled clips. On top of that come thresholds, visual anchors, faults and about 50 bilingual drills.
    - **Fix:**
      - Launch with 3 skills per sport. That still covers both sports. Example: badminton clear, smash and low serve; pickleball dink, serve and third-shot drop.
      - Serve the skill list from the server, so more skills ship later as rubric data with no App Review.

16. **[Major] Cut the serve-legality rule badges.**
    - **What is wrong:** The badminton 1.15 m service height and the pickleball serve rules depend on where the shuttle or paddle is, and on calibrated height. 2D pose with no racket detection cannot measure either. A wrong "likely_fault" damages trust.
    - **Fix:** Remove the badges from MVP. At most, show a static rules tip card.

17. **[Major] Legal entity, tax and data localisation are still undecided, and they change both the architecture and the margins.**
    - **What is wrong:**
      - Apple's August 2025 Vietnam change, as [reported](https://ppc.land/apple-announces-tax-and-pricing-updates-affecting-global-developers/): for Vietnam-based developers, Apple no longer remits tax on sales to customers; individuals pay 2% PIT, and a 5% FCT applies to Apple's commission. The proceeds model ("79k with 10% VAT included") assumes Apple handles VAT.
      - The Cybersecurity Law 116/2025 (in force 1 July 2026) [reportedly keeps](https://blogs.duanemorris.com/vietnam/2026/01/08/vietnam-law-on-cybersecurity-2026-what-you-must-know/) the data-localisation duty for domestic enterprises. A Vietnamese company may need a copy of user data hosted in Vietnam despite Supabase Singapore.
      - Decree 356/2025 replaced Decree 13 and revised the transfer-impact-assessment templates. A processing impact assessment (DPIA) is likely also needed, not only the cross-border one.
    - **Fix:**
      - Decide the entity with Vietnamese counsel and a tax adviser before M6.
      - Model proceeds for each entity type.
      - Plan a Vietnam-stored copy of user data (or a confirmed exemption).
      - File both assessments before launch, and check whether the SME/startup exemption applies.
      - Ask counsel whether a Ministry of Industry and Trade (Bộ Công Thương) e-commerce app notification is required.

18. **[Minor] Vietnam now has its own App Store age rating.** From 18 June 2026, under Decree 147, Vietnam shows 00+, 12+, 16+ or 18+ on the product page, derived from the age-rating questionnaire ([Apple news](https://developer.apple.com/news/), [9to5Mac](https://9to5mac.com/2026/05/21/apple-to-update-app-store-age-ratings-in-australia-and-vietnam-next-month/)).
    - **Fix:** Answer the questionnaire consistently with the in-app minimum age, and check the VN rating before submitting.

19. **[Minor] Vietnam AI Law 134/2025/QH15** (in force 1 March 2026; existing systems have until 1 March 2027; implementing decrees still pending) adds transparency and labelling duties ([Rajah & Tann](https://www.rajahtannasia.com/viewpoints/new-law-on-artificial-intelligence-takes-effect-on-1-march-2026/)).
    - **Fix:** Put a visible "Nhận xét do AI tạo, có thể chưa chính xác" label on Results, and track the decree.

20. **[Minor now; Major at the international launch] International readiness.**
    - **What is wrong:**
      - Utah (from 6 May 2026) and Louisiana (from 1 July 2026) age-assurance rules apply through Apple's Declared Age Range API ([9to5Mac](https://9to5mac.com/2026/02/24/apple-expands-age-assurance-tools-as-new-app-store-requirements-roll-out-in-several-regions/)).
      - Mainland China requires a generative-AI filing before such apps are allowed.
      - The EU requires DSA trader status, and GDPR needs transfer clauses (SCCs) covering Anthropic.
      - An auto-equalised $9.99 is too high for Indonesia, Malaysia, Thailand, the Philippines and India, which are core badminton markets.
    - **Fix:**
      - Integrate DeclaredAgeRange before the US launch.
      - Deselect the China mainland storefront.
      - Complete trader status, or skip the EU at first.
      - Set manual price points in Southeast Asian and Indian storefronts, or launch in the VN storefront only.

21. **[Minor] The free first-ever Sonnet analysis can be farmed with throwaway email-OTP accounts.**
    - **Fix:** Store a DeviceCheck bit per device for "bonus used", and add App Attest on `submit`.

22. **[Minor] Refund abuse.** A user can subscribe, burn 20 Sonnet analyses, then ask Apple for a refund. The plan only logs `CONSUMPTION_REQUEST`.
    - **Fix:** Answer it with [Send Consumption Information](https://developer.apple.com/documentation/appstoreserverapi/consumptionrequest.md), which supports auto-renewable subscriptions. This needs the user's consent, so add that to the Terms or Settings.

23. **[Minor] The global `DAILY_BUDGET_USD` guard returns 503 to everyone**, including paying users and App Review.
    - **Fix:**
      - Always serve paid users; free users get queued or moved to Haiku.
      - Never consume quota on a 503.
      - Exempt the review and demo accounts, and alert at 70% of the budget.

24. **[Minor] Hitting a cap sends the wrong message.**
    - **What is wrong:** A trial or premium user who reaches the cap gets the paywall, which is meaningless to someone already subscribed. A trial user who uses all 5 analyses on day 1 is likely to cancel.
    - **Fix:**
      - Show "Lượt mới vào <ngày>" instead of the paywall.
      - Consider letting the trial continue on Haiku after the 5 Sonnet analyses.

25. **[Minor] Partial results still use quota.** Charging for a result with coverage < 0.5, or with every sub-score "Chưa đủ dữ liệu", will feel like a cheat.
    - **Fix:** Refund the quota for partial results.

26. **[Minor] App Review practicalities.**
    - **What is wrong:**
      - A reviewer cannot receive an email OTP.
      - Reviewers often test iPhone-only apps on iPad, in compatibility mode.
      - App Store Connect requires a Support URL, not just a support email.
    - **Fix:**
      - If anonymous auth is not adopted, provide a reviewer email+password account.
      - Test the app in iPad compatibility mode.
      - Publish a support page.
      - Keep the sample-clip analysis under about 90 s.

27. **[Minor] Gaps in privacy, retention and data reuse.**
    - **What is wrong:**
      - The privacy label omits Name (Google returns it, and `display_name` stores it) and Product Interaction / Other Usage Data (the analytics events and LLM call logs).
      - The consent screen and privacy policy do not state Anthropic's API data retention.
      - Key frames are kept for 30 days even though they are only needed until the analysis succeeds.
      - Pose JSON has no maximum retention.
      - Using production data for calibration or eval needs its own opt-in (5.1.2(ii)).
    - **Fix:**
      - Add Name, Product Interaction and Other Usage Data to the label and manifest.
      - State Anthropic's current API retention in the consent screen and privacy policy.
      - Delete key frames once the analysis succeeds, with a 72 h cap for failed or retried jobs.
      - Set a maximum for pose JSON, such as 24 months of inactivity.
      - Add a separate opt-in before production data is used for calibration or eval.

28. **[Minor] The default language is wrong for many VN users.** Many Vietnamese iPhone users keep the system language in English, so "default to VI only if the system is VI" gives them English.
    - **Fix:**
      - Default to VI when the storefront or region is Vietnam (`Storefront.current?.countryCode == "VNM"` or `Locale.current.region`).
      - Expect the StoreKit and system sheets to stay in the device language, so keep custom paywall copy minimal.

29. **[Minor] Vietnamese and English copy quality.**
    - **What is wrong:**
      - "Động tác vung theo" reads as a literal calque.
      - "Vô-lê" uses an outdated hyphenated spelling.
      - "Hồi vị" alone is unclear to beginners.
      - Whether to say "Bếp" or "Kitchen" needs coach review.
      - The subject-consent line is awkward.
      - The camera guide's Settings path ("Cài đặt › Camera › Quay video…") is a guess at iOS's Vietnamese menu labels and has not been checked on a VI-language iPhone.
      - Haiku's Vietnamese output quality has not been checked, and free users see Haiku.
      - EN copy mixes British "Analyse" into a US-facing app.
      - Pickleball players in Vietnam skew older, and long Vietnamese strings may not fit at large text sizes.
    - **Fix:**
      - "Động tác vung theo" → "Kết thúc động tác".
      - "Vô-lê" → "vô lê".
      - "Hồi vị" → "Về vị trí (hồi vị)".
      - "Bếp" → "Kitchen (vùng cấm vô lê)", pending coach review.
      - "Tôi có sự đồng ý của người trong video" → "Người trong video đã đồng ý cho tôi quay và phân tích".
      - "chưa tới" → "chưa đến".
      - Mark every glossary term "(?)" for coach review, not just "Lunge".
      - Check the Settings path on a VI-language iPhone, and warn about "FPS tự động", which drops to 24/30 fps in dim halls.
      - Run a separate eval of Haiku's Vietnamese output.
      - Use US spelling ("Analyze").
      - Support Dynamic Type and test the Vietnamese strings at XL sizes.

30. **[Minor] The medical filter will miss and mis-match terms.**
    - **What is wrong:**
      - Vietnamese diacritics can be encoded in different ways, so an unnormalised regex misses terms.
      - EN patterns without word boundaries over-match: `tear` matches "teardrop".
      - Listing the app under Health & Fitness invites medical scrutiny.
    - **Fix:**
      - Normalise text (NFC, lowercase) before matching, and use `\b` word boundaries.
      - List the app under "Sports".
      - Avoid "phòng chấn thương" (injury prevention) and "chuẩn như HLV" (as good as a coach) in App Store copy.

31. **[Minor] Local storage is wasteful and gets backed up to iCloud.** D16 copies up to 1 GB / 5 min into Application Support, which iCloud backs up by default, to analyse at most 30 s.
    - **Fix:**
      - Passthrough-export only the trimmed segment (no re-encode).
      - Set `isExcludedFromBackup`.
      - Auto-clean old videos, with a notice.

32. **[Minor] Processing stops when the user switches apps.**
    - **What is wrong:** `beginBackgroundTask` gives only seconds, while 30 s at 60 Hz takes 1–2 minutes on older phones.
    - **Fix:**
      - Tell the user to keep the app open.
      - On iOS 26+, use `BGContinuedProcessingTask` for the pose pass.
      - Queue the upload while offline (indoor halls often have weak 4G) and resume later.

33. **[Minor] Further scope to cut.**
    - **What is wrong:** These features add work without much value for an MVP:
      - Level hysteresis.
      - Drill logs, which have no reminders behind them.
      - Per-metric joint highlighting, and evidence chips that seek the video with `CADisplayLink`.
      - Google Sign-In.
      - The context and goal fields.
    - **Fix:**
      - Use the "beta" level label instead of hysteresis.
      - Replace drill logs with one local notification: "quay lại sau 7 ngày để so sánh".
      - Have evidence chips open the matching key frame with the skeleton drawn, and keep a plain skeleton overlay on the video.
      - Rely on Apple, email and anonymous sign-in, which saves an SDK, a URL scheme and manifest review.
      - Drop context and goal from the form.

34. **[Minor] Progress charts mix people.** They combine `subject=self` with "someone else" clips.
    - **Fix:** Chart only `subject=self`, or let the user tag a named player locally.

35. **[Minor] The Zalo import path is misdescribed.** Videos received in Zalo are usually saved to Photos, not Files. The natural flow is the share sheet.
    - **Fix:** Declare `CFBundleDocumentTypes` for `public.movie` so "Open in / Copy to RacketCoach" appears in the share sheet. A full Share Extension can come later.

36. **[Minor] App Store Server API host (§1.1 item 11).** Apple's [changelog of 2026-05-05](https://developer.apple.com/documentation/appstoreserverapi/app-store-server-api-changelog.md) now recommends `api.storekit.apple.com` and `api.storekit-sandbox.apple.com`. The old hosts are still supported.
    - **Fix:** Default the env var to the new hosts.
