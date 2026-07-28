import {
  CatalogConfidence,
  CatalogLanguageStatus,
  CatalogLanguageStatusScope,
  CatalogRawContentRedactionClass,
  CatalogSource,
  CatalogSourceRecordKind,
  capabilityLevelValues,
  catalogExternalIds,
  catalogLanguageStatusValues,
  catalogLanguageStatuses,
  catalogSourceProvenance,
} from "./dependencies.js";
import { CatalogConflictReviewSourceId } from "./catalog-domain-02.js";
import {
  CatalogAlphaBenchmarkOpportunityDemotion,
  CatalogBenchmarkSeedFinderFilter,
  CatalogCompletenessPool,
  CatalogCompletenessPoolWork,
  CatalogCompletenessSourceSummary,
  CatalogCompletenessStatusFact,
  CatalogConflictReviewRow,
  CatalogOpportunityRankingFilter,
  catalogCompletenessPoolValues,
} from "./catalog-domain-03.js";
import {
  benchmarkDemandBuckets,
  benchmarkLocalOwnershipValues,
  catalogCompletenessPools,
  catalogLanguageStatusEnums,
} from "./catalog-domain-04.js";
import {
  uniqueBenchmarkPools,
  uniqueCapabilityLevels,
  uniqueCatalogLanguageStatuses,
} from "./catalog-domain-13.js";
import { publicRawContentRedactionClass } from "./catalog-domain-15.js";
import {
  isPrivateSourceProvenance,
  isPublicSourceId,
  uniqueSourceIds,
  uniqueStrings,
} from "./catalog-domain-16.js";
import {
  NormalizedBenchmarkSeedFinderFilter,
  NormalizedCatalogOpportunityRankingFilter,
} from "./catalog-domain-21.js";
import { requiredString } from "./catalog-domain-22.js";
import { assertEnumValue } from "./catalog-domain-23.js";

export function assertBenchmarkSeedFinderFilter(
  filter: CatalogBenchmarkSeedFinderFilter,
): NormalizedBenchmarkSeedFinderFilter {
  const targetLanguage =
    filter.targetLanguage === undefined
      ? "en-US"
      : requiredString(filter.targetLanguage, "targetLanguage");
  const pools = filter.pools ?? null;
  if (pools !== null) {
    for (const pool of pools) {
      assertEnumValue(pool, catalogCompletenessPools, "pools[]");
    }
  }
  if (filter.minCapabilityLevel !== undefined) {
    assertEnumValue(
      filter.minCapabilityLevel,
      Object.values(capabilityLevelValues),
      "minCapabilityLevel",
    );
  }
  const requiredCapabilities = filter.requiredCapabilities ?? null;
  if (requiredCapabilities !== null) {
    for (const capability of requiredCapabilities) {
      assertEnumValue(capability, Object.values(capabilityLevelValues), "requiredCapabilities[]");
    }
  }
  const adapterIds = filter.adapterIds ?? null;
  if (adapterIds !== null) {
    for (const adapterId of adapterIds) {
      requiredString(adapterId, "adapterIds[]");
    }
  }
  if (filter.demandBucket !== undefined) {
    assertEnumValue(filter.demandBucket, benchmarkDemandBuckets, "demandBucket");
  }
  const translationCompleteness = filter.translationCompleteness ?? null;
  if (translationCompleteness !== null) {
    for (const status of translationCompleteness) {
      assertEnumValue(status, catalogLanguageStatusEnums, "translationCompleteness[]");
    }
  }
  if (filter.localOwnership !== undefined) {
    assertEnumValue(filter.localOwnership, benchmarkLocalOwnershipValues, "localOwnership");
  }
  const limit = filter.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("limit must be an integer from 1 to 500");
  }
  return {
    targetLanguage,
    pools: pools === null ? null : uniqueBenchmarkPools(pools),
    minCapabilityLevel: filter.minCapabilityLevel ?? null,
    requiredCapabilities:
      requiredCapabilities === null ? [] : uniqueCapabilityLevels(requiredCapabilities),
    adapterIds: adapterIds === null ? null : uniqueStrings(adapterIds),
    demandBucket: filter.demandBucket ?? null,
    translationCompleteness:
      translationCompleteness === null
        ? null
        : uniqueCatalogLanguageStatuses(translationCompleteness),
    provenanceRequired: filter.provenanceRequired ?? false,
    localOwnership: filter.localOwnership ?? null,
    includeDemoted: filter.includeDemoted ?? false,
    limit,
  };
}

export function assertCatalogOpportunityRankingFilter(
  filter: CatalogOpportunityRankingFilter,
): NormalizedCatalogOpportunityRankingFilter {
  const targetLanguage =
    filter.targetLanguage === undefined
      ? "en-US"
      : requiredString(filter.targetLanguage, "targetLanguage");
  if (filter.pool !== undefined) {
    assertEnumValue(filter.pool, catalogCompletenessPools, "pool");
  }
  if (filter.minCapabilityLevel !== undefined) {
    assertEnumValue(
      filter.minCapabilityLevel,
      Object.values(capabilityLevelValues),
      "minCapabilityLevel",
    );
  }
  if (filter.localOwnership !== undefined) {
    assertEnumValue(filter.localOwnership, benchmarkLocalOwnershipValues, "localOwnership");
  }
  if (filter.demandBucket !== undefined) {
    assertEnumValue(filter.demandBucket, benchmarkDemandBuckets, "demandBucket");
  }
  const limit = filter.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("limit must be an integer from 1 to 500");
  }
  return {
    targetLanguage,
    includeDemoted: filter.includeDemoted ?? false,
    limit,
    engine: filter.engine === undefined ? null : requiredString(filter.engine, "engine"),
    pool: filter.pool ?? null,
    minCapabilityLevel: filter.minCapabilityLevel ?? null,
    localOwnership: filter.localOwnership ?? null,
    demandBucket: filter.demandBucket ?? null,
  };
}

