-- p0-core-attempt-and-outcome-journal — durable, lossless execution journal.
--
-- One physical provider dispatch produces one itotori_llm_attempts row.
-- A written unit persists its real selected body, every candidate, permanent
-- QA annotations (including raw rationale/evidence), resolved context refs,
-- and speaker-label provenance. This deliberately does not reuse the legacy
-- draft-job/provider-ledger/pass-ledger tables: those rows cannot attest a
-- complete N-attempt / written-outcome projection.
--
-- Exact money discipline: cost_usd is unconstrained PostgreSQL NUMERIC, never
-- integer micros or a fixed-scale NUMERIC. The TypeScript boundary carries it
-- as a decimal string, avoiding a JS-number precision/rounding path.
--
-- @permission-gate draft.write writes
-- @permission-gate catalog.read reads

create table if not exists itotori_localization_journal_runs (
  run_id text primary key,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  locale_branch_id text not null references itotori_locale_branches(locale_branch_id) on delete cascade,
  source_revision_id text not null references itotori_source_revisions(source_revision_id) on delete restrict,
  target_locale text not null,
  created_at timestamptz not null default now(),
  constraint itotori_localization_journal_runs_run_id_non_empty check (length(run_id) > 0),
  constraint itotori_localization_journal_runs_target_locale_non_empty check (length(target_locale) > 0)
);

create index if not exists itotori_localization_journal_runs_branch_created_idx
  on itotori_localization_journal_runs (locale_branch_id, created_at);

create index if not exists itotori_localization_journal_runs_project_created_idx
  on itotori_localization_journal_runs (project_id, created_at);

create table if not exists itotori_llm_attempts (
  -- The provider-run id is the physical-call identity. Candidates refer to
  -- this attempt_id directly, so no surrogate/id translation can lose it.
  attempt_id text primary key,
  run_id text not null references itotori_localization_journal_runs(run_id) on delete cascade,
  -- The shipped whole-project driver can journal raw bridge units before any
  -- source-unit SQL projection exists, so frozen-scope identity is text rather
  -- than a source_units FK.
  bridge_unit_id text not null,
  stage text not null,
  agent_label text not null,
  logical_call_id text not null,
  attempt_index integer not null,
  model_id text not null,
  provider_id text not null,
  provider_run_id text not null,
  cost_usd numeric not null,
  tokens_in integer,
  tokens_out integer,
  zdr boolean not null,
  finish_state text,
  refusal_state text,
  validation_result text not null,
  failure_class text,
  retry_decision text,
  retry_delay_ms integer,
  artifact_ref text,
  error_classes jsonb not null default '[]'::jsonb,
  started_at timestamptz not null,
  completed_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint itotori_llm_attempts_id_non_empty check (length(attempt_id) > 0),
  constraint itotori_llm_attempts_stage_non_empty check (length(stage) > 0),
  constraint itotori_llm_attempts_agent_label_non_empty check (length(agent_label) > 0),
  constraint itotori_llm_attempts_logical_call_id_non_empty check (length(logical_call_id) > 0),
  constraint itotori_llm_attempts_attempt_index_non_negative check (attempt_index >= 0),
  constraint itotori_llm_attempts_model_id_non_empty check (length(model_id) > 0),
  constraint itotori_llm_attempts_provider_id_non_empty check (length(provider_id) > 0),
  constraint itotori_llm_attempts_provider_run_id_non_empty check (length(provider_run_id) > 0),
  constraint itotori_llm_attempts_cost_non_negative check (cost_usd >= 0),
  constraint itotori_llm_attempts_tokens_in_non_negative check (tokens_in is null or tokens_in >= 0),
  constraint itotori_llm_attempts_tokens_out_non_negative check (tokens_out is null or tokens_out >= 0),
  constraint itotori_llm_attempts_retry_delay_non_negative check (retry_delay_ms is null or retry_delay_ms >= 0),
  constraint itotori_llm_attempts_error_classes_array check (jsonb_typeof(error_classes) = 'array'),
  constraint itotori_llm_attempts_validation_result_known check (
    validation_result in ('accepted', 'schema_invalid', 'semantic_invalid', 'provider_failed', 'not_evaluated')
  ),
  constraint itotori_llm_attempts_retry_decision_known check (
    retry_decision is null or retry_decision in ('retry', 'advance', 'write', 'pause')
  ),
  -- Candidate provenance must resolve to the same frozen run/unit scope.
  -- `attempt_id` is globally unique, but this composite key makes that
  -- provenance boundary an explicit database invariant too.
  constraint itotori_llm_attempts_run_unit_attempt_unique
    unique (run_id, bridge_unit_id, attempt_id)
);

create unique index if not exists itotori_llm_attempts_run_logical_attempt_idx
  on itotori_llm_attempts (run_id, logical_call_id, attempt_index);

