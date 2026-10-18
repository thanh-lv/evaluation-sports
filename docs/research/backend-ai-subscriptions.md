# Research: backend-ai-subs

> Research output from 2026-10-18 (unverified claims marked inside). DESIGN.md is authoritative.

# Backend, AI analysis and subscription architecture for the badminton/pickleball coach MVP

## Summary of decisions
1. **Analysis runs as a background job.** `analysis-init` → the client uploads key frames and metrics to private Storage → `analyze` reserves quota and returns **202**. The Claude call runs inside `EdgeRuntime.waitUntil`. The client learns the result through Realtime or by polling. A pg_cron sweeper retries jobs that got stuck.
2. **Models:**
   - Free tier ("basic"): **`claude-haiku-5-5`**, about $0.004 per analysis.
   - Standard: **`claude-sonnet-5-5`**, about $0.09–0.11.
   - Premium "deep": **`claude-opus-5-5`**, about $0.27–0.30.
   - All three use the same output schema. The model's JSON is constrained by `output_config.format`, and the sport rubric in the system prompt is cached.
3. **Apple's server API decides entitlements.** Purchases and webhooks only trigger a re-fetch from the App Store Server API, and the database is updated from that response. Checking Apple's JWS signature locally is a second layer, because Apple's certificate-chain check reportedly fails in the Supabase Deno runtime.
4. **Quotas are enforced in SQL.** Reserve, commit and refund run as atomic Postgres functions, with idempotency per session. The limits live in a `plan_limits` table so they can be tuned without a deploy.
5. **Account deletion is one edge function.** It revokes Sign in with Apple tokens, deletes Storage objects through the API, then hard-deletes the auth user so database rows cascade.

---

## 0. Facts checked against current docs (cite these; they can change)

| Fact | Value | Source |
|---|---|---|
| Edge Function wall clock | **150 s on Free, 400 s on paid plans.** CPU 2 s per request (async I/O not counted). Request idle timeout 150 s. Memory 256 MB. Bundle 20 MB. | [S1] |
| Background tasks | `EdgeRuntime.waitUntil(p)` keeps the worker alive but **does not extend the wall-clock limit**. Local CLI runs need `[edge_runtime] policy="per_worker"`. | [S2][S3] |
| Supabase keys | New publishable/secret keys are not JWTs. Send them in the `apikey` header. Legacy anon/service_role keys are deprecated by end of 2026. `verify_jwt` still checks user JWTs. Helper: `jsr:@supabase/server@1.9.2` (`withSupabase({auth:'user'})`). | [S4] |
| Deleting Storage objects | Delete through the Storage API (`remove()`). Deleting rows from `storage.objects` with SQL orphans the files. | [S5] |
| Claude prices (per MTok: input / output / 5-min cache write / cache read) | Opus 5.5: $4 / $20 / $5 / $0.20. Sonnet 5.5: $2 / $10 / $2.50 / **$0.10**. Haiku 5.5 (prompts ≤100K): $0.10 / $0.50 / $0.125 / $0.01. Batch API is −50%. | [A1] |
| Image tokens | `⌈w/28⌉ × ⌈h/28⌉`. "4.7+" models: long edge up to 2576 px, max 4784 tokens per image. Formats: JPEG/PNG/GIF/WebP. 10 MB per image, 32 MB per request. Put images before text. | [A2] |
| Structured outputs | `output_config.format {type:"json_schema", schema}`, supported on Opus 5.5, Sonnet 5.5 and Haiku 5.5. **No `minimum/maximum/minLength/maxLength`.** `additionalProperties:false` is required. At most **24 optional params** and **16 union-typed params**. The compiled grammar is cached 24 h. **Changing the format invalidates the prompt cache.** TS helpers: `zodOutputFormat`, `jsonSchemaOutputFormat`. | [A3] |
| Sampling parameters | Opus 5.5: `temperature`/`top_p`/`top_k` return **400**. Sonnet 5.5 and Haiku 5.5: any non-default value returns **400**. You cannot use temperature 0 for consistency. | [A4] |
| Thinking | Opus 5.5 is always adaptive (default effort `medium`). Sonnet 5.5 defaults to `high` and `disabled` returns 400. Haiku 5.5 defaults to `medium`. Effort is set with `output_config.effort`. Assistant prefill and forced `tool_choice` return 400 on these models. | [A4] |
| Prompt cache | Minimum prefix is 512 tokens on the 5.5 models. At most 4 breakpoints. Default TTL is 5 min, or `ttl:"1h"` at 2× write cost. | [A4] |
| Refusals | HTTP 200 with `stop_reason:"refusal"`. Server-side `fallbacks:"default"` (beta `server-side-fallback-2026-07-01`) applies to Sonnet and Opus only. **Haiku 5.5 has no fallback.** | [A4] |
| Apple JWT for the server API | ES256 with header `{alg, kid, typ:"JWT"}` and claims `{iss, iat, exp ≤ iat+60 min, aud:"appstoreconnect-v1", bid}`. New hosts: `api.storekit.apple.com` and `api.storekit-sandbox.apple.com` (the old `itunes` hosts still work). | [P1][P2][P3] |
| Apple JWS check in Supabase Deno | `@apple/app-store-server-library@3.1.0` (May 2026) uses `node:crypto` `X509Certificate`. Developers report its chain verification **failing in the Supabase Deno runtime**. | [P4][P5] |
| Sign in with Apple deletion | Account deletion must call `/auth/revoke` with a refresh or access token. Get the refresh token by exchanging the authorization code (short-lived) at `/auth/token`. If you have no token: delete the data, tell the user to revoke manually, and handle credential-revoked events. | [P6] |
| Guideline 4.8 | Current wording asks for an *equivalent privacy-preserving login*. Sign in with Apple satisfies it, so keep it next to Google. | [P7] |
| Guideline 5.1.2(i) (Nov 2025) | You must say in the app that data goes to a **third-party AI** and get an **explicit opt-in** before sending it. | [P8] |
| Vietnam PDPL | Law 91/2025/QH15 plus Decree 356/2025, effective 2026-01-01. Cross-border transfer (Supabase in Singapore, Anthropic in the US) needs consent plus a transfer impact assessment filed within 60 days. **Needs legal review.** | [L1] |

---

## 1. Supabase project setup
- **Region:** `ap-southeast-1` (Singapore). Pin Edge Functions to the same region with the `x-region` header or `forceFunctionRegion`.
- **Plan:** **Pro is required.** You need the 400 s wall clock for Opus "deep" calls, and Free projects get paused.
- **Auth providers:**
  - **Apple, native:** `ASAuthorizationAppleIDProvider` with a SHA-256-hashed nonce, then `signInWithIdToken(provider:.apple, idToken, nonce: raw)`. Add the bundle ID to Apple's "Client IDs" in Supabase. **Right after sign-in, send `authorizationCode` to `apple-auth-exchange`** to get and store the refresh token, which deletion needs later.
  - **Google, native:** GoogleSignIn-iOS, then `signInWithIdToken(provider:.google, idToken, accessToken)`. Add the iOS and web client IDs to the authorized list. Check in the Supabase docs whether "skip nonce check" is needed for the iOS SDK.
  - **Email:** 6-digit OTP code, which avoids deep-link setup. **Configure custom SMTP**, because the built-in sender is heavily rate-limited.
  - **Optional (P2):** anonymous sign-ins for "try before signup", then `linkIdentity`. Tie free quota to `appTransactionID` to limit abuse.
