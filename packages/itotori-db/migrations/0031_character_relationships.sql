-- ITOTORI-014: character relationship agent persistence.
-- Three new tables stand up the agent-managed character bio + relationship
-- artifact set. Stays separate from itotori_context_artifacts (which carries
-- curator-authored, free-form notes) and from itotori_scene_summaries (which
-- is scene-scoped); a follow-up node can project these into a unified read
-- model.
--
-- Prompt template version constant (mirrored in TypeScript):
--   PROMPT_TEMPLATE_VERSION_V1 = 'itotori-character-relationship-v1'

create table if not exists itotori_character_bios (
  character_bio_id text primary key,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  locale_branch_id text not null references itotori_locale_branches(locale_branch_id) on delete cascade,
  source_revision_id text not null references itotori_source_revisions(source_revision_id) on delete restrict,
  character_id text not null,
  bio_locale text not null,
  bio_text text not null,
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

create unique index if not exists itotori_character_bios_unique_idx
  on itotori_character_bios (
    project_id,
    locale_branch_id,
    source_revision_id,
    character_id,
    prompt_template_version
  );

create index if not exists itotori_character_bios_status_idx
  on itotori_character_bios (project_id, locale_branch_id, source_revision_id, status);

create index if not exists itotori_character_bios_character_idx
  on itotori_character_bios (character_id);

create table if not exists itotori_character_bio_evidence (
  character_bio_id text not null references itotori_character_bios(character_bio_id) on delete cascade,
  bridge_unit_id text not null,
  cited_source_hash text not null,
  cite_ordinal integer not null,
  created_at timestamptz not null default now(),
  primary key (character_bio_id, bridge_unit_id),
  check (cite_ordinal >= 1)
);

create index if not exists itotori_character_bio_evidence_bridge_unit_idx
  on itotori_character_bio_evidence (bridge_unit_id, cited_source_hash);

create index if not exists itotori_character_bio_evidence_ordinal_idx
  on itotori_character_bio_evidence (character_bio_id, cite_ordinal);

create table if not exists itotori_character_relationships (
  character_relationship_id text primary key,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  locale_branch_id text not null references itotori_locale_branches(locale_branch_id) on delete cascade,
  source_revision_id text not null references itotori_source_revisions(source_revision_id) on delete restrict,
  from_character_id text not null,
  to_character_id text not null,
  kind text not null check (
    kind in (
      'FamilyRelation',
      'Romantic',
      'Friendship',
      'Mentor',
      'Rivalry',
      'Allegiance',
      'Antagonism',
      'Other'
    )
  ),
  direction text not null check (direction in ('Symmetric', 'FromAToB')),
  descriptor text not null,
  descriptor_locale text not null,
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
    or invalidated_reason in ('source_hash_drift', 'template_version_bump', 'manual')
  ),
  generated_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (model_context_window_tokens > 0)
);

create unique index if not exists itotori_character_relationships_unique_idx
  on itotori_character_relationships (
    project_id,
    locale_branch_id,
    source_revision_id,
    from_character_id,
    to_character_id,
    kind,
    prompt_template_version
  );

create index if not exists itotori_character_relationships_status_idx
  on itotori_character_relationships (
    project_id,
    locale_branch_id,
    source_revision_id,
    status
  );

create index if not exists itotori_character_relationships_from_idx
  on itotori_character_relationships (from_character_id);

create index if not exists itotori_character_relationships_to_idx
  on itotori_character_relationships (to_character_id);

create table if not exists itotori_character_relationship_evidence (
  character_relationship_id text not null references itotori_character_relationships(character_relationship_id) on delete cascade,
  bridge_unit_id text not null,
  cited_source_hash text not null,
  cite_ordinal integer not null,
  created_at timestamptz not null default now(),
  primary key (character_relationship_id, bridge_unit_id),
  check (cite_ordinal >= 1)
);

create index if not exists itotori_character_relationship_evidence_bridge_unit_idx
  on itotori_character_relationship_evidence (bridge_unit_id, cited_source_hash);

create index if not exists itotori_character_relationship_evidence_ordinal_idx
  on itotori_character_relationship_evidence (character_relationship_id, cite_ordinal);
