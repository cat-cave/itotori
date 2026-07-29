import {
  CatalogConfidence,
  CatalogDemandFactKind,
  CatalogEngineSource,
  CatalogExternalIdKind,
  CatalogInstallState,
  CatalogLanguageStatus,
  CatalogLanguageStatusScope,
  CatalogRawContentRedactionClass,
  CatalogReleaseKind,
  CatalogReleaseMappingKind,
  CatalogReleasePackageKind,
  CatalogSource,
  CatalogSourceRecordKind,
  CatalogTranslationPortability,
} from "./dependencies.js";

export type CatalogJsonRecord = Record<string, unknown>;
export type CatalogDateInput = string | Date;

/**
 * Stable, machine-readable codes for catalog artifact-mapping validation
 * failures — specifically cross-work release mapping and install-state artifact
 * validation. API/CLI callers classify failures on these codes rather than
 * string-matching the human-readable message.
 */
export const catalogArtifactMappingErrorCodes = [
  /** An input release already belongs to a different work than the one being written. */
  "release_belongs_to_other_work",
  /** A release-mapping endpoint references a release owned by a different work. */
  "release_mapping_release_belongs_to_other_work",
  /** A release-mapping endpoint references a release that is not part of the parent work. */
  "release_mapping_release_not_in_work",
  /** A release-mapping's source and target releases are identical. */
  "release_mapping_endpoints_identical",
  /** An install-state references a release owned by a different work. */
  "install_state_release_belongs_to_other_work",
  /** An install-state references a release that is not part of the parent work. */
  "install_state_release_not_in_work",
  /** An install-state references a local-scan entry owned by a different work. */
  "install_state_local_scan_entry_belongs_to_other_work",
  /** A conflict-evidence row references a subject id that does not exist for its declared kind. */
  "conflict_evidence_subject_unknown",
  /** A conflict-evidence row references a subject owned by a different work than the conflict. */
  "conflict_evidence_subject_belongs_to_other_work",
  /**
   * A child-kind (externalId/release/languageStatus) conflict-evidence row carries a
   * `<catalogSource>:<sourceId>` cross-source identity. Child kinds are PARENT-SCOPED by
   * contract (CATALOG-079): they may only name a local row of the parent work. Cross-source
   * disagreement evidence must route through the `sourceProvenance` kind, which accepts the
   * well-formed cross-source identity. This is a caller error, not a dangling reference.
   */
  "conflict_evidence_child_subject_cross_source",
] as const;

export type CatalogArtifactMappingErrorCode = (typeof catalogArtifactMappingErrorCodes)[number];

/**
 * Structured domain error for catalog artifact-mapping validation failures.
 * Mirrors the established repository-error pattern: a stable `code` plus a
 * useful human-readable message.
 */
export class CatalogArtifactMappingError extends Error {
  constructor(
    readonly code: CatalogArtifactMappingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CatalogArtifactMappingError";
  }
}

export type CatalogSourceProvenanceInput = {
  sourceProvenanceId?: string;
  catalogSource: CatalogSource;
  sourceRecordKind: CatalogSourceRecordKind;
  sourceId: string;
  sourceVersion?: string;
  requestId?: string;
  httpStatus?: number;
  ok?: boolean;
  payloadHash?: string;
  rawContentRedactionClass?: CatalogRawContentRedactionClass;
  payload?: CatalogJsonRecord;
  fetchedAt: CatalogDateInput;
  metadata?: CatalogJsonRecord;
};

export type CatalogSourceProvenanceRecord = {
  sourceProvenanceId: string;
  catalogSource: CatalogSource;
  sourceRecordKind: CatalogSourceRecordKind;
  sourceId: string;
  sourceVersion: string | null;
  requestId: string | null;
  httpStatus: number | null;
  ok: boolean;
  payloadHash: string | null;
  rawContentRedactionClass: CatalogRawContentRedactionClass;
  payload: CatalogJsonRecord;
  fetchedAt: Date;
  metadata: CatalogJsonRecord;
  recordedAt: Date;
};

export type CatalogEngineInput = {
  engineName: string;
  engineSource: CatalogEngineSource;
  engineConfidence?: CatalogConfidence;
  engineProvenanceId?: string;
};

export type CatalogExternalIdInput = {
  externalIdId?: string;
  catalogSource: CatalogSource;
  sourceId: string;
  externalIdKind?: CatalogExternalIdKind;
  sourceProvenanceId?: string;
  confidence?: CatalogConfidence;
  discoveredAt?: CatalogDateInput;
  metadata?: CatalogJsonRecord;
};

export type CatalogExternalIdRecord = {
  externalIdId: string;
  workId: string;
  catalogSource: CatalogSource;
  sourceId: string;
  externalIdKind: CatalogExternalIdKind;
  sourceProvenanceId: string | null;
  confidence: CatalogConfidence;
  discoveredAt: Date;
  metadata: CatalogJsonRecord;
};

