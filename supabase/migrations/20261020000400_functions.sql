-- 0400 functions (DESIGN.md §6.5, §8.3, §8.7, §9.3–9.4).
--
-- private.* functions are service-role only (Edge Functions call them via supabase-js `.schema('private').rpc()`).
-- public.* RPCs are for authenticated clients, use auth.uid() and raise PostgREST status codes via SQLSTATE 'PTnnn'
-- with the contracts ApiErrorCode as the message (e.g. PT404 'analysis_not_found').
--
-- Lock order everywhere: per-user advisory xact lock first, then row locks. This keeps reserve_for_submit and the
-- finalize/refund path from deadlocking when an idempotent re-submit races a worker.

-- ---------------------------------------------------------------------------------------------------------------
-- Time helpers (ICT = Asia/Ho_Chi_Minh, fixed +07:00, no DST)

-- ISO 8601 with the ICT offset, e.g. 2026-11-01T00:00:00+07:00 (QuotaPreview.resetsAt format).
create or replace function private.ict_iso(p_at timestamptz)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case when p_at is null then null
    else to_char(p_at at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD"T"HH24:MI:SS') || '+07:00' end;
$$;

-- Quota window for a tier at an instant (pure: no table access).
--   free    → 'YYYY-MM' of the ICT calendar month; resets at the next ICT month start.
--   trial   → 'trial:<origTx>' for the whole trial; no reset (null).
--   premium → 'sub:<origTx>:<windowStart ICT date>' for monthly windows anchored on p_anchor (§9.3).
-- Month arithmetic is anchor + n months (never iterated), so a 31st anchor gives Feb 28/29 then Mar 31.
create or replace function private.period_window(
  p_tier text,
  p_at timestamptz,
  p_original_transaction_id text default null,
  p_anchor timestamptz default null
)
returns table (period_key text, period_start timestamptz, resets_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz constant text := 'Asia/Ho_Chi_Minh';
  v_local timestamp := p_at at time zone v_tz;
  v_anchor timestamp;
  v_start timestamp;
  v_months int;
begin
  if p_tier = 'trial' then
    return query select 'trial:' || coalesce(p_original_transaction_id, 'none'), null::timestamptz, null::timestamptz;
  elsif p_tier = 'premium' then
    v_anchor := coalesce(p_anchor, p_at) at time zone v_tz;
    v_months := (extract(year from v_local)::int - extract(year from v_anchor)::int) * 12
      + (extract(month from v_local)::int - extract(month from v_anchor)::int);
    if v_anchor + make_interval(months => v_months) > v_local then
      v_months := v_months - 1;
    end if;
    v_months := greatest(v_months, 0); -- anchor in the future (clock skew): first window
    v_start := v_anchor + make_interval(months => v_months);
    return query select
      'sub:' || coalesce(p_original_transaction_id, 'none') || ':' || to_char(v_start, 'YYYY-MM-DD'),
      v_start at time zone v_tz,
      (v_anchor + make_interval(months => v_months + 1)) at time zone v_tz;
  else
    v_start := date_trunc('month', v_local);
    return query select to_char(v_start, 'YYYY-MM'), v_start at time zone v_tz,
      (v_start + interval '1 month') at time zone v_tz;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Tier and quota context

-- Premium or trial while entitlements.expires_at (already coalesced with the grace period) is in the future.
create or replace function private.tier_of(p_user_id uuid, p_at timestamptz default now())
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select case when e.tier in ('trial', 'premium') and e.expires_at > p_at then e.tier else 'free' end
    from public.entitlements e
    where e.user_id = p_user_id
  ), 'free');
$$;

