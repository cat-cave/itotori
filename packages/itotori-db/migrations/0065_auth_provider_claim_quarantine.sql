-- auth-015-provider-claim-quarantine
--
-- Provider roles/groups/scopes are untrusted IdP input. They are recorded in a
-- quarantine table for audit/reconciliation, but authorization must never read
-- them directly. Only an admin-created provider-claim -> permission mapping can
-- materialize an ordinary itotori_auth_principal_permission_grants row; the
-- existing grant resolver remains the only authorization path.

create table if not exists itotori_auth_external_identity_provider_claims (
  external_identity_id text not null references itotori_auth_external_identities(external_identity_id) on delete cascade,
  claim_kind text not null check (claim_kind in ('role', 'group', 'scope')),
  claim_value text not null check (length(claim_value) > 0),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (external_identity_id, claim_kind, claim_value)
);

create index if not exists itotori_auth_external_identity_provider_claims_identity_idx
  on itotori_auth_external_identity_provider_claims (external_identity_id);

create table if not exists itotori_auth_provider_claim_permission_mappings (
  provider text not null,
  claim_kind text not null check (claim_kind in ('role', 'group', 'scope')),
  claim_value text not null check (length(claim_value) > 0),
  permission text not null,
  created_by_principal_id text not null references itotori_auth_principals(principal_id) on delete restrict,
  reason text,
  request_id text,
  created_at timestamptz not null default now(),
  primary key (provider, claim_kind, claim_value, permission)
);

create index if not exists itotori_auth_provider_claim_permission_mappings_claim_idx
  on itotori_auth_provider_claim_permission_mappings (provider, claim_kind, claim_value);
