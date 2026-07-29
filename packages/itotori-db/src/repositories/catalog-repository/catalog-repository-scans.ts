import {
  AuthorizationActor,
  CatalogCandidateMatchStatus,
  CatalogExternalIdKind,
  CatalogSeedStatus,
  CatalogSource,
  ItotoriDatabase,
  and,
  catalogCandidateMatches,
  catalogExternalIdKindValues,
  catalogExternalIds,
  catalogLocalScanEntries,
  catalogLocalScanExternalIds,
  catalogLocalScans,
  catalogSeedTargets,
  catalogWorks,
  desc,
  eq,
  inArray,
  permissionValues,
  requirePermission,
  sql,
} from "./dependencies.js";
import {
  CatalogCandidateMatchInput,
  CatalogCandidateMatchRecord,
  CatalogCandidateTargetWorkRecord,
  CatalogLocalScanInput,
  CatalogLocalScanRecord,
  CatalogSeedTargetInput,
  CatalogSeedTargetRecord,
  CatalogWorkSnapshot,
} from "./catalog-domain-02.js";
import {
  CatalogConflictReviewFilter,
  CatalogConflictReviewReadModel,
} from "./catalog-domain-03.js";
import {
  catalogBenchmarkSelectableSeedStatuses,
  catalogCandidateMatchStatuses,
  catalogExternalIdKinds,
  catalogSeedStatuses,
  catalogSources,
  seedTargetIsBenchmarkSelectable,
} from "./catalog-domain-04.js";
import { readCatalogConflictReview } from "./catalog-domain-05.js";
import {
  assertCatalogConflictReviewFilter,
  catalogConflictReviewRowMatches,
} from "./catalog-domain-15.js";
import { recordSeedTargetUnchecked } from "./catalog-domain-16.js";
import { readLocalScan, readWorkSnapshot } from "./catalog-domain-17.js";
import {
  assertCandidateMatchInput,
  assertLocalScanInput,
  assertSeedTargetInput,
} from "./catalog-domain-21.js";
import {
  candidateMatchFromRow,
  requiredLocalScan,
  requiredRow,
  seedTargetFromRow,
} from "./catalog-domain-22.js";
import { requiredString } from "../../required-string.js";
import { assertEnumValue } from "./catalog-domain-23.js";
import { CatalogRepositoryWrites } from "./catalog-repository-writes.js";

