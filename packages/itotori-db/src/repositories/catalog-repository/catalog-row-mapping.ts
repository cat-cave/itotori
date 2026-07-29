import {
  CatalogCandidateMatchStatus,
  CatalogConfidence,
  CatalogConflictKind,
  CatalogConflictStatus,
  CatalogConflictSubjectKind,
  CatalogDemandFactKind,
  CatalogEngineSource,
  CatalogExternalIdKind,
  CatalogInstallState,
  CatalogLanguageStatus,
  CatalogLanguageStatusScope,
  CatalogPathRedactionClass,
  CatalogRawContentRedactionClass,
  CatalogReleaseMappingKind,
  CatalogSeedOrigin,
  CatalogSeedStatus,
  CatalogSource,
  CatalogTranslationPortability,
  catalogCandidateMatches,
  catalogConflictEvidence,
  catalogConflicts,
  catalogDemandFacts,
  catalogLanguageStatuses,
  catalogLocalScanEntries,
  catalogLocalScanExternalIds,
  catalogLocalScans,
  catalogReleaseInstallStates,
  catalogReleaseMappings,
  catalogSeedTargets,
} from "./dependencies.js";
import { requiredString } from "../../required-string.js";
import {
  CatalogDateInput,
  CatalogDemandFactRecord,
  CatalogJsonRecord,
  CatalogLanguageStatusRecord,
  CatalogReleaseInstallStateRecord,
  CatalogReleaseMappingRecord,
} from "./catalog-record-types.js";
import {
  CatalogCandidateMatchRecord,
  CatalogConflictEvidenceRecord,
  CatalogConflictRecord,
  CatalogLocalScanDetectedExternalIdRecord,
  CatalogLocalScanEntryRecord,
  CatalogLocalScanRecord,
  CatalogSeedTargetRecord,
  CatalogWorkSnapshot,
} from "./catalog-work-scan-types.js";

