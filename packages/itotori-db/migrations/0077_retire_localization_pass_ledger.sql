-- p0-core-attempt-and-outcome-journal follow-up:
--
-- The normalized execution journal is the only durable localization run
-- projection. Retire the lossy selected-body pass table rather than retaining
-- a second reader/writer path. Historical migration 0058 remains immutable so
-- already-migrated databases retain their checksum history; this forward
-- migration removes its physical table everywhere.
--
-- Also close the selected-candidate integrity hole. The FK is deferred because
-- outcomes and their candidates are inserted atomically in mutually-dependent
-- order; it is still checked at transaction commit and rejects a dangling or
-- cross-outcome selected candidate.

alter table itotori_written_unit_outcomes
  add constraint itotori_written_unit_outcomes_selected_candidate_fkey
  foreign key (journal_outcome_id, selected_candidate_id)
  references itotori_translation_candidates (journal_outcome_id, candidate_id)
  deferrable initially deferred;

drop table if exists itotori_localization_pass_ledger;