export class CatalogRepositoryScans extends CatalogRepositoryWrites {
  async recordLocalScan(
    actor: AuthorizationActor,
    input: CatalogLocalScanInput,
  ): Promise<CatalogLocalScanRecord> {
    await requirePermission(this.db, actor, permissionValues.catalogWrite);
    const normalized = assertLocalScanInput(input);

    await this.db.transaction(async (tx) => {
      await tx
        .insert(catalogLocalScans)
        .values({
          localScanId: normalized.localScanId,
          scanRootLabel: normalized.scanRootLabel,
          scanRootPathHash: normalized.scanRootPathHash,
          scannerName: normalized.scannerName,
          scannerVersion: normalized.scannerVersion,
          startedAt: normalized.startedAt,
          completedAt: normalized.completedAt,
          createdByUserId: actor.userId,
          metadata: normalized.metadata,
        })
        .onConflictDoUpdate({
          target: catalogLocalScans.localScanId,
          set: {
            scanRootLabel: normalized.scanRootLabel,
            scanRootPathHash: normalized.scanRootPathHash,
            scannerName: normalized.scannerName,
            scannerVersion: normalized.scannerVersion,
            startedAt: normalized.startedAt,
            completedAt: normalized.completedAt,
            metadata: normalized.metadata,
          },
        });

      for (const entry of normalized.entries) {
        const entryRows = await tx
          .insert(catalogLocalScanEntries)
          .values({
            localScanEntryId: entry.localScanEntryId,
            localScanId: normalized.localScanId,
            workId: entry.workId,
            pathHash: entry.pathHash,
            pathRedactionClass: entry.pathRedactionClass,
            owned: entry.owned,
            engineName: entry.engineName,
            engineSource: entry.engineSource,
            engineConfidence: entry.engineConfidence,
            signals: entry.signals,
            sourceProvenanceId: entry.sourceProvenanceId,
            scannedAt: entry.scannedAt,
            metadata: entry.metadata,
          })
          .onConflictDoUpdate({
            target: [catalogLocalScanEntries.localScanId, catalogLocalScanEntries.pathHash],
            set: {
              workId: entry.workId,
              pathHash: entry.pathHash,
              pathRedactionClass: entry.pathRedactionClass,
              owned: entry.owned,
              engineName: entry.engineName,
              engineSource: entry.engineSource,
              engineConfidence: entry.engineConfidence,
              signals: entry.signals,
              sourceProvenanceId: entry.sourceProvenanceId,
              scannedAt: entry.scannedAt,
              metadata: entry.metadata,
              updatedAt: sql`now()`,
            },
          })
          .returning({ localScanEntryId: catalogLocalScanEntries.localScanEntryId });
        const persistedLocalScanEntryId = requiredRow(
          entryRows,
          entry.localScanEntryId,
        ).localScanEntryId;

        for (const detectedExternalId of entry.detectedExternalIds) {
          await tx
            .insert(catalogLocalScanExternalIds)
            .values({
              localScanEntryId: persistedLocalScanEntryId,
              catalogSource: detectedExternalId.catalogSource,
              sourceId: detectedExternalId.sourceId,
              externalIdKind: detectedExternalId.externalIdKind,
              sourceProvenanceId: detectedExternalId.sourceProvenanceId,
              metadata: detectedExternalId.metadata,
            })
            .onConflictDoUpdate({
              target: [
                catalogLocalScanExternalIds.localScanEntryId,
                catalogLocalScanExternalIds.catalogSource,
                catalogLocalScanExternalIds.sourceId,
                catalogLocalScanExternalIds.externalIdKind,
              ],
              set: {
                sourceProvenanceId: detectedExternalId.sourceProvenanceId,
                metadata: detectedExternalId.metadata,
              },
            });
        }

        for (const seedTarget of entry.seedTargets) {
          const usesParentLocalScanEntry =
            seedTarget.localScanEntryId === null ||
            seedTarget.localScanEntryId === entry.localScanEntryId;
          await recordSeedTargetUnchecked(tx as ItotoriDatabase, {
            ...seedTarget,
            localScanEntryId: usesParentLocalScanEntry
              ? persistedLocalScanEntryId
              : seedTarget.localScanEntryId,
          });
        }
      }
    });

    return requiredLocalScan(
      await readLocalScan(this.db, normalized.localScanId),
      normalized.localScanId,
    );
  }

  async recordSeedTarget(
    actor: AuthorizationActor,
    input: CatalogSeedTargetInput,
  ): Promise<CatalogSeedTargetRecord> {
    await requirePermission(this.db, actor, permissionValues.catalogWrite);
    return recordSeedTargetUnchecked(this.db, assertSeedTargetInput(input));
  }

