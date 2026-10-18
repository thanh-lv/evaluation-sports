-- log_event: allowlist, props size, 300 per user per ICT day; events not readable by clients (DESIGN.md §6.5, D22).
begin;
\ir _helpers.psql
select plan(11);

create temp table ids (name text primary key, id uuid) on commit drop;
grant all on ids to anon, authenticated;
insert into ids values ('u', tests.create_user()), ('v', tests.create_user());

select tests.login_as((select id from ids where name = 'u'));
select is(public.log_event('app_open', '{"lang": "vi"}'), true, 'an allowlisted event is stored');
select is(public.log_event('paywall_viewed'), true, 'props default to {}');
select throws_ok($$select public.log_event('drop_table_users', '{}')$$, 'PT422', 'invalid_payload',
  'unknown event names are refused');
select throws_ok($$select public.log_event(null, '{}')$$, 'PT422', 'invalid_payload', 'a null name is refused');
select throws_ok($$select public.log_event('app_open', '[1, 2]')$$, 'PT422', 'invalid_payload', 'props must be an object');
select throws_ok(format($$select public.log_event('app_open', '{"x": "%s"}')$$, repeat('a', 2100)), 'PT422',
  'invalid_payload', 'props over 2 KB are refused');
select throws_ok($$select id from public.events$$, '42501', null, 'clients cannot read events');
select tests.logout();

-- Daily cap: 300 client events per user per ICT day; yesterday's and server events do not count
insert into public.events (user_id, name, created_at)
select id, 'app_open', now() - interval '2 days' from ids, generate_series(1, 400) where name = 'u';
insert into public.events (user_id, name, source) select id, 'analysis_failed', 'server' from ids where name = 'u';
insert into public.events (user_id, name) select id, 'app_open' from ids, generate_series(1, 297) where name = 'u';
select tests.login_as((select id from ids where name = 'u'));
select is(public.log_event('result_viewed'), true, 'the 300th event of the day is stored');
select is(public.log_event('result_viewed'), false, 'the 301st event is dropped (false, no error)');
select tests.login_as((select id from ids where name = 'v'));
select is(public.log_event('result_viewed'), true, 'the cap is per user');
select tests.logout();
select is((select count(*)::int from public.events e join ids on ids.id = e.user_id
  where ids.name = 'u' and e.created_at >= date_trunc('day', now() at time zone 'Asia/Ho_Chi_Minh')
    at time zone 'Asia/Ho_Chi_Minh' and e.source = 'client'), 300, 'exactly 300 client events today');

select * from finish();
rollback;
