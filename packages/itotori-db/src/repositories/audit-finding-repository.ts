import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import type { ItotoriDatabase } from "../connection.js";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import {
  auditFindings,
  auditFindingSeverityValues,
  auditFindingStatusValues,
  type AuditFindingRecord,
  type AuditFindingSeverity,
  type AuditFindingStatus,
} from "../schema.js";

export const auditFindingSeverityList: ReadonlyArray<AuditFindingSeverity> = [
  auditFindingSeverityValues.p0,
  auditFindingSeverityValues.p1,
  auditFindingSeverityValues.p2,
  auditFindingSeverityValues.p3,
];

export const auditFindingStatusList: ReadonlyArray<AuditFindingStatus> = [
  auditFindingStatusValues.open,
  auditFindingStatusValues.superseded,
  auditFindingStatusValues.fixed,
  auditFindingStatusValues.wontfix,
  auditFindingStatusValues.duplicate,
];

export class AuditFindingRepositoryError extends Error {
  constructor(
    readonly code:
      | "audit_finding_not_found"
      | "audit_finding_invalid_input"
      | "audit_finding_not_open"
      | "audit_finding_supersede_chain_invalid",
    message: string,
  ) {
    super(message);
    this.name = "AuditFindingRepositoryError";
  }
}

export type RecordFindingInput = {
  auditReportId: string;
  nodeId: string;
  severity: AuditFindingSeverity;
  category: string;
  summary: string;
  detail?: string | null;
  fileRef?: string | null;
  proposedDagNode?: string | null;
  createdAt?: Date;
};

export type LoadFindingsByNodeOptions = {
  statusFilter?: AuditFindingStatus;
  severityFilter?: AuditFindingSeverity;
};

export type LoadOpenFindingsOptions = {
  severityFilter?: AuditFindingSeverity;
};

export interface ItotoriAuditFindingRepositoryPort {
  recordFinding(actor: AuthorizationActor, input: RecordFindingInput): Promise<AuditFindingRecord>;
  loadFindingsByNode(
    actor: AuthorizationActor,
    nodeId: string,
    opts?: LoadFindingsByNodeOptions,
  ): Promise<AuditFindingRecord[]>;
  loadFindingsByReport(
    actor: AuthorizationActor,
    auditReportId: string,
  ): Promise<AuditFindingRecord[]>;
  loadOpenFindings(
    actor: AuthorizationActor,
    opts?: LoadOpenFindingsOptions,
  ): Promise<AuditFindingRecord[]>;
  markFindingFixed(actor: AuthorizationActor, findingId: string, resolvedAt: Date): Promise<void>;
  markFindingSuperseded(
    actor: AuthorizationActor,
    oldFindingId: string,
    newFindingId: string,
    resolvedAt: Date,
  ): Promise<void>;
}

export class ItotoriAuditFindingRepository implements ItotoriAuditFindingRepositoryPort {
  constructor(private readonly db: ItotoriDatabase) {}

  async recordFinding(
    actor: AuthorizationActor,
    input: RecordFindingInput,
  ): Promise<AuditFindingRecord> {
    await requirePermission(this.db, actor, permissionValues.auditWrite);
    assertRecordInput(input);

    const auditFindingId = `audit-finding-${randomUUID()}`;
    const createdAt = input.createdAt ?? new Date();

    await this.db.insert(auditFindings).values({
      auditFindingId,
      auditReportId: input.auditReportId,
      nodeId: input.nodeId,
      severity: input.severity,
      category: input.category,
      summary: input.summary,
      detail: input.detail ?? null,
      fileRef: input.fileRef ?? null,
      proposedDagNode: input.proposedDagNode ?? null,
      status: auditFindingStatusValues.open,
      createdAt,
    });

    const persisted = await this.fetchById(auditFindingId);
    if (persisted === null) {
      throw new AuditFindingRepositoryError(
        "audit_finding_not_found",
        `failed to load audit finding ${auditFindingId} after insert`,
      );
    }
    return persisted;
  }

