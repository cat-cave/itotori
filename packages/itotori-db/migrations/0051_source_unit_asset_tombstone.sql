-- ITOTORI-060: tombstone / archive source units + assets on bridge reimport
-- instead of hard-DELETEing them.
--
-- The finding
-- -----------
-- When a bridge REIMPORT ingested a bundle that OMITTED previously-present
-- source units or assets, importSourceBundle() HARD-DELETED the omitted rows:
--
--     delete from itotori_source_units where bridge_unit_id in (<removed>)
--     delete from itotori_assets        where asset_id      in (<removed>)
--
-- Deleting a source unit CASCADE-destroyed its dependent history:
--   * itotori_locale_branch_units            (on delete cascade) — the
--     locale-branch translation rows / draft targets for that unit
--   * itotori_runtime_evidence_bridge_unit_refs (on delete cascade) — runtime
--     evidence references proving the unit was observed at runtime
--   * itotori_translation_memory_reuse_events   (on delete cascade)
--   * itotori_exact_search_documents            (on delete cascade)
-- and SET NULL-severed the back-pointers on TM segments, terminology source
-- references, artifacts, runtime evidence items, runtime validation findings
-- and feedback reports. That silently threw away locale-branch and
-- runtime-evidence HISTORY every time an author reimported a smaller bundle.
--
-- The fix: retention via a tombstone timestamp. A reimport that omits a
-- previously-present unit/asset now UPDATEs `removed_at = now()` instead of
-- deleting the row, so NONE of the cascades fire and every dependent record is
-- preserved, still pointing at the now-tombstoned row. Re-importing a bundle
-- that RE-ADDS the unit/asset clears `removed_at` back to NULL (revive), rather
-- than duplicating the row.
--
-- Active-set semantics
-- --------------------
-- `removed_at IS NULL`  = active / current member of the latest reimported
--                         bundle (what "the reimport reflects").
-- `removed_at IS NOT NULL` = archived; excluded from active/current queries but
--                            fully visible to history queries.
--
-- Forward-only. Both columns are added NULLABLE; pre-migration rows backfill to
-- NULL (active) by construction, matching the pre-existing behaviour where
-- every persisted row was active.
--
-- @permission-gate catalog.write writes
-- @permission-gate catalog.read reads

-- 1. Source-unit tombstone column.
alter table itotori_source_units
  add column removed_at timestamptz;

-- 2. Asset tombstone column.
alter table itotori_assets
  add column removed_at timestamptz;

-- 3. Partial indexes over the active set, so active/current queries scoped by
--    source bundle stay cheap while tombstoned rows accumulate for history.
create index if not exists itotori_source_units_active_idx
  on itotori_source_units (source_bundle_id)
  where removed_at is null;

create index if not exists itotori_assets_active_idx
  on itotori_assets (source_bundle_id)
  where removed_at is null;
