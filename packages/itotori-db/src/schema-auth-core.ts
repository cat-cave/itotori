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

export const authPrincipalKindValues = {
  humanUser: "human_user",
  servicePrincipal: "service_principal",
} as const;

export type AuthPrincipalKind =
  (typeof authPrincipalKindValues)[keyof typeof authPrincipalKindValues];

/** External IdP claim KIND. Claims are quarantined input, not grants. */
export const authProviderClaimKindValues = {
  role: "role",
  group: "group",
  scope: "scope",
} as const;

export type AuthProviderClaimKind =
  (typeof authProviderClaimKindValues)[keyof typeof authProviderClaimKindValues];

/** Direction of a permission / permission-set delta recorded in the audit log. */
export const authAuditEventActionValues = {
  granted: "granted",
  revoked: "revoked",
  invited: "invited",
  accepted: "accepted",
  removed: "removed",
  sessionRevoked: "session_revoked",
} as const;

export type AuthAuditEventAction =
  (typeof authAuditEventActionValues)[keyof typeof authAuditEventActionValues];

/**
 * The kind of permission-set MODEL mutation recorded in the permission-set audit
 * trail. This is orthogonal to `authAuditEventActionValues` (which records a
 * grant/revoke against a principal): a set mutation edits the DATA of a
 * permission bundle itself, and its subject is a permission SET, not a target
 * principal. Editing a set changes the effective permissions of every principal
 * the set is granted to, so the change is auditable in its own right.
 */
export const authPermissionSetAuditActionValues = {
  created: "set_created",
  renamed: "set_renamed",
  permissionAdded: "permission_added",
  permissionRemoved: "permission_removed",
  deleted: "set_deleted",
} as const;

export type AuthPermissionSetAuditAction =
  (typeof authPermissionSetAuditActionValues)[keyof typeof authPermissionSetAuditActionValues];

/** External SSO provider protocol configured by an account admin. */
export const authSsoProviderProtocolValues = {
  oidc: "oidc",
  saml: "saml",
} as const;

export type AuthSsoProviderProtocol =
  (typeof authSsoProviderProtocolValues)[keyof typeof authSsoProviderProtocolValues];

/** The org / workspace tenant that owns memberships, permission sets, etc. */
export const authAccounts = pgTable("itotori_auth_accounts", {
  accountId: text("account_id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
});

export const authBillingPeriodValues = {
  monthly: "monthly",
  annual: "annual",
  manual: "manual",
} as const;

export type AuthBillingPeriod =
  (typeof authBillingPeriodValues)[keyof typeof authBillingPeriodValues];

/** Internal account billing plan and seat entitlement. */
export const authAccountBillingSeats = pgTable(
  "itotori_auth_account_billing_seats",
  {
    accountId: text("account_id")
      .primaryKey()
      .references(() => authAccounts.accountId, { onDelete: "cascade" }),
    planId: text("plan_id").notNull(),
    planName: text("plan_name").notNull(),
    seatLimit: integer("seat_limit").notNull(),
    includedSeats: integer("included_seats").notNull(),
    billingPeriod: text("billing_period").notNull().$type<AuthBillingPeriod>().default("monthly"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("itotori_auth_account_billing_seats_plan_id_check", sql`length(${table.planId}) > 0`),
    check("itotori_auth_account_billing_seats_plan_name_check", sql`length(${table.planName}) > 0`),
    check("itotori_auth_account_billing_seats_seat_limit_check", sql`${table.seatLimit} >= 1`),
    check(
      "itotori_auth_account_billing_seats_included_seats_check",
      sql`${table.includedSeats} >= 0`,
    ),
    check(
      "itotori_auth_account_billing_seats_period_check",
      sql`${table.billingPeriod} in ('monthly', 'annual', 'manual')`,
    ),
  ],
);

/**
 * The unifying principal supertype: a principal is a human user OR a service
 * principal. Grants, sessions, and audit rows reference a principal by this id
 * regardless of kind. `principalKind` is an identity-type discriminator, not a
 * role (see the module note).
 */
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
