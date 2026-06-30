-- catalog-generic-conflicts-defaulted-to-languagestatus-kind: add a neutral
-- 'unknown' conflict kind.
--
-- conflictInputs previously defaulted an absent conflictKind to
-- 'language_status' (packages/itotori-db/src/services/catalog-recorded-
-- importers.ts), so every untyped generic conflict produced by
-- conflictFactsFromPayload was persisted as a language-status conflict
-- regardless of its actual nature — false labelling. The application now
-- falls back to a neutral 'unknown' kind instead. The CHECK constraint on
-- itotori_catalog_conflicts.conflict_kind must admit that value so honest,
-- untyped conflicts can be stored without being mislabelled.
--
-- @permission-gate catalog.write writes
-- @permission-gate catalog.read reads

alter table itotori_catalog_conflicts
  drop constraint if exists itotori_catalog_conflicts_kind_check;

alter table itotori_catalog_conflicts
  add constraint itotori_catalog_conflicts_kind_check check (
    conflict_kind in ('external_id', 'language_status', 'release', 'title', 'engine', 'unknown')
  );
