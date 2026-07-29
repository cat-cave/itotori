import { and, eq, sql } from "drizzle-orm";
import { permissionValues, requirePermission, type AuthorizationActor } from "../authorization.js";
import type { ItotoriDatabase } from "../connection.js";
import {
  catalogCrawlerCheckpoints,
  catalogCrawlerJobs,
  catalogCrawlerJobStatusValues,
  catalogCrawlerJobSteps,
  catalogCrawlerRateLimits,
  catalogCrawlerStepStatusValues,
} from "../schema.js";
import type {
  CatalogCrawlerCheckpointInput,
  CatalogCrawlerCheckpointRecord,
  CatalogCrawlerCommitStepInput,
  CatalogCrawlerCommitStepResult,
  CatalogCrawlerCursor,
  CatalogCrawlerJobRecord,
  CatalogCrawlerRateLimitInput,
  CatalogCrawlerRateLimitRecord,
  CatalogCrawlerStepRecord,
} from "./catalog-crawler-repository.js";
import {
  activeCrawlerJobPredicate,
  assertActiveCrawlerJob,
  checkpointFromRow,
  errorMessage,
  jobFromRow,
  normalizeCrawlerCheckpointInput,
  normalizeCrawlerRateLimitInput,
  rateLimitFromRow,
  requiredActiveCrawlerJob,
  requiredRow,
  requiredString,
  stepFromRow,
} from "./catalog-crawler-repository-normalization.js";

export async function commitStepImport(
  db: ItotoriDatabase,
  actor: AuthorizationActor,
  input: CatalogCrawlerCommitStepInput,
): Promise<CatalogCrawlerCommitStepResult> {
  await requirePermission(db, actor, permissionValues.catalogWrite);
  const crawlerJobId = requiredString(input.crawlerJobId, "crawlerJobId");
  const workerId = requiredString(input.workerId, "workerId");
  const crawlerJobStepId = requiredString(input.crawlerJobStepId, "crawlerJobStepId");
  const checkpoint = normalizeCrawlerCheckpointInput({
    ...input.checkpoint,
    lastCrawlerJobId: crawlerJobId,
    workerId,
  });
  const rateLimit =
    input.rateLimit === undefined
      ? null
      : normalizeCrawlerRateLimitInput({ ...input.rateLimit, crawlerJobId, workerId });
  return db.transaction(async (tx) => {
    const activeRows = await tx
      .select({ crawlerJobId: catalogCrawlerJobs.crawlerJobId })
      .from(catalogCrawlerJobs)
      .where(activeCrawlerJobPredicate(crawlerJobId, workerId))
      .limit(1);
    requiredActiveCrawlerJob(activeRows, crawlerJobId);
    const stepRows = await tx
      .update(catalogCrawlerJobSteps)
      .set({
        status: catalogCrawlerStepStatusValues.imported,
        importedAt: sql`coalesce(${catalogCrawlerJobSteps.importedAt}, now())`,
        error: null,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(catalogCrawlerJobSteps.crawlerJobStepId, crawlerJobStepId),
          eq(catalogCrawlerJobSteps.crawlerJobId, crawlerJobId),
        ),
      )
      .returning();
    const step = stepFromRow(requiredRow(stepRows, crawlerJobStepId));
    let rateLimitRecord: CatalogCrawlerRateLimitRecord | null = null;
    if (rateLimit !== null) {
      const rateLimitRows = await tx
        .insert(catalogCrawlerRateLimits)
        .values(rateLimit)
        .onConflictDoUpdate({
          target: [
            catalogCrawlerRateLimits.catalogSource,
            catalogCrawlerRateLimits.adapterName,
            catalogCrawlerRateLimits.partitionKey,
          ],
          set: {
            nextAvailableAt: rateLimit.nextAvailableAt,
            resetAt: rateLimit.resetAt,
            remaining: rateLimit.remaining,
            limit: rateLimit.limit,
            retryAfterSeconds: rateLimit.retryAfterSeconds,
            requestIdentity: rateLimit.requestIdentity,
            metadata: rateLimit.metadata,
            updatedAt: sql`now()`,
          },
        })
        .returning();
      rateLimitRecord = rateLimitFromRow(requiredRow(rateLimitRows, rateLimit.partitionKey));
    }
    const checkpointRows = await tx
      .insert(catalogCrawlerCheckpoints)
      .values(checkpoint)
      .onConflictDoUpdate({
        target: [
          catalogCrawlerCheckpoints.catalogSource,
          catalogCrawlerCheckpoints.adapterName,
          catalogCrawlerCheckpoints.partitionKey,
        ],
        set: {
          checkpointCursor: checkpoint.checkpointCursor,
          sourceVersion: checkpoint.sourceVersion,
          parserVersion: checkpoint.parserVersion,
          lastCrawlerJobId: checkpoint.lastCrawlerJobId,
          lastStepKey: checkpoint.lastStepKey,
          metadata: checkpoint.metadata,
          updatedAt: sql`now()`,
        },
      })
      .returning();
    return {
      step,
      checkpoint: checkpointFromRow(requiredRow(checkpointRows, checkpoint.partitionKey)),
      rateLimit: rateLimitRecord,
    };
  });
}

