# Database (M5)

Postgres schema, RLS, functions, Storage and cron for RacketCoach. The spec is DESIGN.md §6.5–6.6, §8.1, §8.7 and
§9.3–9.5 (v1.1), on top of DESIGN-v1.0 §6.5. This page lists what exists and how to call it.

| Path | Contents |
|---|---|
| `supabase/config.toml` | Local stack: anonymous sign-ins, manual linking, 6-digit email OTP, email confirmations on, `private` exposed to the API, `per_worker` edge runtime |
| `supabase/templates/*.html` | OTP email templates (`magic_link`, `email_change`, `confirmation`), each with `{{ .Token }}` |
| `supabase/migrations/20261020000100_core.sql` | Schemas, default privileges, `profiles`, `analyses`, `analysis_results`, `feedback`, auth-user triggers |
| `…0200_billing.sql` | `plan_limits`, `model_routes`, `entitlements`, `app_store_subscriptions`, `usage_counters`, `quota_ledger` |
| `…0300_private.sql` | `private.*` tables |
| `…0400_functions.sql` | Quota, job, entitlement, spend and merge functions; client RPCs |
| `…0500_rls.sql` | Grants and RLS policies |
| `…0600_storage.sql` | Buckets and Storage policies |
| `…0700_analytics_config.sql` | `app_config`, `enabled_skills`, `events`, `log_event`, retention helper |
| `…0900_cron.sql` | pg_net and pg_cron jobs |
| `supabase/seed.sql` | Plan limits, model routes, app config, enabled skills, local demo reviewer email |
| `supabase/tests/database/*.test.sql` | pgTAP tests (11 files) |
| `supabase/tests/sql/*.sh` | Runner, concurrency proof, fixture check, HTTP smoke test |

## Conventions

- Enum-like columns are `text` with a `CHECK`. Every table has RLS enabled; policies use `(select auth.uid())`.
- Clients (`anon`, `authenticated`) get no access by default. Migration 0100 revokes Supabase's default grants, and
  0500/0700 list every client grant. 0100 also removes PostgreSQL's global EXECUTE-to-PUBLIC default for functions
  (`alter default privileges revoke execute on functions from public`, with no `in schema`: a per-schema statement
  cannot remove a global default). A function added by a later migration is therefore service-role only until it is
  granted explicitly; `010_schema_seed` checks this.
- All functions are `SECURITY DEFINER SET search_path = ''` with schema-qualified names. A pgTAP test enforces this.
- Calendar periods use ICT (`Asia/Ho_Chi_Minh`, fixed `+07:00`). Timestamps returned as strings look like
  `2026-11-01T00:00:00+07:00`.
- Lock order: take the per-user advisory lock (`pg_advisory_xact_lock(hashtextextended(uid::text, 0))`) before any
  row lock.
- Client RPCs report errors as PostgREST status codes through `SQLSTATE 'PTnnn'`. The message is the contracts
  `ApiErrorCode`: `PT401 unauthorized`, `PT403 forbidden`, `PT404 analysis_not_found`, `PT422 invalid_payload`.
- `private` functions return `{ok:false, code}` (or `false`/`null`). The Edge Function maps that to HTTP.

## Tables

### `public`

