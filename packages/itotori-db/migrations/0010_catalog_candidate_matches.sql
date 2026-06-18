create table if not exists itotori_catalog_candidate_matches (
  candidate_id text primary key,
  source_catalog_source text not null,
  source_id text not null,
  source_title text not null,
  source_provenance_id text references itotori_catalog_source_provenance(source_provenance_id) on delete set null,
  target_work_id text not null references itotori_catalog_works(work_id) on delete cascade,
  score integer not null,
  matched_fields jsonb not null default '{}'::jsonb,
  status text not null,
  diagnostic_code text not null,
  generator_version text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint itotori_catalog_candidate_matches_source_check check (
    source_catalog_source in (
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
  constraint itotori_catalog_candidate_matches_score_check check (score >= 0 and score <= 1000),
  constraint itotori_catalog_candidate_matches_status_check check (
    status in ('review_pending', 'duplicate_source')
  ),
  constraint itotori_catalog_candidate_matches_json_shape_check check (
    jsonb_typeof(matched_fields) = 'object'
      and jsonb_typeof(metadata) = 'object'
  )
);

create unique index if not exists itotori_catalog_candidate_matches_source_target_idx
  on itotori_catalog_candidate_matches(
    source_catalog_source,
    source_id,
    target_work_id,
    generator_version
  );
create index if not exists itotori_catalog_candidate_matches_status_idx
  on itotori_catalog_candidate_matches(status, score desc, created_at);
create index if not exists itotori_catalog_candidate_matches_target_idx
  on itotori_catalog_candidate_matches(target_work_id);
create index if not exists itotori_catalog_candidate_matches_provenance_idx
  on itotori_catalog_candidate_matches(source_provenance_id);
