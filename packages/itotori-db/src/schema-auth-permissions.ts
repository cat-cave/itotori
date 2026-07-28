import {
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { Permission } from "./authorization.js";
import { events } from "./schema-events.js";
import {
  authAccounts,
  authPrincipals,
  authExternalIdentities,
  type AuthProviderClaimKind,
  type AuthAuditEventAction,
  type AuthPermissionSetAuditAction,
} from "./schema-auth-core.js";

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
export const authProviderClaimPermissionMappings = pgTable(
  "itotori_auth_provider_claim_permission_mappings",
  {
    provider: text("provider").notNull(),
    claimKind: text("claim_kind").notNull().$type<AuthProviderClaimKind>(),
    claimValue: text("claim_value").notNull(),
    permission: text("permission").notNull().$type<Permission>(),
    createdByPrincipalId: text("created_by_principal_id")
      .notNull()
      .references(() => authPrincipals.principalId, { onDelete: "restrict" }),
    reason: text("reason"),
    requestId: text("request_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.provider, table.claimKind, table.claimValue, table.permission] }),
    check(
      "itotori_auth_provider_claim_permission_mappings_kind_check",
      sql`${table.claimKind} in ('role', 'group', 'scope')`,
    ),
    check(
      "itotori_auth_provider_claim_permission_mappings_claim_value_check",
      sql`length(${table.claimValue}) > 0`,
    ),
    index("itotori_auth_provider_claim_permission_mappings_claim_idx").on(
      table.provider,
      table.claimKind,
      table.claimValue,
    ),
  ],
);

/**
 * An account invitation. `initialPermissionSetIds` is the OPTIONAL list of
 * permission-set ids to grant the accepting principal on join — a permission
 * bundle, never a role string.
 */
export const authInvitations = pgTable(
  "itotori_auth_invitations",
  {
    invitationId: text("invitation_id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => authAccounts.accountId, { onDelete: "cascade" }),
    email: text("email").notNull(),
    initialPermissionSetIds: jsonb("initial_permission_set_ids")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("itotori_auth_invitations_account_email_idx").on(table.accountId, table.email)],
);

/** Opaque server-side session for a principal (human or service). */
export const authSessions = pgTable(
  "itotori_auth_sessions",
  {
    sessionId: text("session_id").primaryKey(),
    principalId: text("principal_id")
      .notNull()
      .references(() => authPrincipals.principalId, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    userAgent: text("user_agent"),
    ipAddress: text("ip_address"),
    deviceLabel: text("device_label"),
  },
  (table) => [index("itotori_auth_sessions_principal_idx").on(table.principalId)],
);

/**
 * A named, editable permission bundle. This is the ONLY thing a "role" may ever
 * be: a data row of permissions, account-scoped and editable. Unique per
 * (account, name).
 */
export const authPermissionSets = pgTable(
  "itotori_auth_permission_sets",
  {
    permissionSetId: text("permission_set_id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => authAccounts.accountId, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("itotori_auth_permission_sets_account_name_key").on(table.accountId, table.name),
  ],
);

/**
 * The permissions in a permission set. `permission` is a `Permission` value
 * (the same exact-match permission strings `requirePermission` checks); it is
 * validated by the typed repository layer, keeping a single source of truth in
 * `permissionValues` rather than a second SQL enum copy.
 */
export const authPermissionSetPermissions = pgTable(
  "itotori_auth_permission_set_permissions",
  {
    permissionSetId: text("permission_set_id")
      .notNull()
      .references(() => authPermissionSets.permissionSetId, { onDelete: "cascade" }),
    permission: text("permission").notNull().$type<Permission>(),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.permissionSetId, table.permission] })],
);

/** Direct exact-permission overrides granted to a principal. */
export const authPrincipalPermissionGrants = pgTable(
  "itotori_auth_principal_permission_grants",
  {
    principalId: text("principal_id")
      .notNull()
      .references(() => authPrincipals.principalId, { onDelete: "cascade" }),
    permission: text("permission").notNull().$type<Permission>(),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.principalId, table.permission] })],
);

/** A permission set granted to a principal (the "role assignment"). */
export const authPrincipalPermissionSetGrants = pgTable(
  "itotori_auth_principal_permission_set_grants",
  {
    principalId: text("principal_id")
      .notNull()
      .references(() => authPrincipals.principalId, { onDelete: "cascade" }),
    permissionSetId: text("permission_set_id")
      .notNull()
      .references(() => authPermissionSets.permissionSetId, { onDelete: "cascade" }),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.principalId, table.permissionSetId] })],
);

/**
 * Append-only audit trail of authorization changes and member lifecycle events:
 * which actor granted/revoked which permission or permission-set to/from which
 * target principal, invited which email, accepted which invitation, or removed
 * which member, why, and under which request id.
 */
