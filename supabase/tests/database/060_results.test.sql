-- get_result redaction by the current tier, get_history stubs, get_progress gating (DESIGN.md §6.5, CONTRACTS.md
-- "A free result"). The fixture pair shared/fixtures/results/example_{full,free}.json is checked by tests/sql/run.sh.
begin;
\ir _helpers.psql
select plan(34);

create temp table ids (name text primary key, id uuid) on commit drop;
create temp table got (name text primary key, v jsonb) on commit drop;
grant all on ids, got to anon, authenticated;

insert into ids values ('u', tests.create_user()), ('v', tests.create_user());
insert into ids select 'r1', tests.add_result((select id from ids where name = 'u'), 'bd.clear_fh', now() - interval '5 days');
insert into ids select 'r2', tests.add_result((select id from ids where name = 'u'), 'bd.clear_fh', now() - interval '4 days');
insert into ids select 'r3', tests.add_result((select id from ids where name = 'u'), 'bd.smash', now() - interval '3 days');
insert into ids select 'r4', tests.add_result((select id from ids where name = 'u'), 'bd.clear_fh', now() - interval '2 days',
  'other');
insert into ids select 'q', tests.make_analysis((select id from ids where name = 'u'), 'queued', 'bd.clear_fh',
  now() - interval '1 day');
insert into ids select 'd', tests.make_analysis((select id from ids where name = 'u')); -- draft: not in history
insert into ids select 'v1', tests.add_result((select id from ids where name = 'v'));

-- expected documents, computed with full privileges
insert into got select 'stored', result from public.analysis_results
where analysis_id = (select id from ids where name = 'r1');
insert into got select 'stored2', result from public.analysis_results
where analysis_id = (select id from ids where name = 'r2');
insert into got select 'redacted', private.redact_result_free(v) from got where name = 'stored2';

-- Free -----------------------------------------------------------------------------------------------------------------
select tests.login_as((select id from ids where name = 'u'));
-- r2 has 2 newer results (r3, r4), so it is among the newest 3 that free users may open
insert into got select 'free', public.get_result((select id from ids where name = 'r2'));
select is((select v ->> 'access' from got where name = 'free'), 'free', 'free: access = free');
select is((select v -> 'locked' from got where name = 'free'), '{"strengths": 1, "weaknesses": 2, "plan": 3}'::jsonb,
  'free: locked counts');
select is((select jsonb_array_length(v -> 'strengths') from got where name = 'free'), 1, 'free: one strength');
select is((select v -> 'strengths' -> 0 ->> 'checkpointId' from got where name = 'free'), 'S1', 'free: the first strength');
select is((select (v -> 'weaknesses') || (v -> 'plan') from got where name = 'free'), '[]'::jsonb,
  'free: weaknesses and plan are empty');
select ok((select not (v ? 'checkpoints') from got where name = 'free'), 'free: checkpoints are left out');
select ok((select v -> 'hero' is not null and v -> 'overall' is not null and v -> 'subScores' is not null
  and v ->> 'summary' = 'Summary text' and v -> 'safety' is not null and v -> 'recordingTips' is not null
  and v -> 'rulesTip' is not null from got where name = 'free'), 'free: hero, scores, summary, safety, tips are kept');
select is(
  (select v from got where name = 'free'),
  (select v from got where name = 'redacted'),
  'free: get_result is exactly the free redaction');

select throws_ok(format($$select public.get_result(%L)$$, (select id from ids where name = 'v1')), 'PT404',
  'analysis_not_found', 'another user''s result is not found');
select throws_ok(format($$select public.get_result(%L)$$, (select id from ids where name = 'q')), 'PT404',
  'analysis_not_found', 'an analysis without a result is not found');
select throws_ok($$select public.get_progress('badminton')$$, 'PT403', 'forbidden', 'free: progress is premium only');
select throws_ok(format($$select public.get_result(%L)$$, (select id from ids where name = 'r1')), 'PT403',
  'forbidden', 'free: a result locked in the history (4th newest) cannot be opened through get_result');
select is(public.get_result((select id from ids where name = 'r4')) ->> 'access', 'free',
  'free: the newest result opens (redacted)');

