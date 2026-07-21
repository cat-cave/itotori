import { sql, type SQL } from "drizzle-orm";
import {
  projectRunCostAccounts,
  projectRunCostReservations,
  projectRunProgressStatusValues,
  projectRunStatusValues,
  projectRuns,
  type ProjectRunProgressStatus,
  type ProjectRunStatus,
} from "../schema.js";
import type {
  CreateProjectRunInput,
  ProjectRunCostReservationRecord,
  ProjectRunLease,
  ProjectRunLeaseFence,
  ProjectRunProgressRecord,
  ProjectRunRecord,
} from "./project-run-repository.js";

export type SqlExecutor = { execute(query: SQL): Promise<{ rows: unknown[] }> };
export type Row = Record<string, unknown>;

export class ItotoriProjectRunRepositoryError extends Error {
  constructor(
    readonly code:
      | "cost_cap_exceeded"
      | "fence_rejected"
      | "lease_unavailable"
      | "progress_regression"
      | "run_transition_rejected"
      | "unknown_run",
    message: string,
  ) {
    super(message);
    this.name = "ItotoriProjectRunRepositoryError";
  }
}

export async function requireCurrentLease(
  executor: SqlExecutor,
  lease: ProjectRunLeaseFence,
): Promise<Row> {
  const rows = await rowsOf(
    executor,
    sql`
      select * from ${projectRuns}
      where run_id = ${lease.runId} and project_id = ${lease.projectId}
        and lease_owner_id = ${lease.leaseOwnerId} and fence_token = ${lease.fenceToken}
        and lease_expires_at > now()
      for update
    `,
  );
  if (rows[0] === undefined) throw fenceRejected();
  return rows[0];
}

export async function loadRun(
  executor: SqlExecutor,
  projectId: string,
  runId: string,
): Promise<ProjectRunRecord> {
  const found = await loadRunOrNull(executor, projectId, runId);
  if (found === null)
    throw new ItotoriProjectRunRepositoryError("unknown_run", "project run was not found");
  return found;
}

export async function loadRunOrNull(
  executor: SqlExecutor,
  projectId: string,
  runId: string,
): Promise<ProjectRunRecord | null> {
  const rows = await rowsOf(
    executor,
    sql`
      select run.*, account.cap_micros_usd, account.spent_micros_usd, account.reserved_micros_usd
      from ${projectRuns} run
      join ${projectRunCostAccounts} account
        on account.run_id = run.run_id and account.project_id = run.project_id
      where run.run_id = ${runId} and run.project_id = ${projectId}
    `,
  );
  return rows[0] === undefined ? null : runFromRow(rows[0]);
}

type ReservationRow = Row & {
  runId: string;
  projectId: string;
  reservedMicrosUsd: number;
  settledMicrosUsd: number | null;
  state: string;
};

export async function reservationById(
  executor: SqlExecutor,
  runId: string,
  reservationId: string,
  lock = false,
): Promise<ReservationRow | null> {
  const lockClause = lock ? sql`for update` : sql``;
  const rows = await rowsOf(
    executor,
    sql`
      select * from ${projectRunCostReservations}
      where run_id = ${runId} and reservation_id = ${reservationId} ${lockClause}
    `,
  );
  if (rows[0] === undefined) return null;
  const row = rows[0];
  return {
    ...row,
    runId: textOf(row, "run_id"),
    projectId: textOf(row, "project_id"),
    reservedMicrosUsd: numberOf(row, "reserved_micros_usd"),
    settledMicrosUsd: nullableNumberOf(row, "settled_micros_usd"),
    state: textOf(row, "state"),
  };
}

export function runFromRow(row: Row): ProjectRunRecord {
  return {
    projectId: textOf(row, "project_id"),
    runId: textOf(row, "run_id"),
    localeBranchId: textOf(row, "locale_branch_id"),
    contextSnapshotId: textOf(row, "context_snapshot_id"),
    localizationSnapshotId: textOf(row, "localization_snapshot_id"),
    status: textOf(row, "status") as ProjectRunStatus,
    leaseOwnerId: nullableTextOf(row, "lease_owner_id"),
    leaseExpiresAt: nullableDateOf(row, "lease_expires_at"),
    fenceToken: numberOf(row, "fence_token"),
    createdAt: dateOf(row, "created_at"),
    updatedAt: dateOf(row, "updated_at"),
    cost: {
      capMicrosUsd: nullableNumberOf(row, "cap_micros_usd"),
      spentMicrosUsd: numberOf(row, "spent_micros_usd"),
      reservedMicrosUsd: numberOf(row, "reserved_micros_usd"),
    },
  };
}

export function progressFromRow(row: Row): ProjectRunProgressRecord {
  return {
    bridgeUnitId: textOf(row, "bridge_unit_id"),
    role: textOf(row, "role"),
    status: textOf(row, "status") as ProjectRunProgressStatus,
    costMicrosUsd: numberOf(row, "cost_micros_usd"),
    coveragePercent: numberOf(row, "coverage_percent"),
    blockers: asStrings(row.blockers),
    updatedAt: dateOf(row, "updated_at"),
  };
}

export function reservationFromRow(row: Row): ProjectRunCostReservationRecord {
  return {
    reservationId: textOf(row, "reservation_id"),
    reservedMicrosUsd: numberOf(row, "reserved_micros_usd"),
    settledMicrosUsd: nullableNumberOf(row, "settled_micros_usd"),
    state: textOf(row, "state") as "reserved" | "settled",
    createdAt: dateOf(row, "created_at"),
    settledAt: nullableDateOf(row, "settled_at"),
  };
}

