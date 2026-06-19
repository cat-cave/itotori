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
      'affected_work_invalidated',
      'job_scheduled',
      'job_completed',
      'job_failed',
      'job_dead_lettered'
    )
  );
