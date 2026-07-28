-- Reservation capacity is only pre-dispatch exposure. A terminal attempt with
-- no provider-confirmed bill releases it explicitly; its LLM attempt row keeps
-- the durable unknown-cost and failure evidence.

alter table itotori_project_run_cost_reservations
  add column released_at timestamptz;

alter table itotori_project_run_cost_reservations
  drop constraint itotori_project_run_cost_reservations_state_known,
  drop constraint itotori_project_run_cost_reservations_settlement_shape;

alter table itotori_project_run_cost_reservations
  add constraint itotori_project_run_cost_reservations_state_known
    check (state in ('reserved', 'settled', 'released')),
  add constraint itotori_project_run_cost_reservations_terminal_shape
    check (
      (state = 'reserved' and settled_micros_usd is null and settled_at is null and released_at is null)
      or
      (state = 'settled' and settled_micros_usd is not null and settled_at is not null and released_at is null)
      or
      (state = 'released' and settled_micros_usd is null and settled_at is null and released_at is not null)
    );
