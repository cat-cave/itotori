import {
  CatalogConfidence,
  CatalogEngineSource,
  CatalogExternalIdKind,
  CatalogPathRedactionClass,
  CatalogSeedOrigin,
  CatalogSeedStatus,
  CatalogSource,
  and,
  catalogConfidenceValues,
  catalogConflictStatusValues,
  catalogExternalIdKindValues,
  catalogLanguageStatusScopeValues,
  catalogRawContentRedactionClassValues,
  catalogReleaseKindValues,
  catalogReleasePackageKindValues,
  catalogTranslationPortabilityValues,
  createUuid7,
} from "./dependencies.js";
import {
  CatalogArtifactMappingError,
  CatalogDemandFactInput,
  CatalogExternalIdInput,
  CatalogJsonRecord,
  CatalogLanguageStatusInput,
  CatalogReleaseInput,
  CatalogReleaseInstallStateInput,
  CatalogReleaseMappingInput,
} from "./catalog-domain-01.js";
import { CatalogConflictEvidenceInput, CatalogConflictInput } from "./catalog-domain-02.js";
import {
  catalogConfidences,
  catalogConflictKinds,
  catalogConflictStatuses,
  catalogConflictSubjectKinds,
  catalogDemandFactKinds,
  catalogEngineSources,
  catalogExternalIdKinds,
  catalogInstallStates,
  catalogLanguageStatusEnums,
  catalogLanguageStatusScopes,
  catalogRawContentRedactionClasses,
  catalogReleaseKinds,
  catalogReleaseMappingKinds,
  catalogReleasePackageKinds,
  catalogSources,
  catalogTranslationPortabilities,
} from "./catalog-domain-04.js";
import {
  NormalizedCatalogEngineInput,
  NormalizedExternalIdInput,
  NormalizedReleaseInput,
  NormalizedReleaseInstallStateInput,
  NormalizedReleaseMappingInput,
} from "./catalog-domain-17.js";
import {
  NormalizedConflictEvidenceInput,
  NormalizedConflictInput,
  NormalizedDemandFactInput,
  NormalizedLanguageStatusInput,
} from "./catalog-domain-18.js";
import {
  dateInput,
  jsonRecord,
  optionalString,
  optionalYear,
  requiredString,
} from "./catalog-domain-22.js";
import { assertEnumValue } from "./catalog-domain-23.js";

export function assertExternalIdInput(input: CatalogExternalIdInput): NormalizedExternalIdInput {
  assertEnumValue(input.catalogSource, catalogSources, "externalId.catalogSource");
  if (input.externalIdKind !== undefined) {
    assertEnumValue(input.externalIdKind, catalogExternalIdKinds, "externalId.externalIdKind");
  }
  if (input.confidence !== undefined) {
    assertEnumValue(input.confidence, catalogConfidences, "externalId.confidence");
  }
  return {
    externalIdId: input.externalIdId ?? createUuid7(),
    catalogSource: input.catalogSource,
    sourceId: requiredString(input.sourceId, "externalId.sourceId"),
    externalIdKind: input.externalIdKind ?? catalogExternalIdKindValues.sourceRecord,
    sourceProvenanceId: input.sourceProvenanceId ?? null,
    confidence: input.confidence ?? catalogConfidenceValues.high,
    discoveredAt:
      input.discoveredAt === undefined ? new Date() : dateInput(input.discoveredAt, "discoveredAt"),
    metadata: jsonRecord(input.metadata ?? {}, "externalId.metadata"),
  };
}

export function assertReleaseInput(input: CatalogReleaseInput): NormalizedReleaseInput {
  assertEnumValue(input.catalogSource, catalogSources, "release.catalogSource");
  if (input.releaseKind !== undefined) {
    assertEnumValue(input.releaseKind, catalogReleaseKinds, "release.releaseKind");
  }
  if (input.packageKind !== undefined) {
    assertEnumValue(input.packageKind, catalogReleasePackageKinds, "release.packageKind");
  }
  let engine: NormalizedCatalogEngineInput | null = null;
  if (input.engine !== undefined) {
    assertEnumValue(input.engine.engineSource, catalogEngineSources, "release.engine.engineSource");
    if (input.engine.engineConfidence !== undefined) {
      assertEnumValue(
        input.engine.engineConfidence,
        catalogConfidences,
        "release.engine.engineConfidence",
      );
    }
    engine = {
      engineName: requiredString(input.engine.engineName, "release.engine.engineName"),
      engineSource: input.engine.engineSource,
      engineConfidence: input.engine.engineConfidence ?? catalogConfidenceValues.unknown,
      engineProvenanceId: input.engine.engineProvenanceId ?? null,
    };
  }
  return {
    releaseId: input.releaseId ?? createUuid7(),
    catalogSource: input.catalogSource,
    sourceReleaseId: optionalString(input.sourceReleaseId, "release.sourceReleaseId"),
    releaseTitle: requiredString(input.releaseTitle, "release.releaseTitle"),
    releaseKind: input.releaseKind ?? catalogReleaseKindValues.unknown,
    editionName: optionalString(input.editionName, "release.editionName"),
    milestone: optionalString(input.milestone, "release.milestone"),
    packageKind: input.packageKind ?? catalogReleasePackageKindValues.unknown,
    engine,
    platform: optionalString(input.platform, "release.platform"),
    language: optionalString(input.language, "release.language"),
    releaseDate: optionalString(input.releaseDate, "release.releaseDate"),
    releaseYear: optionalYear(input.releaseYear, "release.releaseYear"),
    isOfficial: input.isOfficial ?? false,
    sourceProvenanceId: input.sourceProvenanceId ?? null,
    metadata: jsonRecord(input.metadata ?? {}, "release.metadata"),
  };
}

