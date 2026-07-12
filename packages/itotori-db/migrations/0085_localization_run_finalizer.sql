-- p0-core-terminal-run-finalizer — minimal run-scoped PatchVersion,
-- canonical terminal summary, and idempotent finalizer-worker outbox.
--
-- A patch version is deliberately run-scoped for this foundation: later
-- result-revision and lineage work can grow the identity chain without
-- recreating the coverage barrier. Membership is sourced from the durable
-- planned-unit rows, never from an opaque frozen_scope JSON projection.
--
-- @permission-gate draft.write writes
-- @permission-gate catalog.read reads

create table if not exists itotori_localization_patch_versions (
  patch_version_id text primary key,
  run_id text not null unique references itotori_localization_journal_runs(run_id) on delete cascade,
  status text not null default 'building',
  artifact_hashes jsonb not null default '{}'::jsonb,
  artifact_refs jsonb not null default '{}'::jsonb,
  playable_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint itotori_localization_patch_versions_id_non_empty
    check (length(btrim(patch_version_id)) > 0),
  constraint itotori_localization_patch_versions_status_known
    check (status in ('building', 'playable', 'failed')),
  constraint itotori_localization_patch_versions_hashes_object
    check (jsonb_typeof(artifact_hashes) = 'object'),
  constraint itotori_localization_patch_versions_refs_object
    check (jsonb_typeof(artifact_refs) = 'object'),
  constraint itotori_localization_patch_versions_playable_consistent
    check ((status = 'playable') = (playable_at is not null)),
  constraint itotori_localization_patch_versions_id_run_unique
    unique (patch_version_id, run_id)
);

create index if not exists itotori_localization_patch_versions_run_status_idx
  on itotori_localization_patch_versions (run_id, status);

create table if not exists itotori_localization_patch_version_units (
  patch_version_id text not null,
  run_id text not null,
  bridge_unit_id text not null,
  journal_outcome_id text not null,
  -- Node 10 will materialize the full result-revision record. Until then this
  -- deterministic run-origin reference is the durable coverage seam.
  result_revision_id text not null,
  unit_ordinal integer not null,
  created_at timestamptz not null default now(),
  primary key (patch_version_id, bridge_unit_id),
  constraint itotori_localization_patch_version_units_ordinal_unique
    unique (patch_version_id, unit_ordinal),
  constraint itotori_localization_patch_version_units_revision_deterministic
    check (result_revision_id = 'run-result:' || run_id || ':' || bridge_unit_id),
  constraint itotori_localization_patch_version_units_ordinal_non_negative
    check (unit_ordinal >= 0),
  constraint itotori_localization_patch_version_units_patch_run_fkey
    foreign key (patch_version_id, run_id)
    references itotori_localization_patch_versions(patch_version_id, run_id)
    on delete cascade,
  constraint itotori_localization_patch_version_units_planned_unit_fkey
    foreign key (run_id, bridge_unit_id)
    references itotori_localization_journal_run_units(run_id, bridge_unit_id)
    on delete cascade,
  constraint itotori_localization_patch_version_units_outcome_fkey
    foreign key (journal_outcome_id, run_id, bridge_unit_id)
    references itotori_written_unit_outcomes(journal_outcome_id, run_id, bridge_unit_id)
    on delete cascade
);

create index if not exists itotori_localization_patch_version_units_run_idx
  on itotori_localization_patch_version_units (run_id, bridge_unit_id);

-- Exactly one current canonical terminal projection exists per run. A paused
-- run can later resume, so summary_epoch distinguishes an updated terminal
-- projection while preserving this one-row canonical source of truth.
create table if not exists itotori_localization_run_terminal_summaries (
  run_id text primary key references itotori_localization_journal_runs(run_id) on delete cascade,
  terminal_status text not null,
  summary_epoch integer not null default 1,
  summary_json jsonb not null,
  terminalized_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint itotori_localization_run_terminal_summaries_status_known
    check (terminal_status in ('succeeded', 'failed', 'aborted', 'paused')),
  constraint itotori_localization_run_terminal_summaries_epoch_positive
    check (summary_epoch > 0),
  constraint itotori_localization_run_terminal_summaries_json_object
    check (jsonb_typeof(summary_json) = 'object'),
  constraint itotori_localization_run_terminal_summaries_json_run_matches
    check (summary_json->>'runId' = run_id),
  constraint itotori_localization_run_terminal_summaries_json_status_matches
    check (summary_json->>'terminalStatus' = terminal_status)
);

