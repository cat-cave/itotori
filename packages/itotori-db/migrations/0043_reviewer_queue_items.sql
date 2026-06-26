-- ITOTORI-081: Reviewer queue action API and state machine.
--
-- Until this migration the agentic-loop triage router (ITOTORI-022) emitted
-- root-cause routings into an in-process structure with no human-actionable
-- queue. This migration introduces `itotori_reviewer_queue_items`: one row
-- per pending reviewer decision, keyed by `(localeBranchId, itemKind,
-- sourceItemRef)` so the same proposal cannot be enqueued twice for the
-- same locale branch + source revision.
--
-- Item kinds covered (closed enum, validated by check constraint):
--   - qa                  — QA finding routed for human review
--   - style               — style-guide proposal awaiting reviewer
--   - glossary            — glossary term proposal awaiting reviewer
--   - feedback            — manual / playtest feedback report
--   - runtime_evidence    — Utsushi runtime evidence finding
--
-- States (closed enum):
--   - pending             — newly created, no reviewer action yet
--   - in_review           — a reviewer has claimed it but not decided
--   - accepted            — reviewer approved; downstream side-effects can
--                           proceed (glossary write, style guide edit, etc.)
--   - rejected            — reviewer denied; the proposal is dropped
--   - repair_requested    — reviewer asked the agentic-loop to re-run with
--                           targeted hints
--   - escalated           — reviewer escalated to a senior reviewer / owner
--
-- Permissions:
--   queue.read  — view items and transitions
--   queue.manage — create items and execute reviewer actions
--
-- Runtime-evidence items must additionally carry the Utsushi evidence
-- tier, observation event ids, and artifact hashes verbatim so the
-- downstream patch-result ingest cannot lose them. The check constraint
-- requires the runtime-evidence metadata block be present (non-null
-- evidence_tier) precisely for item_kind = 'runtime_evidence' rows; it
-- must be NULL for any other item_kind so the type discriminant is
-- non-overlapping.

create table if not exists itotori_reviewer_queue_items (
  review_item_id text primary key,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  locale_branch_id text not null references itotori_locale_branches(locale_branch_id) on delete cascade,
  source_revision_id text not null references itotori_source_revisions(source_revision_id) on delete restrict,
  item_kind text not null check (item_kind in ('qa', 'style', 'glossary', 'feedback', 'runtime_evidence')),
  source_item_ref text not null,
  state text not null default 'pending' check (state in (
    'pending', 'in_review', 'accepted', 'rejected', 'repair_requested', 'escalated'
  )),
  priority integer not null default 0,
  summary text not null,
  affected_artifact_ids jsonb not null default '[]'::jsonb,
  evidence_tier text,
  observation_event_ids jsonb,
  artifact_hashes jsonb,
  payload jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_by_user_id text references itotori_users(user_id) on delete set null,
  assigned_to_user_id text references itotori_users(user_id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,
  -- Source-item ref uniqueness: the same proposal (locale branch + source
  -- revision + item kind + source item ref) cannot be enqueued twice.
  constraint itotori_reviewer_queue_items_source_item_unique unique (
    locale_branch_id, source_revision_id, item_kind, source_item_ref
  ),
  -- Runtime-evidence rows MUST carry evidence_tier; non-runtime-evidence
  -- rows MUST NOT. Same for observation_event_ids and artifact_hashes.
  -- This guarantees runtime evidence cannot lose its tier (audit focus).
  constraint itotori_reviewer_queue_items_runtime_evidence_discriminant check (
    (item_kind = 'runtime_evidence'
      and evidence_tier is not null
      and observation_event_ids is not null
      and artifact_hashes is not null)
    or (item_kind <> 'runtime_evidence'
      and evidence_tier is null
      and observation_event_ids is null
      and artifact_hashes is null)
  ),
  -- Resolved-state consistency: terminal states must carry resolved_at;
  -- non-terminal must not.
  constraint itotori_reviewer_queue_items_resolved_state_consistent check (
    (state in ('accepted', 'rejected') and resolved_at is not null)
    or (state in ('pending', 'in_review', 'repair_requested', 'escalated')
      and resolved_at is null)
  ),
  constraint itotori_reviewer_queue_items_summary_non_empty check (length(summary) > 0),
  constraint itotori_reviewer_queue_items_source_item_ref_non_empty check (length(source_item_ref) > 0)
);

create index if not exists itotori_reviewer_queue_items_branch_state_idx
  on itotori_reviewer_queue_items (locale_branch_id, state, updated_at);

create index if not exists itotori_reviewer_queue_items_project_kind_state_idx
  on itotori_reviewer_queue_items (project_id, item_kind, state);

create index if not exists itotori_reviewer_queue_items_assigned_idx
  on itotori_reviewer_queue_items (assigned_to_user_id, state);

-- Append-only transition log. Every reviewer action that mutates an
-- item's state records one row here, atomically with the item update.
-- The orchestrator and the dashboard read this log to audit reviewer
-- decisions; nothing in the app ever updates or deletes a row.
create table if not exists itotori_reviewer_queue_transitions (
  transition_id text primary key,
  review_item_id text not null references itotori_reviewer_queue_items(review_item_id) on delete cascade,
  locale_branch_id text not null references itotori_locale_branches(locale_branch_id) on delete cascade,
  source_revision_id text not null references itotori_source_revisions(source_revision_id) on delete restrict,
  item_kind text not null check (item_kind in ('qa', 'style', 'glossary', 'feedback', 'runtime_evidence')),
  action text not null check (action in (
    'approve', 'reject', 'request_repair', 'update_glossary', 'update_style', 'import_runtime_feedback'
  )),
  prior_state text not null check (prior_state in (
    'pending', 'in_review', 'accepted', 'rejected', 'repair_requested', 'escalated'
  )),
  next_state text not null check (next_state in (
    'pending', 'in_review', 'accepted', 'rejected', 'repair_requested', 'escalated'
  )),
  actor_user_id text not null references itotori_users(user_id) on delete restrict,
  affected_artifact_ids jsonb not null default '[]'::jsonb,
  diagnostics jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists itotori_reviewer_queue_transitions_item_idx
  on itotori_reviewer_queue_transitions (review_item_id, created_at);

create index if not exists itotori_reviewer_queue_transitions_actor_idx
  on itotori_reviewer_queue_transitions (actor_user_id, created_at);
