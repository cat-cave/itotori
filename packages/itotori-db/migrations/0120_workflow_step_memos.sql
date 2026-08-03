-- Completed logical workflow steps are restart checkpoints. The values can
-- contain localized text, so they use the same encrypted, retention-managed
-- history shape as other durable LLM artifacts.

create table if not exists itotori_llm_workflow_step_memos (
  memo_key text primary key,
  schema_version text not null default 'itotori.workflow-step-memo.v1',
  value_ciphertext bytea,
  value_key_ref text not null,
  value_content_hash text not null,
  created_at timestamptz not null default now(),
  retention_deadline timestamptz not null default (now() + interval '30 days'),
  deletion_state text not null default 'active'
    check (deletion_state in ('active', 'deleted')),
  deleted_at timestamptz,
  constraint itotori_llm_workflow_step_memos_identity check (
    memo_key ~ '^(pure-mtl:)?[0-9a-f]{64}$'
  ),
  constraint itotori_llm_workflow_step_memos_hash check (
    value_content_hash ~ '^sha256:[0-9a-f]{64}$'
  ),
  constraint itotori_llm_workflow_step_memos_retention check (
    retention_deadline <= created_at + interval '30 days'
  ),
  constraint itotori_llm_workflow_step_memos_deletion check (
    (deletion_state = 'active' and value_ciphertext is not null and deleted_at is null)
    or (deletion_state = 'deleted' and value_ciphertext is null and deleted_at is not null)
  )
);

create index if not exists itotori_llm_workflow_step_memos_retention_idx
  on itotori_llm_workflow_step_memos (retention_deadline, memo_key)
  where deletion_state = 'active';

insert into itotori_llm_encrypted_column_registry (
  table_name, ciphertext_column, key_ref_column, hash_column, retention_class
)
values (
  'itotori_llm_workflow_step_memos',
  'value_ciphertext',
  'value_key_ref',
  'value_content_hash',
  'run-30d'
)
on conflict (table_name, ciphertext_column) do nothing;

drop trigger if exists itotori_llm_workflow_step_memos_immutable
  on itotori_llm_workflow_step_memos;
create trigger itotori_llm_workflow_step_memos_immutable
before update or delete on itotori_llm_workflow_step_memos
for each row execute function itotori_llm_enforce_history_immutability();

drop trigger if exists itotori_llm_workflow_step_memos_no_truncate
  on itotori_llm_workflow_step_memos;
create trigger itotori_llm_workflow_step_memos_no_truncate
before truncate on itotori_llm_workflow_step_memos
for each statement execute function itotori_llm_reject_immutable_mutation();
