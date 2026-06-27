export const catalogOpportunityWeightsVersion = "catalog.opportunity_ranking.weights.v0.1";

export const catalogOpportunityFactorValues = {
  translationCompleteness: "translation_completeness",
  localOwnership: "local_ownership",
  dlsiteDemand: "dlsite_demand",
  platformLanguageConflict: "platform_language_conflict",
  marketPrevalence: "market_prevalence",
  adapterReadiness: "adapter_readiness",
  runtimeEvidenceReadiness: "runtime_evidence_readiness",
  existingTranslationStatus: "existing_translation_status",
  benchmarkUsefulness: "benchmark_usefulness",
  unknownEvidence: "unknown_evidence",
} as const;

export type CatalogOpportunityFactorName =
  (typeof catalogOpportunityFactorValues)[keyof typeof catalogOpportunityFactorValues];

export type CatalogOpportunityDecision = "candidate" | "demoted" | "excluded";

export type CatalogOpportunityCompletenessSignal =
  | "no_english"
  | "mtl_only"
  | "fan_partial"
  | "unknown"
  | "conflict";

export type CatalogOpportunityDemandSignal = "none" | "low" | "medium" | "high" | "very_high";

export type CatalogOpportunityLocalOwnershipSignal = "owned" | "not_owned" | "unknown";

export type CatalogOpportunityConflictSignal = "none" | "open_platform_language_conflict";

export type CatalogOpportunityMarketPrevalenceSignal =
  | "public_and_local_aggregate"
  | "public_only"
  | "local_aggregate_only"
  | "unknown";

export type CatalogOpportunityAdapterReadinessSignal =
  | "patch_supported"
  | "extract_supported"
  | "inventory_supported"
  | "identify_supported"
  | "partial"
  | "unsupported"
  | "unknown";

export type CatalogOpportunityRuntimeEvidenceSignal =
  | "public_and_aggregate"
  | "public_fixture"
  | "private_local_aggregate"
  | "unknown";

export type CatalogOpportunityExistingTranslationSignal =
  | "none"
  | "mtl"
  | "fan_partial"
  | "official_or_complete"
  | "unknown";

export type CatalogOpportunityBenchmarkUsefulnessSignal = "high" | "medium" | "low" | "none";

export type CatalogOpportunityUnknownEvidenceSignal = "none" | "present";

export type CatalogOpportunityScoreInput = {
  translationCompleteness: CatalogOpportunityCompletenessSignal;
  localOwnership: CatalogOpportunityLocalOwnershipSignal;
  dlsiteDemand: CatalogOpportunityDemandSignal;
  platformLanguageConflict: CatalogOpportunityConflictSignal;
  marketPrevalence: CatalogOpportunityMarketPrevalenceSignal;
  adapterReadiness: CatalogOpportunityAdapterReadinessSignal;
  runtimeEvidenceReadiness: CatalogOpportunityRuntimeEvidenceSignal;
  existingTranslationStatus: CatalogOpportunityExistingTranslationSignal;
  benchmarkUsefulness: CatalogOpportunityBenchmarkUsefulnessSignal;
  unknownEvidence: CatalogOpportunityUnknownEvidenceSignal;
  evidenceRefs?: Partial<Record<CatalogOpportunityFactorName, string[]>>;
};

export type CatalogOpportunityFactor = {
  factor: CatalogOpportunityFactorName;
  weight: number;
  rawValue: number | string | boolean | null;
  weightedScore: number;
  evidenceRefs: string[];
  explanationCode: string;
};

export type CatalogOpportunityScoreBreakdown = {
  weightsVersion: typeof catalogOpportunityWeightsVersion;
  score: number;
  decision: CatalogOpportunityDecision;
  factors: CatalogOpportunityFactor[];
  explanationCodes: string[];
};

