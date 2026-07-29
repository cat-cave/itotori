import { randomBytes } from "node:crypto";
import {
  type JobEventType,
  type JobIdempotencyPolicy,
  type JobStatus,
  type JobTaskType,
  type OutboxEventType,
  type OutboxStatus,
} from "../schema.js";
import {
  DEFAULT_JOB_EVENT_RETENTION_DAYS,
  type JobEventRecord,
  type JobQueueRecord,
  type OutboxEventRecord,
  type QueueErrorRecord,
  type QueueJsonRecord,
  type QueueStatusCount,
} from "./event-queue-repository-types.js";

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

export function jobFromRow(row: Record<string, unknown>): JobQueueRecord {
  return {
    jobId: rowString(row, "job_id"),
    projectId: rowString(row, "project_id"),
    localeBranchId: nullableRowString(row, "locale_branch_id"),
    sourceEventId: nullableRowString(row, "source_event_id"),
    triggerOutboxEventId: nullableRowString(row, "trigger_outbox_event_id"),
    jobType: rowString(row, "job_type") as JobTaskType,
    jobName: rowString(row, "job_name"),
    queueName: rowString(row, "queue_name"),
    status: rowString(row, "status") as JobStatus,
    idempotencyPolicy: rowString(row, "idempotency_policy") as JobIdempotencyPolicy,
    idempotencyKey: nullableRowString(row, "idempotency_key"),
    correlationId: rowString(row, "correlation_id"),
    causationId: nullableRowString(row, "causation_id"),
    subjectRefs: rowArray(row, "subject_refs"),
    dependsOnJobIds: rowArray(row, "depends_on_job_ids") as string[],
    payload: rowJsonRecord(row, "payload"),
    priority: rowNumber(row, "priority"),
    availableAt: rowDate(row, "available_at"),
    attemptCount: rowNumber(row, "attempt_count"),
    maxAttempts: rowNumber(row, "max_attempts"),
    lockedBy: nullableRowString(row, "locked_by"),
    lockedAt: nullableRowDate(row, "locked_at"),
    leaseExpiresAt: nullableRowDate(row, "lease_expires_at"),
    completedAt: nullableRowDate(row, "completed_at"),
    lastError: nullableRowString(row, "last_error"),
    errorHistory: rowArray(row, "error_history") as QueueErrorRecord[],
    result: nullableRowJsonRecord(row, "result"),
    createdAt: rowDate(row, "created_at"),
    updatedAt: rowDate(row, "updated_at"),
  };
}

export function jobEventFromRow(row: Record<string, unknown>): JobEventRecord {
  return {
    jobEventId: rowString(row, "job_event_id"),
    jobId: rowString(row, "job_id"),
    projectId: rowString(row, "project_id"),
    localeBranchId: nullableRowString(row, "locale_branch_id"),
    queueName: rowString(row, "queue_name"),
    eventType: rowString(row, "event_type") as JobEventType,
    priorStatus: nullableRowString(row, "prior_status") as JobStatus | null,
    nextStatus: rowString(row, "next_status") as JobStatus,
    attemptCount: rowNumber(row, "attempt_count"),
    workerId: nullableRowString(row, "worker_id"),
    correlationId: rowString(row, "correlation_id"),
    detail: rowJsonRecord(row, "detail"),
    recordedAt: rowDate(row, "recorded_at"),
  };
}

export function createUuid7(date = new Date()): string {
  const timestamp = BigInt(date.getTime());
  const bytes = randomBytes(16);
  bytes[0] = Number((timestamp >> 40n) & 0xffn);
  bytes[1] = Number((timestamp >> 32n) & 0xffn);
  bytes[2] = Number((timestamp >> 24n) & 0xffn);
  bytes[3] = Number((timestamp >> 16n) & 0xffn);
  bytes[4] = Number((timestamp >> 8n) & 0xffn);
  bytes[5] = Number(timestamp & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function rowString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`expected ${key} to be a string`);
  }
  return value;
}

export function nullableRowString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`expected ${key} to be a string or null`);
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

export function nullableRowDate(row: Record<string, unknown>, key: string): Date | null {
  const value = row[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === "string") {
    return new Date(value);
  }
  throw new Error(`expected ${key} to be a date or null`);
}

