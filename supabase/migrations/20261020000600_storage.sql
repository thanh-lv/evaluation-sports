-- 0600 storage buckets and policies (DESIGN.md §6.6). Buckets are created here (not in config.toml) so the hosted
-- project gets them from `db push` too. Idempotent. Each policy is scoped by bucket_id; storage.objects itself is
-- not altered (no ALTER TABLE storage.objects).
--
-- analysis-inputs  {uid}/{aid}/frames/F1..F5.jpg   client INSERT/SELECT/UPDATE/DELETE in its own folder
--                                                   (upsert needs SELECT + UPDATE). Deleted at finalize / 72 h cap.
-- analysis-derived {uid}/{aid}/pose.raw.json, pose.clean.json   client SELECT/DELETE own; writes by service role.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('analysis-inputs', 'analysis-inputs', false, 2097152, array['image/jpeg']),
  ('analysis-derived', 'analysis-derived', false, 2097152, array['application/json'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists analysis_inputs_insert_own on storage.objects;
drop policy if exists analysis_inputs_select_own on storage.objects;
drop policy if exists analysis_inputs_update_own on storage.objects;
drop policy if exists analysis_inputs_delete_own on storage.objects;
drop policy if exists analysis_derived_select_own on storage.objects;
drop policy if exists analysis_derived_delete_own on storage.objects;

-- Writes must also match the exact frame layout with lowercase UUIDs (D14: uppercase ids would break RLS paths).
create policy analysis_inputs_insert_own on storage.objects
for insert to authenticated
with check (
  bucket_id = 'analysis-inputs'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/frames/F[1-5]\.jpg$'
);

create policy analysis_inputs_select_own on storage.objects
for select to authenticated
using (
  bucket_id = 'analysis-inputs'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

create policy analysis_inputs_update_own on storage.objects
for update to authenticated
using (
  bucket_id = 'analysis-inputs'
  and (storage.foldername(name))[1] = (select auth.uid())::text
)
with check (
  bucket_id = 'analysis-inputs'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/frames/F[1-5]\.jpg$'
);

create policy analysis_inputs_delete_own on storage.objects
for delete to authenticated
using (
  bucket_id = 'analysis-inputs'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

create policy analysis_derived_select_own on storage.objects
for select to authenticated
using (
  bucket_id = 'analysis-derived'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

create policy analysis_derived_delete_own on storage.objects
for delete to authenticated
using (
  bucket_id = 'analysis-derived'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);
