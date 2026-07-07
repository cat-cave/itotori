-- auth-004-permission-set-model: the data-driven permission-set model that
-- replaces any role concept.
--
-- auth-001 (migration 0059) created the permission-set tables
-- (itotori_auth_permission_sets + itotori_auth_permission_set_permissions +
-- itotori_auth_principal_permission_set_grants) and auth-002 already resolves a
-- principal's effective permissions by EXPANDING granted sets to permissions at
-- check time. This migration adds the audit trail for editing the permission-set
-- MODEL itself: create / rename / add-permission / remove-permission / delete.
--
-- GOVERNING INVARIANT (docs/permissions.md): access control is PERMISSION-based,
-- never role-based. A "role" is ONLY a permission_set -- a named, editable DATA
-- bundle of permission rows. Editing a granted set changes the effective
-- permissions of every principal it is granted to; that edit is auditable in its
-- own right. Nothing branches authorization on a set/role NAME -- the name is a
-- label; resolution is purely by the permissions in the set.
--
-- The permission-set audit trail is SEPARATE from the principal grant/revoke
-- audit trail (itotori_auth_audit_events): a set mutation's subject is a
-- permission SET, not a target principal, so it has no target_principal_id.
-- permission_set_id is retained as plain text (NOT a foreign key) so a
-- set_deleted row survives the set's deletion instead of being cascaded away;
-- set_name snapshots the name at mutation time so a deleted set stays legible.
--
-- @permission-gate auth.admin edit (create/rename/add/remove/delete) permission
--   sets in the multi-user auth layer

create table if not exists itotori_auth_permission_set_audit_events (
  auth_permission_set_audit_event_id text primary key,
  actor_principal_id text not null references itotori_auth_principals(principal_id) on delete restrict,
  permission_set_id text not null,
  set_name text not null,
  action text not null check (
    action in (
      'set_created',
      'set_renamed',
      'permission_added',
      'permission_removed',
      'set_deleted'
    )
  ),
  permission text,
  reason text,
  request_id text,
  created_at timestamptz not null default now()
);

create index if not exists itotori_auth_permission_set_audit_events_set_idx
  on itotori_auth_permission_set_audit_events (permission_set_id, created_at);

create index if not exists itotori_auth_permission_set_audit_events_actor_idx
  on itotori_auth_permission_set_audit_events (actor_principal_id, created_at);
