-- auth-012-member-management-api: member lifecycle management.
--
-- Adds the exact permission that gates invite / accept / list / remove member
-- operations, and widens the auth audit table so invitation and membership
-- lifecycle events can be recorded before or beyond a target principal grant.

alter table itotori_auth_audit_events
  drop constraint if exists itotori_auth_audit_events_action_check;

alter table itotori_auth_audit_events
  alter column target_principal_id drop not null;

alter table itotori_auth_audit_events
  add column if not exists account_id text references itotori_auth_accounts(account_id) on delete set null,
  add column if not exists invitation_id text references itotori_auth_invitations(invitation_id) on delete set null,
  add column if not exists target_email text;

alter table itotori_auth_audit_events
  add constraint itotori_auth_audit_events_action_check check (
    action in ('granted', 'revoked', 'invited', 'accepted', 'removed')
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
      'system.reset'
    )
  );
