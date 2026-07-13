-- p0-core-purge-reviewer-queue-as-deferral follow-up:
--
-- `itotori_glossary_review_items` was a second, dormant approval taxonomy for
-- terminology proposals. Canonical terminology terms, source references,
-- style guides, and branch-policy glossary-term snapshots remain the durable
-- glossary/context surfaces. Retire the proposal table and the serialized
-- review-item snapshot rather than preserving a parallel human-decision path.
--
-- Historical migrations remain immutable for already-deployed migration
-- ledgers. Dropping the column retains each branch-policy reference's
-- canonical glossary-term snapshot and provenance; dropping the table removes
-- its owned foreign keys and indexes without cascading into those canonical
-- tables.

alter table if exists itotori_branch_policy_glossary_references
  drop column if exists glossary_review_item_refs;

drop table if exists itotori_glossary_review_items;
