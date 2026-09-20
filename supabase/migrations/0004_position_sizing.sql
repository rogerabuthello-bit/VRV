-- =====================================================================
-- Position sizing: what one pip is worth, how big the position was, and
-- what share of equity was actually put at risk.
-- Additive and safe to re-run.
-- =====================================================================

-- Per-trader contract spec. value_per_pip is money (in the trader's base
-- currency) made or lost on ONE pip when holding ONE lot, which is the one
-- number every broker states and every size calculation needs.
alter table public.instruments
  add column if not exists pip_size      double precision,
  add column if not exists value_per_pip double precision,
  add column if not exists lot_step      double precision not null default 0.01;

alter table public.instruments drop constraint if exists instruments_spec_positive;
alter table public.instruments add constraint instruments_spec_positive check (
  (pip_size is null or pip_size > 0)
  and (value_per_pip is null or value_per_pip > 0)
  and lot_step > 0
);

-- Position actually taken, and the risk it represented at the time.
alter table public.trades
  add column if not exists lots     double precision,
  add column if not exists risk_pct double precision;

alter table public.trades drop constraint if exists trades_lots_positive;
alter table public.trades add constraint trades_lots_positive
  check (lots is null or lots > 0);

-- The plan each trade is measured against.
alter table public.users
  add column if not exists default_risk_pct double precision not null default 1;

alter table public.users drop constraint if exists users_default_risk_pct_check;
alter table public.users add constraint users_default_risk_pct_check
  check (default_risk_pct > 0 and default_risk_pct <= 100);
