-- =====================================================================
-- Points of interest: the level or structure that made the trade worth
-- taking. They belong to a strategy, because a POI only means anything
-- inside the model that reads it, so each strategy carries its own list
-- exactly as it already carries its rules.
-- Additive and safe to re-run.
-- =====================================================================

alter table public.strategies
  add column if not exists pois text[] not null default '{}';

alter table public.trades
  add column if not exists poi text;

create index if not exists trades_poi_idx on public.trades (poi);
