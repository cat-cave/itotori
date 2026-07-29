import {
  bigint as pgBigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
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
import type { Permission } from "./authorization.js";

import { type AuditFindingSeverity } from "./schema-19.js";

export const auditFindingStatusValues = {
  open: "open",
  superseded: "superseded",
  fixed: "fixed",
  wontfix: "wontfix",
  duplicate: "duplicate",
} as const;

export type AuditFindingStatus =
  (typeof auditFindingStatusValues)[keyof typeof auditFindingStatusValues];

/**
 * Shape of an audit-finding row as it appears in the DB. The dashboard
 * read model and the bootstrap script both consume this shape directly;
 * the repository class wraps it with auth + invariants.
 */
export type AuditFindingRecord = {
  auditFindingId: string;
  auditReportId: string;
  nodeId: string;
  severity: AuditFindingSeverity;
  category: string;
  summary: string;
  detail: string | null;
  fileRef: string | null;
  proposedDagNode: string | null;
  status: AuditFindingStatus;
  supersededByFindingId: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
};

export const auditFindings = pgTable(
  "itotori_audit_findings",
  {
    auditFindingId: text("audit_finding_id").primaryKey(),
    auditReportId: text("audit_report_id").notNull(),
    nodeId: text("node_id").notNull(),
    severity: text("severity").$type<AuditFindingSeverity>().notNull(),
    category: text("category").notNull(),
    summary: text("summary").notNull(),
    detail: text("detail"),
    fileRef: text("file_ref"),
    proposedDagNode: text("proposed_dag_node"),
    status: text("status").$type<AuditFindingStatus>().notNull().default("open"),
    supersededByFindingId: text("superseded_by_finding_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.supersededByFindingId],
      foreignColumns: [table.auditFindingId],
      name: "itotori_audit_findings_superseded_by_fkey",
    }),
    index("itotori_audit_findings_node_status_severity_idx").on(
      table.nodeId,
      table.status,
      table.severity,
    ),
    index("itotori_audit_findings_report_idx").on(table.auditReportId),
    index("itotori_audit_findings_severity_status_idx").on(table.severity, table.status),
  ],
);

// ---------------------------------------------------------------------------
// auth-001-principal-schema — multi-user principal / account / permission-set
// identity layer.
//
// This EXTENDS the existing single-user substrate (`itotori_users` +
// `itotori_user_permission_grants` above, which `requirePermission` reads) with
// the organization / membership / identity / session / permission-set / audit
// layer a real multi-user auth service needs. The single-user substrate stays
// intact and working; nothing here replaces it.
//
// GOVERNING INVARIANT (docs/permissions.md): access control is PERMISSION-based,
// NEVER role-based. There is NO role column anywhere that authorization branches
// on. A "role" is ONLY a `permission_set` — a named, editable DATA bundle of
// permission rows granted to a principal. Effective permissions for a principal
// are the UNION of its direct permission grants and the permissions of every
// permission-set granted to it; authorization still resolves to an exact-match
// permission check, never to a role string.
//
// `principal_kind` below is an identity-TYPE discriminator (human user vs
// non-human service principal), NOT an authorization role: no authorization code
// branches on it. It exists only so a grant / session / audit row can reference
// either kind of principal through one supertype id.

/** Principal identity TYPE. NOT an authorization role — see the note above. */
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
