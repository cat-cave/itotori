import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { ItotoriDatabase } from "../connection.js";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import {
  catalogCrawlerCheckpoints,
  catalogCrawlerJobs,
  catalogCrawlerJobStatusValues,
  catalogCrawlerJobSteps,
  catalogCrawlerRateLimits,
  catalogCrawlerStepStatusValues,
  catalogSourceProvenance,
  catalogSourceRecordKindValues,
  type CatalogCrawlerJobStatus,
  type CatalogCrawlerStepStatus,
  type CatalogSource,
} from "../schema.js";
import { createUuid7 } from "./event-queue-repository.js";

export type CatalogCrawlerJsonRecord = Record<string, unknown>;
export type CatalogCrawlerCursor = unknown | null;
export type CatalogCrawlerDateInput = string | Date;

export type CatalogCrawlerKey = {
  catalogSource: CatalogSource;
  adapterName: string;
  partitionKey?: string;
};

export type CatalogCrawlerJobInput = CatalogCrawlerKey & {
  crawlerJobId?: string;
  adapterVersion: string;
  sourceVersion: string;
  parserVersion: string;
  checkpointCursor?: CatalogCrawlerCursor;
  leaseSeconds?: number;
  metadata?: CatalogCrawlerJsonRecord;
};

export type CatalogCrawlerJobRecord = Required<CatalogCrawlerKey> & {
  crawlerJobId: string;
  adapterVersion: string;
  sourceVersion: string;
  parserVersion: string;
  status: CatalogCrawlerJobStatus;
  checkpointCursor: CatalogCrawlerCursor;
  lockedBy: string;
  leaseExpiresAt: Date;
  startedAt: Date;
  completedAt: Date | null;
  lastError: string | null;
  metadata: CatalogCrawlerJsonRecord;
  updatedAt: Date;
};

export type CatalogCrawlerCheckpointInput = Required<CatalogCrawlerKey> & {
  checkpointCursor: CatalogCrawlerCursor;
  sourceVersion: string;
  parserVersion: string;
  lastCrawlerJobId?: string;
  lastStepKey?: string;
  metadata?: CatalogCrawlerJsonRecord;
};

export type CatalogCrawlerCheckpointRecord = Required<CatalogCrawlerKey> & {
  checkpointCursor: CatalogCrawlerCursor;
  sourceVersion: string;
  parserVersion: string;
  lastCrawlerJobId: string | null;
  lastStepKey: string | null;
  updatedAt: Date;
  metadata: CatalogCrawlerJsonRecord;
};

export type CatalogCrawlerRateLimitInput = Required<CatalogCrawlerKey> & {
  nextAvailableAt?: CatalogCrawlerDateInput;
  resetAt?: CatalogCrawlerDateInput;
  remaining?: number;
  limit?: number;
  retryAfterSeconds?: number;
  requestIdentity?: string;
  metadata?: CatalogCrawlerJsonRecord;
};

export type CatalogCrawlerRateLimitRecord = Required<CatalogCrawlerKey> & {
  nextAvailableAt: Date | null;
  resetAt: Date | null;
  remaining: number | null;
  limit: number | null;
  retryAfterSeconds: number | null;
  requestIdentity: string | null;
  metadata: CatalogCrawlerJsonRecord;
  updatedAt: Date;
};

export type CatalogCrawlerStepInput = {
  crawlerJobId: string;
  crawlerJobStepId?: string;
  stepKey: string;
  catalogSource: CatalogSource;
  adapterName: string;
  adapterVersion: string;
  partitionKey?: string;
  sourceId: string;
  requestIdentity: string;
  sourceVersion: string;
  parserVersion: string;
  checkpointCursor: CatalogCrawlerCursor;
  fetchedAt: CatalogCrawlerDateInput;
  httpStatus?: number;
  ok?: boolean;
  payload: CatalogCrawlerJsonRecord;
  payloadHash?: string;
  metadata?: CatalogCrawlerJsonRecord;
};

export type CatalogCrawlerStepRecord = {
  crawlerJobStepId: string;
  crawlerJobId: string;
  stepKey: string;
  catalogSource: CatalogSource;
  adapterName: string;
  partitionKey: string;
  sourceId: string;
  requestIdentity: string;
  sourceVersion: string;
  parserVersion: string;
  checkpointCursor: CatalogCrawlerCursor;
  fetchedAt: Date;
  httpStatus: number | null;
  ok: boolean;
  payloadHash: string;
  sourceProvenanceId: string;
  status: CatalogCrawlerStepStatus;
  importedAt: Date | null;
  error: string | null;
  metadata: CatalogCrawlerJsonRecord;
  createdAt: Date;
  updatedAt: Date;
};

