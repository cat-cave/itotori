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
      'system.reset'
    )
  );

create table if not exists itotori_event_outbox (
  outbox_event_id text primary key,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  locale_branch_id text references itotori_locale_branches(locale_branch_id) on delete set null,
  source_event_id text references itotori_events(event_id) on delete set null,
  event_type text not null,
  status text not null,
  idempotency_key text not null,
  correlation_id text not null,
  causation_id text,
  payload jsonb not null,
  available_at timestamptz not null default now(),
  attempt_count integer not null default 0,
  max_attempts integer not null default 25,
  locked_by text,
  locked_at timestamptz,
  lease_expires_at timestamptz,
  published_at timestamptz,
  last_error text,
  error_history jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint itotori_event_outbox_event_type_check check (
    event_type in (
      'agent_task_requested',
      'deterministic_tool_task_requested',
      'rerun_requested',
      'triage_loop_requested',
      'job_scheduled',
      'job_completed',
      'job_failed',
      'job_dead_lettered'
    )
  ),
  constraint itotori_event_outbox_status_check check (
    status in (
      'pending',
      'publishing',
      'published',
      'retry_waiting',
      'dead_letter'
    )
  ),
  constraint itotori_event_outbox_attempts_check check (
    attempt_count >= 0 and max_attempts > 0
  ),
  constraint itotori_event_outbox_error_history_check check (
    jsonb_typeof(error_history) = 'array'
  )
);

create unique index if not exists itotori_event_outbox_idempotency_key_idx
  on itotori_event_outbox(idempotency_key);
create index if not exists itotori_event_outbox_ready_idx
  on itotori_event_outbox(status, available_at, created_at);
create index if not exists itotori_event_outbox_project_type_idx
  on itotori_event_outbox(project_id, event_type);
create index if not exists itotori_event_outbox_source_event_idx
  on itotori_event_outbox(source_event_id);
create index if not exists itotori_event_outbox_correlation_idx
  on itotori_event_outbox(correlation_id);

create table if not exists itotori_jobs (
  job_id text primary key,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  locale_branch_id text references itotori_locale_branches(locale_branch_id) on delete set null,
  source_event_id text references itotori_events(event_id) on delete set null,
  trigger_outbox_event_id text references itotori_event_outbox(outbox_event_id) on delete set null,
  job_type text not null,
  job_name text not null,
  queue_name text not null default 'default',
  status text not null,
  idempotency_policy text not null,
  idempotency_key text,
  correlation_id text not null,
  causation_id text,
  subject_refs jsonb not null,
  payload jsonb not null,
  priority integer not null default 0,
  available_at timestamptz not null default now(),
  attempt_count integer not null default 0,
  max_attempts integer not null default 3,
  locked_by text,
  locked_at timestamptz,
  lease_expires_at timestamptz,
  completed_at timestamptz,
  last_error text,
  error_history jsonb not null default '[]'::jsonb,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint itotori_jobs_job_type_check check (
    job_type in (
      'agent_task',
      'deterministic_tool_task',
      'rerun',
      'triage_loop'
    )
  ),
  constraint itotori_jobs_status_check check (
    status in (
      'queued',
      'running',
      'retry_waiting',
      'succeeded',
      'dead_letter',
      'cancelled'
    )
  ),
  constraint itotori_jobs_idempotency_policy_check check (
    idempotency_policy in ('idempotent', 'non_idempotent')
  ),
  constraint itotori_jobs_idempotency_key_check check (
    (idempotency_policy = 'idempotent' and idempotency_key is not null)
      or (idempotency_policy = 'non_idempotent' and idempotency_key is null)
  ),
  constraint itotori_jobs_attempts_check check (
    attempt_count >= 0 and max_attempts > 0
  ),
  constraint itotori_jobs_json_shape_check check (
    jsonb_typeof(subject_refs) = 'array'
      and jsonb_typeof(payload) = 'object'
      and jsonb_typeof(error_history) = 'array'
  )
);

create unique index if not exists itotori_jobs_idempotency_key_idx
  on itotori_jobs(idempotency_key);
create index if not exists itotori_jobs_ready_idx
  on itotori_jobs(queue_name, status, available_at, priority desc, created_at);
create index if not exists itotori_jobs_project_type_status_idx
  on itotori_jobs(project_id, job_type, status);
create index if not exists itotori_jobs_trigger_outbox_event_idx
  on itotori_jobs(trigger_outbox_event_id);
create index if not exists itotori_jobs_source_event_idx
  on itotori_jobs(source_event_id);
create index if not exists itotori_jobs_correlation_idx
  on itotori_jobs(correlation_id);
