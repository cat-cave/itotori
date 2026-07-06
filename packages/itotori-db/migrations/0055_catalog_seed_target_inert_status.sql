-- recorded-importer-seed-hints-were-benchmark-selectable-prematurely
-- (CATALOG-080): recorded importers (CATALOG-011) author `seedTarget` HINTS
-- that were persisted as `pending` seed targets — directly benchmark-selectable
-- before the readiness-aware CATALOG-004 filtering + explanations had run. A raw,
-- unvetted importer hint could therefore be picked as a benchmark target
-- prematurely.
--
-- Importer hints are now stored as INERT evidence (seed status 'inert') that
-- carries its source-fact provenance but is never directly benchmark-selectable;
-- CATALOG-004 later consumes the inert hint, records a readiness explanation and
-- promotes it to a selectable status. The CHECK constraint on
-- itotori_catalog_seed_targets.status must admit the new 'inert' value.
--
-- @permission-gate catalog.write writes
-- @permission-gate catalog.read reads

alter table itotori_catalog_seed_targets
  drop constraint if exists itotori_catalog_seed_targets_status_check;

alter table itotori_catalog_seed_targets
  add constraint itotori_catalog_seed_targets_status_check check (
    status in ('inert', 'pending', 'queued', 'imported', 'ignored', 'failed')
  );