export function assertReleaseMappingInput(
  input: CatalogReleaseMappingInput,
): NormalizedReleaseMappingInput {
  assertEnumValue(input.relationKind, catalogReleaseMappingKinds, "releaseMapping.relationKind");
  if (input.portability !== undefined) {
    assertEnumValue(
      input.portability,
      catalogTranslationPortabilities,
      "releaseMapping.portability",
    );
  }
  if (input.confidence !== undefined) {
    assertEnumValue(input.confidence, catalogConfidences, "releaseMapping.confidence");
  }
  const sourceReleaseId = requiredString(input.sourceReleaseId, "releaseMapping.sourceReleaseId");
  const targetReleaseId = requiredString(input.targetReleaseId, "releaseMapping.targetReleaseId");
  if (sourceReleaseId === targetReleaseId) {
    throw new CatalogArtifactMappingError(
      "release_mapping_endpoints_identical",
      "releaseMapping source and target releases must differ",
    );
  }
  return {
    releaseMappingId: input.releaseMappingId ?? createUuid7(),
    sourceReleaseId,
    targetReleaseId,
    relationKind: input.relationKind,
    portability: input.portability ?? catalogTranslationPortabilityValues.unknown,
    sourceProvenanceId: input.sourceProvenanceId ?? null,
    confidence: input.confidence ?? catalogConfidenceValues.unknown,
    observedAt:
      input.observedAt === undefined ? new Date() : dateInput(input.observedAt, "observedAt"),
    metadata: jsonRecord(input.metadata ?? {}, "releaseMapping.metadata"),
  };
}

export function assertReleaseInstallStateInput(
  input: CatalogReleaseInstallStateInput,
): NormalizedReleaseInstallStateInput {
  assertEnumValue(input.installState, catalogInstallStates, "installState.installState");
  if (input.confidence !== undefined) {
    assertEnumValue(input.confidence, catalogConfidences, "installState.confidence");
  }
  return {
    installStateId: input.installStateId ?? createUuid7(),
    releaseId: requiredString(input.releaseId, "installState.releaseId"),
    localScanEntryId: input.localScanEntryId ?? null,
    installState: input.installState,
    targetArtifactLabel: optionalString(
      input.targetArtifactLabel,
      "installState.targetArtifactLabel",
    ),
    sourceProvenanceId: input.sourceProvenanceId ?? null,
    confidence: input.confidence ?? catalogConfidenceValues.unknown,
    observedAt:
      input.observedAt === undefined ? new Date() : dateInput(input.observedAt, "observedAt"),
    metadata: jsonRecord(input.metadata ?? {}, "installState.metadata"),
  };
}

export function assertLanguageStatusInput(
  input: CatalogLanguageStatusInput,
): NormalizedLanguageStatusInput {
  assertEnumValue(input.status, catalogLanguageStatusEnums, "languageStatus.status");
  if (input.statusScope !== undefined) {
    assertEnumValue(input.statusScope, catalogLanguageStatusScopes, "languageStatus.statusScope");
  }
  if (input.confidence !== undefined) {
    assertEnumValue(input.confidence, catalogConfidences, "languageStatus.confidence");
  }
  if (input.rawContentRedactionClass !== undefined) {
    assertEnumValue(
      input.rawContentRedactionClass,
      catalogRawContentRedactionClasses,
      "languageStatus.rawContentRedactionClass",
    );
  }
  return {
    languageStatusId: input.languageStatusId ?? createUuid7(),
    language: requiredString(input.language, "languageStatus.language"),
    status: input.status,
    statusScope: input.statusScope ?? catalogLanguageStatusScopeValues.work,
    platform: optionalString(input.platform, "languageStatus.platform"),
    releaseId: input.releaseId ?? null,
    sourceProvenanceId: input.sourceProvenanceId ?? null,
    confidence: input.confidence ?? catalogConfidenceValues.high,
    isCurrent: input.isCurrent ?? true,
    observedAt:
      input.observedAt === undefined ? new Date() : dateInput(input.observedAt, "observedAt"),
    importedAt:
      input.importedAt === undefined ? new Date() : dateInput(input.importedAt, "importedAt"),
    parserVersion:
      input.parserVersion === undefined
        ? "unknown"
        : requiredString(input.parserVersion, "languageStatus.parserVersion"),
    rawContentRedactionClass:
      input.rawContentRedactionClass ?? catalogRawContentRedactionClassValues.publicMetadata,
    metadata: jsonRecord(input.metadata ?? {}, "languageStatus.metadata"),
  };
}

