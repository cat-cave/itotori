create table if not exists itotori_catalog_demand_facts (
  demand_fact_id text primary key,
  work_id text not null references itotori_catalog_works(work_id) on delete cascade,
  catalog_source text not null,
  source_id text not null,
  fact_kind text not null,
  fact_value jsonb not null default '{}'::jsonb,
  observed_at timestamptz not null default now(),
  source_provenance_id text references itotori_catalog_source_provenance(source_provenance_id) on delete set null,
  parser_version text not null default 'unknown',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint itotori_catalog_demand_facts_source_check check (
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
  constraint itotori_catalog_demand_facts_kind_check check (
    fact_kind in (
      'dl_count',
      'rating_summary',
      'rating_histogram',
      'wishlist_count',
      'rank',
      'work_type',
      'translation_tree'
    )
  ),
  constraint itotori_catalog_demand_facts_json_shape_check check (
    jsonb_typeof(fact_value) = 'object'
      and jsonb_typeof(metadata) = 'object'
  )
);

create unique index if not exists itotori_catalog_demand_facts_source_kind_idx
  on itotori_catalog_demand_facts(
    catalog_source,
    source_id,
    fact_kind,
    coalesce(metadata->>'sourceField', '')
  );
create index if not exists itotori_catalog_demand_facts_work_idx
  on itotori_catalog_demand_facts(work_id);
create index if not exists itotori_catalog_demand_facts_provenance_idx
  on itotori_catalog_demand_facts(source_provenance_id);