export function emptyCompletenessPools(): Record<
  CatalogCompletenessPool,
  CatalogCompletenessPoolWork[]
> {
  return {
    [catalogCompletenessPoolValues.mtlOnly]: [],
    [catalogCompletenessPoolValues.fanPartial]: [],
    [catalogCompletenessPoolValues.noEnglish]: [],
    [catalogCompletenessPoolValues.unknown]: [],
    [catalogCompletenessPoolValues.conflict]: [],
  };
}

export function poolsForCompletenessWork(
  work: CatalogCompletenessPoolWork,
): CatalogCompletenessPool[] {
  const statuses = work.statuses.map((status) => status.status);
  const pools: CatalogCompletenessPool[] = [];
  if (work.conflicts.length > 0) {
    pools.push(catalogCompletenessPoolValues.conflict);
  }
  if (statuses.includes(catalogLanguageStatusValues.fanPartial)) {
    pools.push(catalogCompletenessPoolValues.fanPartial);
  }
  if (
    statuses.includes(catalogLanguageStatusValues.mtl) &&
    statuses.every(
      (status) =>
        status === catalogLanguageStatusValues.mtl ||
        status === catalogLanguageStatusValues.unknown,
    )
  ) {
    pools.push(catalogCompletenessPoolValues.mtlOnly);
  }
  if (
    statuses.includes(catalogLanguageStatusValues.none) &&
    statuses.every(
      (status) =>
        status === catalogLanguageStatusValues.none ||
        status === catalogLanguageStatusValues.unknown,
    )
  ) {
    pools.push(catalogCompletenessPoolValues.noEnglish);
  }
  if (statuses.every((status) => status === catalogLanguageStatusValues.unknown)) {
    pools.push(catalogCompletenessPoolValues.unknown);
  }
  return pools;
}

export function completenessStatusFactFromRow(
  row: typeof catalogLanguageStatuses.$inferSelect,
  sourcesById: Map<string, CatalogCompletenessSourceSummary>,
): CatalogCompletenessStatusFact {
  const source =
    row.sourceProvenanceId === null ? null : (sourcesById.get(row.sourceProvenanceId) ?? null);
  return {
    languageStatusId: row.languageStatusId,
    language: row.language,
    status: row.status as CatalogLanguageStatus,
    statusScope: row.statusScope as CatalogLanguageStatusScope,
    platform: row.platform,
    releaseId: row.releaseId,
    sourceProvenanceId: source === null ? null : row.sourceProvenanceId,
    source,
    privateSourceCount: row.sourceProvenanceId !== null && source === null ? 1 : 0,
    confidence: row.confidence as CatalogConfidence,
    observedAt: row.observedAt,
    importedAt: row.importedAt,
    parserVersion: row.parserVersion,
    rawContentRedactionClass: publicRawContentRedactionClass(
      row.rawContentRedactionClass as CatalogRawContentRedactionClass,
    ),
  };
}

export function sourceSummaryFromRow(
  row: typeof catalogSourceProvenance.$inferSelect,
): CatalogCompletenessSourceSummary | null {
  if (isPrivateSourceProvenance(row)) {
    return null;
  }
  return {
    sourceProvenanceId: row.sourceProvenanceId,
    catalogSource: row.catalogSource as CatalogSource,
    sourceRecordKind: row.sourceRecordKind as CatalogSourceRecordKind,
    sourceId: row.sourceId,
    sourceVersion: row.sourceVersion,
    fetchedAt: row.fetchedAt,
    rawContentRedactionClass: publicRawContentRedactionClass(
      row.rawContentRedactionClass as CatalogRawContentRedactionClass,
    ),
  };
}

export function sourceIdsForCompletenessWork(
  facts: CatalogCompletenessStatusFact[],
  externalIds: (typeof catalogExternalIds.$inferSelect)[],
): CatalogConflictReviewSourceId[] {
  return uniqueSourceIds(
    [
      ...facts
        .map((fact) =>
          fact.source === null
            ? null
            : { catalogSource: fact.source.catalogSource, sourceId: fact.source.sourceId },
        )
        .filter((sourceId): sourceId is CatalogConflictReviewSourceId => sourceId !== null),
      ...externalIds.map((externalId) => ({
        catalogSource: externalId.catalogSource as CatalogSource,
        sourceId: externalId.sourceId,
      })),
    ].filter(isPublicSourceId),
  );
}

export type DraftCatalogAlphaBenchmarkOpportunity = {
  work: CatalogCompletenessPoolWork;
  candidatePool: CatalogCompletenessPool;
  baseScore: number;
  demotions: CatalogAlphaBenchmarkOpportunityDemotion[];
};

export function alphaBenchmarkPoolBaseScore(pool: CatalogCompletenessPool): number {
  switch (pool) {
    case catalogCompletenessPoolValues.noEnglish:
      return 80;
    case catalogCompletenessPoolValues.mtlOnly:
      return 60;
    case catalogCompletenessPoolValues.fanPartial:
      return 50;
    case catalogCompletenessPoolValues.unknown:
      return 20;
    case catalogCompletenessPoolValues.conflict:
      return 10;
  }
}

export function alphaBenchmarkDemotionFromConflict(
  row: CatalogConflictReviewRow,
): CatalogAlphaBenchmarkOpportunityDemotion {
  return {
    reasonCode: row.reasonCode,
    reasonDetail: row.reasonDetail,
    conflictOrigin: row.conflictOrigin,
    conflictId: row.conflictId,
    severity: row.severity,
    sourceIds: row.sourceIds,
    provenance: row.provenance,
  };
}
