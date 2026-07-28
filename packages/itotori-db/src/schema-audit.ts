import { foreignKey, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import {
  type AuditFindingSeverity,
  type AuditFindingStatus,
} from "./schema-capabilities-drafts.js";

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
