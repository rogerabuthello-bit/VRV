-- =====================================================================
-- The "why" behind a trade: what went wrong, how you felt going in, and
-- which of your own rules you actually followed.
-- Additive and safe to re-run.
-- =====================================================================

-- Fixed taxonomies. A free-text field would splinter into synonyms and stop
-- being groupable, which defeats the point of tagging at all.
alter table public.trades
  add column if not exists mistakes text[] not null default '{}',
  add column if not exists emotion  text;

alter table public.trades drop constraint if exists trades_mistakes_check;
alter table public.trades add constraint trades_mistakes_check check (
  mistakes <@ array[
    'Chased entry', 'Entered early', 'No setup', 'Moved stop', 'Oversized',
    'Closed early', 'Held too long', 'Revenge trade', 'Overtraded'
  ]::text[]
);

alter table public.trades drop constraint if exists trades_emotion_check;
alter table public.trades add constraint trades_emotion_check check (
  emotion is null or emotion in (
    'Calm', 'Confident', 'FOMO', 'Anxious', 'Frustrated', 'Bored', 'Tilted', 'Distracted'
  )
);

-- A strategy's rules, and which of them a trade honoured. rules_total is
-- frozen onto the trade so editing a strategy later cannot rewrite history.
alter table public.strategies
  add column if not exists rules text[] not null default '{}';

alter table public.trades
  add column if not exists rules_followed text[] not null default '{}',
  add column if not exists rules_total    integer not null default 0;

alter table public.trades drop constraint if exists trades_rules_total_check;
alter table public.trades add constraint trades_rules_total_check
  check (rules_total >= 0 and array_length(rules_followed, 1) is null
         or array_length(rules_followed, 1) <= rules_total);

create index if not exists trades_emotion_idx  on public.trades (emotion);
create index if not exists trades_mistakes_idx on public.trades using gin (mistakes);
