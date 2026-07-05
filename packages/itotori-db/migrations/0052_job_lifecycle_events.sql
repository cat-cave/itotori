-- ITOTORI-045: audit trail + immutability + retention for the job queue's
-- lifecycle (`itotori_job_events`).
--
-- The finding
-- -----------
-- The durable job queue (`itotori_jobs`) transitions its `status` IN PLACE
-- across its whole lifecycle:
--
--     enqueue        -> queued        (insert)
--     claimJobs      -> running       (update)
--     completeJob    -> succeeded     (update)
--     failJob        -> retry_waiting | dead_letter (update)
--     lease recovery -> retry_waiting | dead_letter (update)
--
-- Nothing recorded WHEN or HOW a job moved between states: a direct
-- `update itotori_jobs set status = 'succeeded'` left no trace, so the queue
-- had no auditable history and a transition could be silently rewritten.
--
-- The fix mirrors the ReplayLog / `itotori_events` append-only pattern on the
-- DB side (see 0003_persistence_v02.sql `itotori_events_append_only`): every
-- lifecycle transition APPENDS an immutable `itotori_job_events` row, written
-- by the database itself (an AFTER trigger on `itotori_jobs`), so NO code path
-- — not even a raw SQL UPDATE — can move a job without leaving an audit record.
--
-- (a) Immutability
-- ----------------
-- `itotori_job_events` is append-only. A BEFORE UPDATE trigger ALWAYS rejects
-- rewriting a recorded event. A BEFORE DELETE trigger rejects ad-hoc deletes
-- too, EXCEPT the sanctioned retention path, which signals itself with the
-- transaction-local GUC `itotori.job_events_prune = 'on'` (set via `set local`
-- inside pruneJobEvents(), auto-cleared at commit). Any DELETE without that
-- flag — the way someone would try to silently erase an event — is rejected.
--
-- (b) Retention / archival policy
-- -------------------------------
-- KEPT    : every event for a job that is NOT in a terminal state
--           (queued/running/retry_waiting) is kept regardless of age; and
--           every event younger than the retention window (default 90 days)
--           is kept.
-- PRUNED  : events for a job in a TERMINAL state (succeeded/dead_letter/
--           cancelled) that are older than the retention window are pruned via
--           pruneJobEvents() — a job's closed lifecycle stops accumulating
--           audit rows forever, while any still-open or recent job keeps its
--           full trail.
-- STORED  : `itotori_job_events`, one append-only row per transition, in the
--           same Postgres as the queue; pruning only ever removes closed,
--           past-window rows and only through the audited prune path.
--
-- Forward-only. The trigger fires only on genuine status changes (or insert),
-- so idempotent re-enqueues (`on conflict do update set updated_at`) that leave
-- status unchanged do NOT append a spurious event.
--
-- @permission-gate queue.manage writes (enqueue/claim/complete/fail drive the
--   trigger; pruneJobEvents requires it directly)
-- @permission-gate queue.read reads (getJobEvents)

create table itotori_job_events (
  job_event_id text primary key,
  job_id text not null
    references itotori_jobs (job_id) on delete cascade,
  project_id text not null
    references itotori_projects (project_id) on delete cascade,
  locale_branch_id text
    references itotori_locale_branches (locale_branch_id) on delete set null,
  queue_name text not null,
  event_type text not null,
  prior_status text,
  next_status text not null,
  attempt_count integer not null,
  worker_id text,
  correlation_id text not null,
  detail jsonb not null default '{}'::jsonb,
  recorded_at timestamptz not null default now(),
  constraint itotori_job_events_event_type_check check (
    event_type in (
      'enqueued',
      'claimed',
      'succeeded',
      'retry_scheduled',
      'dead_lettered',
      'cancelled',
      'requeued'
    )
  ),
  constraint itotori_job_events_next_status_check check (
    next_status in (
      'queued',
      'running',
      'retry_waiting',
      'succeeded',
      'dead_letter',
      'cancelled'
    )
  )
);

create index itotori_job_events_job_time_idx
  on itotori_job_events (job_id, recorded_at);

create index itotori_job_events_project_time_idx
  on itotori_job_events (project_id, recorded_at);

create index itotori_job_events_status_time_idx
  on itotori_job_events (next_status, recorded_at);

-- Capture: append one immutable event per real lifecycle transition. Runs as
-- an AFTER trigger on itotori_jobs so the audit row is written in the SAME
-- transaction as the status change and cannot be bypassed by any code path.
create function itotori_job_events_capture()
returns trigger
language plpgsql
as $$
declare
  resolved_event_type text;
  resolved_prior_status text;
begin
  if tg_op = 'UPDATE' and old.status is not distinct from new.status then
    return new;
  end if;

  if tg_op = 'INSERT' then
    resolved_prior_status := null;
  else
    resolved_prior_status := old.status;
  end if;

  resolved_event_type := case
    when tg_op = 'INSERT' then 'enqueued'
    when new.status = 'running' then 'claimed'
    when new.status = 'succeeded' then 'succeeded'
    when new.status = 'retry_waiting' then 'retry_scheduled'
    when new.status = 'dead_letter' then 'dead_lettered'
    when new.status = 'cancelled' then 'cancelled'
    when new.status = 'queued' then 'requeued'
  end;

  insert into itotori_job_events (
    job_event_id,
    job_id,
    project_id,
    locale_branch_id,
    queue_name,
    event_type,
    prior_status,
    next_status,
    attempt_count,
    worker_id,
    correlation_id,
    detail,
    recorded_at
  )
  values (
    gen_random_uuid()::text,
    new.job_id,
    new.project_id,
    new.locale_branch_id,
    new.queue_name,
    resolved_event_type,
    resolved_prior_status,
    new.status,
    new.attempt_count,
    coalesce(new.locked_by, old.locked_by),
    new.correlation_id,
    jsonb_build_object(
      'lastError', new.last_error,
      'terminal', new.attempt_count >= new.max_attempts,
      'leaseExpiresAt', new.lease_expires_at,
      'completedAt', new.completed_at
    ),
    now()
  );

  return new;
end;
$$;

create trigger itotori_job_events_capture_trigger
after insert or update on itotori_jobs
for each row execute function itotori_job_events_capture();

-- Immutability: reject any in-place rewrite of a recorded event, and reject
-- ad-hoc deletes. The sanctioned retention prune signals itself with the
-- transaction-local GUC itotori.job_events_prune = 'on'.
create function itotori_job_events_append_only()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'itotori_job_events is append-only: recorded events cannot be rewritten';
  end if;
  if coalesce(current_setting('itotori.job_events_prune', true), '') <> 'on' then
    raise exception 'itotori_job_events is append-only: delete only via the retention prune path';
  end if;
  return old;
end;
$$;

create trigger itotori_job_events_append_only_trigger
before update or delete on itotori_job_events
for each row execute function itotori_job_events_append_only();
