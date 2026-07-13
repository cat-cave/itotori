-- p0-core-iterative-patch-versioning-and-playtest-feedback — durable
-- version-lineage iteration inputs, play sessions, feedback inbox/batches,
-- and refinement membership provenance.
--
-- Node 5's terminal finalizer remains the owner of the coverage barrier. This
-- migration only teaches it how to assemble a second complete patch from a
-- refinement run: redrafted/new units retain this run's result revisions while
-- unaffected units point at the exact immutable result revision observed in
-- the base patch. `run_id` on patch membership remains the patch-owning run;
-- `source_run_id` is deliberately separate provenance for the immutable
-- outcome/revision source.
--
-- @permission-gate draft.write writes
-- @permission-gate catalog.read reads

-- ---------------------------------------------------------------------------
-- Refinement inputs frozen on the durable journal run.
-- ---------------------------------------------------------------------------

alter table itotori_localization_journal_runs
  add column if not exists base_patch_version_id text;

alter table itotori_localization_journal_runs
  drop constraint if exists itotori_localization_journal_runs_base_patch_version_fkey;

alter table itotori_localization_journal_runs
  add constraint itotori_localization_journal_runs_base_patch_version_fkey
  foreign key (base_patch_version_id)
  references itotori_localization_patch_versions (patch_version_id)
  on delete restrict;

create index if not exists itotori_localization_journal_runs_base_patch_idx
  on itotori_localization_journal_runs (base_patch_version_id)
  where base_patch_version_id is not null;

-- ---------------------------------------------------------------------------
-- Patch-version origin and membership provenance.
-- ---------------------------------------------------------------------------

alter table itotori_localization_patch_versions
  drop constraint if exists itotori_localization_patch_versions_origin_known;

alter table itotori_localization_patch_versions
  add constraint itotori_localization_patch_versions_origin_known
  check (origin in ('run_finalizer', 'play_tester_edit', 'refinement_run'));

alter table itotori_localization_patch_versions
  drop constraint if exists itotori_localization_patch_versions_play_tester_provenance;

alter table itotori_localization_patch_versions
  add constraint itotori_localization_patch_versions_play_tester_provenance
  check (
    (
      origin = 'run_finalizer'
      and parent_patch_version_id is null
      and actor_user_id is null
    )
    or (
      origin = 'play_tester_edit'
      and parent_patch_version_id is not null
      and actor_user_id is not null
      and length(btrim(actor_user_id)) > 0
    )
    or (
      origin = 'refinement_run'
      and parent_patch_version_id is not null
      and actor_user_id is null
    )
  );

-- Node 10 permits arbitrarily many play-tester child versions per run. There
-- is nevertheless exactly one finalizer-owned version per run, whether it is
-- a normal node-5 run or a node-11 refinement run.
create unique index if not exists itotori_localization_patch_versions_finalizer_origin_unique
  on itotori_localization_patch_versions (run_id)
  where origin in ('run_finalizer', 'refinement_run');

-- Existing rows use the same run for both patch scope and immutable revision
-- provenance. Temporarily disable the node-5 immutable-membership trigger so
-- already-playable historical memberships can receive this additive fact.
alter table itotori_localization_patch_version_units
  disable trigger itotori_playable_patch_membership_immutable;

alter table itotori_localization_patch_version_units
  add column if not exists source_run_id text;

update itotori_localization_patch_version_units
set source_run_id = run_id
where source_run_id is null;

alter table itotori_localization_patch_version_units
  alter column source_run_id set not null;

alter table itotori_localization_patch_version_units
  add column if not exists member_origin text not null default 'run_written_outcome';

alter table itotori_localization_patch_version_units
  add column if not exists reused_from_patch_version_id text;

alter table itotori_localization_patch_version_units
  drop constraint if exists itotori_localization_patch_version_units_outcome_fkey;

