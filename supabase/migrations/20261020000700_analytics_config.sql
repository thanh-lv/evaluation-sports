-- 0700 config and first-party analytics (DESIGN.md §6.5, D21, D22, §8.7). Values are seeded by supabase/seed.sql.

-- ---------------------------------------------------------------------------------------------------------------
-- app_config: small typed-by-convention key/value flags, readable by everyone. Known keys (see docs/database.md):
--   min_user_age (int), consent_versions ({pdpl, ai}), budget_usd (number), budget_alert_ratio (number),
--   budget_hard_cap_mult (number), event_allowlist (text[]), event_daily_limit (int), event_props_max_bytes (int)

create table public.app_config (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{1,63}$'),
  value jsonb not null,
  description text,
  updated_at timestamptz not null default now()
);
alter table public.app_config enable row level security;

create trigger app_config_touch_updated_at
before update on public.app_config
for each row execute function private.touch_updated_at();

-- enabled_skills: rubric skills switched on for the catalog (D4). The rubric JSON holds the content.
create table public.enabled_skills (
  skill text primary key check (skill ~ '^(bd|pb)\.[a-z0-9_]+$'),
  sport text not null check (sport in ('badminton', 'pickleball')),
  enabled boolean not null default false,
  note text,
  updated_at timestamptz not null default now(),
  constraint enabled_skills_sport_prefix check (
    (sport = 'badminton' and skill like 'bd.%') or (sport = 'pickleball' and skill like 'pb.%')
  )
);
alter table public.enabled_skills enable row level security;

create trigger enabled_skills_touch_updated_at
before update on public.enabled_skills
for each row execute function private.touch_updated_at();

-- events: first-party analytics (D22). Written by log_event() and by the service role; no client SELECT.
-- 13-month retention (private.purge_expired_rows).
create table public.events (
  id bigint generated always as identity primary key,
  user_id uuid references public.profiles (id) on delete cascade,
  name text not null check (name ~ '^[a-z][a-z0-9_.]{1,63}$'),
  props jsonb not null default '{}' check (jsonb_typeof(props) = 'object' and octet_length(props::text) <= 2048),
  source text not null default 'client' check (source in ('client', 'server')),
  created_at timestamptz not null default now()
);
alter table public.events enable row level security;

create index events_user_created_idx on public.events (user_id, created_at);
create index events_created_idx on public.events (created_at);

-- ---------------------------------------------------------------------------------------------------------------
-- Grants and policies for these tables

revoke all on public.app_config, public.enabled_skills, public.events from anon, authenticated;
grant all on public.app_config, public.enabled_skills, public.events to service_role;

grant select on public.app_config to anon, authenticated;
grant select on public.enabled_skills to anon, authenticated;

create policy app_config_read_all on public.app_config
for select to anon, authenticated
using (true);

create policy enabled_skills_read_all on public.enabled_skills
for select to anon, authenticated
using (true);

-- ---------------------------------------------------------------------------------------------------------------
-- log_event(name, props): allowlisted names, props object ≤ 2 KB, ≤ 300 client events per user per ICT day.
-- Invalid input raises (PT422 invalid_payload); over the daily cap it returns false without storing, so a batched
-- client never fails a whole batch for analytics.

create or replace function public.log_event(p_name text, p_props jsonb default '{}')
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_allow jsonb;
  v_limit int;
  v_max_bytes int;
  v_day_start timestamptz := date_trunc('day', now() at time zone 'Asia/Ho_Chi_Minh') at time zone 'Asia/Ho_Chi_Minh';
  v_count int;
begin
  if v_uid is null then
    raise sqlstate 'PT401' using message = 'unauthorized';
  end if;
  select value into v_allow from public.app_config where key = 'event_allowlist';
  select (value #>> '{}')::int into v_limit from public.app_config where key = 'event_daily_limit';
  select (value #>> '{}')::int into v_max_bytes from public.app_config where key = 'event_props_max_bytes';
  v_limit := coalesce(v_limit, 300);
  v_max_bytes := least(coalesce(v_max_bytes, 2048), 2048);

  if p_name is null or v_allow is null or not (v_allow ? p_name) then
    raise sqlstate 'PT422' using message = 'invalid_payload', detail = 'event name not allowed';
  end if;
  p_props := coalesce(p_props, '{}'::jsonb);
  if jsonb_typeof(p_props) <> 'object' or octet_length(p_props::text) > v_max_bytes then
    raise sqlstate 'PT422' using message = 'invalid_payload', detail = 'props must be an object of at most 2 KB';
  end if;

  -- serialise per user so concurrent batches cannot overshoot the cap
  perform pg_advisory_xact_lock(hashtextextended('events:' || v_uid::text, 0));
  select count(*) into v_count from public.events e
  where e.user_id = v_uid and e.source = 'client' and e.created_at >= v_day_start;
  if v_count >= v_limit then
    return false;
  end if;

  insert into public.events (user_id, name, props, source) values (v_uid, p_name, p_props, 'client');
  return true;
end;
$$;

revoke execute on function public.log_event(text, jsonb) from public, anon;
grant execute on function public.log_event(text, jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- DB-only retention for the daily cron task (§6.6). Files are handled by the cron Edge Function.

create or replace function private.purge_expired_rows()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_events int;
  v_outputs int;
  v_notifications int;
begin
  delete from public.events where created_at < now() - interval '13 months';
  get diagnostics v_events = row_count;
  delete from private.llm_outputs where created_at < now() - interval '90 days';
  get diagnostics v_outputs = row_count;
  delete from private.appstore_notifications
  where status = 'processed' and received_at < now() - interval '13 months';
  get diagnostics v_notifications = row_count;
  return jsonb_build_object('events', v_events, 'llmOutputs', v_outputs, 'appstoreNotifications', v_notifications);
end;
$$;

revoke execute on function private.purge_expired_rows() from public, anon, authenticated;
grant execute on function private.purge_expired_rows() to service_role;
