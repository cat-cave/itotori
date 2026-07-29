import {
  CapabilityLevel,
  CatalogLanguageStatus,
  CatalogOpportunityDecision,
  CatalogOpportunityExistingTranslationSignal,
  CatalogOpportunityUnknownEvidenceSignal,
  capabilityLevelStatusKindValues,
  capabilityLevelValues,
  catalogLanguageStatusValues,
  catalogPlatformLanguageConflictReasonCode,
} from "./dependencies.js";
import { CatalogJsonRecord } from "./catalog-record-types.js";
import {
  CatalogAlphaBenchmarkOpportunity,
  CatalogBenchmarkDemandBucket,
  CatalogBenchmarkLocalOwnership,
  CatalogBenchmarkSeedFinderDecision,
  CatalogBenchmarkSeedProvenanceSummary,
  CatalogBenchmarkSeedReadiness,
  CatalogCompletenessPool,
  CatalogCompletenessPoolWork,
  CatalogCompletenessPublicReport,
  CatalogCompletenessPublicStatusReport,
  CatalogCompletenessStatusFact,
  CatalogConflictReviewRow,
  catalogCompletenessPoolValues,
} from "./catalog-read-model-types.js";
import {
  CatalogOpportunityDemotion,
  catalogCompletenessPools,
  catalogLanguageStatusEnums,
} from "./catalog-repository-port-and-enums.js";
import {
  DraftCatalogBenchmarkSeedRow,
  DraftCatalogOpportunityRow,
} from "./catalog-benchmark-helpers.js";
import { stringMetadata, uniqueSourceIds } from "./catalog-conflict-utils.js";

export function opportunityExistingTranslationStatus(
  statuses: CatalogCompletenessStatusFact[],
): CatalogOpportunityExistingTranslationSignal {
  const statusValues = statuses.map((status) => status.status);
  if (
    statusValues.includes(catalogLanguageStatusValues.officialFull) ||
    statusValues.includes(catalogLanguageStatusValues.fanFull)
  ) {
    return "official_or_complete";
  }
  if (statusValues.includes(catalogLanguageStatusValues.fanPartial)) {
    return "fan_partial";
  }
  if (statusValues.includes(catalogLanguageStatusValues.mtl)) {
    return "mtl";
  }
  if (statusValues.includes(catalogLanguageStatusValues.none)) {
    return "none";
  }
  return "unknown";
}

export function opportunityBenchmarkUsefulness(
  pool: CatalogCompletenessPool,
  demandBucket: CatalogBenchmarkDemandBucket,
): "high" | "medium" | "low" | "none" {
  if (pool === catalogCompletenessPoolValues.noEnglish && demandBucket !== "none") {
    return "high";
  }
  if (
    (pool === catalogCompletenessPoolValues.mtlOnly ||
      pool === catalogCompletenessPoolValues.fanPartial) &&
    (demandBucket === "very_high" || demandBucket === "high" || demandBucket === "medium")
  ) {
    return "medium";
  }
  if (pool === catalogCompletenessPoolValues.unknown || demandBucket === "low") {
    return "low";
  }
  return "none";
}

export function opportunityUnknownEvidence(
  readiness: CatalogBenchmarkSeedReadiness,
  provenance: CatalogBenchmarkSeedProvenanceSummary[],
): CatalogOpportunityUnknownEvidenceSignal {
  if (
    provenance.length === 0 ||
    readiness.adapterId === null ||
    readiness.identify === "unknown" ||
    readiness.inventory === "unknown" ||
    readiness.extract === "unknown" ||
    readiness.patch === "unknown"
  ) {
    return "present";
  }
  return "none";
}

export function catalogOpportunityDemotionFromConflict(
  row: CatalogConflictReviewRow,
): CatalogOpportunityDemotion {
  return {
    reasonCode: row.reasonCode,
    conflictOrigin: row.conflictOrigin,
    conflictId: row.conflictId,
    severity: row.severity,
    sourceIds: row.sourceIds,
  };
}

export function catalogOpportunityConflictAppliesToTargetLanguage(
  row: CatalogConflictReviewRow,
  rawConflictMetadataById: Map<string, CatalogJsonRecord>,
  targetLanguage: string,
): boolean {
  if (row.reasonCode !== catalogPlatformLanguageConflictReasonCode) {
    return false;
  }
  if (row.conflictId === null) {
    return false;
  }
  const metadata = rawConflictMetadataById.get(row.conflictId);
  return metadata !== undefined && stringMetadata(metadata, "targetLanguage") === targetLanguage;
}

export function compareCatalogOpportunityDemotions(
  left: CatalogOpportunityDemotion,
  right: CatalogOpportunityDemotion,
): number {
  return (
    left.reasonCode.localeCompare(right.reasonCode) ||
    (left.conflictId ?? "").localeCompare(right.conflictId ?? "")
  );
}

export function compareCatalogOpportunityDrafts(
  left: DraftCatalogOpportunityRow,
  right: DraftCatalogOpportunityRow,
): number {
  return (
    opportunityDecisionOrder(left.row.decision) - opportunityDecisionOrder(right.row.decision) ||
    right.row.score - left.row.score ||
    left.row.canonicalTitle.localeCompare(right.row.canonicalTitle) ||
    left.row.workId.localeCompare(right.row.workId)
  );
}