export function releaseMappingFromRow(
  row: typeof catalogReleaseMappings.$inferSelect,
): CatalogReleaseMappingRecord {
  return {
    releaseMappingId: row.releaseMappingId,
    workId: row.workId,
    sourceReleaseId: row.sourceReleaseId,
    targetReleaseId: row.targetReleaseId,
    relationKind: row.relationKind as CatalogReleaseMappingKind,
    portability: row.portability as CatalogTranslationPortability,
    sourceProvenanceId: row.sourceProvenanceId,
    confidence: row.confidence as CatalogConfidence,
    observedAt: row.observedAt,
    metadata: row.metadata,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function releaseInstallStateFromRow(
  row: typeof catalogReleaseInstallStates.$inferSelect,
): CatalogReleaseInstallStateRecord {
  return {
    installStateId: row.installStateId,
    workId: row.workId,
    releaseId: row.releaseId,
    localScanEntryId: row.localScanEntryId,
    installState: row.installState as CatalogInstallState,
    targetArtifactLabel: row.targetArtifactLabel,
    sourceProvenanceId: row.sourceProvenanceId,
    confidence: row.confidence as CatalogConfidence,
    observedAt: row.observedAt,
    metadata: row.metadata,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function languageStatusFromRow(
  row: typeof catalogLanguageStatuses.$inferSelect,
): CatalogLanguageStatusRecord {
  return {
    languageStatusId: row.languageStatusId,
    workId: row.workId,
    language: row.language,
    status: row.status as CatalogLanguageStatus,
    statusScope: row.statusScope as CatalogLanguageStatusScope,
    platform: row.platform,
    releaseId: row.releaseId,
    sourceProvenanceId: row.sourceProvenanceId,
    confidence: row.confidence as CatalogConfidence,
    isCurrent: row.isCurrent,
    observedAt: row.observedAt,
    importedAt: row.importedAt,
    parserVersion: row.parserVersion,
    rawContentRedactionClass: row.rawContentRedactionClass as CatalogRawContentRedactionClass,
    metadata: row.metadata,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function demandFactFromRow(
  row: typeof catalogDemandFacts.$inferSelect,
): CatalogDemandFactRecord {
  return {
    demandFactId: row.demandFactId,
    workId: row.workId,
    catalogSource: row.catalogSource as CatalogSource,
    sourceId: row.sourceId,
    factKind: row.factKind as CatalogDemandFactKind,
    factValue: row.factValue,
    observedAt: row.observedAt,
    sourceProvenanceId: row.sourceProvenanceId,
    parserVersion: row.parserVersion,
    metadata: row.metadata,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function conflictFromRow(
  row: typeof catalogConflicts.$inferSelect,
): Omit<CatalogConflictRecord, "evidence"> {
  return {
    conflictId: row.conflictId,
    workId: row.workId,
    conflictKind: row.conflictKind as CatalogConflictKind,
    status: row.status as CatalogConflictStatus,
    summary: row.summary,
    detectedAt: row.detectedAt,
    metadata: row.metadata,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function conflictEvidenceFromRow(
  row: typeof catalogConflictEvidence.$inferSelect,
): CatalogConflictEvidenceRecord {
  return {
    conflictEvidenceId: row.conflictEvidenceId,
    conflictId: row.conflictId,
    subjectKind: row.subjectKind as CatalogConflictSubjectKind,
    subjectId: row.subjectId,
    sourceProvenanceId: row.sourceProvenanceId,
    evidencePosition: row.evidencePosition,
    metadata: row.metadata,
    createdAt: row.createdAt,
  };
}

export function localScanFromRow(
  row: typeof catalogLocalScans.$inferSelect,
): Omit<CatalogLocalScanRecord, "entries"> {
  return {
    localScanId: row.localScanId,
    scanRootLabel: row.scanRootLabel,
    scanRootPathHash: row.scanRootPathHash,
    scannerName: row.scannerName,
    scannerVersion: row.scannerVersion,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    createdByUserId: row.createdByUserId,
    metadata: row.metadata,
    createdAt: row.createdAt,
  };
}

export function localScanEntryFromRow(
  row: typeof catalogLocalScanEntries.$inferSelect,
): Omit<CatalogLocalScanEntryRecord, "detectedExternalIds" | "seedTargets"> {
  return {
    localScanEntryId: row.localScanEntryId,
    localScanId: row.localScanId,
    workId: row.workId,
    pathHash: row.pathHash,
    pathRedactionClass: row.pathRedactionClass as CatalogPathRedactionClass,
    owned: row.owned,
    engineName: row.engineName,
    engineSource: row.engineSource as CatalogEngineSource | null,
    engineConfidence: row.engineConfidence as CatalogConfidence | null,
    signals: row.signals,
    sourceProvenanceId: row.sourceProvenanceId,
    scannedAt: row.scannedAt,
    metadata: row.metadata,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function localScanDetectedExternalIdFromRow(
  row: typeof catalogLocalScanExternalIds.$inferSelect,
): CatalogLocalScanDetectedExternalIdRecord {
  return {
    localScanEntryId: row.localScanEntryId,
    catalogSource: row.catalogSource as CatalogSource,
    sourceId: row.sourceId,
    externalIdKind: row.externalIdKind as CatalogExternalIdKind,
    sourceProvenanceId: row.sourceProvenanceId,
    metadata: row.metadata,
    createdAt: row.createdAt,
  };
}

export function seedTargetFromRow(
  row: typeof catalogSeedTargets.$inferSelect,
): CatalogSeedTargetRecord {
  return {
    seedTargetId: row.seedTargetId,
    catalogSource: row.catalogSource as CatalogSource,
    sourceId: row.sourceId,
    seedOrigin: row.seedOrigin as CatalogSeedOrigin,
    originRef: row.originRef,
    localScanEntryId: row.localScanEntryId,
    sourceProvenanceId: row.sourceProvenanceId,
    status: row.status as CatalogSeedStatus,
    priority: row.priority,
    addedAt: row.addedAt,
    metadata: row.metadata,
    updatedAt: row.updatedAt,
  };
}

export function candidateMatchFromRow(
  row: typeof catalogCandidateMatches.$inferSelect,
): CatalogCandidateMatchRecord {
  return {
    candidateId: row.candidateId,
    sourceCatalogSource: row.sourceCatalogSource as CatalogSource,
    sourceId: row.sourceId,
    sourceTitle: row.sourceTitle,
    sourceProvenanceId: row.sourceProvenanceId,
    targetWorkId: row.targetWorkId,
    score: row.score,
    matchedFields: row.matchedFields,
    status: row.status as CatalogCandidateMatchStatus,
    diagnosticCode: row.diagnosticCode,
    generatorVersion: row.generatorVersion,
    metadata: row.metadata,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function requiredSnapshot(
  snapshot: CatalogWorkSnapshot | null,
  workId: string,
): CatalogWorkSnapshot {
  if (snapshot === null) {
    throw new Error(`catalog work ${workId} was not persisted`);
  }
  return snapshot;
}

export function requiredLocalScan(
  scan: CatalogLocalScanRecord | null,
  localScanId: string,
): CatalogLocalScanRecord {
  if (scan === null) {
    throw new Error(`local scan ${localScanId} was not persisted`);
  }
  return scan;
}

export function requiredRow<T>(rows: T[], id: string): T {
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`record ${id} was not persisted`);
  }
  return row;
}

export function optionalString(value: string | undefined, fieldName: string): string | null {
  if (value === undefined) {
    return null;
  }
  return requiredString(value, fieldName);
}

export function optionalYear(value: number | undefined, fieldName: string): number | null {
  if (value === undefined) {
    return null;
  }
  if (!Number.isInteger(value) || value < 1970 || value > 2200) {
    throw new Error(`${fieldName} must be an integer year`);
  }
  return value;
}

export function dateInput(value: CatalogDateInput, fieldName: string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${fieldName} must be a valid date`);
  }
  return date;
}

export function jsonRecord(value: CatalogJsonRecord, fieldName: string): CatalogJsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${fieldName} must be a JSON object`);
  }
  return value;
}

export function assertSha256(value: string, fieldName: string): void {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${fieldName} must be a sha256 hash`);
  }
}