create unique index if not exists itotori_llm_attempts_provider_run_idx
  on itotori_llm_attempts (provider_run_id);

create index if not exists itotori_llm_attempts_run_unit_idx
  on itotori_llm_attempts (run_id, bridge_unit_id);

create index if not exists itotori_llm_attempts_run_stage_idx
  on itotori_llm_attempts (run_id, stage);

create table if not exists itotori_written_unit_outcomes (
  -- Canonical WrittenUnitOutcome ids are deterministic per project/branch/unit
  -- and recur across runs. Child rows use this run-local identity instead.
  journal_outcome_id text primary key,
  outcome_id text not null,
  run_id text not null references itotori_localization_journal_runs(run_id) on delete cascade,
  bridge_unit_id text not null,
  -- Source-unit keys are retained as a patch/read-model convenience and are
  -- deliberately not an FK; the journal can precede source-unit SQL projection.
  source_unit_key text,
  target_locale text not null,
  selected_candidate_id text not null,
  quality_flags text[] not null default '{}'::text[],
  -- Null is meaningful here: no resolved packet/version store must not be
  -- rewritten as a fabricated empty object.
  provenance jsonb,
  context_packet jsonb,
  written_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint itotori_written_unit_outcomes_journal_id_non_empty check (length(journal_outcome_id) > 0),
  constraint itotori_written_unit_outcomes_id_non_empty check (length(outcome_id) > 0),
  constraint itotori_written_unit_outcomes_target_locale_non_empty check (length(target_locale) > 0),
  constraint itotori_written_unit_outcomes_selected_candidate_non_empty check (length(selected_candidate_id) > 0),
  -- Required by the candidate composite FK below: a candidate cannot claim an
  -- outcome from one run/unit while using an attempt from another.
  constraint itotori_written_unit_outcomes_journal_scope_unique
    unique (journal_outcome_id, run_id, bridge_unit_id)
);

create unique index if not exists itotori_written_unit_outcomes_run_unit_idx
  on itotori_written_unit_outcomes (run_id, bridge_unit_id);

create unique index if not exists itotori_written_unit_outcomes_run_outcome_idx
  on itotori_written_unit_outcomes (run_id, outcome_id);

create index if not exists itotori_written_unit_outcomes_run_written_idx
  on itotori_written_unit_outcomes (run_id, written_at);

create table if not exists itotori_translation_candidates (
  -- Canonical candidate ids are output ids; retain a journal-local key so a
  -- later run can carry the same canonical candidate id without collision.
  journal_candidate_id text primary key,
  candidate_id text not null,
  journal_outcome_id text not null,
  run_id text not null,
  bridge_unit_id text not null,
  candidate_ordinal integer not null,
  body text not null,
  model_id text not null,
  provider_id text not null,
  -- Direct FK to the provider-run-keyed physical attempt. This is the
  -- load-bearing candidate provenance join; no legacy attempt id is involved.
  attempt_id text not null,
  kind text not null,
  created_at timestamptz not null default now(),
  constraint itotori_translation_candidates_journal_id_non_empty check (length(journal_candidate_id) > 0),
  constraint itotori_translation_candidates_id_non_empty check (length(candidate_id) > 0),
  constraint itotori_translation_candidates_ordinal_non_negative check (candidate_ordinal >= 0),
  constraint itotori_translation_candidates_body_non_blank check (length(btrim(body)) > 0),
  constraint itotori_translation_candidates_model_non_empty check (length(model_id) > 0),
  constraint itotori_translation_candidates_provider_non_empty check (length(provider_id) > 0),
  constraint itotori_translation_candidates_kind_known check (kind in ('primary', 'repair')),
  constraint itotori_translation_candidates_outcome_scope_fkey
    foreign key (journal_outcome_id, run_id, bridge_unit_id)
    references itotori_written_unit_outcomes(journal_outcome_id, run_id, bridge_unit_id)
    on delete cascade,
  constraint itotori_translation_candidates_attempt_scope_fkey
    foreign key (run_id, bridge_unit_id, attempt_id)
    references itotori_llm_attempts(run_id, bridge_unit_id, attempt_id)
    -- A run deletes outcomes and attempts through separate cascade paths.
    -- Cascading from either provenance parent makes the run itself deletable
    -- without relying on PostgreSQL's internal cascade ordering.
    on delete cascade,
  constraint itotori_translation_candidates_journal_outcome_unique
    unique (journal_candidate_id, journal_outcome_id)
);

create unique index if not exists itotori_translation_candidates_outcome_ordinal_idx
  on itotori_translation_candidates (journal_outcome_id, candidate_ordinal);

create unique index if not exists itotori_translation_candidates_outcome_candidate_idx
  on itotori_translation_candidates (journal_outcome_id, candidate_id);

create index if not exists itotori_translation_candidates_attempt_idx
  on itotori_translation_candidates (attempt_id);

