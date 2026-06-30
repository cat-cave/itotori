-- ITOTORI-118: Workspace manual correction edit history.
--
-- The read-only localization workspace (ITOTORI-040) lets a reviewer browse
-- projects / locale branches / scenes / units and compare source / draft /
-- final text. This migration adds the MUTATION layer's durable spine: one
-- append-only edit-history row per reviewer manual correction.
--
-- Each correction is ALSO routed through the existing feedback intake
-- (ItotoriFeedbackRepository.importManualFeedback) so it enters the same
-- decision queue + targeted-rerun loop as QA / runtime findings — this table
-- never forks that path; it only records the durable, auditable edit history
-- and links it back to the feedback report / evidence / reviewer-queue item it
-- produced.
--
-- Every row is tied to (project, locale branch, source revision, bridge unit,
-- actor, reason) per ITOTORI-118 acceptance #1. `locale_branch_id` keeps
-- corrections branch-scoped (ITOTORI-059): the same bridge unit corrected on
-- two branches that share a target locale produces two distinct rows that are
-- never conflated.
--
-- `before_text` is the draft the reviewer saw (NULL when there was no draft);
-- `after_text` is the reviewer's correction (always present). `reason` is the
-- reviewer's justification and is mandatory — a correction with no reason is
-- rejected at the repository boundary, not silently stored.
--
-- The repository writes this row and a durable `itotori_events` row
-- (`event_kind = 'workspace_correction_recorded'`) in a single transaction so
-- the edit history and the canonical event log can never diverge.

create table if not exists itotori_workspace_correction_edits (
  correction_edit_id text primary key,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  locale_branch_id text not null references itotori_locale_branches(locale_branch_id) on delete cascade,
  source_revision_id text not null references itotori_source_revisions(source_revision_id) on delete restrict,
  bridge_unit_id text not null,
  actor_user_id text not null references itotori_users(user_id) on delete restrict,
  reason text not null check (length(btrim(reason)) > 0),
  before_text text,
  after_text text not null check (length(after_text) > 0),
  disposition text not null check (disposition in ('repair_candidate', 'decision_queue', 'needs_context')),
  triage_label text not null,
  feedback_report_id text not null references itotori_feedback_reports(feedback_report_id) on delete cascade,
  feedback_evidence_id text not null,
  review_item_id text references itotori_reviewer_queue_items(review_item_id) on delete set null,
  batch_id text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists itotori_workspace_correction_edits_branch_time_idx
  on itotori_workspace_correction_edits (locale_branch_id, created_at);

create index if not exists itotori_workspace_correction_edits_unit_idx
  on itotori_workspace_correction_edits (locale_branch_id, source_revision_id, bridge_unit_id);

create index if not exists itotori_workspace_correction_edits_feedback_idx
  on itotori_workspace_correction_edits (feedback_report_id);

create index if not exists itotori_workspace_correction_edits_batch_idx
  on itotori_workspace_correction_edits (batch_id);
