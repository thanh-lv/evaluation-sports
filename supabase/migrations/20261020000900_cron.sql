-- 0900 pg_cron + pg_net jobs (DESIGN.md §6.5 cron migration, D12, §6.6).
--
-- Secrets come from Vault (names: project_url, cron_secret, internal_secret). When a secret is missing the job
-- functions only RAISE NOTICE and return, so `supabase db reset` and fresh projects work before secrets exist.
-- Local example (docs/database.md):
--   select vault.create_secret('http://supabase_kong_racketcoach:8000', 'project_url');  -- Kong, seen from the db container
--   select vault.create_secret('<INTERNAL_SECRET>', 'internal_secret');
--   select vault.create_secret('<CRON_SECRET>', 'cron_secret');

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

-- Vault lookup (null when absent or Vault is unavailable).
create or replace function private.vault_secret(p_name text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_secret text;
begin
  select s.decrypted_secret into v_secret from vault.decrypted_secrets s where s.name = p_name limit 1;
  return nullif(v_secret, '');
exception
  when undefined_table or invalid_schema_name or insufficient_privilege then
    return null;
end;
$$;

-- Due jobs: queued for ≥ 15 s with next_attempt_at reached (the submit's own waitUntil gets the first try), or
-- processing with a lock older than the 8-minute TTL. One pg_net request per job to /functions/v1/analyze/run;
-- claim_analysis() fencing makes duplicate deliveries harmless. Returns the number of requests queued.
create or replace function private.dispatch_due_jobs(p_limit int default 5)
returns int
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_url text := private.vault_secret('project_url');
  v_secret text := private.vault_secret('internal_secret');
  v_job record;
  v_sent int := 0;
begin
  if v_url is null or v_secret is null then
    raise notice 'dispatch_due_jobs: vault secrets project_url/internal_secret missing; nothing dispatched';
    return 0;
  end if;
  for v_job in
    select a.id from public.analyses a
    where (a.status = 'queued' and a.next_attempt_at <= now() - interval '15 seconds')
       or (a.status = 'processing' and a.locked_at < now() - interval '8 minutes')
    order by a.next_attempt_at nulls first
    limit greatest(coalesce(p_limit, 5), 1)
  loop
    perform net.http_post(
      url := rtrim(v_url, '/') || '/functions/v1/analyze/run',
      body := jsonb_build_object('analysisId', v_job.id),
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-internal-secret', v_secret),
      timeout_milliseconds := 5000
    );
    v_sent := v_sent + 1;
  end loop;
  return v_sent;
end;
$$;

-- POST /functions/v1/cron {task} with x-cron-secret (the function answers 202 and works in waitUntil).
-- Returns the pg_net request id, or null when the secrets are missing.
create or replace function private.call_cron_task(p_task text)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_url text := private.vault_secret('project_url');
  v_secret text := private.vault_secret('cron_secret');
  v_request bigint;
begin
  if v_url is null or v_secret is null then
    raise notice 'call_cron_task(%): vault secrets project_url/cron_secret missing; skipped', p_task;
    return null;
  end if;
  select net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/cron',
    body := jsonb_build_object('task', p_task),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret),
    timeout_milliseconds := 5000
  ) into v_request;
  return v_request;
end;
$$;

revoke execute on function private.vault_secret(text) from public, anon, authenticated;
revoke execute on function private.dispatch_due_jobs(int) from public, anon, authenticated;
revoke execute on function private.call_cron_task(text) from public, anon, authenticated;
grant execute on function private.dispatch_due_jobs(int) to service_role;
grant execute on function private.call_cron_task(text) to service_role;

-- cron.schedule(name, …) replaces an existing job with the same name, so re-running this migration is safe.
select cron.schedule('racketcoach-dispatch-jobs', '* * * * *', 'select private.dispatch_due_jobs(5)');
-- 20:17 UTC = 03:17 ICT
select cron.schedule('racketcoach-daily', '17 20 * * *', $$select private.call_cron_task('daily')$$);
