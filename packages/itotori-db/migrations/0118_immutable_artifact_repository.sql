-- Immutable artifacts are normalized so authorization can be checked before a
-- content-bearing column is selected. Payloads are envelope-encrypted by the
-- application; this schema never persists a plaintext or Base64 payload.

create table if not exists itotori_immutable_artifacts (
  artifact_id text primary key check (artifact_id ~ '^sha256:[0-9a-f]{64}$'),
  byte_length integer not null check (byte_length >= 0),
  parents text[] not null default '{}',
  retention_classification text not null
    check (retention_classification in ('public', 'restricted')),
  retention_basis text not null
    check (retention_basis in ('lineage', 'expiry', 'release', 'append-only', 'declared-scope')),
  expires_at timestamptz not null,
  created_at timestamptz not null,
  created_by text not null,
  content_ciphertext bytea,
  content_key_ref text,
  deletion_state text not null default 'active'
    check (deletion_state in ('active', 'deleting', 'deleted')),
  deleted_at timestamptz,
  check (expires_at > created_at),
  check (retention_basis <> 'release' or retention_classification = 'public'),
  check (
    (deletion_state in ('active', 'deleting') and content_ciphertext is not null
      and content_key_ref is not null and deleted_at is null)
    or
    (deletion_state = 'deleted' and content_ciphertext is null
      and content_key_ref is null and deleted_at is not null)
  )
);

create index if not exists itotori_immutable_artifacts_expiry_idx
  on itotori_immutable_artifacts (expires_at, artifact_id)
  where deletion_state = 'active';

create table if not exists itotori_immutable_artifact_references (
  reference_id text primary key,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  project_artifact_id text not null,
  artifact_id text not null references itotori_immutable_artifacts(artifact_id) on delete restrict,
  purpose text not null check (purpose in ('lineage', 'release')),
  created_at timestamptz not null,
  created_by text not null,
  removed_at timestamptz,
  removed_by text,
  unique (project_id, project_artifact_id),
  check ((removed_at is null) = (removed_by is null))
);

create index if not exists itotori_immutable_artifact_references_live_idx
  on itotori_immutable_artifact_references (artifact_id)
  where removed_at is null;

create table if not exists itotori_immutable_artifact_audit_events (
  audit_event_id bigserial primary key,
  occurred_at timestamptz not null,
  actor_id text not null,
  action text not null,
  target text not null,
  outcome text not null,
  artifact_id text,
  reference_id text,
  details jsonb not null default '{}'::jsonb
);

create index if not exists itotori_immutable_artifact_audit_target_idx
  on itotori_immutable_artifact_audit_events (target, audit_event_id);

-- Lifecycle mutation is intentionally narrower than audit.write: an actor who
-- may append audit findings must not thereby gain ciphertext-deletion authority.
alter table itotori_user_permission_grants
  drop constraint if exists itotori_user_permission_grants_permission_check;

alter table itotori_user_permission_grants
  add constraint itotori_user_permission_grants_permission_check check (
    permission in (
      'project.import',
      'draft.write',
      'patch.export',
      'runtime.ingest',
      'feedback.import',
      'queue.manage',
      'queue.read',
      'content.read',
      'catalog.read',
      'catalog.write',
      'audit.write',
      'retention.manage',
      'style_guide.approve',
      'auth.admin',
      'auth.sso.manage',
      'auth.members.manage',
      'auth.sessions.manage',
      'auth.permissions.manage',
      'system.reset'
    )
  );

-- @permission-gate runtime.ingest inserts immutable payloads and references
-- @permission-gate content.read selects and decrypts payload ciphertext
-- @permission-gate retention.manage reconciles references and expires payloads
