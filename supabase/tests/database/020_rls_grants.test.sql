-- RLS isolation between two users, column grants and feedback ownership (DESIGN.md §6.5 "RLS and grants", M5).
begin;
\ir _helpers.psql
select plan(32);

create temp table ids (name text primary key, id uuid) on commit drop;
grant all on ids to anon, authenticated;
insert into ids values ('alice', tests.create_user('alice@example.com')), ('bob', tests.create_user(null, true));
insert into ids select 'a1', tests.add_result((select id from ids where name = 'alice'));
insert into ids select 'b1', tests.add_result((select id from ids where name = 'bob'));
insert into public.usage_counters (user_id, period_key, used) select id, '2026-10', 1 from ids where name in ('alice', 'bob');
insert into public.events (user_id, name) select id, 'app_open' from ids where name = 'alice';
select tests.set_entitlement((select id from ids where name = 'bob'), 'premium', now() + interval '10 days');

-- Alice ------------------------------------------------------------------------------------------------------------
select tests.login_as((select id from ids where name = 'alice'));

select results_eq($$select id from public.profiles$$, $$select id from ids where name = 'alice'$$,
  'profiles: only own row visible');
select results_eq($$select id from public.analyses$$, $$select id from ids where name = 'a1'$$,
  'analyses: only own rows visible');
select lives_ok(
  $$select id, user_id, sport, skill, status, failure_code, camera_view, subject, created_at, completed_at
    from public.analyses$$,
  'analyses: the granted columns are readable');
select throws_ok($$select prepared from public.analyses$$, '42501', null, 'analyses.prepared is not readable');
select throws_ok($$select pose_clean_path from public.analyses$$, '42501', null, 'analyses pose paths are not readable');
select throws_ok($$select quality, video_meta from public.analyses$$, '42501', null, 'analyses quality/meta are not readable');
select throws_ok($$select * from public.analyses$$, '42501', null, 'select * on analyses is refused');
select throws_ok($$select result from public.analysis_results$$, '42501', null, 'analysis_results.result is not readable');
select throws_ok($$select 1 from public.quota_ledger$$, '42501', null, 'quota_ledger is not readable');
select throws_ok($$select 1 from public.model_routes$$, '42501', null, 'model_routes is not readable');
select throws_ok($$select 1 from public.events$$, '42501', null, 'events are not readable');
select throws_ok($$select 1 from public.app_store_subscriptions$$, '42501', null, 'subscriptions are not readable');
select throws_ok($$select 1 from private.llm_calls$$, '42501', null, 'private schema is not usable');
select throws_ok(
  $$insert into public.analyses (id, user_id, sport, skill) values (gen_random_uuid(), auth.uid(), 'badminton', 'bd.smash')$$,
  '42501', null, 'clients cannot insert analyses');
select throws_ok($$update public.analyses set status = 'succeeded'$$, '42501', null, 'clients cannot update analyses');
select is((select count(*)::int from public.usage_counters), 1, 'usage_counters: only own row');
select is((select count(*)::int from public.entitlements), 0, 'entitlements: other users rows invisible');
select is((select count(*)::int from public.plan_limits), 3, 'plan_limits readable');

-- profiles: allowed columns update, server-owned columns refused, other users untouched
select lives_ok($$update public.profiles set locale = 'en', handedness = 'left', calibration_opt_in = true$$,
  'profiles: allowed columns are updatable');
select throws_ok($$update public.profiles set is_reviewer = true$$, '42501', null, 'profiles.is_reviewer is not updatable');
select throws_ok($$update public.profiles set ai_consent_at = now()$$, '42501', null,
  'consent timestamps are not client-writable');
update public.profiles set locale = 'en' where id = (select id from ids where name = 'bob');

-- feedback ownership
select lives_ok(
  $$insert into public.feedback (analysis_id, rating, comment) select id, 1, 'great' from ids where name = 'a1'$$,
  'feedback on own analysis is allowed (user_id defaults to auth.uid())');
select throws_ok(
  $$insert into public.feedback (analysis_id, rating) select id, 1 from ids where name = 'b1'$$,
  '42501', null, 'feedback on another user''s analysis is refused');
select throws_ok(
  $$insert into public.feedback (analysis_id, user_id, rating) select a.id, b.id, -1 from ids a, ids b
    where a.name = 'a1' and b.name = 'bob'$$,
  '42501', null, 'feedback cannot be written for another user');

-- delete: own analysis only
delete from public.analyses where id = (select id from ids where name = 'b1');

-- Bob ----------------------------------------------------------------------------------------------------------------
select tests.login_as((select id from ids where name = 'bob'), true);
select is((select locale from public.profiles), null, 'alice could not update bob''s profile');
select is((select count(*)::int from public.analyses), 1, 'alice could not delete bob''s analysis');
select is((select count(*)::int from public.feedback), 0, 'bob does not see alice''s feedback');
select is((select tier from public.entitlements), 'premium', 'bob (anonymous) sees his own entitlement');
select lives_ok($$delete from public.analyses$$, 'bob deletes his own analyses');

-- Anon (no session) ----------------------------------------------------------------------------------------------------
select tests.login_anon();
select throws_ok($$select id from public.analyses$$, '42501', null, 'anon cannot read analyses');
select throws_ok($$select id from public.profiles$$, '42501', null, 'anon cannot read profiles');
select is((select count(*)::int from public.enabled_skills), 12, 'anon can read enabled_skills');

select tests.logout();

select * from finish();
rollback;
