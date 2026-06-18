alter table itotori_user_permission_grants
  drop constraint if exists itotori_user_permission_grants_permission_check;

alter table itotori_user_permission_grants
  add constraint itotori_user_permission_grants_permission_check check (
    permission in (
      'project.import',
      'draft.write',
      'patch.export',
      'runtime.ingest',
      'feedback.import',
      'queue.manage',
      'catalog.read',
      'catalog.write',
      'system.reset'
    )
  );

create table if not exists itotori_catalog_source_provenance (
  source_provenance_id text primary key,
  catalog_source text not null,
  source_record_kind text not null,
  source_id text not null,
  source_version text,
  request_id text,
  http_status integer,
  ok boolean not null,
  payload_hash text,
  payload jsonb not null default '{}'::jsonb,
  fetched_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb,
  recorded_at timestamptz not null default now(),
  constraint itotori_catalog_source_provenance_source_check check (
    catalog_source in (
      'vndb',
      'egs',
      'dlsite',
      'steam',
      'igdb',
      'wikidata',
      'local_corpus',
      'kaifuu',
      'manual'
    )
  ),
  constraint itotori_catalog_source_provenance_kind_check check (
    source_record_kind in (
      'raw_cache',
      'normalized_record',
      'recorded_fixture',
      'local_scan',
      'manual_assertion',
      'importer_request'
    )
  ),
  constraint itotori_catalog_source_provenance_http_check check (
    http_status is null or (http_status >= 100 and http_status <= 599)
  ),
  constraint itotori_catalog_source_provenance_hash_check check (
    payload_hash is null or payload_hash like 'sha256:%'
  ),
  constraint itotori_catalog_source_provenance_json_shape_check check (
    jsonb_typeof(payload) = 'object'
      and jsonb_typeof(metadata) = 'object'
  )
);

create index if not exists itotori_catalog_source_provenance_lookup_idx
  on itotori_catalog_source_provenance(
    catalog_source,
    source_record_kind,
    source_id,
    fetched_at
  );
create index if not exists itotori_catalog_source_provenance_hash_idx
  on itotori_catalog_source_provenance(payload_hash);

