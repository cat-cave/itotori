-- auth-016-session-admin-tools: inspect/revoke active sessions.
--
-- Adds the exact permission that gates session administration and widens the
-- auth audit/action surface for explicit session revocations.

alter table itotori_auth_sessions
  add column if not exists user_agent text,
  add column if not exists ip_address text,
  add column if not exists device_label text;

alter table itotori_auth_audit_events
  drop constraint if exists itotori_auth_audit_events_action_check;

alter table itotori_auth_audit_events
  add constraint itotori_auth_audit_events_action_check check (
    action in ('granted', 'revoked', 'invited', 'accepted', 'removed', 'session_revoked')
  );

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
      'auth.sessions.manage',
      'auth.permissions.manage',
      'system.reset'
    )
  );
