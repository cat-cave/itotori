create table if not exists itotori_translation_memory_segments (
  memory_segment_id text primary key,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  locale_branch_id text not null references itotori_locale_branches(locale_branch_id) on delete cascade,
  source_revision_id text not null references itotori_source_revisions(source_revision_id) on delete restrict,
  source_bridge_unit_id text references itotori_source_units(bridge_unit_id) on delete set null,
  source_unit_key text not null,
  source_occurrence_id text not null,
  source_hash text not null,
  source_fingerprint text not null,
  source_text text not null,
  target_locale text not null,
  target_text text not null,
  status text not null,
  provenance jsonb not null default '{}'::jsonb,
  created_by_user_id text references itotori_users(user_id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists itotori_tm_segments_exact_lookup_idx
  on itotori_translation_memory_segments(
    locale_branch_id,
    source_revision_id,
    source_hash,
    status,
    source_unit_key,
    source_occurrence_id
  );

create index if not exists itotori_tm_segments_fingerprint_idx
  on itotori_translation_memory_segments(
    locale_branch_id,
    source_revision_id,
    source_fingerprint,
    status
  );

create index if not exists itotori_tm_segments_project_branch_idx
  on itotori_translation_memory_segments(project_id, locale_branch_id, created_at);

create table if not exists itotori_translation_memory_reuse_events (
  reuse_event_id text primary key,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  locale_branch_id text not null references itotori_locale_branches(locale_branch_id) on delete cascade,
  target_bridge_unit_id text not null references itotori_source_units(bridge_unit_id) on delete cascade,
  source_revision_id text not null references itotori_source_revisions(source_revision_id) on delete restrict,
  memory_segment_id text not null references itotori_translation_memory_segments(memory_segment_id) on delete restrict,
  match_kind text not null,
  match_score integer not null,
  reuse_status text not null,
  source_hash text not null,
  candidate_source_hash text not null,
  target_text text not null,
  provenance jsonb not null default '{}'::jsonb,
  cost_impact jsonb not null default '{}'::jsonb,
  created_by_user_id text references itotori_users(user_id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists itotori_tm_reuse_events_target_idx
  on itotori_translation_memory_reuse_events(locale_branch_id, target_bridge_unit_id, created_at);

create index if not exists itotori_tm_reuse_events_segment_idx
  on itotori_translation_memory_reuse_events(memory_segment_id, created_at);

