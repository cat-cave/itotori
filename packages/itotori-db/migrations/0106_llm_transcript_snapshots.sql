-- Content-addressed snapshot identities and the single immutable transcript
-- DAG build on the encrypted conversation-event shell introduced in 0101.

create table if not exists itotori_llm_context_snapshots (
  snapshot_id text primary key,
  schema_version text not null,
  snapshot_content_hash text not null,
  snapshot_identity jsonb not null,
  created_at timestamptz not null,
  constraint itotori_llm_context_snapshots_hash check (
    snapshot_id ~ '^sha256:[0-9a-f]{64}$'
    and snapshot_content_hash = snapshot_id
  ),
  constraint itotori_llm_context_snapshots_schema check (
    schema_version = 'itotori.context-snapshot.v1'
  ),
  constraint itotori_llm_context_snapshots_identity check (
    jsonb_typeof(snapshot_identity) = 'object'
  )
);

create table if not exists itotori_llm_localization_snapshots (
  snapshot_id text primary key,
  schema_version text not null,
  snapshot_content_hash text not null,
  context_snapshot_id text not null
    references itotori_llm_context_snapshots(snapshot_id) on delete restrict,
  snapshot_identity jsonb not null,
  created_at timestamptz not null,
  constraint itotori_llm_localization_snapshots_hash check (
    snapshot_id ~ '^sha256:[0-9a-f]{64}$'
    and snapshot_content_hash = snapshot_id
  ),
  constraint itotori_llm_localization_snapshots_schema check (
    schema_version = 'itotori.localization-snapshot.v1'
  ),
  constraint itotori_llm_localization_snapshots_identity check (
    jsonb_typeof(snapshot_identity) = 'object'
  )
);

alter table itotori_llm_conversation_events
  add column if not exists projection_kind text,
  add column if not exists projection_ref text,
  add column if not exists projection_auxiliary_ref text,
  drop constraint if exists itotori_llm_conversation_events_parent_count,
  add constraint itotori_llm_conversation_events_parent_count check (
    cardinality(parent_event_ids) <= 32
  ),
  drop constraint if exists itotori_llm_conversation_events_content_snapshot,
  add constraint itotori_llm_conversation_events_content_snapshot check (
    snapshot_id ~ '^sha256:[0-9a-f]{64}$'
  ) not valid,
  drop constraint if exists itotori_llm_conversation_events_current_schema,
  add constraint itotori_llm_conversation_events_current_schema check (
    schema_version = 'itotori.conversation-event.v1'
  ) not valid,
  drop constraint if exists itotori_llm_conversation_events_projection_shape,
  add constraint itotori_llm_conversation_events_projection_shape check (
    (
      projection_kind is null
      and projection_ref is null
      and projection_auxiliary_ref is null
    )
    or (
      projection_kind = 'local-turn'
      and projection_ref is null
      and projection_auxiliary_ref is null
    )
    or (
      projection_kind in (
        'role-contract', 'snapshot-fact', 'semantic-note', 'accepted-target', 'source-batch'
      )
      and projection_ref is not null
      and projection_auxiliary_ref is null
    )
    or (
      projection_kind = 'tool-loop'
      and projection_ref is not null
      and projection_auxiliary_ref is not null
    )
  );

alter table itotori_llm_accepted_outputs
  drop constraint if exists itotori_llm_accepted_outputs_content_snapshot,
  add constraint itotori_llm_accepted_outputs_content_snapshot check (
    snapshot_id ~ '^sha256:[0-9a-f]{64}$'
  ) not valid;

alter table itotori_llm_wiki_versions
  drop constraint if exists itotori_llm_wiki_versions_content_snapshot,
  add constraint itotori_llm_wiki_versions_content_snapshot check (
    snapshot_id ~ '^sha256:[0-9a-f]{64}$'
  ) not valid;

alter table itotori_llm_cas_heads
  drop constraint if exists itotori_llm_cas_heads_content_snapshot,
  add constraint itotori_llm_cas_heads_content_snapshot check (
    snapshot_id ~ '^sha256:[0-9a-f]{64}$'
  ) not valid;

create or replace function itotori_llm_validate_conversation_event()
returns trigger
language plpgsql
as $$
declare
  canonical_parents text[];
  canonical_parent_json text;
  canonical_identity text;
  expected_event_id text;
