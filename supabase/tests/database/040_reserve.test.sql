-- private.reserve_for_submit: quota limits, kinds, first-ever bonus, in-flight, idempotency, ownership and the
-- period keys (ICT month boundary, trial, premium windows). DESIGN.md §6.5, §9.3, D18. Concurrency: tests/sql.
begin;
\ir _helpers.psql
select plan(51);

create temp table ids (name text primary key, id uuid) on commit drop;
create temp table r (name text primary key, v jsonb) on commit drop;

-- Period keys (pure) ---------------------------------------------------------------------------------------------------
select is((select period_key from private.period_window('free', '2026-10-31 16:59:59+00')), '2026-10',
  'free: 23:59:59 ICT on Oct 31 is still October');
select is((select period_key from private.period_window('free', '2026-10-31 17:00:00+00')), '2026-11',
  'free: 00:00 ICT on Nov 1 (17:00 UTC Oct 31) is November');
select is((select private.ict_iso(resets_at) from private.period_window('free', '2026-10-31 16:59:59+00')),
  '2026-11-01T00:00:00+07:00', 'free: October resets at Nov 1 00:00 ICT');
select is((select private.ict_iso(resets_at) from private.period_window('free', '2026-12-31 17:30:00+00')),
  '2027-02-01T00:00:00+07:00', 'free: Jan 1 00:30 ICT belongs to January (year rollover)');
select is((select row(period_key, resets_at)::text from private.period_window('trial', now(), 'tx9')),
  '(trial:tx9,)', 'trial: one key per original transaction, no reset');
select is(
  (select period_key || ' ' || private.ict_iso(resets_at)
   from private.period_window('premium', '2026-02-28 12:00+07', 'tx', '2026-01-31 10:00+07')),
  'sub:tx:2026-02-28 2026-03-31T10:00:00+07:00', 'premium: a Jan 31 anchor gives a Feb 28 window ending Mar 31');
select is(
  (select period_key from private.period_window('premium', '2026-03-31 09:59+07', 'tx', '2026-01-31 10:00+07')),
  'sub:tx:2026-02-28', 'premium: still the Feb window one minute before the anchor time on Mar 31');
select is(
  (select period_key from private.period_window('premium', '2026-03-31 10:00+07', 'tx', '2026-01-31 10:00+07')),
  'sub:tx:2026-03-31', 'premium: the Mar window starts at the anchor time');
select is(
  (select period_key from private.period_window('premium', '2026-01-31 03:00+00', 'tx', '2026-01-31 10:00+07')),
  'sub:tx:2026-01-31', 'premium: the first window starts at the purchase instant');
select is(
  (select period_key from private.period_window('premium', '2026-01-01 00:00+07', 'tx', '2026-01-31 10:00+07')),
  'sub:tx:2026-01-31', 'premium: an anchor in the future clamps to the first window');
select is(
  (select string_agg(period_key || ' ' || private.ict_iso(resets_at), ', ')
   from (values ('2026-03-01 00:00+07'::timestamptz), ('2026-03-20 12:00+07'), ('2026-03-31 23:59+07')) t(at),
     private.period_window('premium', t.at, 'tx', null)),
  'sub:tx:2026-03-01 2026-04-01T00:00:00+07:00, sub:tx:2026-03-01 2026-04-01T00:00:00+07:00, '
    || 'sub:tx:2026-03-01 2026-04-01T00:00:00+07:00',
  'premium without an anchor: stable ICT calendar-month windows (never a new window per call)');
select is((select period_key from private.period_window('premium', '2026-03-31 17:00+00', 'tx', null)),
  'sub:tx:2026-04-01', 'premium without an anchor: the window turns at ICT midnight');
select is((select period_key from private.period_window('free', '2026-02-28 16:59:59.999+00')), '2026-02',
  'free: the last millisecond of February (ICT) is still February');

-- Free user without the DeviceCheck bonus ----------------------------------------------------------------------------
insert into ids values ('f', tests.create_user('free@example.com'));
insert into ids select 'f1', tests.make_analysis((select id from ids where name = 'f'));
insert into ids select 'f2', tests.make_analysis((select id from ids where name = 'f'));
insert into ids select 'f3', tests.make_analysis((select id from ids where name = 'f'));

insert into r select 'f1', private.reserve_for_submit((select id from ids where name = 'f'),
  (select id from ids where name = 'f1'), false);
