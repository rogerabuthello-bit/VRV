-- =====================================================================
-- Record when a trade was closed, not just when it was entered.
-- Additive and safe to re-run: existing trades keep a NULL close time.
-- =====================================================================

alter table public.trades
  add column if not exists closed_utc timestamptz;

alter table public.trades
  drop constraint if exists trades_closed_after_open;

alter table public.trades
  add constraint trades_closed_after_open
  check (closed_utc is null or closed_utc >= opened_utc);

create index if not exists trades_closed_idx on public.trades (closed_utc);
