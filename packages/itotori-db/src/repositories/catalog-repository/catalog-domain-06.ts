import {
  ItotoriDatabase,
  catalogConflictKindValues,
  catalogConflictStatusValues,
  catalogDemandFacts,
  catalogExternalIds,
  catalogLocalScanEntries,
  catalogSourceProvenance,
  catalogWorks,
  engineCapabilityReports,
  inArray,
} from "./dependencies.js";
import {
  CatalogAlphaBenchmarkOpportunityRanking,
  CatalogBenchmarkSeedFinderReadModel,
  catalogCompletenessPoolValues,
} from "./catalog-domain-03.js";
import { catalogCompletenessPools } from "./catalog-domain-04.js";
import {
  readCatalogCompletenessBenchmarkPools,
  readCatalogConflictReview,
} from "./catalog-domain-05.js";
import {
  DraftCatalogAlphaBenchmarkOpportunity,
  alphaBenchmarkDemotionFromConflict,
  alphaBenchmarkPoolBaseScore,
} from "./catalog-domain-09.js";
import {
  DraftCatalogBenchmarkSeedRow,
  alphaBenchmarkOpportunityFromDraft,
  benchmarkProvenanceSummaries,
  benchmarkSourceIds,
  benchmarkTranslationStatus,
  compareBenchmarkTranslationStatuses,
  groupBy,
  hasSharedSourceId,
  translationCompletenessMatches,
} from "./catalog-domain-10.js";
import {
  benchmarkDecision,
  benchmarkExplanationCodes,
  benchmarkSortScore,
  capabilityReportsByAdapter,
  demandBucketForFacts,
  localOwnershipByWork,
  readinessForWork,
} from "./catalog-domain-11.js";
import {
  compareAlphaBenchmarkOpportunities,
  compareBenchmarkSeedDrafts,
} from "./catalog-domain-13.js";
import {
  NormalizedAlphaBenchmarkOpportunityRankingFilter,
  NormalizedBenchmarkSeedFinderFilter,
  sourceProvenanceFromRow,
} from "./catalog-domain-21.js";

export async function readCatalogAlphaBenchmarkOpportunityRanking(
  db: ItotoriDatabase,
  filter: NormalizedAlphaBenchmarkOpportunityRankingFilter,
): Promise<CatalogAlphaBenchmarkOpportunityRanking> {
  const [pools, conflictRows] = await Promise.all([
    readCatalogCompletenessBenchmarkPools(db, { targetLanguage: filter.targetLanguage }),
    readCatalogConflictReview(db),
  ]);
  const candidatesByWorkId = new Map<string, DraftCatalogAlphaBenchmarkOpportunity>();
  for (const pool of [
    catalogCompletenessPoolValues.noEnglish,
    catalogCompletenessPoolValues.mtlOnly,
    catalogCompletenessPoolValues.fanPartial,
    catalogCompletenessPoolValues.unknown,
  ]) {
    for (const work of pools.pools[pool]) {
      const existing = candidatesByWorkId.get(work.workId);
      if (existing === undefined || alphaBenchmarkPoolBaseScore(pool) > existing.baseScore) {
        candidatesByWorkId.set(work.workId, {
          work,
          candidatePool: pool,
          baseScore: alphaBenchmarkPoolBaseScore(pool),
          demotions: [],
        });
      }
    }
  }

  const openLanguageConflicts = conflictRows.filter(
    (row) =>
      row.conflictKind === catalogConflictKindValues.languageStatus &&
      row.status === catalogConflictStatusValues.open,
  );
  for (const conflict of openLanguageConflicts) {
    const demotion = alphaBenchmarkDemotionFromConflict(conflict);
    const directCandidate = candidatesByWorkId.get(conflict.catalogRecordId);
    if (directCandidate === undefined) {
      const conflictWork = pools.pools[catalogCompletenessPoolValues.conflict].find(
        (work) => work.workId === conflict.catalogRecordId,
      );
      if (conflictWork !== undefined) {
        candidatesByWorkId.set(conflictWork.workId, {
          work: conflictWork,
          candidatePool: catalogCompletenessPoolValues.conflict,
          baseScore: alphaBenchmarkPoolBaseScore(catalogCompletenessPoolValues.conflict),
          demotions: [demotion],
        });
      }
    } else {
      directCandidate.demotions.push(demotion);
    }

    for (const candidate of candidatesByWorkId.values()) {
      if (candidate.work.workId === conflict.catalogRecordId) {
        continue;
      }
      if (hasSharedSourceId(candidate.work.sourceIds, conflict.sourceIds)) {
        candidate.demotions.push(demotion);
      }
    }
  }

  const ranked = Array.from(candidatesByWorkId.values())
    .filter((candidate) => filter.includeDemoted || candidate.demotions.length === 0)
    .map(alphaBenchmarkOpportunityFromDraft)
    .sort(compareAlphaBenchmarkOpportunities)
    .map((row, index) => ({ ...row, rank: index + 1 }));

  let seedRank = 0;
  const rows = ranked.map((row) => {
    if (row.decision === "demoted") {
      return row;
    }
    seedRank += 1;
    return { ...row, seedRank };
  });

  return {
    schemaVersion: "catalog.alpha_benchmark_opportunity_ranking.v0.1",
    targetLanguage: filter.targetLanguage,
    generatedAt: new Date(),
    rows,
  };
}

