-- CATALOG-007: evidence rows attach to the strict capability matrix without
-- changing matrix support status. Public fixture evidence and private-local
-- aggregate evidence stay separable at persistence and read-model boundaries.

create type engine_capability_evidence_source as enum (
  'public_fixture',
  'private_local_aggregate'
);

create type engine_capability_evidence_kind as enum (
  'adapter_matrix',
  'local_corpus_sidecar',
  'key_validation',
  'engine_marker_count'
);

create type engine_capability_evidence_status as enum (
  'present',
  'partial',
  'missing',
  'unknown'
);

create table if not exists itotori_engine_capability_evidence (
  engine_capability_evidence_id text primary key,
  adapter_id                    text not null,
  level                         capability_level_enum not null,
  evidence_source               engine_capability_evidence_source not null,
  evidence_kind                 engine_capability_evidence_kind not null,
  schema_version                text not null,
  status                        engine_capability_evidence_status not null,
  aggregate_counts              jsonb not null default '{}'::jsonb,
  evidence_labels               jsonb not null default '[]'::jsonb,
  limitations                   jsonb not null default '[]'::jsonb,
  public_fixture_id             text,
  reported_at                   timestamptz not null default now(),
  check (jsonb_typeof(aggregate_counts) = 'object'),
  check (jsonb_typeof(evidence_labels) = 'array'),
  check (jsonb_typeof(limitations) = 'array'),
  check (
    evidence_source = 'public_fixture'
    or public_fixture_id is null
  )
);

create index if not exists itotori_engine_capability_evidence_adapter_idx
  on itotori_engine_capability_evidence (adapter_id);

create index if not exists itotori_engine_capability_evidence_level_idx
  on itotori_engine_capability_evidence (adapter_id, level);

create index if not exists itotori_engine_capability_evidence_source_idx
  on itotori_engine_capability_evidence (evidence_source, evidence_kind);