create table if not exists itotori_written_qa_findings (
  journal_finding_id text primary key,
  finding_id text not null,
  journal_outcome_id text not null references itotori_written_unit_outcomes(journal_outcome_id) on delete cascade,
  journal_candidate_id text not null,
  finding_ordinal integer not null,
  severity text not null,
  category text not null,
  note text not null,
  contested boolean not null,
  confidence numeric not null,
  recommendation text not null,
  agent_rationale text not null,
  evidence_refs jsonb not null default '[]'::jsonb,
  source_span jsonb,
  draft_span jsonb,
  created_at timestamptz not null default now(),
  constraint itotori_written_qa_findings_journal_id_non_empty check (length(journal_finding_id) > 0),
  constraint itotori_written_qa_findings_id_non_empty check (length(finding_id) > 0),
  constraint itotori_written_qa_findings_ordinal_non_negative check (finding_ordinal >= 0),
  constraint itotori_written_qa_findings_severity_known check (severity in ('info', 'minor', 'major', 'critical')),
  constraint itotori_written_qa_findings_category_non_empty check (length(category) > 0),
  constraint itotori_written_qa_findings_note_non_empty check (length(note) > 0),
  constraint itotori_written_qa_findings_confidence_range check (confidence >= 0 and confidence <= 1),
  constraint itotori_written_qa_findings_recommendation_non_empty check (length(recommendation) > 0),
  constraint itotori_written_qa_findings_agent_rationale_non_empty check (length(agent_rationale) > 0),
  constraint itotori_written_qa_findings_evidence_refs_array check (jsonb_typeof(evidence_refs) = 'array'),
  constraint itotori_written_qa_findings_source_span_object check (
    source_span is null or jsonb_typeof(source_span) = 'object'
  ),
  constraint itotori_written_qa_findings_draft_span_object check (
    draft_span is null or jsonb_typeof(draft_span) = 'object'
  ),
  -- The finding's candidate must belong to this same written outcome; two
  -- independent single-column FKs would allow cross-outcome links.
  constraint itotori_written_qa_findings_candidate_outcome_fkey
    foreign key (journal_candidate_id, journal_outcome_id)
    references itotori_translation_candidates(journal_candidate_id, journal_outcome_id)
    -- The outcome cascade and candidate cascade can arrive in either order
    -- when a journal run is removed, so this must be a cascade as well.
    on delete cascade
);

create unique index if not exists itotori_written_qa_findings_outcome_ordinal_idx
  on itotori_written_qa_findings (journal_outcome_id, finding_ordinal);

create unique index if not exists itotori_written_qa_findings_outcome_finding_idx
  on itotori_written_qa_findings (journal_outcome_id, finding_id);

create index if not exists itotori_written_qa_findings_candidate_idx
  on itotori_written_qa_findings (journal_candidate_id);

create table if not exists itotori_outcome_context_refs (
  journal_outcome_id text not null references itotori_written_unit_outcomes(journal_outcome_id) on delete cascade,
  ref_ordinal integer not null,
  ref_kind text not null,
  ref_id text not null,
  version_ref text,
  details jsonb,
  created_at timestamptz not null default now(),
  primary key (journal_outcome_id, ref_ordinal),
  constraint itotori_outcome_context_refs_ordinal_non_negative check (ref_ordinal >= 0),
  constraint itotori_outcome_context_refs_kind_non_empty check (length(ref_kind) > 0),
  constraint itotori_outcome_context_refs_id_non_empty check (length(ref_id) > 0)
);

create index if not exists itotori_outcome_context_refs_kind_ref_idx
  on itotori_outcome_context_refs (ref_kind, ref_id);

create table if not exists itotori_outcome_speaker_labels (
  journal_outcome_id text not null references itotori_written_unit_outcomes(journal_outcome_id) on delete cascade,
  label_ordinal integer not null,
  bridge_unit_id text not null,
  speaker_id jsonb not null,
  confidence text not null,
  evidence_refs jsonb not null default '[]'::jsonb,
  agent_rationale text not null,
  created_at timestamptz not null default now(),
  primary key (journal_outcome_id, label_ordinal),
  constraint itotori_outcome_speaker_labels_ordinal_non_negative check (label_ordinal >= 0),
  constraint itotori_outcome_speaker_labels_speaker_not_json_null check (speaker_id <> 'null'::jsonb),
  constraint itotori_outcome_speaker_labels_confidence_known check (
    confidence in ('high', 'medium', 'low', 'unknown')
  ),
  constraint itotori_outcome_speaker_labels_evidence_refs_array check (jsonb_typeof(evidence_refs) = 'array'),
  constraint itotori_outcome_speaker_labels_agent_rationale_non_empty check (length(agent_rationale) > 0)
);

create index if not exists itotori_outcome_speaker_labels_bridge_unit_idx
  on itotori_outcome_speaker_labels (bridge_unit_id);