alter table itotori_localization_patch_version_units
  drop constraint if exists itotori_localization_patch_version_units_result_revision_fkey;

alter table itotori_localization_patch_version_units
  add constraint itotori_localization_patch_version_units_source_outcome_fkey
  foreign key (journal_outcome_id, source_run_id, bridge_unit_id)
  references itotori_written_unit_outcomes (journal_outcome_id, run_id, bridge_unit_id)
  on delete cascade;

alter table itotori_localization_patch_version_units
  add constraint itotori_localization_patch_version_units_source_result_revision_fkey
  foreign key (result_revision_id, journal_outcome_id, source_run_id, bridge_unit_id)
  references itotori_localization_result_revisions (
    result_revision_id,
    journal_outcome_id,
    run_id,
    bridge_unit_id
  );

alter table itotori_localization_patch_version_units
  add constraint itotori_localization_patch_version_units_reused_from_patch_fkey
  foreign key (reused_from_patch_version_id)
  references itotori_localization_patch_versions (patch_version_id)
  on delete restrict;

alter table itotori_localization_patch_version_units
  add constraint itotori_localization_patch_version_units_member_origin_known
  check (member_origin in ('run_written_outcome', 'reused_from_base', 'play_tester_edit'));

alter table itotori_localization_patch_version_units
  add constraint itotori_localization_patch_version_units_member_origin_provenance
  check (
    (
      member_origin = 'run_written_outcome'
      and source_run_id = run_id
      and reused_from_patch_version_id is null
    )
    or (
      member_origin = 'reused_from_base'
      and source_run_id <> run_id
      and reused_from_patch_version_id is not null
    )
    or (
      member_origin = 'play_tester_edit'
      and reused_from_patch_version_id is not null
    )
  );

alter table itotori_localization_patch_version_units
  add constraint itotori_localization_patch_version_units_provenance_key
  unique (
    patch_version_id,
    bridge_unit_id,
    source_run_id,
    journal_outcome_id,
    result_revision_id
  );

create index if not exists itotori_localization_patch_version_units_source_run_idx
  on itotori_localization_patch_version_units (source_run_id, bridge_unit_id);

alter table itotori_localization_patch_version_units
  enable trigger itotori_playable_patch_membership_immutable;

-- A raw SQL write cannot claim reuse while quietly substituting a different
-- revision. Likewise, a node-10 edit under a refinement patch must name a
-- result revision whose parent is actually in the named parent patch.
create or replace function itotori_assert_localization_patch_member_provenance()
returns trigger
language plpgsql
as $$
begin
  if new.member_origin = 'reused_from_base' then
    if not exists (
      select 1
      from itotori_localization_patch_version_units base_member
      where base_member.patch_version_id = new.reused_from_patch_version_id
        and base_member.bridge_unit_id = new.bridge_unit_id
        and base_member.source_run_id = new.source_run_id
        and base_member.journal_outcome_id = new.journal_outcome_id
        and base_member.result_revision_id = new.result_revision_id
    ) then
      raise exception 'reused patch member %/% does not match base patch % membership',
        new.patch_version_id, new.bridge_unit_id, new.reused_from_patch_version_id;
    end if;
  elsif new.member_origin = 'play_tester_edit' then
    if not exists (
      select 1
      from itotori_localization_patch_version_units parent_member
      join itotori_localization_result_revisions revision
        on revision.result_revision_id = new.result_revision_id
       and revision.journal_outcome_id = new.journal_outcome_id
       and revision.run_id = new.source_run_id
       and revision.bridge_unit_id = new.bridge_unit_id
      where parent_member.patch_version_id = new.reused_from_patch_version_id
        and parent_member.bridge_unit_id = new.bridge_unit_id
        and revision.origin = 'play_tester_edit'
        and revision.parent_revision_id = parent_member.result_revision_id
    ) then
      raise exception 'play-tester patch member %/% is not parented by patch %',
        new.patch_version_id, new.bridge_unit_id, new.reused_from_patch_version_id;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists itotori_localization_patch_member_provenance_guard
  on itotori_localization_patch_version_units;

