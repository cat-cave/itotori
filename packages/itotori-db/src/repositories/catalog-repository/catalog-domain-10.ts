import {
  CatalogExternalIdKind,
  CatalogLanguageStatus,
  CatalogPlatformLanguageConflictOrigin,
  CatalogSource,
  and,
  catalogDemandFacts,
  catalogExternalIds,
  catalogPlatformLanguageConflictOriginValues,
  catalogRawContentRedactionClassValues,
  catalogSourceRecordKindValues,
  catalogSourceValues,
} from "./dependencies.js";
import { CatalogSourceProvenanceRecord } from "./catalog-domain-01.js";
import { CatalogConflictReviewSourceId } from "./catalog-domain-02.js";
import {
  CatalogAlphaBenchmarkOpportunity,
  CatalogAlphaBenchmarkOpportunityDecision,
  CatalogAlphaBenchmarkOpportunityDemotion,
  CatalogBenchmarkSeedProvenanceSummary,
  CatalogBenchmarkSeedReadiness,
  CatalogBenchmarkSeedRow,
  CatalogBenchmarkSeedSourceId,
  CatalogBenchmarkSeedTranslationStatus,
  CatalogCompletenessPool,
  CatalogCompletenessPoolWork,
  CatalogCompletenessStatusFact,
  catalogCompletenessPoolValues,
} from "./catalog-domain-03.js";
import { CatalogOpportunityRow } from "./catalog-domain-04.js";
import { DraftCatalogAlphaBenchmarkOpportunity } from "./catalog-domain-09.js";
import { stringMetadata } from "./catalog-domain-16.js";

export function alphaBenchmarkOpportunityFromDraft(
  draft: DraftCatalogAlphaBenchmarkOpportunity,
): CatalogAlphaBenchmarkOpportunity {
  const demotions = uniqueAlphaBenchmarkDemotions(draft.demotions);
  const decision: CatalogAlphaBenchmarkOpportunityDecision =
    demotions.length === 0 ? "seed" : "demoted";
  const score = draft.baseScore - demotions.length * 1000;
  return {
    rank: 0,
    seedRank: decision === "seed" ? 0 : null,
    workId: draft.work.workId,
    canonicalTitle: draft.work.canonicalTitle,
    originalLanguage: draft.work.originalLanguage,
    candidatePool: draft.candidatePool,
    decision,
    score,
    explanation:
      decision === "seed"
        ? alphaBenchmarkSeedExplanation(draft.candidatePool)
        : `Demoted from alpha benchmark seed output because ${demotions
            .map(
              (demotion) =>
                `${demotion.reasonCode} (${alphaBenchmarkDemotionOriginLabel(demotion.conflictOrigin)})`,
            )
            .join(", ")}.`,
    sourceIds: draft.work.sourceIds,
    statuses: draft.work.statuses,
    demotions,
  };
}

export function alphaBenchmarkDemotionOriginLabel(
  origin: CatalogPlatformLanguageConflictOrigin,
): string {
  return origin === catalogPlatformLanguageConflictOriginValues.repositoryDerived
    ? "repository-derived"
    : "fixture-authored";
}

export function alphaBenchmarkSeedExplanation(pool: CatalogCompletenessPool): string {
  switch (pool) {
    case catalogCompletenessPoolValues.noEnglish:
      return "Eligible alpha benchmark seed: current catalog evidence says no English localization exists.";
    case catalogCompletenessPoolValues.mtlOnly:
      return "Eligible alpha benchmark seed: current catalog evidence says only machine translation exists.";
    case catalogCompletenessPoolValues.fanPartial:
      return "Eligible alpha benchmark seed: current catalog evidence says only partial fan localization exists.";
    case catalogCompletenessPoolValues.unknown:
      return "Eligible alpha benchmark seed: current catalog evidence is unknown and needs review.";
    case catalogCompletenessPoolValues.conflict:
      return "Eligible alpha benchmark seed: conflict review is required before use.";
  }
}

export function uniqueAlphaBenchmarkDemotions(
  demotions: CatalogAlphaBenchmarkOpportunityDemotion[],
): CatalogAlphaBenchmarkOpportunityDemotion[] {
  const byKey = new Map<string, CatalogAlphaBenchmarkOpportunityDemotion>();
  for (const demotion of demotions) {
    byKey.set(`${demotion.conflictId ?? ""}:${demotion.reasonCode}`, demotion);
  }
  return Array.from(byKey.values()).sort((left, right) =>
    `${left.reasonCode}:${left.conflictId ?? ""}`.localeCompare(
      `${right.reasonCode}:${right.conflictId ?? ""}`,
    ),
  );
}

export function hasSharedSourceId(
  left: CatalogConflictReviewSourceId[],
  right: CatalogConflictReviewSourceId[],
): boolean {
  const rightKeys = new Set(right.map((sourceId) => sourceIdKey(sourceId)));
  return left.some((sourceId) => rightKeys.has(sourceIdKey(sourceId)));
}

export function sourceIdKey(sourceId: CatalogConflictReviewSourceId): string {
  return `${sourceId.catalogSource}:${sourceId.sourceId}`;
}

export type DraftCatalogBenchmarkSeedRow = {
  row: CatalogBenchmarkSeedRow;
  sortScore: number;
};

export type DraftCatalogOpportunityRow = {
  row: CatalogOpportunityRow;
};

export type CatalogOpportunityEvidenceCounts = {
  publicFixtureEvidenceCount: number;
  privateLocalAggregateEvidenceCount: number;
};

export type CatalogBenchmarkReadinessResult = {
  readiness: CatalogBenchmarkSeedReadiness;
};

