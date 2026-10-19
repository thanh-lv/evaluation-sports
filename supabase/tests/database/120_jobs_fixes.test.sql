-- M7 helpers (migration 1100): prepare rate limit, daily-cron retention queries and the warm-up lookup
-- (DESIGN.md §6.1, §6.6, §8.2).
begin;
\ir _helpers.psql
select plan(23);

create temp table ids (name text primary key, id uuid) on commit drop;

-- Rate limit ------------------------------------------------------------------------------------------------------------
insert into ids values ('u', tests.create_user()), ('v', tests.create_user());

select is((private.rate_limit_hit((select id from ids where name = 'u'), 'prepare', 2) ->> 'allowed')::boolean, true,
  'first hit allowed');
select is((private.rate_limit_hit((select id from ids where name = 'u'), 'prepare', 2) ->> 'allowed')::boolean, true,
  'second hit allowed (limit 2)');
select is(private.rate_limit_hit((select id from ids where name = 'u'), 'prepare', 2) - 'resetAt',
  '{"allowed": false, "count": 3, "limit": 2}'::jsonb, 'third hit denied and counted');
select is((private.rate_limit_hit((select id from ids where name = 'v'), 'prepare', 2) ->> 'allowed')::boolean, true,
  'another user has its own window');
select is((private.rate_limit_hit((select id from ids where name = 'u'), 'reprepare', 2) ->> 'allowed')::boolean, true,
  'another bucket has its own window');
select matches(private.rate_limit_hit((select id from ids where name = 'u'), 'prepare', 2) ->> 'resetAt',
  '^\d{4}-\d{2}-\d{2}T\d{2}:00:00\+07:00$', 'resetAt is the next hour boundary in ICT');
update private.rate_limits set window_start = window_start - interval '3 days'
where user_id = (select id from ids where name = 'v');
select is(private.cron_purge_rate_limits(), 1, 'expired windows are purged');
select is((private.rate_limit_hit((select id from ids where name = 'v'), 'prepare', 2) ->> 'count')::int, 1,
  'a fresh window starts at 1');

-- Stale jobs (72 h cap) ---------------------------------------------------------------------------------------------------
insert into ids select 'old', tests.make_analysis((select id from ids where name = 'u'));
insert into ids select 'new', tests.make_analysis((select id from ids where name = 'v'));
insert into ids select 'draft', tests.make_analysis((select id from ids where name = 'v'), 'prepared', 'bd.clear_fh',
  now() - interval '5 days');
select private.reserve_for_submit((select id from ids where name = 'u'), (select id from ids where name = 'old'), false);
select private.reserve_for_submit((select id from ids where name = 'v'), (select id from ids where name = 'new'), false);
update public.analyses set queued_at = now() - interval '73 hours' where id = (select id from ids where name = 'old');

select is((select array_agg(id) from private.cron_stale_jobs()), array[(select id from ids where name = 'old')],
  'only the job queued more than 72 h ago is stale');
select is((select count(*)::int from private.cron_stale_jobs(3600 * 100)), 0, 'the threshold is a parameter');
select private.claim_analysis((select id from ids where name = 'old'));
select is((select status from private.cron_stale_jobs() where id = (select id from ids where name = 'old')), 'processing',
  'processing jobs are listed too (the caller claims before failing)');

-- Expired drafts (24 h) ---------------------------------------------------------------------------------------------------
alter table public.analyses disable trigger analyses_touch_updated_at;
update public.analyses set updated_at = now() - interval '25 hours'
where id in (select id from ids where name in ('draft', 'old', 'new'));
alter table public.analyses enable trigger analyses_touch_updated_at;
insert into ids select 'fresh', tests.make_analysis((select id from ids where name = 'u'));
insert into ids select 'rej', tests.make_analysis((select id from ids where name = 'u'), 'rejected');
insert into ids select 'res', tests.add_result((select id from ids where name = 'u'));
alter table public.analyses disable trigger analyses_touch_updated_at;
update public.analyses set updated_at = now() - interval '2 days', status = 'rejected'
where id in (select id from ids where name in ('rej', 'res'));
alter table public.analyses enable trigger analyses_touch_updated_at;

select set_eq(
  $$select id from private.cron_expired_drafts()$$,
  $$select id from ids where name in ('draft', 'rej')$$,
  'old prepared drafts and prepare rejections expire; submitted jobs, fresh drafts and results do not');
