create table if not exists itotori_branch_policy_glossary_references (
  reference_id text primary key,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  locale_branch_id text not null references itotori_locale_branches(locale_branch_id) on delete cascade,
  version_sequence integer not null,
  style_guide_version_id text references itotori_style_guide_versions(style_guide_version_id) on delete set null,
  glossary_content_hash text not null,
  glossary_term_refs jsonb not null default '[]'::jsonb,
  glossary_review_item_refs jsonb not null default '[]'::jsonb,
  update_reason text not null,
  event_id text references itotori_events(event_id) on delete set null,
  supersedes_reference_id text,
  actor_user_id text references itotori_users(user_id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint itotori_branch_policy_glossary_refs_sequence_check check (version_sequence > 0),
  constraint itotori_branch_policy_glossary_refs_term_refs_check check (
    jsonb_typeof(glossary_term_refs) = 'array'
  ),
  constraint itotori_branch_policy_glossary_refs_review_refs_check check (
    jsonb_typeof(glossary_review_item_refs) = 'array'
  ),
  constraint itotori_branch_policy_glossary_refs_metadata_check check (
    jsonb_typeof(metadata) = 'object'
  )
);

create unique index if not exists itotori_branch_policy_glossary_refs_branch_sequence_idx
  on itotori_branch_policy_glossary_references(locale_branch_id, version_sequence);
create index if not exists itotori_branch_policy_glossary_refs_project_branch_idx
  on itotori_branch_policy_glossary_references(project_id, locale_branch_id, created_at);
create index if not exists itotori_branch_policy_glossary_refs_style_guide_idx
  on itotori_branch_policy_glossary_references(style_guide_version_id);
create index if not exists itotori_branch_policy_glossary_refs_hash_idx
  on itotori_branch_policy_glossary_references(locale_branch_id, glossary_content_hash);
create index if not exists itotori_branch_policy_glossary_refs_event_idx
  on itotori_branch_policy_glossary_references(event_id);

alter table itotori_locale_branch_units
  add column if not exists glossary_reference_id text
    references itotori_branch_policy_glossary_references(reference_id) on delete set null;

create index if not exists itotori_locale_branch_units_glossary_reference_idx
  on itotori_locale_branch_units(glossary_reference_id);

alter table itotori_glossary_review_items
  add column if not exists glossary_reference_id text
    references itotori_branch_policy_glossary_references(reference_id) on delete set null;

create index if not exists itotori_glossary_review_items_glossary_reference_idx
  on itotori_glossary_review_items(glossary_reference_id);
