create table if not exists itotori_terminology_terms (
  term_id text primary key,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  locale_branch_id text not null references itotori_locale_branches(locale_branch_id) on delete cascade,
  source_term text not null,
  normalized_source_term text not null,
  source_locale text not null,
  target_locale text not null,
  preferred_translation text not null,
  normalized_preferred_translation text not null,
  term_kind text not null,
  part_of_speech text,
  status text not null,
  case_sensitive boolean not null default false,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_by_user_id text references itotori_users(user_id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint itotori_terminology_terms_status_check check (
    status in ('active', 'deprecated', 'conflicted')
  ),
  constraint itotori_terminology_terms_kind_check check (
    term_kind in ('character_name', 'place_name', 'item_name', 'system_term', 'lore_term', 'ui_term', 'general')
  ),
  constraint itotori_terminology_terms_metadata_check check (jsonb_typeof(metadata) = 'object')
);

create unique index if not exists itotori_terminology_terms_branch_preferred_idx
  on itotori_terminology_terms(
    locale_branch_id,
    normalized_source_term,
    normalized_preferred_translation
  );
create index if not exists itotori_terminology_terms_project_idx
  on itotori_terminology_terms(project_id, locale_branch_id, status);
create index if not exists itotori_terminology_terms_exact_idx
  on itotori_terminology_terms(locale_branch_id, normalized_source_term);
create index if not exists itotori_terminology_terms_translation_idx
  on itotori_terminology_terms(locale_branch_id, normalized_preferred_translation);

create table if not exists itotori_terminology_aliases (
  alias_id text primary key,
  term_id text not null references itotori_terminology_terms(term_id) on delete cascade,
  alias_text text not null,
  normalized_alias_text text not null,
  alias_kind text not null,
  locale text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint itotori_terminology_aliases_kind_check check (
    alias_kind in ('source_alias', 'target_alias', 'disallowed_translation')
  ),
  constraint itotori_terminology_aliases_metadata_check check (jsonb_typeof(metadata) = 'object')
);

create unique index if not exists itotori_terminology_aliases_term_kind_idx
  on itotori_terminology_aliases(term_id, alias_kind, normalized_alias_text);
create index if not exists itotori_terminology_aliases_lookup_idx
  on itotori_terminology_aliases(alias_kind, normalized_alias_text);

create table if not exists itotori_terminology_source_refs (
  source_ref_id text primary key,
  term_id text not null references itotori_terminology_terms(term_id) on delete cascade,
  source_revision_id text references itotori_source_revisions(source_revision_id) on delete set null,
  bridge_unit_id text references itotori_source_units(bridge_unit_id) on delete set null,
  source_provenance_id text references itotori_catalog_source_provenance(source_provenance_id) on delete set null,
  reference_kind text not null,
  citation text not null,
  context text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint itotori_terminology_source_refs_kind_check check (
    reference_kind in ('source_unit', 'style_guide', 'catalog', 'manual', 'qa_finding')
  ),
  constraint itotori_terminology_source_refs_metadata_check check (jsonb_typeof(metadata) = 'object')
);

create index if not exists itotori_terminology_source_refs_term_idx
  on itotori_terminology_source_refs(term_id, reference_kind);
create index if not exists itotori_terminology_source_refs_revision_idx
  on itotori_terminology_source_refs(source_revision_id);
create index if not exists itotori_terminology_source_refs_bridge_unit_idx
  on itotori_terminology_source_refs(bridge_unit_id);
create index if not exists itotori_terminology_source_refs_provenance_idx
  on itotori_terminology_source_refs(source_provenance_id);

create table if not exists itotori_terminology_semantic_index (
  semantic_index_id text primary key,
  term_id text not null references itotori_terminology_terms(term_id) on delete cascade,
  search_document text not null,
  search_tokens jsonb not null,
  embedding_provider text not null,
  embedding_model text not null,
  embedding_dimension integer not null,
  embedding_vector jsonb,
  content_hash text not null,
  status text not null,
  metadata jsonb not null default '{}'::jsonb,
  refreshed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint itotori_terminology_semantic_index_status_check check (
    status in ('pending', 'ready', 'stale', 'failed')
  ),
  constraint itotori_terminology_semantic_index_dimension_check check (embedding_dimension >= 0),
  constraint itotori_terminology_semantic_index_tokens_check check (jsonb_typeof(search_tokens) = 'array'),
  constraint itotori_terminology_semantic_index_vector_check check (
    embedding_vector is null or jsonb_typeof(embedding_vector) = 'array'
  ),
  constraint itotori_terminology_semantic_index_metadata_check check (jsonb_typeof(metadata) = 'object')
);

create unique index if not exists itotori_terminology_semantic_index_term_idx
  on itotori_terminology_semantic_index(term_id);
create index if not exists itotori_terminology_semantic_index_status_idx
  on itotori_terminology_semantic_index(status, updated_at);
create index if not exists itotori_terminology_semantic_index_hash_idx
  on itotori_terminology_semantic_index(content_hash);

create table if not exists itotori_terminology_conflicts (
  conflict_id text primary key,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  locale_branch_id text not null references itotori_locale_branches(locale_branch_id) on delete cascade,
  normalized_source_term text not null,
  conflict_kind text not null,
  status text not null,
  summary text not null,
  finding_id text references itotori_findings(finding_id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  detected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint itotori_terminology_conflicts_kind_check check (
    conflict_kind in ('preferred_translation', 'alias', 'source_reference', 'locale_scope')
  ),
  constraint itotori_terminology_conflicts_status_check check (
    status in ('open', 'resolved', 'ignored')
  ),
  constraint itotori_terminology_conflicts_metadata_check check (jsonb_typeof(metadata) = 'object')
);

create index if not exists itotori_terminology_conflicts_branch_status_idx
  on itotori_terminology_conflicts(locale_branch_id, status, conflict_kind);
create index if not exists itotori_terminology_conflicts_finding_idx
  on itotori_terminology_conflicts(finding_id);

create table if not exists itotori_terminology_conflict_evidence (
  conflict_evidence_id text primary key,
  conflict_id text not null references itotori_terminology_conflicts(conflict_id) on delete cascade,
  term_id text references itotori_terminology_terms(term_id) on delete set null,
  source_ref_id text references itotori_terminology_source_refs(source_ref_id) on delete set null,
  evidence_position integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint itotori_terminology_conflict_evidence_position_check check (evidence_position >= 0),
  constraint itotori_terminology_conflict_evidence_metadata_check check (jsonb_typeof(metadata) = 'object')
);

create index if not exists itotori_terminology_conflict_evidence_conflict_idx
  on itotori_terminology_conflict_evidence(conflict_id, evidence_position);
create index if not exists itotori_terminology_conflict_evidence_term_idx
  on itotori_terminology_conflict_evidence(term_id);
