-- Persistent context brain history (design §4), following durable cost-account migrations.
--
-- `itotori_context_artifacts` remains the mutable ContextEntry/head projection
-- used by live retrieval. A content hash proves bytes, but cannot identify two
-- writes of the same bytes or preserve a prior packet after the entry changes.
-- Every repository upsert therefore appends one complete ContextEntryVersion
-- snapshot and moves this head pointer. The snapshot includes citation and
-- affected-unit data so an older ContextPacket is reconstructable without
-- consulting the mutable current-source join.

alter table itotori_context_artifacts
  add column if not exists head_version_id text;

-- Some pre-versioned deployments already received this supporting key through
-- schema provisioning. Preserve that compatible key instead of failing the
-- forward migration on its relation name; fresh installs create it here.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'itotori_context_artifacts_scope_key'
      and conrelid = 'itotori_context_artifacts'::regclass
  ) then
    alter table itotori_context_artifacts
      add constraint itotori_context_artifacts_scope_key
      unique (context_artifact_id, project_id, locale_branch_id);
  end if;
end;
$$;

create table if not exists itotori_context_entry_versions (
  context_entry_version_id text primary key,
  context_artifact_id text not null,
  project_id text not null,
  locale_branch_id text not null,
  parent_version_id text,
  source_revision_id text not null references itotori_source_revisions(source_revision_id) on delete restrict,
  category text not null check (
    category in (
      'scene_summary',
      'character_note',
      'route_map',
      'speaker_label',
      'terminology_candidate'
    )
  ),
  status text not null check (
    status in ('active', 'stale', 'superseded', 'rejected')
  ),
  title text not null,
  normalized_title text not null,
  body text not null,
  data jsonb not null default '{}'::jsonb,
  content_hash text not null,
  produced_by_agent text,
  produced_by_tool text,
  producer_version text not null,
  provenance jsonb not null default '{}'::jsonb,
  citations jsonb not null default '[]'::jsonb,
  affected_unit_ids jsonb not null default '[]'::jsonb,
  invalidated_reason text,
  invalidated_at timestamptz,
  created_by_user_id text references itotori_users(user_id) on delete set null,
  created_at timestamptz not null default now(),
  constraint itotori_context_entry_versions_scope_key unique (
    context_entry_version_id,
    context_artifact_id,
    project_id,
    locale_branch_id
  ),
  constraint itotori_context_entry_versions_entry_scope_fkey
    foreign key (context_artifact_id, project_id, locale_branch_id)
    references itotori_context_artifacts(context_artifact_id, project_id, locale_branch_id)
    on delete cascade,
  constraint itotori_context_entry_versions_parent_scope_fkey
    foreign key (parent_version_id, context_artifact_id, project_id, locale_branch_id)
    references itotori_context_entry_versions(
      context_entry_version_id,
      context_artifact_id,
      project_id,
      locale_branch_id
    )
    on delete cascade,
  check (produced_by_agent is not null or produced_by_tool is not null),
  check (char_length(title) between 1 and 512),
  check (char_length(body) <= 20000),
  check (octet_length(data::text) <= 65536),
  check (octet_length(provenance::text) <= 65536),
  check (jsonb_typeof(citations) = 'array'),
  check (jsonb_typeof(affected_unit_ids) = 'array')
);

create index if not exists itotori_context_entry_versions_entry_created_idx
  on itotori_context_entry_versions(context_artifact_id, created_at);

create index if not exists itotori_context_entry_versions_parent_idx
  on itotori_context_entry_versions(parent_version_id);

create index if not exists itotori_context_entry_versions_branch_created_idx
  on itotori_context_entry_versions(locale_branch_id, created_at);

