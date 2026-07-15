-- Completed calls and accepted artifacts are durable facts. History is frozen
-- while small versioned head rows remain the only mutable selection state.

create table if not exists itotori_llm_encrypted_column_registry (
  table_name text not null,
  ciphertext_column text not null,
  key_ref_column text not null,
  hash_column text not null,
  retention_class text not null,
  deletion_state_column text not null default 'deletion_state',
  encryption_method text not null default 'operator-managed-envelope',
  primary key (table_name, ciphertext_column),
  constraint itotori_llm_encrypted_registry_table_name check (table_name like 'itotori_llm_%'),
  constraint itotori_llm_encrypted_registry_ciphertext_name check (
    ciphertext_column like '%ciphertext%'
  ),
  constraint itotori_llm_encrypted_registry_retention check (
    retention_class in ('attempt-7d', 'run-30d', 'accepted-365d')
  ),
  constraint itotori_llm_encrypted_registry_method check (
    encryption_method = 'operator-managed-envelope'
  )
);

create table if not exists itotori_llm_call_memos (
  memo_key text primary key,
  semantic_hash text not null unique,
  schema_version text not null,
  request_ciphertext bytea,
  request_key_ref text not null,
  request_content_hash text not null,
  response_ciphertext bytea,
  response_key_ref text not null,
  response_content_hash text not null,
  outcome_ciphertext bytea,
  outcome_key_ref text not null,
  outcome_content_hash text not null,
  outcome_kind text not null,
  verification_status text not null,
  generation_id text,
  requested_model text not null,
  provider_policy jsonb not null,
  served_model text,
  served_provider text,
  prompt_token_count integer not null,
  completion_token_count integer not null,
  reasoning_token_count integer not null,
  cached_token_count integer not null,
  billing_state text not null,
  cost_usd numeric(24, 12),
  completed_at timestamptz not null,
  retention_deadline timestamptz not null,
  deletion_state text not null default 'active',
  deleted_at timestamptz,
  constraint itotori_llm_call_memos_hashes check (
    memo_key ~ '^sha256:[0-9a-f]{64}$'
    and semantic_hash ~ '^sha256:[0-9a-f]{64}$'
    and request_content_hash ~ '^sha256:[0-9a-f]{64}$'
    and response_content_hash ~ '^sha256:[0-9a-f]{64}$'
    and outcome_content_hash ~ '^sha256:[0-9a-f]{64}$'
  ),
  constraint itotori_llm_call_memos_outcome check (
    outcome_kind in ('terminal', 'tool-calls', 'invalid', 'refusal', 'truncation')
  ),
  constraint itotori_llm_call_memos_verification check (
    verification_status in ('verified', 'quarantined')
  ),
  constraint itotori_llm_call_memos_served_pair check (
    (served_model is null) = (served_provider is null)
    and (verification_status <> 'verified' or (generation_id is not null and served_model is not null))
  ),
  constraint itotori_llm_call_memos_usage check (
    prompt_token_count >= 0 and completion_token_count >= 0
    and reasoning_token_count >= 0 and cached_token_count >= 0
  ),
  constraint itotori_llm_call_memos_billing check (
    (billing_state = 'confirmed' and cost_usd is not null and cost_usd >= 0)
    or (billing_state = 'billing_unknown' and cost_usd is null)
  ),
  constraint itotori_llm_call_memos_retention check (
    retention_deadline <= completed_at + interval '30 days'
  ),
  constraint itotori_llm_call_memos_deletion check (
    (deletion_state = 'active' and request_ciphertext is not null
      and response_ciphertext is not null and outcome_ciphertext is not null and deleted_at is null)
    or (deletion_state = 'deleted' and request_ciphertext is null
      and response_ciphertext is null and outcome_ciphertext is null and deleted_at is not null)
  )
);

