import {
  CatalogConfidence,
  CatalogContextPanelReadModel,
  CatalogOpportunityFactorName,
  CatalogSource,
  catalogConfidenceValues,
  catalogSourceValues,
} from "./dependencies.js";
import { STRICT_API_BODY_KEYS } from "./api-domain-02.js";
import {
  assertCatalogBenchmarkSeedProvenance,
  assertCatalogBenchmarkSeedReadiness,
  assertCatalogBenchmarkSeedSourceIds,
  assertCatalogBenchmarkSeedTranslationStatuses,
  assertLocaleBranchStatus,
  assertNullablePublicBenchmarkSeedString,
  assertNullablePublicOpportunityString,
  assertPublicBenchmarkSeedString,
  assertPublicBenchmarkSeedStringArray,
  assertPublicOpportunityString,
  assertPublicOpportunityStringArray,
} from "./api-domain-13.js";
import { asRecord } from "./api-domain-28.js";
import {
  asArray,
  asStrictRecord,
  assertBoolean,
  assertDateLike,
  assertEnum,
  assertFiniteNumber,
  assertLiteral,
  assertNonNegativeInteger,
  assertNonNegativeNumber,
  assertNullableNonNegativeInteger,
  assertNullableNonNegativeNumber,
} from "./api-domain-29.js";

export function assertCatalogOpportunityDemandFacts(value: unknown, label: string): void {
  const facts = asStrictRecord(value, label, [
    "demandBucket",
    "dlCount",
    "ratingAverage",
    "ratingCount",
    "wishlistCount",
    "bestRank",
    "workType",
  ]);
  assertEnum(
    facts.demandBucket,
    ["none", "low", "medium", "high", "very_high"] as const,
    `${label}.demandBucket`,
  );
  assertNullableNonNegativeInteger(facts.dlCount, `${label}.dlCount`);
  assertNullableNonNegativeNumber(facts.ratingAverage, `${label}.ratingAverage`);
  assertNullableNonNegativeInteger(facts.ratingCount, `${label}.ratingCount`);
  assertNullableNonNegativeInteger(facts.wishlistCount, `${label}.wishlistCount`);
  assertNullableNonNegativeInteger(facts.bestRank, `${label}.bestRank`);
  assertNullablePublicOpportunityString(facts.workType, `${label}.workType`);
}

export function assertCatalogOpportunityFactors(value: unknown, label: string): void {
  const factors = asArray(value, label);
  for (const [index, factorValue] of factors.entries()) {
    const factorLabel = `${label}[${index}]`;
    const factor = asStrictRecord(factorValue, factorLabel, [
      "factor",
      "weight",
      "rawValue",
      "weightedScore",
      "evidenceRefs",
      "explanationCode",
    ]);
    assertEnum(
      factor.factor,
      [
        "translation_completeness",
        "local_ownership",
        "dlsite_demand",
        "platform_language_conflict",
        "market_prevalence",
        "adapter_readiness",
        "runtime_evidence_readiness",
        "dlsite_work_type",
        "existing_translation_status",
        "benchmark_usefulness",
        "unknown_evidence",
      ] as CatalogOpportunityFactorName[],
      `${factorLabel}.factor`,
    );
    assertFiniteNumber(factor.weight, `${factorLabel}.weight`);
    assertCatalogOpportunityRawValue(factor.rawValue, `${factorLabel}.rawValue`);
    assertFiniteNumber(factor.weightedScore, `${factorLabel}.weightedScore`);
    assertPublicOpportunityStringArray(factor.evidenceRefs, `${factorLabel}.evidenceRefs`);
    assertPublicOpportunityString(factor.explanationCode, `${factorLabel}.explanationCode`);
  }
}

export function assertCatalogOpportunityRawValue(value: unknown, label: string): void {
  if (value === null || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    assertFiniteNumber(value, label);
    return;
  }
  assertPublicOpportunityString(value, label);
}

