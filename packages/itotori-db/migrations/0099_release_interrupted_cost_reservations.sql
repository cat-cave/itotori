-- A lease-takeover resume releases the worst-case capacity held by a physical
-- dispatch it durably closes as interrupted. Keep that durable fact distinct
-- from a settled bill: `released` no longer consumes reserved_usd, but remains
-- unresolved until a later exact provider settlement moves it to reconciled.

alter table itotori_localization_cost_reservations
  drop constraint if exists itotori_localization_cost_reservations_state_known,
  drop constraint if exists itotori_localization_cost_reservations_reconciliation_consistency;

alter table itotori_localization_cost_reservations
  add constraint itotori_localization_cost_reservations_state_known
    check (state in ('reserved', 'released', 'reconciled')),
  add constraint itotori_localization_cost_reservations_reconciliation_consistency
    check (
      (state in ('reserved', 'released') and reconciled_usd is null and reconciled_at is null)
      or
      (state = 'reconciled' and reconciled_usd is not null and reconciled_at is not null)
    );
