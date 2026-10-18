-- 0300 private schema tables: service role only (DESIGN.md §6.5). RLS is enabled with no policies, so even a
-- mistaken grant exposes nothing to anon/authenticated.

-- App Store Server Notifications V2 inbox (§9.5): re-processed unless status = 'processed'.
create table private.appstore_notifications (
  notification_uuid uuid primary key,
  notification_type text not null,
  subtype text,
  environment text check (environment in ('Production', 'Sandbox', 'Xcode')),
  original_transaction_id text,
  payload jsonb not null,
  status text not null default 'received' check (status in ('received', 'processed', 'failed')),
  error text,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);
alter table private.appstore_notifications enable row level security;
create index appstore_notifications_tx_idx on private.appstore_notifications (original_transaction_id);

-- Sign in with Apple refresh tokens, AES-GCM encrypted by the edge function (crypto.ts).
create table private.apple_auth_tokens (
  user_id uuid primary key references auth.users (id) on delete cascade,
  ciphertext text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table private.apple_auth_tokens enable row level security;

-- One row per Claude attempt (§8.3). Kept after account deletion for cost accounting: no FK, no user_id.
create table private.llm_calls (
  id bigint generated always as identity primary key,
  analysis_id uuid not null,
  attempt int not null,
  kind text check (kind in ('basic', 'standard')),
  model_requested text not null,
  model_served text,
  effort text,
  stop_reason text,
  refusal_category text,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cache_read_input_tokens int not null default 0,
  cache_creation_input_tokens int not null default 0,
  cost_usd numeric(12, 6) not null default 0,
  latency_ms int,
  request_id text,
  error text,
  created_at timestamptz not null default now()
);
alter table private.llm_calls enable row level security;
create index llm_calls_analysis_idx on private.llm_calls (analysis_id);
create index llm_calls_created_idx on private.llm_calls (created_at);

-- Raw model output (debugging / eval), 90-day retention (§6.6).
create table private.llm_outputs (
  id bigint generated always as identity primary key,
  analysis_id uuid not null,
  attempt int not null,
  output jsonb,
  created_at timestamptz not null default now()
);
alter table private.llm_outputs enable row level security;
create index llm_outputs_created_idx on private.llm_outputs (created_at);

-- Spend per ICT day (budget guard §8.7) and per user per ICT month (60%-of-proceeds alert).
create table private.daily_spend (
  day date primary key,
  cost_usd numeric(12, 6) not null default 0,
  calls int not null default 0,
  alerted_70 boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table private.daily_spend enable row level security;

create table private.user_monthly_cost (
  user_id uuid not null references public.profiles (id) on delete cascade,
  month text not null check (month ~ '^[0-9]{4}-[0-9]{2}$'),
  cost_usd numeric(12, 6) not null default 0,
  calls int not null default 0,
  alerted boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, month)
);
alter table private.user_monthly_cost enable row level security;

-- Restore transfers of a subscription between accounts (§9.4: 3 per 30 days per originalTransactionId).
create table private.link_transfers (
  id bigint generated always as identity primary key,
  original_transaction_id text not null,
  from_user_id uuid,
  to_user_id uuid not null,
  created_at timestamptz not null default now()
);
alter table private.link_transfers enable row level security;
create index link_transfers_tx_idx on private.link_transfers (original_transaction_id, created_at);

-- Security-relevant actions. subject is a hash for deleted accounts (sha256(uid + pepper)), never an email.
create table private.audit_log (
  id bigint generated always as identity primary key,
  action text not null,
  subject text,
  details jsonb not null default '{}',
  created_at timestamptz not null default now()
);
alter table private.audit_log enable row level security;
create index audit_log_created_idx on private.audit_log (created_at);

-- Emails whose accounts get profiles.is_reviewer (App Review / demo). Filled by the operator; the local seed adds a
-- reserved-TLD demo address only.
create table private.reviewer_emails (
  email text primary key check (email = lower(email)),
  note text,
  created_at timestamptz not null default now()
);
alter table private.reviewer_emails enable row level security;

grant all on all tables in schema private to service_role;
grant all on all sequences in schema private to service_role;
