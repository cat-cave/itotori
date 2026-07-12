-- Preserve idempotent `insert ... on conflict do nothing` membership replays
-- while retaining the playable-patch immutability guard introduced in 0085.
-- A byte-for-byte identical existing member may reach its uniqueness conflict;
-- any genuinely new member for a playable patch remains forbidden.
--
-- @permission-gate draft.write writes
-- @permission-gate catalog.read reads

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
        and member.journal_outcome_id = new.journal_outcome_id
        and member.result_revision_id = new.result_revision_id
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
