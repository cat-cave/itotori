create table if not exists itotori_bridge_imports (
  bridge_import_id text primary key,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  source_bundle_id text not null references itotori_source_bundles(source_bundle_id) on delete cascade,
  source_bundle_revision_id text not null references itotori_source_revisions(source_revision_id) on delete restrict,
  bridge_id text not null,
  schema_version text not null,
  source_bundle_hash text not null,
  source_locale text not null,
  unit_count integer not null,
  asset_count integer not null,
  source_revision_count integer not null,
  validation_failure_count integer not null default 0,
  added_unit_count integer not null,
  updated_unit_count integer not null,
  removed_unit_count integer not null,
  unchanged_unit_count integer not null,
  added_asset_count integer not null,
  updated_asset_count integer not null,
  removed_asset_count integer not null,
  unchanged_asset_count integer not null,
  added_source_revision_count integer not null,
  existing_source_revision_count integer not null,
  catalog_work_id text,
  local_corpus_entry_id text,
  readiness_profile_id text,
  completeness_status_id text,
  metadata jsonb not null default '{}'::jsonb,
  imported_at timestamptz not null default now()
);

create unique index if not exists itotori_bridge_imports_bundle_revision_idx
  on itotori_bridge_imports(source_bundle_id, source_bundle_revision_id);
create index if not exists itotori_bridge_imports_project_imported_idx
  on itotori_bridge_imports(project_id, imported_at);
create index if not exists itotori_bridge_imports_future_refs_idx
  on itotori_bridge_imports(
    catalog_work_id,
    local_corpus_entry_id,
    readiness_profile_id,
    completeness_status_id
  );
