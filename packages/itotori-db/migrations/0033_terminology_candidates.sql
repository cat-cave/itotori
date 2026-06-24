-- ITOTORI-016: terminology candidate agent persistence.
-- Two new tables stand up the agent-managed glossary-candidate inbox.
-- Promotion to itotori_terminology_terms is curator-review only.
--
-- Prompt template version constant (mirrored in TypeScript):
--   PROMPT_TEMPLATE_VERSION_V1 = 'itotori-terminology-candidate-v1'

create table if not exists itotori_terminology_candidates (
  terminology_candidate_id text primary key,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  locale_branch_id text not null references itotori_locale_branches(locale_branch_id) on delete cascade,
  source_revision_id text not null references itotori_source_revisions(source_revision_id) on delete restrict,
  kind text not null check (
    kind in (
      'ProperNoun',
      'TitleOrHonorific',
      'TechnicalTerm',
      'Catchphrase',
      'SoundEffect',
      'WrittenSign',
      'Other'
    )
  ),
  surface_form text not null,
  surface_locale text not null,
  rationale text not null,
  reading_hint text,
  conflicting_terminology_term_id text references itotori_terminology_terms(term_id) on delete set null,
  model_provider_family text not null,
  model_id text not null,
  model_context_window_tokens integer not null,
  model_max_output_tokens integer,
  prompt_template_version text not null,
  prompt_hash text not null,
  input_token_estimate integer not null,
  completion_tokens integer not null,
  status text not null check (
    status in ('Fresh', 'Stale', 'Promoted', 'RejectedByReviewer')
  ),
  invalidated_at timestamptz,
  invalidated_reason text check (
    invalidated_reason is null
    or invalidated_reason in (
      'source_hash_drift',
      'template_version_bump',
      'glossary_conflict_post_persist',
      'manual'
    )
  ),
  generated_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (model_context_window_tokens > 0),
  check (input_token_estimate >= 0),
  check (completion_tokens >= 0)
);

create unique index if not exists itotori_terminology_candidates_unique_idx
  on itotori_terminology_candidates (
    project_id,
    locale_branch_id,
    source_revision_id,
    surface_form,
    kind,
    prompt_template_version
  );

create index if not exists itotori_terminology_candidates_status_idx
  on itotori_terminology_candidates (project_id, locale_branch_id, source_revision_id, status);

create index if not exists itotori_terminology_candidates_surface_idx
  on itotori_terminology_candidates (surface_form);

create index if not exists itotori_terminology_candidates_conflict_idx
  on itotori_terminology_candidates (conflicting_terminology_term_id)
  where conflicting_terminology_term_id is not null;

create table if not exists itotori_terminology_candidate_evidence (
  terminology_candidate_id text not null references itotori_terminology_candidates(terminology_candidate_id) on delete cascade,
  bridge_unit_id text not null,
  cited_source_hash text not null,
  cite_ordinal integer not null check (cite_ordinal >= 1),
  created_at timestamptz not null default now(),
  primary key (terminology_candidate_id, bridge_unit_id)
);

create index if not exists itotori_terminology_candidate_evidence_bridge_unit_idx
  on itotori_terminology_candidate_evidence (bridge_unit_id, cited_source_hash);

create index if not exists itotori_terminology_candidate_evidence_ordinal_idx
  on itotori_terminology_candidate_evidence (terminology_candidate_id, cite_ordinal);
