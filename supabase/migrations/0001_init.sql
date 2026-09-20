-- =====================================================================
-- VRV Trading Journal - initial schema
-- Run this once in the Supabase SQL editor (or via `supabase db push`).
--
-- Identity is handled by Supabase Auth (Google OAuth + email/password).
-- public.users is the profile row that hangs off auth.users and carries
-- the trading-journal identity: handle, role, default timezone/currency.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- users
create table if not exists public.users (
  id             uuid primary key references auth.users (id) on delete cascade,
  username       text not null,
  username_lower text generated always as (lower(username)) stored,
  email          text not null default '',
  role           text not null default 'user',
  timezone       text not null default 'UTC',
  currency       text not null default 'USD',
  disabled       boolean not null default false,
  created_at     timestamptz not null default now(),
  constraint users_role_check check (role in ('user', 'admin', 'superadmin')),
  constraint users_username_format check (username ~ '^[A-Za-z0-9_]{3,20}$')
);

create unique index if not exists users_username_lower_key on public.users (username_lower);

-- At most one superadmin account may exist.
create unique index if not exists users_single_superadmin_idx
  on public.users ((role)) where role = 'superadmin';

-- -------------------------------------------------------- invite codes
-- The superadmin (and admins) mint these from the Admin tab; a new signup
-- cannot create a profile without one.
create table if not exists public.invite_codes (
  id         uuid primary key default gen_random_uuid(),
  code       text not null,
  code_upper text generated always as (upper(code)) stored,
  note       text not null default '',
  max_uses   integer not null default 1,
  uses       integer not null default 0,
  expires_at timestamptz,
  active     boolean not null default true,
  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint invite_codes_max_uses_check check (max_uses >= 1),
  constraint invite_codes_uses_check check (uses >= 0),
  constraint invite_codes_code_format check (char_length(code) between 6 and 64)
);

create unique index if not exists invite_codes_code_upper_key on public.invite_codes (code_upper);

create table if not exists public.invite_redemptions (
  id          uuid primary key default gen_random_uuid(),
  invite_id   uuid not null references public.invite_codes (id) on delete cascade,
  user_id     uuid not null references public.users (id) on delete cascade,
  redeemed_at timestamptz not null default now()
);

create index if not exists invite_redemptions_invite_idx on public.invite_redemptions (invite_id);

-- ---------------------------------------------------------- instruments
create table if not exists public.instruments (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users (id) on delete cascade,
  name       text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists instruments_user_name_key on public.instruments (user_id, name);

-- ----------------------------------------------------------- strategies
create table if not exists public.strategies (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users (id) on delete cascade,
  name        text not null,
  description text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index if not exists strategies_user_name_key on public.strategies (user_id, lower(name));

-- ---------------------------------------- funds (deposits / withdrawals)
create table if not exists public.funds (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users (id) on delete cascade,
  entry_date date not null,
  type       text not null,
  amount     numeric(18, 2) not null,
  currency   text not null,
  note       text not null default '',
  created_at timestamptz not null default now(),
  constraint funds_type_check check (type in ('Deposit', 'Withdrawal')),
  constraint funds_amount_check check (amount > 0)
);

create index if not exists funds_user_idx on public.funds (user_id);

-- --------------------------------------------------------------- trades
create table if not exists public.trades (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users (id) on delete cascade,
  logged_at   timestamptz not null default now(),
  trade_date  date not null,
  instrument  text not null,
  direction   text not null,
  strategy    text not null,
  entry       double precision not null,
  initial_sl  double precision not null,
  final_sl    double precision not null,
  sl_trailed  boolean not null default false,
  initial_tp  double precision,
  exit_price  double precision not null,
  risk        double precision,
  planned_rr  double precision,
  result_r    double precision not null,
  pnl         double precision,
  outcome     text not null,
  quality     text not null,
  notes       text not null default '',
  confidence  smallint not null,
  screenshots text[] not null default '{}',
  timezone    text not null default 'UTC',
  opened_utc  timestamptz not null,
  session     text not null,
  currency    text not null default 'USD',
  constraint trades_direction_check check (direction in ('Long', 'Short')),
  constraint trades_outcome_check check (outcome in ('Win', 'Loss', 'BE')),
  constraint trades_quality_check check (quality in ('Good Win', 'Bad Win', 'Good Loss', 'Bad Loss')),
  constraint trades_confidence_check check (confidence between 1 and 5),
  constraint trades_session_check check (session in ('Asia', 'London', 'London/NY', 'New York', 'Off-hours'))
);

create index if not exists trades_user_idx on public.trades (user_id);
create index if not exists trades_date_idx on public.trades (trade_date);
create index if not exists trades_opened_idx on public.trades (opened_utc);

-- ------------------------------------------------------------------ RLS
-- Every table is locked down. The browser only ever talks to /api/rpc,
-- which uses the service-role key after checking the caller's Supabase
-- Auth JWT. No policies are defined on purpose: with RLS enabled and no
-- policy, anon/authenticated clients can read and write nothing, while
-- the service role bypasses RLS entirely.
alter table public.users              enable row level security;
alter table public.invite_codes       enable row level security;
alter table public.invite_redemptions enable row level security;
alter table public.instruments        enable row level security;
alter table public.strategies         enable row level security;
alter table public.funds              enable row level security;
alter table public.trades             enable row level security;

-- -------------------------------------------------------------- storage
-- Private bucket for trade screenshots. Objects are written by the browser
-- with a short-lived signed upload URL and read back through signed URLs,
-- both minted server-side after an ownership check.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'screenshots',
  'screenshots',
  false,
  4194304,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
