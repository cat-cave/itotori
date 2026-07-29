import { eq, sql } from "drizzle-orm";
import type { ItotoriDatabase } from "../connection.js";
import {
  localeBranches,
  sourceBundles,
  sourceRevisions,
  styleGuides,
  styleGuideVersions,
  type OutboxEventType,
  type OutboxStatus,
  type StyleGuideVersionStatus,
} from "../schema.js";
import type {
  LocaleBranchStyleGuideContext,
  SourceRevisionReference,
  StyleGuideRecord,
  StyleGuideVersionRecord,
} from "./style-guide-repository-contracts.js";
import type { OutboxEventRecord, QueueErrorRecord } from "./event-queue-repository.js";

type StyleGuideRow = typeof styleGuides.$inferSelect;
type StyleGuideVersionRow = typeof styleGuideVersions.$inferSelect;
type SourceRevisionRow = typeof sourceRevisions.$inferSelect;
export type StyleGuideDb = Pick<ItotoriDatabase, "select" | "execute" | "insert" | "update">;

export function styleGuideFromRow(row: StyleGuideRow): StyleGuideRecord {
  return {
    styleGuideId: row.styleGuideId,
    projectId: row.projectId,
    localeBranchId: row.localeBranchId,
    latestVersionId: row.latestVersionId,
    approvedVersionId: row.approvedVersionId,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getLocaleBranchContextInTx(
  db: StyleGuideDb,
  projectId: string,
  localeBranchId: string,
): Promise<LocaleBranchStyleGuideContext | null> {
  const rows = await db
    .select({
      projectId: localeBranches.projectId,
      localeBranchId: localeBranches.localeBranchId,
      targetLocale: localeBranches.targetLocale,
      sourceBundleId: localeBranches.sourceBundleId,
      sourceRevisionId: sourceRevisions.sourceRevisionId,
      revisionKind: sourceRevisions.revisionKind,
      value: sourceRevisions.value,
    })
    .from(localeBranches)
    .innerJoin(sourceBundles, eq(sourceBundles.sourceBundleId, localeBranches.sourceBundleId))
    .innerJoin(
      sourceRevisions,
      eq(sourceRevisions.sourceRevisionId, sourceBundles.sourceBundleRevisionId),
    )
    .where(
      sql`${localeBranches.projectId} = ${projectId} and ${localeBranches.localeBranchId} = ${localeBranchId}`,
    )
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  return {
    projectId: row.projectId,
    localeBranchId: row.localeBranchId,
    targetLocale: row.targetLocale,
    sourceBundleId: row.sourceBundleId,
    sourceRevisionReference: {
      sourceRevisionId: row.sourceRevisionId,
      revisionKind: row.revisionKind,
      value: row.value,
    },
  };
}

export async function getSourceRevisionInTx(
  db: StyleGuideDb,
  projectId: string,
  sourceRevisionId: string,
): Promise<SourceRevisionReference | null> {
  const rows = await db
    .select()
    .from(sourceRevisions)
    .where(
      sql`${sourceRevisions.projectId} = ${projectId} and ${sourceRevisions.sourceRevisionId} = ${sourceRevisionId}`,
    )
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  return {
    sourceRevisionId: row.sourceRevisionId,
    revisionKind: row.revisionKind,
    value: row.value,
  };
}

export async function getVersionByIdInTx(
  db: StyleGuideDb,
  styleGuideVersionId: string,
): Promise<StyleGuideVersionRecord | null> {
  const rows = await db
    .select({
      version: styleGuideVersions,
      sourceRevision: sourceRevisions,
    })
    .from(styleGuideVersions)
    .innerJoin(
      sourceRevisions,
      eq(sourceRevisions.sourceRevisionId, styleGuideVersions.sourceRevisionId),
    )
    .where(eq(styleGuideVersions.styleGuideVersionId, styleGuideVersionId))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : versionFromJoinedRow(row.version, row.sourceRevision);
}

export function versionFromJoinedRow(
  row: StyleGuideVersionRow,
  sourceRevision: SourceRevisionRow,
): StyleGuideVersionRecord {
  return {
    styleGuideVersionId: row.styleGuideVersionId,
    styleGuideId: row.styleGuideId,
    projectId: row.projectId,
    localeBranchId: row.localeBranchId,
    previousVersionId: row.previousVersionId,
    sourceRevisionReference: {
      sourceRevisionId: sourceRevision.sourceRevisionId,
      revisionKind: sourceRevision.revisionKind,
      value: sourceRevision.value,
    },
    versionSequence: row.versionSequence,
    authorUserId: row.authorUserId,
    approverUserId: row.approverUserId,
    status: row.status as StyleGuideVersionStatus,
    contentHash: row.contentHash,
    policy: row.policy,
    semanticDiagnostics: row.semanticDiagnostics,
    approvedAt: row.approvedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function outboxEventFromRow(row: Record<string, unknown>): OutboxEventRecord {
  return {
    outboxEventId: rowString(row, "outbox_event_id"),
    projectId: rowString(row, "project_id"),
    localeBranchId: nullableRowString(row, "locale_branch_id"),
    sourceEventId: nullableRowString(row, "source_event_id"),
    eventType: rowString(row, "event_type") as OutboxEventType,
    status: rowString(row, "status") as OutboxStatus,
    idempotencyKey: rowString(row, "idempotency_key"),
    correlationId: rowString(row, "correlation_id"),
    causationId: nullableRowString(row, "causation_id"),
    payload: rowJsonRecord(row, "payload"),
    availableAt: rowDate(row, "available_at"),
    attemptCount: rowNumber(row, "attempt_count"),
    maxAttempts: rowNumber(row, "max_attempts"),
    lockedBy: nullableRowString(row, "locked_by"),
    lockedAt: nullableRowDate(row, "locked_at"),
    leaseExpiresAt: nullableRowDate(row, "lease_expires_at"),
    publishedAt: nullableRowDate(row, "published_at"),
    lastError: nullableRowString(row, "last_error"),
    errorHistory: rowArray(row, "error_history") as QueueErrorRecord[],
    createdAt: rowDate(row, "created_at"),
    updatedAt: rowDate(row, "updated_at"),
  };
}

export function rowNumber(row: Record<string, unknown> | undefined, key: string): number {
  if (row === undefined) {
    return 0;
  }
  const value = row[key];
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return Number.parseInt(value, 10);
  }
  return 0;
}

function rowString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`expected ${key} to be a string`);
  }
  return value;
}

function nullableRowString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`expected ${key} to be a nullable string`);
  }
  return value;
}

function rowDate(row: Record<string, unknown>, key: string): Date {
  const value = row[key];
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === "string") {
    return new Date(value);
  }
  throw new Error(`expected ${key} to be a date`);
}

function nullableRowDate(row: Record<string, unknown>, key: string): Date | null {
  const value = row[key];
  if (value === null || value === undefined) {
    return null;
  }
  return rowDate(row, key);
}

function rowJsonRecord(row: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = row[key];
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(`expected ${key} to be a JSON object`);
}

function rowArray(row: Record<string, unknown>, key: string): unknown[] {
  const value = row[key];
  if (Array.isArray(value)) {
    return value;
  }
  throw new Error(`expected ${key} to be an array`);
}
