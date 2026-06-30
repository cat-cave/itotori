-- ITOTORI-220: (modelId, providerId) pair integrity on persisted batches
-- and the draft-attempt provider ledger.
--
-- Two seams dropped or faked the provider half of the pair:
--
--   1. translation_batches had NO provider_id column. The planner pins a
--      real (modelId, providerId) pair on batch.modelProfile, but
--      persistence only wrote model_provider_family + model_id, so the
--      pinned provider was LOST on every persisted batch. We add a NOT
--      NULL provider_id with NO sentinel default.
--
--   2. draft_attempt_provider_ledger.provider_id was NOT NULL DEFAULT
--      'unknown'. The default silently recorded a FAKE (model, 'unknown')
--      pair for any insert that omitted the real served provider — the
--      no-fallback anti-pattern the standing model-provider-pair rule
--      forbids. We drop the default so a missing providerId fails loud;
--      callers must supply the provider that ACTUALLY served the call.
--
-- Backfill posture (no-sentinel law): we never invent a provider. For
-- translation_batches the rows are regenerable planner artifacts that
-- never captured a provider — there is no truth to backfill — so the
-- pre-fix rows are deleted (cascading to units + context refs) and the
-- column is added NOT NULL with no default on the now-empty table. For
-- the ledger we also purge any legacy 'unknown' rows written by the old
-- migration-0038 backfill so no fake pair survives anywhere.
--
-- @permission-gate draft.write writes
-- @permission-gate catalog.read reads

-- 1. translation_batches.provider_id (NOT NULL, no sentinel default).
delete from itotori_translation_batches;

alter table itotori_translation_batches
  add column provider_id text not null;

-- 2. draft_attempt_provider_ledger.provider_id: drop the 'unknown' default
--    and purge the legacy fake-pair rows it produced.
delete from itotori_draft_attempt_provider_ledger
  where provider_id = 'unknown';

alter table itotori_draft_attempt_provider_ledger
  alter column provider_id drop default;
