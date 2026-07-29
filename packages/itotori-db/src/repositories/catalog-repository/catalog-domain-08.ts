import {
  CatalogOpportunityDemandSignal,
  ItotoriDatabase,
  capabilityLevelStatusKindValues,
  catalogConflictKindValues,
  catalogConflictStatusValues,
  catalogConflicts,
  catalogDemandFacts,
  catalogExternalIds,
  catalogLocalScanEntries,
  catalogOpportunityWeightsVersion,
  catalogSourceProvenance,
  catalogWorks,
  engineCapabilityEvidence,
  engineCapabilityReports,
  inArray,
  scoreCatalogOpportunity,
} from "./dependencies.js";
import {
  CatalogAlphaBenchmarkOpportunityRankingFilter,
  CatalogCompletenessPoolFilter,
} from "./catalog-domain-03.js";
import {
  CatalogOpportunityRankingReadModel,
  catalogCompletenessPools,
} from "./catalog-domain-04.js";
import {
  readCatalogCompletenessBenchmarkPools,
  readCatalogConflictReview,
} from "./catalog-domain-05.js";
import {
  DraftCatalogOpportunityRow,
  benchmarkProvenanceSummaries,
  benchmarkSourceIds,
  benchmarkTranslationStatus,
  compareBenchmarkTranslationStatuses,
  groupBy,
} from "./catalog-domain-10.js";
import {
  capabilityReportsByAdapter,
  localOwnershipByWork,
  readinessForWork,
} from "./catalog-domain-11.js";
import {
  capabilityEvidenceCountsByAdapter,
  hasPublicOpportunityIdentity,
  opportunityAdapterReadiness,
  opportunityCompletenessSignal,
  opportunityDemandEvidenceRefs,
  opportunityDemandFacts,
  opportunityMarketPrevalence,
  opportunityRuntimeEvidenceReadiness,
  opportunityWorkTypeSignal,
} from "./catalog-domain-12.js";
import {
  catalogOpportunityConflictAppliesToTargetLanguage,
  catalogOpportunityDemotionFromConflict,
  compareCatalogOpportunityDemotions,
  compareCatalogOpportunityDrafts,
  opportunityBenchmarkUsefulness,
  opportunityExistingTranslationStatus,
  opportunityUnknownEvidence,
} from "./catalog-domain-13.js";
import {
  NormalizedAlphaBenchmarkOpportunityRankingFilter,
  NormalizedCatalogOpportunityRankingFilter,
  NormalizedCompletenessPoolFilter,
  sourceProvenanceFromRow,
} from "./catalog-domain-21.js";
import { requiredString } from "./catalog-domain-22.js";
import { assertEnumValue } from "./catalog-domain-23.js";

