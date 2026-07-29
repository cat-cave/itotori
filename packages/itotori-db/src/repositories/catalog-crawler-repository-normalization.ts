import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { ItotoriDatabase } from "../connection.js";
import {
  catalogCrawlerCheckpoints,
  catalogCrawlerJobs,
  catalogCrawlerJobStatusValues,
  catalogCrawlerJobSteps,
  catalogCrawlerRateLimits,
  catalogSourceRecordKindValues,
  type CatalogCrawlerJobStatus,
  type CatalogCrawlerStepStatus,
  type CatalogSource,
  type CatalogSourceRecordKind,
} from "../schema.js";
import { createUuid7 } from "./event-queue-repository.js";
import type {
  CatalogCrawlerCheckpointInput,
  CatalogCrawlerCheckpointRecord,
  CatalogCrawlerCursor,
  CatalogCrawlerDateInput,
  CatalogCrawlerJobInput,
  CatalogCrawlerJobRecord,
  CatalogCrawlerJsonRecord,
  CatalogCrawlerKey,
  CatalogCrawlerRateLimitInput,
  CatalogCrawlerRateLimitRecord,
  CatalogCrawlerStepInput,
  CatalogCrawlerStepRecord,
} from "./catalog-crawler-repository.js";

type NormalizedCrawlerJobInput = Required<Omit<CatalogCrawlerJobInput, "leaseSeconds">>;
type NormalizedCrawlerCheckpointInput = Required<CatalogCrawlerKey> & {
  checkpointCursor: CatalogCrawlerCursor;
  sourceVersion: string;
  parserVersion: string;
  lastCrawlerJobId: string | null;
  lastStepKey: string | null;
  metadata: CatalogCrawlerJsonRecord;
};

type NormalizedCrawlerStepInput = {
  crawlerJobId: string;
  crawlerJobStepId: string;
  stepKey: string;
  catalogSource: CatalogSource;
  adapterName: string;
  adapterVersion: string;
  partitionKey: string;
  sourceId: string;
  requestIdentity: string;
  sourceVersion: string;
  parserVersion: string;
  checkpointCursor: CatalogCrawlerCursor;
  fetchedAt: Date;
  httpStatus: number | null;
  ok: boolean;
  payload: CatalogCrawlerJsonRecord;
  payloadHash: string;
  metadata: CatalogCrawlerJsonRecord;
  sourceRecordKind: CatalogSourceRecordKind;
};

export function normalizeCrawlerKey(input: CatalogCrawlerKey): Required<CatalogCrawlerKey> {
  return {
    catalogSource: input.catalogSource,
    adapterName: requiredString(input.adapterName, "adapterName"),
    partitionKey: input.partitionKey ?? "default",
  };
}

export function normalizeCrawlerJobInput(input: CatalogCrawlerJobInput): NormalizedCrawlerJobInput {
  const key = normalizeCrawlerKey(input);
  return {
    ...key,
    crawlerJobId: input.crawlerJobId ?? createUuid7(),
    adapterVersion: requiredString(input.adapterVersion, "adapterVersion"),
    sourceVersion: requiredString(input.sourceVersion, "sourceVersion"),
    parserVersion: requiredString(input.parserVersion, "parserVersion"),
    checkpointCursor: input.checkpointCursor ?? null,
    metadata: jsonRecord(input.metadata ?? {}, "metadata"),
  };
}

export function normalizeCrawlerCheckpointInput(
  input: CatalogCrawlerCheckpointInput,
): NormalizedCrawlerCheckpointInput {
  const key = normalizeCrawlerKey(input);
  return {
    ...key,
    checkpointCursor: input.checkpointCursor ?? null,
    sourceVersion: requiredString(input.sourceVersion, "sourceVersion"),
    parserVersion: requiredString(input.parserVersion, "parserVersion"),
    lastCrawlerJobId: input.lastCrawlerJobId ?? null,
    lastStepKey: input.lastStepKey ?? null,
    metadata: jsonRecord(input.metadata ?? {}, "metadata"),
  };
}

