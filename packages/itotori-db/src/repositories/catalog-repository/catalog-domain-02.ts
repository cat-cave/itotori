import {
  CatalogCandidateMatchStatus,
  CatalogConfidence,
  CatalogConflictKind,
  CatalogConflictStatus,
  CatalogConflictSubjectKind,
  CatalogEngineSource,
  CatalogExternalIdKind,
  CatalogPathRedactionClass,
  CatalogSeedOrigin,
  CatalogSeedStatus,
  CatalogSource,
  CatalogSourceRecordKind,
} from "./dependencies.js";
import {
  CatalogDateInput,
  CatalogDemandFactInput,
  CatalogDemandFactRecord,
  CatalogEngineInput,
  CatalogExternalIdInput,
  CatalogExternalIdRecord,
  CatalogJsonRecord,
  CatalogLanguageStatusInput,
  CatalogLanguageStatusRecord,
  CatalogReleaseInput,
  CatalogReleaseInstallStateInput,
  CatalogReleaseInstallStateRecord,
  CatalogReleaseMappingInput,
  CatalogReleaseMappingRecord,
  CatalogReleaseRecord,
} from "./catalog-domain-01.js";

export type CatalogConflictEvidenceInput = {
  conflictEvidenceId?: string;
  subjectKind: CatalogConflictSubjectKind;
  subjectId: string;
  sourceProvenanceId?: string;
  evidencePosition?: number;
  metadata?: CatalogJsonRecord;
};

export type CatalogConflictInput = {
  conflictId?: string;
  conflictKind: CatalogConflictKind;
  status?: CatalogConflictStatus;
  summary: string;
  detectedAt?: CatalogDateInput;
  metadata?: CatalogJsonRecord;
  evidence?: CatalogConflictEvidenceInput[];
};

export type CatalogConflictEvidenceRecord = {
  conflictEvidenceId: string;
  conflictId: string;
  subjectKind: CatalogConflictSubjectKind;
  subjectId: string;
  sourceProvenanceId: string | null;
  evidencePosition: number;
  metadata: CatalogJsonRecord;
  createdAt: Date;
};

export type CatalogConflictRecord = {
  conflictId: string;
  workId: string;
  conflictKind: CatalogConflictKind;
  status: CatalogConflictStatus;
  summary: string;
  detectedAt: Date;
  metadata: CatalogJsonRecord;
  createdAt: Date;
  updatedAt: Date;
  evidence: CatalogConflictEvidenceRecord[];
};

export type CatalogWorkInput = {
  workId?: string;
  canonicalTitle: string;
  originalLanguage?: string;
  firstReleaseYear?: number;
  workKind?: string;
  engine?: CatalogEngineInput;
  metadata?: CatalogJsonRecord;
  externalIds?: CatalogExternalIdInput[];
  releases?: CatalogReleaseInput[];
  releaseMappings?: CatalogReleaseMappingInput[];
  installStates?: CatalogReleaseInstallStateInput[];
  languageStatuses?: CatalogLanguageStatusInput[];
  demandFacts?: CatalogDemandFactInput[];
  conflicts?: CatalogConflictInput[];
};

export type CatalogWorkRecord = {
  workId: string;
  canonicalTitle: string;
  originalLanguage: string | null;
  firstReleaseYear: number | null;
  workKind: string;
  engineName: string | null;
  engineSource: CatalogEngineSource | null;
  engineConfidence: CatalogConfidence | null;
  engineProvenanceId: string | null;
  metadata: CatalogJsonRecord;
  createdAt: Date;
  updatedAt: Date;
};

export type CatalogWorkSnapshot = CatalogWorkRecord & {
  externalIds: CatalogExternalIdRecord[];
  releases: CatalogReleaseRecord[];
  releaseMappings: CatalogReleaseMappingRecord[];
  installStates: CatalogReleaseInstallStateRecord[];
  languageStatuses: CatalogLanguageStatusRecord[];
  demandFacts: CatalogDemandFactRecord[];
  conflicts: CatalogConflictRecord[];
  localScanEntries: CatalogLocalScanEntryRecord[];
  seedTargets: CatalogSeedTargetRecord[];
};

export type CatalogSeedTargetInput = {
  seedTargetId?: string;
  catalogSource: CatalogSource;
  sourceId: string;
  seedOrigin?: CatalogSeedOrigin;
  originRef?: string;
  localScanEntryId?: string;
  sourceProvenanceId?: string;
  status?: CatalogSeedStatus;
  priority?: number;
  addedAt?: CatalogDateInput;
  metadata?: CatalogJsonRecord;
};

