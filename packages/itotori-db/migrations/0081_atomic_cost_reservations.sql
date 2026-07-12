-- p0-core-atomic-cost-reservation-and-fallback — durable exact-decimal
-- run-cost accounting.
--
-- A cost account is owned by one localization journal run. Reservations are
-- made before a physical dispatch, alongside the dispatching attempt row, so
-- concurrent drivers cannot admit `spent + reserved` beyond the run cap.
-- Money is unconstrained PostgreSQL NUMERIC: TypeScript crosses this boundary
-- only as canonical decimal strings, never rounded integer micros.
--
-- `billing_state` deliberately distinguishes a confirmed zero-charge from an
-- absent/unknown settlement. An unknown completion retains its reservation
-- until a later reconciler supplies the provider's billed cost.
--
-- @permission-gate draft.write writes
-- @permission-gate catalog.read reads

alter table itotori_llm_attempts
  add column billing_state text;

alter table itotori_llm_attempts
  add constraint itotori_llm_attempts_billing_state_known
    check (billing_state is null or billing_state in ('known', 'unknown'));

-- The physical attempt id is globally unique already. This redundant scoped
-- key lets the reservation FK prove that its account/run and attempt belong
-- to the same durable run.
alter table itotori_llm_attempts
  add constraint itotori_llm_attempts_run_attempt_unique
    unique (run_id, attempt_id);

create table if not exists itotori_localization_run_cost_accounts (
  run_id text primary key references itotori_localization_journal_runs(run_id) on delete cascade,
  cap_usd numeric,
  spent_usd numeric not null default 0,
  reserved_usd numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint itotori_localization_run_cost_accounts_cap_non_negative
    check (cap_usd is null or cap_usd >= 0),
  constraint itotori_localization_run_cost_accounts_spent_non_negative
    check (spent_usd >= 0),
  constraint itotori_localization_run_cost_accounts_reserved_non_negative
    check (reserved_usd >= 0)
);

create table if not exists itotori_localization_cost_reservations (
  reservation_id text primary key,
  run_id text not null references itotori_localization_run_cost_accounts(run_id) on delete cascade,
  attempt_id text not null,
  reserved_usd numeric not null,
  reconciled_usd numeric,
  state text not null default 'reserved',
  created_at timestamptz not null default now(),
  reconciled_at timestamptz,
  constraint itotori_localization_cost_reservations_run_attempt_unique
    unique (run_id, attempt_id),
  constraint itotori_localization_cost_reservations_reserved_non_negative
    check (reserved_usd >= 0),
  constraint itotori_localization_cost_reservations_reconciled_non_negative
    check (reconciled_usd is null or reconciled_usd >= 0),
  constraint itotori_localization_cost_reservations_state_known
    check (state in ('reserved', 'reconciled')),
  constraint itotori_localization_cost_reservations_reconciliation_consistency
    check (
      (state = 'reserved' and reconciled_usd is null and reconciled_at is null)
      or
      (state = 'reconciled' and reconciled_usd is not null and reconciled_at is not null)
    ),
  constraint itotori_localization_cost_reservations_attempt_fkey
    foreign key (run_id, attempt_id)
    references itotori_llm_attempts(run_id, attempt_id)
    on delete cascade
);

create index if not exists itotori_localization_cost_reservations_run_state_idx
  on itotori_localization_cost_reservations (run_id, state, created_at);
