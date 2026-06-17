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
      'system.reset'
    )
  );

create table if not exists itotori_feedback_sources (
  feedback_source_id text primary key,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  source_kind text not null,
  label text not null,
  source_channel text,
  privacy_review_state text not null,
  metadata jsonb not null,
  created_by_user_id text references itotori_users(user_id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists itotori_feedback_sources_project_kind_idx
  on itotori_feedback_sources(project_id, source_kind);

create table if not exists itotori_feedback_reports (
  feedback_report_id text primary key,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  locale_branch_id text references itotori_locale_branches(locale_branch_id) on delete set null,
  source_bundle_id text references itotori_source_bundles(source_bundle_id) on delete set null,
  bridge_unit_id text references itotori_source_units(bridge_unit_id) on delete set null,
  target_locale text not null,
  feedback_source_id text not null references itotori_feedback_sources(feedback_source_id) on delete restrict,
  feedback_type text not null,
  triage_label text not null,
  report_status text not null,
  context_status text not null,
  privacy_classification text not null,
  redaction_state text not null,
  reporter_role text not null,
  reporter_note text not null,
  dedupe_key text not null,
  line_reference jsonb,
  attachment_summary jsonb not null,
  report_count integer not null default 1,
  metadata jsonb not null,
  first_reported_at timestamptz not null,
  last_reported_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists itotori_feedback_reports_dedupe_key_idx
  on itotori_feedback_reports(dedupe_key);
create index if not exists itotori_feedback_reports_project_branch_status_idx
  on itotori_feedback_reports(project_id, locale_branch_id, report_status);
create index if not exists itotori_feedback_reports_project_label_idx
  on itotori_feedback_reports(project_id, triage_label);
create index if not exists itotori_feedback_reports_bridge_unit_idx
  on itotori_feedback_reports(bridge_unit_id);

create table if not exists itotori_feedback_report_evidence (
  feedback_evidence_id text primary key,
  feedback_report_id text not null references itotori_feedback_reports(feedback_report_id) on delete cascade,
  feedback_source_id text not null references itotori_feedback_sources(feedback_source_id) on delete restrict,
  reporter jsonb not null,
  reporter_note text not null,
  line_reference jsonb,
  attachments jsonb not null,
  context_signals jsonb not null,
  metadata jsonb not null,
  reported_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists itotori_feedback_evidence_report_idx
  on itotori_feedback_report_evidence(feedback_report_id);
create index if not exists itotori_feedback_evidence_source_idx
  on itotori_feedback_report_evidence(feedback_source_id);