export type CatalogCrawlerStepResult = {
  step: CatalogCrawlerStepRecord;
  alreadyImported: boolean;
};

export interface ItotoriCatalogCrawlerRepositoryPort {
  getCheckpoint(
    actor: AuthorizationActor,
    key: CatalogCrawlerKey,
  ): Promise<CatalogCrawlerCheckpointRecord | null>;
  startCrawlerJob(
    actor: AuthorizationActor,
    workerId: string,
    input: CatalogCrawlerJobInput,
  ): Promise<CatalogCrawlerJobRecord>;
  recordFetchedStep(
    actor: AuthorizationActor,
    input: CatalogCrawlerStepInput,
  ): Promise<CatalogCrawlerStepResult>;
  markStepImported(
    actor: AuthorizationActor,
    crawlerJobStepId: string,
  ): Promise<CatalogCrawlerStepRecord>;
  markStepFailed(
    actor: AuthorizationActor,
    crawlerJobStepId: string,
    error: unknown,
  ): Promise<CatalogCrawlerStepRecord>;
  saveCheckpoint(
    actor: AuthorizationActor,
    input: CatalogCrawlerCheckpointInput,
  ): Promise<CatalogCrawlerCheckpointRecord>;
  saveRateLimit(
    actor: AuthorizationActor,
    input: CatalogCrawlerRateLimitInput,
  ): Promise<CatalogCrawlerRateLimitRecord>;
  completeCrawlerJob(
    actor: AuthorizationActor,
    crawlerJobId: string,
    workerId: string,
    checkpointCursor: CatalogCrawlerCursor,
  ): Promise<CatalogCrawlerJobRecord>;
  failCrawlerJob(
    actor: AuthorizationActor,
    crawlerJobId: string,
    workerId: string,
    error: unknown,
  ): Promise<CatalogCrawlerJobRecord>;
}

export class ItotoriCatalogCrawlerRepository implements ItotoriCatalogCrawlerRepositoryPort {
  constructor(private readonly db: ItotoriDatabase) {}