export async function markStepImported(
  db: ItotoriDatabase,
  actor: AuthorizationActor,
  crawlerJobStepId: string,
  workerId: string,
): Promise<CatalogCrawlerStepRecord> {
  await requirePermission(db, actor, permissionValues.catalogWrite);
  const lockedBy = requiredString(workerId, "workerId");
  const rows = await db
    .update(catalogCrawlerJobSteps)
    .set({
      status: catalogCrawlerStepStatusValues.imported,
      importedAt: sql`now()`,
      error: null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(
          catalogCrawlerJobSteps.crawlerJobStepId,
          requiredString(crawlerJobStepId, "crawlerJobStepId"),
        ),
        sql`exists (
              select 1 from ${catalogCrawlerJobs}
              where ${catalogCrawlerJobs.crawlerJobId} = ${catalogCrawlerJobSteps.crawlerJobId}
                and ${catalogCrawlerJobs.lockedBy} = ${lockedBy}
                and ${catalogCrawlerJobs.status} = ${catalogCrawlerJobStatusValues.running}
                and ${catalogCrawlerJobs.leaseExpiresAt} > now()
            )`,
      ),
    )
    .returning();
  return stepFromRow(requiredRow(rows, crawlerJobStepId));
}

export async function markStepFailed(
  db: ItotoriDatabase,
  actor: AuthorizationActor,
  crawlerJobStepId: string,
  error: unknown,
  workerId: string,
): Promise<CatalogCrawlerStepRecord> {
  await requirePermission(db, actor, permissionValues.catalogWrite);
  const lockedBy = requiredString(workerId, "workerId");
  const rows = await db
    .update(catalogCrawlerJobSteps)
    .set({
      status: catalogCrawlerStepStatusValues.failed,
      error: errorMessage(error),
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(
          catalogCrawlerJobSteps.crawlerJobStepId,
          requiredString(crawlerJobStepId, "crawlerJobStepId"),
        ),
        sql`exists (
              select 1 from ${catalogCrawlerJobs}
              where ${catalogCrawlerJobs.crawlerJobId} = ${catalogCrawlerJobSteps.crawlerJobId}
                and ${catalogCrawlerJobs.lockedBy} = ${lockedBy}
                and ${catalogCrawlerJobs.status} = ${catalogCrawlerJobStatusValues.running}
                and ${catalogCrawlerJobs.leaseExpiresAt} > now()
            )`,
      ),
    )
    .returning();
  return stepFromRow(requiredRow(rows, crawlerJobStepId));
}

export async function saveCheckpoint(
  db: ItotoriDatabase,
  actor: AuthorizationActor,
  input: CatalogCrawlerCheckpointInput,
): Promise<CatalogCrawlerCheckpointRecord> {
  await requirePermission(db, actor, permissionValues.catalogWrite);
  const normalized = normalizeCrawlerCheckpointInput(input);
  const lastCrawlerJobId = requiredString(input.lastCrawlerJobId, "lastCrawlerJobId");
  await assertActiveCrawlerJob(db, lastCrawlerJobId, input.workerId);
  const rows = await db
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

export async function saveRateLimit(
  db: ItotoriDatabase,
  actor: AuthorizationActor,
  input: CatalogCrawlerRateLimitInput,
): Promise<CatalogCrawlerRateLimitRecord> {
  await requirePermission(db, actor, permissionValues.catalogWrite);
  const normalized = normalizeCrawlerRateLimitInput(input);
  await assertActiveCrawlerJob(db, input.crawlerJobId, input.workerId);
  const rows = await db
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

export async function completeCrawlerJob(
  db: ItotoriDatabase,
  actor: AuthorizationActor,
  crawlerJobId: string,
  workerId: string,
  checkpointCursor: CatalogCrawlerCursor,
): Promise<CatalogCrawlerJobRecord> {
  await requirePermission(db, actor, permissionValues.catalogWrite);
  const rows = await db
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
        eq(catalogCrawlerJobs.status, catalogCrawlerJobStatusValues.running),
        sql`${catalogCrawlerJobs.leaseExpiresAt} > now()`,
      ),
    )
    .returning();
  return jobFromRow(requiredRow(rows, crawlerJobId));
}

export async function failCrawlerJob(
  db: ItotoriDatabase,
  actor: AuthorizationActor,
  crawlerJobId: string,
  workerId: string,
  error: unknown,
): Promise<CatalogCrawlerJobRecord> {
  await requirePermission(db, actor, permissionValues.catalogWrite);
  const rows = await db
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
        eq(catalogCrawlerJobs.status, catalogCrawlerJobStatusValues.running),
        sql`${catalogCrawlerJobs.leaseExpiresAt} > now()`,
      ),
    )
    .returning();
  return jobFromRow(requiredRow(rows, crawlerJobId));
}
