-- 1100 jobs fixes (M7: analyze + cron functions, DESIGN.md §6.1, §6.6, §8.2, §8.7).
--
-- The Edge Functions reach the database through supabase-js with equality filters only, so the range queries the
-- daily cron and the prepare rate limit need live here. Every function is service-role only (migration 0100 removed
-- the EXECUTE-to-PUBLIC default; the grants below are explicit).

-- ---------------------------------------------------------------------------------------------------------------
-- Per-user fixed-window rate limits (POST /analyze/prepare: 20 pose.v1 bodies per hour per user, §6.1).

create table private.rate_limits (
  user_id uuid not null references public.profiles (id) on delete cascade,
  bucket text not null check (bucket ~ '^[a-z][a-z0-9_.]{1,31}$'),
  window_start timestamptz not null,
  count int not null default 0 check (count >= 0),
  primary key (user_id, bucket, window_start)
);
alter table private.rate_limits enable row level security;
grant all on private.rate_limits to service_role;

-- Counts one hit in the current window (windows are aligned to multiples of p_window_s since the epoch) and returns
-- {allowed, count, limit, resetAt}. Denied hits are counted too, so hammering does not reopen the window early.
create or replace function private.rate_limit_hit(
  p_user_id uuid,
  p_bucket text,
  p_limit int,
  p_window_s int default 3600
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_window int := greatest(coalesce(p_window_s, 3600), 1);
  v_start timestamptz := to_timestamp(floor(extract(epoch from now()) / v_window) * v_window);
  v_count int;
begin
  insert into private.rate_limits as r (user_id, bucket, window_start, count)
  values (p_user_id, p_bucket, v_start, 1)
  on conflict (user_id, bucket, window_start) do update set count = r.count + 1
  returning r.count into v_count;
  return jsonb_build_object(
    'allowed', v_count <= p_limit, 'count', v_count, 'limit', p_limit,
    'resetAt', private.ict_iso(v_start + make_interval(secs => v_window)));
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Daily cron (§6.6). Each returns at most p_limit rows; the caller works in chunks and re-runs are idempotent.

-- Jobs still queued or processing p_older_than_s after they were queued (72 h cap). The caller claims each one
-- (fencing) and then fails it with `expired`, which refunds the quota; frames are deleted afterwards.
create or replace function private.cron_stale_jobs(p_older_than_s int default 259200, p_limit int default 100)
returns table (id uuid, user_id uuid, status text)
language sql
stable
security definer
set search_path = ''
as $$
  select a.id, a.user_id, a.status
  from public.analyses a
  where a.status in ('queued', 'processing')
    and coalesce(a.queued_at, a.created_at) < now() - make_interval(secs => p_older_than_s)
  order by coalesce(a.queued_at, a.created_at)
  limit greatest(coalesce(p_limit, 100), 1);
$$;

-- Drafts never submitted: `prepared` rows, and `rejected` rows from a prepare rejection (no result and no quota
-- reservation; a result rejected by the input check keeps its analysis_results row). Untouched for p_older_than_s.
create or replace function private.cron_expired_drafts(p_older_than_s int default 86400, p_limit int default 200)
returns table (id uuid, user_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select a.id, a.user_id
  from public.analyses a
  where a.status in ('prepared', 'rejected')
    and a.updated_at < now() - make_interval(secs => p_older_than_s)
    and not exists (select 1 from public.analysis_results r where r.analysis_id = a.id)
    and not exists (select 1 from public.quota_ledger l where l.analysis_id = a.id)
  order by a.updated_at
  limit greatest(coalesce(p_limit, 200), 1);
$$;

-- Analyses that still reference pose JSON files and whose owner has been inactive for p_months: no sign-in, no
-- analysis and no event in that time. The caller deletes the files and clears the paths.
create or replace function private.cron_inactive_pose(p_months int default 24, p_limit int default 200)
returns table (id uuid, user_id uuid, pose_raw_path text, pose_clean_path text)
language sql
stable
security definer
set search_path = ''
as $$
  with inactive as (
    select u.id
    from auth.users u
    where greatest(
      coalesce(u.last_sign_in_at, u.created_at),
      u.created_at,
      (select max(b.created_at) from public.analyses b where b.user_id = u.id),
      (select max(e.created_at) from public.events e where e.user_id = u.id)
    ) < now() - make_interval(months => p_months)
  )
  select a.id, a.user_id, a.pose_raw_path, a.pose_clean_path
  from public.analyses a
  join inactive i on i.id = a.user_id
  where a.pose_raw_path is not null or a.pose_clean_path is not null
  order by a.created_at
  limit greatest(coalesce(p_limit, 200), 1);
$$;

-- Expired rate-limit windows (kept 2 days for debugging).
create or replace function private.cron_purge_rate_limits()
returns int
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_n int;
begin
  delete from private.rate_limits where window_start < now() - interval '2 days';
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Grammar warm-up (§8.2): which (model, sport) pairs served a real call in the last p_hours. Warm-up calls are stored
-- with a marker analysis id that matches no analysis; they come back with sport = null and `analysis_id` set, so the
-- caller can map its own markers.
create or replace function private.recent_model_use(p_hours int default 20)
returns table (model text, sport text, analysis_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct c.model_requested, a.sport, case when a.id is null then c.analysis_id end
  from private.llm_calls c
  left join public.analyses a on a.id = c.analysis_id
  where c.created_at > now() - make_interval(hours => p_hours)
    and c.model_served is not null;
$$;

revoke execute on function private.rate_limit_hit(uuid, text, int, int) from public, anon, authenticated;
revoke execute on function private.cron_stale_jobs(int, int) from public, anon, authenticated;
revoke execute on function private.cron_expired_drafts(int, int) from public, anon, authenticated;
revoke execute on function private.cron_inactive_pose(int, int) from public, anon, authenticated;
revoke execute on function private.cron_purge_rate_limits() from public, anon, authenticated;
revoke execute on function private.recent_model_use(int) from public, anon, authenticated;
grant execute on function private.rate_limit_hit(uuid, text, int, int) to service_role;
grant execute on function private.cron_stale_jobs(int, int) to service_role;
grant execute on function private.cron_expired_drafts(int, int) to service_role;
grant execute on function private.cron_inactive_pose(int, int) to service_role;
grant execute on function private.cron_purge_rate_limits() to service_role;
grant execute on function private.recent_model_use(int) to service_role;
