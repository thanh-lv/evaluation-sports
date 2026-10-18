-- Account deletion cascades (DESIGN.md §6.1 delete-account step 5) and cron jobs that are no-ops without Vault secrets
-- (§6.5 cron migration, D12).
begin;
\ir _helpers.psql
select plan(17);

create temp table ids (name text primary key, id uuid) on commit drop;

-- Cascades -----------------------------------------------------------------------------------------------------------------
insert into ids values ('u', tests.create_user('gone@example.com')), ('keep', tests.create_user());
insert into ids select 'a', tests.add_result((select id from ids where name = 'u'));
insert into ids select 'p', tests.make_analysis((select id from ids where name = 'u'));
select private.reserve_for_submit((select id from ids where name = 'u'), (select id from ids where name = 'p'), false);
insert into ids select 'k', tests.add_result((select id from ids where name = 'keep'));
insert into public.feedback (analysis_id, user_id, rating) select a.id, u.id, 1 from ids a, ids u
where a.name = 'a' and u.name = 'u';
insert into public.events (user_id, name) select id, 'app_open' from ids where name = 'u';
select tests.set_entitlement((select id from ids where name = 'u'), 'premium', now() + interval '3 days');
insert into public.app_store_subscriptions (original_transaction_id, user_id, app_account_token, environment, product_id,
  status, expires_at)
select 'tx-del', id, id, 'Production', 'premium.monthly', 1, now() + interval '3 days' from ids where name = 'u';
insert into private.apple_auth_tokens (user_id, ciphertext) select id, 'x' from ids where name = 'u';
select private.record_llm_cost((select id from ids where name = 'u'), 0.05);

delete from auth.users where id = (select id from ids where name = 'u');

select is((select count(*)::int from public.profiles where id = (select id from ids where name = 'u')), 0,
  'profile deleted with the auth user');
select is((select count(*)::int from public.analyses where user_id = (select id from ids where name = 'u')), 0,
  'analyses cascade');
select is((select count(*)::int from public.analysis_results where analysis_id in (select id from ids where name in ('a', 'p'))),
  0, 'results cascade');
select is((select count(*)::int from public.feedback where user_id = (select id from ids where name = 'u')), 0,
  'feedback cascades');
select is((select count(*)::int from public.usage_counters where user_id = (select id from ids where name = 'u')), 0,
  'usage counters cascade');
select is((select count(*)::int from public.quota_ledger where user_id = (select id from ids where name = 'u')), 0,
  'ledger cascades');
select is((select count(*)::int from public.entitlements where user_id = (select id from ids where name = 'u')), 0,
  'entitlement cascades');
select is((select count(*)::int from public.events where user_id = (select id from ids where name = 'u')), 0,
  'events cascade');
select is((select count(*)::int from private.apple_auth_tokens where user_id = (select id from ids where name = 'u')),
  0, 'SIWA token cascades');
select is((select count(*)::int from private.user_monthly_cost where user_id = (select id from ids where name = 'u')),
  0, 'per-user cost cascades');
select is((select user_id from public.app_store_subscriptions where original_transaction_id = 'tx-del'), null,
  'subscription survives with user_id set null');
select is((select count(*)::int from public.analysis_results where analysis_id = (select id from ids where name = 'k')),
  1, 'other users are untouched');

-- Cron: no-ops without Vault secrets -----------------------------------------------------------------------------------------
delete from vault.secrets where name in ('project_url', 'cron_secret', 'internal_secret');
insert into ids select 'due', tests.make_analysis((select id from ids where name = 'keep'));
update public.analyses set status = 'queued', next_attempt_at = now() - interval '1 minute'
where id = (select id from ids where name = 'due');

select is(private.dispatch_due_jobs(5), 0, 'dispatch_due_jobs is a no-op without vault secrets');
select is(private.call_cron_task('daily'), null, 'call_cron_task is a no-op without vault secrets');
select results_eq(
  $$select jobname::text, schedule::text, command::text from cron.job where jobname like 'racketcoach-%' order by jobname$$,
  $$values ('racketcoach-daily'::text, '17 20 * * *'::text, 'select private.call_cron_task(''daily'')'::text),
           ('racketcoach-dispatch-jobs', '* * * * *', 'select private.dispatch_due_jobs(5)')$$,
  'cron jobs are scheduled');

-- With secrets, one pg_net request per due job (rolled back before pg_net sends anything)
select vault.create_secret('http://127.0.0.1:9', 'project_url');
select vault.create_secret('test-internal-secret', 'internal_secret');
select ok(private.dispatch_due_jobs(100) >= 1, 'with vault secrets the dispatcher queues requests');
select ok(exists (select 1 from net.http_request_queue q
  where q.url = 'http://127.0.0.1:9/functions/v1/analyze/run'
    and convert_from(q.body, 'utf8')::jsonb ->> 'analysisId' = (select id::text from ids where name = 'due')
    and q.headers ->> 'x-internal-secret' = 'test-internal-secret'),
  'one POST /analyze/run per due job with x-internal-secret');

select * from finish();
rollback;