create table if not exists itotori_catalog_works (
  work_id text primary key,
  canonical_title text not null,
  original_language text,
  first_release_year integer,
  work_kind text not null default 'game',
  engine_name text,
  engine_source text,
  engine_confidence text,
  engine_provenance_id text references itotori_catalog_source_provenance(source_provenance_id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint itotori_catalog_works_year_check check (
    first_release_year is null or (first_release_year >= 1970 and first_release_year <= 2200)
  ),
  constraint itotori_catalog_works_engine_source_check check (
    engine_source is null
    or engine_source in (
      'local_scan',
      'vndb',
      'dlsite_worktype_inferred',
      'source_provenance',
      'manual',
      'unknown'
    )
  ),
  constraint itotori_catalog_works_engine_confidence_check check (
    engine_confidence is null or engine_confidence in ('high', 'medium', 'low', 'unknown')
  ),
  constraint itotori_catalog_works_json_shape_check check (jsonb_typeof(metadata) = 'object')
);

create index if not exists itotori_catalog_works_title_idx
  on itotori_catalog_works(canonical_title);
create index if not exists itotori_catalog_works_engine_idx
  on itotori_catalog_works(engine_name, engine_source);
create index if not exists itotori_catalog_works_engine_provenance_idx
  on itotori_catalog_works(engine_provenance_id);

create table if not exists itotori_catalog_external_ids (
  external_id_id text primary key,
  work_id text not null references itotori_catalog_works(work_id) on delete cascade,
  catalog_source text not null,
  source_id text not null,
  external_id_kind text not null,
  source_provenance_id text references itotori_catalog_source_provenance(source_provenance_id) on delete set null,
  confidence text not null,
  discovered_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  constraint itotori_catalog_external_ids_source_check check (
    catalog_source in (
      'vndb',
      'egs',
      'dlsite',
      'steam',
      'igdb',
      'wikidata',
      'local_corpus',
      'kaifuu',
      'manual'
    )
  ),
  constraint itotori_catalog_external_ids_kind_check check (
    external_id_kind in (
      'source_record',
      'release_record',
      'store_product',
      'knowledge_base_entity',
      'local_detection',
      'manual_alias'
    )
  ),
  constraint itotori_catalog_external_ids_confidence_check check (
    confidence in ('high', 'medium', 'low', 'unknown')
  ),
  constraint itotori_catalog_external_ids_json_shape_check check (jsonb_typeof(metadata) = 'object')
);

create unique index if not exists itotori_catalog_external_ids_source_idx
  on itotori_catalog_external_ids(catalog_source, source_id, external_id_kind);
create index if not exists itotori_catalog_external_ids_work_idx
  on itotori_catalog_external_ids(work_id);
create index if not exists itotori_catalog_external_ids_provenance_idx
  on itotori_catalog_external_ids(source_provenance_id);

create table if not exists itotori_catalog_releases (
  release_id text primary key,
  work_id text not null references itotori_catalog_works(work_id) on delete cascade,
  catalog_source text not null,
  source_release_id text,
  release_title text not null,
  release_kind text not null,
  platform text,
  language text,
  release_date text,
  release_year integer,
  is_official boolean not null default false,
  source_provenance_id text references itotori_catalog_source_provenance(source_provenance_id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint itotori_catalog_releases_source_check check (
    catalog_source in (
      'vndb',
      'egs',
      'dlsite',
      'steam',
      'igdb',
      'wikidata',
      'local_corpus',
      'kaifuu',
      'manual'
    )
  ),
  constraint itotori_catalog_releases_kind_check check (
    release_kind in (
      'original',
      'official_translation',
      'fan_patch',
      'patch',
      'remaster',
      'bundle',
      'unknown'
    )
  ),
  constraint itotori_catalog_releases_year_check check (
    release_year is null or (release_year >= 1970 and release_year <= 2200)
  ),
  constraint itotori_catalog_releases_json_shape_check check (jsonb_typeof(metadata) = 'object')
);

create index if not exists itotori_catalog_releases_work_kind_idx
  on itotori_catalog_releases(work_id, release_kind);
create index if not exists itotori_catalog_releases_source_idx
  on itotori_catalog_releases(catalog_source, source_release_id);
create index if not exists itotori_catalog_releases_platform_language_idx
  on itotori_catalog_releases(platform, language);
create index if not exists itotori_catalog_releases_provenance_idx
  on itotori_catalog_releases(source_provenance_id);

create table if not exists itotori_catalog_language_statuses (
  language_status_id text primary key,
  work_id text not null references itotori_catalog_works(work_id) on delete cascade,
  language text not null,
  status text not null,
  status_scope text not null,
  platform text,
  release_id text references itotori_catalog_releases(release_id) on delete set null,
  source_provenance_id text references itotori_catalog_source_provenance(source_provenance_id) on delete set null,
  confidence text not null,
  is_current boolean not null default true,
  observed_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint itotori_catalog_language_statuses_status_check check (
    status in (
      'official_full',
      'fan_full',
      'fan_partial',
      'mtl',
      'interface_only',
      'none',
      'unverified_console',
      'unknown'
    )
  ),
  constraint itotori_catalog_language_statuses_scope_check check (
    status_scope in ('work', 'release', 'platform')
  ),
  constraint itotori_catalog_language_statuses_confidence_check check (
    confidence in ('high', 'medium', 'low', 'unknown')
  ),
  constraint itotori_catalog_language_statuses_json_shape_check check (
    jsonb_typeof(metadata) = 'object'
  )
);

create index if not exists itotori_catalog_language_statuses_work_lang_idx
  on itotori_catalog_language_statuses(work_id, language, status);
create index if not exists itotori_catalog_language_statuses_release_idx
  on itotori_catalog_language_statuses(release_id);
create index if not exists itotori_catalog_language_statuses_provenance_idx
  on itotori_catalog_language_statuses(source_provenance_id);

create table if not exists itotori_catalog_conflicts (
  conflict_id text primary key,
  work_id text not null references itotori_catalog_works(work_id) on delete cascade,
  conflict_kind text not null,
  status text not null,
  summary text not null,
  detected_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint itotori_catalog_conflicts_kind_check check (
    conflict_kind in ('external_id', 'language_status', 'release', 'title', 'engine')
  ),
  constraint itotori_catalog_conflicts_status_check check (status in ('open', 'resolved', 'ignored')),
  constraint itotori_catalog_conflicts_json_shape_check check (jsonb_typeof(metadata) = 'object')
);

create index if not exists itotori_catalog_conflicts_work_status_idx
  on itotori_catalog_conflicts(work_id, conflict_kind, status);

create table if not exists itotori_catalog_conflict_evidence (
  conflict_evidence_id text primary key,
  conflict_id text not null references itotori_catalog_conflicts(conflict_id) on delete cascade,
  subject_kind text not null,
  subject_id text not null,
  source_provenance_id text references itotori_catalog_source_provenance(source_provenance_id) on delete set null,
  evidence_position integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint itotori_catalog_conflict_evidence_subject_check check (
    subject_kind in ('external_id', 'language_status', 'release', 'work', 'source_provenance')
  ),
  constraint itotori_catalog_conflict_evidence_position_check check (evidence_position >= 0),
  constraint itotori_catalog_conflict_evidence_json_shape_check check (
    jsonb_typeof(metadata) = 'object'
  )
);

create index if not exists itotori_catalog_conflict_evidence_conflict_idx
  on itotori_catalog_conflict_evidence(conflict_id);
create index if not exists itotori_catalog_conflict_evidence_subject_idx
  on itotori_catalog_conflict_evidence(subject_kind, subject_id);
create index if not exists itotori_catalog_conflict_evidence_provenance_idx
  on itotori_catalog_conflict_evidence(source_provenance_id);

create table if not exists itotori_catalog_local_scans (
  local_scan_id text primary key,
  scan_root_label text not null,
  scan_root_path_hash text not null,
  scanner_name text not null,
  scanner_version text not null,
  started_at timestamptz not null,
  completed_at timestamptz not null,
  created_by_user_id text references itotori_users(user_id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint itotori_catalog_local_scans_hash_check check (scan_root_path_hash like 'sha256:%'),
  constraint itotori_catalog_local_scans_time_check check (completed_at >= started_at),
  constraint itotori_catalog_local_scans_json_shape_check check (jsonb_typeof(metadata) = 'object')
);

create index if not exists itotori_catalog_local_scans_root_completed_idx
  on itotori_catalog_local_scans(scan_root_path_hash, completed_at);
create index if not exists itotori_catalog_local_scans_user_idx
  on itotori_catalog_local_scans(created_by_user_id);

create table if not exists itotori_catalog_local_scan_entries (
  local_scan_entry_id text primary key,
  local_scan_id text not null references itotori_catalog_local_scans(local_scan_id) on delete cascade,
  work_id text references itotori_catalog_works(work_id) on delete set null,
  path_hash text not null,
  path_redaction_class text not null,
  owned boolean not null default true,
  engine_name text,
  engine_source text,
  engine_confidence text,
  signals jsonb not null default '{}'::jsonb,
  source_provenance_id text references itotori_catalog_source_provenance(source_provenance_id) on delete set null,
  scanned_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint itotori_catalog_local_scan_entries_path_hash_check check (path_hash like 'sha256:%'),
  constraint itotori_catalog_local_scan_entries_redaction_check check (
    path_redaction_class in ('private_path_hash', 'public_fixture_path', 'redacted')
  ),
  constraint itotori_catalog_local_scan_entries_engine_source_check check (
    engine_source is null
    or engine_source in (
      'local_scan',
      'vndb',
      'dlsite_worktype_inferred',
      'source_provenance',
      'manual',
      'unknown'
    )
  ),
  constraint itotori_catalog_local_scan_entries_engine_confidence_check check (
    engine_confidence is null or engine_confidence in ('high', 'medium', 'low', 'unknown')
  ),
  constraint itotori_catalog_local_scan_entries_json_shape_check check (
    jsonb_typeof(signals) = 'object'
      and jsonb_typeof(metadata) = 'object'
  )
);

create unique index if not exists itotori_catalog_local_scan_entries_path_idx
  on itotori_catalog_local_scan_entries(local_scan_id, path_hash);
create index if not exists itotori_catalog_local_scan_entries_work_idx
  on itotori_catalog_local_scan_entries(work_id);
create index if not exists itotori_catalog_local_scan_entries_engine_idx
  on itotori_catalog_local_scan_entries(engine_name, engine_source);
create index if not exists itotori_catalog_local_scan_entries_provenance_idx
  on itotori_catalog_local_scan_entries(source_provenance_id);

create table if not exists itotori_catalog_local_scan_external_ids (
  local_scan_entry_id text not null references itotori_catalog_local_scan_entries(local_scan_entry_id) on delete cascade,
  catalog_source text not null,
  source_id text not null,
  external_id_kind text not null,
  source_provenance_id text references itotori_catalog_source_provenance(source_provenance_id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (local_scan_entry_id, catalog_source, source_id, external_id_kind),
  constraint itotori_catalog_local_scan_external_ids_source_check check (
    catalog_source in (
      'vndb',
      'egs',
      'dlsite',
      'steam',
      'igdb',
      'wikidata',
      'local_corpus',
      'kaifuu',
      'manual'
    )
  ),
  constraint itotori_catalog_local_scan_external_ids_kind_check check (
    external_id_kind in (
      'source_record',
      'release_record',
      'store_product',
      'knowledge_base_entity',
      'local_detection',
      'manual_alias'
    )
  ),
  constraint itotori_catalog_local_scan_external_ids_json_shape_check check (
    jsonb_typeof(metadata) = 'object'
  )
);

create index if not exists itotori_catalog_local_scan_external_ids_source_idx
  on itotori_catalog_local_scan_external_ids(catalog_source, source_id);
create index if not exists itotori_catalog_local_scan_external_ids_provenance_idx
  on itotori_catalog_local_scan_external_ids(source_provenance_id);

create table if not exists itotori_catalog_seed_targets (
  seed_target_id text primary key,
  catalog_source text not null,
  source_id text not null,
  seed_origin text not null,
  origin_ref text,
  local_scan_entry_id text references itotori_catalog_local_scan_entries(local_scan_entry_id) on delete set null,
  source_provenance_id text references itotori_catalog_source_provenance(source_provenance_id) on delete set null,
  status text not null,
  priority integer not null default 0,
  added_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint itotori_catalog_seed_targets_source_check check (
    catalog_source in (
      'vndb',
      'egs',
      'dlsite',
      'steam',
      'igdb',
      'wikidata',
      'local_corpus',
      'kaifuu',
      'manual'
    )
  ),
  constraint itotori_catalog_seed_targets_origin_check check (
    seed_origin in (
      'local_scan',
      'recorded_fixture',
      'research_fixture',
      'manual',
      'importer',
      'catalog_crawl'
    )
  ),
  constraint itotori_catalog_seed_targets_status_check check (
    status in ('pending', 'queued', 'imported', 'ignored', 'failed')
  ),
  constraint itotori_catalog_seed_targets_json_shape_check check (jsonb_typeof(metadata) = 'object')
);

create unique index if not exists itotori_catalog_seed_targets_source_origin_idx
  on itotori_catalog_seed_targets(catalog_source, source_id, seed_origin, coalesce(origin_ref, ''));
create index if not exists itotori_catalog_seed_targets_status_idx
  on itotori_catalog_seed_targets(status, priority desc, added_at);
create index if not exists itotori_catalog_seed_targets_local_scan_entry_idx
  on itotori_catalog_seed_targets(local_scan_entry_id);
create index if not exists itotori_catalog_seed_targets_provenance_idx
  on itotori_catalog_seed_targets(source_provenance_id);
