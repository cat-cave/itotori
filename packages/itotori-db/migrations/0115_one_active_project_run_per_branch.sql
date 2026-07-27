-- A branch has one accepted-output namespace and one run-level cost ceiling.
-- Queue/running/paused rows therefore exclude a second launch atomically.

create unique index itotori_project_runs_one_active_branch_idx
  on itotori_project_runs(project_id, locale_branch_id)
  where status in ('queued', 'running', 'paused');