create table if not exists itotori_llm_http_attempts (
  attempt_id text primary key,
  memo_key text not null,
  attempt_ordinal integer not null,
  request_ciphertext bytea,
  request_key_ref text not null,
  request_content_hash text not null,
  response_ciphertext bytea,
  response_key_ref text,
  response_content_hash text,
  request_hash text not null,
  attempt_status text not null,
  http_status integer,
  generation_id text,
  billing_state text not null,
  cost_usd numeric(24, 12),
  started_at timestamptz not null,
  completed_at timestamptz not null,
  retention_deadline timestamptz not null,
  deletion_state text not null default 'active',
  deleted_at timestamptz,
  constraint itotori_llm_http_attempts_semantic_unique unique (memo_key, attempt_ordinal),
  constraint itotori_llm_http_attempts_hashes check (
    memo_key ~ '^sha256:[0-9a-f]{64}$'
    and request_hash ~ '^sha256:[0-9a-f]{64}$'
    and request_content_hash ~ '^sha256:[0-9a-f]{64}$'
    and (response_content_hash is null or response_content_hash ~ '^sha256:[0-9a-f]{64}$')
  ),
  constraint itotori_llm_http_attempts_ordinal check (attempt_ordinal between 1 and 3),
  constraint itotori_llm_http_attempts_status check (
    attempt_status in ('completed', 'transport-error', 'http-error', 'cancelled')
  ),
  constraint itotori_llm_http_attempts_http_status check (
    http_status is null or http_status between 100 and 599
  ),
  constraint itotori_llm_http_attempts_billing check (
    (billing_state = 'confirmed' and cost_usd is not null and cost_usd >= 0)
    or (billing_state = 'billing_unknown' and cost_usd is null)
  ),
  constraint itotori_llm_http_attempts_times check (completed_at >= started_at),
  constraint itotori_llm_http_attempts_retention check (
    retention_deadline <= completed_at + interval '7 days'
  ),
  constraint itotori_llm_http_attempts_response_ref check (
    (response_key_ref is null) = (response_content_hash is null)
  ),
  constraint itotori_llm_http_attempts_deletion check (
    (deletion_state = 'active' and request_ciphertext is not null
      and (response_ciphertext is null) = (response_content_hash is null) and deleted_at is null)
    or (deletion_state = 'deleted' and request_ciphertext is null
      and response_ciphertext is null and deleted_at is not null)
  )
);

create table if not exists itotori_llm_conversation_events (
  event_id text primary key,
  schema_version text not null,
  parent_event_ids text[] not null default '{}',
  event_kind text not null,
  snapshot_kind text not null,
  snapshot_id text not null,
  actor_role text not null,
  event_body_ciphertext bytea,
  event_body_key_ref text not null,
  event_body_content_hash text not null,
  memo_key text,
  accepted boolean not null,
  created_at timestamptz not null,
  retention_deadline timestamptz not null,
  deletion_state text not null default 'active',
  deleted_at timestamptz,
  constraint itotori_llm_conversation_events_id check (event_id ~ '^sha256:[0-9a-f]{64}$'),
  constraint itotori_llm_conversation_events_parent check (not event_id = any(parent_event_ids)),
  constraint itotori_llm_conversation_events_kind check (
    event_kind in ('instruction', 'input', 'assistant', 'tool', 'artifact', 'defects')
  ),
  constraint itotori_llm_conversation_events_snapshot check (
    snapshot_kind in ('context', 'localization')
  ),
  constraint itotori_llm_conversation_events_hash check (
    event_body_content_hash ~ '^sha256:[0-9a-f]{64}$'
    and (memo_key is null or memo_key ~ '^sha256:[0-9a-f]{64}$')
  ),
  constraint itotori_llm_conversation_events_retention check (
    retention_deadline <= created_at + interval '30 days'
  ),
  constraint itotori_llm_conversation_events_deletion check (
    (deletion_state = 'active' and event_body_ciphertext is not null and deleted_at is null)
    or (deletion_state = 'deleted' and event_body_ciphertext is null and deleted_at is not null)
  )
);

