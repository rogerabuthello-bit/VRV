-- =====================================================================
-- Brokers become a stored list rather than something inferred from the
-- instruments that happen to exist. Inferring meant a broker you had just
-- added disappeared the moment you switched away from it, before you had
-- chance to give it any instruments.
-- Additive and safe to re-run.
-- =====================================================================

alter table public.users
  add column if not exists brokers text[] not null default '{}';

-- Seed each trader's list from the brokers already present on their rows,
-- so nothing set up before this migration is lost.
update public.users u
set brokers = sub.names
from (
  select user_id, array_agg(distinct broker) as names
  from public.instruments
  where broker <> ''
  group by user_id
) as sub
where sub.user_id = u.id
  and u.brokers = '{}';

update public.users
set brokers = array_append(brokers, active_broker)
where active_broker <> '' and not (active_broker = any(brokers));