create index if not exists itotori_localization_run_terminal_summaries_status_idx
  on itotori_localization_run_terminal_summaries (terminal_status, terminalized_at);

-- This is intentionally separate from the generic event outbox. The rows are
-- keyed by (run, stage), giving deterministic idempotency for build, apply,
-- validation, and summary workers without inventing a second summary truth.
create table if not exists itotori_localization_run_finalizer_outbox (
  run_id text not null references itotori_localization_journal_runs(run_id) on delete cascade,
  stage text not null,
  status text not null default 'pending',
  idempotency_key text not null,
  payload jsonb not null default '{}'::jsonb,
  evidence jsonb,
  attempt_count integer not null default 0,
  available_at timestamptz not null default now(),
  locked_by text,
  locked_at timestamptz,
  lease_expires_at timestamptz,
  completed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (run_id, stage),
  constraint itotori_localization_run_finalizer_outbox_stage_known
    check (stage in (
      'preflight',
      'provider',
      'unit',
      'persistence',
      'patch_build',
      'patch_apply',
      'validation',
      'summary',
      'cleanup'
    )),
  constraint itotori_localization_run_finalizer_outbox_status_known
    check (status in ('pending', 'running', 'retry_waiting', 'succeeded', 'failed')),
  constraint itotori_localization_run_finalizer_outbox_key_deterministic
    check (idempotency_key = 'localization-finalizer:' || run_id || ':' || stage),
  constraint itotori_localization_run_finalizer_outbox_payload_object
    check (jsonb_typeof(payload) = 'object'),
  constraint itotori_localization_run_finalizer_outbox_evidence_object
    check (evidence is null or jsonb_typeof(evidence) = 'object'),
  constraint itotori_localization_run_finalizer_outbox_attempt_non_negative
    check (attempt_count >= 0)
);

create unique index if not exists itotori_localization_run_finalizer_outbox_key_idx
  on itotori_localization_run_finalizer_outbox (idempotency_key);

create index if not exists itotori_localization_run_finalizer_outbox_ready_idx
  on itotori_localization_run_finalizer_outbox (status, available_at, created_at);

-- `playable` is deliberately impossible until all frozen planned units are in
-- this patch, the build/apply/validation evidence is durable, and both
-- artifact refs and hashes exist. It is deferred so the finalizer can write
-- all facts atomically in one transaction.
create or replace function itotori_assert_localization_patch_version_playable()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'playable' then
    if new.artifact_hashes = '{}'::jsonb or new.artifact_refs = '{}'::jsonb then
      raise exception 'playable patch version % requires artifact refs and hashes', new.patch_version_id;
    end if;

    if exists (
      select 1
      from itotori_localization_journal_run_units unit
      where unit.run_id = new.run_id
        and not exists (
          select 1
          from itotori_localization_patch_version_units member
          where member.patch_version_id = new.patch_version_id
            and member.run_id = new.run_id
            and member.bridge_unit_id = unit.bridge_unit_id
        )
    ) or exists (
      select 1
      from itotori_localization_patch_version_units member
      where member.patch_version_id = new.patch_version_id
        and member.run_id = new.run_id
        and not exists (
          select 1
          from itotori_localization_journal_run_units unit
          where unit.run_id = new.run_id
            and unit.bridge_unit_id = member.bridge_unit_id
        )
    ) then
      raise exception 'playable patch version % does not contain exactly its frozen run scope', new.patch_version_id;
    end if;

    if not exists (
      select 1
      from itotori_localization_run_finalizer_outbox stage
      where stage.run_id = new.run_id
        and stage.stage = 'patch_build'
        and stage.status = 'succeeded'
    ) or not exists (
      select 1
      from itotori_localization_run_finalizer_outbox stage
      where stage.run_id = new.run_id
        and stage.stage = 'patch_apply'
        and stage.status = 'succeeded'
    ) or not exists (
      select 1
      from itotori_localization_run_finalizer_outbox stage
      where stage.run_id = new.run_id
        and stage.stage = 'validation'
        and stage.status = 'succeeded'
    ) then
      raise exception 'playable patch version % requires successful build/apply/validation evidence', new.patch_version_id;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists itotori_localization_patch_version_playable_guard
  on itotori_localization_patch_versions;

create constraint trigger itotori_localization_patch_version_playable_guard
after insert or update of status, artifact_hashes, artifact_refs
on itotori_localization_patch_versions
deferrable initially deferred
for each row
execute function itotori_assert_localization_patch_version_playable();