| Table | Notes | Client access |
|---|---|---|
| `profiles` | One row per auth user, anonymous users included. A trigger on `auth.users` creates it. `birth_year` is checked by a trigger against `app_config.min_user_age`: below the minimum raises `under_min_age`; exactly the minimum without `age_attested` raises `age_attestation_required` (both `23514`). `*_consent_at` is set by a trigger whenever the version changes. `is_reviewer` comes from `private.reviewer_emails` | SELECT own; UPDATE own on `locale, handedness, level, birth_year, age_attested, pdpl_consent_version, ai_consent_version, calibration_opt_in, consumption_consent` |
| `analyses` | Client-generated lowercase `id`. Holds `prepared` (engine output), `pose_raw_path`/`pose_clean_path` (object names in `analysis-derived`), `frame_mode`, `subject_minor`, `excluded_strokes`, `view_confirmed`, `kind`, `attempt_count`, `next_attempt_at`, `locked_at`, `max_tokens_mult`, `last_error_code`. `status` ∈ prepared/queued/processing/succeeded/rejected/failed | SELECT own on `id, user_id, sport, skill, status, failure_code, camera_view, subject, created_at, completed_at`; DELETE own |
| `analysis_results` | The full `coach-result.v1` (`access: full`), plus the exact `overall_score` and the display columns used by history and progress | none (use `get_result`) |
| `feedback` | (`analysis_id`, `user_id`) PK; `rating` ∈ {−1, 1}; `comment` ≤ 500. `user_id` defaults to `auth.uid()` | SELECT own; INSERT own, only on own analyses |
| `plan_limits` | One row per tier (seeded) | SELECT for everyone |
| `model_routes` | `basic` / `standard`: `model`, `effort`, `max_tokens`, `timeout_ms`, `fallbacks` (`'default'` or null), `betas` | none |
| `entitlements` | `tier`, `is_trial`, `expires_at` (already coalesced with grace), `period_anchor`, `original_transaction_id`, `will_renew`, `billing_issue`, `in_grace`, `source` | SELECT own |
| `app_store_subscriptions` | One row per `original_transaction_id`. `user_id` is set to null when the user is deleted. Also holds `original_purchase_at`, `period_anchor`, `transfer_count_30d` | none |
| `usage_counters` | (`user_id`, `period_key`): `used`, `used_standard`, `retries_used`, `bonus_used` (on the `lifetime` row) | SELECT own |
| `quota_ledger` | One row per submitted analysis: `period_key`, `kind`, `is_bonus`, `state` (reserved/committed/refunded), `refund_reason` | none |
| `events` | First-party analytics; `props` must be an object ≤ 2 KB; `source` is client or server | none (write through `log_event`) |
| `app_config` | Key/value flags (see below) | SELECT for everyone |
| `enabled_skills` | `skill`, `sport`, `enabled` | SELECT for everyone |

Period keys: `YYYY-MM` is the ICT calendar month (free). `trial:<origTx>` covers the whole trial. Premium uses
`sub:<origTx>:<YYYY-MM-DD>`, one window per month from `period_anchor`, computed as anchor + n months, so a
Jan 31 anchor gives windows starting Feb 28 and Mar 31. Without an anchor (for example a manual entitlement), the
premium windows are ICT calendar months. `lifetime` tracks the first-ever bonus.

### `private` (service role only)

The `private` tables are `appstore_notifications`, `apple_auth_tokens`, `llm_calls`, `llm_outputs`, `daily_spend`
(per ICT day), `user_monthly_cost` (per ICT month), `link_transfers`, `audit_log` and `reviewer_emails`.

`private` is listed in `[api] schemas`, so Edge Functions can reach it with
`createClient(url, SECRET_KEY).schema('private')`. `anon` and `authenticated` have no USAGE on the schema, so a
client request gets 401 or 403.

### `app_config` keys (seeded)

| Key | Value |
|---|---|
| `min_user_age` | `18` (D21) |
| `consent_versions` | `{"pdpl": "2026-10-01", "ai": "2026-10-01"}` |
| `budget_usd` | `30` (daily, ICT) |
| `budget_alert_ratio` | `0.7` |
| `budget_hard_cap_mult` | `2` |
| `event_allowlist` | JSON array of allowed client event names |
| `event_daily_limit` | `300` |
| `event_props_max_bytes` | `2048` |

## Functions

### Service role: `db.schema('private').rpc(name, args)`

