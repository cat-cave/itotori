import {
  CatalogOpportunityAdapterReadinessSignal,
  CatalogOpportunityCompletenessSignal,
  CatalogOpportunityMarketPrevalenceSignal,
  CatalogOpportunityRuntimeEvidenceSignal,
  CatalogOpportunityWorkTypeSignal,
  and,
  capabilityLevelStatusKindValues,
  catalogDemandFactKindValues,
  catalogDemandFacts,
  engineCapabilityEvidence,
  engineCapabilityEvidenceKindValues,
  engineCapabilityEvidenceSourceValues,
  engineCapabilityEvidenceStatusValues,
} from "./dependencies.js";
import { CatalogJsonRecord } from "./catalog-domain-01.js";
import {
  CatalogBenchmarkSeedProvenanceSummary,
  CatalogBenchmarkSeedReadiness,
  CatalogBenchmarkSeedSourceId,
  CatalogCompletenessPool,
  CatalogOpportunityDemandFacts,
  CatalogOpportunityRuntimeEvidenceReadiness,
  catalogCompletenessPoolValues,
} from "./catalog-domain-03.js";
import { CatalogOpportunityEvidenceCounts } from "./catalog-domain-10.js";
import { demandBucketForFacts, numberRecordValue } from "./catalog-domain-11.js";

export function opportunityDemandFacts(
  facts: (typeof catalogDemandFacts.$inferSelect)[],
): CatalogOpportunityDemandFacts {
  let dlCount: number | null = null;
  let wishlistCount: number | null = null;
  let bestRank: number | null = null;
  let ratingAverage: number | null = null;
  let ratingCount: number | null = null;
  let workType: string | null = null;
  for (const fact of facts) {
    switch (fact.factKind) {
      case catalogDemandFactKindValues.dlCount:
        dlCount = maxNullable(dlCount, numberRecordValue(fact.factValue, "count"));
        break;
      case catalogDemandFactKindValues.wishlistCount:
        wishlistCount = maxNullable(wishlistCount, numberRecordValue(fact.factValue, "count"));
        break;
      case catalogDemandFactKindValues.rank: {
        const rank = numberRecordValue(fact.factValue, "rank");
        if (rank !== null) {
          bestRank = bestRank === null ? rank : Math.min(bestRank, rank);
        }
        break;
      }
      case catalogDemandFactKindValues.ratingSummary:
        ratingAverage = maxNullable(
          ratingAverage,
          numberRecordValue(fact.factValue, "average") ?? numberRecordValue(fact.factValue, "mean"),
        );
        ratingCount = maxNullable(ratingCount, numberRecordValue(fact.factValue, "count"));
        break;
      case catalogDemandFactKindValues.workType:
        workType =
          stringRecordValue(fact.factValue, "workType") ??
          stringRecordValue(fact.factValue, "value");
        break;
      default:
        break;
    }
  }
  return {
    demandBucket: demandBucketForFacts(facts),
    dlCount,
    ratingAverage,
    ratingCount,
    wishlistCount,
    bestRank,
    workType,
  };
}

export function maxNullable(left: number | null, right: number | null): number | null {
  if (left === null) {
    return right;
  }
  if (right === null) {
    return left;
  }
  return Math.max(left, right);
}