-- A migrated database can already have a mutable current artifact. Seed one
-- baseline version per such entry before requiring a non-dangling head. The
-- deterministic id makes a recovery/replay of this forward migration safe;
-- future versions use repository-generated UUIDv7 ids.
insert into itotori_context_entry_versions (
  context_entry_version_id,
  context_artifact_id,
  project_id,
  locale_branch_id,
  parent_version_id,
  source_revision_id,
  category,
  status,
  title,
  normalized_title,
  body,
  data,
  content_hash,
  produced_by_agent,
  produced_by_tool,
  producer_version,
  provenance,
  citations,
  affected_unit_ids,
  invalidated_reason,
  invalidated_at,
  created_by_user_id,
  created_at
)
select
  'context-entry-version:baseline:' || ca.context_artifact_id,
  ca.context_artifact_id,
  ca.project_id,
  ca.locale_branch_id,
  null,
  ca.source_revision_id,
  ca.category,
  ca.status,
  ca.title,
  ca.normalized_title,
  ca.body,
  ca.data,
  ca.content_hash,
  ca.produced_by_agent,
  ca.produced_by_tool,
  ca.producer_version,
  ca.provenance,
  coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'bridgeUnitId', casu.bridge_unit_id,
          'sourceRevisionId', casu.source_revision_id,
          'sourceHash', casu.source_hash,
          'citation', casu.citation,
          'metadata', casu.metadata
        )
        order by casu.bridge_unit_id
      )
      from itotori_context_artifact_source_units casu
      where casu.context_artifact_id = ca.context_artifact_id
    ),
    '[]'::jsonb
  ),
  coalesce(
    (
      select jsonb_agg(casu.bridge_unit_id order by casu.bridge_unit_id)
      from itotori_context_artifact_source_units casu
      where casu.context_artifact_id = ca.context_artifact_id
    ),
    '[]'::jsonb
  ),
  ca.invalidated_reason,
  ca.invalidated_at,
  ca.created_by_user_id,
  ca.created_at
from itotori_context_artifacts ca
where ca.head_version_id is null
on conflict (context_entry_version_id) do nothing;

update itotori_context_artifacts ca
set head_version_id = cev.context_entry_version_id
from itotori_context_entry_versions cev
where ca.head_version_id is null
  and cev.context_artifact_id = ca.context_artifact_id
  and cev.project_id = ca.project_id
  and cev.locale_branch_id = ca.locale_branch_id;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'itotori_context_artifacts_head_version_scope_fkey'
      and conrelid = 'itotori_context_artifacts'::regclass
  ) then
    alter table itotori_context_artifacts
      add constraint itotori_context_artifacts_head_version_scope_fkey
      foreign key (head_version_id, context_artifact_id, project_id, locale_branch_id)
      references itotori_context_entry_versions(
        context_entry_version_id,
        context_artifact_id,
        project_id,
        locale_branch_id
      )
      deferrable initially deferred;
  end if;
end;
$$;

-- Version snapshots are immutable. The only sanctioned deletion is a cascade
-- from deleting the owning ContextEntry; its before-delete trigger marks the
-- transaction so a raw delete cannot silently rewrite history.
create or replace function itotori_context_entry_versions_append_only()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'itotori_context_entry_versions is append-only: versions cannot be rewritten';
  end if;
  if coalesce(current_setting('itotori.context_entry_versions_prune', true), '') <> 'on' then
    raise exception 'itotori_context_entry_versions is append-only: delete only with owning entry';
  end if;
  return old;
end;
$$;

drop trigger if exists itotori_context_entry_versions_append_only_trigger
  on itotori_context_entry_versions;

create trigger itotori_context_entry_versions_append_only_trigger
before update or delete on itotori_context_entry_versions
for each row execute function itotori_context_entry_versions_append_only();

create or replace function itotori_context_artifacts_prepare_version_prune()
returns trigger
language plpgsql
as $$
begin
  perform set_config('itotori.context_entry_versions_prune', 'on', true);
  return old;
end;
$$;

drop trigger if exists itotori_context_artifacts_prepare_version_prune_trigger
  on itotori_context_artifacts;

create trigger itotori_context_artifacts_prepare_version_prune_trigger
before delete on itotori_context_artifacts
for each row execute function itotori_context_artifacts_prepare_version_prune();
