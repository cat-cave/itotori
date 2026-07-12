-- A playable localization patch is an immutable, already-verified fact.
-- Freeze its manifest and the durable membership/stage evidence on which the
-- playable decision depended. Parent/run deletion remains legal: cascade
-- children see no surviving playable parent and therefore pass these guards.
--
-- @permission-gate draft.write writes
-- @permission-gate catalog.read reads

create or replace function itotori_freeze_localization_result_revision()
returns trigger
language plpgsql
as $$
begin
  raise exception 'localization result revision % is immutable', old.result_revision_id;
end;
$$;

drop trigger if exists itotori_localization_result_revision_immutable
  on itotori_localization_result_revisions;

create trigger itotori_localization_result_revision_immutable
before update
on itotori_localization_result_revisions
for each row
execute function itotori_freeze_localization_result_revision();

create or replace function itotori_freeze_selected_translation_candidate()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1
    from itotori_localization_result_revisions revision
    where revision.journal_outcome_id = old.journal_outcome_id
      and revision.selected_candidate_id = old.candidate_id
  ) then
    raise exception 'selected translation candidate % for outcome % is immutable', old.candidate_id, old.journal_outcome_id;
  end if;
  return new;
end;
$$;

drop trigger if exists itotori_selected_translation_candidate_immutable
  on itotori_translation_candidates;

create trigger itotori_selected_translation_candidate_immutable
before update of journal_outcome_id, candidate_id, body
on itotori_translation_candidates
for each row
execute function itotori_freeze_selected_translation_candidate();

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
  ) then
    raise exception 'playable patch version % is immutable', old.patch_version_id;
  end if;
  return new;
end;
$$;

drop trigger if exists itotori_playable_patch_manifest_immutable
  on itotori_localization_patch_versions;

create trigger itotori_playable_patch_manifest_immutable
before update of status, artifact_hashes, artifact_refs, playable_at
on itotori_localization_patch_versions
for each row
execute function itotori_freeze_playable_patch_manifest();

create or replace function itotori_freeze_playable_patch_membership()
returns trigger
language plpgsql
as $$
begin
  if tg_op <> 'INSERT' and exists (
    select 1
    from itotori_localization_patch_versions patch
    where patch.patch_version_id = old.patch_version_id
      and patch.status = 'playable'
  ) then
    raise exception 'membership for playable patch version % is immutable', old.patch_version_id;
  end if;
  if tg_op <> 'DELETE' and exists (
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

drop trigger if exists itotori_playable_patch_membership_immutable
  on itotori_localization_patch_version_units;

create trigger itotori_playable_patch_membership_immutable
before insert or update or delete
on itotori_localization_patch_version_units
for each row
execute function itotori_freeze_playable_patch_membership();

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

drop trigger if exists itotori_playable_patch_stage_evidence_immutable
  on itotori_localization_run_finalizer_outbox;

create trigger itotori_playable_patch_stage_evidence_immutable
before update or delete
on itotori_localization_run_finalizer_outbox
for each row
execute function itotori_freeze_playable_patch_stage_evidence();