create table if not exists itotori_llm_accepted_outputs (
  output_id text primary key,
  semantic_key text not null unique,
  schema_version text not null,
  output_version integer not null,
  supersedes_output_id text references itotori_llm_accepted_outputs(output_id) on delete restrict,
  parent_output_ids text[] not null default '{}',
  memo_keys text[] not null default '{}',
  snapshot_kind text not null,
  snapshot_id text not null,
  subject_type text not null,
  subject_id text not null,
  stage text not null,
  source_hash text,
  output_ciphertext bytea,
  output_key_ref text not null,
  output_content_hash text not null,
  accepted_at timestamptz not null,
  retention_deadline timestamptz not null,
  deletion_state text not null default 'active',
  deleted_at timestamptz,
  constraint itotori_llm_accepted_outputs_version_unique unique (
    snapshot_kind, snapshot_id, subject_type, subject_id, stage, output_version
  ),
  constraint itotori_llm_accepted_outputs_version check (output_version > 0),
  constraint itotori_llm_accepted_outputs_snapshot check (
    snapshot_kind in ('context', 'localization')
  ),
  constraint itotori_llm_accepted_outputs_subject check (
    subject_type in ('unit', 'wiki-object', 'translation-object', 'localized-rendering')
  ),
  constraint itotori_llm_accepted_outputs_hashes check (
    semantic_key ~ '^sha256:[0-9a-f]{64}$'
    and output_content_hash ~ '^sha256:[0-9a-f]{64}$'
    and (source_hash is null or source_hash ~ '^sha256:[0-9a-f]{64}$')
  ),
  constraint itotori_llm_accepted_outputs_source check (
    subject_type not in ('unit', 'translation-object') or source_hash is not null
  ),
  constraint itotori_llm_accepted_outputs_retention check (
    retention_deadline <= accepted_at + interval '365 days'
  ),
  constraint itotori_llm_accepted_outputs_deletion check (
    (deletion_state = 'active' and output_ciphertext is not null and deleted_at is null)
    or (deletion_state = 'deleted' and output_ciphertext is null and deleted_at is not null)
  )
);

create table if not exists itotori_llm_wiki_versions (
  wiki_version_id text primary key,
  wiki_kind text not null,
  object_id text not null,
  object_version integer not null,
  supersedes_version integer,
  snapshot_kind text not null,
  snapshot_id text not null,
  object_kind text not null,
  wiki_ciphertext bytea,
  wiki_key_ref text not null,
  wiki_content_hash text not null,
  created_at timestamptz not null,
  retention_deadline timestamptz not null,
  deletion_state text not null default 'active',
  deleted_at timestamptz,
  constraint itotori_llm_wiki_versions_identity unique (wiki_kind, object_id, object_version),
  constraint itotori_llm_wiki_versions_semantic unique (wiki_kind, object_id, wiki_content_hash),
  constraint itotori_llm_wiki_versions_parent foreign key (wiki_kind, object_id, supersedes_version)
    references itotori_llm_wiki_versions(wiki_kind, object_id, object_version) on delete restrict,
  constraint itotori_llm_wiki_versions_kind check (
    wiki_kind in ('source-object', 'translation-object', 'localized-rendering')
  ),
  constraint itotori_llm_wiki_versions_snapshot check (
    snapshot_kind in ('context', 'localization')
  ),
  constraint itotori_llm_wiki_versions_version check (
    object_version > 0 and (supersedes_version is null or supersedes_version < object_version)
  ),
  constraint itotori_llm_wiki_versions_hash check (
    wiki_content_hash ~ '^sha256:[0-9a-f]{64}$'
  ),
  constraint itotori_llm_wiki_versions_retention check (
    retention_deadline <= created_at + interval '365 days'
  ),
  constraint itotori_llm_wiki_versions_deletion check (
    (deletion_state = 'active' and wiki_ciphertext is not null and deleted_at is null)
    or (deletion_state = 'deleted' and wiki_ciphertext is null and deleted_at is not null)
  )
);

