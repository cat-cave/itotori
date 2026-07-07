-- CATALOG-092: source-side release-mapping traversal index.
--
-- Portability queries — "what can this source release map to" — drive
-- translation porting and patch-target discovery by filtering
-- itotori_catalog_release_mappings on (source_release_id, relation_kind): e.g.
-- relation_kind = 'translation_of' (translation porting) or 'patch_targets'
-- (patch-target discovery). The existing indexes cover the TARGET side
-- (itotori_catalog_release_mappings_target_idx on (target_release_id,
-- relation_kind)) and the WORK scope (itotori_catalog_release_mappings_work_idx
-- on (work_id, relation_kind)), but no index leads with source_release_id
-- paired with relation_kind.
--
-- NOT a duplicate of the unique itotori_catalog_release_mappings_relation_idx
-- (source_release_id, target_release_id, relation_kind): that index exists to
-- enforce the source/target/kind natural key, and relation_kind is its THIRD
-- column. A (source_release_id, relation_kind) predicate can only use that
-- index's source_release_id prefix and must then SCAN every target_release_id
-- for that source, filtering relation_kind afterward — unbounded traversal for
-- any source with many mapped targets. This dedicated (source_release_id,
-- relation_kind) index makes relation_kind a second index KEY so the
-- portability lookup seeks the (source, kind) bucket directly. It mirrors the
-- target-side index exactly, closing the symmetric source-side traversal gap.

create index if not exists itotori_catalog_release_mappings_source_idx
  on itotori_catalog_release_mappings(source_release_id, relation_kind);
