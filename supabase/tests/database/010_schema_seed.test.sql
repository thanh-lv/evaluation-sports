-- Schema shape, function hygiene, client privileges and seed values (DESIGN.md §6.5, §8.1, §9.3, D21).
begin;
\ir _helpers.psql
select plan(33);

-- Tables -----------------------------------------------------------------------------------------------------------
select has_table('public', t, format('public.%s exists', t))
from unnest(array['profiles', 'analyses', 'analysis_results', 'feedback', 'plan_limits', 'model_routes',
  'entitlements', 'app_store_subscriptions', 'usage_counters', 'quota_ledger', 'events', 'app_config',
  'enabled_skills']) t;

select is(
  (select count(*)::int from pg_tables where schemaname = 'private'),
  10, 'private schema has its 10 tables (rate_limits from migration 1100)');

select is(
  (select array_agg(n.nspname || '.' || c.relname order by n.nspname || '.' || c.relname)
   from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'private') and c.relkind = 'r' and not c.relrowsecurity),
  null, 'RLS is enabled on every public and private table');

select is(
  (select array_agg(n.nspname || '.' || p.proname order by n.nspname || '.' || p.proname)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private')
     and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
     and not (p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=""'])),
  null, 'every public/private function is SECURITY DEFINER with search_path = ''''');

-- Client privileges --------------------------------------------------------------------------------------------------
select is(
  (select array_agg(p.proname::text order by p.proname::text)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
     and has_function_privilege('authenticated', p.oid, 'execute')),
  array['get_history', 'get_progress', 'get_result', 'log_event', 'my_status'],
  'authenticated may execute exactly the client RPCs');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private')
     and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
     and has_function_privilege('anon', p.oid, 'execute')),
  0, 'anon may execute no public/private function');

select ok(
  not has_schema_privilege('authenticated', 'private', 'usage')
  and not has_schema_privilege('anon', 'private', 'usage')
  and has_schema_privilege('service_role', 'private', 'usage'),
  'only service_role may use the private schema');

select is(
  (select array_agg(c.relname::text order by c.relname::text) from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
     and (has_table_privilege('anon', c.oid, 'select') or has_any_column_privilege('anon', c.oid, 'select'))),
  array['app_config', 'enabled_skills', 'plan_limits'],
  'anon can read only the public config tables');

select is(
  (select array_agg(c.relname::text order by c.relname::text) from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
     and (has_table_privilege('authenticated', c.oid, 'insert') or has_table_privilege('authenticated', c.oid, 'update')
       or has_any_column_privilege('authenticated', c.oid, 'insert')
       or has_any_column_privilege('authenticated', c.oid, 'update'))),
  array['feedback', 'profiles'],
  'authenticated can write only feedback (insert) and profiles (update)');

select is(
  (select array_agg(n.nspname || '.' || c.relname order by n.nspname || '.' || c.relname)
   from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'private') and c.relkind in ('r', 'v', 'm')
     and (has_table_privilege('authenticated', c.oid, 'delete') or has_table_privilege('anon', c.oid, 'delete')
       or has_table_privilege('authenticated', c.oid, 'truncate') or has_table_privilege('anon', c.oid, 'truncate')
       or has_table_privilege('authenticated', c.oid, 'references')
       or has_table_privilege('authenticated', c.oid, 'trigger'))),
  array['public.analyses'],
  'clients may DELETE only analyses (own rows via RLS); no TRUNCATE/REFERENCES/TRIGGER anywhere');

-- Default privileges: a function or table a LATER migration creates must not reach clients by default. (PostgreSQL's
-- EXECUTE-to-PUBLIC default is global; a per-schema ALTER DEFAULT PRIVILEGES cannot revoke it.)
create function public.zz_future_fn() returns int language sql as 'select 1';
create function private.zz_future_fn() returns int language sql as 'select 1';
create table public.zz_future_table (id int);
select ok(
  not has_function_privilege('anon', 'public.zz_future_fn()', 'execute')
  and not has_function_privilege('authenticated', 'public.zz_future_fn()', 'execute')
  and has_function_privilege('service_role', 'public.zz_future_fn()', 'execute'),
  'a new public function is not executable by anon/authenticated by default (service_role keeps it)');
select is(
  (select count(*)::int from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
   where p.oid in ('public.zz_future_fn()'::regprocedure, 'private.zz_future_fn()'::regprocedure)
     and a.grantee = 0 and a.privilege_type = 'EXECUTE'),
  0, 'new functions in public/private carry no EXECUTE for PUBLIC');
select ok(
  not has_table_privilege('anon', 'public.zz_future_table', 'select')
  and not has_table_privilege('authenticated', 'public.zz_future_table', 'select,insert,update,delete'),
  'a new public table is not readable or writable by clients by default');
drop table public.zz_future_table;
drop function public.zz_future_fn();
drop function private.zz_future_fn();

-- Seed values --------------------------------------------------------------------------------------------------------
select results_eq(
  $$select tier, period_type, total_limit, standard_limit, first_ever_standard, max_in_flight, free_retry_limit,
      features
    from public.plan_limits order by tier$$,
  $$values
    ('free'::text, 'calendar_month'::text, 2, 0, true, 1, 3,
      '{"full_report": false, "progress": false, "player": false, "history_full_limit": 3}'::jsonb),
    ('premium', 'subscription_month', 15, 15, false, 1, 3,
      '{"full_report": true, "progress": true, "player": true, "history_full_limit": null}'),
    ('trial', 'trial', 10, 5, false, 1, 3,
      '{"full_report": true, "progress": true, "player": true, "history_full_limit": null}')$$,
  'plan_limits seed matches §9.3');

select results_eq(
  $$select kind, model, effort, max_tokens, timeout_ms, fallbacks from public.model_routes order by kind$$,
  $$values ('basic'::text, 'claude-haiku-5-5'::text, 'medium'::text, 12000, 90000, null::text),
           ('standard', 'claude-sonnet-5-5', 'low', 12000, 180000, 'default')$$,
  'model_routes seed matches §8.1');

select is((select value from public.app_config where key = 'min_user_age'), '18'::jsonb, 'min_user_age = 18 (D21)');
select is((select value from public.app_config where key = 'budget_usd'), '30'::jsonb, 'budget_usd = 30 (§8.7)');
select is(
  (select jsonb_object_agg(key, value) from public.app_config
   where key in ('budget_alert_ratio', 'budget_hard_cap_mult', 'event_daily_limit', 'event_props_max_bytes')),
  '{"budget_alert_ratio": 0.7, "budget_hard_cap_mult": 2, "event_daily_limit": 300, "event_props_max_bytes": 2048}'::jsonb,
  'budget guard (70 %, 2x hard cap, §8.7) and log_event limits (300/day, 2 KB, §6.5)');
select ok(
  (select value ? 'pdpl' and value ? 'ai' from public.app_config where key = 'consent_versions'),
  'consent_versions has pdpl and ai');

select results_eq(
  $$select skill from public.enabled_skills where enabled order by skill$$,
  $$values ('bd.clear_fh'::text), ('bd.serve_low'), ('bd.smash'), ('pb.dink'), ('pb.drop3'), ('pb.serve')$$,
  'the 6 launch skills are enabled');

select results_eq(
  $$select skill from public.enabled_skills where not enabled order by skill$$,
  $$values ('bd.lift'::text), ('bd.net_shot'), ('bd.serve_high'), ('pb.drive'), ('pb.return'), ('pb.volley')$$,
  'the 6 deferred skills are disabled');

select * from finish();
rollback;
