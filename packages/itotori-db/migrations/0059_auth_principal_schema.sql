-- auth-001-principal-schema: multi-user principal / account / permission-set
-- identity layer.
--
-- This EXTENDS the existing single-user substrate (itotori_users +
-- itotori_user_permission_grants, which requirePermission reads) with the
-- organization / membership / identity / session / permission-set / audit layer
-- a real multi-user auth service needs. The single-user substrate is untouched
-- and keeps working; nothing here replaces it.
--
-- GOVERNING INVARIANT (docs/permissions.md): access control is PERMISSION-based,
-- never role-based. There is NO role column anywhere that authorization branches
-- on. A "role" is ONLY a permission_set -- a named, editable DATA bundle of
-- permission rows granted to a principal. A principal's effective permissions
-- are the UNION of its direct permission grants and the permissions of every
-- permission-set granted to it; authorization still resolves to an exact-match
-- permission check, never a role string.
--
-- principal_kind is an identity-TYPE discriminator (human user vs non-human
-- service principal), NOT an authorization role: no authorization code branches
-- on it. It exists so a grant / session / audit row can reference either kind of
-- principal through one supertype id.
--
-- @permission-gate auth.admin administer principals, accounts, permission sets,
--   and grants in the multi-user auth layer

-- The org / workspace tenant.
create table if not exists itotori_auth_accounts (
  account_id text primary key,
  slug text not null unique,
  name text not null,
  created_at timestamptz not null default now(),
  disabled_at timestamptz
);

-- The unifying principal supertype (human user OR service principal).
create table if not exists itotori_auth_principals (
  principal_id text primary key,
  principal_kind text not null check (principal_kind in ('human_user', 'service_principal')),
  created_at timestamptz not null default now(),
  disabled_at timestamptz
);

create index if not exists itotori_auth_principals_kind_idx
  on itotori_auth_principals (principal_kind);

-- Human user subtype (1:1 with a human_user principal).
create table if not exists itotori_auth_users (
  user_id text primary key,
  principal_id text not null unique references itotori_auth_principals(principal_id) on delete cascade,
  email text,
  display_name text not null,
  created_at timestamptz not null default now()
);

-- One identity per email when present (NULL emails do not collide).
create unique index if not exists itotori_auth_users_email_idx
  on itotori_auth_users (email);

-- Non-human principal subtype (1:1 with a service_principal principal).
create table if not exists itotori_auth_service_principals (
  service_principal_id text primary key,
  principal_id text not null unique references itotori_auth_principals(principal_id) on delete cascade,
  account_id text not null references itotori_auth_accounts(account_id) on delete cascade,
  display_name text not null,
  created_at timestamptz not null default now(),
  disabled_at timestamptz
);

-- User <-> account tenancy link.
create table if not exists itotori_auth_account_memberships (
  membership_id text primary key,
  account_id text not null references itotori_auth_accounts(account_id) on delete cascade,
  user_id text not null references itotori_auth_users(user_id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint itotori_auth_account_memberships_account_user_key unique (account_id, user_id)
);

create index if not exists itotori_auth_account_memberships_user_idx
  on itotori_auth_account_memberships (user_id);

-- OIDC / SAML identity link.
create table if not exists itotori_auth_external_identities (
  external_identity_id text primary key,
  user_id text not null references itotori_auth_users(user_id) on delete cascade,
  provider text not null,
  subject text not null,
  created_at timestamptz not null default now(),
  constraint itotori_auth_external_identities_provider_subject_key unique (provider, subject)
);

create index if not exists itotori_auth_external_identities_user_idx
  on itotori_auth_external_identities (user_id);

-- Account invitation. initial_permission_set_ids is the OPTIONAL list of
-- permission-set ids granted on accept (a permission bundle, never a role).
create table if not exists itotori_auth_invitations (
  invitation_id text primary key,
  account_id text not null references itotori_auth_accounts(account_id) on delete cascade,
  email text not null,
  initial_permission_set_ids jsonb not null default '[]'::jsonb,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists itotori_auth_invitations_account_email_idx
  on itotori_auth_invitations (account_id, email);

-- Opaque server-side session for a principal.
create table if not exists itotori_auth_sessions (
  session_id text primary key,
  principal_id text not null references itotori_auth_principals(principal_id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);

create index if not exists itotori_auth_sessions_principal_idx
  on itotori_auth_sessions (principal_id);

-- A named, editable permission bundle -- the ONLY thing a "role" may ever be.
create table if not exists itotori_auth_permission_sets (
  permission_set_id text primary key,
  account_id text not null references itotori_auth_accounts(account_id) on delete cascade,
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint itotori_auth_permission_sets_account_name_key unique (account_id, name)
);

-- The permissions in a set. permission is a Permission value validated by the
-- typed repository layer (single source of truth in permissionValues).
create table if not exists itotori_auth_permission_set_permissions (
  permission_set_id text not null references itotori_auth_permission_sets(permission_set_id) on delete cascade,
  permission text not null,
  added_at timestamptz not null default now(),
  primary key (permission_set_id, permission)
);

-- Direct exact-permission overrides granted to a principal.
create table if not exists itotori_auth_principal_permission_grants (
  principal_id text not null references itotori_auth_principals(principal_id) on delete cascade,
  permission text not null,
  granted_at timestamptz not null default now(),
  primary key (principal_id, permission)
);

-- A permission set granted to a principal (the "role assignment").
create table if not exists itotori_auth_principal_permission_set_grants (
  principal_id text not null references itotori_auth_principals(principal_id) on delete cascade,
  permission_set_id text not null references itotori_auth_permission_sets(permission_set_id) on delete cascade,
  granted_at timestamptz not null default now(),
  primary key (principal_id, permission_set_id)
);

-- Append-only audit trail of authorization changes.
create table if not exists itotori_auth_audit_events (
  auth_audit_event_id text primary key,
  actor_principal_id text not null references itotori_auth_principals(principal_id) on delete restrict,
  target_principal_id text not null references itotori_auth_principals(principal_id) on delete restrict,
  action text not null check (action in ('granted', 'revoked')),
  permission text,
  permission_set_id text references itotori_auth_permission_sets(permission_set_id) on delete set null,
  reason text,
  request_id text,
  created_at timestamptz not null default now()
);

create index if not exists itotori_auth_audit_events_target_idx
  on itotori_auth_audit_events (target_principal_id, created_at);

create index if not exists itotori_auth_audit_events_actor_idx
  on itotori_auth_audit_events (actor_principal_id, created_at);

-- New permission auth.admin gates the auth-admin repository mutations. Recreate
-- the single-user substrate's permission check constraint with the full current
-- permission set including auth.admin (immutable-migration convention: never
-- edit an applied migration; add a forward one that recreates the constraint).
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
      'system.reset'
    )
  );
