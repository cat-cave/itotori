-- terminal finalizer integrity hardening: persisted result revisions only.
--
-- A patch member may reference only an immutable result-revision row bound to
-- the same written outcome, run, and unit. Existing canonical outcomes are
-- normalized into revision rows once during migration; runtime reads/builds
-- never manufacture a missing revision.
--
-- @permission-gate draft.write writes
-- @permission-gate catalog.read reads

create table itotori_localization_result_revisions (
  result_revision_id text primary key,
  journal_outcome_id text not null,
  run_id text not null,
  bridge_unit_id text not null,
  selected_candidate_id text not null,
  target_body text not null,
  origin text not null default 'run_written_outcome',
  created_at timestamptz not null default now(),
  constraint itotori_localization_result_revisions_id_non_empty
    check (length(btrim(result_revision_id)) > 0),
  constraint itotori_localization_result_revisions_target_non_empty
    check (length(btrim(target_body)) > 0),
  constraint itotori_localization_result_revisions_origin_known
    check (origin = 'run_written_outcome'),
  constraint itotori_localization_result_revisions_outcome_unique
    unique (journal_outcome_id),
  constraint itotori_localization_result_revisions_revision_scope_unique
    unique (result_revision_id, journal_outcome_id, run_id, bridge_unit_id),
  constraint itotori_localization_result_revisions_outcome_fkey
    foreign key (journal_outcome_id, run_id, bridge_unit_id)
    references itotori_written_unit_outcomes(journal_outcome_id, run_id, bridge_unit_id)
    on delete cascade,
  constraint itotori_localization_result_revisions_selected_candidate_fkey
    foreign key (journal_outcome_id, selected_candidate_id)
    references itotori_translation_candidates(journal_outcome_id, candidate_id)
    on delete cascade
);

create index itotori_localization_result_revisions_run_unit_idx
  on itotori_localization_result_revisions (run_id, bridge_unit_id);

-- Outcomes committed before this normalization already contain the immutable
-- selected candidate and written timestamp. Materialize that exact persisted
-- fact; do not infer a revision during a finalizer read or patch build.
insert into itotori_localization_result_revisions (
  result_revision_id,
  journal_outcome_id,
  run_id,
  bridge_unit_id,
  selected_candidate_id,
  target_body,
  origin,
  created_at
)
select
  'run-result:' || outcome.run_id || ':' || outcome.bridge_unit_id,
  outcome.journal_outcome_id,
  outcome.run_id,
  outcome.bridge_unit_id,
  outcome.selected_candidate_id,
  candidate.body,
  'run_written_outcome',
  outcome.written_at
from itotori_written_unit_outcomes outcome
join itotori_translation_candidates candidate
  on candidate.journal_outcome_id = outcome.journal_outcome_id
 and candidate.candidate_id = outcome.selected_candidate_id;

alter table itotori_localization_patch_version_units
  drop constraint itotori_localization_patch_version_units_revision_deterministic;

alter table itotori_localization_patch_version_units
  add constraint itotori_localization_patch_version_units_result_revision_fkey
  foreign key (result_revision_id, journal_outcome_id, run_id, bridge_unit_id)
  references itotori_localization_result_revisions(
    result_revision_id,
    journal_outcome_id,
    run_id,
    bridge_unit_id
  );
