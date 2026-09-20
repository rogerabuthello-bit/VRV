-- =====================================================================
-- How each trade ended: target, stop, trail or a manual close.
-- Additive and safe to re-run. Existing trades stay NULL; the app works
-- their reason out from the prices when it displays them.
-- =====================================================================

alter table public.trades
  add column if not exists exit_reason text;

alter table public.trades
  drop constraint if exists trades_exit_reason_check;

alter table public.trades
  add constraint trades_exit_reason_check
  check (exit_reason is null or exit_reason in (
    'Target hit', 'Ran past target', 'Trailed stop hit', 'Stopped out', 'Manual close'
  ));

create index if not exists trades_exit_reason_idx on public.trades (exit_reason);