  async getCheckpoint(
    actor: AuthorizationActor,
    key: CatalogCrawlerKey,
  ): Promise<CatalogCrawlerCheckpointRecord | null> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    const normalized = normalizeCrawlerKey(key);
    const rows = await this.db
      .select()
      .from(catalogCrawlerCheckpoints)
      .where(
        and(
          eq(catalogCrawlerCheckpoints.catalogSource, normalized.catalogSource),
          eq(catalogCrawlerCheckpoints.adapterName, normalized.adapterName),
          eq(catalogCrawlerCheckpoints.partitionKey, normalized.partitionKey),
        ),
      )
      .limit(1);
    return rows[0] === undefined ? null : checkpointFromRow(rows[0]);
  }

  async startCrawlerJob(
    actor: AuthorizationActor,
    workerId: string,
    input: CatalogCrawlerJobInput,
  ): Promise<CatalogCrawlerJobRecord> {
    await requirePermission(this.db, actor, permissionValues.catalogWrite);
    const normalized = normalizeCrawlerJobInput(input);
    const leaseExpiresAt = new Date(Date.now() + (input.leaseSeconds ?? 300) * 1000);

    const rows = await this.db.transaction(async (tx) => {
      await tx
        .update(catalogCrawlerJobs)
        .set({
          status: catalogCrawlerJobStatusValues.failed,
          completedAt: sql`now()`,
          lastError: "crawler lease expired before completion",
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(catalogCrawlerJobs.catalogSource, normalized.catalogSource),
            eq(catalogCrawlerJobs.adapterName, normalized.adapterName),
            eq(catalogCrawlerJobs.partitionKey, normalized.partitionKey),
            eq(catalogCrawlerJobs.status, catalogCrawlerJobStatusValues.running),
            sql`${catalogCrawlerJobs.leaseExpiresAt} < now()`,
          ),
        );

      return tx
        .insert(catalogCrawlerJobs)
        .values({
          crawlerJobId: normalized.crawlerJobId,
          catalogSource: normalized.catalogSource,
          adapterName: normalized.adapterName,
          adapterVersion: normalized.adapterVersion,
          sourceVersion: normalized.sourceVersion,
          parserVersion: normalized.parserVersion,
          partitionKey: normalized.partitionKey,
          status: catalogCrawlerJobStatusValues.running,
          checkpointCursor: normalized.checkpointCursor,
          lockedBy: requiredString(workerId, "workerId"),
          leaseExpiresAt,
          metadata: normalized.metadata,
        })
        .returning();
    });

    return jobFromRow(requiredRow(rows, normalized.crawlerJobId));
  }

  async recordFetchedStep(
    actor: AuthorizationActor,
    input: CatalogCrawlerStepInput,
  ): Promise<CatalogCrawlerStepResult> {
    await requirePermission(this.db, actor, permissionValues.catalogWrite);
    const normalized = normalizeCrawlerStepInput(input);
    const sourceProvenanceId = stableId("catalog-crawler-provenance", [
      normalized.crawlerJobId,
      normalized.stepKey,
    ]);
    const previousRows = await this.db
      .select({ status: catalogCrawlerJobSteps.status })
      .from(catalogCrawlerJobSteps)
      .where(
        and(
          eq(catalogCrawlerJobSteps.catalogSource, normalized.catalogSource),
          eq(catalogCrawlerJobSteps.adapterName, normalized.adapterName),
          eq(catalogCrawlerJobSteps.partitionKey, normalized.partitionKey),
          eq(catalogCrawlerJobSteps.stepKey, normalized.stepKey),
          eq(catalogCrawlerJobSteps.requestIdentity, normalized.requestIdentity),
          eq(catalogCrawlerJobSteps.sourceVersion, normalized.sourceVersion),
          eq(catalogCrawlerJobSteps.parserVersion, normalized.parserVersion),
          eq(catalogCrawlerJobSteps.payloadHash, normalized.payloadHash),
          eq(catalogCrawlerJobSteps.status, catalogCrawlerStepStatusValues.imported),
        ),
      )
      .limit(1);
    const alreadyImported = previousRows[0] !== undefined;

    const rows = await this.db.transaction(async (tx) => {
      await tx
        .insert(catalogSourceProvenance)
        .values({
          sourceProvenanceId,
          catalogSource: normalized.catalogSource,
          sourceRecordKind: catalogSourceRecordKindValues.rawCache,
          sourceId: normalized.sourceId,
          sourceVersion: normalized.sourceVersion,
          requestId: normalized.requestIdentity,
          httpStatus: normalized.httpStatus,
          ok: normalized.ok,
          payloadHash: normalized.payloadHash,
          payload: normalized.payload,
          fetchedAt: normalized.fetchedAt,
          metadata: {
            ...normalized.metadata,
            adapterName: normalized.adapterName,
            adapterVersion: normalized.adapterVersion,
            checkpointCursor: normalized.checkpointCursor,
            crawlerJobId: normalized.crawlerJobId,
            crawlerJobStepId: normalized.crawlerJobStepId,
            parserVersion: normalized.parserVersion,
            requestIdentity: normalized.requestIdentity,
            stepKey: normalized.stepKey,
          },
        })
        .onConflictDoUpdate({
          target: catalogSourceProvenance.sourceProvenanceId,
          set: {
            sourceVersion: normalized.sourceVersion,
            requestId: normalized.requestIdentity,
            httpStatus: normalized.httpStatus,
            ok: normalized.ok,
            payloadHash: normalized.payloadHash,
            payload: normalized.payload,
            fetchedAt: normalized.fetchedAt,
            metadata: {
              ...normalized.metadata,
              adapterName: normalized.adapterName,
              adapterVersion: normalized.adapterVersion,
              checkpointCursor: normalized.checkpointCursor,
              crawlerJobId: normalized.crawlerJobId,
              crawlerJobStepId: normalized.crawlerJobStepId,
              parserVersion: normalized.parserVersion,
              requestIdentity: normalized.requestIdentity,
              stepKey: normalized.stepKey,
            },
          },
        });

      return tx
        .insert(catalogCrawlerJobSteps)
        .values({
          crawlerJobStepId: normalized.crawlerJobStepId,
          crawlerJobId: normalized.crawlerJobId,
          stepKey: normalized.stepKey,
          catalogSource: normalized.catalogSource,
          adapterName: normalized.adapterName,
          partitionKey: normalized.partitionKey,
          sourceId: normalized.sourceId,
          requestIdentity: normalized.requestIdentity,
          sourceVersion: normalized.sourceVersion,
          parserVersion: normalized.parserVersion,
          checkpointCursor: normalized.checkpointCursor,
          fetchedAt: normalized.fetchedAt,
          httpStatus: normalized.httpStatus,
          ok: normalized.ok,
          payloadHash: normalized.payloadHash,
          sourceProvenanceId,
          status: alreadyImported
            ? catalogCrawlerStepStatusValues.imported
            : catalogCrawlerStepStatusValues.fetched,
          importedAt: alreadyImported ? sql`now()` : null,
          metadata: normalized.metadata,
        })
        .onConflictDoUpdate({
          target: [catalogCrawlerJobSteps.crawlerJobId, catalogCrawlerJobSteps.stepKey],
          set: {
            adapterName: normalized.adapterName,
            partitionKey: normalized.partitionKey,
            sourceId: normalized.sourceId,
            requestIdentity: normalized.requestIdentity,
            sourceVersion: normalized.sourceVersion,
            parserVersion: normalized.parserVersion,
            checkpointCursor: normalized.checkpointCursor,
            fetchedAt: normalized.fetchedAt,
            httpStatus: normalized.httpStatus,
            ok: normalized.ok,
            payloadHash: normalized.payloadHash,
            sourceProvenanceId,
            status: alreadyImported
              ? catalogCrawlerStepStatusValues.imported
              : sql`case when ${catalogCrawlerJobSteps.status} = 'imported' then ${catalogCrawlerJobSteps.status} else 'fetched' end`,
            importedAt: alreadyImported
              ? sql`coalesce(${catalogCrawlerJobSteps.importedAt}, now())`
              : catalogCrawlerJobSteps.importedAt,
            error: null,
            metadata: normalized.metadata,
            updatedAt: sql`now()`,
          },
        })
        .returning();
    });

    return { step: stepFromRow(requiredRow(rows, normalized.crawlerJobStepId)), alreadyImported };
  }

  async markStepImported(
    actor: AuthorizationActor,
    crawlerJobStepId: string,
  ): Promise<CatalogCrawlerStepRecord> {
    await requirePermission(this.db, actor, permissionValues.catalogWrite);
    const rows = await this.db
      .update(catalogCrawlerJobSteps)
      .set({
        status: catalogCrawlerStepStatusValues.imported,
        importedAt: sql`now()`,
        error: null,
        updatedAt: sql`now()`,
      })
      .where(eq(catalogCrawlerJobSteps.crawlerJobStepId, requiredString(crawlerJobStepId, "crawlerJobStepId")))
      .returning();
    return stepFromRow(requiredRow(rows, crawlerJobStepId));
  }

  async markStepFailed(
    actor: AuthorizationActor,
    crawlerJobStepId: string,
    error: unknown,
  ): Promise<CatalogCrawlerStepRecord> {
    await requirePermission(this.db, actor, permissionValues.catalogWrite);
    const rows = await this.db
      .update(catalogCrawlerJobSteps)
      .set({
        status: catalogCrawlerStepStatusValues.failed,
        error: errorMessage(error),
        updatedAt: sql`now()`,
      })
      .where(eq(catalogCrawlerJobSteps.crawlerJobStepId, requiredString(crawlerJobStepId, "crawlerJobStepId")))
      .returning();
    return stepFromRow(requiredRow(rows, crawlerJobStepId));
  }

  async saveCheckpoint(
    actor: AuthorizationActor,
    input: CatalogCrawlerCheckpointInput,
  ): Promise<CatalogCrawlerCheckpointRecord> {
    await requirePermission(this.db, actor, permissionValues.catalogWrite);
    const normalized = normalizeCrawlerCheckpointInput(input);
    const rows = await this.db
      .insert(catalogCrawlerCheckpoints)
      .values(normalized)
      .onConflictDoUpdate({
        target: [
          catalogCrawlerCheckpoints.catalogSource,
          catalogCrawlerCheckpoints.adapterName,
          catalogCrawlerCheckpoints.partitionKey,
        ],
        set: {
          checkpointCursor: normalized.checkpointCursor,
          sourceVersion: normalized.sourceVersion,
          parserVersion: normalized.parserVersion,
          lastCrawlerJobId: normalized.lastCrawlerJobId,
          lastStepKey: normalized.lastStepKey,
          metadata: normalized.metadata,
          updatedAt: sql`now()`,
        },
      })
      .returning();
    return checkpointFromRow(requiredRow(rows, normalized.partitionKey));
  }

  async saveRateLimit(
    actor: AuthorizationActor,
    input: CatalogCrawlerRateLimitInput,
  ): Promise<CatalogCrawlerRateLimitRecord> {
    await requirePermission(this.db, actor, permissionValues.catalogWrite);
    const normalized = normalizeCrawlerRateLimitInput(input);
    const rows = await this.db
      .insert(catalogCrawlerRateLimits)
      .values(normalized)
      .onConflictDoUpdate({
        target: [
          catalogCrawlerRateLimits.catalogSource,
          catalogCrawlerRateLimits.adapterName,
          catalogCrawlerRateLimits.partitionKey,
        ],
        set: {
          nextAvailableAt: normalized.nextAvailableAt,
          resetAt: normalized.resetAt,
          remaining: normalized.remaining,
          limit: normalized.limit,
          retryAfterSeconds: normalized.retryAfterSeconds,
          requestIdentity: normalized.requestIdentity,
          metadata: normalized.metadata,
          updatedAt: sql`now()`,
        },
      })
      .returning();
    return rateLimitFromRow(requiredRow(rows, normalized.partitionKey));
  }

  async completeCrawlerJob(
    actor: AuthorizationActor,
    crawlerJobId: string,
    workerId: string,
    checkpointCursor: CatalogCrawlerCursor,
  ): Promise<CatalogCrawlerJobRecord> {
    await requirePermission(this.db, actor, permissionValues.catalogWrite);
    const rows = await this.db
      .update(catalogCrawlerJobs)
      .set({
        status: catalogCrawlerJobStatusValues.succeeded,
        checkpointCursor,
        completedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(catalogCrawlerJobs.crawlerJobId, requiredString(crawlerJobId, "crawlerJobId")),
          eq(catalogCrawlerJobs.lockedBy, requiredString(workerId, "workerId")),
        ),
      )
      .returning();
    return jobFromRow(requiredRow(rows, crawlerJobId));
  }

  async failCrawlerJob(
    actor: AuthorizationActor,
    crawlerJobId: string,
    workerId: string,
    error: unknown,
  ): Promise<CatalogCrawlerJobRecord> {
    await requirePermission(this.db, actor, permissionValues.catalogWrite);
    const rows = await this.db
      .update(catalogCrawlerJobs)
      .set({
        status: catalogCrawlerJobStatusValues.failed,
        completedAt: sql`now()`,
        lastError: errorMessage(error),
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(catalogCrawlerJobs.crawlerJobId, requiredString(crawlerJobId, "crawlerJobId")),
          eq(catalogCrawlerJobs.lockedBy, requiredString(workerId, "workerId")),
        ),
      )
      .returning();
    return jobFromRow(requiredRow(rows, crawlerJobId));
  }
}

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
};

