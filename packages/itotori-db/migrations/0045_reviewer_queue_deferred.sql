-- ITOTORI-023: first-class reviewer queue deferral.
--
-- Adds the deferred state and defer action to the reviewer queue check
-- constraints. The state is intentionally non-terminal: deferred items
-- have no resolved_at and can later be reopened, accepted, rejected, or
-- escalated.

alter table itotori_reviewer_queue_items
  drop constraint if exists itotori_reviewer_queue_items_state_check;

alter table itotori_reviewer_queue_items
  add constraint itotori_reviewer_queue_items_state_check check (state in (
    'pending', 'in_review', 'accepted', 'rejected', 'repair_requested', 'deferred', 'escalated'
  ));

alter table itotori_reviewer_queue_items
  drop constraint if exists itotori_reviewer_queue_items_resolved_state_consistent;

alter table itotori_reviewer_queue_items
  add constraint itotori_reviewer_queue_items_resolved_state_consistent check (
    (state in ('accepted', 'rejected') and resolved_at is not null)
    or (state in ('pending', 'in_review', 'repair_requested', 'deferred', 'escalated')
      and resolved_at is null)
  );

alter table itotori_reviewer_queue_transitions
  drop constraint if exists itotori_reviewer_queue_transitions_action_check;

alter table itotori_reviewer_queue_transitions
  add constraint itotori_reviewer_queue_transitions_action_check check (action in (
    'approve', 'reject', 'defer', 'escalate', 'request_repair', 'update_glossary',
    'update_style', 'import_runtime_feedback'
  ));

alter table itotori_reviewer_queue_transitions
  drop constraint if exists itotori_reviewer_queue_transitions_prior_state_check;

alter table itotori_reviewer_queue_transitions
  add constraint itotori_reviewer_queue_transitions_prior_state_check check (prior_state in (
    'pending', 'in_review', 'accepted', 'rejected', 'repair_requested', 'deferred', 'escalated'
  ));

alter table itotori_reviewer_queue_transitions
  drop constraint if exists itotori_reviewer_queue_transitions_next_state_check;

alter table itotori_reviewer_queue_transitions
  add constraint itotori_reviewer_queue_transitions_next_state_check check (next_state in (
    'pending', 'in_review', 'accepted', 'rejected', 'repair_requested', 'deferred', 'escalated'
  ));
