import {
  CapabilityLevel,
  CapabilityLevelStatusKind,
  capabilityLevelStatusKindValues,
  capabilityLevelValues,
  catalogDemandFactKindValues,
  catalogDemandFacts,
  engineCapabilityReports,
} from "./dependencies.js";
import { CatalogJsonRecord } from "./catalog-domain-01.js";
import {
  CatalogBenchmarkDemandBucket,
  CatalogBenchmarkLocalOwnership,
  CatalogBenchmarkSeedFinderDecision,
  CatalogBenchmarkSeedProvenanceSummary,
  CatalogBenchmarkSeedReadiness,
  CatalogBenchmarkSeedReadinessLevel,
  CatalogCompletenessPool,
  CatalogCompletenessPoolWork,
} from "./catalog-domain-03.js";
import { alphaBenchmarkPoolBaseScore } from "./catalog-domain-09.js";
import { CatalogBenchmarkReadinessResult } from "./catalog-domain-10.js";
import {
  benchmarkDecisionWeight,
  benchmarkDemandBucketWeight,
  benchmarkLocalOwnershipWeight,
  benchmarkReadinessWeight,
} from "./catalog-domain-13.js";
import { uniqueStrings } from "./catalog-domain-16.js";

export function localOwnershipByWork(
  rows: { workId: string | null; owned: boolean }[],
): Map<string, { localOwnership: CatalogBenchmarkLocalOwnership; localEvidenceCount: number }> {
  const aggregate = new Map<string, { count: number; ownedCount: number }>();
  for (const row of rows) {
    if (row.workId === null) {
      continue;
    }
    const existing = aggregate.get(row.workId) ?? { count: 0, ownedCount: 0 };
    existing.count += 1;
    if (row.owned) {
      existing.ownedCount += 1;
    }
    aggregate.set(row.workId, existing);
  }

  const result = new Map<
    string,
    { localOwnership: CatalogBenchmarkLocalOwnership; localEvidenceCount: number }
  >();
  for (const [workId, row] of aggregate) {
    result.set(workId, {
      localOwnership: row.ownedCount > 0 ? "owned" : "not_owned",
      localEvidenceCount: row.count,
    });
  }
  return result;
}

export function demandBucketForFacts(
  facts: (typeof catalogDemandFacts.$inferSelect)[],
): CatalogBenchmarkDemandBucket {
  let dlCount = 0;
  let wishlistCount = 0;
  let bestRank: number | null = null;
  let ratingCount = 0;
  for (const fact of facts) {
    switch (fact.factKind) {
      case catalogDemandFactKindValues.dlCount:
        dlCount = Math.max(dlCount, numberRecordValue(fact.factValue, "count") ?? 0);
        break;
      case catalogDemandFactKindValues.wishlistCount:
        wishlistCount = Math.max(wishlistCount, numberRecordValue(fact.factValue, "count") ?? 0);
        break;
      case catalogDemandFactKindValues.rank: {
        const rank = numberRecordValue(fact.factValue, "rank");
        if (rank !== null) {
          bestRank = bestRank === null ? rank : Math.min(bestRank, rank);
        }
        break;
      }
      case catalogDemandFactKindValues.ratingSummary:
        ratingCount = Math.max(ratingCount, numberRecordValue(fact.factValue, "count") ?? 0);
        break;
      default:
        break;
    }
  }
  if (dlCount === 0 && wishlistCount === 0 && bestRank === null && ratingCount === 0) {
    return facts.length === 0 ? "none" : "low";
  }
  if (dlCount >= 10_000 || wishlistCount >= 5_000 || (bestRank !== null && bestRank <= 10)) {
    return "very_high";
  }
  if (
    dlCount >= 3_000 ||
    wishlistCount >= 1_000 ||
    (bestRank !== null && bestRank <= 50) ||
    ratingCount >= 1_000
  ) {
    return "high";
  }
  if (
    dlCount >= 1_000 ||
    wishlistCount >= 250 ||
    (bestRank !== null && bestRank <= 200) ||
    ratingCount >= 250
  ) {
    return "medium";
  }
  return "low";
}

export function numberRecordValue(record: CatalogJsonRecord, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function capabilityReportsByAdapter(
  rows: (typeof engineCapabilityReports.$inferSelect)[],
): Map<string, Map<CapabilityLevel, CapabilityLevelStatusKind>> {
  const byAdapter = new Map<string, Map<CapabilityLevel, CapabilityLevelStatusKind>>();
  for (const row of rows) {
    const adapterRows = byAdapter.get(row.adapterId) ?? new Map();
    adapterRows.set(row.level, row.statusKind);
    byAdapter.set(row.adapterId, adapterRows);
  }
  return byAdapter;
}

export function readinessForWork(
  engineName: string | null,
  capabilityByAdapterId: Map<string, Map<CapabilityLevel, CapabilityLevelStatusKind>>,
  explicitAdapterIds: string[] | null = null,
): CatalogBenchmarkReadinessResult {
  const adapterId = benchmarkAdapterIdForEngine(
    engineName,
    capabilityByAdapterId,
    explicitAdapterIds,
  );
  const adapterRows = adapterId === null ? null : (capabilityByAdapterId.get(adapterId) ?? null);
  const level = (capabilityLevel: CapabilityLevel): CatalogBenchmarkSeedReadinessLevel =>
    adapterRows?.get(capabilityLevel) ?? "unknown";
  return {
    readiness: {
      adapterId,
      identify: level(capabilityLevelValues.identify),
      inventory: level(capabilityLevelValues.inventory),
      extract: level(capabilityLevelValues.extract),
      patch: level(capabilityLevelValues.patch),
      helper: "unknown",
      runtime: "unknown",
    },
  };
}

export function benchmarkAdapterIdForEngine(
  engineName: string | null,
  capabilityByAdapterId: Map<string, Map<CapabilityLevel, CapabilityLevelStatusKind>>,
  explicitAdapterIds: string[] | null = null,
): string | null {
  if (engineName === null || capabilityByAdapterId.size === 0) {
    return null;
  }
  const normalizedEngine = normalizeBenchmarkAdapterKey(engineName);
  const adapterIds =
    explicitAdapterIds === null
      ? Array.from(capabilityByAdapterId.keys()).sort()
      : explicitAdapterIds.filter((adapterId) => capabilityByAdapterId.has(adapterId)).sort();
  if (adapterIds.length === 0) {
    return null;
  }
  const exactAdapterId = adapterIds.find(
    (adapterId) => normalizeBenchmarkAdapterKey(adapterId) === normalizedEngine,
  );
  if (exactAdapterId !== undefined) {
    return exactAdapterId;
  }
  if (explicitAdapterIds !== null) {
    const prefixMatches = adapterIds.filter((adapterId) =>
      normalizeBenchmarkAdapterKey(adapterId).startsWith(normalizedEngine),
    );
    return prefixMatches.length === 1 ? prefixMatches[0]! : null;
  }
  return (
    adapterIds.find((adapterId) =>
      normalizeBenchmarkAdapterKey(adapterId).startsWith(normalizedEngine),
    ) ?? null
  );
}

export function normalizeBenchmarkAdapterKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "");
}

