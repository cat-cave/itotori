create table if not exists itotori_exact_search_documents (
  search_document_id text primary key,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  locale_branch_id text not null references itotori_locale_branches(locale_branch_id) on delete cascade,
  source_revision_id text not null references itotori_source_revisions(source_revision_id) on delete restrict,
  source_artifact_type text not null,
  source_artifact_id text not null references itotori_source_units(bridge_unit_id) on delete cascade,
  exact_term text not null,
  normalized_exact_term text not null,
  source_locale text not null,
  target_locale text not null,
  provenance jsonb not null default '{}'::jsonb,
  refreshed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists itotori_exact_search_docs_source_term_idx
  on itotori_exact_search_documents(
    locale_branch_id,
    source_revision_id,
    source_artifact_type,
    source_artifact_id,
    normalized_exact_term
  );

create index if not exists itotori_exact_search_docs_lookup_idx
  on itotori_exact_search_documents(
    locale_branch_id,
    source_revision_id,
    normalized_exact_term,
    source_artifact_type
  );

create index if not exists itotori_exact_search_docs_project_branch_idx
  on itotori_exact_search_documents(project_id, locale_branch_id, source_revision_id);
