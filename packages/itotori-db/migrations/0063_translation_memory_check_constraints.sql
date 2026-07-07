-- ITOTORI-145: harden translation-memory CHECK constraints.
--
-- Migration 0023 declared the translation-memory tables but didn't pin the
-- enum-like allowed values (segment status, match kind, reuse status), the
-- numeric match_score range, or the jsonb object-shape of the provenance /
-- cost_impact columns. Direct or HISTORICAL rows could otherwise persist an
-- unknown status / kind / score, and would then poison reuse reads downstream
-- (a "blocked" segment with an "applied" reuse event is structurally
-- inconsistent). Add DB-level CHECK constraints so invalid values are
-- rejected at persist time regardless of caller (TS repo, hand-rolled SQL,
-- or future service callers).
--
-- The reuse_events match_score range matches the deterministic similarity
-- scale used by lexicalSimilarityScore / boundedScore (0..1000 inclusive).

alter table itotori_translation_memory_segments
  add constraint itotori_tm_segments_status_check check (
    status in ('reusable', 'blocked')
  ),
  add constraint itotori_tm_segments_provenance_check check (
    jsonb_typeof(provenance) = 'object'
  );

alter table itotori_translation_memory_reuse_events
  add constraint itotori_tm_reuse_events_match_kind_check check (
    match_kind in ('exact', 'fuzzy')
  ),
  add constraint itotori_tm_reuse_events_match_score_check check (
    match_score >= 0 and match_score <= 1000
  ),
  add constraint itotori_tm_reuse_events_reuse_status_check check (
    reuse_status in ('suggested', 'applied')
  ),
  add constraint itotori_tm_reuse_events_provenance_check check (
    jsonb_typeof(provenance) = 'object'
  ),
  add constraint itotori_tm_reuse_events_cost_impact_check check (
    jsonb_typeof(cost_impact) = 'object'
  );
