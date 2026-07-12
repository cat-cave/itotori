-- p0-core-atomic-cost-reservation follow-up — backfill historical spend.
--
-- Migration 0081 created durable cost accounts but initialized every account
-- at zero. Existing journal attempts already carry exact paid cost facts, so
-- resuming one of those runs must start from the historical spent balance
-- rather than admitting calls as though its prior provider usage vanished.
--
-- `cost_kind` was introduced after the original journal table. A NULL kind
-- with a non-NULL cost is therefore a legacy paid attempt, while explicit
-- provider estimates are not settled spend. Keep any live reservation balance
-- already written after 0081; only the historical spent projection changes.

with historical_run_spend as (
  select
    run.run_id,
    case
      when jsonb_typeof(run.cost_policy -> 'budgetCapUsd') = 'number'
        and run.cost_policy ->> 'budgetCapUsd' ~ '^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$'
        then (run.cost_policy ->> 'budgetCapUsd')::numeric
      when jsonb_typeof(run.cost_policy -> 'budgetCapUsd') = 'string'
        and run.cost_policy ->> 'budgetCapUsd' ~ '^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$'
        then (run.cost_policy ->> 'budgetCapUsd')::numeric
      else null
    end as cap_usd,
    coalesce(
      sum(attempt.cost_usd) filter (
        where attempt.cost_usd is not null
          and (attempt.cost_kind = 'billed' or attempt.cost_kind is null)
      ),
      0
    ) as spent_usd,
    run.created_at
  from itotori_localization_journal_runs run
  left join itotori_llm_attempts attempt on attempt.run_id = run.run_id
  group by run.run_id, run.cost_policy, run.created_at
)
insert into itotori_localization_run_cost_accounts (
  run_id,
  cap_usd,
  spent_usd,
  reserved_usd,
  created_at,
  updated_at
)
select
  run_id,
  cap_usd,
  spent_usd,
  0,
  created_at,
  now()
from historical_run_spend
on conflict (run_id) do update
set
  spent_usd = excluded.spent_usd,
  updated_at = now();