create trigger itotori_localization_patch_member_provenance_guard
before insert or update of source_run_id, member_origin, reused_from_patch_version_id,
  journal_outcome_id, result_revision_id
on itotori_localization_patch_version_units
for each row
execute function itotori_assert_localization_patch_member_provenance();

-- The patch origin is a projection of the run's frozen identity. This keeps a
-- refinement from being accidentally inserted as a generic child patch.
create or replace function itotori_assert_localization_patch_origin_matches_run()
returns trigger
language plpgsql
as $$
declare
  expected_base_patch_version_id text;
begin
  select base_patch_version_id
    into expected_base_patch_version_id
  from itotori_localization_journal_runs
  where run_id = new.run_id;

  if new.origin = 'refinement_run' and expected_base_patch_version_id is distinct from new.parent_patch_version_id then
    raise exception 'refinement patch version % must parent the frozen base patch for run %',
      new.patch_version_id, new.run_id;
  end if;
  if new.origin = 'run_finalizer' and expected_base_patch_version_id is not null then
    raise exception 'refinement run % must create a refinement_run patch version', new.run_id;
  end if;
  return new;
end;
$$;

drop trigger if exists itotori_localization_patch_origin_matches_run_guard
  on itotori_localization_patch_versions;

create trigger itotori_localization_patch_origin_matches_run_guard
before insert or update of run_id, parent_patch_version_id, origin
on itotori_localization_patch_versions
for each row
execute function itotori_assert_localization_patch_origin_matches_run();

-- Keep node-5's idempotent replay allowance exact after the extra provenance
-- columns were introduced.
create or replace function itotori_freeze_playable_patch_membership()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' and exists (
    select 1
    from itotori_localization_patch_versions patch
    where patch.patch_version_id = new.patch_version_id
      and patch.status = 'playable'
  ) then
    if exists (
      select 1
      from itotori_localization_patch_version_units member
      where member.patch_version_id = new.patch_version_id
        and member.run_id = new.run_id
        and member.bridge_unit_id = new.bridge_unit_id
        and member.source_run_id = new.source_run_id
        and member.journal_outcome_id = new.journal_outcome_id
        and member.result_revision_id = new.result_revision_id
        and member.member_origin = new.member_origin
        and member.reused_from_patch_version_id is not distinct from new.reused_from_patch_version_id
        and member.unit_ordinal = new.unit_ordinal
    ) then
      return new;
    end if;
    raise exception 'membership for playable patch version % is immutable', new.patch_version_id;
  end if;
  if tg_op <> 'INSERT' and exists (
    select 1
    from itotori_localization_patch_versions patch
    where patch.patch_version_id = old.patch_version_id
      and patch.status = 'playable'
  ) then
    raise exception 'membership for playable patch version % is immutable', old.patch_version_id;
  end if;
  if tg_op = 'UPDATE' and exists (
    select 1
    from itotori_localization_patch_versions patch
    where patch.patch_version_id = new.patch_version_id
      and patch.status = 'playable'
  ) then
    raise exception 'membership for playable patch version % is immutable', new.patch_version_id;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create or replace function itotori_freeze_playable_patch_manifest()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'playable' and (
    new.status is distinct from old.status
    or new.artifact_hashes is distinct from old.artifact_hashes
    or new.artifact_refs is distinct from old.artifact_refs
    or new.playable_at is distinct from old.playable_at
    or new.parent_patch_version_id is distinct from old.parent_patch_version_id
    or new.origin is distinct from old.origin
    or new.actor_user_id is distinct from old.actor_user_id
  ) then
    raise exception 'playable patch version % is immutable', old.patch_version_id;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Play sessions and exact-version feedback inbox/batches.
-- ---------------------------------------------------------------------------

