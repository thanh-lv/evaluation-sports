-- Job lifecycle: claim/finalize/requeue/fail fencing, refund rules and the retry cap, ownership-safe prepare upsert
-- (DESIGN.md D12, §6.1, §6.5, §8.3).
begin;
\ir _helpers.psql
select plan(44);

create temp table ids (name text primary key, id uuid) on commit drop;

-- Fencing ---------------------------------------------------------------------------------------------------------------
insert into ids values ('u', tests.create_user());
insert into ids select 'a', tests.make_analysis((select id from ids where name = 'u'));
select private.reserve_for_submit((select id from ids where name = 'u'), (select id from ids where name = 'a'), false);

select is(private.claim_analysis((select id from ids where name = 'a')), 1, 'claim → attempt 1');
select is(private.claim_analysis((select id from ids where name = 'a')), null, 'a second claim gets nothing');
select is(private.claim_analysis(gen_random_uuid()), null, 'claiming an unknown job gets nothing');
select is(private.requeue_analysis((select id from ids where name = 'a'), 1, 0, 'upstream_529'), true,
  'requeue with the current attempt applies');
select is((select status || '/' || last_error_code from public.analyses where id = (select id from ids where name = 'a')),
  'queued/upstream_529', 'requeued with the error code');
select is(private.claim_analysis((select id from ids where name = 'a')), 2, 'claim again → attempt 2');
select is(private.requeue_analysis((select id from ids where name = 'a'), 1, 0, 'stale'), false,
  'requeue with an old attempt is fenced off');
select is(private.requeue_analysis((select id from ids where name = 'a'), 2, 60, 'max_tokens', 1.5), true,
  'requeue with a delay and a max_tokens multiplier');
select is((select max_tokens_mult from public.analyses where id = (select id from ids where name = 'a')), 1.5::real,
  'max_tokens_mult stored');
select is(private.claim_analysis((select id from ids where name = 'a')), null, 'a delayed job is not claimable yet');
update public.analyses set next_attempt_at = now() - interval '1 second' where id = (select id from ids where name = 'a');
select is(private.claim_analysis((select id from ids where name = 'a')), 3, 'due again → attempt 3');
update public.analyses set locked_at = now() - interval '7 minutes' where id = (select id from ids where name = 'a');
select is(private.claim_analysis((select id from ids where name = 'a')), null, 'a 7-minute-old lock is still held');
update public.analyses set locked_at = now() - interval '9 minutes' where id = (select id from ids where name = 'a');
select is(private.claim_analysis((select id from ids where name = 'a')), 4, 'a lock older than 8 minutes is re-claimed');
select is(private.finalize_analysis((select id from ids where name = 'a'), 3,
  tests.sample_result((select id from ids where name = 'a'))), false, 'the stale worker cannot finalize');
select is((select count(*)::int from public.analysis_results where analysis_id = (select id from ids where name = 'a')),
  0, 'no result stored by the fenced-off worker');
select is(private.fail_analysis((select id from ids where name = 'a'), 3, 'internal'), false,
  'the stale worker cannot fail the job');
select is(private.finalize_analysis((select id from ids where name = 'a'), 4,
  tests.sample_result((select id from ids where name = 'a')), 66.2, 'claude-sonnet-5-5'), true,
  'the current worker finalizes');
select is((select status || '/' || coalesce(failure_code, '-') from public.analyses
  where id = (select id from ids where name = 'a')), 'succeeded/-', 'analysis succeeded');
select is((select display_score || '/' || overall_score || '/' || (result ->> 'access')
  from public.analysis_results where analysis_id = (select id from ids where name = 'a')), '65/66.2/full',
  'result stored with display and exact scores');
select is((select state from public.quota_ledger where analysis_id = (select id from ids where name = 'a')),
  'committed', 'quota committed on success');
select is(private.finalize_analysis((select id from ids where name = 'a'), 4,
  tests.sample_result((select id from ids where name = 'a'))), false, 'finalize applies once');
select is(private.claim_analysis((select id from ids where name = 'a')), null, 'a finished job cannot be claimed');

-- Rejected results: refunded 3 times per period, then committed --------------------------------------------------------
insert into ids values ('r', tests.create_user());
create temp table rej (n int primary key, refunded text) on commit drop;
do $$
declare
  v_user uuid := (select id from ids where name = 'r');
  v_aid uuid;
  v_attempt int;
begin
  for i in 1..4 loop
    v_aid := tests.make_analysis(v_user);
    perform private.reserve_for_submit(v_user, v_aid, false);
    v_attempt := private.claim_analysis(v_aid);
    perform private.finalize_analysis(v_aid, v_attempt, tests.sample_result(v_aid, 'rejected'));
    insert into rej values (i, (select state || ':' || coalesce(refund_reason, '') from public.quota_ledger
      where analysis_id = v_aid));
  end loop;
end;
$$;
select results_eq($$select refunded from rej order by n$$,
  $$values ('refunded:rejected'::text), ('refunded:rejected'), ('refunded:rejected'), ('committed:rejected:retry_cap')$$,
  'rejections refund 3 times, the 4th is committed (retry cap)');
select is((select used || '/' || retries_used from public.usage_counters
  where user_id = (select id from ids where name = 'r') and period_key <> 'lifetime'), '1/3',
  'counter: only the capped rejection counts; 3 retries used');
