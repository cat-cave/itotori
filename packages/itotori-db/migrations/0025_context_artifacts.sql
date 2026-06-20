create table if not exists itotori_context_artifacts (
  context_artifact_id text primary key,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  locale_branch_id text not null references itotori_locale_branches(locale_branch_id) on delete cascade,
  source_revision_id text not null references itotori_source_revisions(source_revision_id) on delete restrict,
  category text not null check (
    category in (
      'scene_summary',
      'character_note',
      'route_map',
      'speaker_label',
      'terminology_candidate'
    )
  ),
  status text not null default 'active' check (
    status in ('active', 'stale', 'superseded', 'rejected')
  ),
  title text not null,
  normalized_title text not null,
  body text not null,
  data jsonb not null default '{}'::jsonb,
  content_hash text not null,
  produced_by_agent text,
  produced_by_tool text,
  producer_version text not null,
  provenance jsonb not null default '{}'::jsonb,
  invalidated_reason text,
  invalidated_at timestamptz,
  created_by_user_id text references itotori_users(user_id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (produced_by_agent is not null or produced_by_tool is not null),
  check (char_length(title) between 1 and 512),
  check (char_length(body) <= 20000),
  check (octet_length(data::text) <= 65536),
  check (octet_length(provenance::text) <= 65536)
);

create index if not exists itotori_context_artifacts_branch_lookup_idx
  on itotori_context_artifacts(
    project_id,
    locale_branch_id,
    source_revision_id,
    category,
    status
  );

create index if not exists itotori_context_artifacts_title_idx
  on itotori_context_artifacts(locale_branch_id, normalized_title);

create index if not exists itotori_context_artifacts_content_hash_idx
  on itotori_context_artifacts(locale_branch_id, category, content_hash);

create table if not exists itotori_context_artifact_source_units (
  context_artifact_id text not null references itotori_context_artifacts(context_artifact_id) on delete cascade,
  bridge_unit_id text not null,
  source_revision_id text not null references itotori_source_revisions(source_revision_id) on delete restrict,
  source_hash text not null,
  citation text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (context_artifact_id, bridge_unit_id),
  check (char_length(citation) between 1 and 1000),
  check (octet_length(metadata::text) <= 32768)
);

create index if not exists itotori_context_artifact_source_units_unit_idx
  on itotori_context_artifact_source_units(bridge_unit_id, source_revision_id, source_hash);