export function assertCatalogOpportunityDemotions(value: unknown, label: string): void {
  const demotions = asArray(value, label);
  for (const [index, demotionValue] of demotions.entries()) {
    const demotionLabel = `${label}[${index}]`;
    const demotion = asStrictRecord(demotionValue, demotionLabel, [
      "reasonCode",
      "conflictOrigin",
      "conflictId",
      "severity",
      "sourceIds",
    ]);
    assertPublicOpportunityString(demotion.reasonCode, `${demotionLabel}.reasonCode`);
    assertEnum(
      demotion.conflictOrigin,
      ["fixture_authored", "repository_derived"] as const,
      `${demotionLabel}.conflictOrigin`,
    );
    assertNullablePublicOpportunityString(demotion.conflictId, `${demotionLabel}.conflictId`);
    assertEnum(
      demotion.severity,
      ["error", "warning", "info"] as const,
      `${demotionLabel}.severity`,
    );
    assertCatalogOpportunityDemotionSourceIds(demotion.sourceIds, `${demotionLabel}.sourceIds`);
  }
}

export function assertCatalogOpportunityDemotionSourceIds(value: unknown, label: string): void {
  const sourceIds = asArray(value, label);
  for (const [index, sourceIdValue] of sourceIds.entries()) {
    const sourceId = asStrictRecord(sourceIdValue, `${label}[${index}]`, [
      "catalogSource",
      "sourceId",
    ]);
    assertEnum(
      sourceId.catalogSource,
      Object.values(catalogSourceValues) as CatalogSource[],
      `${label}[${index}].catalogSource`,
    );
    if (sourceId.catalogSource === catalogSourceValues.localCorpus) {
      throw new Error(`${label}[${index}].catalogSource must not expose local corpus sources`);
    }
    assertPublicOpportunityString(sourceId.sourceId, `${label}[${index}].sourceId`);
  }
}

export function assertCatalogContextPanelReadModel(
  value: unknown,
  label = "CatalogContextPanelReadModel",
): asserts value is CatalogContextPanelReadModel {
  const model = asStrictRecord(value, label, STRICT_API_BODY_KEYS.CatalogContextPanelReadModel);
  assertLiteral(model.schemaVersion, "catalog.context_panel_route.v0.1", `${label}.schemaVersion`);
  assertDateLike(model.generatedAt, `${label}.generatedAt`);
  const params = asStrictRecord(model.params, `${label}.params`, [
    "projectId",
    "localeBranchId",
    "workId",
  ]);
  assertPublicBenchmarkSeedString(params.projectId, `${label}.params.projectId`);
  assertPublicBenchmarkSeedString(params.localeBranchId, `${label}.params.localeBranchId`);
  assertPublicBenchmarkSeedString(params.workId, `${label}.params.workId`);
  assertCatalogBenchmarkSeedRow(model.row, `${label}.row`);
  assertCatalogReleaseRecords(model.releases, `${label}.releases`);
  const projectState = asStrictRecord(model.projectState, `${label}.projectState`, [
    "targetLanguage",
    "localeBranch",
  ]);
  assertPublicBenchmarkSeedString(
    projectState.targetLanguage,
    `${label}.projectState.targetLanguage`,
  );
  if (projectState.localeBranch !== null) {
    assertLocaleBranchStatus(projectState.localeBranch, `${label}.projectState.localeBranch`);
  }
}

export function assertCatalogBenchmarkSeedRow(value: unknown, label: string): void {
  const row = asStrictRecord(value, label, [
    "workId",
    "canonicalTitle",
    "originalLanguage",
    "sourceIds",
    "completenessPool",
    "translationStatuses",
    "localOwnership",
    "localEvidenceCount",
    "demandBucket",
    "readiness",
    "provenance",
    "decision",
    "rank",
    "seedRank",
    "explanationCodes",
  ]);
  assertPublicBenchmarkSeedString(row.workId, `${label}.workId`);
  assertPublicBenchmarkSeedString(row.canonicalTitle, `${label}.canonicalTitle`);
  assertNullablePublicBenchmarkSeedString(row.originalLanguage, `${label}.originalLanguage`);
  assertCatalogBenchmarkSeedSourceIds(row.sourceIds, `${label}.sourceIds`);
  assertEnum(
    row.completenessPool,
    ["mtl_only", "fan_partial", "no_english", "unknown", "conflict"] as const,
    `${label}.completenessPool`,
  );
  assertCatalogBenchmarkSeedTranslationStatuses(
    row.translationStatuses,
    `${label}.translationStatuses`,
  );
  assertEnum(
    row.localOwnership,
    ["owned", "not_owned", "unknown"] as const,
    `${label}.localOwnership`,
  );
  assertNonNegativeNumber(row.localEvidenceCount, `${label}.localEvidenceCount`);
  assertEnum(
    row.demandBucket,
    ["none", "low", "medium", "high", "very_high"] as const,
    `${label}.demandBucket`,
  );
  assertCatalogBenchmarkSeedReadiness(row.readiness, `${label}.readiness`);
  assertCatalogBenchmarkSeedProvenance(row.provenance, `${label}.provenance`);
  assertEnum(
    row.decision,
    ["seed", "candidate", "demoted", "excluded"] as const,
    `${label}.decision`,
  );
  assertNonNegativeInteger(row.rank, `${label}.rank`);
  if (row.seedRank !== null) {
    assertNonNegativeInteger(row.seedRank, `${label}.seedRank`);
  }
  assertPublicBenchmarkSeedStringArray(row.explanationCodes, `${label}.explanationCodes`);
}

