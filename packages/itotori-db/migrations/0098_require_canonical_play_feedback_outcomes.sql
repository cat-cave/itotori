-- Reviewer-queue retirement closes the remaining event-only play-feedback
-- escape hatch. A feedback event must now prove a concrete output: either the
-- immutable result revision selected by a target edit, or the immutable
-- canonical context version created/referenced by every other feedback kind.
--
-- Old event-only comments cannot be replayed as a real correction, so remove
-- them (and only their refinement snapshot links) rather than preserving a
-- hidden human backlog under the iteration tables.

delete from itotori_localization_refinement_run_feedback_events link
using itotori_play_test_feedback_events event
where link.feedback_event_id = event.feedback_event_id
  and (
    (event.event_kind = 'result_edit' and event.result_revision_id is null)
    or (
      event.event_kind in ('comment', 'added_context', 'wiki_edit')
      and (
        event.context_artifact_id is null
        or event.context_entry_version_id is null
      )
    )
    or (event.event_kind = 'comment' and event.body is null)
  );

delete from itotori_play_test_feedback_events event
where (event.event_kind = 'result_edit' and event.result_revision_id is null)
   or (
     event.event_kind in ('comment', 'added_context', 'wiki_edit')
     and (
       event.context_artifact_id is null
       or event.context_entry_version_id is null
     )
   )
   or (event.event_kind = 'comment' and event.body is null);

alter table itotori_play_test_feedback_events
  drop constraint if exists itotori_play_test_feedback_events_result_edit_revision,
  drop constraint if exists itotori_play_test_feedback_events_context_version_pair,
  drop constraint if exists itotori_play_test_feedback_events_canonical_outcome,
  drop constraint if exists itotori_play_test_feedback_events_comment_body;

alter table itotori_play_test_feedback_events
  add constraint itotori_play_test_feedback_events_result_edit_revision check (
    event_kind <> 'result_edit' or result_revision_id is not null
  ),
  add constraint itotori_play_test_feedback_events_context_version_pair check (
    (context_artifact_id is null) = (context_entry_version_id is null)
  ),
  add constraint itotori_play_test_feedback_events_canonical_outcome check (
    (event_kind = 'result_edit' and result_revision_id is not null)
    or (
      event_kind in ('comment', 'added_context', 'wiki_edit')
      and context_artifact_id is not null
      and context_entry_version_id is not null
    )
  ),
  add constraint itotori_play_test_feedback_events_comment_body check (
    event_kind <> 'comment' or body is not null
  );