export const authAuditEvents = pgTable(
  "itotori_auth_audit_events",
  {
    authAuditEventId: text("auth_audit_event_id").primaryKey(),
    actorPrincipalId: text("actor_principal_id")
      .notNull()
      .references(() => authPrincipals.principalId, { onDelete: "restrict" }),
    targetPrincipalId: text("target_principal_id").references(() => authPrincipals.principalId, {
      onDelete: "restrict",
    }),
    accountId: text("account_id").references(() => authAccounts.accountId, {
      onDelete: "set null",
    }),
    invitationId: text("invitation_id").references(() => authInvitations.invitationId, {
      onDelete: "set null",
    }),
    targetEmail: text("target_email"),
    action: text("action").notNull().$type<AuthAuditEventAction>(),
    permission: text("permission").$type<Permission>(),
    permissionSetId: text("permission_set_id").references(
      () => authPermissionSets.permissionSetId,
      { onDelete: "set null" },
    ),
    reason: text("reason"),
    requestId: text("request_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("itotori_auth_audit_events_target_idx").on(table.targetPrincipalId, table.createdAt),
    index("itotori_auth_audit_events_actor_idx").on(table.actorPrincipalId, table.createdAt),
  ],
);

/**
 * Append-only audit trail of permission-set MODEL edits: which actor created,
 * renamed, added/removed a permission to/from, or deleted which permission set,
 * why, and under which request id. Editing a granted set changes the effective
 * permissions of the principals it is granted to, so every set mutation is
 * recorded here.
 *
 * `permissionSetId` is a plain retained id (NOT a foreign key): the row must
 * survive the set's deletion so a `set_deleted` event is not itself cascaded
 * away. `setName` snapshots the set's name at mutation time so a deleted set is
 * still legible in the trail. `permission` is populated only for
 * `permission_added` / `permission_removed`.
 */
export const authPermissionSetAuditEvents = pgTable(
  "itotori_auth_permission_set_audit_events",
  {
    authPermissionSetAuditEventId: text("auth_permission_set_audit_event_id").primaryKey(),
    actorPrincipalId: text("actor_principal_id")
      .notNull()
      .references(() => authPrincipals.principalId, { onDelete: "restrict" }),
    permissionSetId: text("permission_set_id").notNull(),
    setName: text("set_name").notNull(),
    action: text("action").notNull().$type<AuthPermissionSetAuditAction>(),
    permission: text("permission").$type<Permission>(),
    reason: text("reason"),
    requestId: text("request_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("itotori_auth_permission_set_audit_events_set_idx").on(
      table.permissionSetId,
      table.createdAt,
    ),
    index("itotori_auth_permission_set_audit_events_actor_idx").on(
      table.actorPrincipalId,
      table.createdAt,
    ),
  ],
);

/** Delivery lifecycle for retained patch versions. */
export const localizationRunPatchVersionStatusValues = {
  building: "building",
  playable: "playable",
  failed: "failed",
} as const;

export type LocalizationRunPatchVersionStatus =
  (typeof localizationRunPatchVersionStatusValues)[keyof typeof localizationRunPatchVersionStatusValues];

/** How a patch member arrived in this exact delivery. */
export const localizationPatchVersionMemberOriginValues = {
  runWrittenOutcome: "run_written_outcome",
  reusedFromBase: "reused_from_base",
  playTesterEdit: "play_tester_edit",
} as const;

export type LocalizationPatchVersionMemberOrigin =
  (typeof localizationPatchVersionMemberOriginValues)[keyof typeof localizationPatchVersionMemberOriginValues];

/** Durable play-feedback event kinds. */
export const playTestFeedbackEventKindValues = {
  resultEdit: "result_edit",
  comment: "comment",
  addedContext: "added_context",
  wikiEdit: "wiki_edit",
} as const;

export type PlayTestFeedbackEventKind =
  (typeof playTestFeedbackEventKindValues)[keyof typeof playTestFeedbackEventKindValues];

export const playTestFeedbackBatchSelectionKindValues = {
  individual: "individual",
  batch: "batch",
} as const;

export type PlayTestFeedbackBatchSelectionKind =
  (typeof playTestFeedbackBatchSelectionKindValues)[keyof typeof playTestFeedbackBatchSelectionKindValues];

export const localizationPatchVersionOriginValues = {
  runFinalizer: "run_finalizer",
  playTesterEdit: "play_tester_edit",
  refinementRun: "refinement_run",
} as const;
export type LocalizationPatchVersionOrigin =
  (typeof localizationPatchVersionOriginValues)[keyof typeof localizationPatchVersionOriginValues];

/** Immutable target text retained independently of the retired journal. */
