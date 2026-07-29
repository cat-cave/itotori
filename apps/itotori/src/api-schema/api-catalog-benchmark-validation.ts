import {
  CatalogBenchmarkSeedFinderReadModel,
  CatalogConfidence,
  CatalogExternalIdKind,
  CatalogLanguageStatus,
  CatalogLanguageStatusScope,
  CatalogRawContentRedactionClass,
  CatalogSource,
  CatalogSourceRecordKind,
  catalogConfidenceValues,
  catalogExternalIdKindValues,
  catalogLanguageStatusScopeValues,
  catalogLanguageStatusValues,
  catalogRawContentRedactionClassValues,
  catalogSourceRecordKindValues,
  catalogSourceValues,
} from "./dependencies.js";
import { STRICT_API_BODY_KEYS } from "./api-strict-body-keys.js";
import { assertNoOpportunityPrivateLeakage } from "./api-terminology-validation.js";
import { benchmarkSeedPrivateLeakagePatterns } from "./api-private-leakage.js";
import {
  asArray,
  asStrictRecord,
  assertDateLike,
  assertEnum,
  assertLiteral,
  assertNonNegativeInteger,
  assertNonNegativeNumber,
  assertNullableString,
  assertString,
} from "./api-validation-primitives.js";

export function assertLocaleBranchStatus(value: unknown, label: string): void {
  const branch = asStrictRecord(value, label, [
    "localeBranchId",
    "targetLocale",
    "status",
    "currentStyleGuidePolicyVersionId",
    "unitCount",
    "translatedUnitCount",
    "openFindingCount",
    "artifactCount",
  ]);
  assertString(branch.localeBranchId, `${label}.localeBranchId`);
  assertString(branch.targetLocale, `${label}.targetLocale`);
  assertString(branch.status, `${label}.status`);
  assertNullableString(
    branch.currentStyleGuidePolicyVersionId,
    `${label}.currentStyleGuidePolicyVersionId`,
  );
  assertNonNegativeInteger(branch.unitCount, `${label}.unitCount`);
  assertNonNegativeInteger(branch.translatedUnitCount, `${label}.translatedUnitCount`);
  assertNonNegativeInteger(branch.openFindingCount, `${label}.openFindingCount`);
  assertNonNegativeInteger(branch.artifactCount, `${label}.artifactCount`);
}