create table if not exists itotori_llm_dependency_edges (
  edge_id text primary key,
  downstream_wiki_version_id text not null
    references itotori_llm_wiki_versions(wiki_version_id) on delete restrict,
  dependency_hash text not null,
  upstream_object_id text not null,
  upstream_version integer not null,
  claim_id text,
  field_path text[] not null default '{}',
  rendering_id text,
  scope_ref jsonb not null,
  from_play_order integer,
  through_play_order integer,
  created_at timestamptz not null,
  constraint itotori_llm_dependency_edges_semantic unique (
    downstream_wiki_version_id, dependency_hash
  ),
  constraint itotori_llm_dependency_edges_hash check (
    dependency_hash ~ '^sha256:[0-9a-f]{64}$'
  ),
  constraint itotori_llm_dependency_edges_version check (upstream_version > 0),
  constraint itotori_llm_dependency_edges_locator check (
    claim_id is not null or cardinality(field_path) > 0 or rendering_id is not null
  ),
  constraint itotori_llm_dependency_edges_order check (
    (from_play_order is null or from_play_order >= 0)
    and (through_play_order is null or through_play_order >= 0)
    and (from_play_order is null or through_play_order is null or through_play_order >= from_play_order)
  )
);

create table if not exists itotori_llm_human_inputs (
  input_id text primary key,
  input_kind text not null,
  subject_ref text not null,
  human_input_ciphertext bytea,
  human_input_key_ref text not null,
  human_input_content_hash text not null,
  created_at timestamptz not null,
  retention_deadline timestamptz not null,
  deletion_state text not null default 'active',
  deleted_at timestamptz,
  constraint itotori_llm_human_inputs_kind check (input_kind in ('edit', 'feedback')),
  constraint itotori_llm_human_inputs_hash check (
    human_input_content_hash ~ '^sha256:[0-9a-f]{64}$'
  ),
  constraint itotori_llm_human_inputs_retention check (
    retention_deadline <= created_at + interval '365 days'
  ),
  constraint itotori_llm_human_inputs_deletion check (
    (deletion_state = 'active' and human_input_ciphertext is not null and deleted_at is null)
    or (deletion_state = 'deleted' and human_input_ciphertext is null and deleted_at is not null)
  )
);

create table if not exists itotori_llm_cas_heads (
  head_namespace text not null,
  snapshot_id text not null,
  subject_type text not null,
  subject_id text not null,
  head_stage text not null,
  head_id text not null,
  head_version integer not null,
  head_content_hash text not null,
  updated_at timestamptz not null,
  primary key (head_namespace, snapshot_id, subject_type, subject_id, head_stage),
  constraint itotori_llm_cas_heads_namespace check (
    head_namespace in ('accepted-output', 'wiki-version')
  ),
  constraint itotori_llm_cas_heads_version check (head_version > 0),
  constraint itotori_llm_cas_heads_hash check (
    head_content_hash ~ '^sha256:[0-9a-f]{64}$'
  )
);

insert into itotori_llm_encrypted_column_registry (
  table_name, ciphertext_column, key_ref_column, hash_column, retention_class
)
values
  ('itotori_llm_call_memos', 'request_ciphertext', 'request_key_ref', 'request_content_hash', 'run-30d'),
  ('itotori_llm_call_memos', 'response_ciphertext', 'response_key_ref', 'response_content_hash', 'run-30d'),
  ('itotori_llm_call_memos', 'outcome_ciphertext', 'outcome_key_ref', 'outcome_content_hash', 'run-30d'),
  ('itotori_llm_http_attempts', 'request_ciphertext', 'request_key_ref', 'request_content_hash', 'attempt-7d'),
  ('itotori_llm_http_attempts', 'response_ciphertext', 'response_key_ref', 'response_content_hash', 'attempt-7d'),
  ('itotori_llm_conversation_events', 'event_body_ciphertext', 'event_body_key_ref', 'event_body_content_hash', 'run-30d'),
  ('itotori_llm_accepted_outputs', 'output_ciphertext', 'output_key_ref', 'output_content_hash', 'accepted-365d'),
  ('itotori_llm_wiki_versions', 'wiki_ciphertext', 'wiki_key_ref', 'wiki_content_hash', 'accepted-365d'),
  ('itotori_llm_human_inputs', 'human_input_ciphertext', 'human_input_key_ref', 'human_input_content_hash', 'accepted-365d')
