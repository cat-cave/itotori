-- ITOTORI-232: schema-level enforcement of real cost on the draft-attempt
-- provider ledger.
--
-- Why this exists
-- ---------------
-- Per docs/openrouter-integration.md §5 (canonical real-cost contract) and
-- docs/audits/openrouter-cost-tracking-audit-2026-06-25.md §3 N5 / §2.6
-- (no schema constraint tying cost_amount to usage.cost), the application
-- layer can already guarantee cost_amount mirrors the originating
-- OpenRouter usage.cost (ITOTORI-225 / ITOTORI-228). This node makes the
-- database itself refuse to accept a row that violates the contract, so a
-- future code regression cannot silently re-introduce fake cost.
--
-- What the storage layer now enforces:
--
--   (a) cost_unit MUST be the literal 'usd'. USD-only is the alpha
--       commitment (cost-audit §6.1); future currency support is its own
--       node. There is no nullable escape hatch.
--   (b) usage_response_json jsonb NOT NULL holds the originating OR
--       response's full `usage` block (prompt_tokens, completion_tokens,
--       cost, cost_details with caching annotations, prompt_tokens_details
--       with caching annotations). The application writes this end-to-end
--       from OpenRouterProvider.invoke; the recorded-bundle path mirrors
--       it verbatim (bundle schema v2 → v3). Pre-migration rows are
--       backfilled with the TYPED sentinel `{"_pre_itotori_232": true}`
--       so a downstream consumer can tell them apart from real captured
--       usage blocks; we do NOT synthesise a fake usage shape.
--   (c) cost_amount MUST equal (usage_response_json->>'cost')::numeric
--       within 1e-9 USD whenever the usage_response_json carries a real
--       `cost` field. The partial CHECK exempts rows where `cost` is
--       absent (the backfill sentinel; offline / local / fake providers
--       that never billed). New OR-derived rows MUST populate `cost` in
--       usage_response_json so the check fires.
--
-- Tolerance: the 1e-9 threshold is the audit-mandated tight bound. It is
-- NOT a "rounding fudge" — both sides of the equality originate from the
-- same `usage.cost` value upstream, so any drift larger than 1e-9 means
-- the application either dropped precision or wrote a different cost than
-- the response reported. That MUST fail loudly; the standing rule from
-- Trevor is "no tolerance widening" and the audit forecloses any softer
-- bound.
--
-- Model-ledger CHECK from migration 0006
-- --------------------------------------
-- Migration 0006 created itotori_cost_ledger_entries with a CHECK
-- enumerating `('billed', 'provider_estimate', 'local_estimate', 'zero',
-- 'unknown')`. Migration 0039 (ITOTORI-225) ALREADY narrowed that CHECK
-- to `('billed', 'zero')`. We re-verified by reading 0039; the legacy
-- enum values no longer appear in any live CHECK constraint, so this
-- migration does NOT re-touch itotori_cost_ledger_entries. Verifying it
-- here keeps the audit trail honest (the DAG asked us to confirm) without
-- inventing a no-op DDL.
--
-- Forward-only
-- ------------
-- No rollback path. ADD column + ADD checks + (verified-no-op) DROP of
-- legacy enum land in one transaction; if Postgres rolls back mid-way the
-- whole thing reverts, which is the desired behaviour.
--
-- @permission-gate draft.write writes
-- @permission-gate catalog.read reads

-- 1. cost_unit = 'usd' CHECK on the draft-attempt provider ledger.
--    USD-only per cost-audit §6.1 (alpha commitment).
alter table itotori_draft_attempt_provider_ledger
  add constraint itotori_draft_attempt_provider_ledger_cost_unit_usd_check
    check (cost_unit = 'usd');

-- 2. usage_response_json jsonb NOT NULL. Backfilled to the sentinel
--    `{"_pre_itotori_232": true}` so pre-migration rows are visibly
--    flagged; the partial-NULL CHECK on cost_amount exempts them because
--    the sentinel carries no `cost` key.
--
--    The default is dropped immediately after the ALTER so future inserts
--    MUST supply usage_response_json explicitly (the application layer
--    makes the field required on RecordLedgerEntryInput; this is the
--    storage-layer belt-and-braces).
alter table itotori_draft_attempt_provider_ledger
  add column usage_response_json jsonb not null
    default '{"_pre_itotori_232": true}'::jsonb;

alter table itotori_draft_attempt_provider_ledger
  alter column usage_response_json drop default;

-- 3. usage_response_json must be a JSON object (not an array, not a
--    primitive). Catches accidental writes of `null` cast through jsonb or
--    a stringified payload.
alter table itotori_draft_attempt_provider_ledger
  add constraint itotori_draft_attempt_provider_ledger_usage_response_object_check
    check (jsonb_typeof(usage_response_json) = 'object');

-- 4. The load-bearing equality check: when usage_response_json carries a
--    real `cost` field, cost_amount must equal it within 1e-9 USD. The
--    partial-NULL pattern exempts:
--      (a) the backfill sentinel (pre-ITOTORI-232 rows);
--      (b) offline / local / fake provider rows that genuinely never
--          billed (their usage_response_json carries no `cost` key, and
--          their cost_amount is 0).
--    Future OR-derived rows MUST populate `cost` in usage_response_json
--    so the check fires; refusing to populate it is an application-layer
--    bug, not a CHECK loophole.
alter table itotori_draft_attempt_provider_ledger
  add constraint itotori_draft_attempt_provider_ledger_cost_matches_usage_check
    check (
      usage_response_json->>'cost' is null
      or abs(cost_amount - (usage_response_json->>'cost')::numeric) < 1e-9
    );
