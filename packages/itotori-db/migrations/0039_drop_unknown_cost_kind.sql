-- ITOTORI-225: Narrow the cost-kind enum to ('billed', 'zero').
--
-- The 2026-06-25 OpenRouter cost-tracking audit (docs/audits/openrouter-
-- cost-tracking-audit-2026-06-25.md §3 N1) and the standing rule from
-- Trevor — "there should never be a single hardcoded model cost anywhere
-- in this repo... there is never a reason to estimate, as it's always
-- possible to know the exact, real spend" — together demand that every
-- ledger row carry either a real upstream charge ('billed') or no charge
-- at all ('zero'). The legacy values 'provider_estimate', 'local_estimate',
-- and 'unknown' have no place in a system where the real cost is always
-- queryable.
--
-- Backfill rules (operator review of NULL amounts is mandatory):
--   * provider_estimate / local_estimate rows with a non-null
--     amount_micros_usd are reclassified as 'billed' — they recorded a
--     real spend amount, just under the wrong label.
--   * unknown rows with a non-null amount_micros_usd are also reclassified
--     as 'billed'; the amount is the real charge that was mistakenly
--     tagged 'unknown'.
--   * Any row in the legacy three-value set with a NULL amount aborts the
--     migration: there is no automatic way to tell whether such a row was
--     a failed pre-billing request (should become 'zero') or a missed
--     billed spend (operator must inspect the source artifact). The audit
--     explicitly forbids defaulting to 0.
--
-- After backfill the CHECK constraint is tightened to ('billed', 'zero')
-- and the amount-CHECK to "amount_micros_usd is not null and >= 0; zero
-- entries must store 0". This forecloses the legacy enum at the storage
-- layer so a future application-level regression cannot silently re-
-- introduce 'unknown'.
--
-- @permission-gate runtime.ingest writes
-- @permission-gate catalog.read reads

-- 1. Refuse the migration if any legacy row has a NULL amount; force the
--    operator to triage it manually before re-running. This `do` block
--    raises before any UPDATE fires, so the migration is a no-op until
--    the inputs are clean.
do $$
declare
  null_amount_count integer;
begin
  select count(*)
    into null_amount_count
  from itotori_cost_ledger_entries
  where cost_kind in ('provider_estimate', 'local_estimate', 'unknown')
    and amount_micros_usd is null;

  if null_amount_count > 0 then
    raise exception
      'ITOTORI-225: % rows in itotori_cost_ledger_entries have legacy cost_kind with NULL amount_micros_usd; operator must classify each as billed (with a real amount) or zero before this migration can run',
      null_amount_count;
  end if;
end$$;

-- 2. Reclassify legacy rows that have a real amount as 'billed'.
update itotori_cost_ledger_entries
  set cost_kind = 'billed'
  where cost_kind in ('provider_estimate', 'local_estimate', 'unknown')
    and amount_micros_usd is not null;

-- 3. Drop the old constraints and replace them with the narrowed ones.
alter table itotori_cost_ledger_entries
  drop constraint if exists itotori_cost_ledger_cost_kind_check;
alter table itotori_cost_ledger_entries
  drop constraint if exists itotori_cost_ledger_amount_check;

alter table itotori_cost_ledger_entries
  add constraint itotori_cost_ledger_cost_kind_check check (
    cost_kind in ('billed', 'zero')
  );

-- amount_micros_usd is non-null for both kinds; zero rows store exactly 0.
alter table itotori_cost_ledger_entries
  add constraint itotori_cost_ledger_amount_check check (
    amount_micros_usd is not null
    and amount_micros_usd >= 0
    and (cost_kind <> 'zero' or amount_micros_usd = 0)
  );