insert into got select 'hist', public.get_history();
select results_eq(
  $$select e ->> 'id', (e ->> 'locked')::boolean, (e ->> 'displayScore')::int
    from got, jsonb_array_elements(v) e where name = 'hist'$$,
  $$select id::text, l, s from (values ('q', false, null::int, 1), ('r4', false, 65, 2), ('r3', false, 65, 3),
      ('r2', false, 65, 4), ('r1', true, null, 5)) x(n, l, s, o) join ids on ids.name = x.n order by o$$,
  'free history: newest first, last 3 results in full, older ones locked, drafts hidden');
select is((select v -> 4 -> 'heroTitle' from got where name = 'hist'), 'null'::jsonb, 'locked stubs hide the hero title');
select is((select v -> 1 ->> 'heroTitle' from got where name = 'hist'), 'Hero fix', 'unlocked items show the hero title');
select is(jsonb_array_length(public.get_history(2)), 2, 'get_history honours the limit');
select is(public.get_history(10, now() - interval '3 days 12 hours') -> 0 ->> 'id',
  (select id::text from ids where name = 'r2'), 'get_history pages with p_before');
select is((public.get_history(10, now() - interval '4 days 12 hours') -> 0 ->> 'locked')::boolean, true,
  'paging keeps the global lock rank');

-- Premium (upgrade unlocks past reports) ---------------------------------------------------------------------------------
select tests.logout();
select tests.set_entitlement((select id from ids where name = 'u'), 'premium', now() + interval '1 day');
select tests.login_as((select id from ids where name = 'u'));
insert into got select 'full', public.get_result((select id from ids where name = 'r1'));
select is((select v ->> 'access' from got where name = 'full'), 'full', 'premium: access = full');
select is((select v - 'access' - 'locked' from got where name = 'full'),
  (select v - 'access' - 'locked' from got where name = 'stored'), 'premium: the whole stored result');
select is((select v -> 'locked' from got where name = 'full'), '{"strengths": 0, "weaknesses": 0, "plan": 0}'::jsonb,
  'premium: nothing locked');
select is((select bool_or((e ->> 'locked')::boolean) from jsonb_array_elements(public.get_history()) e), false,
  'premium: full history');

insert into got select 'prog', public.get_progress('badminton', 'bd.clear_fh');
select is((select jsonb_array_length(v) from got where name = 'prog'), 2, 'progress: self clear_fh results only');
select is((select v -> 0 ->> 'analysisId' from got where name = 'prog'), (select id::text from ids where name = 'r1'),
  'progress: oldest first');
select is((select v -> 0 -> 'subScores' -> 0 from got where name = 'prog'), '{"key": "stance", "displayScore": 70}'::jsonb,
  'progress: display sub-scores only');
select ok((select not (v -> 0 ? 'overallScore') and v::text not like '%66.3%' from got where name = 'prog'),
  'progress: exact scores never leave the server');
select is(jsonb_array_length(public.get_progress('badminton')), 3, 'progress: all self badminton skills');
select is(jsonb_array_length(public.get_progress('pickleball')), 0, 'progress: other sport is empty');
select throws_ok($$select public.get_progress('tennis')$$, 'PT422', 'invalid_payload', 'progress: unknown sport');

-- Trial counts as full; grace (expires_at already coalesced) too; expired → free again ---------------------------------
select tests.logout();
select tests.set_entitlement((select id from ids where name = 'u'), 'trial', now() + interval '1 hour');
select tests.login_as((select id from ids where name = 'u'));
select is(public.get_result((select id from ids where name = 'r1')) ->> 'access', 'full', 'trial: access = full');
select tests.logout();
select tests.set_entitlement((select id from ids where name = 'u'), 'premium', now() - interval '1 second');
select tests.login_as((select id from ids where name = 'u'));
select is(public.get_result((select id from ids where name = 'r2')) ->> 'access', 'free', 'expired premium: access = free');
select throws_ok(format($$select public.get_result(%L)$$, (select id from ids where name = 'r1')), 'PT403',
  'forbidden', 'expired premium: older results lock again');

-- Anonymous visitors (no session) -----------------------------------------------------------------------------------------
select tests.login_anon();
select throws_ok(format($$select public.get_result(%L)$$, (select id from ids where name = 'r1')), '42501', null,
  'anon cannot call get_result');
select tests.logout();

select * from finish();
rollback;
