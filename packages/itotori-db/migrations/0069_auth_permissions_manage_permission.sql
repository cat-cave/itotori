-- auth-013-permission-editor-api: exact permission for permission editor
-- operations.
--
-- The permission-management UI may grant/revoke direct permissions, grant/revoke
-- permission sets, and edit permission-set contents without broad account /
-- principal administration. Register that authority as its own exact permission:
-- auth.permissions.manage.

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
      'auth.admin',
      'auth.sso.manage',
      'auth.members.manage',
      'auth.permissions.manage',
      'system.reset'
    )
  );