export function opportunityDecisionOrder(decision: CatalogOpportunityDecision): number {
  switch (decision) {
    case "candidate":
      return 0;
    case "demoted":
      return 1;
    case "excluded":
      return 2;
  }
}

export function benchmarkDecisionWeight(decision: CatalogBenchmarkSeedFinderDecision): number {
  switch (decision) {
    case "seed":
      return 10_000;
    case "candidate":
      return 5_000;
    case "demoted":
      return 1_000;
    case "excluded":
      return 0;
  }
}

export function benchmarkDemandBucketWeight(bucket: CatalogBenchmarkDemandBucket): number {
  switch (bucket) {
    case "very_high":
      return 500;
    case "high":
      return 300;
    case "medium":
      return 150;
    case "low":
      return 50;
    case "none":
      return 0;
  }
}

export function benchmarkLocalOwnershipWeight(ownership: CatalogBenchmarkLocalOwnership): number {
  switch (ownership) {
    case "owned":
      return 75;
    case "unknown":
      return 0;
    case "not_owned":
      return -50;
  }
}

export function benchmarkReadinessWeight(readiness: CatalogBenchmarkSeedReadiness): number {
  if (readiness.patch === capabilityLevelStatusKindValues.supported) {
    return 120;
  }
  if (readiness.extract === capabilityLevelStatusKindValues.supported) {
    return 100;
  }
  if (readiness.inventory === capabilityLevelStatusKindValues.supported) {
    return 50;
  }
  if (readiness.identify === capabilityLevelStatusKindValues.supported) {
    return 25;
  }
  return 0;
}

export function compareBenchmarkSeedDrafts(
  left: DraftCatalogBenchmarkSeedRow,
  right: DraftCatalogBenchmarkSeedRow,
): number {
  return (
    right.sortScore - left.sortScore ||
    left.row.canonicalTitle.localeCompare(right.row.canonicalTitle) ||
    left.row.workId.localeCompare(right.row.workId)
  );
}

export function uniqueBenchmarkPools(pools: CatalogCompletenessPool[]): CatalogCompletenessPool[] {
  return catalogCompletenessPools.filter((pool) => pools.includes(pool));
}

export function uniqueCatalogLanguageStatuses(
  statuses: CatalogLanguageStatus[],
): CatalogLanguageStatus[] {
  return catalogLanguageStatusEnums.filter((status) => statuses.includes(status));
}

export function uniqueCapabilityLevels(levels: CapabilityLevel[]): CapabilityLevel[] {
  const capabilityLevels = Object.values(capabilityLevelValues) as CapabilityLevel[];
  return capabilityLevels.filter((level) => levels.includes(level));
}

export function compareAlphaBenchmarkOpportunities(
  left: CatalogAlphaBenchmarkOpportunity,
  right: CatalogAlphaBenchmarkOpportunity,
): number {
  return (
    right.score - left.score ||
    left.canonicalTitle.localeCompare(right.canonicalTitle) ||
    left.workId.localeCompare(right.workId)
  );
}

export function publicCompletenessReport(
  targetLanguage: string,
  pools: Record<CatalogCompletenessPool, CatalogCompletenessPoolWork[]>,
): CatalogCompletenessPublicReport {
  // Aggregate counts must dedupe by identity: a single work can appear in
  // multiple overlapping pools (e.g. fan_partial AND conflict), so summing the
  // per-pool statuses/conflicts here would double-count. We count each
  // language-status once by its languageStatusId and each conflict once by its
  // conflictId. Pool-local work counts (workCount below) intentionally stay
  // per-pool — a work legitimately belongs to each of its pools locally.
  const workIds = new Set<string>();
  const seenStatusIds = new Set<string>();
  const conflictIds = new Set<string>();
  const statusReports = new Map<CatalogLanguageStatus, CatalogCompletenessPublicStatusReport>();
  for (const works of Object.values(pools)) {
    for (const work of works) {
      workIds.add(work.workId);
      for (const conflict of work.conflicts) {
        conflictIds.add(conflict.conflictId);
      }
      for (const status of work.statuses) {
        if (seenStatusIds.has(status.languageStatusId)) {
          continue;
        }
        seenStatusIds.add(status.languageStatusId);
        const existing = statusReports.get(status.status) ?? {
          status: status.status,
          factCount: 0,
          sourceIds: [],
        };
        existing.factCount += 1;
        existing.sourceIds = uniqueSourceIds([
          ...existing.sourceIds,
          ...(status.source === null
            ? []
            : [{ catalogSource: status.source.catalogSource, sourceId: status.source.sourceId }]),
        ]);
        statusReports.set(status.status, existing);
      }
    }
  }
  return {
    schemaVersion: "catalog.completeness_public_report.v0.1",
    targetLanguage,
    generatedAt: new Date(),
    totalWorkCount: workIds.size,
    conflictCount: conflictIds.size,
    pools: catalogCompletenessPools.map((pool) => ({
      pool,
      workCount: pools[pool].length,
      sourceIds: uniqueSourceIds(pools[pool].flatMap((work) => work.sourceIds)),
    })),
    statuses: Array.from(statusReports.values()).sort((left, right) =>
      left.status.localeCompare(right.status),
    ),
  };
}

export function compareCompletenessPoolWorks(
  left: CatalogCompletenessPoolWork,
  right: CatalogCompletenessPoolWork,
): number {
  return (
    left.canonicalTitle.localeCompare(right.canonicalTitle) ||
    left.workId.localeCompare(right.workId)
  );
}
