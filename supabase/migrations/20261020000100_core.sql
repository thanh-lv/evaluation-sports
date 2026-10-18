-- 0100 core: schemas, default privileges, profiles, analyses, analysis_results, feedback (DESIGN.md §6.5).
--
-- Conventions (apply to every migration):
--   * text + CHECK instead of enums; RLS enabled on every table at creation; policies in 0500.
--   * Clients (anon/authenticated) get nothing by default: every grant is explicit (0500, 0700).
--   * Functions are SECURITY DEFINER SET search_path = '' with schema-qualified names.
--   * Timezone for calendar keys is Asia/Ho_Chi_Minh (ICT, UTC+7, no DST).

-- ---------------------------------------------------------------------------------------------------------------
-- Schemas and default privileges

create schema if not exists private;
-- `private` is listed in the API schemas so the service role can reach it through PostgREST; clients cannot even
-- resolve names in it.
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

-- Supabase's defaults grant ALL on new public tables/functions to anon and authenticated. Turn that off for objects
-- created by this role so every client grant in later migrations is deliberate. service_role keeps its defaults.
-- PostgreSQL's built-in EXECUTE-to-PUBLIC default for functions is global, and a per-schema ALTER DEFAULT PRIVILEGES
-- can only add to the global defaults, never remove from them. Without this schema-less statement every function a
-- later migration creates in `public` would be callable by anon through PUBLIC.
alter default privileges revoke execute on functions from public;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
alter default privileges in schema private revoke execute on functions from public, anon, authenticated;
alter default privileges in schema private grant all on tables to service_role;
alter default privileges in schema private grant all on sequences to service_role;
alter default privileges in schema private grant execute on functions to service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- Generic trigger: updated_at

create or replace function private.touch_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- profiles: one row per auth user, anonymous users included (D14). No display_name.

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  -- null = follow the system/storefront default (D15)
  locale text check (locale in ('vi', 'en')),
  handedness text check (handedness in ('right', 'left')),
  level text check (level in ('beginner', 'improving', 'intermediate', 'advanced')),
  -- checked against app_config.min_user_age by private.check_profile_age (D21)
  birth_year smallint check (birth_year between 1900 and 2100),
  age_attested boolean not null default false,
  pdpl_consent_version text check (char_length(pdpl_consent_version) between 1 and 32),
  pdpl_consent_at timestamptz,
  ai_consent_version text check (char_length(ai_consent_version) between 1 and 32),
  ai_consent_at timestamptz,
  calibration_opt_in boolean not null default false,
  consumption_consent boolean not null default false,
  -- App Review / demo accounts: exempt from the daily budget guard (§8.7). Never client-writable.
  is_reviewer boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

create trigger profiles_touch_updated_at
before update on public.profiles
for each row execute function private.touch_updated_at();

-- Age gate (D21): the year-based age must reach min_user_age; when it equals min_user_age exactly the user may still
-- be one year younger (birthday not reached), so an attestation is required. Consent timestamps are server-set.
create or replace function private.check_profile_age()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_min int;
  v_age int;
