-- ITOTORI-074: draft job schema (jobs + attempts).
--
-- Two new tables stand up the agent-managed translation-draft job ledger.
-- Permission governance: write paths require draft.write; read paths
-- require catalog.read.
--
-- @permission-gate draft.write writes
-- @permission-gate catalog.read reads
--
-- Status vocabulary mirrored in TypeScript (packages/itotori-db/src/schema.ts):
--   draft_job_status        = queued | running | succeeded | failed | retryable | cancelled
--   draft_job_attempt_status = running | succeeded | failed | retryable | cancelled
--
-- Retry-state semantics enforced by repository + drift tests:
--   a 'retryable' parent must have at least one 'retryable' attempt.

create table if not exists itotori_draft_jobs (
  draft_job_id text primary key,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  locale_branch_id text not null references itotori_locale_branches(locale_branch_id) on delete cascade,
  bridge_unit_ids text[] not null,
  style_guide_version text not null,
  glossary_version text not null,
  protected_span_refs jsonb not null default '[]'::jsonb,
  policy_versions jsonb not null default '{}'::jsonb,
  context_refs jsonb not null default '[]'::jsonb,
  status text not null check (
    status in ('queued', 'running', 'succeeded', 'failed', 'retryable', 'cancelled')
  ),
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint itotori_draft_jobs_bridge_unit_ids_nonempty
    check (cardinality(bridge_unit_ids) >= 1),
  constraint itotori_draft_jobs_protected_span_refs_is_array
    check (jsonb_typeof(protected_span_refs) = 'array'),
  constraint itotori_draft_jobs_context_refs_is_array
    check (jsonb_typeof(context_refs) = 'array'),
  constraint itotori_draft_jobs_policy_versions_is_object
    check (jsonb_typeof(policy_versions) = 'object')
);

create index if not exists itotori_draft_jobs_project_status_idx
  on itotori_draft_jobs (project_id, status);

create index if not exists itotori_draft_jobs_locale_branch_status_idx
  on itotori_draft_jobs (locale_branch_id, status);

create index if not exists itotori_draft_jobs_created_at_idx
  on itotori_draft_jobs (project_id, created_at desc);

create table if not exists itotori_draft_job_attempts (
  draft_job_attempt_id text primary key,
  draft_job_id text not null references itotori_draft_jobs(draft_job_id) on delete cascade,
  attempt_index integer not null check (attempt_index >= 1),
  provider_run_id text,
  started_at timestamptz not null,
  ended_at timestamptz,
  status text not null check (
    status in ('running', 'succeeded', 'failed', 'retryable', 'cancelled')
  ),
  failure_reason text,
  recorded_provider_artifact_id text,
  created_at timestamptz not null default now()
);

create unique index if not exists itotori_draft_job_attempts_attempt_idx
  on itotori_draft_job_attempts (draft_job_id, attempt_index);

create index if not exists itotori_draft_job_attempts_status_idx
  on itotori_draft_job_attempts (draft_job_id, status);

create index if not exists itotori_draft_job_attempts_provider_run_idx
  on itotori_draft_job_attempts (provider_run_id)
  where provider_run_id is not null;
