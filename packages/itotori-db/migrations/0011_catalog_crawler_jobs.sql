create table if not exists itotori_catalog_crawler_jobs (
  crawler_job_id text primary key,
  catalog_source text not null,
  adapter_name text not null,
  adapter_version text not null,
  source_version text not null,
  parser_version text not null,
  partition_key text not null,
  status text not null,
  checkpoint_cursor jsonb,
  locked_by text not null,
  lease_expires_at timestamptz not null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  last_error text,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint itotori_catalog_crawler_jobs_source_check check (
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
  constraint itotori_catalog_crawler_jobs_status_check check (
    status in ('running', 'succeeded', 'failed', 'cancelled')
  ),
  constraint itotori_catalog_crawler_jobs_json_shape_check check (
    (checkpoint_cursor is null or jsonb_typeof(checkpoint_cursor) in ('object', 'array', 'string', 'number', 'boolean'))
      and jsonb_typeof(metadata) = 'object'
  )
);

create unique index if not exists itotori_catalog_crawler_jobs_active_partition_idx
  on itotori_catalog_crawler_jobs(catalog_source, adapter_name, partition_key)
  where status = 'running';
create index if not exists itotori_catalog_crawler_jobs_source_status_idx
  on itotori_catalog_crawler_jobs(catalog_source, status, updated_at);
create index if not exists itotori_catalog_crawler_jobs_lease_idx
  on itotori_catalog_crawler_jobs(lease_expires_at);

create table if not exists itotori_catalog_crawler_checkpoints (
  catalog_source text not null,
  adapter_name text not null,
  partition_key text not null,
  checkpoint_cursor jsonb,
  source_version text not null,
  parser_version text not null,
  last_crawler_job_id text references itotori_catalog_crawler_jobs(crawler_job_id) on delete set null,
  last_step_key text,
  updated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  primary key (catalog_source, adapter_name, partition_key),
  constraint itotori_catalog_crawler_checkpoints_source_check check (
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
  constraint itotori_catalog_crawler_checkpoints_json_shape_check check (
    (checkpoint_cursor is null or jsonb_typeof(checkpoint_cursor) in ('object', 'array', 'string', 'number', 'boolean'))
      and jsonb_typeof(metadata) = 'object'
  )
);

create index if not exists itotori_catalog_crawler_checkpoints_job_idx
  on itotori_catalog_crawler_checkpoints(last_crawler_job_id);

create table if not exists itotori_catalog_crawler_rate_limits (
  catalog_source text not null,
  adapter_name text not null,
  partition_key text not null,
  next_available_at timestamptz,
  reset_at timestamptz,
  remaining integer,
  "limit" integer,
  retry_after_seconds integer,
  request_identity text,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (catalog_source, adapter_name, partition_key),
  constraint itotori_catalog_crawler_rate_limits_source_check check (
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
  constraint itotori_catalog_crawler_rate_limits_nonnegative_check check (
    (remaining is null or remaining >= 0)
      and ("limit" is null or "limit" >= 0)
      and (retry_after_seconds is null or retry_after_seconds >= 0)
  ),
  constraint itotori_catalog_crawler_rate_limits_json_shape_check check (
    jsonb_typeof(metadata) = 'object'
  )
);

create index if not exists itotori_catalog_crawler_rate_limits_next_idx
  on itotori_catalog_crawler_rate_limits(next_available_at);

create table if not exists itotori_catalog_crawler_job_steps (
  crawler_job_step_id text primary key,
  crawler_job_id text not null references itotori_catalog_crawler_jobs(crawler_job_id) on delete cascade,
  step_key text not null,
  catalog_source text not null,
  adapter_name text not null,
  partition_key text not null,
  source_id text not null,
  request_identity text not null,
  source_version text not null,
  parser_version text not null,
  checkpoint_cursor jsonb,
  fetched_at timestamptz not null,
  http_status integer,
  ok boolean not null,
  payload_hash text not null,
  source_provenance_id text not null references itotori_catalog_source_provenance(source_provenance_id) on delete restrict,
  status text not null,
  imported_at timestamptz,
  error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint itotori_catalog_crawler_job_steps_source_check check (
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
  constraint itotori_catalog_crawler_job_steps_status_check check (
    status in ('fetched', 'imported', 'failed')
  ),
  constraint itotori_catalog_crawler_job_steps_http_check check (
    http_status is null or (http_status >= 100 and http_status <= 599)
  ),
  constraint itotori_catalog_crawler_job_steps_hash_check check (
    payload_hash like 'sha256:%'
  ),
  constraint itotori_catalog_crawler_job_steps_json_shape_check check (
    (checkpoint_cursor is null or jsonb_typeof(checkpoint_cursor) in ('object', 'array', 'string', 'number', 'boolean'))
      and jsonb_typeof(metadata) = 'object'
  )
);

create unique index if not exists itotori_catalog_crawler_job_steps_job_step_idx
  on itotori_catalog_crawler_job_steps(crawler_job_id, step_key);
create index if not exists itotori_catalog_crawler_job_steps_source_request_idx
  on itotori_catalog_crawler_job_steps(catalog_source, adapter_name, partition_key, request_identity, fetched_at);
create index if not exists itotori_catalog_crawler_job_steps_provenance_idx
  on itotori_catalog_crawler_job_steps(source_provenance_id);
create index if not exists itotori_catalog_crawler_job_steps_status_idx
  on itotori_catalog_crawler_job_steps(status, updated_at);
