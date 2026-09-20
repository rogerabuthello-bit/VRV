-- =====================================================================
-- Points of interest become a per-trader library rather than a list
-- retyped inside every strategy. The same level gets read by several
-- models, and the question worth answering - which POI works with which
-- strategy - can only be asked once both vary independently.
-- Additive and safe to re-run.
-- =====================================================================

alter table public.users
  add column if not exists pois text[] not null default '{}';

-- Seed each trader's library from whatever they had defined per strategy,
-- so nothing written under the old shape is lost.
update public.users u
set pois = sub.names
from (
  select s.user_id, array_agg(distinct p order by p) as names
  from public.strategies s, unnest(s.pois) as p
  where p <> ''
  group by s.user_id
) as sub
where sub.user_id = u.id
  and u.pois = '{}';

-- strategies.pois stays in place but is no longer read; dropping it would
-- throw away the only copy if this migration is ever rolled back.
