-- Content decryption is authorized by an exact permission grant. Permission-set
-- names remain data labels and do not participate in the authorization decision.

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
      'content.read',
      'catalog.read',
      'catalog.write',
      'audit.write',
      'style_guide.approve',
      'auth.admin',
      'auth.sso.manage',
      'auth.members.manage',
      'auth.sessions.manage',
      'auth.permissions.manage',
      'system.reset'
    )
  );