export function benchmarkExplanationCodes(input: {
  pool: CatalogCompletenessPool;
  work: CatalogCompletenessPoolWork;
  demandBucket: CatalogBenchmarkDemandBucket;
  localOwnership: CatalogBenchmarkLocalOwnership;
  provenance: CatalogBenchmarkSeedProvenanceSummary[];
  readiness: CatalogBenchmarkReadinessResult;
  minCapabilityLevel: CapabilityLevel | null;
  requiredCapabilities: CapabilityLevel[];
  provenanceRequired: boolean;
  conflictRequested: boolean;
}): string[] {
  const codes = [
    `pool:${input.pool}`,
    `demand_bucket:${input.demandBucket}`,
    `local_ownership:${input.localOwnership}`,
    ...benchmarkReadinessExplanationCodes(input.readiness.readiness),
  ];
  if (input.provenance.length === 0) {
    codes.push("unrecorded_or_local_only");
  }
  if (input.provenanceRequired && input.provenance.length === 0) {
    codes.push("excluded_provenance_required");
  }
  if (input.readiness.readiness.adapterId === null) {
    codes.push("readiness_adapter_unknown");
  }
  if (input.minCapabilityLevel !== null) {
    const status = input.readiness.readiness[input.minCapabilityLevel];
    if (status !== capabilityLevelStatusKindValues.supported) {
      codes.push(`excluded_min_capability_${input.minCapabilityLevel}_${status}`);
    }
  }
  for (const capability of input.requiredCapabilities) {
    const status = input.readiness.readiness[capability];
    if (status !== capabilityLevelStatusKindValues.supported) {
      codes.push(`excluded_required_capability_${capability}_${status}`);
    }
  }
  if (input.work.conflicts.length > 0) {
    if (input.conflictRequested) {
      codes.push("conflict_pool_requested");
    } else {
      for (const conflict of input.work.conflicts) {
        codes.push(`demoted_open_conflict:${conflict.conflictId}`);
      }
    }
  }
  return uniqueStrings(codes);
}

export function benchmarkReadinessExplanationCodes(
  readiness: CatalogBenchmarkSeedReadiness,
): string[] {
  return [
    `identify_readiness_${readiness.identify}`,
    `inventory_readiness_${readiness.inventory}`,
    `extract_readiness_${readiness.extract}`,
    `patch_readiness_${readiness.patch}`,
    `helper_readiness_${readiness.helper}`,
    `runtime_readiness_${readiness.runtime}`,
  ];
}

export function benchmarkDecision(
  explanationCodes: string[],
  readiness: CatalogBenchmarkReadinessResult,
  minCapabilityLevel: CapabilityLevel | null,
  requiredCapabilities: CapabilityLevel[],
): CatalogBenchmarkSeedFinderDecision {
  if (explanationCodes.some((code) => code.startsWith("excluded_"))) {
    return "excluded";
  }
  if (explanationCodes.some((code) => code.startsWith("demoted_"))) {
    return "demoted";
  }
  if (minCapabilityLevel !== null) {
    return readiness.readiness[minCapabilityLevel] === capabilityLevelStatusKindValues.supported
      ? "seed"
      : "excluded";
  }
  if (requiredCapabilities.length > 0) {
    return requiredCapabilities.every(
      (capability) => readiness.readiness[capability] === capabilityLevelStatusKindValues.supported,
    )
      ? "seed"
      : "excluded";
  }
  return readiness.readiness.extract === capabilityLevelStatusKindValues.supported
    ? "seed"
    : "candidate";
}

export function benchmarkSortScore(input: {
  pool: CatalogCompletenessPool;
  decision: CatalogBenchmarkSeedFinderDecision;
  demandBucket: CatalogBenchmarkDemandBucket;
  localOwnership: CatalogBenchmarkLocalOwnership;
  readiness: CatalogBenchmarkSeedReadiness;
}): number {
  return (
    benchmarkDecisionWeight(input.decision) +
    alphaBenchmarkPoolBaseScore(input.pool) * 10 +
    benchmarkDemandBucketWeight(input.demandBucket) +
    benchmarkLocalOwnershipWeight(input.localOwnership) +
    benchmarkReadinessWeight(input.readiness)
  );
}
