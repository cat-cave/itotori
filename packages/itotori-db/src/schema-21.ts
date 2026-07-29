import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
// Type-only import (erased at compile time — no runtime cycle with
// authorization.ts, which imports table VALUES from this module). Types the
// auth permission-set / grant / audit columns to the single Permission source
// of truth in authorization.ts.

import {
  authAccounts,
  type AuthPrincipalKind,
  type AuthProviderClaimKind,
  type AuthSsoProviderProtocol,
} from "./schema-20.js";

export const authPrincipals = pgTable(
  "itotori_auth_principals",
  {
    principalId: text("principal_id").primaryKey(),
    principalKind: text("principal_kind").notNull().$type<AuthPrincipalKind>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
  },
  (table) => [index("itotori_auth_principals_kind_idx").on(table.principalKind)],
);

/** Human user identity subtype (1:1 with a `human_user` principal). */
export const authUsers = pgTable(
  "itotori_auth_users",
  {
    userId: text("user_id").primaryKey(),
    principalId: text("principal_id")
      .notNull()
      .unique()
      .references(() => authPrincipals.principalId, { onDelete: "cascade" }),
    email: text("email"),
    displayName: text("display_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("itotori_auth_users_email_idx").on(table.email)],
);

/** Non-human principal subtype (1:1 with a `service_principal` principal). */
export const authServicePrincipals = pgTable("itotori_auth_service_principals", {
  servicePrincipalId: text("service_principal_id").primaryKey(),
  principalId: text("principal_id")
    .notNull()
    .unique()
    .references(() => authPrincipals.principalId, { onDelete: "cascade" }),
  accountId: text("account_id")
    .notNull()
    .references(() => authAccounts.accountId, { onDelete: "cascade" }),
  displayName: text("display_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
});

/** User ↔ account tenancy link. Unique on (account, user). */
export const authAccountMemberships = pgTable(
  "itotori_auth_account_memberships",
  {
    membershipId: text("membership_id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => authAccounts.accountId, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => authUsers.userId, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("itotori_auth_account_memberships_account_user_key").on(table.accountId, table.userId),
    index("itotori_auth_account_memberships_user_idx").on(table.userId),
  ],
);

/** OIDC / SAML identity link. Unique on (provider, subject). */
export const authExternalIdentities = pgTable(
  "itotori_auth_external_identities",
  {
    externalIdentityId: text("external_identity_id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => authUsers.userId, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    subject: text("subject").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("itotori_auth_external_identities_provider_subject_key").on(
      table.provider,
      table.subject,
    ),
    index("itotori_auth_external_identities_user_idx").on(table.userId),
  ],
);

/** Admin-managed OIDC / SAML provider configuration for an account. */
export const authSsoProviderConfigs = pgTable(
  "itotori_auth_sso_provider_configs",
  {
    accountId: text("account_id")
      .notNull()
      .references(() => authAccounts.accountId, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    protocol: text("protocol").notNull().$type<AuthSsoProviderProtocol>(),
    displayName: text("display_name").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    oidcIssuer: text("oidc_issuer"),
    oidcClientId: text("oidc_client_id"),
    oidcScopes: jsonb("oidc_scopes")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    samlSsoUrl: text("saml_sso_url"),
    samlEntityId: text("saml_entity_id"),
    samlCertificateFingerprint: text("saml_certificate_fingerprint"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.providerId] }),
    check(
      "itotori_auth_sso_provider_configs_protocol_check",
      sql`${table.protocol} in ('oidc', 'saml')`,
    ),
    check(
      "itotori_auth_sso_provider_configs_provider_id_check",
      sql`length(${table.providerId}) > 0`,
    ),
    check(
      "itotori_auth_sso_provider_configs_display_name_check",
      sql`length(${table.displayName}) > 0`,
    ),
    check(
      "itotori_auth_sso_provider_configs_oidc_check",
      sql`${table.protocol} <> 'oidc' or (${table.oidcIssuer} is not null and ${table.oidcClientId} is not null)`,
    ),
    check(
      "itotori_auth_sso_provider_configs_saml_check",
      sql`${table.protocol} <> 'saml' or (${table.samlSsoUrl} is not null and ${table.samlEntityId} is not null)`,
    ),
    index("itotori_auth_sso_provider_configs_account_idx").on(table.accountId),
  ],
);

/** Account-wide security and session policy backing Settings > Account security. */
export const authAccountSecuritySettings = pgTable(
  "itotori_auth_account_security_settings",
  {
    accountId: text("account_id")
      .primaryKey()
      .references(() => authAccounts.accountId, { onDelete: "cascade" }),
    requireSso: boolean("require_sso").notNull().default(false),
    requireMfa: boolean("require_mfa").notNull().default(false),
    allowPasswordLogin: boolean("allow_password_login").notNull().default(true),
    sessionIdleTimeoutMinutes: integer("session_idle_timeout_minutes").notNull(),
    sessionAbsoluteTimeoutMinutes: integer("session_absolute_timeout_minutes").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "itotori_auth_account_security_settings_idle_timeout_check",
      sql`${table.sessionIdleTimeoutMinutes} > 0`,
    ),
    check(
      "itotori_auth_account_security_settings_absolute_timeout_check",
      sql`${table.sessionAbsoluteTimeoutMinutes} >= ${table.sessionIdleTimeoutMinutes}`,
    ),
  ],
);

/**
 * Quarantined provider claims observed during external-login processing.
 *
 * These rows are untrusted facts from the IdP. Authorization never reads them
 * directly; only explicit admin-created mappings may materialize ordinary grant
 * rows.
 */
export const authExternalIdentityProviderClaims = pgTable(
  "itotori_auth_external_identity_provider_claims",
  {
    externalIdentityId: text("external_identity_id")
      .notNull()
      .references(() => authExternalIdentities.externalIdentityId, { onDelete: "cascade" }),
    claimKind: text("claim_kind").notNull().$type<AuthProviderClaimKind>(),
    claimValue: text("claim_value").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.externalIdentityId, table.claimKind, table.claimValue] }),
    check(
      "itotori_auth_external_identity_provider_claims_kind_check",
      sql`${table.claimKind} in ('role', 'group', 'scope')`,
    ),
    check(
      "itotori_auth_external_identity_provider_claims_value_check",
      sql`length(${table.claimValue}) > 0`,
    ),
    index("itotori_auth_external_identity_provider_claims_identity_idx").on(
      table.externalIdentityId,
    ),
  ],
);

/**
 * Admin-created mapping from a quarantined provider claim to an exact
 * permission. Login reconciliation uses these rows to materialize ordinary
 * `auth_principal_permission_grants`; authorization still reads only grants.
 */