- **`supabase/config.toml`:**
```toml
[edge_runtime]
policy = "per_worker"   # local: lets waitUntil finish
[functions.analysis-init]      verify_jwt = true
[functions.analyze]            verify_jwt = true
[functions.verify-subscription] verify_jwt = true
[functions.apple-auth-exchange] verify_jwt = true
[functions.delete-account]     verify_jwt = true
[functions.appstore-webhook]   verify_jwt = false   # Apple calls it; trust comes from re-fetching
[functions.analysis-worker]    verify_jwt = false   # pg_cron/pg_net; checks x-worker-secret
[functions.maintenance]        verify_jwt = false   # cron: reconcile + cleanup
```
- **Imports (`deno.json`), exact pins:**
  - `npm:@anthropic-ai/sdk@0.135.0` (peer `zod ^3.25 || ^4`)
  - `npm:zod@4.6.7`
  - `npm:jose@6.2.12`
  - `npm:@supabase/supabase-js@2.118.0`
  - `jsr:@supabase/functions-js/edge-runtime.d.ts`
  - `npm:@peculiar/asn1-x509` (pure ASN.1, used by the Apple certificate checker)

---

## 2. Postgres schema (migrations in `supabase/migrations/`)

Conventions:
- Use `text` with `CHECK` constraints instead of enum types, which are easier to migrate.
- Every user-owned table has an index on `user_id`.
- RLS is enabled on every table and policies use `(select auth.uid())`.
- `private` is a non-exposed schema, reachable only by the service role.

### 2.1 Tables

**`public.profiles`**: one row per auth user, created by trigger `handle_new_user()` on `auth.users`.
| column | type | notes |
|---|---|---|
| id | uuid PK → auth.users(id) ON DELETE CASCADE | |
| display_name | text | |
| locale | text CHECK in ('vi','en') default 'vi' | default output language |
| preferred_sport | text CHECK in ('badminton','pickleball') | |
| skill_level | text CHECK in ('beginner','novice','intermediate','advanced') | self-reported |
| handedness | text CHECK in ('right','left') | |
| goals | text CHECK (char_length ≤ 200) | treated as data in the prompt |
| timezone | text default 'Asia/Ho_Chi_Minh' | |
| ai_consent_at / ai_consent_version | timestamptz / text | 5.1.2(i) and PDPL; server returns 403 if null |
| app_transaction_id | text null | from AppTransaction (P2: free-quota anti-abuse) |
| created_at / updated_at | timestamptz | |

**`public.analysis_sessions`**: one per upload.
| column | type | notes |
|---|---|---|
| id | uuid PK default gen_random_uuid() | |
| user_id | uuid → profiles ON DELETE CASCADE | |
| client_request_id | uuid NOT NULL | **UNIQUE(user_id, client_request_id)**, the idempotency key |
| sport | text CHECK in ('badminton','pickleball') | |
| subject | text CHECK in ('self','other'); subject_consent bool | if 'other', must be true |
| focus_stroke | text null | e.g. 'smash', 'clear', 'dink', 'third_shot_drop' |
| camera_view | text CHECK in ('side','behind','front','diagonal','unknown') | |
| language | text CHECK in ('vi','en') | |
| kind | text CHECK in ('basic','standard','deep') | |
| tier_at_request | text | 'free' or 'premium' |
| status | text CHECK in ('created','queued','processing','succeeded','rejected','failed','expired') | state machine |
| failure_code / failure_message | text | e.g. 'not_assessable', 'wrong_sport', 'model_refusal', 'upstream_timeout' |
| attempt_count | int default 0; next_attempt_at, locked_at | used by the worker |
| video_meta | jsonb | duration_s, fps, w, h, device_model, app_version |
| precheck | jsonb | on-device quality numbers |
| metrics_path / metrics_sha256 | text | object in Storage |
| frame_count | int | |
| model / effort / prompt_version / rubric_version / schema_version | text | for reproducibility |
| created_at / started_at / completed_at / updated_at | timestamptz | |

**`public.session_frames`**: id, session_id → sessions CASCADE, user_id, `frame_id` text ('F1'…'F12'), t_s numeric, stroke_index int, phase text CHECK in ('ready','preparation','contact','follow_through','recovery'), storage_path, width, height, bytes, sha256. UNIQUE(session_id, frame_id).

**`public.strokes`**: id, session_id CASCADE, user_id, stroke_index, type_guess, side CHECK in ('forehand','backhand','overhead','underhand','unknown'), t_start_s, t_contact_s, t_end_s, confidence real, `features` jsonb (per-stroke numbers from the device), `model_note` text (merged from the result). UNIQUE(session_id, stroke_index).

**`public.analysis_results`**:
| column | type |
|---|---|
| session_id | uuid PK → sessions CASCADE |
| user_id, sport, language | |
| is_assessable | bool |
| overall_score | smallint (final, computed by the server) |
| sub_scores | jsonb `[{dimension, model_score, anchor_score, final_score, confidence}]` |
| result | jsonb (normalized schema-v1 output) |
| raw_output | jsonb (exact parsed model output, for audits) |
| model, effort, prompt_version, rubric_version, schema_version | text |
| created_at | timestamptz |

**`public.analysis_translations`** (P2): (session_id, language) PK, result jsonb. Filled by Haiku 5.5 when the user switches language.

**`public.drills`** (bilingual catalog, seeded by migration):
id text PK (slug, e.g. `bd_shadow_6corner`), sport, `skill_tags` text[] (must match the dimension names), level_min, level_max, solo bool, equipment text[], duration_min int, `title`/`description`/`steps`/`cues`/`safety` jsonb `{vi, en}`, media_url, is_active, version, updated_at. MVP target: about 30 drills per sport.

**`public.drill_plans`** (premium): id, user_id, sport, source_session_ids uuid[], week_start date, items jsonb `[{drill_id, sessions_per_week, reps, note}]`, status.
**`public.drill_completions`**: id, user_id, plan_id, drill_id, completed_at, self_rating smallint.
**`public.feedback`**: session_id, user_id, rating smallint (−1 or 1), comment text, created_at. Feeds the eval set.

**Subscriptions and quotas:**

**`public.plan_limits`** (config, readable by authenticated users):
| column | example free | example premium |
|---|---|---|
| tier PK | 'free' | 'premium' |
| basic_per_month | 3 | 0 |
| standard_per_month | 0 (plus 1 lifetime trial: `trial_standard_lifetime`=1) | 20 |
| deep_per_month | 0 | 3 |
| max_video_seconds | 30 | 90 |
| max_frames | 6 | 8 standard / 12 deep |
| max_concurrent | 1 | 2 |
| models | jsonb `{"basic":["claude-haiku-5-5","medium"],"standard":["claude-sonnet-5-5","medium"],"deep":["claude-opus-5-5","high"]}` | |
| features | jsonb `{"progress":false,"drill_plans":false}` | `{"progress":true,"drill_plans":true}` |

**`public.app_store_subscriptions`**:
| column | type / notes |
|---|---|
| original_transaction_id | text PK |
| user_id | uuid null → profiles ON DELETE SET NULL (filled when linked) |
| app_account_token | uuid null (Supabase user UUID, set at purchase) |
| environment | text CHECK in ('Production','Sandbox','Xcode') |
| product_id, subscription_group_id | text |
| status | smallint (Apple: 1 active, 2 expired, 3 billing retry, 4 grace, 5 revoked) |
| auto_renew | bool; auto_renew_product_id text |
| expires_at, grace_period_expires_at | timestamptz |
| is_trial | bool (offerDiscountType = FREE_TRIAL) |
| revocation_date / revocation_reason | |
| last_transaction_id, last_signed_date | |
| last_notification_type / subtype | |
| last_verified_at | timestamptz |
| renewal_info / transaction_info | jsonb (decoded) |

**`public.entitlements`**: user_id PK, tier CHECK in ('free','premium'), source CHECK in ('app_store','promo','admin'), product_id, expires_at, will_renew bool, billing_issue bool, updated_at. Recomputed by `private.recompute_entitlement(uid)`.

