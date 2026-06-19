create table if not exists itotori_glossary_review_items (
  review_item_id text primary key,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  locale_branch_id text not null references itotori_locale_branches(locale_branch_id) on delete cascade,
  term_id text references itotori_terminology_terms(term_id) on delete set null,
  source_revision_id text not null references itotori_source_revisions(source_revision_id) on delete restrict,
  style_guide_version_id text references itotori_style_guide_versions(style_guide_version_id) on delete set null,
  state text not null,
  source_term text not null,
  normalized_source_term text not null,
  proposed_translation text not null,
  normalized_proposed_translation text not null,
  protected_span_refs jsonb not null default '[]'::jsonb,
  provenance jsonb not null default '{}'::jsonb,
  semantic_diagnostics jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_by_user_id text references itotori_users(user_id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint itotori_glossary_review_items_state_check check (
    state in ('proposed', 'approved', 'rejected', 'conflict', 'stale_source')
  ),
  constraint itotori_glossary_review_items_protected_refs_check check (
    jsonb_typeof(protected_span_refs) = 'array'
  ),
  constraint itotori_glossary_review_items_provenance_check check (jsonb_typeof(provenance) = 'object'),
  constraint itotori_glossary_review_items_diagnostics_check check (
    jsonb_typeof(semantic_diagnostics) = 'array'
  ),
  constraint itotori_glossary_review_items_metadata_check check (jsonb_typeof(metadata) = 'object')
);

create unique index if not exists itotori_glossary_review_items_proposal_idx
  on itotori_glossary_review_items(
    locale_branch_id,
    source_revision_id,
    normalized_source_term,
    normalized_proposed_translation
  );
create index if not exists itotori_glossary_review_items_term_idx
  on itotori_glossary_review_items(term_id, source_revision_id);
create index if not exists itotori_glossary_review_items_queue_idx
  on itotori_glossary_review_items(locale_branch_id, state, updated_at);
create index if not exists itotori_glossary_review_items_style_guide_idx
  on itotori_glossary_review_items(style_guide_version_id);