export function groupBy<T, K>(rows: T[], keyFor: (row: T) => K): Map<K, T[]> {
  const grouped = new Map<K, T[]>();
  for (const row of rows) {
    const key = keyFor(row);
    const existing = grouped.get(key) ?? [];
    existing.push(row);
    grouped.set(key, existing);
  }
  return grouped;
}

export function translationCompletenessMatches(
  work: CatalogCompletenessPoolWork,
  statuses: CatalogLanguageStatus[] | null,
): boolean {
  if (statuses === null) {
    return true;
  }
  return work.statuses.some((status) => statuses.includes(status.status));
}

export function benchmarkSourceIds(
  externalIds: (typeof catalogExternalIds.$inferSelect)[],
): CatalogBenchmarkSeedSourceId[] {
  const byKey = new Map<string, CatalogBenchmarkSeedSourceId>();
  for (const externalId of externalIds) {
    if (externalId.catalogSource === catalogSourceValues.localCorpus) {
      continue;
    }
    const sourceId = {
      catalogSource: externalId.catalogSource as CatalogSource,
      sourceId: externalId.sourceId,
      externalIdKind: externalId.externalIdKind as CatalogExternalIdKind,
    };
    byKey.set(
      `${sourceId.catalogSource}:${sourceId.sourceId}:${sourceId.externalIdKind}`,
      sourceId,
    );
  }
  return Array.from(byKey.values()).sort(compareBenchmarkSourceIds);
}

export function compareBenchmarkSourceIds(
  left: CatalogBenchmarkSeedSourceId,
  right: CatalogBenchmarkSeedSourceId,
): number {
  return (
    left.catalogSource.localeCompare(right.catalogSource) ||
    left.sourceId.localeCompare(right.sourceId) ||
    left.externalIdKind.localeCompare(right.externalIdKind)
  );
}

export function benchmarkTranslationStatus(
  status: CatalogCompletenessStatusFact,
): CatalogBenchmarkSeedTranslationStatus {
  return {
    language: status.language,
    status: status.status,
    confidence: status.confidence,
    statusScope: status.statusScope,
    platform: status.platform,
  };
}

export function compareBenchmarkTranslationStatuses(
  left: CatalogBenchmarkSeedTranslationStatus,
  right: CatalogBenchmarkSeedTranslationStatus,
): number {
  return (
    left.language.localeCompare(right.language) ||
    left.status.localeCompare(right.status) ||
    left.statusScope.localeCompare(right.statusScope) ||
    (left.platform ?? "").localeCompare(right.platform ?? "")
  );
}

export function benchmarkProvenanceSummaries(
  work: CatalogCompletenessPoolWork,
  externalIds: (typeof catalogExternalIds.$inferSelect)[],
  demandFacts: (typeof catalogDemandFacts.$inferSelect)[],
  engineProvenanceId: string | null,
  provenanceById: Map<string, CatalogSourceProvenanceRecord>,
): CatalogBenchmarkSeedProvenanceSummary[] {
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

  const summaries = Array.from(provenanceIds)
    .map((id) => provenanceById.get(id) ?? null)
    .filter((record): record is CatalogSourceProvenanceRecord => record !== null)
    .filter(isPublicBenchmarkProvenance)
    .map(benchmarkProvenanceSummaryFromRecord);
  return uniqueBenchmarkProvenanceSummaries(summaries);
}

export function isPublicBenchmarkProvenance(record: CatalogSourceProvenanceRecord): boolean {
  if (record.catalogSource === catalogSourceValues.localCorpus) {
    return false;
  }
  if (record.sourceRecordKind === catalogSourceRecordKindValues.localScan) {
    return false;
  }
  if (record.rawContentRedactionClass === catalogRawContentRedactionClassValues.privateCorpus) {
    return false;
  }
  return (
    record.sourceRecordKind === catalogSourceRecordKindValues.recordedFixture ||
    record.sourceRecordKind === catalogSourceRecordKindValues.importerRequest
  );
}

export function benchmarkProvenanceSummaryFromRecord(
  record: CatalogSourceProvenanceRecord,
): CatalogBenchmarkSeedProvenanceSummary {
  return {
    catalogSource: record.catalogSource,
    sourceId: record.sourceId,
    sourceRecordKind: record.sourceRecordKind,
    sourceVersion: record.sourceVersion,
    fixtureId: stringMetadata(record.metadata, "fixtureId"),
    redactionClass: record.rawContentRedactionClass,
  };
}

export function uniqueBenchmarkProvenanceSummaries(
  summaries: CatalogBenchmarkSeedProvenanceSummary[],
): CatalogBenchmarkSeedProvenanceSummary[] {
  const byKey = new Map<string, CatalogBenchmarkSeedProvenanceSummary>();
  for (const summary of summaries) {
    byKey.set(
      `${summary.catalogSource}:${summary.sourceRecordKind}:${summary.sourceId}:${summary.sourceVersion ?? ""}:${summary.redactionClass}`,
      summary,
    );
  }
  return Array.from(byKey.values()).sort(compareBenchmarkProvenanceSummaries);
}

export function compareBenchmarkProvenanceSummaries(
  left: CatalogBenchmarkSeedProvenanceSummary,
  right: CatalogBenchmarkSeedProvenanceSummary,
): number {
  return (
    left.catalogSource.localeCompare(right.catalogSource) ||
    left.sourceId.localeCompare(right.sourceId) ||
    left.sourceRecordKind.localeCompare(right.sourceRecordKind) ||
    (left.sourceVersion ?? "").localeCompare(right.sourceVersion ?? "")
  );
}