export async function readCatalogOpportunityRanking(
  db: ItotoriDatabase,
  filter: NormalizedCatalogOpportunityRankingFilter,
): Promise<CatalogOpportunityRankingReadModel> {
  const [
    pools,
    conflictRows,
    workRows,
    externalIdRows,
    demandFactRows,
    localScanEntryRows,
    capabilityRows,
    capabilityEvidenceRows,
    rawConflictRows,
  ] = await Promise.all([
    readCatalogCompletenessBenchmarkPools(db, { targetLanguage: filter.targetLanguage }),
    readCatalogConflictReview(db),
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
    db.select().from(engineCapabilityEvidence),
    db
      .select({
        conflictId: catalogConflicts.conflictId,
        metadata: catalogConflicts.metadata,
      })
      .from(catalogConflicts),
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
  const evidenceByAdapterId = capabilityEvidenceCountsByAdapter(capabilityEvidenceRows);
  const rawConflictMetadataById = new Map(
    rawConflictRows.map((row) => [row.conflictId, row.metadata]),
  );
  const openLanguageConflictsByWorkId = groupBy(
    conflictRows.filter(
      (row) =>
        row.conflictKind === catalogConflictKindValues.languageStatus &&
        row.status === catalogConflictStatusValues.open &&
        catalogOpportunityConflictAppliesToTargetLanguage(
          row,
          rawConflictMetadataById,
          filter.targetLanguage,
        ),
    ),
    (row) => row.catalogRecordId,
  );

  const drafts: DraftCatalogOpportunityRow[] = [];
  const seenWorkIds = new Set<string>();
  for (const pool of catalogCompletenessPools) {
    if (filter.pool !== null && filter.pool !== pool) {
      continue;
    }
    for (const work of pools.pools[pool]) {
      if (seenWorkIds.has(work.workId)) {
        continue;
      }
      seenWorkIds.add(work.workId);

      const workRecord = workById.get(work.workId);
      const engineName = workRecord?.engineName ?? null;
      if (filter.engine !== null && engineName !== filter.engine) {
        continue;
      }
      const readiness = readinessForWork(engineName, capabilityByAdapterId).readiness;
      if (
        filter.minCapabilityLevel !== null &&
        readiness[filter.minCapabilityLevel] !== capabilityLevelStatusKindValues.supported
      ) {
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

      const demandFacts = opportunityDemandFacts(demandFactsByWorkId.get(work.workId) ?? []);
      if (filter.demandBucket !== null && filter.demandBucket !== demandFacts.demandBucket) {
        continue;
      }

      const sourceIds = benchmarkSourceIds(externalIdsByWorkId.get(work.workId) ?? []);
      const provenance = benchmarkProvenanceSummaries(
        work,
        externalIdsByWorkId.get(work.workId) ?? [],
        demandFactsByWorkId.get(work.workId) ?? [],
        workRecord?.engineProvenanceId ?? null,
        provenanceById,
      );
      if (!hasPublicOpportunityIdentity(sourceIds, provenance)) {
        continue;
      }
      const demotions = (openLanguageConflictsByWorkId.get(work.workId) ?? [])
        .map(catalogOpportunityDemotionFromConflict)
        .sort(compareCatalogOpportunityDemotions);
      const runtimeEvidenceReadiness = opportunityRuntimeEvidenceReadiness(
        readiness.adapterId === null ? null : evidenceByAdapterId.get(readiness.adapterId),
      );
      const marketPrevalence = opportunityMarketPrevalence(
        sourceIds,
        localOwnership.localEvidenceCount,
      );
      const score = scoreCatalogOpportunity({
        translationCompleteness: opportunityCompletenessSignal(pool),
        localOwnership: localOwnership.localOwnership,
        dlsiteDemand: demandFacts.demandBucket as CatalogOpportunityDemandSignal,
        dlsiteRatingAverage: demandFacts.ratingAverage,
        dlsiteWorkType: opportunityWorkTypeSignal(demandFacts.workType),
        platformLanguageConflict: demotions.length > 0 ? "open_platform_language_conflict" : "none",
        marketPrevalence,
        adapterReadiness: opportunityAdapterReadiness(readiness),
        runtimeEvidenceReadiness: runtimeEvidenceReadiness.status,
        existingTranslationStatus: opportunityExistingTranslationStatus(work.statuses),
        benchmarkUsefulness: opportunityBenchmarkUsefulness(pool, demandFacts.demandBucket),
        unknownEvidence: opportunityUnknownEvidence(readiness, provenance),
        evidenceRefs: {
          translation_completeness: work.statuses.map((status) => status.languageStatusId),
          local_ownership:
            localOwnership.localEvidenceCount > 0
              ? [`local_evidence_count:${localOwnership.localEvidenceCount}`]
              : [],
          dlsite_demand: opportunityDemandEvidenceRefs(demandFacts),
          dlsite_work_type:
            demandFacts.workType === null
              ? ["work_type:unknown"]
              : [`work_type:${demandFacts.workType}`],
          platform_language_conflict: demotions
            .map((demotion) => demotion.conflictId)
            .filter((conflictId): conflictId is string => conflictId !== null),
          market_prevalence: [
            `source_id_count:${sourceIds.length}`,
            `local_evidence_count:${localOwnership.localEvidenceCount}`,
          ],
          adapter_readiness: readiness.adapterId === null ? [] : [readiness.adapterId],
          runtime_evidence_readiness: [
            `public_fixture_evidence_count:${runtimeEvidenceReadiness.publicFixtureEvidenceCount}`,
            `private_local_aggregate_evidence_count:${runtimeEvidenceReadiness.privateLocalAggregateEvidenceCount}`,
          ],
          existing_translation_status: work.statuses.map((status) => status.languageStatusId),
          benchmark_usefulness: [`pool:${pool}`, `demand_bucket:${demandFacts.demandBucket}`],
          unknown_evidence: provenance.length === 0 ? ["public_provenance:missing"] : [],
        },
      });

      if (!filter.includeDemoted && score.decision !== "candidate") {
        continue;
      }

      drafts.push({
        row: {
          rank: 0,
          workId: work.workId,
          canonicalTitle: work.canonicalTitle,
          originalLanguage: work.originalLanguage,
          sourceIds,
          engineName,
          adapterId: readiness.adapterId,
          readiness,
          runtimeEvidenceReadiness,
          completenessPool: pool,
          translationStatuses: work.statuses
            .map(benchmarkTranslationStatus)
            .sort(compareBenchmarkTranslationStatuses),
          demandFacts,
          localOwnership: localOwnership.localOwnership,
          localEvidenceCount: localOwnership.localEvidenceCount,
          marketPrevalence,
          decision: score.decision,
          score: score.score,
          factorBreakdown: score.factors,
          explanationCodes: score.explanationCodes,
          provenance,
          demotions,
        },
      });
    }
  }

  const rows = drafts
    .sort(compareCatalogOpportunityDrafts)
    .slice(0, filter.limit)
    .map(({ row }, index) => ({ ...row, rank: index + 1 }));

  return {
    schemaVersion: "catalog.opportunity_ranking.v0.1",
    targetLanguage: filter.targetLanguage,
    generatedAt: new Date(),
    weightsVersion: catalogOpportunityWeightsVersion,
    rows,
  };
}

export function assertCompletenessPoolFilter(
  filter: CatalogCompletenessPoolFilter,
): NormalizedCompletenessPoolFilter {
  if (filter.pool !== undefined) {
    assertEnumValue(filter.pool, catalogCompletenessPools, "pool");
  }
  const normalized: NormalizedCompletenessPoolFilter = {
    targetLanguage:
      filter.targetLanguage === undefined
        ? "en-US"
        : requiredString(filter.targetLanguage, "targetLanguage"),
  };
  if (filter.pool !== undefined) {
    normalized.pool = filter.pool;
  }
  return normalized;
}

export function assertAlphaBenchmarkOpportunityRankingFilter(
  filter: CatalogAlphaBenchmarkOpportunityRankingFilter,
): NormalizedAlphaBenchmarkOpportunityRankingFilter {
  return {
    targetLanguage:
      filter.targetLanguage === undefined
        ? "en-US"
        : requiredString(filter.targetLanguage, "targetLanguage"),
    includeDemoted: filter.includeDemoted ?? true,
  };
}