**`public.usage_counters`**: (user_id, period_key 'YYYY-MM' in Asia/Ho_Chi_Minh, kind) PK, used int default 0, plus `trial_standard_used` on a lifetime row.
**`public.quota_ledger`**: id, user_id, **session_id UNIQUE**, kind, period_key, state CHECK in ('reserved','committed','refunded'), created_at, updated_at.

**`private` schema** (not exposed through the API):
- `private.appstore_notifications`: notification_uuid uuid PK (idempotency), notification_type, subtype, environment, original_transaction_id, signed_date, payload jsonb, received_at, processed_at, process_status, error.
- `private.apple_auth_tokens`: user_id PK, apple_sub, refresh_token_ciphertext (AES-GCM with an edge-function secret key), created_at.
- `private.llm_calls`: id, session_id, user_id, model, effort, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd numeric(10,5), latency_ms, stop_reason, anthropic_request_id, error_type, attempt, created_at.
- `private.audit_log`: event, user_hash (sha256 of uid plus pepper), at, meta jsonb. Used for deletions and refunds.
- `private.daily_spend`: day PK, cost_usd. A global budget guard checked before each Claude call.

### 2.2 SQL functions (all `SECURITY DEFINER SET search_path=''`; EXECUTE granted only to service_role unless noted)
- `public.current_tier(uid) → text`: `'premium'` if `entitlements.tier='premium' AND expires_at > now()`, otherwise `'free'`. Because it checks expiry itself, a missed webhook can never leave someone premium for good.
- `public.reserve_quota(uid, session_id, kind) → jsonb`:
  - Idempotent: if a ledger row exists, return ok.
  - Check plan limits.
  - Lock the counter row with `FOR UPDATE`, increment it, insert ledger state 'reserved'.
  - Return `{ok, tier, remaining}` or `{ok:false, code:'quota_exceeded', limit, used, resets_at}`.
- `public.commit_quota(session_id)` and `public.refund_quota(session_id)`: move reserved to committed, or reserved to refunded while decrementing `used`. Both are idempotent.
- `private.recompute_entitlement(uid)`: premium if any linked subscription has status ∈ {1,4} and `coalesce(grace_period_expires_at, expires_at) > now()` and no revocation.
- `public.get_progress(p_sport text) → setof(...)`: **SECURITY INVOKER**, granted to authenticated. Raises if `current_tier(auth.uid())='free'`. Returns `(session_id, created_at, overall_score, dimension, final_score)` for premium charts.
- `private.kick_worker()`: run by pg_cron every minute. If any session is `queued` with `next_attempt_at ≤ now()`, or `processing` with `locked_at < now()-'6 min'`, it calls `net.http_post` to `analysis-worker` with the `x-worker-secret` header (secret read from Supabase Vault).

### 2.3 RLS policies (summary)
| table | authenticated user can |
|---|---|
| profiles | SELECT and UPDATE where `id = (select auth.uid())`. Column grants: UPDATE only on display_name, locale, preferred_sport, skill_level, handedness, goals, timezone, ai_consent_*. |
| analysis_sessions | SELECT and DELETE own rows (DELETE cascades to results; the client removes the Storage folder first). **No INSERT/UPDATE**: only edge functions write. |
| session_frames, strokes, analysis_results, analysis_translations | SELECT own |
| drills, plan_limits | SELECT `using (true)` (drills: `is_active`) |
| entitlements, app_store_subscriptions, usage_counters | SELECT own |
| drill_plans | SELECT own |
| drill_completions | SELECT, INSERT and DELETE own (with check `user_id = auth.uid()`) |
| feedback | INSERT own (with check) and SELECT own |
| private.* | none (service role only) |

- **Realtime:** add `analysis_sessions` to the `supabase_realtime` publication. postgres_changes respects RLS for SELECT, and the client filters with `id=eq.<session_id>`. Later you can switch to `realtime.broadcast_changes()` on private channels [S6].
- **pg_cron jobs:**
  - `kick_worker` every minute.
  - `maintenance` daily: App Store reconcile, cleanup of 'created' sessions older than 24 h and their Storage files, and purging free-tier frames older than 180 days.
  - Hourly: `recompute_entitlement` for rows with `expires_at < now()`.

---

## 3. Storage
| bucket | public | limits | path | policies (storage.objects) |
|---|---|---|---|---|
| `analysis-inputs` | **private** | file_size_limit 1.5 MB; mime `image/jpeg`, `image/webp`, `application/json` | `{uid}/{session_id}/frames/F{n}.jpg`, `{uid}/{session_id}/metrics.json` | INSERT, SELECT and DELETE for authenticated where `bucket_id='analysis-inputs' AND (storage.foldername(name))[1] = (select auth.uid())::text` |
| `drill-media` | public | 10 MB, image/webp, video/mp4 | `{sport}/{drill_id}/…` | writes by service role only |
| (future) `analysis-videos` | private, opt-in only | | | not created in the MVP; full video is never uploaded by default |

- **Uploads:** the client uploads directly with its JWT under RLS, which is simplest. Alternatively `analysis-init` can return `createSignedUploadUrl` tokens; either works, and RLS is preferred.
- **Downloads:** history screens use `createSignedUrls(paths, 3600)` from the client, which is allowed by the SELECT policy. The worker downloads with the service role.
- **Frame prep on device:** crop the player's bounding box plus about 25% margin, resize to about **672×896 (portrait) or 896×504 (landscape)**, JPEG quality 0.8. That is about 768 or 576 visual tokens per frame [A2]. Never send 4K.

---

## 4. Edge Functions (Deno/TypeScript)

**Shared modules (`supabase/functions/_shared/`):**
- `auth.ts`: `requireUser(req)` uses `supabase.auth.getClaims(jwt)` or `@supabase/server` `withSupabase({auth:'user'})`.
- `db.ts`: service-role client.
- `errors.ts`: typed `{code, http}`.
- `log.ts`: structured JSON logs with `fn, req_id, session_id, step, ms, model, tokens, stop_reason, error_code`. Never log images, metrics or emails; hash the user id.
- `claude/`: client, `buildRequest.ts`, `prompts/*.ts` (rubrics generated from `.md` into TS string constants with a version hash), `schema.ts` (Zod plus JSON schema), `postprocess.ts`, `anchors.ts`.
- `quota.ts`.
- `apple/jwt.ts`: App Store Server API JWT via `jose` (`importPKCS8` + `SignJWT`).
- `apple/api.ts`: getAllSubscriptionStatuses, getTransactionInfo, notificationHistory, requestTestNotification.
- `apple/jws.ts`: decode without verification, plus best-effort verification. Pin **Apple Root CA – G3**. Check x5c length is 3; verify intermediate←root and leaf←intermediate signatures with WebCrypto ECDSA P-384/P-256 (convert DER signatures to raw r‖s); check OIDs (leaf `1.2.840.113635.100.6.11.1`, intermediate `1.2.840.113635.100.6.2.1`); check validity at `signedDate`; then `jose.compactVerify` ES256 with the leaf key. Avoid `node:crypto X509Certificate`, `pkijs` and `@peculiar/x509` in this runtime [P5].
- `apple/siwa.ts`: client-secret JWT plus `/auth/token` and `/auth/revoke`.
- `crypto.ts`: AES-GCM helpers.