begin
  if new.birth_year is not null
     and (tg_op = 'INSERT' or new.birth_year is distinct from old.birth_year
          or new.age_attested is distinct from old.age_attested) then
    select coalesce((value #>> '{}')::int, 18) into v_min from public.app_config where key = 'min_user_age';
    v_min := coalesce(v_min, 18);
    v_age := extract(year from (now() at time zone 'Asia/Ho_Chi_Minh'))::int - new.birth_year;
    if v_age < v_min then
      raise exception 'under_min_age' using errcode = 'check_violation',
        detail = format('minimum age is %s', v_min);
    end if;
    if v_age = v_min and not new.age_attested then
      raise exception 'age_attestation_required' using errcode = 'check_violation',
        detail = format('birth year %s may be under %s; set age_attested', new.birth_year, v_min);
    end if;
  end if;
  return new;
end;
$$;

create trigger profiles_check_age
before insert or update on public.profiles
for each row execute function private.check_profile_age();

create or replace function private.stamp_profile_consents()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or new.pdpl_consent_version is distinct from old.pdpl_consent_version then
    new.pdpl_consent_at := case when new.pdpl_consent_version is null then null else now() end;
  else
    new.pdpl_consent_at := old.pdpl_consent_at;
  end if;
  if tg_op = 'INSERT' or new.ai_consent_version is distinct from old.ai_consent_version then
    new.ai_consent_at := case when new.ai_consent_version is null then null else now() end;
  else
    new.ai_consent_at := old.ai_consent_at;
  end if;
  return new;
end;
$$;

create trigger profiles_stamp_consents
before insert or update on public.profiles
for each row execute function private.stamp_profile_consents();

-- ---------------------------------------------------------------------------------------------------------------
-- analyses: one row per clip; id is generated by the client (lowercase uuid). Written only by the service role.

create table public.analyses (
  id uuid primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  sport text not null check (sport in ('badminton', 'pickleball')),
  skill text not null check (skill ~ '^(bd|pb)\.[a-z0-9_]+$'),
  -- the view the user picked (`auto` = use viewGuess) and the view confirmed after prepare
  camera_view text check (camera_view in ('side', 'behind', 'front', 'diagonal', 'auto')),
  view_confirmed text check (view_confirmed in ('side', 'behind', 'front', 'diagonal')),
  subject text not null default 'self' check (subject in ('self', 'other')),
  subject_consent boolean not null default false,
  subject_minor boolean not null default false,
  frame_mode text not null default 'frames' check (frame_mode in ('frames', 'pose_only')),
  language text not null default 'vi' check (language in ('vi', 'en')),
  handedness text check (handedness in ('right', 'left')),
  excluded_strokes int[] not null default '{}',
  status text not null default 'prepared'
    check (status in ('prepared', 'queued', 'processing', 'succeeded', 'rejected', 'failed')),
  -- prepare rejection code, result rejection code or FAILURE_CODES (contracts/common.ts)
  failure_code text check (failure_code ~ '^[a-z][a-z0-9_]{1,63}$'),
  -- last transient error recorded by requeue (not shown to clients)
  last_error_code text check (last_error_code ~ '^[a-z0-9_.:-]{1,64}$'),
  kind text check (kind in ('basic', 'standard')),
  model text,
  effort text,
  algo_version text,
  rubric_version text,
  prompt_version text,
  schema_version text,
  analysis_hz smallint check (analysis_hz in (30, 60)),
  video_meta jsonb,
  quality jsonb,
  -- engine output (strokes, checkpoint table, candidates, frame plan, warnings): input to the Claude request
  prepared jsonb,
  -- analysis-derived bucket object names: {uid}/{id}/pose.raw.json, {uid}/{id}/pose.clean.json
  pose_raw_path text,
  pose_clean_path text,
  frame_count smallint not null default 0 check (frame_count between 0 and 9),
  attempt_count int not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz,
  locked_at timestamptz,
  max_tokens_mult real not null default 1 check (max_tokens_mult >= 1 and max_tokens_mult <= 4),
  queued_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint analyses_skill_matches_sport check (
    (sport = 'badminton' and skill like 'bd.%') or (sport = 'pickleball' and skill like 'pb.%')
  ),
  constraint analyses_other_needs_consent check (subject = 'self' or subject_consent),
  constraint analyses_minor_is_other_pose_only check (
    not subject_minor or (subject = 'other' and frame_mode = 'pose_only')
  )
);
alter table public.analyses enable row level security;

create index analyses_user_created_idx on public.analyses (user_id, created_at desc);
create index analyses_inflight_idx on public.analyses (next_attempt_at)
  where status in ('queued', 'processing');
create index analyses_prepared_created_idx on public.analyses (created_at) where status = 'prepared';

create trigger analyses_touch_updated_at
before update on public.analyses
for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------------------------------------------------
-- analysis_results: the full coach-result.v1 (access=full). Clients read it only through get_result().

create table public.analysis_results (
  analysis_id uuid primary key references public.analyses (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  sport text not null check (sport in ('badminton', 'pickleball')),
  skill text not null,
  subject text not null check (subject in ('self', 'other')),
  status text not null default 'succeeded' check (status in ('succeeded', 'rejected')),
  -- exact internal overall (never sent to clients) and the rounded display value
  overall_score real check (overall_score between 0 and 100),
  display_score smallint check (display_score between 0 and 100 and display_score % 5 = 0),
  level text check (level in ('beginner', 'improving', 'intermediate', 'advanced')),
  coverage real check (coverage between 0 and 1),
  partial boolean not null default false,
  sub_scores jsonb not null default '[]',
  result jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.analysis_results enable row level security;

create index analysis_results_progress_idx on public.analysis_results (user_id, sport, skill, created_at);

-- ---------------------------------------------------------------------------------------------------------------
-- feedback: thumbs up/down per analysis

create table public.feedback (
  analysis_id uuid not null references public.analyses (id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  rating smallint not null check (rating in (-1, 1)),
  comment text check (char_length(comment) <= 500),
  created_at timestamptz not null default now(),
  primary key (analysis_id, user_id)
);
alter table public.feedback enable row level security;

create index feedback_user_idx on public.feedback (user_id);

-- ---------------------------------------------------------------------------------------------------------------
-- New auth user → profile (anonymous sign-ins included). Reviewer flag from private.reviewer_emails (0300), only for
-- a CONFIRMED email: GoTrue inserts the row before the OTP is verified (and a password sign-up can name any address),
-- so the flag must wait for email_confirmed_at.

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, is_reviewer)
  values (
    new.id,
    new.email is not null and new.email_confirmed_at is not null
      and exists (select 1 from private.reviewer_emails r where r.email = lower(new.email))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function private.handle_new_user();

-- A user whose reviewer email gets confirmed (OTP verified at sign-up, or an anonymous user linking the email)
-- becomes a reviewer.
create or replace function private.sync_reviewer_flag()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.email is not null and new.email_confirmed_at is not null
     and exists (select 1 from private.reviewer_emails r where r.email = lower(new.email)) then
    update public.profiles set is_reviewer = true where id = new.id and not is_reviewer;
  end if;
  return new;
end;
$$;

create trigger on_auth_user_email_changed
after update of email, email_confirmed_at on auth.users
for each row
when (new.email is distinct from old.email or new.email_confirmed_at is distinct from old.email_confirmed_at)
execute function private.sync_reviewer_flag();
