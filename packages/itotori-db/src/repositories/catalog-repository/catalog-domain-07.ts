import {
  ItotoriDatabase,
  catalogDemandFacts,
  catalogExternalIds,
  catalogSourceProvenance,
  engineCapabilityReports,
  inArray,
} from "./dependencies.js";
import { CatalogReleaseRecord, CatalogSourceProvenanceRecord } from "./catalog-domain-01.js";
import {
  CatalogCompletenessPool,
  CatalogCompletenessPoolWork,
  CatalogContextPanelCatalogReadModel,
  catalogCompletenessPoolValues,
} from "./catalog-domain-03.js";
import { catalogCompletenessPools } from "./catalog-domain-04.js";
import { readCatalogCompletenessBenchmarkPools } from "./catalog-domain-05.js";
import {
  benchmarkProvenanceSummaries,
  benchmarkSourceIds,
  benchmarkTranslationStatus,
  compareBenchmarkTranslationStatuses,
} from "./catalog-domain-10.js";
import {
  benchmarkDecision,
  benchmarkExplanationCodes,
  capabilityReportsByAdapter,
  demandBucketForFacts,
  localOwnershipByWork,
  readinessForWork,
} from "./catalog-domain-11.js";
import { readWorkSnapshot } from "./catalog-domain-17.js";
import { sourceProvenanceFromRow } from "./catalog-domain-21.js";

export async function readCatalogContextPanelCatalogReadModel(
  db: ItotoriDatabase,
  input: { workId: string; targetLanguage: string },
): Promise<CatalogContextPanelCatalogReadModel | null> {
  const [snapshot, pools, capabilityRows] = await Promise.all([
    readWorkSnapshot(db, input.workId),
    readCatalogCompletenessBenchmarkPools(db, { targetLanguage: input.targetLanguage }),
    db.select().from(engineCapabilityReports),
  ]);
  if (snapshot === null) {
    return null;
  }

  const poolWork = findCompletenessPoolWork(pools.pools, input.workId);
  if (poolWork === null) {
    return null;
  }

  const externalIds = snapshot.externalIds as unknown as (typeof catalogExternalIds.$inferSelect)[];
  const demandFacts = snapshot.demandFacts as unknown as (typeof catalogDemandFacts.$inferSelect)[];
  const localOwnership = localOwnershipByWork(
    snapshot.localScanEntries.map((entry) => ({
      workId: entry.workId,
      owned: entry.owned,
    })),
  ).get(input.workId) ?? { localOwnership: "unknown", localEvidenceCount: 0 };
  const readiness = readinessForWork(
    snapshot.engineName,
    capabilityReportsByAdapter(capabilityRows),
  );
  const provenanceById = await provenanceByIdForBenchmarkContext(
    db,
    poolWork.work,
    externalIds,
    demandFacts,
    snapshot.engineProvenanceId,
  );
  const provenance = benchmarkProvenanceSummaries(
    poolWork.work,
    externalIds,
    demandFacts,
    snapshot.engineProvenanceId,
    provenanceById,
  );
  const explanationCodes = benchmarkExplanationCodes({
    pool: poolWork.pool,
    work: poolWork.work,
    demandBucket: demandBucketForFacts(demandFacts),
    localOwnership: localOwnership.localOwnership,
    provenance,
    readiness,
    minCapabilityLevel: null,
    requiredCapabilities: [],
    provenanceRequired: false,
    conflictRequested: poolWork.pool === catalogCompletenessPoolValues.conflict,
  });
  const decision = benchmarkDecision(explanationCodes, readiness, null, []);

  return {
    schemaVersion: "catalog.context_panel_catalog.v0.1",
    targetLanguage: input.targetLanguage,
    generatedAt: new Date(),
    row: {
      workId: snapshot.workId,
      canonicalTitle: snapshot.canonicalTitle,
      originalLanguage: snapshot.originalLanguage,
      sourceIds: benchmarkSourceIds(externalIds),
      completenessPool: poolWork.pool,
      translationStatuses: poolWork.work.statuses
        .map(benchmarkTranslationStatus)
        .sort(compareBenchmarkTranslationStatuses),
      localOwnership: localOwnership.localOwnership,
      localEvidenceCount: localOwnership.localEvidenceCount,
      demandBucket: demandBucketForFacts(demandFacts),
      readiness: readiness.readiness,
      provenance,
      decision,
      rank: 1,
      seedRank: decision === "seed" ? 1 : null,
      explanationCodes,
    },
    releases: [...snapshot.releases].sort(compareCatalogContextReleases),
  };
}

export function findCompletenessPoolWork(
  pools: Record<CatalogCompletenessPool, CatalogCompletenessPoolWork[]>,
  workId: string,
): { pool: CatalogCompletenessPool; work: CatalogCompletenessPoolWork } | null {
  for (const pool of catalogCompletenessPools) {
    const work = pools[pool].find((candidate) => candidate.workId === workId);
    if (work !== undefined) {
      return { pool, work };
    }
  }
  return null;
}

export async function provenanceByIdForBenchmarkContext(
  db: ItotoriDatabase,
  work: CatalogCompletenessPoolWork,
  externalIds: (typeof catalogExternalIds.$inferSelect)[],
  demandFacts: (typeof catalogDemandFacts.$inferSelect)[],
  engineProvenanceId: string | null,
): Promise<Map<string, CatalogSourceProvenanceRecord>> {
  const provenanceIds = new Set<string>();
  for (const status of work.statuses) {
    if (status.sourceProvenanceId !== null) {
      provenanceIds.add(status.sourceProvenanceId);
    }
  }
  for (const externalId of externalIds) {
    if (externalId.sourceProvenanceId !== null) {
      provenanceIds.add(externalId.sourceProvenanceId);
    }
  }
  for (const demandFact of demandFacts) {
    if (demandFact.sourceProvenanceId !== null) {
      provenanceIds.add(demandFact.sourceProvenanceId);
    }
  }
  if (engineProvenanceId !== null) {
    provenanceIds.add(engineProvenanceId);
  }
  if (provenanceIds.size === 0) {
    return new Map();
  }
  const rows = await db
    .select()
    .from(catalogSourceProvenance)
    .where(inArray(catalogSourceProvenance.sourceProvenanceId, Array.from(provenanceIds)));
  return new Map(rows.map((row) => [row.sourceProvenanceId, sourceProvenanceFromRow(row)]));
}

export function compareCatalogContextReleases(
  left: CatalogReleaseRecord,
  right: CatalogReleaseRecord,
): number {
  return (
    (left.releaseYear ?? 0) - (right.releaseYear ?? 0) ||
    (left.releaseDate ?? "").localeCompare(right.releaseDate ?? "") ||
    left.releaseTitle.localeCompare(right.releaseTitle) ||
    left.releaseId.localeCompare(right.releaseId)
  );
}
