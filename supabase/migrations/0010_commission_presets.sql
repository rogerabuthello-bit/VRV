-- =====================================================================
-- Commission. Brokers charge per lot, and a journal that ignores it
-- reports a profit the account never saw. The default lives on the
-- instrument spec, which is already per broker, and each trade stores
-- the amount actually charged.
-- Additive and safe to re-run.
-- =====================================================================

alter table public.instruments
  add column if not exists commission_per_lot double precision not null default 0;

alter table public.instruments drop constraint if exists instruments_commission_check;
alter table public.instruments add constraint instruments_commission_check
  check (commission_per_lot >= 0);

-- Money taken by the broker on this trade. PnL stored on the trade is net
-- of it, so equity needs no separate adjustment.
alter table public.trades
  add column if not exists commission double precision not null default 0;

alter table public.trades drop constraint if exists trades_commission_check;
alter table public.trades add constraint trades_commission_check
  check (commission >= 0);
