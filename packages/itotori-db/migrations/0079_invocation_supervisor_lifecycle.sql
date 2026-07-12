-- p0-core-universal-invocation-supervisor-retry — durable invocation lifecycle.
--
-- Run + planned-unit rows are frozen before dispatch. Physical attempts are
-- then inserted in a dispatching state before the provider request and
-- completed in place with the real served/cost/validation facts. A planned
-- unit deliberately has no source/target body or candidate column: only the
-- canonical terminal WrittenUnitOutcome may contain selected target text.
--
-- @permission-gate draft.write writes
-- @permission-gate catalog.read reads

alter table itotori_localization_journal_runs
  add column frozen_scope jsonb,
  add column routing_policy jsonb,
  add column cost_policy jsonb,
  add column status text not null default 'running',
  add column paused_blocker jsonb,
  add column updated_at timestamptz not null default now();

alter table itotori_localization_journal_runs
  add constraint itotori_localization_journal_runs_status_known
    check (status in ('running', 'paused', 'finalizing', 'succeeded', 'failed', 'aborted')),
  add constraint itotori_localization_journal_runs_frozen_scope_json
    check (frozen_scope is null or jsonb_typeof(frozen_scope) in ('object', 'array')),
  add constraint itotori_localization_journal_runs_routing_policy_json
    check (routing_policy is null or jsonb_typeof(routing_policy) = 'object'),
  add constraint itotori_localization_journal_runs_cost_policy_json
    check (cost_policy is null or jsonb_typeof(cost_policy) = 'object'),
  add constraint itotori_localization_journal_runs_paused_blocker_shape
    check (
      paused_blocker is null or (
        jsonb_typeof(paused_blocker) = 'object'
        and paused_blocker->>'kind' in ('budget_cap', 'provider_outage', 'itotori_bug')
        and length(btrim(coalesce(paused_blocker->>'detail', ''))) > 0
        and length(btrim(coalesce(paused_blocker->>'evidence', ''))) > 0
        and length(btrim(coalesce(paused_blocker->>'raisedAt', ''))) > 0
        and length(btrim(coalesce(paused_blocker->>'operatorAction', ''))) > 0
      )
    ),
  add constraint itotori_localization_journal_runs_pause_consistency
    check ((status = 'paused') = (paused_blocker is not null));

create table if not exists itotori_localization_journal_run_units (
  run_id text not null references itotori_localization_journal_runs(run_id) on delete cascade,
  bridge_unit_id text not null,
  source_unit_key text,
  unit_ordinal integer not null,
  state text not null default 'pending',
  next_action jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (run_id, bridge_unit_id),
  constraint itotori_localization_journal_run_units_bridge_id_non_empty
    check (length(btrim(bridge_unit_id)) > 0),
  constraint itotori_localization_journal_run_units_source_key_non_empty
    check (source_unit_key is null or length(btrim(source_unit_key)) > 0),
  constraint itotori_localization_journal_run_units_ordinal_non_negative
    check (unit_ordinal >= 0),
  constraint itotori_localization_journal_run_units_state_known
    check (state in ('pending', 'written')),
  constraint itotori_localization_journal_run_units_next_action_shape
    check (
      next_action is null or (
        jsonb_typeof(next_action) = 'object'
        and length(btrim(coalesce(next_action->>'kind', ''))) > 0
      )
    ),
  constraint itotori_localization_journal_run_units_written_action_consistency
    check (state <> 'written' or next_action is null),
  constraint itotori_localization_journal_run_units_run_ordinal_unique
    unique (run_id, unit_ordinal)
);

create index if not exists itotori_localization_journal_run_units_run_state_idx
  on itotori_localization_journal_run_units (run_id, state, unit_ordinal);

-- Existing terminal journal history predates planned-unit seeding. Backfill a
-- slot for every unit that has either an attempt or a written outcome, keeping
-- deterministic per-run order and never inventing target text or candidates.
with existing_unit_scope as (
  select
    unit.run_id,
    unit.bridge_unit_id,
    max(unit.source_unit_key) as source_unit_key,
    bool_or(unit.is_written) as is_written
  from (
    select run_id, bridge_unit_id, source_unit_key, true as is_written
    from itotori_written_unit_outcomes
    union all
    select run_id, bridge_unit_id, null::text as source_unit_key, false as is_written
    from itotori_llm_attempts
  ) unit
  group by unit.run_id, unit.bridge_unit_id
), ranked_unit_scope as (
  select
    run_id,
    bridge_unit_id,
    source_unit_key,
    is_written,
    row_number() over (partition by run_id order by bridge_unit_id) - 1 as unit_ordinal
  from existing_unit_scope
)
insert into itotori_localization_journal_run_units (
  run_id,
  bridge_unit_id,
  source_unit_key,
  unit_ordinal,
  state,
  next_action
)
select
  run_id,
  bridge_unit_id,
  source_unit_key,
  unit_ordinal,
  case when is_written then 'written' else 'pending' end,
  null
from ranked_unit_scope
on conflict (run_id, bridge_unit_id) do nothing;

alter table itotori_llm_attempts
  add column lifecycle_state text not null default 'completed';

alter table itotori_llm_attempts
  alter column model_id drop not null,
  alter column provider_id drop not null,
  alter column cost_usd drop not null,
  alter column validation_result drop not null,
  alter column completed_at drop not null;

alter table itotori_llm_attempts
  add constraint itotori_llm_attempts_lifecycle_known
    check (lifecycle_state in ('dispatching', 'completed')),
  add constraint itotori_llm_attempts_lifecycle_facts_consistent
    check (
      (
        lifecycle_state = 'dispatching'
        and model_id is null
        and provider_id is null
        and cost_usd is null
        and validation_result is null
        and completed_at is null
      ) or (
        lifecycle_state = 'completed'
        and zdr is not null
        and validation_result is not null
        and completed_at is not null
      )
    ),
  add constraint itotori_llm_attempts_served_pair_consistent
    check ((model_id is null) = (provider_id is null)),
  add constraint itotori_llm_attempts_cost_has_served_pair
    check (cost_usd is null or model_id is not null),
  add constraint itotori_llm_attempts_cost_kind_has_cost
    check (cost_kind is null or cost_usd is not null),
  add constraint itotori_llm_attempts_planned_unit_fkey
    foreign key (run_id, bridge_unit_id)
    references itotori_localization_journal_run_units(run_id, bridge_unit_id)
    on delete cascade;

alter table itotori_written_unit_outcomes
  add constraint itotori_written_unit_outcomes_planned_unit_fkey
    foreign key (run_id, bridge_unit_id)
    references itotori_localization_journal_run_units(run_id, bridge_unit_id)
    on delete cascade;

create index if not exists itotori_llm_attempts_dispatching_idx
  on itotori_llm_attempts (run_id, lifecycle_state, started_at);
