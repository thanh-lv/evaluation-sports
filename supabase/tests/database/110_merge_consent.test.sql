-- private.merge_anonymous_account (account-merge, DESIGN.md §6.1) and private.consent_current (submit step 2).
begin;
\ir _helpers.psql
select plan(19);

create temp table ids (name text primary key, id uuid) on commit drop;
create temp table r (name text primary key, v jsonb) on commit drop;
insert into ids values ('anon', tests.create_user(null, true)), ('perm', tests.create_user('perm@example.com'));
insert into ids select 'a1', tests.add_result((select id from ids where name = 'anon'));
insert into public.feedback (analysis_id, user_id, rating) select a.id, u.id, 1 from ids a, ids u
where a.name = 'a1' and u.name = 'anon';
insert into public.events (user_id, name) select id, 'app_open' from ids, generate_series(1, 3) where name = 'anon';
insert into public.usage_counters (user_id, period_key, used, used_standard, bonus_used)
select id, '2026-10', 1, 1, false from ids where name = 'anon'
union all select id, 'lifetime', 1, 1, true from ids where name = 'anon'
union all select id, '2026-10', 2, 0, false from ids where name = 'perm';
insert into public.app_store_subscriptions (original_transaction_id, user_id, app_account_token, environment,
  product_id, status, expires_at)
select 'tx-anon', id, id, 'Production', 'premium.monthly', 1, now() + interval '20 days' from ids where name = 'anon';
select private.recompute_entitlement((select id from ids where name = 'anon'));

insert into r select 'm1', private.merge_anonymous_account((select id from ids where name = 'anon'),
  (select id from ids where name = 'perm'));
select is((select v - 'events' - 'counters' from r where name = 'm1'),
  '{"merged": true, "analyses": 1, "subscriptions": ["tx-anon"]}'::jsonb, 'merge reports what moved');
select is((select user_id from public.analyses where id = (select id from ids where name = 'a1')),
  (select id from ids where name = 'perm'), 'analysis moved');
select ok((select pose_clean_path like (select id from ids where name = 'perm')::text || '/%' from public.analyses
  where id = (select id from ids where name = 'a1')), 'pose paths point at the new folder');
select is((select user_id from public.analysis_results where analysis_id = (select id from ids where name = 'a1')),
  (select id from ids where name = 'perm'), 'result moved');
select is((select user_id from public.feedback where analysis_id = (select id from ids where name = 'a1')),
  (select id from ids where name = 'perm'), 'feedback moved');
select is((select count(*)::int from public.events where user_id = (select id from ids where name = 'perm')), 3,
  'events moved');
select is((select used || '/' || used_standard from public.usage_counters
  where user_id = (select id from ids where name = 'perm') and period_key = '2026-10'), '2/1',
  'monthly counters summed and capped at the free limit');
select is((select bonus_used from public.usage_counters
  where user_id = (select id from ids where name = 'perm') and period_key = 'lifetime'), true, 'bonus flag is OR-ed');
select is((select count(*)::int from public.usage_counters where user_id = (select id from ids where name = 'anon')),
  0, 'no counters left on the anonymous account');
select is((select user_id::text || app_account_token::text from public.app_store_subscriptions
  where original_transaction_id = 'tx-anon'),
  (select id::text || id::text from ids where name = 'perm'), 'subscription re-linked with a new appAccountToken');
select is(private.tier_of((select id from ids where name = 'perm')), 'premium', 'target recomputed to premium');
select is(private.tier_of((select id from ids where name = 'anon')), 'free', 'source recomputed to free');
select is((select count(*)::int from private.audit_log where action = 'account_merge'
  and subject = (select id::text from ids where name = 'perm')), 1, 'merge audited');

select is(private.merge_anonymous_account((select id from ids where name = 'anon'),
  (select id from ids where name = 'perm')) - 'counters' - 'events',
  '{"merged": true, "analyses": 0, "subscriptions": []}'::jsonb, 'a re-run is a no-op');
select is(private.merge_anonymous_account((select id from ids where name = 'perm'),
  (select id from ids where name = 'anon')) ->> 'code', 'forbidden', 'only anonymous accounts can be merged away');
select is(private.merge_anonymous_account(gen_random_uuid(), (select id from ids where name = 'perm')) ->> 'code',
  'not_found', 'unknown source');

-- consent_current ---------------------------------------------------------------------------------------------------------
select is(private.consent_current((select id from ids where name = 'perm')), false, 'no consent yet');
update public.profiles set pdpl_consent_version = '2026-10-01', ai_consent_version = '2026-10-01'
where id = (select id from ids where name = 'perm');
select is(private.consent_current((select id from ids where name = 'perm')), true, 'both consents current');
update public.app_config set value = '{"pdpl": "2026-10-01", "ai": "2027-01-01"}' where key = 'consent_versions';
select is(private.consent_current((select id from ids where name = 'perm')), false,
  'a new AI consent version requires consent again');

select * from finish();
rollback;