export function scoreCatalogOpportunity(
  input: CatalogOpportunityScoreInput,
): CatalogOpportunityScoreBreakdown {
  const factors: CatalogOpportunityFactor[] = [
    factor(
      catalogOpportunityFactorValues.translationCompleteness,
      30,
      translationCompletenessValue(input.translationCompleteness),
      `translation_completeness:${input.translationCompleteness}`,
      input,
    ),
    factor(
      catalogOpportunityFactorValues.localOwnership,
      8,
      localOwnershipValue(input.localOwnership),
      `local_ownership:${input.localOwnership}`,
      input,
    ),
    factor(
      catalogOpportunityFactorValues.dlsiteDemand,
      20,
      demandValue(input.dlsiteDemand),
      `dlsite_demand:${input.dlsiteDemand}`,
      input,
    ),
    factor(
      catalogOpportunityFactorValues.platformLanguageConflict,
      -60,
      input.platformLanguageConflict === "open_platform_language_conflict" ? 1 : 0,
      `platform_language_conflict:${input.platformLanguageConflict}`,
      input,
    ),
    factor(
      catalogOpportunityFactorValues.marketPrevalence,
      8,
      marketPrevalenceValue(input.marketPrevalence),
      `market_prevalence:${input.marketPrevalence}`,
      input,
    ),
    factor(
      catalogOpportunityFactorValues.adapterReadiness,
      18,
      adapterReadinessValue(input.adapterReadiness),
      `adapter_readiness:${input.adapterReadiness}`,
      input,
    ),
    factor(
      catalogOpportunityFactorValues.runtimeEvidenceReadiness,
      6,
      runtimeEvidenceValue(input.runtimeEvidenceReadiness),
      `runtime_evidence_readiness:${input.runtimeEvidenceReadiness}`,
      input,
    ),
    factor(
      catalogOpportunityFactorValues.existingTranslationStatus,
      -20,
      existingTranslationValue(input.existingTranslationStatus),
      `existing_translation_status:${input.existingTranslationStatus}`,
      input,
    ),
    factor(
      catalogOpportunityFactorValues.benchmarkUsefulness,
      10,
      benchmarkUsefulnessValue(input.benchmarkUsefulness),
      `benchmark_usefulness:${input.benchmarkUsefulness}`,
      input,
    ),
    factor(
      catalogOpportunityFactorValues.unknownEvidence,
      0,
      input.unknownEvidence === "present" ? 1 : 0,
      `unknown_evidence:${input.unknownEvidence}`,
      input,
    ),
  ];
  const score = roundScore(factors.reduce((sum, row) => sum + row.weightedScore, 0));
  return {
    weightsVersion: catalogOpportunityWeightsVersion,
    score,
    decision: opportunityDecision(input),
    factors,
    explanationCodes: factors.map((row) => row.explanationCode),
  };
}

function factor(
  factorName: CatalogOpportunityFactorName,
  weight: number,
  rawValue: number,
  explanationCode: string,
  input: CatalogOpportunityScoreInput,
): CatalogOpportunityFactor {
  return {
    factor: factorName,
    weight,
    rawValue,
    weightedScore: roundScore(weight * rawValue),
    evidenceRefs: [...(input.evidenceRefs?.[factorName] ?? [])].sort(),
    explanationCode,
  };
}

function opportunityDecision(input: CatalogOpportunityScoreInput): CatalogOpportunityDecision {
  if (input.existingTranslationStatus === "official_or_complete") {
    return "excluded";
  }
  if (input.platformLanguageConflict === "open_platform_language_conflict") {
    return "demoted";
  }
  return "candidate";
}

function translationCompletenessValue(value: CatalogOpportunityCompletenessSignal): number {
  switch (value) {
    case "no_english":
      return 1;
    case "mtl_only":
      return 0.75;
    case "fan_partial":
      return 0.65;
    case "unknown":
      return 0.25;
    case "conflict":
      return 0.1;
  }
}

function localOwnershipValue(value: CatalogOpportunityLocalOwnershipSignal): number {
  switch (value) {
    case "owned":
      return 1;
    case "not_owned":
      return -0.5;
    case "unknown":
      return 0;
  }
}

function demandValue(value: CatalogOpportunityDemandSignal): number {
  switch (value) {
    case "very_high":
      return 1;
    case "high":
      return 0.75;
    case "medium":
      return 0.45;
    case "low":
      return 0.15;
    case "none":
      return 0;
  }
}

function marketPrevalenceValue(value: CatalogOpportunityMarketPrevalenceSignal): number {
  switch (value) {
    case "public_and_local_aggregate":
      return 1;
    case "public_only":
      return 0.7;
    case "local_aggregate_only":
      return 0.45;
    case "unknown":
      return 0;
  }
}

function adapterReadinessValue(value: CatalogOpportunityAdapterReadinessSignal): number {
  switch (value) {
    case "patch_supported":
      return 1;
    case "extract_supported":
      return 0.75;
    case "inventory_supported":
      return 0.4;
    case "identify_supported":
      return 0.2;
    case "partial":
      return 0.05;
    case "unsupported":
      return -0.6;
    case "unknown":
      return -0.2;
  }
}

function runtimeEvidenceValue(value: CatalogOpportunityRuntimeEvidenceSignal): number {
  switch (value) {
    case "public_and_aggregate":
      return 1;
    case "public_fixture":
      return 0.7;
    case "private_local_aggregate":
      return 0.55;
    case "unknown":
      return 0;
  }
}

function existingTranslationValue(value: CatalogOpportunityExistingTranslationSignal): number {
  switch (value) {
    case "official_or_complete":
      return 1;
    case "fan_partial":
      return 0.25;
    case "mtl":
      return 0.1;
    case "none":
    case "unknown":
      return 0;
  }
}

function benchmarkUsefulnessValue(value: CatalogOpportunityBenchmarkUsefulnessSignal): number {
  switch (value) {
    case "high":
      return 1;
    case "medium":
      return 0.6;
    case "low":
      return 0.25;
    case "none":
      return 0;
  }
}

function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}
