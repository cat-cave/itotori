-- ITOTORI-013: scene summary agent persistence.
-- Two new tables for agent-managed scene summaries. Stays separate from
-- itotori_context_artifacts (curator-authored notes); a follow-up node can
-- project agent summaries into context artifacts for unified reads.
--
-- Prompt template version constant (mirrored in TypeScript):
--   PROMPT_TEMPLATE_VERSION_V1 = 'itotori-scene-summary-v1'

create table if not exists itotori_scene_summaries (
  scene_summary_id text primary key,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  locale_branch_id text not null references itotori_locale_branches(locale_branch_id) on delete cascade,
  source_revision_id text not null references itotori_source_revisions(source_revision_id) on delete restrict,
  scene_id text not null,
  summary_locale text not null,
  summary_text text not null,
  model_provider_family text not null,
  model_id text not null,
  model_context_window_tokens integer not null,
  model_max_output_tokens integer,
  prompt_template_version text not null,
  prompt_hash text not null,
  input_token_estimate integer not null,
  completion_tokens integer not null,
  status text not null check (status in ('Fresh', 'Stale')),
  invalidated_at timestamptz,
  invalidated_reason text check (
    invalidated_reason is null
    or invalidated_reason in ('source_hash_drift', 'template_version_bump', 'manual')
  ),
  generated_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (model_context_window_tokens > 0),
  check (input_token_estimate >= 0),
  check (completion_tokens >= 0)
);

create unique index if not exists itotori_scene_summaries_unique_idx
  on itotori_scene_summaries (
    project_id,
    locale_branch_id,
    source_revision_id,
    scene_id,
    prompt_template_version
  );

create index if not exists itotori_scene_summaries_status_idx
  on itotori_scene_summaries (project_id, locale_branch_id, source_revision_id, status);

create index if not exists itotori_scene_summaries_scene_idx
  on itotori_scene_summaries (scene_id);

create table if not exists itotori_scene_summary_cited_units (
  scene_summary_id text not null references itotori_scene_summaries(scene_summary_id) on delete cascade,
  bridge_unit_id text not null,
  cited_source_hash text not null,
  cite_ordinal integer not null,
  created_at timestamptz not null default now(),
  primary key (scene_summary_id, bridge_unit_id),
  check (cite_ordinal >= 1)
);

create index if not exists itotori_scene_summary_cited_units_bridge_unit_idx
  on itotori_scene_summary_cited_units (bridge_unit_id, cited_source_hash);

create index if not exists itotori_scene_summary_cited_units_ordinal_idx
  on itotori_scene_summary_cited_units (scene_summary_id, cite_ordinal);
