-- tier_of (grace via coalesced expires_at), recompute_entitlement, transfer_subscription rate limit
-- (DESIGN.md §6.5, §9.4).
begin;
\ir _helpers.psql
select plan(25);

create temp table ids (name text primary key, id uuid) on commit drop;
insert into ids values ('a', tests.create_user()), ('b', tests.create_user()), ('c', tests.create_user());

-- tier_of on the entitlement row ---------------------------------------------------------------------------------------
select is(private.tier_of((select id from ids where name = 'a')), 'free', 'no entitlement row → free');
select tests.set_entitlement((select id from ids where name = 'a'), 'premium', now() + interval '1 minute');
select is(private.tier_of((select id from ids where name = 'a')), 'premium', 'premium while expires_at is in the future');
select is(private.tier_of((select id from ids where name = 'a'), now() + interval '2 minutes'), 'free',
  'free once expires_at has passed');
select tests.set_entitlement((select id from ids where name = 'a'), 'trial', now() + interval '1 day');
select is(private.tier_of((select id from ids where name = 'a')), 'trial', 'trial tier');
delete from public.entitlements;

-- recompute_entitlement from App Store rows ------------------------------------------------------------------------------
-- Grace period: Apple expiry passed, grace still running → premium, expires_at = grace end.
insert into public.app_store_subscriptions (original_transaction_id, user_id, app_account_token, environment,
  product_id, status, auto_renew, original_purchase_at, expires_at, grace_expires_at)
select 'tx-grace', id, id, 'Production', 'premium.monthly', 4, true, now() - interval '40 days',
  now() - interval '2 days', now() + interval '14 days'
from ids where name = 'a';
select is(private.recompute_entitlement((select id from ids where name = 'a')) ->> 'tier', 'premium',
  'grace period keeps premium');
select ok((select expires_at > now() + interval '13 days' and in_grace and billing_issue
  from public.entitlements where user_id = (select id from ids where name = 'a')),
  'expires_at holds the grace end; inGrace and billingIssue set');
select is(private.tier_of((select id from ids where name = 'a')), 'premium', 'tier_of includes the grace period');
select is((select period_anchor from public.entitlements where user_id = (select id from ids where name = 'a')),
  (select original_purchase_at from public.app_store_subscriptions where original_transaction_id = 'tx-grace'),
  'period anchor falls back to the original purchase date');

update public.app_store_subscriptions set grace_expires_at = now() - interval '1 minute', status = 2
where original_transaction_id = 'tx-grace';
select is(private.recompute_entitlement((select id from ids where name = 'a')) ->> 'tier', 'free', 'expired → free');

update public.app_store_subscriptions set status = 3, expires_at = now() + interval '5 days', grace_expires_at = null
where original_transaction_id = 'tx-grace';
select is(private.recompute_entitlement((select id from ids where name = 'a')) ->> 'billingIssue', 'true',
  'billing retry without grace: free with billingIssue');
select is(private.tier_of((select id from ids where name = 'a')), 'free', 'billing retry has no access');

update public.app_store_subscriptions set status = 5, revoked_at = now() where original_transaction_id = 'tx-grace';
select is(private.recompute_entitlement((select id from ids where name = 'a')) ->> 'tier', 'free', 'revoked → free');

insert into public.app_store_subscriptions (original_transaction_id, user_id, environment, product_id, status,
  is_trial, expires_at, period_anchor)
select 'tx-trial', id, 'Sandbox', 'premium.yearly', 1, true, now() + interval '6 days', now() - interval '1 day'
from ids where name = 'b';
select is(private.recompute_entitlement((select id from ids where name = 'b')) ->> 'tier', 'trial',
  'an active trial subscription → trial');
select is(private.recompute_entitlement(gen_random_uuid()), null, 'unknown user → null');

-- A renewed subscription (status 1, Apple expiry in the future) that still carries the grace end of an earlier billing
-- issue stays premium until the new expiry.
insert into public.app_store_subscriptions (original_transaction_id, user_id, environment, product_id, status,
  expires_at, grace_expires_at)
select 'tx-renewed', id, 'Production', 'premium.monthly', 1, now() + interval '25 days', now() - interval '20 days'
from ids where name = 'a';
select is(private.recompute_entitlement((select id from ids where name = 'a')) ->> 'tier', 'premium',
  'a stale grace end does not cut a renewed subscription short');
select ok((select expires_at > now() + interval '24 days' and not in_grace from public.entitlements
  where user_id = (select id from ids where name = 'a')), 'expires_at is the renewed expiry; not in grace');
-- Grace with Apple status still 3 → no access (only 1 and 4 count)
update public.app_store_subscriptions set status = 3, expires_at = now() - interval '1 day',
  grace_expires_at = now() + interval '5 days' where original_transaction_id = 'tx-renewed';
select is(private.recompute_entitlement((select id from ids where name = 'a')) ->> 'tier', 'free',
  'billing retry (status 3) is not access even with a grace date');

-- transfer_subscription ("last restore wins", 3 per 30 days) --------------------------------------------------------------
select is(private.transfer_subscription('tx-trial', (select id from ids where name = 'c')) ->> 'transferred', 'true',
  'transfer to another account');
select is(
  (select string_agg(private.tier_of(id), ',' order by name) from ids where name in ('b', 'c')), 'free,trial',
  'both accounts recomputed');
select is((select app_account_token from public.app_store_subscriptions where original_transaction_id = 'tx-trial'),
  (select id from ids where name = 'c'), 'appAccountToken re-pointed to the new owner');
select is(private.transfer_subscription('tx-trial', (select id from ids where name = 'c')) ->> 'transferred', 'false',
  'transfer to the current owner is a no-op');
select is(private.transfer_subscription('tx-trial', (select id from ids where name = 'b')) ->> 'ok', 'true', '2nd transfer');
select is(private.transfer_subscription('tx-trial', (select id from ids where name = 'c')) ->> 'ok', 'true', '3rd transfer');
select is(private.transfer_subscription('tx-trial', (select id from ids where name = 'b')) ->> 'code',
  'transfer_rate_limited', 'the 4th transfer within 30 days is refused');
select is((select count(*)::int from private.audit_log where action = 'subscription_transfer'
  and subject = 'tx-trial'), 3, 'each transfer is audited');

select * from finish();
rollback;