begin
  select coalesce(array_agg(parent_id order by parent_id collate "C"), '{}'::text[])
  into canonical_parents
  from unnest(new.parent_event_ids) parent_id;

  if canonical_parents is distinct from new.parent_event_ids
    or cardinality(canonical_parents) <> (
      select count(distinct parent_id) from unnest(new.parent_event_ids) parent_id
    )
    or exists (
      select 1 from unnest(new.parent_event_ids) parent_id
      where parent_id is null or parent_id !~ '^sha256:[0-9a-f]{64}$'
    )
  then
    raise exception 'conversation parent event IDs must be unique canonical SHA-256 hashes'
      using errcode = '23514';
  end if;

  select '[' || coalesce(
    string_agg(to_jsonb(parent_id)::text, ',' order by parent_id collate "C"),
    ''
  ) || ']'
  into canonical_parent_json
  from unnest(canonical_parents) parent_id;

  canonical_identity :=
    '{"bodyContentHash":' || to_jsonb(new.event_body_content_hash)::text ||
    ',"kind":' || to_jsonb(new.event_kind)::text ||
    ',"memoKey":' || coalesce(to_jsonb(new.memo_key)::text, 'null') ||
    ',"parentIds":' || canonical_parent_json ||
    ',"role":' || to_jsonb(new.actor_role)::text ||
    ',"snapshotId":' || to_jsonb(new.snapshot_id)::text || '}';
  expected_event_id := 'sha256:' || encode(
    sha256(convert_to(canonical_identity, 'UTF8')),
    'hex'
  );
  if new.event_id is distinct from expected_event_id then
    raise exception 'conversation event ID does not match its canonical content'
      using errcode = '23514';
  end if;

  if new.memo_key is not null and not exists (
    select 1 from itotori_llm_call_memos memo where memo.memo_key = new.memo_key
  ) then
    raise exception 'conversation event memo key does not reference a completed physical step'
      using errcode = '23503';
  end if;
  return new;
end;
$$;

drop trigger if exists itotori_llm_conversation_event_identity
  on itotori_llm_conversation_events;
create trigger itotori_llm_conversation_event_identity
before insert on itotori_llm_conversation_events
for each row execute function itotori_llm_validate_conversation_event();

-- Reassert the RB-013 encrypted-column registry entry in the migration that
-- activates the event DAG. This remains idempotent on both fresh and upgraded
-- databases and makes the body-storage boundary locally auditable.
insert into itotori_llm_encrypted_column_registry (
  table_name, ciphertext_column, key_ref_column, hash_column, retention_class
)
values (
  'itotori_llm_conversation_events', 'event_body_ciphertext',
  'event_body_key_ref', 'event_body_content_hash', 'run-30d'
)
on conflict (table_name, ciphertext_column) do nothing;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'itotori_llm_context_snapshots',
    'itotori_llm_localization_snapshots'
  ]
  loop
    execute format('drop trigger if exists itotori_llm_snapshot_immutable on %I', table_name);
    execute format(
      'create trigger itotori_llm_snapshot_immutable before update or delete on %I '
      'for each row execute function itotori_llm_reject_immutable_mutation()',
      table_name
    );
    execute format('drop trigger if exists itotori_llm_snapshot_truncate_guard on %I', table_name);
    execute format(
      'create trigger itotori_llm_snapshot_truncate_guard before truncate on %I '
      'for each statement execute function itotori_llm_reject_immutable_mutation()',
      table_name
    );
  end loop;
end;
$$;

-- Strict WikiObject and localized-rendering persistence. The encrypted body in
-- itotori_llm_wiki_versions (0101) becomes a fully typed versioned object: a
-- SOURCE object is source-language and target-agnostic and lives on a CONTEXT
-- snapshot, while a translation object and a per-target localized rendering
-- both carry the target and live on a LOCALIZATION snapshot. The typed columns
-- are extracted from the same validated object that seeds the content hash, so
-- a forged category, scope, provenance, or target binding is rejected here.
alter table itotori_llm_wiki_versions
  add column if not exists object_language text,
  add column if not exists subject_kind text,
  add column if not exists subject_id text,
  add column if not exists scope_kind text,
  add column if not exists scope_route_ids text[] not null default '{}',
  add column if not exists provisional boolean,
  add column if not exists context_scope text,
  add column if not exists run_mode text,
  add column if not exists provenance_edited_by text,
  add column if not exists provenance_author_role text,
  add column if not exists localization_snapshot_id text,
  add column if not exists source_object_id text;