select is((select failure_code from public.analyses where user_id = (select id from ids where name = 'r') limit 1),
  'not_assessable', 'rejected analyses carry the rejection code');
select is((select count(*)::int from public.analysis_results r join public.analyses a on a.id = r.analysis_id
  where a.user_id = (select id from ids where name = 'r') and r.status = 'rejected'), 4, 'rejected results are stored');

-- Partial results refund under the same cap ------------------------------------------------------------------------------
insert into ids values ('q', tests.create_user());
select tests.set_entitlement((select id from ids where name = 'q'), 'premium', now() + interval '20 days', 'tx-q',
  now() - interval '3 days');
insert into ids select 'q1', tests.make_analysis((select id from ids where name = 'q'));
select private.reserve_for_submit((select id from ids where name = 'q'), (select id from ids where name = 'q1'), false);
select private.claim_analysis((select id from ids where name = 'q1'));
select is(private.finalize_analysis((select id from ids where name = 'q1'), 1,
  tests.sample_result((select id from ids where name = 'q1'), 'succeeded', true)), true, 'partial result finalized');
select is((select state || ':' || refund_reason from public.quota_ledger
  where analysis_id = (select id from ids where name = 'q1')), 'refunded:partial', 'a partial result is refunded');
select is((select used || '/' || used_standard || '/' || retries_used from public.usage_counters
  where user_id = (select id from ids where name = 'q') and period_key like 'sub:%'), '0/0/1',
  'partial refund uses one retry and returns the standard slot');
select is((select partial from public.analysis_results where analysis_id = (select id from ids where name = 'q1')), true,
  'partial flag stored');

-- Terminal failures always refund in full, give the bonus back and use no retry -----------------------------------------
insert into ids values ('b', tests.create_user());
insert into ids select 'b1', tests.make_analysis((select id from ids where name = 'b'));
select is(private.reserve_for_submit((select id from ids where name = 'b'), (select id from ids where name = 'b1'), true)
  ->> 'kind', 'standard', 'bonus reservation');
select private.claim_analysis((select id from ids where name = 'b1'));
select is(private.fail_analysis((select id from ids where name = 'b1'), 1, 'model_refusal'), true, 'fail applies');
select is((select status || '/' || failure_code from public.analyses where id = (select id from ids where name = 'b1')),
  'failed/model_refusal', 'analysis failed with the code');
select is((select state || ':' || refund_reason from public.quota_ledger
  where analysis_id = (select id from ids where name = 'b1')), 'refunded:model_refusal', 'refusal is refunded');
select is((select string_agg(period_key || '=' || used || '/' || retries_used || '/' || bonus_used, ' ' order by period_key)
  from public.usage_counters where user_id = (select id from ids where name = 'b')),
  to_char(now() at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM') || '=0/0/false lifetime=0/0/false',
  'counters restored, bonus given back, no retry used');
select is(private.refund_quota((select id from ids where name = 'b1'), 'internal') ->> 'code', 'already_refunded',
  'refund is idempotent');
select is(private.fail_analysis((select id from ids where name = 'b1'), 1, 'internal'), false, 'fail applies once');
select is(private.refund_quota(gen_random_uuid(), 'internal') ->> 'code', 'not_found', 'refund of an unknown id');

-- Ownership-safe prepare upsert ----------------------------------------------------------------------------------------
insert into ids values ('o', tests.create_user()), ('x', gen_random_uuid());
select is(private.upsert_prepared_analysis((select id from ids where name = 'o'), (select id from ids where name = 'x'),
  '{"sport": "badminton", "skill": "bd.smash", "camera_view": "auto", "prepared": {"strokes": []},
    "pose_raw_path": "p/raw", "pose_clean_path": "p/clean", "analysis_hz": 60, "frame_count": 5}'), true,
  'prepare inserts a new analysis');
select is(private.upsert_prepared_analysis((select id from ids where name = 'o'), (select id from ids where name = 'x'),
  '{"view_confirmed": "behind", "excluded_strokes": [2], "prepared": {"strokes": [1]}}'), true,
  'reprepare updates the same user''s analysis');
select is((select sport || '/' || skill || '/' || view_confirmed || '/' || excluded_strokes::text || '/' || analysis_hz
  || '/' || (prepared ->> 'strokes') from public.analyses where id = (select id from ids where name = 'x')),
  'badminton/bd.smash/behind/{2}/60/[1]', 'reprepare keeps unspecified fields');
select is(private.upsert_prepared_analysis((select id from ids where name = 'u'), (select id from ids where name = 'x'),
  '{"sport": "pickleball", "skill": "pb.dink"}'), false, 'another user cannot overwrite the id (409)');
select is(private.upsert_prepared_analysis((select id from ids where name = 'o'), (select id from ids where name = 'x'),
  '{"status": "rejected", "failure_code": "no_strokes_detected"}'), true, 'a prepare rejection is stored');
select is(private.upsert_prepared_analysis((select id from ids where name = 'u'), (select id from ids where name = 'a'),
  '{"sport": "badminton", "skill": "bd.smash"}'), false, 'a submitted analysis cannot be re-prepared');

select * from finish();
rollback;
