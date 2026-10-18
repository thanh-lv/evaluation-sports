-- Schema shape, function hygiene, client privileges and seed values (DESIGN.md §6.5, §8.1, §9.3, D21).
begin;
\ir _helpers.psql
select plan(28);

-- Tables -----------------------------------------------------------------------------------------------------------
select has_table('public', t, format('public.%s exists', t))
from unnest(array['profiles', 'analyses', 'analysis_results', 'feedback', 'plan_limits', 'model_routes',
  'entitlements', 'app_store_subscriptions', 'usage_counters', 'quota_ledger', 'events', 'app_config',
  'enabled_skills']) t;

select is(
  (select count(*)::int from pg_tables where schemaname = 'private'),
  9, 'private schema has its 9 tables');

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