create or replace function private.quota_context(p_user_id uuid, p_at timestamptz default now())
returns table (tier text, period_key text, period_start timestamptz, resets_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tier text := private.tier_of(p_user_id, p_at);
  v_tx text;
  v_anchor timestamptz;
begin
  select e.original_transaction_id, e.period_anchor into v_tx, v_anchor
  from public.entitlements e where e.user_id = p_user_id;
  return query select v_tier, w.period_key, w.period_start, w.resets_at
  from private.period_window(v_tier, p_at, v_tx, v_anchor) w;
end;
$$;

-- Read-only quota snapshot: my_status() and the prepare response's QuotaPreview (tier, remaining, nextKind,
-- resets_at). Keys named in DESIGN.md §6.5 (`resets_at`, `bonusAvailable`) are kept verbatim.
create or replace function private.quota_status(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ctx record;
  v_plan public.plan_limits;
  v_used int := 0;
  v_used_std int := 0;
  v_retries int := 0;
  v_life_used int := 0;
  v_life_bonus boolean := false;
  v_in_flight int;
  v_bonus boolean;
  v_next text;
  v_copy jsonb;
begin
  select * into v_ctx from private.quota_context(p_user_id);
  select * into v_plan from public.plan_limits where tier = v_ctx.tier;
  if not found then
    raise exception 'plan_limits has no row for tier %', v_ctx.tier;
  end if;
  select c.used, c.used_standard, c.retries_used into v_used, v_used_std, v_retries
  from public.usage_counters c where c.user_id = p_user_id and c.period_key = v_ctx.period_key;
  select c.used, c.bonus_used into v_life_used, v_life_bonus
  from public.usage_counters c where c.user_id = p_user_id and c.period_key = 'lifetime';
  v_used := coalesce(v_used, 0);
  v_used_std := coalesce(v_used_std, 0);
  v_retries := coalesce(v_retries, 0);
  select count(*) into v_in_flight from public.analyses a
  where a.user_id = p_user_id and a.status in ('queued', 'processing');

  v_bonus := v_ctx.tier = 'free' and v_plan.first_ever_standard
    and not coalesce(v_life_bonus, false) and coalesce(v_life_used, 0) = 0;
  if v_ctx.tier = 'free' then
    v_next := case when v_bonus then 'standard' else 'basic' end;
  else
    v_next := case when v_used_std < v_plan.standard_limit then 'standard' else 'basic' end;
  end if;

  select jsonb_object_agg(p.tier, jsonb_build_object(
    'periodType', p.period_type, 'totalLimit', p.total_limit, 'standardLimit', p.standard_limit))
  into v_copy from public.plan_limits p;

  return jsonb_build_object(
    'tier', v_ctx.tier,
    'periodType', v_plan.period_type,
    'periodKey', v_ctx.period_key,
    'used', jsonb_build_object('total', v_used, 'standard', v_used_std, 'retries', v_retries),
    'limits', jsonb_build_object(
      'total', v_plan.total_limit, 'standard', v_plan.standard_limit,
      'retries', v_plan.free_retry_limit, 'inFlight', v_plan.max_in_flight),
    'remaining', greatest(v_plan.total_limit - v_used, 0),
    'inFlight', v_in_flight,
    'nextKind', v_next,
    'resets_at', private.ict_iso(v_ctx.resets_at),
    'bonusAvailable', v_bonus,
    'features', v_plan.features,
    'copy', coalesce(v_copy, '{}'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- prepare: ownership-safe upsert (§6.1). Returns false when the id belongs to another user or is past
-- prepared/rejected → the edge function answers 409 analysis_conflict. p_fields uses analyses column names
-- (jsonb_populate_record); absent keys keep their current value on update (reprepare sends only what changed).

create or replace function private.upsert_prepared_analysis(p_user_id uuid, p_analysis_id uuid, p_fields jsonb)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  f public.analyses;
  v_status text := coalesce(p_fields ->> 'status', 'prepared');
begin
  if v_status not in ('prepared', 'rejected') then
    raise exception 'upsert_prepared_analysis: status must be prepared or rejected, got %', v_status
      using errcode = 'invalid_parameter_value';
  end if;
  f := jsonb_populate_record(null::public.analyses, p_fields);

  -- Two passes: update the caller's own draft, else insert; an insert that loses a race retries the update once.
  -- (A single INSERT … ON CONFLICT cannot be used for partial reprepare bodies: NOT NULL is checked on the proposed
  -- insert row before the conflict is detected.)
  for i in 1..2 loop
    update public.analyses a set
      sport = coalesce(f.sport, a.sport),
      skill = coalesce(f.skill, a.skill),
      camera_view = coalesce(f.camera_view, a.camera_view),
      view_confirmed = coalesce(f.view_confirmed, a.view_confirmed),
      subject = coalesce(f.subject, a.subject),
      subject_consent = coalesce(f.subject_consent, a.subject_consent),
      subject_minor = coalesce(f.subject_minor, a.subject_minor),
      frame_mode = coalesce(f.frame_mode, a.frame_mode),
      language = coalesce(f.language, a.language),
      handedness = coalesce(f.handedness, a.handedness),
      excluded_strokes = coalesce(f.excluded_strokes, a.excluded_strokes),
      status = v_status,
      failure_code = case when v_status = 'rejected' then coalesce(f.failure_code, a.failure_code) end,
      algo_version = coalesce(f.algo_version, a.algo_version),
      rubric_version = coalesce(f.rubric_version, a.rubric_version),
      analysis_hz = coalesce(f.analysis_hz, a.analysis_hz),
      video_meta = coalesce(f.video_meta, a.video_meta),
      quality = coalesce(f.quality, a.quality),
      prepared = coalesce(f.prepared, a.prepared),
      pose_raw_path = coalesce(f.pose_raw_path, a.pose_raw_path),
      pose_clean_path = coalesce(f.pose_clean_path, a.pose_clean_path),
      frame_count = coalesce(f.frame_count, a.frame_count)
    where a.id = p_analysis_id and a.user_id = p_user_id and a.status in ('prepared', 'rejected');
    if found then
      return true;
    end if;
    if exists (select 1 from public.analyses where id = p_analysis_id) then
      return false; -- another user's id, or already submitted → 409 analysis_conflict
    end if;

    insert into public.analyses (
      id, user_id, sport, skill, camera_view, view_confirmed, subject, subject_consent, subject_minor, frame_mode,
      language, handedness, excluded_strokes, status, failure_code, algo_version, rubric_version, analysis_hz,
      video_meta, quality, prepared, pose_raw_path, pose_clean_path, frame_count
    ) values (
      p_analysis_id, p_user_id, f.sport, f.skill, f.camera_view, f.view_confirmed, coalesce(f.subject, 'self'),
      coalesce(f.subject_consent, false), coalesce(f.subject_minor, false), coalesce(f.frame_mode, 'frames'),
      coalesce(f.language, 'vi'), f.handedness, coalesce(f.excluded_strokes, '{}'), v_status,
      case when v_status = 'rejected' then f.failure_code end, f.algo_version, f.rubric_version, f.analysis_hz,
      f.video_meta, f.quality, f.prepared, f.pose_raw_path, f.pose_clean_path, coalesce(f.frame_count, 0)
    )
    on conflict (id) do nothing;
    if found then
      return true;
    end if;
  end loop;
  return false;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Submit: reserve quota (§6.5). One transaction under a per-user advisory lock:
--   ownership/status → in-flight → counters (period + lifetime) → limit → kind → ledger + counters + queued.
-- Returns {ok:true, kind, remaining, resets_at, tier, status, period_key, bonus, idempotent}
--      or {ok:false, code: analysis_not_found | analysis_conflict | in_flight | quota_exceeded, ...}.

create or replace function private.reserve_for_submit(
  p_user_id uuid,
  p_analysis_id uuid,
  p_device_bonus_ok boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_a record;
  v_ctx record;
  v_plan public.plan_limits;
  v_c public.usage_counters;
  v_life public.usage_counters;
  v_in_flight int;
  v_kind text;
  v_bonus boolean := false;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  select a.id, a.user_id, a.status, a.kind into v_a
  from public.analyses a where a.id = p_analysis_id for update;
  if not found or v_a.user_id <> p_user_id then
    return jsonb_build_object('ok', false, 'code', 'analysis_not_found');
  end if;

  select * into v_ctx from private.quota_context(p_user_id);
  select * into v_plan from public.plan_limits where tier = v_ctx.tier;
  if not found then
    raise exception 'plan_limits has no row for tier %', v_ctx.tier;
  end if;

  if v_a.status in ('queued', 'processing', 'succeeded') then
    select * into v_c from public.usage_counters
    where user_id = p_user_id and period_key = v_ctx.period_key;
    return jsonb_build_object(
      'ok', true, 'idempotent', true, 'status', v_a.status, 'kind', v_a.kind, 'tier', v_ctx.tier,
      'remaining', greatest(v_plan.total_limit - coalesce(v_c.used, 0), 0),
      'resets_at', private.ict_iso(v_ctx.resets_at), 'period_key', v_ctx.period_key);
  end if;
  if v_a.status <> 'prepared' then
    return jsonb_build_object('ok', false, 'code', 'analysis_conflict', 'status', v_a.status);
  end if;

  select count(*) into v_in_flight from public.analyses
  where user_id = p_user_id and status in ('queued', 'processing');
  if v_in_flight >= v_plan.max_in_flight then
    return jsonb_build_object('ok', false, 'code', 'in_flight', 'tier', v_ctx.tier,
      'limit', v_plan.max_in_flight, 'used', v_in_flight);
  end if;

  insert into public.usage_counters (user_id, period_key)
  values (p_user_id, v_ctx.period_key), (p_user_id, 'lifetime')
  on conflict do nothing;
  select * into v_c from public.usage_counters
  where user_id = p_user_id and period_key = v_ctx.period_key for update;
  select * into v_life from public.usage_counters
  where user_id = p_user_id and period_key = 'lifetime' for update;

  if v_c.used >= v_plan.total_limit then
    return jsonb_build_object('ok', false, 'code', 'quota_exceeded', 'tier', v_ctx.tier,
      'limit', v_plan.total_limit, 'used', v_c.used, 'resets_at', private.ict_iso(v_ctx.resets_at));
  end if;

  if v_ctx.tier = 'free' then
    v_bonus := v_plan.first_ever_standard and coalesce(p_device_bonus_ok, false)
      and not v_life.bonus_used and v_life.used = 0;
    v_kind := case when v_bonus then 'standard' else 'basic' end;
  else
    v_kind := case when v_c.used_standard < v_plan.standard_limit then 'standard' else 'basic' end;
  end if;

  insert into public.quota_ledger (analysis_id, user_id, period_key, kind, is_bonus)
  values (p_analysis_id, p_user_id, v_ctx.period_key, v_kind, v_bonus);

  update public.usage_counters
  set used = used + 1, used_standard = used_standard + (v_kind = 'standard')::int
  where user_id = p_user_id and period_key = v_ctx.period_key;
  update public.usage_counters
  set used = used + 1, used_standard = used_standard + (v_kind = 'standard')::int, bonus_used = bonus_used or v_bonus
  where user_id = p_user_id and period_key = 'lifetime';

  update public.analyses
  set status = 'queued', kind = v_kind, queued_at = now(), next_attempt_at = now(), failure_code = null,
    last_error_code = null
  where id = p_analysis_id;

  return jsonb_build_object(
    'ok', true, 'idempotent', false, 'status', 'queued', 'kind', v_kind, 'tier', v_ctx.tier, 'bonus', v_bonus,
    'remaining', greatest(v_plan.total_limit - v_c.used - 1, 0),
    'resets_at', private.ict_iso(v_ctx.resets_at), 'period_key', v_ctx.period_key);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Quota commit / refund (§6.5, §8.3)

create or replace function private.commit_quota(p_analysis_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ok boolean;
begin
  update public.quota_ledger set state = 'committed', committed_at = now()
  where analysis_id = p_analysis_id and state = 'reserved'
  returning true into v_ok;
  return coalesce(v_ok, false);
end;
$$;

-- Infrastructure reasons (model_refusal, bad_output, upstream_unavailable, bad_request, expired, internal, …) always
-- refund. 'rejected' and 'partial' refund only while retries_used < free_retry_limit for that period, and consume
-- one retry; past the cap the reservation is committed instead. A refund of the first-ever bonus gives it back.
-- Idempotent: only a 'reserved' ledger row changes.
create or replace function private.refund_quota(p_analysis_id uuid, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_l public.quota_ledger;
  v_c public.usage_counters;
  v_cap int;
  v_capped_reason boolean := p_reason in ('rejected', 'partial');
begin
  select user_id into v_user from public.quota_ledger where analysis_id = p_analysis_id;
  if not found then
    return jsonb_build_object('refunded', false, 'code', 'not_found');
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_user::text, 0));

  select * into v_l from public.quota_ledger where analysis_id = p_analysis_id for update;
  if v_l.state <> 'reserved' then
    return jsonb_build_object('refunded', false, 'code', 'already_' || v_l.state);
  end if;

  select * into v_c from public.usage_counters
  where user_id = v_l.user_id and period_key = v_l.period_key for update;

  if v_capped_reason then
    select p.free_retry_limit into v_cap from public.plan_limits p where p.tier = private.tier_of(v_l.user_id);
    if coalesce(v_c.retries_used, 0) >= coalesce(v_cap, 0) then
      update public.quota_ledger
      set state = 'committed', committed_at = now(), refund_reason = p_reason || ':retry_cap'
      where analysis_id = p_analysis_id;
      return jsonb_build_object('refunded', false, 'code', 'retry_cap', 'reason', p_reason);
    end if;
  end if;

  update public.usage_counters
  set used = greatest(used - 1, 0),
    used_standard = greatest(used_standard - (v_l.kind = 'standard')::int, 0),
    retries_used = retries_used + v_capped_reason::int
  where user_id = v_l.user_id and period_key = v_l.period_key;
  update public.usage_counters
  set used = greatest(used - 1, 0),
    used_standard = greatest(used_standard - (v_l.kind = 'standard')::int, 0),
    bonus_used = bonus_used and not v_l.is_bonus
  where user_id = v_l.user_id and period_key = 'lifetime';
  update public.quota_ledger
  set state = 'refunded', refund_reason = p_reason, refunded_at = now()
  where analysis_id = p_analysis_id;
  return jsonb_build_object('refunded', true, 'reason', p_reason);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Job lifecycle with attempt fencing (D12, §8.3)

-- Returns the new attempt number, or null when another worker owns the job (or it is not due).
create or replace function private.claim_analysis(p_analysis_id uuid)
returns int
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_attempt int;
begin
  update public.analyses
  set status = 'processing', locked_at = now(), attempt_count = attempt_count + 1
  where id = p_analysis_id
    and ((status = 'queued' and coalesce(next_attempt_at, now()) <= now())
      or (status = 'processing' and locked_at < now() - interval '8 minutes'))
  returning attempt_count into v_attempt;
  return v_attempt;
end;
$$;

-- p_result is the full coach-result.v1 (status succeeded|rejected). Fenced on (attempt, processing): returns false
-- when the fence is lost (discard the output). Inserts analysis_results once, then commits or refunds the quota:
-- rejected → refund 'rejected', partial → refund 'partial' (both under the retry cap), otherwise commit.
create or replace function private.finalize_analysis(
  p_analysis_id uuid,
  p_attempt int,
  p_result jsonb,
  p_overall_score real default null,
  p_model text default null
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_status text := p_result ->> 'status';
  v_partial boolean := coalesce((p_result #>> '{overall,partial}')::boolean, false);
  v_a record;
begin
  if v_status is null or v_status not in ('succeeded', 'rejected') then
    raise exception 'finalize_analysis: result.status must be succeeded or rejected' using errcode = 'invalid_parameter_value';
  end if;
  select user_id into v_user from public.analyses where id = p_analysis_id;
  if not found then
    return false;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_user::text, 0));

  update public.analyses
  set status = v_status, completed_at = now(), locked_at = null, next_attempt_at = null,
    failure_code = case when v_status = 'rejected' then p_result #>> '{rejection,code}' end,
    model = coalesce(p_model, p_result #>> '{meta,model}', model)
  where id = p_analysis_id and attempt_count = p_attempt and status = 'processing'
  returning user_id, sport, skill, subject into v_a;
  if not found then
    return false;
  end if;

  insert into public.analysis_results (
    analysis_id, user_id, sport, skill, subject, status, overall_score, display_score, level, coverage, partial,
    sub_scores, result
  ) values (
    p_analysis_id, v_a.user_id, v_a.sport, v_a.skill, v_a.subject, v_status, p_overall_score,
    (p_result #>> '{overall,displayScore}')::smallint, p_result #>> '{overall,level}',
    (p_result #>> '{overall,coverage}')::real, v_partial, coalesce(p_result -> 'subScores', '[]'::jsonb),
    -- stored results are always the full document
    p_result || jsonb_build_object('access', 'full', 'locked',
      jsonb_build_object('strengths', 0, 'weaknesses', 0, 'plan', 0))
  )
  on conflict (analysis_id) do nothing;

  if v_status = 'rejected' then
    perform private.refund_quota(p_analysis_id, 'rejected');
  elsif v_partial then
    perform private.refund_quota(p_analysis_id, 'partial');
  else
    perform private.commit_quota(p_analysis_id);
  end if;
  return true;
end;
$$;

-- Back to queued after a transient failure (429/529/5xx/timeout, max_tokens, parse error). Fenced.
create or replace function private.requeue_analysis(
  p_analysis_id uuid,
  p_attempt int,
  p_delay_s int,
  p_code text,
  p_max_tokens_mult real default null
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ok boolean;
begin
  update public.analyses
  set status = 'queued', locked_at = null,
    next_attempt_at = now() + make_interval(secs => greatest(coalesce(p_delay_s, 0), 0)),
    last_error_code = p_code, max_tokens_mult = coalesce(p_max_tokens_mult, max_tokens_mult)
  where id = p_analysis_id and attempt_count = p_attempt and status = 'processing'
  returning true into v_ok;
  return coalesce(v_ok, false);
end;
$$;

-- Terminal failure (FAILURE_CODES). Fenced; refunds the quota in full (infrastructure reason, no retry used).
create or replace function private.fail_analysis(p_analysis_id uuid, p_attempt int, p_code text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_ok boolean;
begin
  select user_id into v_user from public.analyses where id = p_analysis_id;
  if not found then
    return false;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_user::text, 0));
  update public.analyses
  set status = 'failed', failure_code = p_code, completed_at = now(), locked_at = null, next_attempt_at = null
  where id = p_analysis_id and attempt_count = p_attempt and status = 'processing'
  returning true into v_ok;
  if not coalesce(v_ok, false) then
    return false;
  end if;
  perform private.refund_quota(p_analysis_id, p_code);
  return true;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Entitlements (§9.4)

-- Premium/trial from the best live subscription (status 1 active or 4 grace, not revoked, coalesced expiry in the
-- future); otherwise free. expires_at stores coalesce(grace_expires_at, expires_at).
create or replace function private.recompute_entitlement(p_user_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_s public.app_store_subscriptions;
  v_latest public.app_store_subscriptions;
  v_e public.entitlements;
begin
  if p_user_id is null or not exists (select 1 from public.profiles where id = p_user_id) then
    return null;
  end if;

  select * into v_s from public.app_store_subscriptions s
  where s.user_id = p_user_id and s.revoked_at is null and s.status in (1, 4)
    and coalesce(s.grace_expires_at, s.expires_at) > now()
  order by coalesce(s.grace_expires_at, s.expires_at) desc
  limit 1;

  if found then
    insert into public.entitlements as e (
      user_id, tier, is_trial, product_id, original_transaction_id, expires_at, period_anchor, will_renew,
      billing_issue, in_grace, source
    ) values (
      p_user_id, case when v_s.is_trial then 'trial' else 'premium' end, v_s.is_trial, v_s.product_id,
      v_s.original_transaction_id, coalesce(v_s.grace_expires_at, v_s.expires_at),
      coalesce(v_s.period_anchor, v_s.original_purchase_at, v_s.created_at), v_s.auto_renew,
      v_s.status in (3, 4), v_s.status = 4 or (v_s.grace_expires_at is not null and v_s.expires_at <= now()),
      case when v_s.environment = 'Xcode' then 'xcode' else 'app_store' end
    )
    on conflict (user_id) do update set
      tier = excluded.tier, is_trial = excluded.is_trial, product_id = excluded.product_id,
      original_transaction_id = excluded.original_transaction_id, expires_at = excluded.expires_at,
      period_anchor = excluded.period_anchor, will_renew = excluded.will_renew,
      billing_issue = excluded.billing_issue, in_grace = excluded.in_grace, source = excluded.source
    returning * into v_e;
  else
    -- keep the billing-retry signal so the app can say "update your payment method"
    select * into v_latest from public.app_store_subscriptions s
    where s.user_id = p_user_id
    order by coalesce(s.grace_expires_at, s.expires_at) desc nulls last
    limit 1;
    insert into public.entitlements as e (
      user_id, tier, is_trial, product_id, original_transaction_id, expires_at, period_anchor, will_renew,
      billing_issue, in_grace, source
    ) values (
      p_user_id, 'free', false, null, null, null, null, coalesce(v_latest.auto_renew, false),
      coalesce(v_latest.status = 3, false), false, 'none'
    )
    on conflict (user_id) do update set
      tier = excluded.tier, is_trial = excluded.is_trial, product_id = excluded.product_id,
      original_transaction_id = excluded.original_transaction_id, expires_at = excluded.expires_at,
      period_anchor = excluded.period_anchor, will_renew = excluded.will_renew,
      billing_issue = excluded.billing_issue, in_grace = excluded.in_grace, source = excluded.source
    returning * into v_e;
  end if;

  return jsonb_build_object(
    'tier', private.tier_of(p_user_id), 'productId', v_e.product_id, 'expiresAt', v_e.expires_at,
    'willRenew', v_e.will_renew, 'inGrace', v_e.in_grace, 'billingIssue', v_e.billing_issue,
    'isTrial', v_e.is_trial);
end;
$$;

-- "Last restore wins" (§9.4): move a subscription to p_to_user_id, at most 3 times per 30 days per
-- originalTransactionId, audited; both users are recomputed. The caller also re-points Apple's appAccountToken.
create or replace function private.transfer_subscription(p_original_transaction_id text, p_to_user_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_s public.app_store_subscriptions;
  v_count int;
begin
  select * into v_s from public.app_store_subscriptions
  where original_transaction_id = p_original_transaction_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_s.user_id = p_to_user_id then
    return jsonb_build_object('ok', true, 'transferred', false);
  end if;

  select count(*) into v_count from private.link_transfers t
  where t.original_transaction_id = p_original_transaction_id and t.created_at > now() - interval '30 days';
  if v_count >= 3 then
    return jsonb_build_object('ok', false, 'code', 'transfer_rate_limited', 'count30d', v_count);
  end if;

  insert into private.link_transfers (original_transaction_id, from_user_id, to_user_id)
  values (p_original_transaction_id, v_s.user_id, p_to_user_id);
  update public.app_store_subscriptions
  set user_id = p_to_user_id, app_account_token = p_to_user_id, transfer_count_30d = v_count + 1
  where original_transaction_id = p_original_transaction_id;
  insert into private.audit_log (action, subject, details)
  values ('subscription_transfer', p_original_transaction_id,
    jsonb_build_object('from', v_s.user_id, 'to', p_to_user_id, 'count30d', v_count + 1));

  if v_s.user_id is not null then
    perform private.recompute_entitlement(v_s.user_id);
  end if;
  perform private.recompute_entitlement(p_to_user_id);
  return jsonb_build_object('ok', true, 'transferred', true, 'fromUserId', v_s.user_id, 'count30d', v_count + 1);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Spend (§8.3, §8.7): every Claude attempt adds its cost to the ICT day and the user's ICT month.

create or replace function private.record_llm_cost(p_user_id uuid, p_cost_usd numeric)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_day date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_month text := to_char(now() at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM');
  v_day_total numeric;
  v_month_total numeric;
begin
  insert into private.daily_spend as d (day, cost_usd, calls) values (v_day, p_cost_usd, 1)
  on conflict (day) do update set cost_usd = d.cost_usd + excluded.cost_usd, calls = d.calls + 1, updated_at = now()
  returning cost_usd into v_day_total;
  if p_user_id is not null and exists (select 1 from public.profiles where id = p_user_id) then
    insert into private.user_monthly_cost as u (user_id, month, cost_usd, calls)
    values (p_user_id, v_month, p_cost_usd, 1)
    on conflict (user_id, month) do update
      set cost_usd = u.cost_usd + excluded.cost_usd, calls = u.calls + 1, updated_at = now()
    returning cost_usd into v_month_total;
  end if;
  return jsonb_build_object('day', v_day, 'dayUsd', v_day_total, 'month', v_month, 'monthUsd', v_month_total);
end;
$$;

-- Budget guard input (§8.7): today's ICT spend vs app_config.budget_usd.
create or replace function private.budget_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_day date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_spent numeric;
  v_budget numeric;
  v_alert numeric;
  v_hard numeric;
begin
  select coalesce(sum(cost_usd), 0) into v_spent from private.daily_spend where day = v_day;
  select (value #>> '{}')::numeric into v_budget from public.app_config where key = 'budget_usd';
  select (value #>> '{}')::numeric into v_alert from public.app_config where key = 'budget_alert_ratio';
  select (value #>> '{}')::numeric into v_hard from public.app_config where key = 'budget_hard_cap_mult';
  v_budget := coalesce(v_budget, 30);
  return jsonb_build_object(
    'day', v_day, 'spentUsd', v_spent, 'budgetUsd', v_budget,
    'ratio', case when v_budget > 0 then round(v_spent / v_budget, 4) end,
    'alertRatio', coalesce(v_alert, 0.7), 'hardCapMult', coalesce(v_hard, 2));
end;
$$;

-- Submit precondition (§6.1 step 2): both consents accepted at the current versions. (plpgsql: app_config is
-- created in 0700.)
create or replace function private.consent_current(p_user_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return coalesce((
    select p.pdpl_consent_version = c.value ->> 'pdpl' and p.ai_consent_version = c.value ->> 'ai'
    from public.profiles p, public.app_config c
    where p.id = p_user_id and c.key = 'consent_versions'
  ), false);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Account merge (§6.1 account-merge): the database half, in one transaction. Moves the anonymous account's rows to
-- the permanent account, sums usage counters per period (capped at that period's limit; bonus flag = OR), rewrites
-- pose paths to the new folder and re-links App Store subscriptions. Idempotent (a re-run moves nothing).
-- The Edge Function then moves Storage objects, calls Set App Account Token for `subscriptions`, and deletes the
-- anonymous auth user.

create or replace function private.merge_anonymous_account(p_from_user_id uuid, p_to_user_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_is_anon boolean;
  v_analyses int;
  v_events int;
  v_counters int;
  v_subs text[];
begin
  if p_from_user_id = p_to_user_id then
    raise exception 'merge_anonymous_account: source and target are the same user' using errcode = 'invalid_parameter_value';
  end if;
  select u.is_anonymous into v_is_anon from auth.users u where u.id = p_from_user_id;
  if not found then
    return jsonb_build_object('merged', false, 'code', 'not_found');
  end if;
  if not v_is_anon then
    return jsonb_build_object('merged', false, 'code', 'forbidden');
  end if;
  if not exists (select 1 from public.profiles where id = p_to_user_id) then
    return jsonb_build_object('merged', false, 'code', 'not_found');
  end if;

  -- both users' quota state changes: lock in uuid order so concurrent merges cannot deadlock
  perform pg_advisory_xact_lock(hashtextextended(least(p_from_user_id, p_to_user_id)::text, 0));
  perform pg_advisory_xact_lock(hashtextextended(greatest(p_from_user_id, p_to_user_id)::text, 0));

  update public.analyses set
    user_id = p_to_user_id,
    pose_raw_path = regexp_replace(pose_raw_path, '^' || p_from_user_id::text || '/', p_to_user_id::text || '/'),
    pose_clean_path = regexp_replace(pose_clean_path, '^' || p_from_user_id::text || '/', p_to_user_id::text || '/')
  where user_id = p_from_user_id;
  get diagnostics v_analyses = row_count;
  update public.analysis_results set user_id = p_to_user_id where user_id = p_from_user_id;
  update public.feedback set user_id = p_to_user_id where user_id = p_from_user_id;
  update public.quota_ledger set user_id = p_to_user_id where user_id = p_from_user_id;
  update public.events set user_id = p_to_user_id where user_id = p_from_user_id;
  get diagnostics v_events = row_count;

  insert into public.usage_counters as c (user_id, period_key, used, used_standard, retries_used, bonus_used)
  select p_to_user_id, f.period_key, f.used, f.used_standard, f.retries_used, f.bonus_used
  from public.usage_counters f where f.user_id = p_from_user_id
  on conflict (user_id, period_key) do update set
    used = least(c.used + excluded.used, coalesce((
      select p.total_limit from public.plan_limits p
      where p.tier = case
        when excluded.period_key = 'lifetime' then null
        when excluded.period_key like 'trial:%' then 'trial'
        when excluded.period_key like 'sub:%' then 'premium'
        else 'free' end), c.used + excluded.used)),
    used_standard = c.used_standard + excluded.used_standard,
    retries_used = c.retries_used + excluded.retries_used,
    bonus_used = c.bonus_used or excluded.bonus_used;
  get diagnostics v_counters = row_count;
  delete from public.usage_counters where user_id = p_from_user_id;

  insert into private.user_monthly_cost as m (user_id, month, cost_usd, calls)
  select p_to_user_id, f.month, f.cost_usd, f.calls from private.user_monthly_cost f where f.user_id = p_from_user_id
  on conflict (user_id, month) do update set cost_usd = m.cost_usd + excluded.cost_usd, calls = m.calls + excluded.calls;
  delete from private.user_monthly_cost where user_id = p_from_user_id;

  with moved as (
    update public.app_store_subscriptions set user_id = p_to_user_id, app_account_token = p_to_user_id
    where user_id = p_from_user_id
    returning original_transaction_id
  )
  select coalesce(array_agg(original_transaction_id order by original_transaction_id), '{}') into v_subs from moved;
  if cardinality(v_subs) > 0 then
    perform private.recompute_entitlement(p_from_user_id);
  end if;
  perform private.recompute_entitlement(p_to_user_id);

  insert into private.audit_log (action, subject, details)
  values ('account_merge', p_to_user_id::text, jsonb_build_object('from', p_from_user_id, 'analyses', v_analyses,
    'events', v_events, 'counters', v_counters, 'subscriptions', to_jsonb(v_subs)));

  return jsonb_build_object('merged', true, 'analyses', v_analyses, 'events', v_events, 'counters', v_counters,
    'subscriptions', to_jsonb(v_subs));
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Client RPCs (authenticated, anonymous users included)

create or replace function public.my_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_e public.entitlements;
  v_p public.profiles;
  v_versions jsonb;
begin
  if v_uid is null then
    raise sqlstate 'PT401' using message = 'unauthorized';
  end if;
  select * into v_e from public.entitlements where user_id = v_uid;
  select * into v_p from public.profiles where id = v_uid;
  select value into v_versions from public.app_config where key = 'consent_versions';
  return private.quota_status(v_uid) || jsonb_build_object(
    'entitlement', jsonb_build_object(
      'isTrial', coalesce(v_e.is_trial, false), 'productId', v_e.product_id, 'expiresAt', v_e.expires_at,
      'willRenew', coalesce(v_e.will_renew, false), 'inGrace', coalesce(v_e.in_grace, false),
      'billingIssue', coalesce(v_e.billing_issue, false)),
    'consent', jsonb_build_object(
      'pdpl', jsonb_build_object('current', v_versions ->> 'pdpl', 'accepted', v_p.pdpl_consent_version),
      'ai', jsonb_build_object('current', v_versions ->> 'ai', 'accepted', v_p.ai_consent_version),
      'upToDate', v_p.pdpl_consent_version is not distinct from (v_versions ->> 'pdpl')
        and v_p.ai_consent_version is not distinct from (v_versions ->> 'ai')
        and v_p.pdpl_consent_version is not null and v_p.ai_consent_version is not null),
    'isReviewer', coalesce(v_p.is_reviewer, false),
    'isAnonymous', coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false));
end;
$$;

-- Free redaction of a full coach-result.v1 (CONTRACTS.md "A free result"): keep hero, overall, subScores, at most 1
-- strength, safety, recordingTips, rulesTip, summary, …; drop checkpoints; empty weaknesses and plan; access=free and
-- the hidden counts in `locked`.
create or replace function private.redact_result_free(p_result jsonb)
returns jsonb
language sql
immutable
security definer
set search_path = ''
as $$
  select (p_result - 'checkpoints') || jsonb_build_object(
    'access', 'free',
    'locked', jsonb_build_object(
      'strengths', greatest(jsonb_array_length(coalesce(p_result -> 'strengths', '[]'::jsonb)) - 1, 0),
      'weaknesses', jsonb_array_length(coalesce(p_result -> 'weaknesses', '[]'::jsonb)),
      'plan', jsonb_array_length(coalesce(p_result -> 'plan', '[]'::jsonb))),
    'strengths', case when jsonb_array_length(coalesce(p_result -> 'strengths', '[]'::jsonb)) > 0
      then jsonb_build_array(p_result -> 'strengths' -> 0) else '[]'::jsonb end,
    'weaknesses', '[]'::jsonb,
    'plan', '[]'::jsonb);
$$;

-- The caller's result, redacted by the CURRENT tier (an upgrade unlocks past reports).
create or replace function public.get_result(p_analysis_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_result jsonb;
begin
  if v_uid is null then
    raise sqlstate 'PT401' using message = 'unauthorized';
  end if;
  select r.result into v_result
  from public.analysis_results r
  join public.analyses a on a.id = r.analysis_id
  where r.analysis_id = p_analysis_id and a.user_id = v_uid;
  if not found then
    raise sqlstate 'PT404' using message = 'analysis_not_found';
  end if;
  if private.tier_of(v_uid) = 'free' then
    return private.redact_result_free(v_result);
  end if;
  return v_result || jsonb_build_object('access', 'full', 'locked',
    jsonb_build_object('strengths', 0, 'weaknesses', 0, 'plan', 0));
end;
$$;

-- History, newest first, without drafts (status prepared). Free: the newest features.history_full_limit (3)
-- results are shown in full; older results are locked stubs (no score, level or hero title).
create or replace function public.get_history(p_limit int default 20, p_before timestamptz default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_tier text;
  v_full_limit int;
  v_items jsonb;
begin
  if v_uid is null then
    raise sqlstate 'PT401' using message = 'unauthorized';
  end if;
  v_tier := private.tier_of(v_uid);
  select (p.features ->> 'history_full_limit')::int into v_full_limit from public.plan_limits p where p.tier = v_tier;

  with ranked as (
    select a.id, a.sport, a.skill, a.status, a.subject, a.camera_view, a.failure_code, a.created_at, a.completed_at,
      r.analysis_id is not null as has_result, r.display_score, r.level, r.partial,
      r.result -> 'hero' ->> 'title' as hero_title,
      count(r.analysis_id) over (order by a.created_at desc, a.id desc) as result_rank
    from public.analyses a
    left join public.analysis_results r on r.analysis_id = a.id
    where a.user_id = v_uid and a.status <> 'prepared'
  ), page as (
    select *, (v_full_limit is not null and has_result and result_rank > v_full_limit) as locked
    from ranked
    where p_before is null or created_at < p_before
    order by created_at desc, id desc
    limit least(greatest(coalesce(p_limit, 20), 1), 100)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', id, 'sport', sport, 'skill', skill, 'status', status, 'subject', subject, 'cameraView', camera_view,
      'failureCode', failure_code, 'createdAt', created_at, 'completedAt', completed_at, 'hasResult', has_result,
      'locked', locked,
      'displayScore', case when locked then null else display_score end,
      'level', case when locked then null else level end,
      'partial', case when locked then null else partial end,
      'heroTitle', case when locked then null else hero_title end
    ) order by created_at desc, id desc), '[]'::jsonb)
  into v_items from page;
  return v_items;
end;
$$;

-- Progress points (premium or trial only; subject = self; succeeded results). Display values only.
create or replace function public.get_progress(p_sport text, p_skill text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_points jsonb;
begin
  if v_uid is null then
    raise sqlstate 'PT401' using message = 'unauthorized';
  end if;
  if private.tier_of(v_uid) = 'free' then
    raise sqlstate 'PT403' using message = 'forbidden', detail = 'progress requires premium or trial';
  end if;
  if p_sport is null or p_sport not in ('badminton', 'pickleball') then
    raise sqlstate 'PT422' using message = 'invalid_payload', detail = 'unknown sport';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'analysisId', r.analysis_id, 'skill', r.skill, 'createdAt', r.created_at,
      'displayScore', r.display_score, 'level', r.level, 'partial', r.partial,
      'subScores', (
        select coalesce(jsonb_agg(jsonb_build_object('key', s ->> 'key', 'displayScore', s -> 'displayScore')),
          '[]'::jsonb)
        from jsonb_array_elements(r.sub_scores) s)
    ) order by r.created_at), '[]'::jsonb)
  into v_points
  from (
    select * from public.analysis_results r
    where r.user_id = v_uid and r.sport = p_sport and (p_skill is null or r.skill = p_skill)
      and r.subject = 'self' and r.status = 'succeeded'
    order by r.created_at desc
    limit 200
  ) r;
  return v_points;
end;
$$;