export type CatalogReleaseInput = {
  releaseId?: string;
  catalogSource: CatalogSource;
  sourceReleaseId?: string;
  releaseTitle: string;
  releaseKind?: CatalogReleaseKind;
  editionName?: string;
  milestone?: string;
  packageKind?: CatalogReleasePackageKind;
  engine?: CatalogEngineInput;
  platform?: string;
  language?: string;
  releaseDate?: string;
  releaseYear?: number;
  isOfficial?: boolean;
  sourceProvenanceId?: string;
  metadata?: CatalogJsonRecord;
};

export type CatalogReleaseRecord = {
  releaseId: string;
  workId: string;
  catalogSource: CatalogSource;
  sourceReleaseId: string | null;
  releaseTitle: string;
  releaseKind: CatalogReleaseKind;
  editionName: string | null;
  milestone: string | null;
  packageKind: CatalogReleasePackageKind;
  engineName: string | null;
  engineSource: CatalogEngineSource | null;
  engineConfidence: CatalogConfidence | null;
  engineProvenanceId: string | null;
  platform: string | null;
  language: string | null;
  releaseDate: string | null;
  releaseYear: number | null;
  isOfficial: boolean;
  sourceProvenanceId: string | null;
  metadata: CatalogJsonRecord;
  createdAt: Date;
  updatedAt: Date;
};

export type CatalogReleaseMappingInput = {
  releaseMappingId?: string;
  sourceReleaseId: string;
  targetReleaseId: string;
  relationKind: CatalogReleaseMappingKind;
  portability?: CatalogTranslationPortability;
  sourceProvenanceId?: string;
  confidence?: CatalogConfidence;
  observedAt?: CatalogDateInput;
  metadata?: CatalogJsonRecord;
};

export type CatalogReleaseMappingRecord = {
  releaseMappingId: string;
  workId: string;
  sourceReleaseId: string;
  targetReleaseId: string;
  relationKind: CatalogReleaseMappingKind;
  portability: CatalogTranslationPortability;
  sourceProvenanceId: string | null;
  confidence: CatalogConfidence;
  observedAt: Date;
  metadata: CatalogJsonRecord;
  createdAt: Date;
  updatedAt: Date;
};

export type CatalogReleaseInstallStateInput = {
  installStateId?: string;
  releaseId: string;
  localScanEntryId?: string;
  installState: CatalogInstallState;
  targetArtifactLabel?: string;
  sourceProvenanceId?: string;
  confidence?: CatalogConfidence;
  observedAt?: CatalogDateInput;
  metadata?: CatalogJsonRecord;
};

export type CatalogReleaseInstallStateRecord = {
  installStateId: string;
  workId: string;
  releaseId: string;
  localScanEntryId: string | null;
  installState: CatalogInstallState;
  targetArtifactLabel: string | null;
  sourceProvenanceId: string | null;
  confidence: CatalogConfidence;
  observedAt: Date;
  metadata: CatalogJsonRecord;
  createdAt: Date;
  updatedAt: Date;
};

export type CatalogLanguageStatusInput = {
  languageStatusId?: string;
  language: string;
  status: CatalogLanguageStatus;
  statusScope?: CatalogLanguageStatusScope;
  platform?: string;
  releaseId?: string;
  sourceProvenanceId?: string;
  confidence?: CatalogConfidence;
  isCurrent?: boolean;
  observedAt?: CatalogDateInput;
  importedAt?: CatalogDateInput;
  parserVersion?: string;
  rawContentRedactionClass?: CatalogRawContentRedactionClass;
  metadata?: CatalogJsonRecord;
};

export type CatalogLanguageStatusRecord = {
  languageStatusId: string;
  workId: string;
  language: string;
  status: CatalogLanguageStatus;
  statusScope: CatalogLanguageStatusScope;
  platform: string | null;
  releaseId: string | null;
  sourceProvenanceId: string | null;
  confidence: CatalogConfidence;
  isCurrent: boolean;
  observedAt: Date;
  importedAt: Date;
  parserVersion: string;
  rawContentRedactionClass: CatalogRawContentRedactionClass;
  metadata: CatalogJsonRecord;
  createdAt: Date;
  updatedAt: Date;
};

export type CatalogDemandFactInput = {
  demandFactId?: string;
  catalogSource: CatalogSource;
  sourceId: string;
  factKind: CatalogDemandFactKind;
  factValue: CatalogJsonRecord;
  observedAt?: CatalogDateInput;
  sourceProvenanceId?: string;
  parserVersion?: string;
  metadata?: CatalogJsonRecord;
};

export type CatalogDemandFactRecord = {
  demandFactId: string;
  workId: string;
  catalogSource: CatalogSource;
  sourceId: string;
  factKind: CatalogDemandFactKind;
  factValue: CatalogJsonRecord;
  observedAt: Date;
  sourceProvenanceId: string | null;
  parserVersion: string;
  metadata: CatalogJsonRecord;
  createdAt: Date;
  updatedAt: Date;
};