export function assertDemandFactInput(input: CatalogDemandFactInput): NormalizedDemandFactInput {
  assertEnumValue(input.catalogSource, catalogSources, "demandFact.catalogSource");
  assertEnumValue(input.factKind, catalogDemandFactKinds, "demandFact.factKind");
  return {
    demandFactId: input.demandFactId ?? createUuid7(),
    catalogSource: input.catalogSource,
    sourceId: requiredString(input.sourceId, "demandFact.sourceId"),
    factKind: input.factKind,
    factValue: jsonRecord(input.factValue, "demandFact.factValue"),
    observedAt:
      input.observedAt === undefined ? new Date() : dateInput(input.observedAt, "observedAt"),
    sourceProvenanceId: input.sourceProvenanceId ?? null,
    parserVersion:
      input.parserVersion === undefined
        ? "unknown"
        : requiredString(input.parserVersion, "demandFact.parserVersion"),
    metadata: jsonRecord(input.metadata ?? {}, "demandFact.metadata"),
  };
}

export function assertConflictInput(input: CatalogConflictInput): NormalizedConflictInput {
  assertEnumValue(input.conflictKind, catalogConflictKinds, "conflict.conflictKind");
  if (input.status !== undefined) {
    assertEnumValue(input.status, catalogConflictStatuses, "conflict.status");
  }
  return {
    conflictId: input.conflictId ?? createUuid7(),
    conflictKind: input.conflictKind,
    status: input.status ?? catalogConflictStatusValues.open,
    summary: requiredString(input.summary, "conflict.summary"),
    detectedAt:
      input.detectedAt === undefined ? new Date() : dateInput(input.detectedAt, "detectedAt"),
    metadata: jsonRecord(input.metadata ?? {}, "conflict.metadata"),
    evidence: (input.evidence ?? []).map(assertConflictEvidenceInput),
  };
}

export function assertConflictEvidenceInput(
  input: CatalogConflictEvidenceInput,
): NormalizedConflictEvidenceInput {
  assertEnumValue(input.subjectKind, catalogConflictSubjectKinds, "conflict.evidence.subjectKind");
  const evidencePosition = input.evidencePosition ?? 0;
  if (!Number.isInteger(evidencePosition) || evidencePosition < 0) {
    throw new Error("conflict.evidence.evidencePosition must be a non-negative integer");
  }
  return {
    conflictEvidenceId: input.conflictEvidenceId ?? createUuid7(),
    subjectKind: input.subjectKind,
    subjectId: requiredString(input.subjectId, "conflict.evidence.subjectId"),
    sourceProvenanceId: input.sourceProvenanceId ?? null,
    evidencePosition,
    metadata: jsonRecord(input.metadata ?? {}, "conflict.evidence.metadata"),
  };
}

export type NormalizedLocalScanInput = {
  localScanId: string;
  scanRootLabel: string;
  scanRootPathHash: string;
  scannerName: string;
  scannerVersion: string;
  startedAt: Date;
  completedAt: Date;
  metadata: CatalogJsonRecord;
  entries: NormalizedLocalScanEntryInput[];
};

export type NormalizedLocalScanEntryInput = {
  localScanEntryId: string;
  workId: string | null;
  pathHash: string;
  pathRedactionClass: CatalogPathRedactionClass;
  owned: boolean;
  engineName: string | null;
  engineSource: CatalogEngineSource | null;
  engineConfidence: CatalogConfidence | null;
  signals: CatalogJsonRecord;
  sourceProvenanceId: string | null;
  scannedAt: Date;
  metadata: CatalogJsonRecord;
  detectedExternalIds: NormalizedLocalScanDetectedExternalIdInput[];
  seedTargets: NormalizedSeedTargetInput[];
};

export type NormalizedLocalScanDetectedExternalIdInput = {
  catalogSource: CatalogSource;
  sourceId: string;
  externalIdKind: CatalogExternalIdKind;
  sourceProvenanceId: string | null;
  metadata: CatalogJsonRecord;
};

export type NormalizedSeedTargetInput = {
  seedTargetId: string;
  catalogSource: CatalogSource;
  sourceId: string;
  seedOrigin: CatalogSeedOrigin;
  originRef: string | null;
  localScanEntryId: string | null;
  sourceProvenanceId: string | null;
  status: CatalogSeedStatus;
  priority: number;
  addedAt: Date;
  metadata: CatalogJsonRecord;
};