  async loadFindingsByNode(
    actor: AuthorizationActor,
    nodeId: string,
    opts?: LoadFindingsByNodeOptions,
  ): Promise<AuditFindingRecord[]> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);

    const conditions = [eq(auditFindings.nodeId, nodeId)];
    if (opts?.statusFilter !== undefined) {
      conditions.push(eq(auditFindings.status, opts.statusFilter));
    }
    if (opts?.severityFilter !== undefined) {
      conditions.push(eq(auditFindings.severity, opts.severityFilter));
    }
    const rows = await this.db
      .select()
      .from(auditFindings)
      .where(and(...conditions))
      .orderBy(asc(auditFindings.severity), desc(auditFindings.createdAt));
    return rows.map(rowToRecord);
  }

  async loadFindingsByReport(
    actor: AuthorizationActor,
    auditReportId: string,
  ): Promise<AuditFindingRecord[]> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);

    const rows = await this.db
      .select()
      .from(auditFindings)
      .where(eq(auditFindings.auditReportId, auditReportId))
      .orderBy(asc(auditFindings.severity), asc(auditFindings.nodeId));
    return rows.map(rowToRecord);
  }

  async loadOpenFindings(
    actor: AuthorizationActor,
    opts?: LoadOpenFindingsOptions,
  ): Promise<AuditFindingRecord[]> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);

    const conditions = [eq(auditFindings.status, auditFindingStatusValues.open)];
    if (opts?.severityFilter !== undefined) {
      conditions.push(eq(auditFindings.severity, opts.severityFilter));
    }
    const rows = await this.db
      .select()
      .from(auditFindings)
      .where(and(...conditions))
      .orderBy(asc(auditFindings.severity), asc(auditFindings.nodeId));
    return rows.map(rowToRecord);
  }

  async markFindingFixed(
    actor: AuthorizationActor,
    findingId: string,
    resolvedAt: Date,
  ): Promise<void> {
    await requirePermission(this.db, actor, permissionValues.auditWrite);

    await this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(auditFindings)
        .where(eq(auditFindings.auditFindingId, findingId))
        .limit(1);
      const existing = rows[0];
      if (existing === undefined) {
        throw new AuditFindingRepositoryError(
          "audit_finding_not_found",
          `audit finding ${findingId} not found`,
        );
      }
      if (existing.status !== auditFindingStatusValues.open) {
        throw new AuditFindingRepositoryError(
          "audit_finding_not_open",
          `cannot mark audit finding ${findingId} fixed from status ${existing.status}`,
        );
      }
      await tx
        .update(auditFindings)
        .set({ status: auditFindingStatusValues.fixed, resolvedAt })
        .where(eq(auditFindings.auditFindingId, findingId));
    });
  }

  async markFindingSuperseded(
    actor: AuthorizationActor,
    oldFindingId: string,
    newFindingId: string,
    resolvedAt: Date,
  ): Promise<void> {
    await requirePermission(this.db, actor, permissionValues.auditWrite);

    if (oldFindingId === newFindingId) {
      throw new AuditFindingRepositoryError(
        "audit_finding_supersede_chain_invalid",
        "an audit finding cannot supersede itself",
      );
    }

    await this.db.transaction(async (tx) => {
      const oldRows = await tx
        .select()
        .from(auditFindings)
        .where(eq(auditFindings.auditFindingId, oldFindingId))
        .limit(1);
      const oldRow = oldRows[0];
      if (oldRow === undefined) {
        throw new AuditFindingRepositoryError(
          "audit_finding_not_found",
          `audit finding ${oldFindingId} not found`,
        );
      }
      if (oldRow.status !== auditFindingStatusValues.open) {
        throw new AuditFindingRepositoryError(
          "audit_finding_not_open",
          `cannot supersede audit finding ${oldFindingId} from status ${oldRow.status}`,
        );
      }
      const newRows = await tx
        .select()
        .from(auditFindings)
        .where(eq(auditFindings.auditFindingId, newFindingId))
        .limit(1);
      const newRow = newRows[0];
      if (newRow === undefined) {
        throw new AuditFindingRepositoryError(
          "audit_finding_not_found",
          `successor audit finding ${newFindingId} not found`,
        );
      }
      if (newRow.status !== auditFindingStatusValues.open) {
        throw new AuditFindingRepositoryError(
          "audit_finding_supersede_chain_invalid",
          `successor audit finding ${newFindingId} must be open (was ${newRow.status})`,
        );
      }
      await tx
        .update(auditFindings)
        .set({
          status: auditFindingStatusValues.superseded,
          supersededByFindingId: newFindingId,
          resolvedAt,
        })
        .where(eq(auditFindings.auditFindingId, oldFindingId));
    });
  }

  private async fetchById(auditFindingId: string): Promise<AuditFindingRecord | null> {
    const rows = await this.db
      .select()
      .from(auditFindings)
      .where(eq(auditFindings.auditFindingId, auditFindingId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return rowToRecord(row);
  }
}

function assertRecordInput(input: RecordFindingInput): void {
  if (input.auditReportId.length === 0) {
    throw new AuditFindingRepositoryError(
      "audit_finding_invalid_input",
      "auditReportId must be non-empty",
    );
  }
  if (input.nodeId.length === 0) {
    throw new AuditFindingRepositoryError(
      "audit_finding_invalid_input",
      "nodeId must be non-empty",
    );
  }
  if (input.category.length === 0) {
    throw new AuditFindingRepositoryError(
      "audit_finding_invalid_input",
      "category must be non-empty",
    );
  }
  if (input.summary.length === 0) {
    throw new AuditFindingRepositoryError(
      "audit_finding_invalid_input",
      "summary must be non-empty",
    );
  }
  if (!auditFindingSeverityList.includes(input.severity)) {
    throw new AuditFindingRepositoryError(
      "audit_finding_invalid_input",
      `severity must be one of ${auditFindingSeverityList.join(", ")}`,
    );
  }
}

function rowToRecord(row: typeof auditFindings.$inferSelect): AuditFindingRecord {
  return {
    auditFindingId: row.auditFindingId,
    auditReportId: row.auditReportId,
    nodeId: row.nodeId,
    severity: row.severity,
    category: row.category,
    summary: row.summary,
    detail: row.detail,
    fileRef: row.fileRef,
    proposedDagNode: row.proposedDagNode,
    status: row.status,
    supersededByFindingId: row.supersededByFindingId,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
  };
}

export { auditFindingSeverityValues, auditFindingStatusValues };
