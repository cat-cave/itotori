-- ITOTORI-220: Required (modelId, providerId) pair on every draft attempt
-- ledger row.
--
-- Per docs/proposals/alpha-gap-analysis-2026-06-24.md §3 ITOTORI-NEW-Apair
-- and the standing feedback-model-provider-pair rule: every model
-- invocation seam declares both a model id AND a pinned upstream provider
-- id. Calling out by model alone is a P0 architectural violation because
-- OpenRouter is a marketplace and the same model id from different
-- providers has different cost, latency, throughput, and structured-
-- output support. The ledger now captures the providerId alongside the
-- model id so an audit can verify the same (model, provider) pair would
-- be used on rerun.
--
-- Backfill: any row written before this migration receives 'unknown' as a
-- placeholder so the NOT NULL constraint can be added without losing
-- history; new rows must populate `provider_id` via the repository which
-- requires it in its typed input.
--
-- Index: (provider_id, model_provider_family) supports the
-- sumCostByProject `byProvider` aggregation added in the same change.
--
-- @permission-gate draft.write writes
-- @permission-gate catalog.read reads

alter table itotori_draft_attempt_provider_ledger
  add column if not exists provider_id text;

update itotori_draft_attempt_provider_ledger
  set provider_id = 'unknown'
  where provider_id is null;

alter table itotori_draft_attempt_provider_ledger
  alter column provider_id set not null;

alter table itotori_draft_attempt_provider_ledger
  alter column provider_id set default 'unknown';

create index if not exists itotori_draft_attempt_provider_ledger_provider_family_idx
  on itotori_draft_attempt_provider_ledger (provider_id, model_provider_family);
