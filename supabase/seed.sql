-- Seed data: config rows the backend needs (DESIGN.md §6.5, §8.1, §8.7, §9.3, D21) plus a local-only demo
-- reviewer mechanism. Runs after the migrations on `supabase db reset`; for a hosted project apply it once with
-- `supabase db push --include-seed`. Every insert is ON CONFLICT DO NOTHING so a re-run never overwrites values an
-- operator has tuned in production (change those with an explicit UPDATE).

-- ---------------------------------------------------------------------------------------------------------------
-- plan_limits (§9.3, D18)

insert into public.plan_limits
  (tier, period_type, total_limit, standard_limit, first_ever_standard, max_in_flight, free_retry_limit, features)
values
  ('free', 'calendar_month', 2, 0, true, 1, 3,
    '{"full_report": false, "progress": false, "player": false, "history_full_limit": 3}'),
  ('trial', 'trial', 10, 5, false, 1, 3,
    '{"full_report": true, "progress": true, "player": true, "history_full_limit": null}'),
  ('premium', 'subscription_month', 15, 15, false, 1, 3,
    '{"full_report": true, "progress": true, "player": true, "history_full_limit": null}')
on conflict (tier) do nothing;

-- ---------------------------------------------------------------------------------------------------------------
-- model_routes (§8.1). Effort is always explicit; standard starts at `low` pending the M6 sweep.

insert into public.model_routes (kind, model, effort, max_tokens, timeout_ms, fallbacks, betas)
values
  ('basic', 'claude-haiku-5-5', 'medium', 12000, 90000, null, '{}'),
  ('standard', 'claude-sonnet-5-5', 'low', 12000, 180000, 'default', '{server-side-fallback-2026-07-01}')
on conflict (kind) do nothing;

-- ---------------------------------------------------------------------------------------------------------------
-- app_config

insert into public.app_config (key, value, description)
values
  ('min_user_age', '18', 'D21: minimum user age (birth-year gate; attestation when borderline)'),
  ('consent_versions', '{"pdpl": "2026-10-01", "ai": "2026-10-01"}',
    'Current PDPL (processing + transfer) and AI-processing consent versions; submit requires both'),
  ('budget_usd', '30', '§8.7 daily LLM budget in USD (ICT day)'),
  ('budget_alert_ratio', '0.7', '§8.7 alert and downgrade free standard → basic at this share of the budget'),
  ('budget_hard_cap_mult', '2', '§8.7 paid/trial/reviewer users are served up to this multiple of the budget'),
  ('event_daily_limit', '300', 'log_event: client events per user per ICT day'),
  ('event_props_max_bytes', '2048', 'log_event: max props size (bytes of JSON text)'),
  ('event_allowlist', '[
    "app_open", "onboarding_started", "onboarding_completed", "language_changed",
    "consent_shown", "consent_accepted", "consent_withdrawn",
    "camera_guide_viewed", "analysis_started", "capture_recorded", "capture_imported", "trim_completed",
    "quality_rejected", "prepare_completed", "prepare_rejected", "strokes_confirmed", "frames_uploaded",
    "analysis_submitted", "analysis_failed", "result_viewed", "evidence_opened", "locked_section_tapped",
    "feedback_given", "reminder_set", "history_opened", "progress_opened", "player_opened", "demo_opened",
    "paywall_viewed", "purchase_started", "purchase_completed", "purchase_failed", "restore_tapped",
    "account_link_started", "account_linked", "settings_opened", "local_videos_deleted"
  ]', 'log_event: allowed client event names')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------------------------------------------
-- enabled_skills (§2.1): 6 launch skills on, 6 deferred skills off until calibrated (≥ 20 labelled clips each).

insert into public.enabled_skills (skill, sport, enabled, note)
values
  ('bd.clear_fh', 'badminton', true, 'launch'),
  ('bd.smash', 'badminton', true, 'launch'),
  ('bd.serve_low', 'badminton', true, 'launch'),
  ('pb.serve', 'pickleball', true, 'launch'),
  ('pb.dink', 'pickleball', true, 'launch'),
  ('pb.drop3', 'pickleball', true, 'launch'),
  ('bd.net_shot', 'badminton', false, 'deferred: enable after calibration'),
  ('bd.lift', 'badminton', false, 'deferred: enable after calibration'),
  ('bd.serve_high', 'badminton', false, 'deferred: enable after calibration'),
  ('pb.return', 'pickleball', false, 'deferred: enable after calibration'),
  ('pb.drive', 'pickleball', false, 'deferred: enable after calibration'),
  ('pb.volley', 'pickleball', false, 'deferred: enable after calibration')
on conflict (skill) do nothing;

-- ---------------------------------------------------------------------------------------------------------------
-- Local demo reviewer (no real users are created). Signing in locally with this address (email OTP, read the code
-- in Mailpit at http://127.0.0.1:54324), or linking it to an anonymous account, sets profiles.is_reviewer through
-- the auth.users triggers in migration 0100. `.test` is a reserved TLD, so the address can never receive mail on a
-- hosted project even if this file is applied there.

insert into private.reviewer_emails (email, note)
values ('reviewer@racketcoach.test', 'local demo reviewer (seed.sql)')
on conflict (email) do nothing;