export function assertCatalogReleaseRecords(value: unknown, label: string): void {
  const releases = asArray(value, label);
  for (const [index, releaseValue] of releases.entries()) {
    const releaseLabel = `${label}[${index}]`;
    const release = asStrictRecord(releaseValue, releaseLabel, [
      "releaseId",
      "workId",
      "catalogSource",
      "sourceReleaseId",
      "releaseTitle",
      "releaseKind",
      "editionName",
      "milestone",
      "packageKind",
      "engineName",
      "engineSource",
      "engineConfidence",
      "engineProvenanceId",
      "platform",
      "language",
      "releaseDate",
      "releaseYear",
      "isOfficial",
      "sourceProvenanceId",
      "metadata",
      "createdAt",
      "updatedAt",
    ]);
    assertPublicBenchmarkSeedString(release.releaseId, `${releaseLabel}.releaseId`);
    assertPublicBenchmarkSeedString(release.workId, `${releaseLabel}.workId`);
    assertEnum(
      release.catalogSource,
      Object.values(catalogSourceValues) as CatalogSource[],
      `${releaseLabel}.catalogSource`,
    );
    assertNullablePublicBenchmarkSeedString(
      release.sourceReleaseId,
      `${releaseLabel}.sourceReleaseId`,
    );
    assertPublicBenchmarkSeedString(release.releaseTitle, `${releaseLabel}.releaseTitle`);
    assertPublicBenchmarkSeedString(release.releaseKind, `${releaseLabel}.releaseKind`);
    assertNullablePublicBenchmarkSeedString(release.editionName, `${releaseLabel}.editionName`);
    assertNullablePublicBenchmarkSeedString(release.milestone, `${releaseLabel}.milestone`);
    assertPublicBenchmarkSeedString(release.packageKind, `${releaseLabel}.packageKind`);
    assertNullablePublicBenchmarkSeedString(release.engineName, `${releaseLabel}.engineName`);
    assertNullablePublicBenchmarkSeedString(release.engineSource, `${releaseLabel}.engineSource`);
    if (release.engineConfidence !== null) {
      assertEnum(
        release.engineConfidence,
        Object.values(catalogConfidenceValues) as CatalogConfidence[],
        `${releaseLabel}.engineConfidence`,
      );
    }
    assertNullablePublicBenchmarkSeedString(
      release.engineProvenanceId,
      `${releaseLabel}.engineProvenanceId`,
    );
    assertNullablePublicBenchmarkSeedString(release.platform, `${releaseLabel}.platform`);
    assertNullablePublicBenchmarkSeedString(release.language, `${releaseLabel}.language`);
    assertNullablePublicBenchmarkSeedString(release.releaseDate, `${releaseLabel}.releaseDate`);
    if (release.releaseYear !== null) {
      assertNonNegativeInteger(release.releaseYear, `${releaseLabel}.releaseYear`);
    }
    assertBoolean(release.isOfficial, `${releaseLabel}.isOfficial`);
    assertNullablePublicBenchmarkSeedString(
      release.sourceProvenanceId,
      `${releaseLabel}.sourceProvenanceId`,
    );
    asRecord(release.metadata, `${releaseLabel}.metadata`);
    assertDateLike(release.createdAt, `${releaseLabel}.createdAt`);
    assertDateLike(release.updatedAt, `${releaseLabel}.updatedAt`);
  }
}