select is((select v ->> 'ok' from r where name = 'f1'), 'true', 'free: first submit is accepted');
select is((select v ->> 'kind' from r where name = 'f1'), 'basic', 'free: without the bonus the kind is basic');
select is((select (v ->> 'remaining')::int from r where name = 'f1'), 1, 'free: 1 of 2 remaining');
select is((select v ->> 'period_key' from r where name = 'f1'),
  to_char(now() at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM'), 'free: period key is the ICT month');
select is((select v ->> 'resets_at' from r where name = 'f1'),
  to_char(date_trunc('month', now() at time zone 'Asia/Ho_Chi_Minh') + interval '1 month',
    'YYYY-MM-DD"T"HH24:MI:SS') || '+07:00', 'free: resets at the next ICT month start');
select is((select status || '/' || kind from public.analyses where id = (select id from ids where name = 'f1')),
  'queued/basic', 'analysis is queued with its kind');
select is((select state from public.quota_ledger where analysis_id = (select id from ids where name = 'f1')),
  'reserved', 'ledger row is reserved');

-- idempotent re-submit
insert into r select 'f1b', private.reserve_for_submit((select id from ids where name = 'f'),
  (select id from ids where name = 'f1'), true);
select is((select (v ->> 'idempotent')::boolean and (v ->> 'ok')::boolean from r where name = 'f1b'), true,
  'a repeated submit is idempotent');
select is((select used from public.usage_counters where user_id = (select id from ids where name = 'f')
  and period_key <> 'lifetime'), 1, 'an idempotent submit does not count twice');

-- in-flight
select is(private.reserve_for_submit((select id from ids where name = 'f'), (select id from ids where name = 'f2'), false)
  ->> 'code', 'in_flight', 'a second submit while one is queued is refused (in_flight)');
select is((select status from public.analyses where id = (select id from ids where name = 'f2')), 'prepared',
  'the refused analysis stays prepared');

update public.analyses set status = 'succeeded' where id = (select id from ids where name = 'f1');
select is(private.reserve_for_submit((select id from ids where name = 'f'), (select id from ids where name = 'f2'), true)
  ->> 'kind', 'basic', 'free: the bonus is not available once an analysis was used');
update public.analyses set status = 'succeeded' where id = (select id from ids where name = 'f2');

insert into r select 'f3', private.reserve_for_submit((select id from ids where name = 'f'),
  (select id from ids where name = 'f3'), false);
select is((select v ->> 'code' from r where name = 'f3'), 'quota_exceeded', 'free: the third submit in a month is refused');
select is((select (v ->> 'limit')::int || '/' || (v ->> 'used')::int from r where name = 'f3'), '2/2',
  'quota_exceeded carries limit and used');
select is((select count(*)::int from public.quota_ledger where user_id = (select id from ids where name = 'f')), 2,
  'no ledger row for the refused submit');

-- ownership and status
insert into ids values ('other', tests.create_user());
select is(private.reserve_for_submit((select id from ids where name = 'other'), (select id from ids where name = 'f3'), false)
  ->> 'code', 'analysis_not_found', 'another user''s analysis is not found');
select is(private.reserve_for_submit((select id from ids where name = 'other'), gen_random_uuid(), false) ->> 'code',
  'analysis_not_found', 'an unknown analysis is not found');
update public.analyses set status = 'rejected' where id = (select id from ids where name = 'f3');
select is(private.reserve_for_submit((select id from ids where name = 'f'), (select id from ids where name = 'f3'), false)
  ->> 'code', 'analysis_conflict', 'a rejected analysis cannot be submitted');

-- Free user with the first-ever bonus ---------------------------------------------------------------------------------
insert into ids values ('b', tests.create_user());
insert into ids select 'b1', tests.make_analysis((select id from ids where name = 'b'));
insert into ids select 'b2', tests.make_analysis((select id from ids where name = 'b'), 'prepared', 'pb.dink');
select tests.login_as((select id from ids where name = 'b'));
select is((my_status() ->> 'bonusAvailable')::boolean, true, 'my_status: bonus available before the first analysis');
select is(my_status() ->> 'nextKind', 'standard', 'my_status: next kind is standard while the bonus is available');
select tests.logout();
insert into r select 'b1', private.reserve_for_submit((select id from ids where name = 'b'),
  (select id from ids where name = 'b1'), true);
select is((select v ->> 'kind' from r where name = 'b1'), 'standard', 'free: first-ever analysis with DeviceCheck is standard');
select is((select (v ->> 'remaining')::int from r where name = 'b1'), 1, 'free: the bonus counts toward the 2');
select is((select bonus_used from public.usage_counters where user_id = (select id from ids where name = 'b')
  and period_key = 'lifetime'), true, 'lifetime counter records the bonus');
update public.analyses set status = 'succeeded' where id = (select id from ids where name = 'b1');
select is(private.reserve_for_submit((select id from ids where name = 'b'), (select id from ids where name = 'b2'), true)
  ->> 'kind', 'basic', 'free: the bonus is used once');
select tests.login_as((select id from ids where name = 'b'));
select is((my_status() ->> 'bonusAvailable')::boolean, false, 'my_status: bonus gone after use');
select is((my_status() ->> 'remaining')::int, 0, 'my_status: nothing remaining');
select tests.logout();

-- Free user with the bonus but no DeviceCheck token: basic, bonus kept
insert into ids values ('nd', tests.create_user());
insert into ids select 'nd1', tests.make_analysis((select id from ids where name = 'nd'));
select is(private.reserve_for_submit((select id from ids where name = 'nd'), (select id from ids where name = 'nd1'), false)
  ->> 'kind', 'basic', 'free: no DeviceCheck → basic');

-- Trial: 10 total, first 5 standard --------------------------------------------------------------------------------------
insert into ids values ('t', tests.create_user());
select tests.set_entitlement((select id from ids where name = 't'), 'trial', now() + interval '5 days', 'tx-trial');
insert into public.usage_counters (user_id, period_key, used, used_standard)
select id, 'trial:tx-trial', 4, 4 from ids where name = 't';
insert into ids select 't1', tests.make_analysis((select id from ids where name = 't'));
insert into ids select 't2', tests.make_analysis((select id from ids where name = 't'));
insert into ids select 't3', tests.make_analysis((select id from ids where name = 't'));
insert into r select 't1', private.reserve_for_submit((select id from ids where name = 't'),
  (select id from ids where name = 't1'), false);
select is((select v ->> 'kind' || '/' || (v ->> 'tier') from r where name = 't1'), 'standard/trial',
  'trial: the 5th analysis is standard');
select is((select v -> 'resets_at' from r where name = 't1'), 'null'::jsonb, 'trial: no reset date');
select is((select v ->> 'period_key' from r where name = 't1'), 'trial:tx-trial', 'trial: period key per transaction');
update public.analyses set status = 'succeeded' where id = (select id from ids where name = 't1');
select is(private.reserve_for_submit((select id from ids where name = 't'), (select id from ids where name = 't2'), false)
  ->> 'kind', 'basic', 'trial: the 6th analysis is basic');
update public.analyses set status = 'succeeded' where id = (select id from ids where name = 't2');
update public.usage_counters set used = 10 where period_key = 'trial:tx-trial';
select is(private.reserve_for_submit((select id from ids where name = 't'), (select id from ids where name = 't3'), false)
  ->> 'code', 'quota_exceeded', 'trial: 10 in total');

-- Premium: 15 standard per subscription month ---------------------------------------------------------------------------
insert into ids values ('p', tests.create_user());
select tests.set_entitlement((select id from ids where name = 'p'), 'premium', now() + interval '300 days', 'tx-prem',
  now() - interval '40 days');
insert into ids select 'p1', tests.make_analysis((select id from ids where name = 'p'));
insert into ids select 'p2', tests.make_analysis((select id from ids where name = 'p'));
insert into r select 'p1', private.reserve_for_submit((select id from ids where name = 'p'),
  (select id from ids where name = 'p1'), false);
select is((select v ->> 'kind' || '/' || (v ->> 'tier') || '/' || (v ->> 'remaining') from r where name = 'p1'),
  'standard/premium/14', 'premium: standard, 14 remaining');
select is((select v ->> 'period_key' from r where name = 'p1'),
  (select period_key from private.period_window('premium', now(), 'tx-prem', now() - interval '40 days')),
  'premium: window key anchored on the purchase');
select ok((select v ->> 'period_key' from r where name = 'p1') like 'sub:tx-prem:%', 'premium: key is sub:<origTx>:<date>');
select is((select v ->> 'resets_at' from r where name = 'p1'),
  private.ict_iso(((now() - interval '40 days') at time zone 'Asia/Ho_Chi_Minh' + interval '2 months')
    at time zone 'Asia/Ho_Chi_Minh'),
  'premium: resets one subscription month after the current window start');
update public.analyses set status = 'succeeded' where id = (select id from ids where name = 'p1');
update public.usage_counters set used = 15, used_standard = 15
where user_id = (select id from ids where name = 'p') and period_key like 'sub:%';
select is(private.reserve_for_submit((select id from ids where name = 'p'), (select id from ids where name = 'p2'), false)
  ->> 'code', 'quota_exceeded', 'premium: 15 per subscription month');

-- Expired premium falls back to free counting
update public.entitlements set expires_at = now() - interval '1 minute'
where user_id = (select id from ids where name = 'p');
select is(
  private.reserve_for_submit((select id from ids where name = 'p'), (select id from ids where name = 'p2'), false)
    ->> 'period_key',
  to_char(now() at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM'), 'expired premium counts against the free month');

select * from finish();
rollback;
