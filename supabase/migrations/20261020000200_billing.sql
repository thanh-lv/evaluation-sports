-- 0200 billing: plan limits, model routes, entitlements, App Store subscriptions, usage counters, quota ledger
-- (DESIGN.md §6.5, §8.1, §9.3–9.5). Seed values live in supabase/seed.sql.

-- ---------------------------------------------------------------------------------------------------------------
-- plan_limits: one row per tier; every quota number the app shows comes from here (D18).

create table public.plan_limits (
  tier text primary key check (tier in ('free', 'trial', 'premium')),
  period_type text not null check (period_type in ('calendar_month', 'trial', 'subscription_month')),
  total_limit int not null check (total_limit >= 0),
  standard_limit int not null check (standard_limit >= 0 and standard_limit <= total_limit),
  -- free only: the first-ever analysis runs on the standard route (DeviceCheck-guarded) and counts toward total_limit
  first_ever_standard boolean not null default false,
  max_in_flight int not null default 1 check (max_in_flight >= 1),
  -- rejected/partial refunds allowed per period (§6.5 refund_quota)
  free_retry_limit int not null default 3 check (free_retry_limit >= 0),
  -- {full_report, progress, player, history_full_limit (null = unlimited)}
  features jsonb not null default '{}' check (jsonb_typeof(features) = 'object'),
  updated_at timestamptz not null default now()
);
alter table public.plan_limits enable row level security;

-- ---------------------------------------------------------------------------------------------------------------
-- model_routes: kind → Claude model settings, switchable without a deploy (§8.1). Service role only.

create table public.model_routes (
  kind text primary key check (kind in ('basic', 'standard')),
  model text not null,
  effort text not null check (effort in ('low', 'medium', 'high', 'max')),
  max_tokens int not null check (max_tokens > 0),
  timeout_ms int not null check (timeout_ms > 0),
  -- server-side fallback mode (`"default"`) or null for none (Haiku has no fallback)
  fallbacks text check (fallbacks = 'default'),
  betas text[] not null default '{}',
  updated_at timestamptz not null default now()
);
alter table public.model_routes enable row level security;

-- ---------------------------------------------------------------------------------------------------------------
-- entitlements: the effective tier per user, recomputed from app_store_subscriptions (§9.4).

create table public.entitlements (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  tier text not null default 'free' check (tier in ('free', 'trial', 'premium')),
  is_trial boolean not null default false,
  product_id text,
  original_transaction_id text,
  -- coalesce(grace_expires_at, expires_at): tier_of() needs no separate grace logic
  expires_at timestamptz,
  -- premium quota windows are monthly from this instant (§9.3)
  period_anchor timestamptz,
  will_renew boolean not null default false,
  billing_issue boolean not null default false,
  in_grace boolean not null default false,
  source text not null default 'none' check (source in ('none', 'app_store', 'xcode', 'manual')),
  updated_at timestamptz not null default now(),
  constraint entitlements_trial_flag check (is_trial = (tier = 'trial'))
);
alter table public.entitlements enable row level security;

create trigger entitlements_touch_updated_at
before update on public.entitlements
for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------------------------------------------------
-- app_store_subscriptions: one row per originalTransactionId (§9.4/9.5). Service role only.

create table public.app_store_subscriptions (
  original_transaction_id text primary key,
  user_id uuid references public.profiles (id) on delete set null,
  app_account_token uuid,
  environment text not null check (environment in ('Production', 'Sandbox', 'Xcode')),
  product_id text not null,
  -- Apple subscription status: 1 active, 2 expired, 3 billing retry, 4 grace period, 5 revoked
  status smallint not null check (status between 1 and 5),
  auto_renew boolean not null default false,
  is_trial boolean not null default false,
  original_purchase_at timestamptz,
  -- start of the paid period the monthly quota windows are anchored on (set by the Apple layer; falls back to
  -- original_purchase_at)
  period_anchor timestamptz,
  expires_at timestamptz,
  grace_expires_at timestamptz,
  revoked_at timestamptz,
  renewal_info jsonb,
  transaction_info jsonb,
  last_verified_at timestamptz,
  -- restore transfers in the last 30 days (maintained by private.transfer_subscription)
  transfer_count_30d int not null default 0 check (transfer_count_30d >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.app_store_subscriptions enable row level security;

create index app_store_subscriptions_user_idx on public.app_store_subscriptions (user_id);
create index app_store_subscriptions_token_idx on public.app_store_subscriptions (app_account_token);

create trigger app_store_subscriptions_touch_updated_at
before update on public.app_store_subscriptions
for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------------------------------------------------
-- usage_counters: (user, period) counters. period_key: 'YYYY-MM' (ICT calendar month, free),
-- 'trial:<origTx>', 'sub:<origTx>:<windowStart YYYY-MM-DD ICT>' (premium), 'lifetime' (first-ever bonus).

create table public.usage_counters (
  user_id uuid not null references public.profiles (id) on delete cascade,
  period_key text not null check (
    period_key = 'lifetime' or period_key ~ '^[0-9]{4}-[0-9]{2}$' or period_key ~ '^trial:.+$'
    or period_key ~ '^sub:.+:[0-9]{4}-[0-9]{2}-[0-9]{2}$'
  ),
  used int not null default 0 check (used >= 0),
  used_standard int not null default 0 check (used_standard >= 0),
  retries_used int not null default 0 check (retries_used >= 0),
  -- lifetime row only: the free first-ever standard analysis has been reserved (merge = OR)
  bonus_used boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, period_key)
);
alter table public.usage_counters enable row level security;

create trigger usage_counters_touch_updated_at
before update on public.usage_counters
for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------------------------------------------------
-- quota_ledger: one row per submitted analysis; reserved → committed | refunded. Service role only.

create table public.quota_ledger (
  analysis_id uuid primary key references public.analyses (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  period_key text not null,
  kind text not null check (kind in ('basic', 'standard')),
  -- this reservation consumed the free first-ever bonus (a refund gives it back)
  is_bonus boolean not null default false,
  state text not null default 'reserved' check (state in ('reserved', 'committed', 'refunded')),
  refund_reason text,
  created_at timestamptz not null default now(),
  committed_at timestamptz,
  refunded_at timestamptz
);
alter table public.quota_ledger enable row level security;

create index quota_ledger_user_period_idx on public.quota_ledger (user_id, period_key);