export function rowNumber(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return Number(value);
  }
  throw new Error(`expected ${key} to be a number`);
}

function rowJsonRecord(row: Record<string, unknown>, key: string): QueueJsonRecord {
  const value = parseJsonValue(row[key]);
  if (!isJsonRecord(value)) {
    throw new Error(`expected ${key} to be a JSON object`);
  }
  return value;
}

function nullableRowJsonRecord(row: Record<string, unknown>, key: string): QueueJsonRecord | null {
  const value = row[key];
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = parseJsonValue(value);
  if (!isJsonRecord(parsed)) {
    throw new Error(`expected ${key} to be a JSON object or null`);
  }
  return parsed;
}

function rowArray(row: Record<string, unknown>, key: string): unknown[] {
  const value = parseJsonValue(row[key]);
  if (!Array.isArray(value)) {
    throw new Error(`expected ${key} to be a JSON array`);
  }
  return value;
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value === "string") {
    return JSON.parse(value);
  }
  return value;
}

function isJsonRecord(value: unknown): value is QueueJsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeLimit(value: number | undefined): number {
  if (value === undefined) {
    return 10;
  }
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error("queue claim limit must be an integer from 1 through 100");
  }
  return value;
}

export function normalizeLeaseSeconds(value: number | undefined): number {
  if (value === undefined) {
    return 60;
  }
  if (!Number.isFinite(value) || value < 0 || value > 3600) {
    throw new Error("queue lease seconds must be from 0 through 3600");
  }
  return value;
}

export function normalizeRetryAfterSeconds(value: number | undefined): number {
  if (value === undefined) {
    return 60;
  }
  if (!Number.isFinite(value) || value < 0 || value > 86400) {
    throw new Error("queue retry seconds must be from 0 through 86400");
  }
  return value;
}

export function normalizeRetentionDays(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_JOB_EVENT_RETENTION_DAYS;
  }
  if (!Number.isFinite(value) || value < 0 || value > 36500) {
    throw new Error("job event retention days must be from 0 through 36500");
  }
  return value;
}

export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 4096 ? message.slice(0, 4096) : message;
}

export async function singleRow(
  rowsPromise: Promise<Array<Record<string, unknown>>>,
  label: string,
): Promise<Record<string, unknown>> {
  const rows = await rowsPromise;
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`expected ${label} to return exactly one row`);
  }
  return row;
}

/**
 * Deterministic lag in seconds between the read-model's `generatedAt` and
 * the oldest un-processed timestamp. Returns null when there is nothing
 * pending (no oldest timestamp). Computed from a fixed `generatedAt` rather
 * than a moving DB `now()` so the metric is stable and testable; clamped at
 * 0 so a tiny app/DB clock skew can never report negative lag.
 */
export function lagSeconds(generatedAt: Date, oldestUnprocessedAt: Date | null): number | null {
  if (oldestUnprocessedAt === null) {
    return null;
  }
  const seconds = (generatedAt.getTime() - oldestUnprocessedAt.getTime()) / 1000;
  return Math.round(Math.max(0, seconds) * 1000) / 1000;
}

/**
 * Fold the per-status group-by rows into a STABLE breakdown that always
 * lists every known status (missing statuses default to 0), so a consumer
 * never has to defensively branch on an absent status. Statuses appear in
 * the enum's declaration order for deterministic serialization.
 */
export function mergeStatusCounts(
  knownStatuses: readonly string[],
  statusRows: Array<Record<string, unknown>>,
): QueueStatusCount[] {
  const countsByStatus = new Map<string, number>();
  for (const row of statusRows) {
    countsByStatus.set(rowString(row, "status"), rowNumber(row, "count"));
  }
  return knownStatuses.map((status) => ({
    status,
    count: countsByStatus.get(status) ?? 0,
  }));
}

export function normalizeDeadLetterLimit(value: number | undefined): number {
  if (value === undefined) {
    return 50;
  }
  if (!Number.isInteger(value) || value < 1 || value > 200) {
    throw new Error("queue health dead-letter limit must be an integer from 1 through 200");
  }
  return value;
}
