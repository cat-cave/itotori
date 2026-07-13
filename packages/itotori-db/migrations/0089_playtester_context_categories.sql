-- Play-tester context corrections persist through the canonical ContextEntry
-- store. Keep the original generated-artifact categories while admitting the
-- glossary, style, and free-form context-note entries written by that loop.
--
-- Migrations 0025 and 0083 declared these as inline column checks, for which
-- PostgreSQL assigned the names below. Drop by name before recreating them so
-- this forward migration safely replaces the old closed category set on both
-- the mutable entry head and its append-only version history.

alter table itotori_context_artifacts
  drop constraint if exists itotori_context_artifacts_category_check;

alter table itotori_context_artifacts
  add constraint itotori_context_artifacts_category_check check (
    category in (
      'scene_summary',
      'character_note',
      'route_map',
      'speaker_label',
      'terminology_candidate',
      'glossary',
      'style',
      'context_note'
    )
  );

alter table itotori_context_entry_versions
  drop constraint if exists itotori_context_entry_versions_category_check;

alter table itotori_context_entry_versions
  add constraint itotori_context_entry_versions_category_check check (
    category in (
      'scene_summary',
      'character_note',
      'route_map',
      'speaker_label',
      'terminology_candidate',
      'glossary',
      'style',
      'context_note'
    )
  );