| Function | Returns | Notes |
|---|---|---|
| `upsert_prepared_analysis(p_user_id, p_analysis_id, p_fields jsonb)` | boolean | `prepare`/`reprepare`. `p_fields` uses `analyses` column names; on update, absent keys keep their value. `status` is `prepared` or `rejected`, with `failure_code`. `false` → 409 `analysis_conflict` (the id belongs to someone else, or is past prepared/rejected) |
| `quota_status(p_user_id)` | jsonb | Read-only snapshot. Build `QuotaPreview` from `{tier, remaining, nextKind, resets_at}` |
| `consent_current(p_user_id)` | boolean | Submit step 2 |
| `reserve_for_submit(p_user_id, p_analysis_id, p_device_bonus_ok)` | jsonb | `{ok:true, kind, remaining, resets_at, tier, status, period_key, bonus, idempotent}`, or `{ok:false, code}` with `code` ∈ `analysis_not_found`, `analysis_conflict`, `in_flight` (+`limit`, `used`), `quota_exceeded` (+`limit`, `used`, `resets_at`, `tier`). `idempotent:true` means already queued, processing or succeeded. Under the 70 % budget, pass `p_device_bonus_ok = false` so free standard becomes basic |
| `claim_analysis(p_analysis_id)` | int or null | The new attempt number. Claims `queued` jobs whose `next_attempt_at` has passed, or `processing` jobs locked more than 8 min ago |
| `finalize_analysis(p_analysis_id, p_attempt, p_result jsonb, p_overall_score real = null, p_model text = null)` | boolean | Fenced on (attempt, processing). Stores `p_result` (`access` forced to full) once. A rejected result refunds `rejected` and a partial one refunds `partial`, both under the retry cap; anything else commits. `false` means the fence was lost: discard the output |
| `requeue_analysis(p_analysis_id, p_attempt, p_delay_s, p_code, p_max_tokens_mult real = null)` | boolean | Fenced |
| `fail_analysis(p_analysis_id, p_attempt, p_code)` | boolean | Fenced. Gives a full refund and returns the first-ever bonus; uses no retry |
| `refund_quota(p_analysis_id, p_reason)` | jsonb | `{refunded:true, reason}` or `{refunded:false, code}` with `code` ∈ `retry_cap`, `already_refunded`, `already_committed`, `not_found`. Only `rejected` and `partial` count against `free_retry_limit` per period |
| `commit_quota(p_analysis_id)` | boolean | Idempotent |
| `tier_of(p_user_id, p_at = now())` | text | `premium` or `trial` while `entitlements.expires_at > p_at`; otherwise `free` |
| `period_window(p_tier, p_at, p_original_transaction_id, p_anchor)` | table | Pure; returns `period_key, period_start, resets_at` |
| `recompute_entitlement(p_user_id)` | jsonb | `{tier, productId, expiresAt, willRenew, inGrace, billingIssue, isTrial}`. The best live subscription (status 1 or 4, not revoked, effective expiry in the future) wins. The effective expiry is `greatest(grace_expires_at, expires_at)`: it equals the spec's coalesce during a grace period, and a stale grace date left from an earlier billing issue cannot cut a renewed subscription short |
| `transfer_subscription(p_original_transaction_id, p_to_user_id)` | jsonb | `{ok:true, transferred, fromUserId, count30d}` or `{ok:false, code: not_found \| transfer_rate_limited}`. Limited to 3 per 30 days, audited; recomputes both users and re-points `app_account_token`. The caller then calls Apple's Set App Account Token |
| `merge_anonymous_account(p_from_user_id, p_to_user_id)` | jsonb | `{merged, analyses, events, counters, subscriptions: [origTx…]}` or `{merged:false, code: not_found \| forbidden}` (`forbidden`: the source is not anonymous, or the target is). Moves rows, sums counters (capped at the period limit; bonus OR-ed), rewrites pose paths, re-links subscriptions. Idempotent. Storage moves, Set App Account Token and deleting the anonymous user stay in the Edge Function |
| `record_llm_cost(p_user_id, p_cost_usd)` | jsonb | Adds to `daily_spend` and `user_monthly_cost`. Returns `{dayUsd, monthUsd, …}` |
| `budget_status()` | jsonb | `{day, spentUsd, budgetUsd, ratio, alertRatio, hardCapMult}` |
| `purge_expired_rows()` | jsonb | For the daily cron: deletes events older than 13 months, `llm_outputs` older than 90 days, and processed notifications |
| `redact_result_free(result)` | jsonb | The free view of a full result |
| `dispatch_due_jobs(p_limit = 5)`, `call_cron_task(p_task)` | int, bigint | pg_cron entry points (see Cron) |

### Client RPCs: `supabase.rpc(name, args)`, authenticated (anonymous users included)