export async function readCatalogBenchmarkSeedFinder(
  db: ItotoriDatabase,
  filter: NormalizedBenchmarkSeedFinderFilter,
): Promise<CatalogBenchmarkSeedFinderReadModel> {
  const [pools, workRows, externalIdRows, demandFactRows, localScanEntryRows, capabilityRows] =
    await Promise.all([
      readCatalogCompletenessBenchmarkPools(db, { targetLanguage: filter.targetLanguage }),
      db.select().from(catalogWorks),
      db.select().from(catalogExternalIds),
      db.select().from(catalogDemandFacts),
      db
        .select({
          workId: catalogLocalScanEntries.workId,
          owned: catalogLocalScanEntries.owned,
        })
        .from(catalogLocalScanEntries),
      db.select().from(engineCapabilityReports),
    ]);

  const provenanceIds = new Set<string>();
  for (const work of Object.values(pools.pools).flat()) {
    for (const status of work.statuses) {
      if (status.sourceProvenanceId !== null) {
        provenanceIds.add(status.sourceProvenanceId);
      }
    }
  }
  for (const externalId of externalIdRows) {
    if (externalId.sourceProvenanceId !== null) {
      provenanceIds.add(externalId.sourceProvenanceId);
    }
  }
  for (const demandFact of demandFactRows) {
    if (demandFact.sourceProvenanceId !== null) {
      provenanceIds.add(demandFact.sourceProvenanceId);
    }
  }
  for (const work of workRows) {
    if (work.engineProvenanceId !== null) {
      provenanceIds.add(work.engineProvenanceId);
    }
  }

  const provenanceRows =
    provenanceIds.size === 0
      ? []
      : await db
          .select()
          .from(catalogSourceProvenance)
          .where(inArray(catalogSourceProvenance.sourceProvenanceId, Array.from(provenanceIds)));

  const provenanceById = new Map(
    provenanceRows.map((row) => [row.sourceProvenanceId, sourceProvenanceFromRow(row)]),
  );
  const workById = new Map(workRows.map((row) => [row.workId, row]));
  const externalIdsByWorkId = groupBy(externalIdRows, (row) => row.workId);
  const demandFactsByWorkId = groupBy(demandFactRows, (row) => row.workId);
  const localOwnershipByWorkId = localOwnershipByWork(localScanEntryRows);
  const capabilityByAdapterId = capabilityReportsByAdapter(capabilityRows);

  const drafts: DraftCatalogBenchmarkSeedRow[] = [];
  const seenWorkIds = new Set<string>();
  for (const pool of catalogCompletenessPools) {
    if (filter.pools !== null && !filter.pools.includes(pool)) {
      continue;
    }
    for (const work of pools.pools[pool]) {
      if (seenWorkIds.has(work.workId)) {
        continue;
      }
      seenWorkIds.add(work.workId);

      if (!translationCompletenessMatches(work, filter.translationCompleteness)) {
        continue;
      }

      const localOwnership = localOwnershipByWorkId.get(work.workId) ?? {
        localOwnership: "unknown" as const,
        localEvidenceCount: 0,
      };
      if (
        filter.localOwnership !== null &&
        filter.localOwnership !== localOwnership.localOwnership
      ) {
        continue;
      }

      const demandBucket = demandBucketForFacts(demandFactsByWorkId.get(work.workId) ?? []);
      if (filter.demandBucket !== null && filter.demandBucket !== demandBucket) {
        continue;
      }

      const sourceIds = benchmarkSourceIds(externalIdsByWorkId.get(work.workId) ?? []);
      const provenance = benchmarkProvenanceSummaries(
        work,
        externalIdsByWorkId.get(work.workId) ?? [],
        demandFactsByWorkId.get(work.workId) ?? [],
        workById.get(work.workId)?.engineProvenanceId ?? null,
        provenanceById,
      );
      const readiness = readinessForWork(
        workById.get(work.workId)?.engineName ?? null,
        capabilityByAdapterId,
        filter.adapterIds,
      );
      const explanationCodes = benchmarkExplanationCodes({
        pool,
        work,
        demandBucket,
        localOwnership: localOwnership.localOwnership,
        provenance,
        readiness,
        minCapabilityLevel: filter.minCapabilityLevel,
        requiredCapabilities: filter.requiredCapabilities,
        provenanceRequired: filter.provenanceRequired,
        conflictRequested: filter.pools?.includes(catalogCompletenessPoolValues.conflict) ?? false,
      });
      const decision = benchmarkDecision(
        explanationCodes,
        readiness,
        filter.minCapabilityLevel,
        filter.requiredCapabilities,
      );

      if (!filter.includeDemoted && (decision === "demoted" || decision === "excluded")) {
        continue;
      }

      drafts.push({
        row: {
          workId: work.workId,
          canonicalTitle: work.canonicalTitle,
          originalLanguage: work.originalLanguage,
          sourceIds,
          completenessPool: pool,
          translationStatuses: work.statuses
            .map(benchmarkTranslationStatus)
            .sort(compareBenchmarkTranslationStatuses),
          localOwnership: localOwnership.localOwnership,
          localEvidenceCount: localOwnership.localEvidenceCount,
          demandBucket,
          readiness: readiness.readiness,
          provenance,
          decision,
          rank: 0,
          seedRank: null,
          explanationCodes,
        },
        sortScore: benchmarkSortScore({
          pool,
          decision,
          demandBucket,
          localOwnership: localOwnership.localOwnership,
          readiness: readiness.readiness,
        }),
      });
    }
  }

  const sorted = drafts.sort(compareBenchmarkSeedDrafts).slice(0, filter.limit);
  let seedRank = 0;
  const rows = sorted.map(({ row }, index) => {
    if (row.decision === "seed") {
      seedRank += 1;
      return { ...row, rank: index + 1, seedRank };
    }
    return { ...row, rank: index + 1 };
  });

  return {
    schemaVersion: "catalog.benchmark_seed_finder.v0.1",
    targetLanguage: filter.targetLanguage,
    generatedAt: new Date(),
    rows,
  };
}