function normalizeCrawlerKey(input: CatalogCrawlerKey): Required<CatalogCrawlerKey> {
  return {
    catalogSource: input.catalogSource,
    adapterName: requiredString(input.adapterName, "adapterName"),
    partitionKey: input.partitionKey ?? "default",
  };
}

function normalizeCrawlerJobInput(input: CatalogCrawlerJobInput): NormalizedCrawlerJobInput {
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

function normalizeCrawlerCheckpointInput(
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

function normalizeCrawlerRateLimitInput(
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
      input.requestIdentity === undefined ? null : requiredString(input.requestIdentity, "requestIdentity"),
    metadata: jsonRecord(input.metadata ?? {}, "metadata"),
  };
}

function normalizeCrawlerStepInput(input: CatalogCrawlerStepInput): NormalizedCrawlerStepInput {
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
  };
}

function jobFromRow(row: typeof catalogCrawlerJobs.$inferSelect): CatalogCrawlerJobRecord {
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

function checkpointFromRow(
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

function rateLimitFromRow(
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

function stepFromRow(row: typeof catalogCrawlerJobSteps.$inferSelect): CatalogCrawlerStepRecord {
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

function dateInput(input: CatalogCrawlerDateInput): Date {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) {
    throw new Error("date input must be valid");
  }
  return date;
}

function requiredString(input: string | undefined, name: string): string {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return input;
}

function optionalNonnegativeInteger(input: number | undefined, name: string): number | null {
  if (input === undefined) {
    return null;
  }
  if (!Number.isInteger(input) || input < 0) {
    throw new Error(`${name} must be a nonnegative integer`);
  }
  return input;
}

function jsonRecord(input: unknown, name: string): CatalogCrawlerJsonRecord {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return input as CatalogCrawlerJsonRecord;
}

function requiredRow<T>(rows: T[], id: string): T {
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`expected row for ${id}`);
  }
  return row;
}

function hashJson(input: unknown): string {
  return `sha256:${createHash("sha256").update(stableJsonStringify(input)).digest("hex")}`;
}

function stableId(prefix: string, parts: string[]): string {
  const hash = createHash("sha256").update(parts.join("\0")).digest("hex");
  return `${prefix}:${hash}`;
}

function stableJsonStringify(input: unknown): string {
  if (input === null || typeof input !== "object") {
    return JSON.stringify(input);
  }
  if (Array.isArray(input)) {
    return `[${input.map((value) => stableJsonStringify(value)).join(",")}]`;
  }
  const record = input as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJsonStringify(record[key])}`)
    .join(",")}}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