### 4.1 `POST /analysis-init` (user JWT)
```ts
Req  { client_request_id: uuid, sport: 'badminton'|'pickleball', kind?: 'basic'|'standard'|'deep',
       subject: 'self'|'other', subject_consent: boolean, focus_stroke?: string,
       camera_view: 'side'|'behind'|'front'|'diagonal'|'unknown', language: 'vi'|'en',
       video_meta: { duration_s, fps, width, height, device_model, app_version },
       precheck: { person_detected_ratio, mean_kp_conf, full_body_ratio, blur, brightness, strokes_detected },
       frame_count: number }
200  { session_id, status:'created', upload: { bucket:'analysis-inputs', base_path:`${uid}/${session_id}/`,
       frames: [{frame_id:'F1', path}], metrics_path }, quota: { tier, kind, remaining, resets_at },
       resolved_kind: 'basic'|'standard'|'deep' }
```
- **Errors:**
  - 403 `consent_required`: AI consent or subject consent missing.
  - 422 `precheck_failed {reasons[]}`: server repeats the threshold checks.
  - 422 `invalid_payload`.
  - 402 `quota_exceeded`: preview only, nothing is reserved yet.
  - 413: duration over `max_video_seconds` or too many frames.
- **Idempotency:** the upsert on `(user_id, client_request_id)` returns the same session.
- **Kind resolution:** free users get `basic`, or `standard` if the lifetime trial is still unused. Premium users get `standard`, or `deep` if requested.

