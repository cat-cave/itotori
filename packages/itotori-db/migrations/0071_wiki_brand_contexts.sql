create table if not exists itotori_wiki_brand_contexts (
  brand_context_id text primary key,
  workspace_id text not null references itotori_workspaces(workspace_id) on delete cascade,
  context_key text not null,
  name text not null,
  description text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint itotori_wiki_brand_contexts_key_check check (
    char_length(context_key) between 1 and 128
  ),
  constraint itotori_wiki_brand_contexts_name_check check (
    char_length(name) between 1 and 512
  ),
  constraint itotori_wiki_brand_contexts_metadata_check check (jsonb_typeof(metadata) = 'object')
);

create unique index if not exists itotori_wiki_brand_contexts_workspace_key_idx
  on itotori_wiki_brand_contexts(workspace_id, context_key);

create index if not exists itotori_wiki_brand_contexts_workspace_name_idx
  on itotori_wiki_brand_contexts(workspace_id, name);

create unique index if not exists itotori_locale_branches_project_branch_unique_idx
  on itotori_locale_branches(project_id, locale_branch_id);

create table if not exists itotori_wiki_brand_context_memberships (
  brand_context_membership_id text primary key,
  brand_context_id text not null references itotori_wiki_brand_contexts(brand_context_id) on delete cascade,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  locale_branch_id text not null references itotori_locale_branches(locale_branch_id) on delete cascade,
  context_role text not null,
  inheritance_order integer not null default 0,
  provides_character_arcs boolean not null default true,
  provides_glossary boolean not null default true,
  provides_context boolean not null default true,
  inherits_character_arcs boolean not null default true,
  inherits_glossary boolean not null default true,
  inherits_context boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint itotori_wiki_brand_context_memberships_branch_fk
    foreign key (project_id, locale_branch_id)
    references itotori_locale_branches(project_id, locale_branch_id)
    on delete cascade,
  constraint itotori_wiki_brand_context_memberships_role_check check (
    context_role in ('base', 'sequel', 'fandisk', 'shared')
  ),
  constraint itotori_wiki_brand_context_memberships_order_check check (inheritance_order >= 0),
  constraint itotori_wiki_brand_context_memberships_metadata_check check (
    jsonb_typeof(metadata) = 'object'
  )
);

create unique index if not exists itotori_wiki_brand_context_memberships_scope_idx
  on itotori_wiki_brand_context_memberships(brand_context_id, project_id, locale_branch_id);

create index if not exists itotori_wiki_brand_context_memberships_branch_idx
  on itotori_wiki_brand_context_memberships(project_id, locale_branch_id);

create index if not exists itotori_wiki_brand_context_memberships_context_order_idx
  on itotori_wiki_brand_context_memberships(brand_context_id, inheritance_order, context_role);
