create table if not exists itotori_style_guides (
  style_guide_id text primary key,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  locale_branch_id text not null references itotori_locale_branches(locale_branch_id) on delete cascade,
  latest_version_id text,
  approved_version_id text,
  created_by_user_id text references itotori_users(user_id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists itotori_style_guides_locale_branch_idx
  on itotori_style_guides(locale_branch_id);
create index if not exists itotori_style_guides_project_idx
  on itotori_style_guides(project_id);

create table if not exists itotori_style_guide_versions (
  style_guide_version_id text primary key,
  style_guide_id text not null references itotori_style_guides(style_guide_id) on delete cascade,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  locale_branch_id text not null references itotori_locale_branches(locale_branch_id) on delete cascade,
  previous_version_id text,
  source_revision_id text not null references itotori_source_revisions(source_revision_id) on delete restrict,
  version_sequence integer not null,
  author_user_id text not null references itotori_users(user_id) on delete restrict,
  approver_user_id text references itotori_users(user_id) on delete set null,
  status text not null,
  content_hash text not null,
  policy jsonb not null,
  semantic_diagnostics jsonb not null default '[]'::jsonb,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint itotori_style_guide_versions_status_check check (
    status in ('draft', 'approved', 'superseded')
  ),
  constraint itotori_style_guide_versions_sequence_check check (version_sequence > 0),
  constraint itotori_style_guide_versions_policy_check check (jsonb_typeof(policy) = 'object'),
  constraint itotori_style_guide_versions_diagnostics_check check (
    jsonb_typeof(semantic_diagnostics) = 'array'
  )
);

create unique index if not exists itotori_style_guide_versions_branch_sequence_idx
  on itotori_style_guide_versions(locale_branch_id, version_sequence);
create index if not exists itotori_style_guide_versions_guide_created_idx
  on itotori_style_guide_versions(style_guide_id, created_at);
create index if not exists itotori_style_guide_versions_source_revision_idx
  on itotori_style_guide_versions(source_revision_id);
create index if not exists itotori_style_guide_versions_status_idx
  on itotori_style_guide_versions(status);

alter table itotori_event_outbox
  drop constraint if exists itotori_event_outbox_event_type_check;

alter table itotori_event_outbox
  add constraint itotori_event_outbox_event_type_check check (
    event_type in (
      'agent_task_requested',
      'deterministic_tool_task_requested',
      'rerun_requested',
      'triage_loop_requested',
      'style_guide_version_changed',
      'job_scheduled',
      'job_completed',
      'job_failed',
      'job_dead_lettered'
    )
  );
