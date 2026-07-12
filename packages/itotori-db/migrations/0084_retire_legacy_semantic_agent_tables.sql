-- G-6: semantic enrichment has one durable home: itotori_context_artifacts.
--
-- These agent-specific tables formed a parallel context silo. Their data is
-- intentionally not copied: the central store is the authoritative current
-- and versioned history surface, and retaining shadow rows would make future
-- writes ambiguous. Evidence tables are dropped first to satisfy their FKs.

drop table if exists itotori_scene_summary_cited_units;
drop table if exists itotori_scene_summaries;

drop table if exists itotori_character_bio_evidence;
drop table if exists itotori_character_relationship_evidence;
drop table if exists itotori_character_bios;
drop table if exists itotori_character_relationships;

drop table if exists itotori_route_evidence;
drop table if exists itotori_route_choices;
drop table if exists itotori_route_maps;

drop table if exists itotori_terminology_candidate_evidence;
drop table if exists itotori_terminology_candidates;