select is((select count(*)::int from private.cron_expired_drafts(86400, 1)), 1, 'the limit is honoured');

-- Pose JSON after 24 months of inactivity ------------------------------------------------------------------------------
insert into ids values ('sleeper', tests.create_user()), ('active', tests.create_user());
update auth.users set created_at = now() - interval '30 months', last_sign_in_at = now() - interval '25 months'
where id in (select id from ids where name in ('sleeper', 'active'));
insert into ids select 'sa', tests.make_analysis((select id from ids where name = 'sleeper'), 'succeeded', 'bd.clear_fh',
  now() - interval '26 months');
insert into ids select 'aa', tests.make_analysis((select id from ids where name = 'active'), 'succeeded', 'bd.clear_fh',
  now() - interval '26 months');
insert into public.events (user_id, name, created_at)
select id, 'app_open', now() - interval '3 months' from ids where name = 'active';

select is((select array_agg(id) from private.cron_inactive_pose()), array[(select id from ids where name = 'sa')],
  'only the inactive owner''s pose files are listed (a recent event counts as activity)');
select is((select pose_raw_path from private.cron_inactive_pose() limit 1),
  (select id from ids where name = 'sleeper') || '/' || (select id from ids where name = 'sa') || '/pose.raw.json',
  'paths are returned for deletion');
update public.analyses set pose_raw_path = null, pose_clean_path = null where id = (select id from ids where name = 'sa');
select is((select count(*)::int from private.cron_inactive_pose()), 0, 'cleared paths are not listed again');
update auth.users set last_sign_in_at = now() - interval '1 day' where id = (select id from ids where name = 'sleeper');
update public.analyses set pose_raw_path = 'x' where id = (select id from ids where name = 'sa');
select is((select count(*)::int from private.cron_inactive_pose()), 0, 'a recent sign-in counts as activity');

-- Warm-up lookup ---------------------------------------------------------------------------------------------------------
insert into private.llm_calls (analysis_id, attempt, model_requested, model_served, created_at)
values ((select id from ids where name = 'new'), 1, 'claude-haiku-5-5', 'claude-haiku-5-5', now() - interval '1 hour'),
  ((select id from ids where name = 'sa'), 1, 'claude-sonnet-5-5', 'claude-sonnet-5-5', now() - interval '30 hours'),
  ((select id from ids where name = 'res'), 1, 'claude-sonnet-5-5', null, now() - interval '1 hour'),
  ('00000000-0000-4000-8000-0000000000b1', 0, 'claude-sonnet-5-5', 'claude-sonnet-5-5', now() - interval '2 hours');
select set_eq(
  $$select model, sport, analysis_id from private.recent_model_use()$$,
  $$values ('claude-haiku-5-5', 'badminton', null::uuid),
    ('claude-sonnet-5-5', null, '00000000-0000-4000-8000-0000000000b1'::uuid)$$,
  'recent served calls by (model, sport); calls without a response and old calls do not count; markers come back');
select is((select count(*)::int from private.recent_model_use(48)), 3, 'the window is a parameter');

-- Privileges ---------------------------------------------------------------------------------------------------------------
select ok(not has_function_privilege('authenticated', 'private.rate_limit_hit(uuid, text, int, int)', 'execute')
  and not has_function_privilege('anon', 'private.rate_limit_hit(uuid, text, int, int)', 'execute'),
  'clients cannot call rate_limit_hit');
select ok(not has_function_privilege('authenticated', 'private.cron_stale_jobs(int, int)', 'execute')
  and not has_function_privilege('authenticated', 'private.cron_expired_drafts(int, int)', 'execute')
  and not has_function_privilege('authenticated', 'private.cron_inactive_pose(int, int)', 'execute')
  and not has_function_privilege('authenticated', 'private.recent_model_use(int)', 'execute'),
  'clients cannot call the cron helpers');
select ok(has_function_privilege('service_role', 'private.cron_stale_jobs(int, int)', 'execute')
  and has_function_privilege('service_role', 'private.rate_limit_hit(uuid, text, int, int)', 'execute'),
  'the service role can');
select is((select relrowsecurity from pg_class where oid = 'private.rate_limits'::regclass), true,
  'rate_limits has RLS enabled');

select * from finish();
rollback;
