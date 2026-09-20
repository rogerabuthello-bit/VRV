-- =====================================================================
-- Brokers. Pip values and lot steps are set by the broker, not the
-- market, so a spec belongs to (trader, broker, instrument). Keeping the
-- broker on the row means moving or adding a broker never overwrites the
-- settings you already proved out on the old one.
-- Additive and safe to re-run.
-- =====================================================================

alter table public.instruments
  add column if not exists broker text not null default '';

-- Widen the uniqueness rule so the same symbol can exist once per broker.
drop index if exists public.instruments_user_name_key;
create unique index if not exists instruments_user_broker_name_key
  on public.instruments (user_id, broker, name);

alter table public.users
  add column if not exists active_broker text not null default '';

-- Snapshot on the trade, so history still reads correctly after a move.
alter table public.trades
  add column if not exists broker text not null default '';

create index if not exists trades_broker_idx on public.trades (broker);