export function normalizeCrawlerRateLimitInput(
  input: CatalogCrawlerRateLimitInput,
): Required<CatalogCrawlerKey> & {
  nextAvailableAt: Date | null;
  resetAt: Date | null;
  remaining: number | null;
  limit: number | null;
  retryAfterSeconds: number | null;
  requestIdentity: string | null;
  metadata: CatalogCrawlerJsonRecord;
} {
  const key = normalizeCrawlerKey(input);
  return {
    ...key,
    nextAvailableAt: input.nextAvailableAt === undefined ? null : dateInput(input.nextAvailableAt),
    resetAt: input.resetAt === undefined ? null : dateInput(input.resetAt),
    remaining: optionalNonnegativeInteger(input.remaining, "remaining"),
    limit: optionalNonnegativeInteger(input.limit, "limit"),
    retryAfterSeconds: optionalNonnegativeInteger(input.retryAfterSeconds, "retryAfterSeconds"),
    requestIdentity:
      input.requestIdentity === undefined
        ? null
        : requiredString(input.requestIdentity, "requestIdentity"),
    metadata: jsonRecord(input.metadata ?? {}, "metadata"),
  };
}

export function normalizeCrawlerStepInput(
  input: CatalogCrawlerStepInput,
): NormalizedCrawlerStepInput {
  const httpStatus = input.httpStatus ?? null;
  if (
    httpStatus !== null &&
    (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599)
  ) {
    throw new Error("httpStatus must be a valid HTTP status code");
  }
  const payload = jsonRecord(input.payload, "payload");
  const payloadHash = input.payloadHash ?? hashJson(payload);
  if (!payloadHash.startsWith("sha256:")) {
    throw new Error("payloadHash must start with sha256:");
  }
  const stepKey = requiredString(input.stepKey, "stepKey");
  const crawlerJobId = requiredString(input.crawlerJobId, "crawlerJobId");
  const sourceRecordKind = input.sourceRecordKind ?? catalogSourceRecordKindValues.rawCache;
  if (
    sourceRecordKind !== catalogSourceRecordKindValues.rawCache &&
    sourceRecordKind !== catalogSourceRecordKindValues.recordedFixture
  ) {
    throw new Error(
      `crawler step sourceRecordKind must be ${catalogSourceRecordKindValues.rawCache} (live crawl) or ${catalogSourceRecordKindValues.recordedFixture} (fixture replay)`,
    );
  }
  return {
    crawlerJobId,
    crawlerJobStepId:
      input.crawlerJobStepId ?? stableId("catalog-crawler-step", [crawlerJobId, stepKey]),
    stepKey,
    catalogSource: input.catalogSource,
    adapterName: requiredString(input.adapterName, "adapterName"),
    adapterVersion: requiredString(input.adapterVersion, "adapterVersion"),
    partitionKey: input.partitionKey ?? "default",
    sourceId: requiredString(input.sourceId, "sourceId"),
    requestIdentity: requiredString(input.requestIdentity, "requestIdentity"),
    sourceVersion: requiredString(input.sourceVersion, "sourceVersion"),
    parserVersion: requiredString(input.parserVersion, "parserVersion"),
    checkpointCursor: input.checkpointCursor ?? null,
    fetchedAt: dateInput(input.fetchedAt),
    httpStatus,
    ok: input.ok ?? true,
    payload,
    payloadHash,
    metadata: jsonRecord(input.metadata ?? {}, "metadata"),
    sourceRecordKind,
  };
}

export function jobFromRow(row: typeof catalogCrawlerJobs.$inferSelect): CatalogCrawlerJobRecord {
  return {
    crawlerJobId: row.crawlerJobId,
    catalogSource: row.catalogSource as CatalogSource,
    adapterName: row.adapterName,
    adapterVersion: row.adapterVersion,
    sourceVersion: row.sourceVersion,
    parserVersion: row.parserVersion,
    partitionKey: row.partitionKey,
    status: row.status as CatalogCrawlerJobStatus,
    checkpointCursor: row.checkpointCursor ?? null,
    lockedBy: row.lockedBy,
    leaseExpiresAt: row.leaseExpiresAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    lastError: row.lastError,
    metadata: row.metadata,
    updatedAt: row.updatedAt,
  };
}

export function checkpointFromRow(
  row: typeof catalogCrawlerCheckpoints.$inferSelect,
): CatalogCrawlerCheckpointRecord {
  return {
    catalogSource: row.catalogSource as CatalogSource,
    adapterName: row.adapterName,
    partitionKey: row.partitionKey,
    checkpointCursor: row.checkpointCursor ?? null,
    sourceVersion: row.sourceVersion,
    parserVersion: row.parserVersion,
    lastCrawlerJobId: row.lastCrawlerJobId,
    lastStepKey: row.lastStepKey,
    updatedAt: row.updatedAt,
    metadata: row.metadata,
  };
}