export function leaseFromRow(row: Row): ProjectRunLease {
  const leaseExpiresAt = nullableDateOf(row, "lease_expires_at");
  if (leaseExpiresAt === null) throw new Error("lease row has no expiry");
  return {
    projectId: textOf(row, "project_id"),
    runId: textOf(row, "run_id"),
    leaseOwnerId: textOf(row, "lease_owner_id"),
    fenceToken: numberOf(row, "fence_token"),
    leaseExpiresAt,
  };
}

export function toReservation(row: ReservationRow): ProjectRunCostReservationRecord {
  return {
    reservationId: textOf(row, "reservation_id"),
    reservedMicrosUsd: row.reservedMicrosUsd,
    settledMicrosUsd: row.settledMicrosUsd,
    state: row.state as "reserved" | "settled",
    createdAt: dateOf(row, "created_at"),
    settledAt: nullableDateOf(row, "settled_at"),
  };
}

export function normalizeCreate(input: CreateProjectRunInput): CreateProjectRunInput {
  const normalized = {
    projectId: requiredText(input.projectId, "projectId"),
    runId: requiredText(input.runId, "runId"),
    localeBranchId: requiredText(input.localeBranchId, "localeBranchId"),
    contextSnapshotId: requiredText(input.contextSnapshotId, "contextSnapshotId"),
    localizationSnapshotId: requiredText(input.localizationSnapshotId, "localizationSnapshotId"),
    capMicrosUsd: input.capMicrosUsd,
  };
  if (normalized.capMicrosUsd !== null) assertMicros(normalized.capMicrosUsd, "capMicrosUsd");
  return normalized;
}

export function normalizeLease(input: ProjectRunLeaseFence): ProjectRunLeaseFence {
  const lease = {
    projectId: requiredText(input.projectId, "projectId"),
    runId: requiredText(input.runId, "runId"),
    leaseOwnerId: requiredText(input.leaseOwnerId, "leaseOwnerId"),
    fenceToken: input.fenceToken,
  };
  if (!Number.isSafeInteger(lease.fenceToken) || lease.fenceToken <= 0) {
    throw new Error("fenceToken must be a positive safe integer");
  }
  return lease;
}

export function canAdvance(from: string, to: ProjectRunStatus): boolean {
  if (from === to) return true;
  return (
    (from === "queued" && (to === "running" || to === "cancelled")) ||
    (from === "running" && ["paused", "completed", "failed", "cancelled"].includes(to)) ||
    (from === "paused" && (to === "running" || to === "cancelled"))
  );
}

export function progressRank(status: unknown): SQL {
  return sql`case ${status} when 'decoded' then 1 when 'drafted' then 2 when 'QA' then 3 when 'accepted' then 4 when 'patched' then 5 end`;
}

export function emptyStatusCounts(): Record<ProjectRunProgressStatus, number> {
  return { decoded: 0, drafted: 0, QA: 0, accepted: 0, patched: 0 };
}

export function rowsOf(executor: SqlExecutor, query: SQL): Promise<Row[]> {
  return executor.execute(query).then((result) => result.rows as Row[]);
}

export function fenceRejected(): ItotoriProjectRunRepositoryError {
  return new ItotoriProjectRunRepositoryError(
    "fence_rejected",
    "project run lease fence was rejected",
  );
}

export function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} is required`);
  return normalized;
}

export function assertMicros(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${label} must be non-negative micros`);
}

export function assertCoverage(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new Error("coveragePercent must be an integer from 0 through 100");
  }
}

export function assertRunStatus(value: string): asserts value is ProjectRunStatus {
  if (!Object.values(projectRunStatusValues).includes(value as ProjectRunStatus)) {
    throw new Error("project run status is invalid");
  }
}

export function assertProgressStatus(value: string): asserts value is ProjectRunProgressStatus {
  if (!Object.values(projectRunProgressStatusValues).includes(value as ProjectRunProgressStatus)) {
    throw new Error("project run progress status is invalid");
  }
}

export function leaseSeconds(value: number | undefined): number {
  const seconds = value ?? 60;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86_400) {
    throw new Error("leaseDurationSeconds must be an integer from 1 through 86400");
  }
  return seconds;
}

export function normalizeBlockers(value: readonly string[]): string[] {
  return value.map((blocker) => requiredText(blocker, "blocker"));
}

function textOf(row: Row, name: string): string {
  const value = row[name];
  if (typeof value !== "string") throw new Error(`database row ${name} is not text`);
  return value;
}

function nullableTextOf(row: Row, name: string): string | null {
  return row[name] === null ? null : textOf(row, name);
}

function numberOf(row: Row, name: string): number {
  const value = Number(row[name]);
  if (!Number.isSafeInteger(value)) throw new Error(`database row ${name} is not a safe integer`);
  return value;
}

function nullableNumberOf(row: Row, name: string): number | null {
  return row[name] === null ? null : numberOf(row, name);
}

function dateOf(row: Row, name: string): Date {
  const value = row[name];
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error(`database row ${name} is not a date`);
  return date;
}

function nullableDateOf(row: Row, name: string): Date | null {
  return row[name] === null ? null : dateOf(row, name);
}

function asStrings(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("database blockers are not a string array");
  }
  return value;
}
