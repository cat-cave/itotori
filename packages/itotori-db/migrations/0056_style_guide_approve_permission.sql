-- ITOTORI-128: dedicated style-guide approval permission.
--
-- Until this migration, approving a style-guide version was authorized by the
-- broad `draft.write` permission -- the same permission that persists arbitrary
-- draft translations. Style-guide approval is a higher-trust governance action
-- (it flips the approved policy for a locale branch and fans out affected-work
-- invalidation), so it now requires its own dedicated permission,
-- `style_guide.approve`. `draft.write` alone no longer authorizes approval.
--
-- This migration adds `style_guide.approve` to the permission check constraint
-- so grants of the new permission are accepted. The constraint is replaced with
-- the full current permission set (immutable-migration convention: never edit an
-- applied migration; add a forward one that recreates the constraint).
--
-- @permission-gate style_guide.approve approves a style-guide version

alter table itotori_user_permission_grants
  drop constraint if exists itotori_user_permission_grants_permission_check;

alter table itotori_user_permission_grants
  add constraint itotori_user_permission_grants_permission_check check (
    permission in (
      'project.import',
      'draft.write',
      'patch.export',
      'runtime.ingest',
      'feedback.import',
      'queue.manage',
      'queue.read',
      'catalog.read',
      'catalog.write',
      'audit.write',
      'style_guide.approve',
      'system.reset'
    )
  );
