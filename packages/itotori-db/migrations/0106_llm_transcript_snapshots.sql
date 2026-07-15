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
