-- Profile auto-creation (anonymous included), age gate (D21), server-set consent timestamps, reviewer flag.
begin;
\ir _helpers.psql
select plan(17);

create temp table ids (name text primary key, id uuid) on commit drop;
grant all on ids to authenticated;

-- (The real GoTrue path, supabase_auth_admin inserting an anonymous user, is covered by tests/sql/api_smoke.sh.)
insert into auth.users (instance_id, id, aud, role, is_anonymous, raw_app_meta_data, raw_user_meta_data, created_at,
  updated_at)
values ('00000000-0000-0000-0000-000000000000', '11111111-1111-4111-8111-111111111111', 'authenticated',
  'authenticated', true, '{}', '{}', now(), now());

select ok(exists (select 1 from public.profiles where id = '11111111-1111-4111-8111-111111111111'),
  'profile created for an anonymous auth user');
select is(
  (select row(calibration_opt_in, consumption_consent, is_reviewer, age_attested)::text from public.profiles
   where id = '11111111-1111-4111-8111-111111111111'),
  '(f,f,f,f)', 'opt-ins default to false');

insert into ids values ('u', tests.create_user('player@example.com'));
select tests.login_as((select id from ids where name = 'u'));

-- Age gate: year-based age vs app_config.min_user_age (18)
select throws_ok(
  format($$update public.profiles set birth_year = %s$$,
    extract(year from now() at time zone 'Asia/Ho_Chi_Minh')::int - 17),
  '23514', 'under_min_age', 'a 17-year-old birth year is refused');
select throws_ok(
  format($$update public.profiles set birth_year = %s$$,
    extract(year from now() at time zone 'Asia/Ho_Chi_Minh')::int - 18),
  '23514', 'age_attestation_required', 'a borderline birth year needs the attestation');
select lives_ok(
  format($$update public.profiles set birth_year = %s, age_attested = true$$,
    extract(year from now() at time zone 'Asia/Ho_Chi_Minh')::int - 18),
  'a borderline birth year with the attestation is accepted');
select lives_ok($$update public.profiles set birth_year = 1990, age_attested = false$$, 'an adult birth year is accepted');

-- Consent timestamps are set by the server when the version changes
select lives_ok($$update public.profiles set pdpl_consent_version = '2026-10-01', ai_consent_version = '2026-10-01'$$,
  'consent versions are client-writable');
select ok((select pdpl_consent_at is not null and ai_consent_at is not null from public.profiles),
  'consent timestamps are stamped');
select lives_ok($$update public.profiles set ai_consent_version = null$$, 'AI consent can be withdrawn');
select ok((select ai_consent_at is null and pdpl_consent_at is not null from public.profiles),
  'withdrawal clears only the AI consent timestamp');
select is((select (my_status() -> 'consent' ->> 'upToDate')::boolean), false, 'my_status reports consent out of date');
select tests.logout();

-- Reviewer flag: seeded local demo email, at sign-up and when an anonymous user links the email
insert into ids values ('rev', tests.create_user('reviewer@racketcoach.test'));
select is((select is_reviewer from public.profiles where id = (select id from ids where name = 'rev')), true,
  'seeded reviewer email gets is_reviewer at sign-up');
-- Unverified addresses never get the flag: GoTrue inserts the row before the OTP is checked, and a password sign-up
-- or an email link can name any address.
update auth.users set email = 'REVIEWER@racketcoach.test' where id = (select id from ids where name = 'rev');
insert into ids values ('unconfirmed', tests.create_user('reviewer@racketcoach.test', false, false));
select is((select is_reviewer from public.profiles where id = (select id from ids where name = 'unconfirmed')), false,
  'an unconfirmed sign-up with the reviewer email is not a reviewer');
update auth.users set email_confirmed_at = now() where id = (select id from ids where name = 'unconfirmed');
select is((select is_reviewer from public.profiles where id = (select id from ids where name = 'unconfirmed')), true,
  'confirming the reviewer email (OTP verified) sets the flag');
insert into ids values ('anon', tests.create_user(null, true));
update auth.users set email = 'Reviewer@RacketCoach.test' where id = (select id from ids where name = 'anon');
select is((select is_reviewer from public.profiles where id = (select id from ids where name = 'anon')), false,
  'an anonymous user cannot become a reviewer by naming the email without confirming it');
update auth.users set email_confirmed_at = now(), is_anonymous = false
where id = (select id from ids where name = 'anon');
select is((select is_reviewer from public.profiles where id = (select id from ids where name = 'anon')), true,
  'an anonymous user who links and confirms the reviewer email becomes a reviewer');
select is((select is_reviewer from public.profiles where id = (select id from ids where name = 'u')), false,
  'ordinary users are not reviewers');

select * from finish();
rollback;