export function stringRecordValue(record: CatalogJsonRecord, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function opportunityDemandEvidenceRefs(facts: CatalogOpportunityDemandFacts): string[] {
  return [
    facts.dlCount === null ? null : `dl_count:${facts.dlCount}`,
    facts.ratingAverage === null ? null : `rating_average:${facts.ratingAverage}`,
    facts.ratingCount === null ? null : `rating_count:${facts.ratingCount}`,
    facts.wishlistCount === null ? null : `wishlist_count:${facts.wishlistCount}`,
    facts.bestRank === null ? null : `best_rank:${facts.bestRank}`,
    facts.workType === null ? null : `work_type:${facts.workType}`,
  ].filter((value): value is string => value !== null);
}

// Runtime-readiness evidence for opportunity ranking is an intentional source split, NOT a dead
// branch. `publicFixtureEvidenceCount` is only incremented by `public_fixture` evidence whose kind
// is `key_validation` (a genuine runtime check, e.g. validating decryption keys against a public
// fixture). `public_fixture` `adapter_matrix` rows describe the static capability matrix and are
// deliberately excluded here so a declared matrix cannot masquerade as runtime readiness.
//
// The current production producer (apps/itotori catalog-local-capability-evidence) only emits
// `private_local_aggregate` sidecar evidence plus `public_fixture` `adapter_matrix` matrices, so
// in production these counts keep `publicFixtureEvidenceCount` at 0 until a `key_validation`
// public-fixture producer exists. The read-model intentionally still surfaces public runtime
// readiness states because this query genuinely produces them once `key_validation` evidence is
// present — locked end-to-end by catalog-repository.test.ts ("counts public fixture and private
// aggregate runtime evidence in opportunity ranking") and the negative case ("public_fixture
// adapter_matrix evidence is not runtime readiness"). The read-model therefore advertises no state
// the DB path cannot emit.
export function capabilityEvidenceCountsByAdapter(
  rows: (typeof engineCapabilityEvidence.$inferSelect)[],
): Map<string, CatalogOpportunityEvidenceCounts> {
  const byAdapter = new Map<string, CatalogOpportunityEvidenceCounts>();
  for (const row of rows) {
    const evidenceWeight = opportunityRuntimeEvidenceWeight(row.status);
    if (evidenceWeight === 0) {
      continue;
    }
    if (!isRuntimeReadinessEvidence(row)) {
      continue;
    }
    const existing = byAdapter.get(row.adapterId) ?? {
      publicFixtureEvidenceCount: 0,
      privateLocalAggregateEvidenceCount: 0,
    };
    if (row.evidenceSource === engineCapabilityEvidenceSourceValues.publicFixture) {
      existing.publicFixtureEvidenceCount += evidenceWeight;
    }
    if (row.evidenceSource === engineCapabilityEvidenceSourceValues.privateLocalAggregate) {
      existing.privateLocalAggregateEvidenceCount += evidenceWeight;
    }
    byAdapter.set(row.adapterId, existing);
  }
  return byAdapter;
}

export function isRuntimeReadinessEvidence(
  row: typeof engineCapabilityEvidence.$inferSelect,
): boolean {
  if (row.evidenceSource === engineCapabilityEvidenceSourceValues.publicFixture) {
    return row.evidenceKind === engineCapabilityEvidenceKindValues.keyValidation;
  }
  if (row.evidenceSource === engineCapabilityEvidenceSourceValues.privateLocalAggregate) {
    return (
      row.evidenceKind === engineCapabilityEvidenceKindValues.localCorpusSidecar ||
      row.evidenceKind === engineCapabilityEvidenceKindValues.engineMarkerCount
    );
  }
  return false;
}

export function opportunityRuntimeEvidenceWeight(
  status: (typeof engineCapabilityEvidence.$inferSelect)["status"],
): number {
  if (status === engineCapabilityEvidenceStatusValues.present) {
    return 1;
  }
  if (status === engineCapabilityEvidenceStatusValues.partial) {
    return 0.5;
  }
  return 0;
}

export function opportunityRuntimeEvidenceReadiness(
  counts: CatalogOpportunityEvidenceCounts | null | undefined,
): CatalogOpportunityRuntimeEvidenceReadiness {
  const publicFixtureEvidenceCount = counts?.publicFixtureEvidenceCount ?? 0;
  const privateLocalAggregateEvidenceCount = counts?.privateLocalAggregateEvidenceCount ?? 0;
  const hasPublicFixtureEvidence = publicFixtureEvidenceCount > 0;
  const hasPrivateLocalAggregateEvidence = privateLocalAggregateEvidenceCount > 0;
  const hasCompletePublicFixtureEvidence = publicFixtureEvidenceCount >= 1;
  const hasCompletePrivateLocalAggregateEvidence = privateLocalAggregateEvidenceCount >= 1;
  const status: CatalogOpportunityRuntimeEvidenceSignal =
    hasPublicFixtureEvidence && hasPrivateLocalAggregateEvidence
      ? hasCompletePublicFixtureEvidence && hasCompletePrivateLocalAggregateEvidence
        ? "public_and_aggregate"
        : "partial_public_and_aggregate"
      : hasPublicFixtureEvidence
        ? hasCompletePublicFixtureEvidence
          ? "public_fixture"
          : "partial_public_fixture"
        : hasPrivateLocalAggregateEvidence
          ? hasCompletePrivateLocalAggregateEvidence
            ? "private_local_aggregate"
            : "partial_private_local_aggregate"
          : "unknown";
  return {
    status,
    publicFixtureEvidenceCount,
    privateLocalAggregateEvidenceCount,
  };
}

export function opportunityMarketPrevalence(
  sourceIds: CatalogBenchmarkSeedSourceId[],
  localEvidenceCount: number,
): CatalogOpportunityMarketPrevalenceSignal {
  if (sourceIds.length > 0 && localEvidenceCount > 0) {
    return "public_and_local_aggregate";
  }
  if (sourceIds.length > 0) {
    return "public_only";
  }
  if (localEvidenceCount > 0) {
    return "local_aggregate_only";
  }
  return "unknown";
}

export function opportunityCompletenessSignal(
  pool: CatalogCompletenessPool,
): CatalogOpportunityCompletenessSignal {
  switch (pool) {
    case catalogCompletenessPoolValues.noEnglish:
      return "no_english";
    case catalogCompletenessPoolValues.mtlOnly:
      return "mtl_only";
    case catalogCompletenessPoolValues.fanPartial:
      return "fan_partial";
    case catalogCompletenessPoolValues.unknown:
      return "unknown";
    case catalogCompletenessPoolValues.conflict:
      return "conflict";
  }
}

export function opportunityWorkTypeSignal(
  workType: string | null,
): CatalogOpportunityWorkTypeSignal {
  if (workType === null) {
    return "unknown";
  }
  const normalized = workType.toLowerCase().replace(/[^a-z0-9]+/gu, "");
  if (normalized.includes("rpg")) {
    return "rpg";
  }
  if (
    normalized.includes("game") ||
    normalized.includes("adv") ||
    normalized.includes("slg") ||
    normalized.includes("act")
  ) {
    return "game";
  }
  return "non_game";
}

export function hasPublicOpportunityIdentity(
  sourceIds: CatalogBenchmarkSeedSourceId[],
  provenance: CatalogBenchmarkSeedProvenanceSummary[],
): boolean {
  return sourceIds.length > 0 || provenance.length > 0;
}

export function opportunityAdapterReadiness(
  readiness: CatalogBenchmarkSeedReadiness,
): CatalogOpportunityAdapterReadinessSignal {
  if (readiness.patch === capabilityLevelStatusKindValues.supported) {
    return "patch_supported";
  }
  if (readiness.extract === capabilityLevelStatusKindValues.supported) {
    return "extract_supported";
  }
  if (readiness.inventory === capabilityLevelStatusKindValues.supported) {
    return "inventory_supported";
  }
  if (readiness.identify === capabilityLevelStatusKindValues.supported) {
    return "identify_supported";
  }
  if (
    readiness.identify === capabilityLevelStatusKindValues.partial ||
    readiness.inventory === capabilityLevelStatusKindValues.partial ||
    readiness.extract === capabilityLevelStatusKindValues.partial ||
    readiness.patch === capabilityLevelStatusKindValues.partial
  ) {
    return "partial";
  }
  if (
    readiness.identify === capabilityLevelStatusKindValues.unsupported ||
    readiness.inventory === capabilityLevelStatusKindValues.unsupported ||
    readiness.extract === capabilityLevelStatusKindValues.unsupported ||
    readiness.patch === capabilityLevelStatusKindValues.unsupported
  ) {
    return "unsupported";
  }
  return "unknown";
}