create table if not exists itotori_play_sessions (
  play_session_id text primary key,
  observed_patch_version_id text not null references itotori_localization_patch_versions(patch_version_id) on delete restrict,
  actor_user_id text not null,
  status text not null default 'active',
  launch_descriptor jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint itotori_play_sessions_id_non_empty check (length(btrim(play_session_id)) > 0),
  constraint itotori_play_sessions_actor_non_empty check (length(btrim(actor_user_id)) > 0),
  constraint itotori_play_sessions_status_known check (status in ('active', 'completed', 'abandoned')),
  constraint itotori_play_sessions_launch_descriptor_object check (jsonb_typeof(launch_descriptor) = 'object'),
  constraint itotori_play_sessions_ended_consistent check ((status = 'active') = (ended_at is null))
);

create index if not exists itotori_play_sessions_patch_started_idx
  on itotori_play_sessions (observed_patch_version_id, started_at desc);

create table if not exists itotori_play_test_feedback_batches (
  feedback_batch_id text primary key,
  observed_patch_version_id text not null references itotori_localization_patch_versions(patch_version_id) on delete restrict,
  actor_user_id text not null,
  selection_kind text not null,
  label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint itotori_play_test_feedback_batches_id_non_empty check (length(btrim(feedback_batch_id)) > 0),
  constraint itotori_play_test_feedback_batches_actor_non_empty check (length(btrim(actor_user_id)) > 0),
  constraint itotori_play_test_feedback_batches_selection_kind_known check (selection_kind in ('individual', 'batch')),
  constraint itotori_play_test_feedback_batches_label_non_blank check (label is null or length(btrim(label)) > 0),
  constraint itotori_play_test_feedback_batches_id_patch_unique unique (feedback_batch_id, observed_patch_version_id)
);

create index if not exists itotori_play_test_feedback_batches_patch_created_idx
  on itotori_play_test_feedback_batches (observed_patch_version_id, created_at desc);

