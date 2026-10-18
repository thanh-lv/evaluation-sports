-- 0500 RLS policies and grants (DESIGN.md §6.5 "RLS and grants"). Every client privilege is listed here (and in
-- 0700 for the config/analytics tables); everything else is revoked.

-- ---------------------------------------------------------------------------------------------------------------
-- Start from nothing for the client roles

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
revoke all on all tables in schema private from public, anon, authenticated;
revoke execute on all functions in schema private from public, anon, authenticated;

grant all on all tables in schema public to service_role;
grant execute on all functions in schema public to service_role;
grant execute on all functions in schema private to service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- profiles: SELECT and UPDATE own; UPDATE limited to profile, consent and opt-in columns (consent timestamps and
-- is_reviewer are server-set).

grant select on public.profiles to authenticated;
grant update (
  locale, handedness, level, birth_year, age_attested, pdpl_consent_version, ai_consent_version,
  calibration_opt_in, consumption_consent
) on public.profiles to authenticated;

create policy profiles_select_own on public.profiles
for select to authenticated
using (id = (select auth.uid()));

create policy profiles_update_own on public.profiles
for update to authenticated
using (id = (select auth.uid()))
with check (id = (select auth.uid()));

-- ---------------------------------------------------------------------------------------------------------------
-- analyses: SELECT own through a column grant (no prepared/pose paths/quality); DELETE own. Written by the service
-- role only. user_id is added to the §6.5 column list because the feedback WITH CHECK subquery below reads
-- a.user_id with the caller's privileges (it is always the caller's own uid under RLS).

grant select (id, user_id, sport, skill, status, failure_code, camera_view, subject, created_at, completed_at)
  on public.analyses to authenticated;
grant delete on public.analyses to authenticated;

create policy analyses_select_own on public.analyses
for select to authenticated
using (user_id = (select auth.uid()));

create policy analyses_delete_own on public.analyses
for delete to authenticated
using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------------------------------------------
-- feedback: INSERT and SELECT own, only on the caller's own analyses.

grant select, insert (analysis_id, user_id, rating, comment) on public.feedback to authenticated;

create policy feedback_select_own on public.feedback
for select to authenticated
using (user_id = (select auth.uid()));

create policy feedback_insert_own on public.feedback
for insert to authenticated
with check (
  user_id = (select auth.uid())
  and exists (select 1 from public.analyses a where a.id = analysis_id and a.user_id = (select auth.uid()))
);

-- ---------------------------------------------------------------------------------------------------------------
-- plan_limits: readable by everyone (paywall copy before sign-in).

grant select on public.plan_limits to anon, authenticated;

create policy plan_limits_read_all on public.plan_limits
for select to anon, authenticated
using (true);

-- ---------------------------------------------------------------------------------------------------------------
-- entitlements, usage_counters: SELECT own.

grant select on public.entitlements to authenticated;
grant select on public.usage_counters to authenticated;

create policy entitlements_select_own on public.entitlements
for select to authenticated
using (user_id = (select auth.uid()));

create policy usage_counters_select_own on public.usage_counters
for select to authenticated
using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------------------------------------------
-- No client access (RLS on, no policies, no grants): analysis_results, model_routes, quota_ledger,
-- app_store_subscriptions, private.*.

-- ---------------------------------------------------------------------------------------------------------------
-- Client RPCs. uid-taking functions (private.*) are never granted to clients.

grant execute on function public.my_status() to authenticated;
grant execute on function public.get_result(uuid) to authenticated;
grant execute on function public.get_history(int, timestamptz) to authenticated;
grant execute on function public.get_progress(text, text) to authenticated;