alter table itotori_llm_wiki_versions
  drop constraint if exists itotori_llm_wiki_versions_localization_fk,
  add constraint itotori_llm_wiki_versions_localization_fk
    foreign key (localization_snapshot_id)
    references itotori_llm_localization_snapshots(snapshot_id) on delete restrict,
  drop constraint if exists itotori_llm_wiki_versions_language,
  add constraint itotori_llm_wiki_versions_language check (
    object_language ~ '^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$'
  ),
  drop constraint if exists itotori_llm_wiki_versions_subject_kind,
  add constraint itotori_llm_wiki_versions_subject_kind check (
    subject_kind is null
    or subject_kind in (
      'game', 'route', 'scene', 'unit', 'character',
      'glossary-term', 'choice', 'organization', 'user', 'genre'
    )
  ),
  drop constraint if exists itotori_llm_wiki_versions_scope,
  add constraint itotori_llm_wiki_versions_scope check (
    (scope_kind = 'global' and cardinality(scope_route_ids) = 0)
    or (scope_kind = 'route' and cardinality(scope_route_ids) = 1)
    or (scope_kind = 'route-set' and cardinality(scope_route_ids) >= 1)
  ),
  drop constraint if exists itotori_llm_wiki_versions_run_mode,
  add constraint itotori_llm_wiki_versions_run_mode check (
    run_mode in ('production', 'pilot', 'test-dev')
  ),
  drop constraint if exists itotori_llm_wiki_versions_context_scope,
  add constraint itotori_llm_wiki_versions_context_scope check (
    context_scope is null
    or context_scope in ('whole-game', 'external-augmented')
    or context_scope ~ '^narrowed:[^\s].{0,127}$'
  ),
  drop constraint if exists itotori_llm_wiki_versions_edited_by,
  add constraint itotori_llm_wiki_versions_edited_by check (
    provenance_edited_by is null
    or provenance_edited_by in ('human', 'enhancement', 'agent')
  ),
  drop constraint if exists itotori_llm_wiki_versions_author_role,
  add constraint itotori_llm_wiki_versions_author_role check (
    provenance_author_role is null
    or provenance_author_role ~ '^(A[1-9]|A10|P[1-3]|Q[1-6])$'
  ),
  drop constraint if exists itotori_llm_wiki_versions_required,
  add constraint itotori_llm_wiki_versions_required check (
    object_language is not null and scope_kind is not null
    and provisional is not null and run_mode is not null
  ),
  drop constraint if exists itotori_llm_wiki_versions_category,
  add constraint itotori_llm_wiki_versions_category check (
    (
      wiki_kind in ('source-object', 'localized-rendering')
      and object_kind in (
        'style-contract', 'term-ruling', 'scene-summary', 'story-so-far',
        'route-arc', 'voice-profile', 'adaptation-note', 'character-bio',
        'character-background', 'character-route-arc', 'speaker-hypothesis'
      )
    )
    or (wiki_kind = 'translation-object' and object_kind = 'translation')
  ),
  drop constraint if exists itotori_llm_wiki_versions_target_binding,
  add constraint itotori_llm_wiki_versions_target_binding check (
    (
      wiki_kind = 'source-object'
      and snapshot_kind = 'context'
      and localization_snapshot_id is null
      and source_object_id is null
      and subject_kind is not null and subject_id is not null
      and context_scope is not null
    )
    or (
      wiki_kind = 'translation-object'
      and snapshot_kind = 'localization'
      and localization_snapshot_id is not null
      and source_object_id is null
      and subject_kind is not null and subject_id is not null
      and context_scope is not null
    )
    or (
      wiki_kind = 'localized-rendering'
      and snapshot_kind = 'localization'
      and localization_snapshot_id is not null
      and source_object_id is not null
      and subject_kind is null and subject_id is null
      and context_scope is null
    )
  );

-- A localization object's snapshot is its localization snapshot (the FK on
-- localization_snapshot_id proves that snapshot exists), and a localized
-- rendering must localize an existing source object. A source object's context
-- snapshot cannot carry a foreign key because snapshot_id is polymorphic, so its
-- context membership is guaranteed by the sole strict writer.
create or replace function itotori_llm_validate_wiki_version()
returns trigger
language plpgsql
as $$
begin
  if new.snapshot_kind = 'localization'
    and new.snapshot_id is distinct from new.localization_snapshot_id then
    raise exception 'localization wiki object snapshot must equal its localization snapshot'
      using errcode = '23514';
  end if;
  if new.wiki_kind = 'localized-rendering' and not exists (
    select 1 from itotori_llm_wiki_versions source_object
    where source_object.object_id = new.source_object_id
      and source_object.wiki_kind = 'source-object'
  ) then
    raise exception 'localized rendering must reference an existing source object'
      using errcode = '23503';
  end if;
  return new;
end;
$$;

drop trigger if exists itotori_llm_wiki_version_validate on itotori_llm_wiki_versions;
create trigger itotori_llm_wiki_version_validate
before insert on itotori_llm_wiki_versions
for each row execute function itotori_llm_validate_wiki_version();
