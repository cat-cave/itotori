-- ITOTORI-015: route + choice map agent persistence.
-- Three new tables stand up the agent-managed route map + choice + evidence
-- artifact set. Mirrors the ITOTORI-014 character-relationship layout:
-- per-subject tables plus a polymorphic evidence table feeding the
-- staleness scan.
--
-- Prompt template version constant (mirrored in TypeScript):
--   PROMPT_TEMPLATE_VERSION_V1 = 'itotori-route-choice-map-v1'

create table if not exists itotori_route_maps (
  route_map_id text primary key,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  locale_branch_id text not null references itotori_locale_branches(locale_branch_id) on delete cascade,
  source_revision_id text not null references itotori_source_revisions(source_revision_id) on delete restrict,
  route_key text not null,
  route_title text not null,
  map_locale text not null,
  route_summary text not null,
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
    or invalidated_reason in (
      'source_hash_drift',
      'template_version_bump',
      'unknown_route_target',
      'manual'
    )
  ),
  generated_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (model_context_window_tokens > 0),
  check (input_token_estimate >= 0),
  check (completion_tokens >= 0)
);

create unique index if not exists itotori_route_maps_unique_idx
  on itotori_route_maps (
    project_id,
    locale_branch_id,
    source_revision_id,
    route_key,
    prompt_template_version
  );

create index if not exists itotori_route_maps_status_idx
  on itotori_route_maps (project_id, locale_branch_id, source_revision_id, status);

create index if not exists itotori_route_maps_route_key_idx
  on itotori_route_maps (route_key);

create table if not exists itotori_route_choices (
  route_choice_id text primary key,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  locale_branch_id text not null references itotori_locale_branches(locale_branch_id) on delete cascade,
  source_revision_id text not null references itotori_source_revisions(source_revision_id) on delete restrict,
  choice_key text not null,
  kind text not null check (
    kind in ('RouteBranch', 'FlagToggle', 'SceneSelector', 'Cosmetic', 'Other')
  ),
  from_route_key text,
  prompt_summary text not null,
  map_locale text not null,
  options jsonb not null,
  model_provider_family text not null,
  model_id text not null,
  model_context_window_tokens integer not null,
  model_max_output_tokens integer,
  prompt_template_version text not null,
  prompt_hash text not null,
  status text not null check (status in ('Fresh', 'Stale')),
  invalidated_at timestamptz,
  invalidated_reason text check (
    invalidated_reason is null
    or invalidated_reason in (
      'source_hash_drift',
      'template_version_bump',
      'unknown_route_target',
      'manual'
    )
  ),
  generated_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (model_context_window_tokens > 0)
);

create unique index if not exists itotori_route_choices_unique_idx
  on itotori_route_choices (
    project_id,
    locale_branch_id,
    source_revision_id,
    choice_key,
    prompt_template_version
  );

create index if not exists itotori_route_choices_status_idx
  on itotori_route_choices (project_id, locale_branch_id, source_revision_id, status);

create index if not exists itotori_route_choices_choice_key_idx
  on itotori_route_choices (choice_key);

create index if not exists itotori_route_choices_from_route_key_idx
  on itotori_route_choices (from_route_key);

create table if not exists itotori_route_evidence (
  route_evidence_id text primary key,
  subject_kind text not null check (subject_kind in ('route', 'choice', 'choice_option')),
  route_map_id text references itotori_route_maps(route_map_id) on delete cascade,
  route_choice_id text references itotori_route_choices(route_choice_id) on delete cascade,
  choice_option_id text,
  bridge_unit_id text not null,
  cited_source_hash text not null,
  cite_ordinal integer not null check (cite_ordinal >= 1),
  created_at timestamptz not null default now(),
  check (
    (subject_kind = 'route' and route_map_id is not null and route_choice_id is null)
    or (subject_kind in ('choice', 'choice_option') and route_choice_id is not null and route_map_id is null)
  )
);

create index if not exists itotori_route_evidence_by_route_idx
  on itotori_route_evidence (route_map_id, bridge_unit_id);

create index if not exists itotori_route_evidence_by_choice_idx
  on itotori_route_evidence (route_choice_id, bridge_unit_id);

create index if not exists itotori_route_evidence_bridge_unit_idx
  on itotori_route_evidence (bridge_unit_id, cited_source_hash);
