import { and, eq, sql } from "drizzle-orm";
import { permissionValues, requirePermission, type AuthorizationActor } from "../authorization.js";
import type { ItotoriDatabase } from "../connection.js";
import {
  catalogCrawlerCheckpoints,
  catalogCrawlerJobs,
  catalogCrawlerJobStatusValues,
  catalogCrawlerJobSteps,
  catalogCrawlerStepStatusValues,
  catalogSourceProvenance,
} from "../schema.js";
import type {
  CatalogCrawlerCheckpointRecord,
  CatalogCrawlerJobInput,
  CatalogCrawlerJobRecord,
  CatalogCrawlerKey,
  CatalogCrawlerStepInput,
  CatalogCrawlerStepResult,
} from "./catalog-crawler-repository.js";
import {
  assertActiveCrawlerJob,
  checkpointFromRow,
  jobFromRow,
  normalizeCrawlerJobInput,
  normalizeCrawlerKey,
  normalizeCrawlerStepInput,
  requiredRow,
  stepFromRow,
} from "./catalog-crawler-repository-normalization.js";
import { stableId } from "./catalog-crawler-repository-values.js";
import { requiredString } from "../required-string.js";

export async function getCheckpoint(
  db: ItotoriDatabase,
  actor: AuthorizationActor,
  key: CatalogCrawlerKey,
): Promise<CatalogCrawlerCheckpointRecord | null> {
  await requirePermission(db, actor, permissionValues.catalogRead);
  const normalized = normalizeCrawlerKey(key);
  const rows = await db
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

export async function startCrawlerJob(
  db: ItotoriDatabase,
  actor: AuthorizationActor,
  workerId: string,
  input: CatalogCrawlerJobInput,
): Promise<CatalogCrawlerJobRecord> {
  await requirePermission(db, actor, permissionValues.catalogWrite);
  const normalized = normalizeCrawlerJobInput(input);
  const leaseExpiresAt = new Date(Date.now() + (input.leaseSeconds ?? 300) * 1000);
  const rows = await db.transaction(async (tx) => {
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

export async function recordFetchedStep(
  db: ItotoriDatabase,
  actor: AuthorizationActor,
  input: CatalogCrawlerStepInput,
): Promise<CatalogCrawlerStepResult> {
  await requirePermission(db, actor, permissionValues.catalogWrite);
  await assertActiveCrawlerJob(db, input.crawlerJobId, input.workerId);
  const normalized = normalizeCrawlerStepInput(input);
  const sourceProvenanceId = stableId("catalog-crawler-provenance", [
    normalized.crawlerJobId,
    normalized.stepKey,
  ]);
  const previousRows = await db
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
        sql`(${catalogCrawlerJobSteps.status} = ${catalogCrawlerStepStatusValues.imported} or ${catalogCrawlerJobSteps.importedAt} is not null)`,
      ),
    )
    .limit(1);
  const alreadyImported = previousRows[0] !== undefined;
  const rows = await db.transaction(async (tx) => {
    await tx
      .insert(catalogSourceProvenance)
      .values({
        sourceProvenanceId,
        catalogSource: normalized.catalogSource,
        sourceRecordKind: normalized.sourceRecordKind,
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
          sourceRecordKind: normalized.sourceRecordKind,
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