  async getWorkSnapshot(
    actor: AuthorizationActor,
    workId: string,
  ): Promise<CatalogWorkSnapshot | null> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    return readWorkSnapshot(this.db, requiredString(workId, "workId"));
  }

  async getWorkByExternalId(
    actor: AuthorizationActor,
    catalogSource: CatalogSource,
    sourceId: string,
    externalIdKind: CatalogExternalIdKind = catalogExternalIdKindValues.sourceRecord,
  ): Promise<CatalogWorkSnapshot | null> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    assertEnumValue(catalogSource, catalogSources, "catalogSource");
    assertEnumValue(externalIdKind, catalogExternalIdKinds, "externalIdKind");
    const externalRows = await this.db
      .select({ workId: catalogExternalIds.workId })
      .from(catalogExternalIds)
      .where(
        and(
          eq(catalogExternalIds.catalogSource, catalogSource),
          eq(catalogExternalIds.sourceId, requiredString(sourceId, "sourceId")),
          eq(catalogExternalIds.externalIdKind, externalIdKind),
        ),
      )
      .limit(1);
    const externalRow = externalRows[0];
    if (externalRow === undefined) {
      return null;
    }
    return readWorkSnapshot(this.db, externalRow.workId);
  }

  async listSeedTargets(
    actor: AuthorizationActor,
    status?: CatalogSeedStatus,
  ): Promise<CatalogSeedTargetRecord[]> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    if (status !== undefined) {
      assertEnumValue(status, catalogSeedStatuses, "status");
    }
    const rows =
      status === undefined
        ? await this.db
            .select()
            .from(catalogSeedTargets)
            .orderBy(desc(catalogSeedTargets.priority), catalogSeedTargets.addedAt)
        : await this.db
            .select()
            .from(catalogSeedTargets)
            .where(eq(catalogSeedTargets.status, status))
            .orderBy(desc(catalogSeedTargets.priority), catalogSeedTargets.addedAt);
    return rows.map(seedTargetFromRow);
  }

  // CATALOG-080: the benchmark-candidate seed-target query. It returns only seeds
  // that are safe to select as benchmark targets — excluding recorded-importer
  // seed hints that have not yet been consumed by CATALOG-004 readiness filtering
  // (i.e. that lack a readiness-explanation record). Source-fact provenance of the
  // excluded inert hints remains available via listSeedTargets for later
  // explanation generation.
  async listBenchmarkSelectableSeedTargets(
    actor: AuthorizationActor,
  ): Promise<CatalogSeedTargetRecord[]> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    const rows = await this.db
      .select()
      .from(catalogSeedTargets)
      .where(inArray(catalogSeedTargets.status, catalogBenchmarkSelectableSeedStatuses))
      .orderBy(desc(catalogSeedTargets.priority), catalogSeedTargets.addedAt);
    return rows.map(seedTargetFromRow).filter(seedTargetIsBenchmarkSelectable);
  }

  async listCatalogCandidateTargetWorks(
    actor: AuthorizationActor,
  ): Promise<CatalogCandidateTargetWorkRecord[]> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    const rows = await this.db
      .select({
        workId: catalogWorks.workId,
        canonicalTitle: catalogWorks.canonicalTitle,
        firstReleaseYear: catalogWorks.firstReleaseYear,
        originalLanguage: catalogWorks.originalLanguage,
        workKind: catalogWorks.workKind,
      })
      .from(catalogWorks)
      .orderBy(catalogWorks.canonicalTitle, catalogWorks.workId);
    return rows;
  }

  async recordCatalogCandidateMatch(
    actor: AuthorizationActor,
    input: CatalogCandidateMatchInput,
  ): Promise<CatalogCandidateMatchRecord> {
    await requirePermission(this.db, actor, permissionValues.catalogWrite);
    const normalized = assertCandidateMatchInput(input);
    const rows = await this.db
      .insert(catalogCandidateMatches)
      .values(normalized)
      .onConflictDoUpdate({
        target: [
          catalogCandidateMatches.sourceCatalogSource,
          catalogCandidateMatches.sourceId,
          catalogCandidateMatches.targetWorkId,
          catalogCandidateMatches.generatorVersion,
        ],
        set: {
          sourceTitle: normalized.sourceTitle,
          sourceProvenanceId: normalized.sourceProvenanceId,
          score: normalized.score,
          matchedFields: normalized.matchedFields,
          status: normalized.status,
          diagnosticCode: normalized.diagnosticCode,
          metadata: normalized.metadata,
          updatedAt: sql`now()`,
        },
      })
      .returning();
    return candidateMatchFromRow(requiredRow(rows, normalized.candidateId));
  }

  async listCatalogCandidateMatches(
    actor: AuthorizationActor,
    status?: CatalogCandidateMatchStatus,
  ): Promise<CatalogCandidateMatchRecord[]> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    if (status !== undefined) {
      assertEnumValue(status, catalogCandidateMatchStatuses, "status");
    }
    const rows =
      status === undefined
        ? await this.db
            .select()
            .from(catalogCandidateMatches)
            .orderBy(desc(catalogCandidateMatches.score), catalogCandidateMatches.createdAt)
        : await this.db
            .select()
            .from(catalogCandidateMatches)
            .where(eq(catalogCandidateMatches.status, status))
            .orderBy(desc(catalogCandidateMatches.score), catalogCandidateMatches.createdAt);
    return rows.map(candidateMatchFromRow);
  }

  async catalogConflictReview(
    actor: AuthorizationActor,
    filter: CatalogConflictReviewFilter = {},
  ): Promise<CatalogConflictReviewReadModel> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    const normalized = assertCatalogConflictReviewFilter(filter);
    const rows = await readCatalogConflictReview(this.db);
    return {
      rows: rows.filter((row) => catalogConflictReviewRowMatches(row, normalized)),
    };
  }
}