| RPC | Returns |
|---|---|
| `my_status()` | `{tier, periodType, periodKey, used:{total,standard,retries}, limits:{total,standard,retries,inFlight}, remaining, inFlight, nextKind, resets_at, bonusAvailable, features, copy:{free\|trial\|premium:{periodType,totalLimit,standardLimit}}, entitlement:{isTrial,productId,expiresAt,willRenew,inGrace,billingIssue}, consent:{pdpl:{current,accepted}, ai:{current,accepted}, upToDate}, isReviewer, isAnonymous}`. `resets_at` is null for the trial |
| `get_result(p_analysis_id)` | `coach-result.v1`, redacted by the **current** tier. Free keeps hero, overall, subScores, at most 1 strength, safety, notAssessable, recordingTips, rulesTip and summary; it drops `checkpoints`, empties `weaknesses` and `plan`, and sets `access:"free"` with `locked` counts. Raises `PT404 analysis_not_found` when the result is missing or belongs to someone else. For a free user, a result that `get_history` shows as a locked stub (older than the newest `history_full_limit` = 3 results) raises `PT403 forbidden`, so the stubs cannot be bypassed |
| `get_history(p_limit = 20, p_before = null)` | Array, newest first, without drafts: `{id, sport, skill, status, subject, cameraView, failureCode, createdAt, completedAt, hasResult, locked, displayScore, level, partial, heroTitle}`. Free users see the newest 3 results in full; older ones are `locked:true` with null score, level and title |
| `get_progress(p_sport, p_skill = null)` | Array, oldest first, of `subject='self'` succeeded results: `{analysisId, skill, createdAt, displayScore, level, partial, subScores:[{key, displayScore}]}`. Free → `PT403 forbidden`; an unknown sport → `PT422` |
| `log_event(p_name, p_props = {})` | `true` when stored, `false` past 300 client events per ICT day. Raises `PT422 invalid_payload` for a name not on the allowlist or props that are not an object of at most 2 KB |

## Storage (migration 0600)

| Bucket | Limits | Paths | Client policies (`authenticated`, own folder `(storage.foldername(name))[1] = auth.uid()`) |
|---|---|---|---|
| `analysis-inputs` | private, 2 MB, `image/jpeg` | `{uid}/{aid}/frames/F1..F5.jpg` | INSERT, SELECT, UPDATE, DELETE. INSERT and UPDATE also require the exact lowercase path pattern. Upsert works because SELECT and UPDATE exist |
| `analysis-derived` | private, 2 MB, `application/json` | `{uid}/{aid}/pose.raw.json`, `pose.clean.json` | SELECT, DELETE. Only the service role writes |

Objects have no foreign key to users. `delete-account` and `account-merge` walk `{uid}/` through the Storage API.

## Cron (migration 0900)

| Job | Schedule | Action |
|---|---|---|
| `racketcoach-dispatch-jobs` | every minute | `private.dispatch_due_jobs(5)`: one `POST {project_url}/functions/v1/analyze/run` per due job, body `{"analysisId"}`, header `x-internal-secret`, 5 s timeout |
| `racketcoach-daily` | `17 20 * * *` UTC (03:17 ICT) | `private.call_cron_task('daily')`: `POST /functions/v1/cron {"task":"daily"}` with `x-cron-secret` |

A job is due when it is `queued` with `next_attempt_at` at least 15 s in the past, or `processing` with a lock older
than 8 min. Secrets come from Vault: `project_url`, `internal_secret` and `cron_secret`. Without them both jobs
only `RAISE NOTICE`. To make the local dispatcher call your local functions:

```sql
select vault.create_secret('http://supabase_kong_racketcoach:8000', 'project_url');  -- Kong, as seen from the db container
select vault.create_secret('<same value as INTERNAL_SECRET in supabase/functions/.env.local>', 'internal_secret');
select vault.create_secret('<same value as CRON_SECRET>', 'cron_secret');
```

On the hosted project, `project_url` is `https://<ref>.supabase.co`.

## Seed and the demo reviewer

`seed.sql` runs on `supabase db reset`. For a hosted project, use `supabase db push --include-seed`. The inserts are
`ON CONFLICT DO NOTHING`, so values tuned in production are not overwritten; change those with an explicit
`UPDATE`.

