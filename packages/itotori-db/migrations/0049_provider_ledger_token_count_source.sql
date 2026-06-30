-- general-audit-1 (genaudit1-00): token-count provenance on the
-- draft-attempt provider ledger.
--
-- Why this exists
-- ---------------
-- PROJECT LAW (Trevor): token counts — like cost — come ONLY from real
-- provider call output, never approximated / defaulted / estimated. Cost
-- has always been strict (assertBilledCost throws; the migration-0041
-- partial-NULL CHECK ties cost_amount to the verbatim usage.cost). TOKENS
-- had a hole: seven agents and the agentic-loop context probe substituted
-- a char/4 `estimateTokens(...)` heuristic (or `?? 0`) when the provider
-- omitted `usage.prompt_tokens` / `usage.completion_tokens`, and that
-- estimate flowed into tokens_in / tokens_out byte-for-byte
-- indistinguishable from a provider-reported count.
--
-- The application layer now throws (assertReportedTokenUsage) instead of
-- estimating, so a real count or a typed error is the only outcome. This
-- column records WHICH real source each persisted count came from, and the
-- CHECK below is the storage-layer belt-and-braces: a row may only carry a
-- token_count_source naming a REAL provenance.
--
-- Real provenances (mirrors providers/types.ts TokenUsage.tokenCountSource
-- and the apps/itotori token-accounting guard):
--   * provider_reported    — live OpenRouter `usage` block (the wire truth).
--   * deterministic_counter — recorded / fake providers counting the real
--                             recorded-or-generated content (a recorded-
--                             bundle replay carries these real counts).
-- The estimate sentinels `estimated` and `unknown` are NOT real counts and
-- are rejected here, exactly as the cost path rejects a fabricated cost.
--
-- Forward-only
-- ------------
-- No rollback path. The column is added NULLABLE: pre-migration rows (and
-- any future row that genuinely recorded no token count, e.g. a cost-only
-- offline row) carry NULL. The CHECK admits NULL OR a real source, so the
-- backfill is the implicit NULL and the constraint passes by construction.
-- New inserts that DO record a token count supply a real source via the
-- typed RecordLedgerEntryInput.tokenCountSource guard.
--
-- @permission-gate draft.write writes
-- @permission-gate catalog.read reads

-- 1. token_count_source text NULL — provenance of tokens_in / tokens_out.
alter table itotori_draft_attempt_provider_ledger
  add column token_count_source text;

-- 2. Domain CHECK: a recorded provenance must name a REAL source. NULL is
--    admitted for pre-migration / no-token rows. The application-layer
--    guard (assertRecordLedgerEntryInput) enforces the same set and
--    additionally requires a non-NULL source whenever a token count is
--    recorded; this CHECK is the storage-layer guarantee that an estimate
--    sentinel can never be smuggled in.
alter table itotori_draft_attempt_provider_ledger
  add constraint itotori_draft_attempt_provider_ledger_token_count_source_check
    check (
      token_count_source is null
      or token_count_source in ('provider_reported', 'deterministic_counter')
    );
