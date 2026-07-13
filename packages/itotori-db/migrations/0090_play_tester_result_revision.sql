-- p0-core-result-revision-hitl — play-tester target edit → LocalizedResultRevision
-- + child delivered PatchVersion (atomic). Extends the node-5 foundation:
-- multiple result revisions per outcome, parent-linked child patch versions,
-- and a current-selected pointer for export (no approval gate).
--
-- @permission-gate draft.write writes
-- @permission-gate catalog.read reads

-- ---------------------------------------------------------------------------
-- Result revisions: allow play-tester lineage beyond the single run-origin row.
-- ---------------------------------------------------------------------------

alter table itotori_localization_result_revisions
  drop constraint itotori_localization_result_revisions_outcome_unique;

alter table itotori_localization_result_revisions
  drop constraint itotori_localization_result_revisions_origin_known;

alter table itotori_localization_result_revisions
  add column parent_revision_id text,
  add column actor_user_id text,
  add column created_for_patch_version_id text;

alter table itotori_localization_result_revisions
  add constraint itotori_localization_result_revisions_origin_known
    check (origin in ('run_written_outcome', 'play_tester_edit'));

-- Exactly one run-origin revision per written outcome (finalizer coverage).
create unique index itotori_localization_result_revisions_run_origin_outcome_unique
  on itotori_localization_result_revisions (journal_outcome_id)
  where origin = 'run_written_outcome';

alter table itotori_localization_result_revisions
  add constraint itotori_localization_result_revisions_parent_fkey
    foreign key (parent_revision_id)
    references itotori_localization_result_revisions (result_revision_id)
    on delete restrict;

alter table itotori_localization_result_revisions
  add constraint itotori_localization_result_revisions_play_tester_provenance
    check (
      (
        origin = 'run_written_outcome'
        and parent_revision_id is null
        and actor_user_id is null
      )
      or (
        origin = 'play_tester_edit'
        and parent_revision_id is not null
        and actor_user_id is not null
        and length(btrim(actor_user_id)) > 0
        and created_for_patch_version_id is not null
        and length(btrim(created_for_patch_version_id)) > 0
      )
    );

create index itotori_localization_result_revisions_parent_idx
  on itotori_localization_result_revisions (parent_revision_id)
  where parent_revision_id is not null;

-- ---------------------------------------------------------------------------
-- Patch versions: child delivered revisions under a parent playable patch.
-- ---------------------------------------------------------------------------

alter table itotori_localization_patch_versions
  drop constraint if exists itotori_localization_patch_versions_run_id_key;

-- Some Postgres catalogs name the unique constraint from `run_id text not null unique`.
do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conrelid = 'itotori_localization_patch_versions'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) = 'UNIQUE (run_id)'
  ) then
    execute (
      select 'alter table itotori_localization_patch_versions drop constraint ' || quote_ident(conname)
      from pg_constraint
      where conrelid = 'itotori_localization_patch_versions'::regclass
        and contype = 'u'
        and pg_get_constraintdef(oid) = 'UNIQUE (run_id)'
      limit 1
    );
  end if;
end
$$;

alter table itotori_localization_patch_versions
  add column parent_patch_version_id text,
  add column origin text not null default 'run_finalizer',
  add column actor_user_id text,
  add column selected_at timestamptz;

alter table itotori_localization_patch_versions
  add constraint itotori_localization_patch_versions_origin_known
    check (origin in ('run_finalizer', 'play_tester_edit'));

alter table itotori_localization_patch_versions
  add constraint itotori_localization_patch_versions_parent_fkey
    foreign key (parent_patch_version_id)
    references itotori_localization_patch_versions (patch_version_id)
    on delete restrict;

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
    );

-- One run-origin patch per localization run (node-5 finalizer invariant).
create unique index itotori_localization_patch_versions_run_origin_unique
  on itotori_localization_patch_versions (run_id)
  where parent_patch_version_id is null;

-- Exactly one currently-selected delivered patch per run (export pointer).
create unique index itotori_localization_patch_versions_run_selected_unique
  on itotori_localization_patch_versions (run_id)
  where selected_at is not null;

create index itotori_localization_patch_versions_parent_idx
  on itotori_localization_patch_versions (parent_patch_version_id)
  where parent_patch_version_id is not null;

-- Existing playable run-origin patches become the selected export revision.
update itotori_localization_patch_versions
set selected_at = playable_at
where status = 'playable'
  and parent_patch_version_id is null
  and selected_at is null
  and playable_at is not null;

-- Stage-evidence freeze must tolerate multiple playable patches on one run
-- (parent stays playable; children become playable). Still freezes when any
-- playable patch exists for the run.
create or replace function itotori_freeze_playable_patch_stage_evidence()
returns trigger
language plpgsql
as $$
begin
  if old.stage in ('patch_build', 'patch_apply', 'validation') and exists (
    select 1
    from itotori_localization_patch_versions patch
    where patch.run_id = old.run_id
      and patch.status = 'playable'
  ) then
    raise exception 'stage % for playable patch run % is immutable', old.stage, old.run_id;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