Reviewer flag: `private.reviewer_emails` lists emails whose accounts get `profiles.is_reviewer`, which exempts them
from the daily budget guard. The flag is set only once the email is **confirmed** (`auth.users.email_confirmed_at`):
at OTP sign-up, or when an anonymous user links that email and verifies the code. GoTrue inserts the user row before
the OTP is checked, so an unconfirmed address never counts. This relies on email confirmations being on
(`[auth.email] enable_confirmations = true`). With confirmations off, GoTrue auto-confirms, so a password sign-up or
an anonymous `updateUser({email})` could claim any address without proving the mailbox. Locally the seed
adds `reviewer@racketcoach.test`: sign in with email OTP and read the code in Mailpit at http://127.0.0.1:54324. For
App Review, an operator inserts the review account's email on the hosted project. No users are seeded.

## Running the tests

```bash
bash supabase/tests/sql/run.sh
```

The script runs these steps in order:
1. Starts the local stack if needed. The default `-x` list skips studio, logflare, vector, imgproxy, realtime,
   postgres-meta and supavisor; override it with `SUPABASE_START_EXCLUDE`.
2. `supabase db reset`, which **wipes the local database**. Set `SKIP_RESET=1` to skip it.
3. `supabase test db supabase/tests/database` (pgTAP; 313 assertions).
4. `concurrency.sh`.
5. `fixtures.sh`.
6. `api_smoke.sh`.

The stack is left running. The script needs Docker; `psql` is optional (it falls back to `docker exec` into the db
container).

| Script | What it proves |
|---|---|
| `tests/database/010_schema_seed` | Tables, RLS on every table, SECURITY DEFINER and `search_path`, the client privilege matrix (DELETE only on `analyses`), default privileges for functions and tables added later, exact seed values |
| `020_rls_grants` | Two-user isolation, column grants (`prepared`, `result`, pose paths unreadable), no client writes, feedback ownership, anon |
| `030_profiles` | Profile auto-creation (anonymous too), age gate, consent timestamps, reviewer flag only for a confirmed email |
| `040_reserve` | ICT period keys and the month boundary, premium windows, free/trial/premium limits and kinds, first-ever bonus once, in-flight, idempotency, ownership |
| `050_jobs` | Claim/requeue/finalize/fail fencing, the 8-minute stale reclaim, retry cap (3), partial refunds, bonus returned on failure, ownership-safe prepare upsert |
| `060_results` | `get_result` redaction by current tier (free/premium/trial/expired), `PT403` for results the free history locks, history stubs and paging, progress gating |
| `070_entitlements` | `tier_of` with grace, `recompute_entitlement` cases (including a stale grace date after renewal), transfer limit and audit |
| `080_storage` | Bucket settings, policy matrix, own-folder only, path pattern, no client writes to `analysis-derived` |
| `090_events` | Allowlist, props limits, 300/day per user |
| `100_cascade_cron` | Cascades on auth-user delete, subscription `SET NULL`, cron no-op without Vault, pg_net request with secrets |
| `110_merge_consent` | Account merge and `consent_current` |
| `tests/sql/concurrency.sh` | Two concurrent psql sessions (in-flight, quota, bonus and same-analysis races) never double-book. Removing the advisory lock makes the in-flight race fail, which was checked by hand |
| `tests/sql/fixtures.sh` | `redact_result_free(example_full.json) == example_free.json` |
| `tests/sql/api_smoke.sh` | Real GoTrue anonymous sign-in → profile, RPCs, column grants, Storage upsert/move refusals over HTTP, and email ownership: a password sign-up gets no session, an anonymous email link stays pending until the OTP (read from Mailpit) is verified, and only then is `is_reviewer` set |

Running a single file: `npx -y supabase@2.119.0 test db supabase/tests/database/040_reserve.test.sql`. Do not put
non-test `.sql` files under `supabase/tests`, because `supabase test db` runs every `.sql` it finds there.

## Hosted project checklist

1. `supabase db push --include-seed`.
2. API settings → Exposed schemas: add `private`.
3. Auth: anonymous sign-ins, manual linking, OTP length 6, **Confirm email on**, and the templates
   (`supabase config push` or the dashboard).
4. Vault secrets `project_url`, `internal_secret` and `cron_secret`, matching the Edge Function secrets.