export function rateLimitFromRow(
  row: typeof catalogCrawlerRateLimits.$inferSelect,
): CatalogCrawlerRateLimitRecord {
  return {
    catalogSource: row.catalogSource as CatalogSource,
    adapterName: row.adapterName,
    partitionKey: row.partitionKey,
    nextAvailableAt: row.nextAvailableAt,
    resetAt: row.resetAt,
    remaining: row.remaining,
    limit: row.limit,
    retryAfterSeconds: row.retryAfterSeconds,
    requestIdentity: row.requestIdentity,
    metadata: row.metadata,
    updatedAt: row.updatedAt,
  };
}

export function stepFromRow(
  row: typeof catalogCrawlerJobSteps.$inferSelect,
): CatalogCrawlerStepRecord {
  return {
    crawlerJobStepId: row.crawlerJobStepId,
    crawlerJobId: row.crawlerJobId,
    stepKey: row.stepKey,
    catalogSource: row.catalogSource as CatalogSource,
    adapterName: row.adapterName,
    partitionKey: row.partitionKey,
    sourceId: row.sourceId,
    requestIdentity: row.requestIdentity,
    sourceVersion: row.sourceVersion,
    parserVersion: row.parserVersion,
    checkpointCursor: row.checkpointCursor ?? null,
    fetchedAt: row.fetchedAt,
    httpStatus: row.httpStatus,
    ok: row.ok,
    payloadHash: row.payloadHash,
    sourceProvenanceId: row.sourceProvenanceId,
    status: row.status as CatalogCrawlerStepStatus,
    importedAt: row.importedAt,
    error: row.error,
    metadata: row.metadata,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function requiredString(input: string | undefined, name: string): string {
  if (typeof input !== "string" || input.trim().length === 0)
    throw new Error(`${name} is required`);
  return input;
}

export function requiredRow<T>(rows: T[], id: string): T {
  const row = rows[0];
  if (row === undefined) throw new Error(`expected row for ${id}`);
  return row;
}

export async function assertActiveCrawlerJob(
  db: ItotoriDatabase,
  crawlerJobId: string,
  workerId: string,
): Promise<void> {
  const rows = await db
    .select({ crawlerJobId: catalogCrawlerJobs.crawlerJobId })
    .from(catalogCrawlerJobs)
    .where(activeCrawlerJobPredicate(crawlerJobId, workerId))
    .limit(1);
  requiredActiveCrawlerJob(rows, crawlerJobId);
}

export function activeCrawlerJobPredicate(crawlerJobId: string, workerId: string) {
  return and(
    eq(catalogCrawlerJobs.crawlerJobId, requiredString(crawlerJobId, "crawlerJobId")),
    eq(catalogCrawlerJobs.lockedBy, requiredString(workerId, "workerId")),
    eq(catalogCrawlerJobs.status, catalogCrawlerJobStatusValues.running),
    sql`${catalogCrawlerJobs.leaseExpiresAt} > now()`,
  );
}

export function requiredActiveCrawlerJob<T>(rows: T[], crawlerJobId: string): void {
  if (rows[0] === undefined)
    throw new Error(`crawler job ${crawlerJobId} does not have an active lease for this worker`);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function dateInput(input: CatalogCrawlerDateInput): Date {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) throw new Error("date input must be valid");
  return date;
}

function optionalNonnegativeInteger(input: number | undefined, name: string): number | null {
  if (input === undefined) return null;
  if (!Number.isInteger(input) || input < 0)
    throw new Error(`${name} must be a nonnegative integer`);
  return input;
}

function jsonRecord(input: unknown, name: string): CatalogCrawlerJsonRecord {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new Error(`${name} must be a JSON object`);
  return input as CatalogCrawlerJsonRecord;
}

function hashJson(input: unknown): string {
  return `sha256:${createHash("sha256").update(stableJsonStringify(input)).digest("hex")}`;
}

export function stableId(prefix: string, parts: string[]): string {
  const hash = createHash("sha256").update(parts.join("\0")).digest("hex");
  return `${prefix}:${hash}`;
}

function stableJsonStringify(input: unknown): string {
  if (input === null || typeof input !== "object") return JSON.stringify(input);
  if (Array.isArray(input))
    return `[${input.map((value) => stableJsonStringify(value)).join(",")}]`;
  const record = input as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJsonStringify(record[key])}`)
    .join(",")}}`;
}