export function assertCatalogBenchmarkSeedFinderReadModel(
  value: unknown,
  label = "CatalogBenchmarkSeedFinderReadModel",
): asserts value is CatalogBenchmarkSeedFinderReadModel {
  const model = asStrictRecord(
    value,
    label,
    STRICT_API_BODY_KEYS.CatalogBenchmarkSeedFinderReadModel,
  );
  assertLiteral(
    model.schemaVersion,
    "catalog.benchmark_seed_finder.v0.1",
    `${label}.schemaVersion`,
  );
  assertString(model.targetLanguage, `${label}.targetLanguage`);
  assertDateLike(model.generatedAt, `${label}.generatedAt`);
  const rows = asArray(model.rows, `${label}.rows`);
  for (const [index, rowValue] of rows.entries()) {
    const rowLabel = `${label}.rows[${index}]`;
    const row = asStrictRecord(rowValue, rowLabel, [
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
    assertPublicBenchmarkSeedString(row.workId, `${rowLabel}.workId`);
    assertPublicBenchmarkSeedString(row.canonicalTitle, `${rowLabel}.canonicalTitle`);
    assertNullablePublicBenchmarkSeedString(row.originalLanguage, `${rowLabel}.originalLanguage`);
    assertCatalogBenchmarkSeedSourceIds(row.sourceIds, `${rowLabel}.sourceIds`);
    assertEnum(
      row.completenessPool,
      ["mtl_only", "fan_partial", "no_english", "unknown", "conflict"] as const,
      `${rowLabel}.completenessPool`,
    );
    assertCatalogBenchmarkSeedTranslationStatuses(
      row.translationStatuses,
      `${rowLabel}.translationStatuses`,
    );
    assertEnum(
      row.localOwnership,
      ["owned", "not_owned", "unknown"] as const,
      `${rowLabel}.localOwnership`,
    );
    assertNonNegativeNumber(row.localEvidenceCount, `${rowLabel}.localEvidenceCount`);
    assertEnum(
      row.demandBucket,
      ["none", "low", "medium", "high", "very_high"] as const,
      `${rowLabel}.demandBucket`,
    );
    assertCatalogBenchmarkSeedReadiness(row.readiness, `${rowLabel}.readiness`);
    assertCatalogBenchmarkSeedProvenance(row.provenance, `${rowLabel}.provenance`);
    assertEnum(
      row.decision,
      ["seed", "candidate", "demoted", "excluded"] as const,
      `${rowLabel}.decision`,
    );
    assertNonNegativeInteger(row.rank, `${rowLabel}.rank`);
    if (row.seedRank !== null) {
      assertNonNegativeInteger(row.seedRank, `${rowLabel}.seedRank`);
    }
    assertPublicBenchmarkSeedStringArray(row.explanationCodes, `${rowLabel}.explanationCodes`);
  }
}

export function assertCatalogBenchmarkSeedSourceIds(value: unknown, label: string): void {
  const sourceIds = asArray(value, label);
  for (const [index, sourceIdValue] of sourceIds.entries()) {
    const sourceId = asStrictRecord(sourceIdValue, `${label}[${index}]`, [
      "catalogSource",
      "sourceId",
      "externalIdKind",
    ]);
    assertEnum(
      sourceId.catalogSource,
      Object.values(catalogSourceValues) as CatalogSource[],
      `${label}[${index}].catalogSource`,
    );
    if (sourceId.catalogSource === catalogSourceValues.localCorpus) {
      throw new Error(`${label}[${index}].catalogSource must not expose local corpus sources`);
    }
    assertPublicBenchmarkSeedString(sourceId.sourceId, `${label}[${index}].sourceId`);
    assertEnum(
      sourceId.externalIdKind,
      Object.values(catalogExternalIdKindValues) as CatalogExternalIdKind[],
      `${label}[${index}].externalIdKind`,
    );
  }
}

export function assertCatalogBenchmarkSeedTranslationStatuses(value: unknown, label: string): void {
  const statuses = asArray(value, label);
  for (const [index, statusValue] of statuses.entries()) {
    const status = asStrictRecord(statusValue, `${label}[${index}]`, [
      "language",
      "status",
      "confidence",
      "statusScope",
      "platform",
    ]);
    assertPublicBenchmarkSeedString(status.language, `${label}[${index}].language`);
    assertEnum(
      status.status,
      Object.values(catalogLanguageStatusValues) as CatalogLanguageStatus[],
      `${label}[${index}].status`,
    );
    assertEnum(
      status.confidence,
      Object.values(catalogConfidenceValues) as CatalogConfidence[],
      `${label}[${index}].confidence`,
    );
    assertEnum(
      status.statusScope,
      Object.values(catalogLanguageStatusScopeValues) as CatalogLanguageStatusScope[],
      `${label}[${index}].statusScope`,
    );
    assertNullablePublicBenchmarkSeedString(status.platform, `${label}[${index}].platform`);
  }
}

export function assertCatalogBenchmarkSeedReadiness(value: unknown, label: string): void {
  const readiness = asStrictRecord(value, label, [
    "adapterId",
    "identify",
    "inventory",
    "extract",
    "patch",
    "helper",
    "runtime",
  ]);
  assertNullablePublicBenchmarkSeedString(readiness.adapterId, `${label}.adapterId`);
  for (const level of ["identify", "inventory", "extract", "patch", "helper", "runtime"] as const) {
    assertEnum(
      readiness[level],
      ["supported", "partial", "unsupported", "unknown"] as const,
      `${label}.${level}`,
    );
  }
}

export function assertCatalogBenchmarkSeedProvenance(value: unknown, label: string): void {
  const provenance = asArray(value, label);
  for (const [index, provenanceValue] of provenance.entries()) {
    const entry = asStrictRecord(provenanceValue, `${label}[${index}]`, [
      "catalogSource",
      "sourceId",
      "sourceRecordKind",
      "sourceVersion",
      "fixtureId",
      "redactionClass",
    ]);
    assertEnum(
      entry.catalogSource,
      Object.values(catalogSourceValues) as CatalogSource[],
      `${label}[${index}].catalogSource`,
    );
    if (entry.catalogSource === catalogSourceValues.localCorpus) {
      throw new Error(`${label}[${index}].catalogSource must not expose local corpus sources`);
    }
    assertPublicBenchmarkSeedString(entry.sourceId, `${label}[${index}].sourceId`);
    assertEnum(
      entry.sourceRecordKind,
      [
        catalogSourceRecordKindValues.recordedFixture,
        catalogSourceRecordKindValues.importerRequest,
      ] as CatalogSourceRecordKind[],
      `${label}[${index}].sourceRecordKind`,
    );
    assertNullablePublicBenchmarkSeedString(
      entry.sourceVersion,
      `${label}[${index}].sourceVersion`,
    );
    assertNullablePublicBenchmarkSeedString(entry.fixtureId, `${label}[${index}].fixtureId`);
    assertEnum(
      entry.redactionClass,
      Object.values(catalogRawContentRedactionClassValues) as CatalogRawContentRedactionClass[],
      `${label}[${index}].redactionClass`,
    );
    if (entry.redactionClass === catalogRawContentRedactionClassValues.privateCorpus) {
      throw new Error(`${label}[${index}].redactionClass must not expose private corpus data`);
    }
  }
}

export function assertPublicBenchmarkSeedString(
  value: unknown,
  label: string,
): asserts value is string {
  assertString(value, label);
  assertNoBenchmarkSeedPrivateLeakage(value, label);
}

export function assertNullablePublicBenchmarkSeedString(
  value: unknown,
  label: string,
): asserts value is string | null {
  assertNullableString(value, label);
  if (value !== null) {
    assertNoBenchmarkSeedPrivateLeakage(value, label);
  }
}

export function assertPublicBenchmarkSeedStringArray(value: unknown, label: string): void {
  const entries = asArray(value, label);
  for (const [index, entry] of entries.entries()) {
    assertPublicBenchmarkSeedString(entry, `${label}[${index}]`);
  }
}

export function assertNoBenchmarkSeedPrivateLeakage(value: string, label: string): void {
  if (benchmarkSeedPrivateLeakagePatterns.some((pattern) => pattern.test(value))) {
    throw new Error(`${label} must not expose private response data`);
  }
}

export function assertPublicOpportunityString(
  value: unknown,
  label: string,
): asserts value is string {
  assertString(value, label);
  assertNoOpportunityPrivateLeakage(value, label);
}

export function assertNullablePublicOpportunityString(
  value: unknown,
  label: string,
): asserts value is string | null {
  assertNullableString(value, label);
  if (value !== null) {
    assertNoOpportunityPrivateLeakage(value, label);
  }
}

export function assertPublicOpportunityStringArray(value: unknown, label: string): void {
  const entries = asArray(value, label);
  for (const [index, entry] of entries.entries()) {
    assertPublicOpportunityString(entry, `${label}[${index}]`);
  }
}
