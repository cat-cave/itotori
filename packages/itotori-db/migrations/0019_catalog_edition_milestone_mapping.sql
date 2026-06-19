alter table itotori_catalog_releases
  drop constraint if exists itotori_catalog_releases_kind_check;

alter table itotori_catalog_releases
  add column if not exists edition_name text,
  add column if not exists milestone text,
  add column if not exists package_kind text not null default 'unknown',
  add column if not exists engine_name text,
  add column if not exists engine_source text,
  add column if not exists engine_confidence text,
  add column if not exists engine_provenance_id text references itotori_catalog_source_provenance(source_provenance_id) on delete set null;

alter table itotori_catalog_releases
  add constraint itotori_catalog_releases_kind_check check (
    release_kind in (
      'original',
      'edition',
      'official_translation',
      'fan_patch',
      'patch',
      'remaster',
      'fandisc',
      'bundle',
      'collection_member',
      'unknown'
    )
  );

alter table itotori_catalog_releases
  drop constraint if exists itotori_catalog_releases_package_kind_check;

alter table itotori_catalog_releases
  add constraint itotori_catalog_releases_package_kind_check check (
    package_kind in (
      'loose_files',
      'archive',
      'installer',
      'steam_app',
      'dlsite_product',
      'physical_media',
      'bundle',
      'unknown'
    )
  );

alter table itotori_catalog_releases
  drop constraint if exists itotori_catalog_releases_engine_source_check;

alter table itotori_catalog_releases
  add constraint itotori_catalog_releases_engine_source_check check (
    engine_source is null
    or engine_source in (
      'local_scan',
      'vndb',
      'dlsite_worktype_inferred',
      'source_provenance',
      'manual',
      'unknown'
    )
  );

alter table itotori_catalog_releases
  drop constraint if exists itotori_catalog_releases_engine_confidence_check;

alter table itotori_catalog_releases
  add constraint itotori_catalog_releases_engine_confidence_check check (
    engine_confidence is null or engine_confidence in ('high', 'medium', 'low', 'unknown')
  );

create index if not exists itotori_catalog_releases_milestone_idx
  on itotori_catalog_releases(work_id, milestone);
create index if not exists itotori_catalog_releases_engine_idx
  on itotori_catalog_releases(engine_name, engine_source);
create index if not exists itotori_catalog_releases_engine_provenance_idx
  on itotori_catalog_releases(engine_provenance_id);

create table if not exists itotori_catalog_release_mappings (
  release_mapping_id text primary key,
  work_id text not null references itotori_catalog_works(work_id) on delete cascade,
  source_release_id text not null references itotori_catalog_releases(release_id) on delete cascade,
  target_release_id text not null references itotori_catalog_releases(release_id) on delete cascade,
  relation_kind text not null,
  portability text not null default 'unknown',
  source_provenance_id text references itotori_catalog_source_provenance(source_provenance_id) on delete set null,
  confidence text not null default 'unknown',
  observed_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint itotori_catalog_release_mappings_distinct_check check (
    source_release_id <> target_release_id
  ),
  constraint itotori_catalog_release_mappings_kind_check check (
    relation_kind in (
      'edition_of',
      'remaster_of',
      'fandisc_of',
      'bundle_contains',
      'collection_contains',
      'translation_of',
      'patch_targets',
      'same_milestone_as'
    )
  ),
  constraint itotori_catalog_release_mappings_portability_check check (
    portability in ('exact', 'likely_portable', 'needs_review', 'incompatible', 'unknown')
  ),
  constraint itotori_catalog_release_mappings_confidence_check check (
    confidence in ('high', 'medium', 'low', 'unknown')
  ),
  constraint itotori_catalog_release_mappings_json_shape_check check (
    jsonb_typeof(metadata) = 'object'
  )
);

create unique index if not exists itotori_catalog_release_mappings_relation_idx
  on itotori_catalog_release_mappings(source_release_id, target_release_id, relation_kind);
create index if not exists itotori_catalog_release_mappings_work_idx
  on itotori_catalog_release_mappings(work_id, relation_kind);
create index if not exists itotori_catalog_release_mappings_target_idx
  on itotori_catalog_release_mappings(target_release_id, relation_kind);
create index if not exists itotori_catalog_release_mappings_provenance_idx
  on itotori_catalog_release_mappings(source_provenance_id);

create table if not exists itotori_catalog_release_install_states (
  install_state_id text primary key,
  work_id text not null references itotori_catalog_works(work_id) on delete cascade,
  release_id text not null references itotori_catalog_releases(release_id) on delete cascade,
  local_scan_entry_id text references itotori_catalog_local_scan_entries(local_scan_entry_id) on delete set null,
  install_state text not null,
  target_artifact_label text,
  source_provenance_id text references itotori_catalog_source_provenance(source_provenance_id) on delete set null,
  confidence text not null default 'unknown',
  observed_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint itotori_catalog_release_install_states_state_check check (
    install_state in (
      'source_archive',
      'installed',
      'patch_target',
      'not_installed',
      'archived',
      'unknown'
    )
  ),
  constraint itotori_catalog_release_install_states_confidence_check check (
    confidence in ('high', 'medium', 'low', 'unknown')
  ),
  constraint itotori_catalog_release_install_states_json_shape_check check (
    jsonb_typeof(metadata) = 'object'
  )
);

create unique index if not exists itotori_catalog_release_install_states_target_idx
  on itotori_catalog_release_install_states(
    release_id,
    coalesce(local_scan_entry_id, ''),
    install_state
  );
create index if not exists itotori_catalog_release_install_states_work_idx
  on itotori_catalog_release_install_states(work_id, install_state);
create index if not exists itotori_catalog_release_install_states_release_idx
  on itotori_catalog_release_install_states(release_id, install_state);
create index if not exists itotori_catalog_release_install_states_local_scan_idx
  on itotori_catalog_release_install_states(local_scan_entry_id);
create index if not exists itotori_catalog_release_install_states_provenance_idx
  on itotori_catalog_release_install_states(source_provenance_id);