### 4.2 `POST /analyze` (user JWT) → background job
```ts
Req  { session_id: uuid }
202  { session_id, status:'queued', poll_after_ms: 3000 }        // started or already queued/processing
200  { session_id, status:'succeeded', result }                  // idempotent repeat
```
- **Errors:**
  - 404 `not_found` (not the caller's session).
  - 409 `invalid_state`.
  - 422 `missing_uploads | invalid_metrics {zod_issues}`.
  - 402 `quota_exceeded {tier, limit, used, resets_at}`.
  - 429 `too_many_concurrent`.
  - 503 `budget_guard`.
- **Synchronous steps:**
  1. Authenticate and load the session (must be the caller's, status `created`).
  2. List the Storage folder: frames must match `frame_count`, metrics must exist, size limits must hold.
  3. Download `metrics.json` and validate it with Zod `PoseMetricsV1` (max 8 strokes, max 30 samples per series, ≤ 64 KB).
  4. Insert `strokes` and `session_frames` rows.
  5. Call `reserve_quota` (idempotent per session_id).
  6. Set status to `queued`.
  7. `EdgeRuntime.waitUntil(runAnalysis(session_id))`.
  8. Return 202.
- **`runAnalysis(session_id)`**, shared with `analysis-worker`:
  1. **Claim:** `UPDATE … SET status='processing', locked_at=now(), attempt_count=attempt_count+1 WHERE id=$1 AND status='queued' RETURNING *`. Zero rows means another worker owns it, so exit.
  2. Download frames (service role) and base64-encode them. That is about 1 MB, well under the 2 s CPU budget.
  3. Compute **anchor scores**: deterministic per-dimension scores of 1–10 from the device features (pure TS, in §5.5).
  4. Build the request (§5.2) and call Claude with a per-request timeout: Haiku 90 s, Sonnet 200 s, Opus 330 s, SDK `maxRetries: 0`. The worker owns retries so the total stays under the 400 s wall clock.
  5. Handle the outcome:

     | outcome | action |
     |---|---|
     | `stop_reason='refusal'` | `failed / model_refusal`, refund quota |
     | `max_tokens` | retry once with 1.5× `max_tokens` |
     | `parsed_output == null` | retry once |
     | 429, 529 or 5xx, `APIConnectionTimeoutError` | `queued` with `next_attempt_at = now() + 30s·2^attempt`; after 3 attempts `failed / upstream_unavailable`, refund |
     | 400 `BadRequestError` | `failed / bad_request`, refund, alert |

  6. Post-process (§5.5). If `is_assessable=false`, or the sport doesn't match, set `rejected` with the reason, refund the quota, and still store the result so the app can show "how to re-record".
  7. Upsert `analysis_results` with `ON CONFLICT (session_id) DO NOTHING`, `commit_quota`, set status `succeeded`, insert `private.llm_calls`, add to `daily_spend`.
- **Client:** subscribe to Realtime `postgres_changes` (UPDATE on `analysis_sessions` with `id=eq.<id>`). As a fallback, poll every 3 s for up to 6 min. Optional P2: APNs push when done.

### 4.3 `POST /analysis-worker` (no JWT; header `x-worker-secret`)
`{}` → claims up to 5 eligible sessions and runs `runAnalysis` for each (sequentially under waitUntil) → `200 {picked:n}`. It also resets `processing` rows whose lock is older than 6 min back to `queued`.

### 4.4 `POST /verify-subscription` (user JWT)
```ts
Req  { signed_transaction?: string /* Transaction.jwsRepresentation */, original_transaction_id?: string,
       reason: 'purchase'|'restore'|'launch_sync'|'updates_listener' }
200  { tier:'free'|'premium', product_id?, expires_at?, will_renew?, in_grace?, billing_issue?, is_trial?,
       environment, linked: boolean }
409  { code:'linked_to_other_account' }   // see linking policy below
```
Flow:
1. Decode the JWS without trusting it. Take `originalTransactionId`, `environment`, `bundleId` (must equal `APPLE_BUNDLE_ID`) and `appAccountToken`. Also run the best-effort local signature check.
2. **Re-fetch** `GET {host}/inApps/v1/subscriptions/{originalTransactionId}`. The host is chosen by `environment`, and the request is authenticated by the ES256 JWT. Decode the `signedTransactionInfo` and `signedRenewalInfo` in the response; trust comes from the TLS connection to Apple.
3. **Linking policy:**
   - If `appAccountToken` equals the caller's uid, link.
   - If there is no token (offer codes, App Store-initiated purchases) and the row is unlinked, or linked to a deleted user, link to the caller.
   - If it is linked to another live user with a different token, return 409. The app explains: "this Apple ID's subscription belongs to another account."
4. Upsert `app_store_subscriptions`, run `recompute_entitlement`, return the entitlement.
5. **`environment='Xcode'`** (StoreKit config file testing): Apple's API cannot verify these. Accept them only when `ALLOW_XCODE_ENV=true`, which is set in the dev project only.

### 4.5 `POST /appstore-webhook` (Apple → us; App Store Server Notifications **V2**)
`Req { signedPayload: string }` → **always 200 quickly**, except on transient database or API failure, where it returns 500 so Apple retries.
1. Decode the payload. Run the best-effort JWS verification and log the result; a failure does not block, because trust comes from step 3.
2. `INSERT INTO private.appstore_notifications … ON CONFLICT (notification_uuid) DO NOTHING`. If it was a duplicate, return 200.
3. Decode `data.signedTransactionInfo` to get `originalTransactionId`. **Re-fetch the statuses from the App Store Server API**, upsert, recompute the entitlement for the linked user, and set `processed_at`.

| notificationType (subtype) [P9] | effect |
|---|---|
| SUBSCRIBED (INITIAL_BUY, RESUBSCRIBE), DID_RENEW (incl. BILLING_RECOVERY), OFFER_REDEEMED, DID_CHANGE_RENEWAL_PREF, DID_CHANGE_RENEWAL_STATUS, PRICE_INCREASE, RENEWAL_EXTENDED | re-fetch, upsert, premium if status is 1 or 4 |
| DID_FAIL_TO_RENEW (GRACE_PERIOD) | keep premium until `grace_period_expires_at`, set `billing_issue=true` (app shows "update payment") |
| DID_FAIL_TO_RENEW (no subtype), GRACE_PERIOD_EXPIRED, EXPIRED (*) | free unless the re-fetch says active |
| REFUND, REVOKE | free immediately, record the revocation, write an audit row |
| REFUND_REVERSED | re-fetch and restore |
| REFUND_DECLINED, CONSUMPTION_REQUEST, RENEWAL_EXTENSION, TEST, ONE_TIME_CHARGE | log only (MVP has no consumables, and no consumption info is sent) |

- Configure the **same URL for Production and Sandbox** in App Store Connect; the payload carries `environment`.
- Turn on **Billing Grace Period** in App Store Connect.
- `maintenance` runs `POST /inApps/v1/notifications/history` daily (last 26 h) to catch missed notifications. Use `requestTestNotification` during setup.

### 4.6 `POST /apple-auth-exchange` (user JWT)
- **Request:** `{ authorization_code }`. Call it right after Sign in with Apple; the code is short-lived.
- Build the client-secret JWT (ES256 signed with the SIWA key; `iss`=Team ID, `sub`=bundle ID, `aud`=`https://appleid.apple.com`, `exp` ≤ 6 months).
- `POST https://appleid.apple.com/auth/token` with `grant_type=authorization_code`, then store `refresh_token` AES-GCM encrypted in `private.apple_auth_tokens`.
- **Response:** `200 {stored:true}`.

### 4.7 `POST /delete-account` (user JWT), required by guideline 5.1.1(v)
```ts
Req  { confirm: 'DELETE' }
200  { deleted: true, had_active_subscription: boolean }  // app then shows "billing continues via Apple — cancel in Settings" + showManageSubscriptions
```
Each step is idempotent and safe to re-run:
1. Set `profiles.deleting=true`.
2. If there is an Apple identity and a stored refresh token, `POST https://appleid.apple.com/auth/revoke` with `{client_id, client_secret, token, token_type_hint:'refresh_token'}`. If no token exists, return a flag so the app shows Apple's manual-revoke instructions [P6].
3. Storage: list `{uid}/` in `analysis-inputs` page by page and `remove()` in batches of up to 1000 [S5].
4. Delete `private.apple_auth_tokens` and set `app_store_subscriptions.user_id = NULL` and `app_account_token = NULL`.
5. `auth.admin.deleteUser(uid, false)` (hard delete) cascades through profiles, sessions, results and the other tables.
6. Write `private.audit_log` with the hashed user id.

Optional P2: a `siwa-events` endpoint for Apple's `consent-revoked` and `account-delete` server notifications, verified with Apple's JWKS through `jose.createRemoteJWKSet`.

### 4.8 `POST /maintenance` (cron, secret header)
`{job:'reconcile'|'cleanup'}` runs notification-history reconciliation, refreshes subscriptions expiring within 48 h, removes stale `created` sessions and their Storage objects, and applies frame retention.

### 4.9 Cross-cutting rules
- **Timeouts:** every outbound `fetch` gets an `AbortSignal.timeout`. Apple API calls use 10 s with 2 retries on 5xx.
- **Logs:** Supabase Logs Explorer. Also keep the Anthropic `request_id` (`response._request_id`) in `llm_calls`.
- **Budget guard:** if `daily_spend > DAILY_BUDGET_USD`, return 503 `budget_guard` and alert.
- **Spend cap:** use a dedicated Anthropic workspace with a monthly spend limit.

---

## 5. Claude analysis design

### 5.1 Model and tier matrix (one schema and prompt family for all three)
| kind | who | model | effort | frames | max_tokens | est. latency |
|---|---|---|---|---|---|---|
| basic | free tier | `claude-haiku-5-5` | `medium` (compare with `low` in evals) | 6 | 12 000 | ~10–25 s |
| standard | premium, plus 1 lifetime trial for free users | `claude-sonnet-5-5` | `medium` (Sonnet defaults to `high`; set it explicitly) | 8 | 16 000 | ~30–80 s |
| deep | premium, 3 per month | `claude-opus-5-5` | `high` | 12 (+3D pose if available) | 16 000 | ~90–240 s, needs Pro's 400 s |

Latency figures are estimates; measure them.

- **Thinking:** leave it adaptive (the default) and don't send a `thinking` field. Read response blocks by `type`; responses may start with `thinking` blocks, which are empty by default.
- **No sampling parameters.** They return 400 on these models [A4].
- **Fallbacks:** on Sonnet and Opus requests, enable `fallbacks:"default"` with beta `server-side-fallback-2026-07-01` through `client.beta.messages`. If the pinned SDK's beta namespace has no `parse`, use `create` plus `jsonSchemaOutputFormat` and validate with Zod yourself. For coaching content this almost never triggers; Sonnet 5.5 fallback only covers the `cyber` and `frontier_llm` categories. **Do not send `fallbacks` for Haiku 5.5.** Handle `stop_reason:"refusal"` on every model.

### 5.2 Request layout (cache-friendly)
```ts
const resp = await client.messages.parse({           // npm:@anthropic-ai/sdk@0.135.0
  model, max_tokens,
  system: [
    { type: "text", text: BASE_SYSTEM_V1 },            // role, input spec, scoring rules, safety, VI/EN glossary (~1.5–2K tok)
    { type: "text", text: RUBRIC[sport],               // sport rubric + anchors + metric reference ranges + drill catalog IDs (~4–5K tok)
      cache_control: { type: "ephemeral" } },          // 5-min TTL; consider ttl:"1h" once traffic is steady (>3 req/h per model+sport)
  ],
  messages: [{ role: "user", content: [
    // images FIRST, each preceded by a label
    { type: "text", text: "Frame F1 — stroke 0, phase=preparation, t=3.20s" },
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64F1 } },
    // … F2..Fn
    { type: "text", text: userText /* XML-tagged blocks below */ },
  ]}],
  output_config: { effort, format: zodOutputFormat(AnalysisV1) },   // SAME schema for all tiers/models
}, { timeout: timeoutMs });
```
- **`userText` blocks:**
  - `<athlete_context>`: level, handedness, subject self/other, focus_stroke, goals inside `<user_goals>`, with an instruction to treat that text as data.
  - `<capture_info>`: camera view, fps, duration, device, pose engine.
  - `<quality_precheck>`.
  - `<anchor_scores>`: server-computed per-dimension scores of 1–10 with confidence.
  - `<metrics_json>`: compact JSON with keys in a fixed sorted order.
  - The final line: `Output language: vi`.
- **Why `language` goes in the user turn:** the cached prefix stays byte-identical for Vietnamese and English. Never put dates, user IDs or flags in `system`, because any changing byte there breaks the cache. Cache prefixes are per (model × sport), so 6 in total.
- **The schema must never change per tier.** Changing `output_config.format` invalidates the cache and recompiles the grammar [A3]. Bumping the schema version is a deploy-time event.
- **Coordinates:** Apple Vision's normalized origin is **bottom-left**. Convert to top-left on the device and document it in `BASE_SYSTEM`.
- **Rubric content (per sport):**
  - Stroke taxonomy and phases (ready, preparation, forward swing, contact, follow-through, recovery).
  - Dimensions and weights (§5.4), each with **1–10 anchor descriptors**: 1–2 basic errors on most reps; 3–4 the shape is there but there is a major flaw; 5–6 functional recreational play with 1–2 notable flaws; 7–8 solid with minor refinements; 9–10 competitive level.
  - Metric reference ranges by level, e.g. elbow angle at contact on clears ≥150°, contact point above and in front of the head, split step before the opponent's contact.
  - Common beginner faults with their metric signatures.
  - **The drill catalog as `id | tags | level | one-line EN`.** The model may only cite these IDs; localized drill text comes from the DB.
  - A VI/EN terminology glossary. Badminton: đập cầu = smash, phông cầu = clear, bỏ nhỏ = drop/net shot, lốp cầu = lift, giao cầu = serve, bộ chân = footwork. Pickleball terms stay in English with a Vietnamese gloss (dink, third shot drop, kitchen = vùng cấm vô-lê).
- **Tooling:** the rubric is generated from the `drills` seed, so `rubric_version` changes whenever the catalog does.

### 5.3 Output JSON schema (`analysis.v1`)
Every field is **required**: no optional fields and no unions, to stay inside the 24-optional / 16-union limits. Use `""`, `-1` or `[]` as sentinels. Ranges and counts are enforced in post-processing, not in the schema.
```json
{
  "type":"object","additionalProperties":false,
  "required":["schema_version","language","input_assessment","summary","level_estimate","overall_score","sub_scores","strokes_reviewed","strengths","weaknesses","improvements","safety_notes","not_assessable","next_recording_tips"],
  "properties":{
    "schema_version":{"type":"string","enum":["analysis.v1"]},
    "language":{"type":"string","enum":["vi","en"]},
    "input_assessment":{"$ref":"#/$defs/InputAssessment"},
    "summary":{"type":"string","description":"2–3 encouraging sentences"},
    "level_estimate":{"type":"string","enum":["beginner","novice","intermediate","advanced","unclear"]},
    "overall_score":{"type":"integer","description":"0–100 (server recomputes)"},
    "sub_scores":{"type":"array","items":{"$ref":"#/$defs/SubScore"}},
    "strokes_reviewed":{"type":"array","items":{"$ref":"#/$defs/StrokeReview"}},
    "strengths":{"type":"array","items":{"$ref":"#/$defs/Strength"},"description":"1–4"},
    "weaknesses":{"type":"array","items":{"$ref":"#/$defs/Weakness"},"description":"1–5, most impactful first"},
    "improvements":{"type":"array","items":{"$ref":"#/$defs/Improvement"},"description":"exactly 3, priority 1..3"},
    "safety_notes":{"type":"array","items":{"$ref":"#/$defs/SafetyNote"}},
    "not_assessable":{"type":"array","items":{"$ref":"#/$defs/NotAssessable"}},
    "next_recording_tips":{"type":"array","items":{"type":"string"}}
  },
  "$defs":{
    "InputAssessment":{"type":"object","additionalProperties":false,
      "required":["is_assessable","sport_detected","sport_matches_request","person_visibility","camera_view","issues","confidence","confidence_score"],
      "properties":{
        "is_assessable":{"type":"boolean"},
        "sport_detected":{"type":"string","enum":["badminton","pickleball","tennis","other","unclear"]},
        "sport_matches_request":{"type":"boolean"},
        "person_visibility":{"type":"string","enum":["good","partial","poor"]},
        "camera_view":{"type":"string","enum":["side","behind","front","diagonal","unclear"]},
        "issues":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["code","message"],
          "properties":{"code":{"type":"string","enum":["no_person","multiple_people","subject_cut_off","too_dark","motion_blur","too_far","occlusion","wrong_sport","no_strokes_detected","camera_angle_limits","clip_too_short","other"]},
                        "message":{"type":"string"}}}},
        "confidence":{"type":"string","enum":["high","medium","low"]},
        "confidence_score":{"type":"integer","description":"0–100"}}},
    "SubScore":{"type":"object","additionalProperties":false,
      "required":["dimension","score","assessable","confidence","rationale"],
      "properties":{
        "dimension":{"type":"string","enum":[
          "bd_grip_racket_prep","bd_ready_split_step","bd_footwork_movement","bd_overhead_contact","bd_swing_kinetic_chain","bd_net_short_game","bd_serve","bd_balance_recovery",
          "pb_ready_paddle_up","pb_split_step_footwork","pb_dink_soft_game","pb_drive_groundstroke","pb_third_shot_drop","pb_kitchen_positioning","pb_volley_reset","pb_serve_return","pb_balance_recovery"]},
        "score":{"type":"integer","description":"1–10 using rubric anchors"},
        "assessable":{"type":"boolean"},
        "confidence":{"type":"string","enum":["high","medium","low"]},
        "rationale":{"type":"string"}}},
    "Evidence":{"type":"object","additionalProperties":false,
      "required":["frame_id","timestamp_s","stroke_index","metric","observed","reference","observation"],
      "properties":{
        "frame_id":{"type":"string","description":"F1..F12 or \"\""},
        "timestamp_s":{"type":"number"},
        "stroke_index":{"type":"integer","description":"-1 = whole session"},
        "metric":{"type":"string","description":"metrics_json key or \"\" if visual only"},
        "observed":{"type":"string","description":"e.g. \"128°\""},
        "reference":{"type":"string","description":"e.g. \"≥150° at contact\""},
        "observation":{"type":"string"}}},
    "StrokeReview":{"type":"object","additionalProperties":false,
      "required":["stroke_index","stroke_type","side","quality","note"],
      "properties":{
        "stroke_index":{"type":"integer"},
        "stroke_type":{"type":"string","enum":["clear","smash","drop","net_shot","lift","drive","serve_short","serve_long","defensive_block","pb_serve","pb_return","dink","third_shot_drop","pb_drive","volley","reset","lob","overhead","unknown"]},
        "side":{"type":"string","enum":["forehand","backhand","overhead","unknown"]},
        "quality":{"type":"string","enum":["good","ok","needs_work"]},
        "note":{"type":"string"}}},
    "Strength":{"type":"object","additionalProperties":false,"required":["title","detail","dimension","evidence"],
      "properties":{"title":{"type":"string"},"detail":{"type":"string"},"dimension":{"type":"string"},
                    "evidence":{"type":"array","items":{"$ref":"#/$defs/Evidence"}}}},
    "Weakness":{"type":"object","additionalProperties":false,"required":["title","detail","dimension","severity","likely_cause","evidence"],
      "properties":{"title":{"type":"string"},"detail":{"type":"string"},"dimension":{"type":"string"},
                    "severity":{"type":"string","enum":["high","medium","low"]},"likely_cause":{"type":"string"},
                    "evidence":{"type":"array","items":{"$ref":"#/$defs/Evidence"}}}},
    "Improvement":{"type":"object","additionalProperties":false,
      "required":["priority","title","why","how_to_fix","cues","drill_ids","linked_weakness_index","target_metric","target_current","target_goal","expected_timeframe"],
      "properties":{"priority":{"type":"integer"},"title":{"type":"string"},"why":{"type":"string"},"how_to_fix":{"type":"string"},
                    "cues":{"type":"array","items":{"type":"string"}},
                    "drill_ids":{"type":"array","items":{"type":"string"},"description":"1–3 IDs from catalog only"},
                    "linked_weakness_index":{"type":"integer","description":"-1 if none"},
                    "target_metric":{"type":"string"},"target_current":{"type":"string"},"target_goal":{"type":"string"},
                    "expected_timeframe":{"type":"string"}}},
    "SafetyNote":{"type":"object","additionalProperties":false,"required":["kind","message"],
      "properties":{"kind":{"type":"string","enum":["warmup","load_management","technique_injury_risk","equipment","consult_professional"]},
                    "message":{"type":"string"}}},
    "NotAssessable":{"type":"object","additionalProperties":false,"required":["aspect","reason","how_to_capture"],
      "properties":{"aspect":{"type":"string"},"reason":{"type":"string"},"how_to_capture":{"type":"string"}}}
  }
}
```
In TypeScript, write this as a Zod schema without `.min/.max` and use `zodOutputFormat(AnalysisV1)`. Strict counts and ranges belong in post-processing, so a count violation never throws away a paid response.

### 5.4 Dimension weights
These are server constants per sport and can be scaled by `focus_stroke`.
- **Badminton:** overhead_contact 0.18, swing_kinetic_chain 0.16, footwork 0.18, ready_split_step 0.10, grip_prep 0.12, balance_recovery 0.12, net_short_game 0.08, serve 0.06.
- **Pickleball:** ready_paddle_up 0.12, split_step_footwork 0.14, dink_soft_game 0.16, drive_groundstroke 0.14, third_shot_drop 0.12, kitchen_positioning 0.12, volley_reset 0.10, serve_return 0.05, balance_recovery 0.05.

### 5.5 Post-processing (`postprocess.ts`, pure and unit-tested)
1. Check `language` and `schema_version`. Keep only dimensions belonging to the sport; dedupe; clamp scores to 1–10. Dimensions the model left out are added as `assessable:false`.
2. **Score anchoring:** `final_d = clamp(model_d, anchor_d−2, anchor_d+2)` when the anchor's confidence is high; otherwise use the model's score. **Overall = round(10·Σw·final / Σw)** over assessable dimensions. Store both the model and anchor values.
3. Trim strengths to 4, weaknesses to 5 and improvements to 3, sorted by priority. Drop `drill_ids` that are not in the active catalog for that sport. If an improvement is left with no drill, pick one deterministically by dimension tag.
4. Evidence: `frame_id` must be in the sent set or `""`; `timestamp_s` must be within [0, duration]; `stroke_index` must be valid. Otherwise blank the reference rather than failing.
5. Run a medical-term scan in EN and VI (e.g. "diagnos", "chẩn đoán", "viêm gân", "rách dây chằng", "tendinitis"). If it hits, log `flag_medical`, replace the text with a generic `consult_professional` note, and send it for review.
6. If `is_assessable=false` or `sport_matches_request=false`, set the session to `rejected` and refund the quota.

### 5.6 Estimated cost per analysis
Assumptions:
- Cached prefix ≈ 7K tokens.
- Uncached input ≈ 14K tokens: 8 frames × 768, plus about 7K of metrics, plus about 0.8K of context.
- Output: Vietnamese JSON about 3.5K tokens (English about 2.5K), plus thinking (Haiku about 1K, Sonnet about 2.5K, Opus about 6K).
- Deep: 12 frames, so about 17K uncached input.

| model | input (uncached) | cache read | output + thinking | **total (cache hit)** | cold cache adds | ≈ VND (@26k/USD) |
|---|---|---|---|---|---|---|
| Haiku 5.5 | 14K × $0.10 = $0.0014 | ~$0.0001 | 4.5K × $0.50 = $0.0023 | **≈ $0.004** | +$0.001 | ~100₫ |
| Sonnet 5.5 | 14K × $2 = $0.028 | 7K × $0.10 = $0.0007 | 6K × $10 = $0.060 | **≈ $0.09** | +$0.017 | ~2,300–2,800₫ |
| Opus 5.5 (deep) | 17K × $4 = $0.068 | 7K × $0.20 = $0.0014 | 10K × $20 = $0.20 | **≈ $0.27** | +$0.034 | ~7,000–8,000₫ |

- **Check before relying on these numbers:** run `count_tokens` and one real call per model with a fixture payload. That costs money, so get approval first.
- **Output is the main cost.** Keep the JSON short (2–3 sentences per field) and use `effort` as the main cost lever.
- **Batch API (−50%)** doesn't fit the interactive flow. Use it only for future overnight items such as monthly progress reports.
- **Rate limits:** image tokens count toward input-tokens-per-minute; cache reads don't count on most models. Check the account tier's limits for each 5.5 model before launch.

---

## 6. Guardrails
- **On-device pre-checks** (the server re-checks the numbers in `analysis-init`):
  - Duration 3 s to `max_video_seconds`; fps ≥ 24 (recommend 60 or 120).
  - Person detected in ≥ 70% of sampled frames.
  - Mean confidence of key joints (shoulders, elbows, wrists, hips, knees, ankles) ≥ 0.5.
  - Full body visible in ≥ 60% of frames.
  - Blur (Laplacian variance) and brightness thresholds.
  - At least 1 stroke detected from wrist-speed peaks.
  - If several people appear, the user taps the subject, which is then tracked by bounding-box overlap.
  - On failure, show capture tips and use no quota.
- **Model checks:** `input_assessment` is the first field. If `is_assessable` is false, or the detected sport is wrong, or confidence is low, set `rejected` with a localized reason and refund the quota. Every dimension can be marked `assessable:false`, and the `not_assessable[]` list explains what was missing. Single-camera 2D pose has blind spots (wrist pronation, racket face angle, depth), and the prompt makes the model say so.
- **No medical claims:**
  - The system prompt forbids diagnosis.
  - Safety notes are limited to generic injury prevention (warm-up, load, "see a qualified coach/physio if pain").
  - The post-filter in §5.5 catches slips.
  - The UI carries a standard disclaimer.
- **Consistent scores:** temperature is not available, so consistency comes from:
  - deterministic anchor scores,
  - descriptor anchors in the rubric,
  - structured outputs,
  - server-computed overall scores,
  - versioned `prompt_version`, `rubric_version` and `schema_version` stored on every result,
  - an eval set of about 30 fixture payloads labeled by a coach. Run each 5× and require the overall-score standard deviation to be ≤ 3 points out of 100 and the mean absolute error against the coach ≤ 8 before changing prompts or models.
- **Prompt injection (minor):** only `goals` is free text. It is capped at 200 characters, wrapped in tags, and declared to be data. Text visible inside frames is ignored.
- **Privacy:**
  - 5.1.2(i) consent screen before the first analysis. It names Anthropic/Claude as the recipient and says what is sent (key frames, pose metrics, level and goals). `ai_consent_at` is required server-side.
  - Attestation of the filmed person's consent when the subject is someone else.
  - Under PDPL, a transfer impact assessment for Supabase (Singapore) and Anthropic (US). Legal review is needed.

---

## 7. StoreKit 2 subscriptions
- **App Store Connect setup:**
  - One subscription group, "Premium", with `…premium.monthly` and `…premium.yearly`. Put both **at the same level** so switching between them is a crossgrade.
  - Introductory offer: a 7-day free trial (on yearly at least; check eligibility with `isEligibleForIntroOffer`).
  - **Family Sharing off.** Leave it unset; it cannot be turned off once enabled.
  - Billing Grace Period on.
  - Apple Small Business Program (15% commission).
  - Notifications V2 URL pointing at the `appstore-webhook` function.
- **Client:**
  - Purchase with `product.purchase(options: [.appAccountToken(supabaseUserUUID)])`. With `SubscriptionStoreView` (iOS 17+), use `.inAppPurchaseOptions { _ in [.appAccountToken(uid)] }` [P10] and `.storeButton(.visible, for: .restorePurchases)`.
  - Start the `Transaction.updates` listener at launch.
  - For every verified transaction, call `verify-subscription` first and **only then** call `transaction.finish()`.
  - On launch, if `Transaction.currentEntitlements` is not empty but the server says free, send them for sync.
  - Restore: `AppStore.sync()`, then send `currentEntitlements`.
  - `AppTransaction.shared` (`appTransactionID`) can be stored for free-quota anti-abuse (P2).
- **Paywall choice:** use `SubscriptionStoreView` for the MVP. It handles localization, intro offers, restore, and the legally required price and terms text. A custom paywall is only worth it for A/B tests later.
- **Local testing:**
  - Add a `Products.storekit` file wired through XcodeGen (`schemes.<App>.run.storeKitConfiguration`).
  - Transactions from it have `environment == .xcode` and **cannot be verified by Apple's server API**, so they need the dev-only flag `ALLOW_XCODE_ENV`.
  - Test the server flows end to end with sandbox accounts and TestFlight.
- **Entitlement rules:** the server's `entitlements` table, checked through `current_tier()`, decides what a user gets. The client's StoreKit state only drives the UI.
- **RevenueCat vs direct:**
  - RevenueCat removes JWS and notification handling, adds analytics, paywall experiments and Android support, and has a free tier and then a revenue share (check current pricing). It is also another data processor under PDPL.
  - Going direct, as decided, is manageable for one platform and one group. Keeping the `entitlements` table as an abstraction means RevenueCat webhooks could replace the Apple module later.

---

## 8. Freemium quotas (server-enforced; values live in `plan_limits`)
| | Free | Premium (monthly or yearly) |
|---|---|---|
| Analyses | 3 **basic** (Haiku) per calendar month (Asia/Ho_Chi_Minh), plus **1 lifetime standard** (Sonnet) as a taste | **20 standard** (Sonnet) plus **3 deep** (Opus) per month, as a fair-use cap |
| Video length / frames | 30 s / 6 | 90 s / 8 (deep: 12) |
| Report | full report, but the app shows the top 2 strengths and weaknesses and 1 improvement; the rest is locked | full report, plus language switch |
| History | own reports are always viewable (it is their data) | plus progress charts (`get_progress`), trends, drill plans and completion tracking |
| Worst-case model cost per user per month | ≈ $0.10 | ≈ 20 × $0.09 + 3 × $0.27 ≈ **$2.6** (typical use of 6 standard + 1 deep ≈ $0.8) |

- **Pricing check:** a price around 99–129k₫ per month nets roughly $3–3.8 after Apple's 15%, which covers the worst case. Keep the caps tunable.
- **Enforcement:**
  - `reserve_quota` runs inside `analyze`; nothing is reserved at init.
  - Commit on success; refund on `rejected` or `failed`.
  - Concurrency is capped by `max_concurrent`.
  - A per-user hourly cap of 6 starts guards against scripted abuse.
  - A global daily spend guard sits above all of it.

---

## 9. Linux verification plan (inside the container)
- **Edge logic:** run `npx deno@2.9.6 test` (npm and jsr are reachable) on the pure modules:
  - Zod fixtures for `PoseMetricsV1` and `AnalysisV1`.
  - **Prompt determinism:** a byte-identical system prompt for vi and en, plus a snapshot test.
  - anchors, postprocess, the quota state machine (fake database), the webhook routing table, linking policy and delete-account orchestration, all with mocks.
  - The Claude wrapper, using an injected `fetch` to simulate refusal, `max_tokens`, 429 and 529 responses.
  - Apple JWT signing and `jws.ts` against a **test CA chain generated with `openssl`**: a P-384 root, an intermediate carrying OID `1.2.840.113635.100.6.2.1`, and a P-256 leaf carrying `…6.11.1`.
- **SQL and RLS:** the container has **PostgreSQL 16 server binaries** (`/usr/lib/postgresql/16/bin/initdb`, `pg_ctl`, `psql`).
  - Start a temporary cluster and load `tests/sql/supabase_shim.sql`: roles `anon`, `authenticated` and `service_role`; `auth.users`; `auth.uid()` reading `request.jwt.claims`; `storage.foldername()`.
  - Apply the migrations and run assertion scripts using `SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claims=…`.
  - Keep pg_cron, pg_net and Vault in a separate migration that the test run skips.
  - PGlite 0.5.x is an alternative.
  - On the Mac, `supabase start` plus `supabase test db` (pgTAP) and `supabase functions serve` give end-to-end coverage. The Docker daemon is not running in the container.
- **Live smoke test (needs approval, spends money):** `scripts/smoke_claude.ts` sends one fixture to each model and prints the four usage meters, to validate the cost estimates and the cache hit on the second call.
- **First-day spike on a deployed Supabase project:** import `jws.ts` and the Apple test notification, to confirm that WebCrypto P-384 works and the bundle boots.

---

## 10. Secrets (Edge Function environment)
- `ANTHROPIC_API_KEY`
- `APPLE_BUNDLE_ID`, `APPLE_APP_APPLE_ID` (numeric)
- `APPLE_IAP_KEY_ID`, `APPLE_IAP_ISSUER_ID`, `APPLE_IAP_PRIVATE_KEY` (.p8)
- `APPLE_SIWA_TEAM_ID`, `APPLE_SIWA_KEY_ID`, `APPLE_SIWA_PRIVATE_KEY`
- `TOKEN_ENC_KEY` (32-byte base64)
- `WORKER_SECRET` (also stored in Vault for pg_net)
- `DAILY_BUDGET_USD`
- `ALLOW_XCODE_ENV` (dev only)
- `SUPABASE_URL` and the service/secret key, which Supabase injects.

---

## 11. Risks and open items
1. **Apple certificate-chain checks in Deno.** The design does not depend on them, because entitlements come from Apple's API over TLS. Still, spike `jws.ts` early.
2. **Wall clock.** The design needs the Pro plan. Opus deep at `high` effort can approach 400 s, so cap `max_tokens` and fall back to `medium` if p95 latency exceeds 250 s.
3. **Single-camera 2D pose limits.** Ship capture guidance (side view, full body, 60 fps) and lean on the model's "not assessable" output.
4. **Vietnamese output quality.** Use the glossary, have a native coach review 20 samples, and use the `feedback` table.
5. **Purchases without `appAccountToken`** (offer codes, App Store-initiated purchases). Handled by the linking policy in §4.4.
6. **Legal.** PDPL cross-border filing, consent of people filmed, minors (age rating 4+ or 9+), and privacy-policy wording about third-party AI processing.
7. **Supabase docs could not be fetched directly** from this environment (supabase.com is blocked by the proxy). The limits here come from search results quoting the official pages. Re-check [S1] before launch.

---

## Sources
- [S1] https://supabase.com/docs/guides/functions/limits
- [S2] https://supabase.com/docs/guides/functions/background-tasks.md
- [S3] https://supabase.com/docs/guides/troubleshooting/edge-functions-worker-timeouts-and-websocket-drops
- [S4] https://supabase.com/docs/guides/functions/auth.md · https://supabase.com/docs/guides/getting-started/api-keys · https://jsr.io/@supabase/server
- [S5] https://supabase.com/docs/guides/troubleshooting/storage-unexpectedly-high-usage-or-exceed_storage_size_quota-errors-ae21a5
- [S6] https://supabase.com/docs/guides/realtime/subscribing-to-database-changes
- [A1] https://platform.claude.com/docs/en/about-claude/pricing
- [A2] https://platform.claude.com/docs/en/build-with-claude/vision
- [A3] https://platform.claude.com/docs/en/build-with-claude/structured-outputs
- [A4] Claude API reference bundled with Claude Code: the Sonnet 5.5, Haiku 5.5 and Opus 5.5 migration notes and the prompt-caching notes. Live versions: https://platform.claude.com/docs/en/about-claude/models/overview and https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- [P1] https://developer.apple.com/documentation/appstoreserverapi/generating-json-web-tokens-for-api-requests
- [P2] https://developer.apple.com/documentation/appstoreserverapi/get-all-subscription-statuses
- [P3] https://developer.apple.com/documentation/appstoreserverapi/app-store-server-api-changelog
- [P4] https://www.npmjs.com/package/@apple/app-store-server-library (v3.1.0, 2026-05-06; I inspected the source, which uses `node:crypto` X509Certificate and jsrsasign)
- [P5] https://qiita.com/christhemart/items/ac19a3f951bbc724f629 · https://questions.deno.com/m/1216891091563970560
- [P6] https://developer.apple.com/documentation/technotes/tn3194-handling-account-deletions-and-revoking-tokens-for-sign-in-with-apple
- [P7] https://developer.apple.com/app-store/review/guidelines/#login-services · https://developer.apple.com/forums/thread/765145
- [P8] https://techcrunch.com/2025/11/13/apples-new-app-review-guidelines-clamp-down-on-apps-sharing-personal-data-with-third-party-ai
- [P9] https://developer.apple.com/documentation/appstoreservernotifications/notificationtype
- [P10] https://developer.apple.com/forums/thread/775028
- [L1] https://legal.pwc.de/en/news/articles/pwc-vietnam-new-personal-data-protection-law · https://digitalpolicyalert.org/event/36569-implementing-regulations-of-law-on-personal-data-protection-including-cross-border-data-transfer-regulation-entered-into-force

**Downloaded file:** `/tmp/claude-0/-home-user/5763de0e-dfa6-5efd-bb66-dcb23248da78/scratchpad/apple/package/dist/jws_verification.js` is the Apple library source I inspected. No project files were created.