export type CatalogSeedTargetRecord = {
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
  updatedAt: Date;
};

export type CatalogLocalScanDetectedExternalIdInput = {
  catalogSource: CatalogSource;
  sourceId: string;
  externalIdKind?: CatalogExternalIdKind;
  sourceProvenanceId?: string;
  metadata?: CatalogJsonRecord;
};

export type CatalogLocalScanEntryInput = {
  localScanEntryId?: string;
  workId?: string;
  pathHash: string;
  pathRedactionClass?: CatalogPathRedactionClass;
  owned?: boolean;
  engineName?: string;
  engineSource?: CatalogEngineSource;
  engineConfidence?: CatalogConfidence;
  signals?: CatalogJsonRecord;
  sourceProvenanceId?: string;
  scannedAt?: CatalogDateInput;
  metadata?: CatalogJsonRecord;
  detectedExternalIds?: CatalogLocalScanDetectedExternalIdInput[];
  seedTargets?: CatalogSeedTargetInput[];
};

export type CatalogLocalScanInput = {
  localScanId?: string;
  scanRootLabel: string;
  scanRootPathHash: string;
  scannerName: string;
  scannerVersion: string;
  startedAt?: CatalogDateInput;
  completedAt?: CatalogDateInput;
  metadata?: CatalogJsonRecord;
  entries: CatalogLocalScanEntryInput[];
};

export type CatalogLocalScanEntryRecord = {
  localScanEntryId: string;
  localScanId: string;
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
  createdAt: Date;
  updatedAt: Date;
  detectedExternalIds: CatalogLocalScanDetectedExternalIdRecord[];
  seedTargets: CatalogSeedTargetRecord[];
};

export type CatalogLocalScanDetectedExternalIdRecord = {
  localScanEntryId: string;
  catalogSource: CatalogSource;
  sourceId: string;
  externalIdKind: CatalogExternalIdKind;
  sourceProvenanceId: string | null;
  metadata: CatalogJsonRecord;
  createdAt: Date;
};

export type CatalogLocalScanRecord = {
  localScanId: string;
  scanRootLabel: string;
  scanRootPathHash: string;
  scannerName: string;
  scannerVersion: string;
  startedAt: Date;
  completedAt: Date;
  createdByUserId: string | null;
  metadata: CatalogJsonRecord;
  createdAt: Date;
  entries: CatalogLocalScanEntryRecord[];
};

export type CatalogCandidateMatchInput = {
  candidateId?: string;
  sourceCatalogSource: CatalogSource;
  sourceId: string;
  sourceTitle: string;
  sourceProvenanceId?: string;
  targetWorkId: string;
  score: number;
  matchedFields: CatalogJsonRecord;
  status?: CatalogCandidateMatchStatus;
  diagnosticCode: string;
  generatorVersion: string;
  metadata?: CatalogJsonRecord;
};

export type CatalogCandidateMatchRecord = {
  candidateId: string;
  sourceCatalogSource: CatalogSource;
  sourceId: string;
  sourceTitle: string;
  sourceProvenanceId: string | null;
  targetWorkId: string;
  score: number;
  matchedFields: CatalogJsonRecord;
  status: CatalogCandidateMatchStatus;
  diagnosticCode: string;
  generatorVersion: string;
  metadata: CatalogJsonRecord;
  createdAt: Date;
  updatedAt: Date;
};

export type CatalogCandidateTargetWorkRecord = Pick<
  CatalogWorkRecord,
  "workId" | "canonicalTitle" | "firstReleaseYear" | "originalLanguage" | "workKind"
>;

export type CatalogConflictReviewSeverity = "error" | "warning" | "info";

export type CatalogConflictReviewStatus = CatalogConflictStatus | CatalogCandidateMatchStatus;

export type CatalogConflictReviewSourceId = {
  catalogSource: CatalogSource;
  sourceId: string;
};

export type CatalogConflictReviewExactLinkRef = CatalogConflictReviewSourceId & {
  externalIdId: string;
  externalIdKind: CatalogExternalIdKind;
  workId: string;
  sourceProvenanceId: string | null;
};

export type CatalogConflictReviewFuzzyScore = {
  candidateId: string;
  score: number;
  diagnosticCode: string;
  generatorVersion: string;
};

export type CatalogConflictReviewProvenance = CatalogConflictReviewSourceId & {
  sourceProvenanceId: string;
  sourceRecordKind: CatalogSourceRecordKind;
  payloadHash: string | null;
  fetchedAt: Date;
};

export type CatalogConflictReviewResolution = {
  reviewerId: string;
  action: string;
  resolvedAt: Date;
  priorCandidateIds: string[];
};