create table if not exists itotori_play_test_feedback_events (
  feedback_event_id text primary key,
  feedback_batch_id text not null,
  observed_patch_version_id text not null,
  play_session_id text references itotori_play_sessions(play_session_id) on delete set null,
  actor_user_id text not null,
  event_kind text not null,
  body text,
  metadata jsonb not null default '{}'::jsonb,
  result_revision_id text references itotori_localization_result_revisions(result_revision_id) on delete restrict,
  context_artifact_id text references itotori_context_artifacts(context_artifact_id) on delete restrict,
  context_entry_version_id text references itotori_context_entry_versions(context_entry_version_id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint itotori_play_test_feedback_events_id_non_empty check (length(btrim(feedback_event_id)) > 0),
  constraint itotori_play_test_feedback_events_actor_non_empty check (length(btrim(actor_user_id)) > 0),
  constraint itotori_play_test_feedback_events_kind_known check (event_kind in ('result_edit', 'comment', 'added_context', 'wiki_edit')),
  constraint itotori_play_test_feedback_events_body_non_blank check (body is null or length(btrim(body)) > 0),
  constraint itotori_play_test_feedback_events_metadata_object check (jsonb_typeof(metadata) = 'object'),
  constraint itotori_play_test_feedback_events_batch_patch_fkey
    foreign key (feedback_batch_id, observed_patch_version_id)
    references itotori_play_test_feedback_batches(feedback_batch_id, observed_patch_version_id)
    on delete restrict,
  constraint itotori_play_test_feedback_events_result_edit_revision check (
    event_kind <> 'result_edit' or result_revision_id is not null
  ),
  constraint itotori_play_test_feedback_events_context_version_pair check (
    context_entry_version_id is null or context_artifact_id is not null
  )
);

create index if not exists itotori_play_test_feedback_events_patch_created_idx
  on itotori_play_test_feedback_events (observed_patch_version_id, created_at desc);

create index if not exists itotori_play_test_feedback_events_batch_created_idx
  on itotori_play_test_feedback_events (feedback_batch_id, created_at);

create table if not exists itotori_play_test_feedback_event_units (
  feedback_event_id text not null references itotori_play_test_feedback_events(feedback_event_id) on delete cascade,
  observed_patch_version_id text not null,
  bridge_unit_id text not null,
  created_at timestamptz not null default now(),
  primary key (feedback_event_id, bridge_unit_id),
  constraint itotori_play_test_feedback_event_units_observed_member_fkey
    foreign key (observed_patch_version_id, bridge_unit_id)
    references itotori_localization_patch_version_units(patch_version_id, bridge_unit_id)
    on delete restrict
);

create index if not exists itotori_play_test_feedback_event_units_patch_unit_idx
  on itotori_play_test_feedback_event_units (observed_patch_version_id, bridge_unit_id);

create table if not exists itotori_play_session_qa_callouts (
  play_session_id text not null references itotori_play_sessions(play_session_id) on delete cascade,
  journal_finding_id text not null references itotori_written_qa_findings(journal_finding_id) on delete restrict,
  presented_at timestamptz not null default now(),
  primary key (play_session_id, journal_finding_id)
);

-- ---------------------------------------------------------------------------
-- Exact refinement snapshots: selected batches/events, wiki heads, and the
-- per-unit choice between redraft/new work and provenance-preserving reuse.
-- ---------------------------------------------------------------------------

create table if not exists itotori_localization_refinement_run_feedback_batches (
  run_id text not null references itotori_localization_journal_runs(run_id) on delete cascade,
  feedback_batch_id text not null references itotori_play_test_feedback_batches(feedback_batch_id) on delete restrict,
  observed_patch_version_id text not null references itotori_localization_patch_versions(patch_version_id) on delete restrict,
  batch_ordinal integer not null,
  created_at timestamptz not null default now(),
  primary key (run_id, feedback_batch_id),
  constraint itotori_localization_refinement_run_feedback_batches_ordinal_unique unique (run_id, batch_ordinal),
  constraint itotori_localization_refinement_run_feedback_batches_batch_patch_fkey
    foreign key (feedback_batch_id, observed_patch_version_id)
    references itotori_play_test_feedback_batches(feedback_batch_id, observed_patch_version_id)
    on delete restrict,
  constraint itotori_localization_refinement_run_feedback_batches_ordinal_non_negative check (batch_ordinal >= 0)
);

create table if not exists itotori_localization_refinement_run_feedback_events (
  run_id text not null references itotori_localization_journal_runs(run_id) on delete cascade,
  feedback_event_id text not null references itotori_play_test_feedback_events(feedback_event_id) on delete restrict,
  feedback_batch_id text not null,
  event_ordinal integer not null,
  created_at timestamptz not null default now(),
  primary key (run_id, feedback_event_id),
  constraint itotori_localization_refinement_run_feedback_events_ordinal_unique unique (run_id, event_ordinal),
  constraint itotori_localization_refinement_run_feedback_events_batch_fkey
    foreign key (run_id, feedback_batch_id)
    references itotori_localization_refinement_run_feedback_batches(run_id, feedback_batch_id)
    on delete cascade,
  constraint itotori_localization_refinement_run_feedback_events_ordinal_non_negative check (event_ordinal >= 0)
);

create table if not exists itotori_localization_refinement_run_wiki_heads (
  run_id text not null references itotori_localization_journal_runs(run_id) on delete cascade,
  context_artifact_id text not null references itotori_context_artifacts(context_artifact_id) on delete restrict,
  context_entry_version_id text not null references itotori_context_entry_versions(context_entry_version_id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (run_id, context_artifact_id),
  constraint itotori_localization_refinement_run_wiki_heads_version_unique unique (run_id, context_entry_version_id)
);

create table if not exists itotori_localization_refinement_run_members (
  run_id text not null,
  bridge_unit_id text not null,
  strategy text not null,
  base_patch_version_id text,
  base_source_run_id text,
  base_journal_outcome_id text,
  base_result_revision_id text,
  created_at timestamptz not null default now(),
  primary key (run_id, bridge_unit_id),
  constraint itotori_localization_refinement_run_members_planned_unit_fkey
    foreign key (run_id, bridge_unit_id)
    references itotori_localization_journal_run_units(run_id, bridge_unit_id)
    on delete cascade,
  constraint itotori_localization_refinement_run_members_strategy_known
    check (strategy in ('reuse', 'redraft', 'new_scope')),
  constraint itotori_localization_refinement_run_members_base_member_fkey
    foreign key (
      base_patch_version_id,
      bridge_unit_id,
      base_source_run_id,
      base_journal_outcome_id,
      base_result_revision_id
    )
    references itotori_localization_patch_version_units (
      patch_version_id,
      bridge_unit_id,
      source_run_id,
      journal_outcome_id,
      result_revision_id
    )
    on delete restrict,
  constraint itotori_localization_refinement_run_members_provenance
    check (
      (
        strategy = 'new_scope'
        and base_patch_version_id is null
        and base_source_run_id is null
        and base_journal_outcome_id is null
        and base_result_revision_id is null
      )
      or (
        strategy in ('reuse', 'redraft')
        and base_patch_version_id is not null
        and base_source_run_id is not null
        and base_journal_outcome_id is not null
        and base_result_revision_id is not null
      )
    )
);

create index if not exists itotori_localization_refinement_run_members_strategy_idx
  on itotori_localization_refinement_run_members (run_id, strategy);

-- Freeze mappings must agree with the journal's base patch, so a raw insert
-- cannot accidentally mix feedback or reused members from a different patch
-- lineage into the same run.
create or replace function itotori_assert_refinement_run_mapping_base()
returns trigger
language plpgsql
as $$
declare
  frozen_base_patch_version_id text;
  row_base_patch_version_id text;
  row_bridge_unit_id text;
begin
  select base_patch_version_id
    into frozen_base_patch_version_id
  from itotori_localization_journal_runs
  where run_id = new.run_id;

  if frozen_base_patch_version_id is null then
    raise exception 'run % is not a refinement run', new.run_id;
  end if;

  row_base_patch_version_id := to_jsonb(new)->>'base_patch_version_id';
  row_bridge_unit_id := to_jsonb(new)->>'bridge_unit_id';
  if tg_table_name = 'itotori_localization_refinement_run_members'
    and row_base_patch_version_id is not null
    and row_base_patch_version_id <> frozen_base_patch_version_id then
    raise exception 'refinement member %/% names base patch %, expected %',
      new.run_id, row_bridge_unit_id, row_base_patch_version_id, frozen_base_patch_version_id;
  end if;
  return new;
end;
$$;

drop trigger if exists itotori_refinement_run_member_base_guard
  on itotori_localization_refinement_run_members;

create trigger itotori_refinement_run_member_base_guard
before insert or update of base_patch_version_id
on itotori_localization_refinement_run_members
for each row
execute function itotori_assert_refinement_run_mapping_base();

drop trigger if exists itotori_refinement_run_feedback_batch_base_guard
  on itotori_localization_refinement_run_feedback_batches;

create trigger itotori_refinement_run_feedback_batch_base_guard
before insert or update
on itotori_localization_refinement_run_feedback_batches
for each row
execute function itotori_assert_refinement_run_mapping_base();

drop trigger if exists itotori_refinement_run_wiki_head_base_guard
  on itotori_localization_refinement_run_wiki_heads;

create trigger itotori_refinement_run_wiki_head_base_guard
before insert or update
on itotori_localization_refinement_run_wiki_heads
for each row
execute function itotori_assert_refinement_run_mapping_base();
