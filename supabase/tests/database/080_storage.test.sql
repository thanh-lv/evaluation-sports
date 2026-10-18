-- Storage buckets and the policy matrix (DESIGN.md §6.6, M5): own folder only, bucket-scoped, upsert needs SELECT
-- and UPDATE, no client writes to analysis-derived. The HTTP upsert path is exercised by tests/sql/api_smoke.sh.
begin;
\ir _helpers.psql
select plan(24);

create temp table ids (name text primary key, id uuid) on commit drop;
grant all on ids to anon, authenticated;
insert into ids values ('a', tests.create_user()), ('b', tests.create_user()), ('aid', gen_random_uuid());

-- Buckets ----------------------------------------------------------------------------------------------------------------
select results_eq(
  $$select id, public, file_size_limit, allowed_mime_types from storage.buckets
    where id in ('analysis-inputs', 'analysis-derived') order by id$$,
  $$values ('analysis-derived'::text, false, 2097152::bigint, array['application/json']::text[]),
           ('analysis-inputs', false, 2097152, array['image/jpeg'])$$,
  'both buckets are private, 2 MB, single MIME type');

-- Policy matrix: (bucket, command) pairs that exist for authenticated, nothing for anon
select results_eq(
  $$select cmd::text collate "default",
      (regexp_match(qual_or_check::text collate "default", $re$bucket_id = '([a-z-]+)'$re$))[1]
    from (select cmd, coalesce(qual, with_check) as qual_or_check, roles from pg_policies
          where schemaname = 'storage' and tablename = 'objects'
            and policyname like 'analysis\_%') p
    order by 2, 1$$,
  $$values ('DELETE'::text, 'analysis-derived'::text), ('SELECT', 'analysis-derived'),
           ('DELETE', 'analysis-inputs'), ('INSERT', 'analysis-inputs'), ('SELECT', 'analysis-inputs'),
           ('UPDATE', 'analysis-inputs')$$,
  'policy matrix: inputs I/S/U/D, derived S/D only');
select is(
  (select count(*)::int from pg_policies where schemaname = 'storage' and tablename = 'objects'
     and policyname like 'analysis\_%' and roles <> '{authenticated}'),
  0, 'every app storage policy targets authenticated only');

-- Fixtures written by the service role (as the edge functions would) -----------------------------------------------------
insert into storage.objects (bucket_id, name, owner, metadata)
select 'analysis-derived', u.id || '/' || (select id from ids where name = 'aid') || '/pose.clean.json', u.id, '{}'
from ids u where u.name in ('a', 'b');
insert into storage.objects (bucket_id, name, owner, metadata)
select 'analysis-inputs', u.id || '/' || (select id from ids where name = 'aid') || '/frames/F2.jpg', u.id, '{}'
from ids u where u.name = 'b';

-- User a -------------------------------------------------------------------------------------------------------------------
select tests.login_as((select id from ids where name = 'a'));

select lives_ok(
  format($$insert into storage.objects (bucket_id, name, owner) values ('analysis-inputs', '%s/%s/frames/F1.jpg', auth.uid())$$,
    (select id from ids where name = 'a'), (select id from ids where name = 'aid')),
  'a uploads a key frame into her own folder');
select throws_ok(
  format($$insert into storage.objects (bucket_id, name) values ('analysis-inputs', '%s/%s/frames/F1.jpg')$$,
    (select id from ids where name = 'b'), (select id from ids where name = 'aid')),
  '42501', null, 'a cannot upload into b''s folder');
select throws_ok(
  format($$insert into storage.objects (bucket_id, name) values ('analysis-inputs', '%s/%s/frames/F9.jpg')$$,
    (select id from ids where name = 'a'), (select id from ids where name = 'aid')),
  '42501', null, 'only F1..F5 may be uploaded');
select throws_ok(
  format($$insert into storage.objects (bucket_id, name) values ('analysis-inputs', '%s/%s/frames/F1.jpg')$$,
    (select id from ids where name = 'a'), upper((select id from ids where name = 'aid')::text)),
  '42501', null, 'uppercase analysis ids are refused');
select throws_ok(
  format($$insert into storage.objects (bucket_id, name) values ('analysis-inputs', '%s/notes.txt')$$,
    (select id from ids where name = 'a')),
  '42501', null, 'arbitrary paths in the own folder are refused');
select throws_ok(
  format($$insert into storage.objects (bucket_id, name) values ('analysis-derived', '%s/%s/pose.clean.json')$$,
    (select id from ids where name = 'a'), (select id from ids where name = 'aid')),
  '42501', null, 'clients cannot write to analysis-derived');

select is((select count(*)::int from storage.objects where bucket_id = 'analysis-inputs'), 1,
  'a sees only her own key frames');
select is((select count(*)::int from storage.objects where bucket_id = 'analysis-derived'), 1,
  'a sees only her own pose JSON');
select ok((select bool_and(name like (select id from ids where name = 'a')::text || '/%') from storage.objects),
  'every visible object is in a''s folder');

-- upsert = INSERT, then SELECT + UPDATE of the existing object
with u as (update storage.objects set metadata = '{"size": 1}' where bucket_id = 'analysis-inputs'
  returning 1)
select is(count(*)::int, 1, 'a can update (overwrite) her own key frame') from u;
with u as (update storage.objects set metadata = '{"size": 1}'
  where name like (select id from ids where name = 'b')::text || '/%' returning 1)
select is(count(*)::int, 0, 'a cannot touch b''s objects') from u;
select throws_ok(
  format($$update storage.objects set name = '%s/%s/frames/F1.jpg' where bucket_id = 'analysis-inputs'$$,
    (select id from ids where name = 'b'), (select id from ids where name = 'aid')),
  '42501', null, 'a cannot move a frame into b''s folder');
with u as (update storage.objects set metadata = '{}' where bucket_id = 'analysis-derived' returning 1)
select is(count(*)::int, 0, 'a cannot update her pose JSON (service-role writes only)') from u;

-- deletes (the Storage API sets storage.allow_delete_query)
set local storage.allow_delete_query = 'true';
with d as (delete from storage.objects where name like (select id from ids where name = 'b')::text || '/%'
  returning 1)
select is(count(*)::int, 0, 'a cannot delete b''s objects') from d;
with d as (delete from storage.objects where bucket_id = 'analysis-derived' returning 1)
select is(count(*)::int, 1, 'a can delete her own pose JSON') from d;
with d as (delete from storage.objects where bucket_id = 'analysis-inputs' returning 1)
select is(count(*)::int, 1, 'a can delete her own key frames') from d;

-- Anon ---------------------------------------------------------------------------------------------------------------------
select tests.login_anon();
select is((select count(*)::int from storage.objects where bucket_id like 'analysis-%'), 0, 'anon sees no objects');
select throws_ok(
  format($$insert into storage.objects (bucket_id, name) values ('analysis-inputs', '%s/%s/frames/F1.jpg')$$,
    (select id from ids where name = 'a'), (select id from ids where name = 'aid')),
  '42501', null, 'anon cannot upload');

-- b still has everything -----------------------------------------------------------------------------------------------------
select tests.login_as((select id from ids where name = 'b'));
select is((select count(*)::int from storage.objects), 2, 'b''s objects are untouched');
select tests.logout();
select is((select count(*)::int from storage.objects where name like (select id from ids where name = 'a')::text || '/%'),
  0, 'a''s folder is empty');
select is((select count(*)::int from storage.objects where name like (select id from ids where name = 'b')::text || '/%'),
  2, 'b''s folder still holds 2 objects');

select * from finish();
rollback;
