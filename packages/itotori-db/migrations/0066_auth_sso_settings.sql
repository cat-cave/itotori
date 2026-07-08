-- auth-014-settings-sso-api: account SSO/security/session-policy settings.

create table if not exists itotori_auth_sso_provider_configs (
  account_id text not null references itotori_auth_accounts(account_id) on delete cascade,
  provider_id text not null,
  protocol text not null,
  display_name text not null,
  enabled boolean not null default true,
  oidc_issuer text,
  oidc_client_id text,
  oidc_scopes jsonb not null default '[]'::jsonb,
  saml_sso_url text,
  saml_entity_id text,
  saml_certificate_fingerprint text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (account_id, provider_id),
  constraint itotori_auth_sso_provider_configs_protocol_check
    check (protocol in ('oidc', 'saml')),
  constraint itotori_auth_sso_provider_configs_provider_id_check
    check (length(provider_id) > 0),
  constraint itotori_auth_sso_provider_configs_display_name_check
    check (length(display_name) > 0),
  constraint itotori_auth_sso_provider_configs_oidc_check
    check (protocol <> 'oidc' or (oidc_issuer is not null and oidc_client_id is not null)),
  constraint itotori_auth_sso_provider_configs_saml_check
    check (protocol <> 'saml' or (saml_sso_url is not null and saml_entity_id is not null))
);

create index if not exists itotori_auth_sso_provider_configs_account_idx
  on itotori_auth_sso_provider_configs(account_id);

create table if not exists itotori_auth_account_security_settings (
  account_id text primary key references itotori_auth_accounts(account_id) on delete cascade,
  require_sso boolean not null default false,
  require_mfa boolean not null default false,
  allow_password_login boolean not null default true,
  session_idle_timeout_minutes integer not null,
  session_absolute_timeout_minutes integer not null,
  updated_at timestamptz not null default now(),
  constraint itotori_auth_account_security_settings_idle_timeout_check
    check (session_idle_timeout_minutes > 0),
  constraint itotori_auth_account_security_settings_absolute_timeout_check
    check (session_absolute_timeout_minutes >= session_idle_timeout_minutes)
);

-- New permission auth.sso.manage gates SSO provider and account security policy
-- management. Recreate the legacy single-user permission check with the full
-- current permission set.
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
      'system.reset'
    )
  );