on conflict (table_name, ciphertext_column) do nothing;

create or replace function itotori_llm_enforce_history_immutability()
returns trigger
language plpgsql
as $$
declare
  column_name text;
  old_metadata jsonb;
  new_metadata jsonb;
begin
  if tg_op = 'DELETE' then
    raise exception '% history is immutable', tg_table_name;
  end if;
  if old.deletion_state <> 'active' or new.deletion_state <> 'deleted' or new.deleted_at is null then
    raise exception '% history is immutable', tg_table_name;
  end if;
  old_metadata := to_jsonb(old) - 'deletion_state' - 'deleted_at';
  new_metadata := to_jsonb(new) - 'deletion_state' - 'deleted_at';
  for column_name in select jsonb_object_keys(old_metadata)
  loop
    if column_name like '%ciphertext%' then
      if new_metadata -> column_name is distinct from 'null'::jsonb then
        raise exception '% deletion must remove ciphertext', tg_table_name;
      end if;
      old_metadata := old_metadata - column_name;
      new_metadata := new_metadata - column_name;
    end if;
  end loop;
  if old_metadata is distinct from new_metadata then
    raise exception '% history metadata is immutable', tg_table_name;
  end if;
  return new;
end;
$$;

create or replace function itotori_llm_reject_immutable_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception '% history is immutable', tg_table_name;
end;
$$;

create or replace function itotori_llm_enforce_cas_head_advance()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'CAS heads cannot be deleted';
  end if;
  if tg_op = 'UPDATE' then
    if new.head_namespace <> old.head_namespace
      or new.snapshot_id <> old.snapshot_id
      or new.subject_type <> old.subject_type
      or new.subject_id <> old.subject_id
      or new.head_stage <> old.head_stage
      or new.head_version <> old.head_version + 1
      or (new.head_id = old.head_id and new.head_content_hash = old.head_content_hash)
    then
      raise exception 'CAS head advance is invalid';
    end if;
  end if;
  if new.head_namespace = 'accepted-output' then
    if not exists (
      select 1 from itotori_llm_accepted_outputs
      where output_id = new.head_id and output_version = new.head_version
        and output_content_hash = new.head_content_hash
    ) then
      raise exception 'CAS head target is invalid';
    end if;
  elsif not exists (
    select 1 from itotori_llm_wiki_versions
    where wiki_version_id = new.head_id and object_version = new.head_version
      and wiki_content_hash = new.head_content_hash
  ) then
    raise exception 'CAS head target is invalid';
  end if;
  return new;
end;
$$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'itotori_llm_call_memos',
    'itotori_llm_http_attempts',
    'itotori_llm_conversation_events',
    'itotori_llm_accepted_outputs',
    'itotori_llm_wiki_versions',
    'itotori_llm_human_inputs'
  ]
  loop
    execute format('drop trigger if exists itotori_llm_history_immutable on %I', table_name);
    execute format(
      'create trigger itotori_llm_history_immutable before update or delete on %I '
      'for each row execute function itotori_llm_enforce_history_immutability()',
      table_name
    );
  end loop;
end;
$$;

drop trigger if exists itotori_llm_dependency_edges_immutable on itotori_llm_dependency_edges;
create trigger itotori_llm_dependency_edges_immutable
before update or delete on itotori_llm_dependency_edges
for each row execute function itotori_llm_reject_immutable_mutation();

drop trigger if exists itotori_llm_encrypted_registry_immutable
  on itotori_llm_encrypted_column_registry;
create trigger itotori_llm_encrypted_registry_immutable
before update or delete on itotori_llm_encrypted_column_registry
for each row execute function itotori_llm_reject_immutable_mutation();

drop trigger if exists itotori_llm_cas_heads_advance on itotori_llm_cas_heads;
create trigger itotori_llm_cas_heads_advance
before insert or update or delete on itotori_llm_cas_heads
for each row execute function itotori_llm_enforce_cas_head_advance();
