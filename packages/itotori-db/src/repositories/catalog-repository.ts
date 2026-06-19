import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { ItotoriDatabase } from "../connection.js";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import { createUuid7 } from "./event-queue-repository.js";
import {
  catalogConfidenceValues,
  catalogCandidateMatches,
  catalogCandidateMatchStatusValues,
  catalogConflictEvidence,
  catalogConflictKindValues,
  catalogConflicts,
  catalogConflictStatusValues,
  catalogConflictSubjectKindValues,
  catalogDemandFactKindValues,
  catalogDemandFacts,
  catalogEngineSourceValues,
  catalogExternalIdKindValues,
  catalogExternalIds,
  catalogInstallStateValues,
  catalogLanguageStatuses,
  catalogLanguageStatusScopeValues,
  catalogLanguageStatusValues,
  catalogLocalScanEntries,
  catalogLocalScanExternalIds,
  catalogLocalScans,
  catalogPathRedactionClassValues,
  catalogRawContentRedactionClassValues,
  catalogReleaseInstallStates,
  catalogReleaseKindValues,
  catalogReleaseMappingKindValues,
  catalogReleaseMappings,
  catalogReleasePackageKindValues,
  catalogReleases,
  catalogSeedOriginValues,
  catalogSeedStatusValues,
  catalogSeedTargets,
  catalogSourceProvenance,
  catalogSourceRecordKindValues,
  catalogSourceValues,
  catalogWorks,
  type CatalogConfidence,
  type CatalogCandidateMatchStatus,
  type CatalogConflictKind,
  type CatalogConflictStatus,
  type CatalogConflictSubjectKind,
  type CatalogDemandFactKind,
  type CatalogEngineSource,
  type CatalogExternalIdKind,
  type CatalogInstallState,
  type CatalogLanguageStatus,
  type CatalogLanguageStatusScope,
  type CatalogPathRedactionClass,
  type CatalogRawContentRedactionClass,
  type CatalogReleaseKind,
  type CatalogReleaseMappingKind,
  type CatalogReleasePackageKind,
  type CatalogSeedOrigin,
  type CatalogSeedStatus,
  type CatalogSource,
  type CatalogSourceRecordKind,
  type CatalogTranslationPortability,
  catalogTranslationPortabilityValues,
} from "../schema.js";

export type CatalogJsonRecord = Record<string, unknown>;
export type CatalogDateInput = string | Date;

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

export type CatalogConflictReviewRow = {
  reviewId: string;
  catalogRecordId: string;
  conflictId: string | null;
  candidateIds: string[];
  candidateCatalogIds: string[];
  exactLinkRefs: CatalogConflictReviewExactLinkRef[];
  fuzzyScores: CatalogConflictReviewFuzzyScore[];
  sourceIds: CatalogConflictReviewSourceId[];
  provenance: CatalogConflictReviewProvenance[];
  severity: CatalogConflictReviewSeverity;
  status: CatalogConflictReviewStatus;
  reasonCode: string;
  reasonDetail: string;
  conflictKind: CatalogConflictKind | null;
  detectedAt: Date;
  resolution: CatalogConflictReviewResolution | null;
};

export type CatalogConflictReviewReadModel = {
  rows: CatalogConflictReviewRow[];
};

export type CatalogConflictReviewFilter = {
  source?: CatalogSource;
  severity?: CatalogConflictReviewSeverity;
  status?: CatalogConflictReviewStatus;
  catalogRecordId?: string;
};

export const catalogCompletenessPoolValues = {
  mtlOnly: "mtl_only",
  fanPartial: "fan_partial",
  noEnglish: "no_english",
  unknown: "unknown",
  conflict: "conflict",
} as const;

export type CatalogCompletenessPool =
  (typeof catalogCompletenessPoolValues)[keyof typeof catalogCompletenessPoolValues];

export type CatalogCompletenessPoolFilter = {
  targetLanguage?: string;
  pool?: CatalogCompletenessPool;
};

export type CatalogCompletenessSourceSummary = {
  sourceProvenanceId: string;
  catalogSource: CatalogSource;
  sourceRecordKind: CatalogSourceRecordKind;
  sourceId: string;
  sourceVersion: string | null;
  fetchedAt: Date;
  rawContentRedactionClass: CatalogRawContentRedactionClass;
};

export type CatalogCompletenessStatusFact = {
  languageStatusId: string;
  language: string;
  status: CatalogLanguageStatus;
  statusScope: CatalogLanguageStatusScope;
  platform: string | null;
  releaseId: string | null;
  sourceProvenanceId: string | null;
  source: CatalogCompletenessSourceSummary | null;
  confidence: CatalogConfidence;
  observedAt: Date;
  importedAt: Date;
  parserVersion: string;
  rawContentRedactionClass: CatalogRawContentRedactionClass;
};

export type CatalogCompletenessConflictSummary = {
  conflictId: string;
  status: CatalogConflictStatus;
  reasonCode: string;
  sourceIds: CatalogConflictReviewSourceId[];
};

export type CatalogCompletenessPoolWork = {
  workId: string;
  canonicalTitle: string;
  originalLanguage: string | null;
  sourceIds: CatalogConflictReviewSourceId[];
  statuses: CatalogCompletenessStatusFact[];
  conflicts: CatalogCompletenessConflictSummary[];
};

export type CatalogCompletenessPublicPoolReport = {
  pool: CatalogCompletenessPool;
  workCount: number;
  sourceIds: CatalogConflictReviewSourceId[];
};

export type CatalogCompletenessPublicStatusReport = {
  status: CatalogLanguageStatus;
  factCount: number;
  sourceIds: CatalogConflictReviewSourceId[];
};

export type CatalogCompletenessPublicReport = {
  schemaVersion: "catalog.completeness_public_report.v0.1";
  targetLanguage: string;
  generatedAt: Date;
  totalWorkCount: number;
  conflictCount: number;
  pools: CatalogCompletenessPublicPoolReport[];
  statuses: CatalogCompletenessPublicStatusReport[];
};

export type CatalogCompletenessBenchmarkPools = {
  targetLanguage: string;
  pools: Record<CatalogCompletenessPool, CatalogCompletenessPoolWork[]>;
  publicReport: CatalogCompletenessPublicReport;
};

export type CatalogAlphaBenchmarkOpportunityDecision = "seed" | "demoted";

export type CatalogAlphaBenchmarkOpportunityDemotion = {
  reasonCode: string;
  reasonDetail: string;
  conflictId: string | null;
  severity: CatalogConflictReviewSeverity;
  sourceIds: CatalogConflictReviewSourceId[];
  provenance: CatalogConflictReviewProvenance[];
};

export type CatalogAlphaBenchmarkOpportunity = {
  rank: number;
  seedRank: number | null;
  workId: string;
  canonicalTitle: string;
  originalLanguage: string | null;
  candidatePool: CatalogCompletenessPool;
  decision: CatalogAlphaBenchmarkOpportunityDecision;
  score: number;
  explanation: string;
  sourceIds: CatalogConflictReviewSourceId[];
  statuses: CatalogCompletenessStatusFact[];
  demotions: CatalogAlphaBenchmarkOpportunityDemotion[];
};

export type CatalogAlphaBenchmarkOpportunityRanking = {
  schemaVersion: "catalog.alpha_benchmark_opportunity_ranking.v0.1";
  targetLanguage: string;
  generatedAt: Date;
  rows: CatalogAlphaBenchmarkOpportunity[];
};

export type CatalogAlphaBenchmarkOpportunityRankingFilter = {
  targetLanguage?: string;
  includeDemoted?: boolean;
};

export interface ItotoriCatalogRepositoryPort {
  recordSourceProvenance(
    actor: AuthorizationActor,
    input: CatalogSourceProvenanceInput,
  ): Promise<CatalogSourceProvenanceRecord>;
  upsertWork(actor: AuthorizationActor, input: CatalogWorkInput): Promise<CatalogWorkSnapshot>;
  recordLocalScan(
    actor: AuthorizationActor,
    input: CatalogLocalScanInput,
  ): Promise<CatalogLocalScanRecord>;
  recordSeedTarget(
    actor: AuthorizationActor,
    input: CatalogSeedTargetInput,
  ): Promise<CatalogSeedTargetRecord>;
  getWorkSnapshot(actor: AuthorizationActor, workId: string): Promise<CatalogWorkSnapshot | null>;
  getWorkByExternalId(
    actor: AuthorizationActor,
    catalogSource: CatalogSource,
    sourceId: string,
    externalIdKind?: CatalogExternalIdKind,
  ): Promise<CatalogWorkSnapshot | null>;
  listSeedTargets(
    actor: AuthorizationActor,
    status?: CatalogSeedStatus,
  ): Promise<CatalogSeedTargetRecord[]>;
  listCatalogCandidateTargetWorks(
    actor: AuthorizationActor,
  ): Promise<CatalogCandidateTargetWorkRecord[]>;
  recordCatalogCandidateMatch(
    actor: AuthorizationActor,
    input: CatalogCandidateMatchInput,
  ): Promise<CatalogCandidateMatchRecord>;
  listCatalogCandidateMatches(
    actor: AuthorizationActor,
    status?: CatalogCandidateMatchStatus,
  ): Promise<CatalogCandidateMatchRecord[]>;
  catalogConflictReview(
    actor: AuthorizationActor,
    filter?: CatalogConflictReviewFilter,
  ): Promise<CatalogConflictReviewReadModel>;
  catalogCompletenessBenchmarkPools(
    actor: AuthorizationActor,
    filter?: CatalogCompletenessPoolFilter,
  ): Promise<CatalogCompletenessBenchmarkPools>;
  catalogAlphaBenchmarkOpportunityRanking(
    actor: AuthorizationActor,
    filter?: CatalogAlphaBenchmarkOpportunityRankingFilter,
  ): Promise<CatalogAlphaBenchmarkOpportunityRanking>;
}

const catalogSources = Object.values(catalogSourceValues) as CatalogSource[];
const catalogSourceRecordKinds = Object.values(
  catalogSourceRecordKindValues,
) as CatalogSourceRecordKind[];
const catalogExternalIdKinds = Object.values(
  catalogExternalIdKindValues,
) as CatalogExternalIdKind[];
const catalogConfidences = Object.values(catalogConfidenceValues) as CatalogConfidence[];
const catalogEngineSources = Object.values(catalogEngineSourceValues) as CatalogEngineSource[];
const catalogReleaseKinds = Object.values(catalogReleaseKindValues) as CatalogReleaseKind[];
const catalogReleasePackageKinds = Object.values(
  catalogReleasePackageKindValues,
) as CatalogReleasePackageKind[];
const catalogReleaseMappingKinds = Object.values(
  catalogReleaseMappingKindValues,
) as CatalogReleaseMappingKind[];
const catalogTranslationPortabilities = Object.values(
  catalogTranslationPortabilityValues,
) as CatalogTranslationPortability[];
const catalogInstallStates = Object.values(catalogInstallStateValues) as CatalogInstallState[];
const catalogLanguageStatusEnums = Object.values(
  catalogLanguageStatusValues,
) as CatalogLanguageStatus[];
const catalogLanguageStatusScopes = Object.values(
  catalogLanguageStatusScopeValues,
) as CatalogLanguageStatusScope[];
const catalogDemandFactKinds = Object.values(
  catalogDemandFactKindValues,
) as CatalogDemandFactKind[];
const catalogConflictKinds = Object.values(catalogConflictKindValues) as CatalogConflictKind[];
const catalogConflictStatuses = Object.values(
  catalogConflictStatusValues,
) as CatalogConflictStatus[];
const catalogConflictSubjectKinds = Object.values(
  catalogConflictSubjectKindValues,
) as CatalogConflictSubjectKind[];
const catalogPathRedactionClasses = Object.values(
  catalogPathRedactionClassValues,
) as CatalogPathRedactionClass[];
const catalogRawContentRedactionClasses = Object.values(
  catalogRawContentRedactionClassValues,
) as CatalogRawContentRedactionClass[];
const catalogSeedOrigins = Object.values(catalogSeedOriginValues) as CatalogSeedOrigin[];
const catalogSeedStatuses = Object.values(catalogSeedStatusValues) as CatalogSeedStatus[];
const catalogCandidateMatchStatuses = Object.values(
  catalogCandidateMatchStatusValues,
) as CatalogCandidateMatchStatus[];
const catalogCompletenessPools = Object.values(
  catalogCompletenessPoolValues,
) as CatalogCompletenessPool[];

export class ItotoriCatalogRepository implements ItotoriCatalogRepositoryPort {
  constructor(private readonly db: ItotoriDatabase) {}

  async recordSourceProvenance(
    actor: AuthorizationActor,
    input: CatalogSourceProvenanceInput,
  ): Promise<CatalogSourceProvenanceRecord> {
    await requirePermission(this.db, actor, permissionValues.catalogWrite);
    return recordSourceProvenanceUnchecked(this.db, assertSourceProvenanceInput(input));
  }

  async upsertWork(
    actor: AuthorizationActor,
    input: CatalogWorkInput,
  ): Promise<CatalogWorkSnapshot> {
    await requirePermission(this.db, actor, permissionValues.catalogWrite);
    const normalized = assertCatalogWorkInput(input);

    await this.db.transaction(async (tx) => {
      await tx
        .insert(catalogWorks)
        .values({
          workId: normalized.workId,
          canonicalTitle: normalized.canonicalTitle,
          originalLanguage: normalized.originalLanguage,
          firstReleaseYear: normalized.firstReleaseYear,
          workKind: normalized.workKind,
          engineName: normalized.engine?.engineName ?? null,
          engineSource: normalized.engine?.engineSource ?? null,
          engineConfidence: normalized.engine?.engineConfidence ?? null,
          engineProvenanceId: normalized.engine?.engineProvenanceId ?? null,
          metadata: normalized.metadata,
        })
        .onConflictDoUpdate({
          target: catalogWorks.workId,
          set: {
            canonicalTitle: normalized.canonicalTitle,
            originalLanguage: normalized.originalLanguage,
            firstReleaseYear: normalized.firstReleaseYear,
            workKind: normalized.workKind,
            engineName: normalized.engine?.engineName ?? null,
            engineSource: normalized.engine?.engineSource ?? null,
            engineConfidence: normalized.engine?.engineConfidence ?? null,
            engineProvenanceId: normalized.engine?.engineProvenanceId ?? null,
            metadata: normalized.metadata,
            updatedAt: sql`now()`,
          },
        });

      for (const externalId of normalized.externalIds) {
        await tx
          .insert(catalogExternalIds)
          .values({
            externalIdId: externalId.externalIdId,
            workId: normalized.workId,
            catalogSource: externalId.catalogSource,
            sourceId: externalId.sourceId,
            externalIdKind: externalId.externalIdKind,
            sourceProvenanceId: externalId.sourceProvenanceId,
            confidence: externalId.confidence,
            discoveredAt: externalId.discoveredAt,
            metadata: externalId.metadata,
          })
          .onConflictDoUpdate({
            target: [
              catalogExternalIds.catalogSource,
              catalogExternalIds.sourceId,
              catalogExternalIds.externalIdKind,
            ],
            set: {
              workId: normalized.workId,
              catalogSource: externalId.catalogSource,
              sourceId: externalId.sourceId,
              externalIdKind: externalId.externalIdKind,
              sourceProvenanceId: externalId.sourceProvenanceId,
              confidence: externalId.confidence,
              metadata: externalId.metadata,
            },
          });
      }

      for (const release of normalized.releases) {
        await tx
          .insert(catalogReleases)
          .values({
            releaseId: release.releaseId,
            workId: normalized.workId,
            catalogSource: release.catalogSource,
            sourceReleaseId: release.sourceReleaseId,
            releaseTitle: release.releaseTitle,
            releaseKind: release.releaseKind,
            editionName: release.editionName,
            milestone: release.milestone,
            packageKind: release.packageKind,
            engineName: release.engine?.engineName ?? null,
            engineSource: release.engine?.engineSource ?? null,
            engineConfidence: release.engine?.engineConfidence ?? null,
            engineProvenanceId: release.engine?.engineProvenanceId ?? null,
            platform: release.platform,
            language: release.language,
            releaseDate: release.releaseDate,
            releaseYear: release.releaseYear,
            isOfficial: release.isOfficial,
            sourceProvenanceId: release.sourceProvenanceId,
            metadata: release.metadata,
          })
          .onConflictDoUpdate({
            target: catalogReleases.releaseId,
            set: {
              catalogSource: release.catalogSource,
              sourceReleaseId: release.sourceReleaseId,
              releaseTitle: release.releaseTitle,
              releaseKind: release.releaseKind,
              editionName: release.editionName,
              milestone: release.milestone,
              packageKind: release.packageKind,
              engineName: release.engine?.engineName ?? null,
              engineSource: release.engine?.engineSource ?? null,
              engineConfidence: release.engine?.engineConfidence ?? null,
              engineProvenanceId: release.engine?.engineProvenanceId ?? null,
              platform: release.platform,
              language: release.language,
              releaseDate: release.releaseDate,
              releaseYear: release.releaseYear,
              isOfficial: release.isOfficial,
              sourceProvenanceId: release.sourceProvenanceId,
              metadata: release.metadata,
              updatedAt: sql`now()`,
            },
          });
      }

      for (const releaseMapping of normalized.releaseMappings) {
        await tx
          .insert(catalogReleaseMappings)
          .values({
            releaseMappingId: releaseMapping.releaseMappingId,
            workId: normalized.workId,
            sourceReleaseId: releaseMapping.sourceReleaseId,
            targetReleaseId: releaseMapping.targetReleaseId,
            relationKind: releaseMapping.relationKind,
            portability: releaseMapping.portability,
            sourceProvenanceId: releaseMapping.sourceProvenanceId,
            confidence: releaseMapping.confidence,
            observedAt: releaseMapping.observedAt,
            metadata: releaseMapping.metadata,
          })
          .onConflictDoUpdate({
            target: [
              catalogReleaseMappings.sourceReleaseId,
              catalogReleaseMappings.targetReleaseId,
              catalogReleaseMappings.relationKind,
            ],
            set: {
              workId: normalized.workId,
              portability: releaseMapping.portability,
              sourceProvenanceId: releaseMapping.sourceProvenanceId,
              confidence: releaseMapping.confidence,
              observedAt: releaseMapping.observedAt,
              metadata: releaseMapping.metadata,
              updatedAt: sql`now()`,
            },
          });
      }

      for (const installState of normalized.installStates) {
        await tx.execute(sql`
          insert into ${catalogReleaseInstallStates} (
            install_state_id,
            work_id,
            release_id,
            local_scan_entry_id,
            install_state,
            target_artifact_label,
            source_provenance_id,
            confidence,
            observed_at,
            metadata
          ) values (
            ${installState.installStateId},
            ${normalized.workId},
            ${installState.releaseId},
            ${installState.localScanEntryId},
            ${installState.installState},
            ${installState.targetArtifactLabel},
            ${installState.sourceProvenanceId},
            ${installState.confidence},
            ${installState.observedAt},
            ${installState.metadata}::jsonb
          )
          on conflict (release_id, coalesce(local_scan_entry_id, ''), install_state)
          do update set
            work_id = excluded.work_id,
            target_artifact_label = excluded.target_artifact_label,
            source_provenance_id = excluded.source_provenance_id,
            confidence = excluded.confidence,
            observed_at = excluded.observed_at,
            metadata = excluded.metadata,
            updated_at = now()
        `);
      }

      for (const languageStatus of normalized.languageStatuses) {
        await tx
          .insert(catalogLanguageStatuses)
          .values({
            languageStatusId: languageStatus.languageStatusId,
            workId: normalized.workId,
            language: languageStatus.language,
            status: languageStatus.status,
            statusScope: languageStatus.statusScope,
            platform: languageStatus.platform,
            releaseId: languageStatus.releaseId,
            sourceProvenanceId: languageStatus.sourceProvenanceId,
            confidence: languageStatus.confidence,
            isCurrent: languageStatus.isCurrent,
            observedAt: languageStatus.observedAt,
            importedAt: languageStatus.importedAt,
            parserVersion: languageStatus.parserVersion,
            rawContentRedactionClass: languageStatus.rawContentRedactionClass,
            metadata: languageStatus.metadata,
          })
          .onConflictDoUpdate({
            target: catalogLanguageStatuses.languageStatusId,
            set: {
              language: languageStatus.language,
              status: languageStatus.status,
              statusScope: languageStatus.statusScope,
              platform: languageStatus.platform,
              releaseId: languageStatus.releaseId,
              sourceProvenanceId: languageStatus.sourceProvenanceId,
              confidence: languageStatus.confidence,
              isCurrent: languageStatus.isCurrent,
              observedAt: languageStatus.observedAt,
              importedAt: languageStatus.importedAt,
              parserVersion: languageStatus.parserVersion,
              rawContentRedactionClass: languageStatus.rawContentRedactionClass,
              metadata: languageStatus.metadata,
              updatedAt: sql`now()`,
            },
          });
      }

      for (const demandFact of normalized.demandFacts) {
        await tx
          .insert(catalogDemandFacts)
          .values({
            demandFactId: demandFact.demandFactId,
            workId: normalized.workId,
            catalogSource: demandFact.catalogSource,
            sourceId: demandFact.sourceId,
            factKind: demandFact.factKind,
            factValue: demandFact.factValue,
            observedAt: demandFact.observedAt,
            sourceProvenanceId: demandFact.sourceProvenanceId,
            parserVersion: demandFact.parserVersion,
            metadata: demandFact.metadata,
          })
          .onConflictDoUpdate({
            target: catalogDemandFacts.demandFactId,
            set: {
              workId: normalized.workId,
              catalogSource: demandFact.catalogSource,
              sourceId: demandFact.sourceId,
              factKind: demandFact.factKind,
              factValue: demandFact.factValue,
              observedAt: demandFact.observedAt,
              sourceProvenanceId: demandFact.sourceProvenanceId,
              parserVersion: demandFact.parserVersion,
              metadata: demandFact.metadata,
              updatedAt: sql`now()`,
            },
          });
      }

      for (const conflict of normalized.conflicts) {
        await tx
          .insert(catalogConflicts)
          .values({
            conflictId: conflict.conflictId,
            workId: normalized.workId,
            conflictKind: conflict.conflictKind,
            status: conflict.status,
            summary: conflict.summary,
            detectedAt: conflict.detectedAt,
            metadata: conflict.metadata,
          })
          .onConflictDoUpdate({
            target: catalogConflicts.conflictId,
            set: {
              conflictKind: conflict.conflictKind,
              status: conflict.status,
              summary: conflict.summary,
              detectedAt: conflict.detectedAt,
              metadata: conflict.metadata,
              updatedAt: sql`now()`,
            },
          });

        for (const evidence of conflict.evidence) {
          await tx
            .insert(catalogConflictEvidence)
            .values({
              conflictEvidenceId: evidence.conflictEvidenceId,
              conflictId: conflict.conflictId,
              subjectKind: evidence.subjectKind,
              subjectId: evidence.subjectId,
              sourceProvenanceId: evidence.sourceProvenanceId,
              evidencePosition: evidence.evidencePosition,
              metadata: evidence.metadata,
            })
            .onConflictDoUpdate({
              target: catalogConflictEvidence.conflictEvidenceId,
              set: {
                subjectKind: evidence.subjectKind,
                subjectId: evidence.subjectId,
                sourceProvenanceId: evidence.sourceProvenanceId,
                evidencePosition: evidence.evidencePosition,
                metadata: evidence.metadata,
              },
            });
        }
      }
    });

    return requiredSnapshot(await readWorkSnapshot(this.db, normalized.workId), normalized.workId);
  }

  async recordLocalScan(
    actor: AuthorizationActor,
    input: CatalogLocalScanInput,
  ): Promise<CatalogLocalScanRecord> {
    await requirePermission(this.db, actor, permissionValues.catalogWrite);
    const normalized = assertLocalScanInput(input);

    await this.db.transaction(async (tx) => {
      await tx
        .insert(catalogLocalScans)
        .values({
          localScanId: normalized.localScanId,
          scanRootLabel: normalized.scanRootLabel,
          scanRootPathHash: normalized.scanRootPathHash,
          scannerName: normalized.scannerName,
          scannerVersion: normalized.scannerVersion,
          startedAt: normalized.startedAt,
          completedAt: normalized.completedAt,
          createdByUserId: actor.userId,
          metadata: normalized.metadata,
        })
        .onConflictDoUpdate({
          target: catalogLocalScans.localScanId,
          set: {
            scanRootLabel: normalized.scanRootLabel,
            scanRootPathHash: normalized.scanRootPathHash,
            scannerName: normalized.scannerName,
            scannerVersion: normalized.scannerVersion,
            startedAt: normalized.startedAt,
            completedAt: normalized.completedAt,
            metadata: normalized.metadata,
          },
        });

      for (const entry of normalized.entries) {
        const entryRows = await tx
          .insert(catalogLocalScanEntries)
          .values({
            localScanEntryId: entry.localScanEntryId,
            localScanId: normalized.localScanId,
            workId: entry.workId,
            pathHash: entry.pathHash,
            pathRedactionClass: entry.pathRedactionClass,
            owned: entry.owned,
            engineName: entry.engineName,
            engineSource: entry.engineSource,
            engineConfidence: entry.engineConfidence,
            signals: entry.signals,
            sourceProvenanceId: entry.sourceProvenanceId,
            scannedAt: entry.scannedAt,
            metadata: entry.metadata,
          })
          .onConflictDoUpdate({
            target: [catalogLocalScanEntries.localScanId, catalogLocalScanEntries.pathHash],
            set: {
              workId: entry.workId,
              pathHash: entry.pathHash,
              pathRedactionClass: entry.pathRedactionClass,
              owned: entry.owned,
              engineName: entry.engineName,
              engineSource: entry.engineSource,
              engineConfidence: entry.engineConfidence,
              signals: entry.signals,
              sourceProvenanceId: entry.sourceProvenanceId,
              scannedAt: entry.scannedAt,
              metadata: entry.metadata,
              updatedAt: sql`now()`,
            },
          })
          .returning({ localScanEntryId: catalogLocalScanEntries.localScanEntryId });
        const persistedLocalScanEntryId = requiredRow(
          entryRows,
          entry.localScanEntryId,
        ).localScanEntryId;

        for (const detectedExternalId of entry.detectedExternalIds) {
          await tx
            .insert(catalogLocalScanExternalIds)
            .values({
              localScanEntryId: persistedLocalScanEntryId,
              catalogSource: detectedExternalId.catalogSource,
              sourceId: detectedExternalId.sourceId,
              externalIdKind: detectedExternalId.externalIdKind,
              sourceProvenanceId: detectedExternalId.sourceProvenanceId,
              metadata: detectedExternalId.metadata,
            })
            .onConflictDoUpdate({
              target: [
                catalogLocalScanExternalIds.localScanEntryId,
                catalogLocalScanExternalIds.catalogSource,
                catalogLocalScanExternalIds.sourceId,
                catalogLocalScanExternalIds.externalIdKind,
              ],
              set: {
                sourceProvenanceId: detectedExternalId.sourceProvenanceId,
                metadata: detectedExternalId.metadata,
              },
            });
        }

        for (const seedTarget of entry.seedTargets) {
          const usesParentLocalScanEntry =
            seedTarget.localScanEntryId === null ||
            seedTarget.localScanEntryId === entry.localScanEntryId;
          await recordSeedTargetUnchecked(tx as ItotoriDatabase, {
            ...seedTarget,
            localScanEntryId: usesParentLocalScanEntry
              ? persistedLocalScanEntryId
              : seedTarget.localScanEntryId,
          });
        }
      }
    });

    return requiredLocalScan(
      await readLocalScan(this.db, normalized.localScanId),
      normalized.localScanId,
    );
  }

  async recordSeedTarget(
    actor: AuthorizationActor,
    input: CatalogSeedTargetInput,
  ): Promise<CatalogSeedTargetRecord> {
    await requirePermission(this.db, actor, permissionValues.catalogWrite);
    return recordSeedTargetUnchecked(this.db, assertSeedTargetInput(input));
  }

  async getWorkSnapshot(
    actor: AuthorizationActor,
    workId: string,
  ): Promise<CatalogWorkSnapshot | null> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    return readWorkSnapshot(this.db, requiredString(workId, "workId"));
  }

  async getWorkByExternalId(
    actor: AuthorizationActor,
    catalogSource: CatalogSource,
    sourceId: string,
    externalIdKind: CatalogExternalIdKind = catalogExternalIdKindValues.sourceRecord,
  ): Promise<CatalogWorkSnapshot | null> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    assertEnumValue(catalogSource, catalogSources, "catalogSource");
    assertEnumValue(externalIdKind, catalogExternalIdKinds, "externalIdKind");
    const externalRows = await this.db
      .select({ workId: catalogExternalIds.workId })
      .from(catalogExternalIds)
      .where(
        and(
          eq(catalogExternalIds.catalogSource, catalogSource),
          eq(catalogExternalIds.sourceId, requiredString(sourceId, "sourceId")),
          eq(catalogExternalIds.externalIdKind, externalIdKind),
        ),
      )
      .limit(1);
    const externalRow = externalRows[0];
    if (externalRow === undefined) {
      return null;
    }
    return readWorkSnapshot(this.db, externalRow.workId);
  }

  async listSeedTargets(
    actor: AuthorizationActor,
    status?: CatalogSeedStatus,
  ): Promise<CatalogSeedTargetRecord[]> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    if (status !== undefined) {
      assertEnumValue(status, catalogSeedStatuses, "status");
    }
    const rows =
      status === undefined
        ? await this.db
            .select()
            .from(catalogSeedTargets)
            .orderBy(desc(catalogSeedTargets.priority), catalogSeedTargets.addedAt)
        : await this.db
            .select()
            .from(catalogSeedTargets)
            .where(eq(catalogSeedTargets.status, status))
            .orderBy(desc(catalogSeedTargets.priority), catalogSeedTargets.addedAt);
    return rows.map(seedTargetFromRow);
  }

  async listCatalogCandidateTargetWorks(
    actor: AuthorizationActor,
  ): Promise<CatalogCandidateTargetWorkRecord[]> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    const rows = await this.db
      .select({
        workId: catalogWorks.workId,
        canonicalTitle: catalogWorks.canonicalTitle,
        firstReleaseYear: catalogWorks.firstReleaseYear,
        originalLanguage: catalogWorks.originalLanguage,
        workKind: catalogWorks.workKind,
      })
      .from(catalogWorks)
      .orderBy(catalogWorks.canonicalTitle, catalogWorks.workId);
    return rows;
  }

  async recordCatalogCandidateMatch(
    actor: AuthorizationActor,
    input: CatalogCandidateMatchInput,
  ): Promise<CatalogCandidateMatchRecord> {
    await requirePermission(this.db, actor, permissionValues.catalogWrite);
    const normalized = assertCandidateMatchInput(input);
    const rows = await this.db
      .insert(catalogCandidateMatches)
      .values(normalized)
      .onConflictDoUpdate({
        target: [
          catalogCandidateMatches.sourceCatalogSource,
          catalogCandidateMatches.sourceId,
          catalogCandidateMatches.targetWorkId,
          catalogCandidateMatches.generatorVersion,
        ],
        set: {
          sourceTitle: normalized.sourceTitle,
          sourceProvenanceId: normalized.sourceProvenanceId,
          score: normalized.score,
          matchedFields: normalized.matchedFields,
          status: normalized.status,
          diagnosticCode: normalized.diagnosticCode,
          metadata: normalized.metadata,
          updatedAt: sql`now()`,
        },
      })
      .returning();
    return candidateMatchFromRow(requiredRow(rows, normalized.candidateId));
  }

  async listCatalogCandidateMatches(
    actor: AuthorizationActor,
    status?: CatalogCandidateMatchStatus,
  ): Promise<CatalogCandidateMatchRecord[]> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    if (status !== undefined) {
      assertEnumValue(status, catalogCandidateMatchStatuses, "status");
    }
    const rows =
      status === undefined
        ? await this.db
            .select()
            .from(catalogCandidateMatches)
            .orderBy(desc(catalogCandidateMatches.score), catalogCandidateMatches.createdAt)
        : await this.db
            .select()
            .from(catalogCandidateMatches)
            .where(eq(catalogCandidateMatches.status, status))
            .orderBy(desc(catalogCandidateMatches.score), catalogCandidateMatches.createdAt);
    return rows.map(candidateMatchFromRow);
  }

  async catalogConflictReview(
    actor: AuthorizationActor,
    filter: CatalogConflictReviewFilter = {},
  ): Promise<CatalogConflictReviewReadModel> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    const normalized = assertCatalogConflictReviewFilter(filter);
    const rows = await readCatalogConflictReview(this.db);
    return {
      rows: rows.filter((row) => catalogConflictReviewRowMatches(row, normalized)),
    };
  }

  async catalogCompletenessBenchmarkPools(
    actor: AuthorizationActor,
    filter: CatalogCompletenessPoolFilter = {},
  ): Promise<CatalogCompletenessBenchmarkPools> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    return readCatalogCompletenessBenchmarkPools(this.db, assertCompletenessPoolFilter(filter));
  }

  async catalogAlphaBenchmarkOpportunityRanking(
    actor: AuthorizationActor,
    filter: CatalogAlphaBenchmarkOpportunityRankingFilter = {},
  ): Promise<CatalogAlphaBenchmarkOpportunityRanking> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    return readCatalogAlphaBenchmarkOpportunityRanking(
      this.db,
      assertAlphaBenchmarkOpportunityRankingFilter(filter),
    );
  }
}

async function readCatalogConflictReview(db: ItotoriDatabase): Promise<CatalogConflictReviewRow[]> {
  const [conflictRows, evidenceRows, candidateRows] = await Promise.all([
    db.select().from(catalogConflicts),
    db.select().from(catalogConflictEvidence),
    db.select().from(catalogCandidateMatches),
  ]);

  const provenanceIds = new Set<string>();
  const externalIdIds = new Set<string>();
  const workIds = new Set<string>();

  for (const evidence of evidenceRows) {
    if (evidence.sourceProvenanceId !== null) {
      provenanceIds.add(evidence.sourceProvenanceId);
    }
    if (evidence.subjectKind === catalogConflictSubjectKindValues.externalId) {
      externalIdIds.add(evidence.subjectId);
    }
    if (evidence.subjectKind === catalogConflictSubjectKindValues.work) {
      workIds.add(evidence.subjectId);
    }
  }
  for (const candidate of candidateRows) {
    workIds.add(candidate.targetWorkId);
    if (candidate.sourceProvenanceId !== null) {
      provenanceIds.add(candidate.sourceProvenanceId);
    }
  }

  const [externalIdRows, workExternalIdRows] = await Promise.all([
    externalIdIds.size === 0
      ? []
      : db
          .select()
          .from(catalogExternalIds)
          .where(inArray(catalogExternalIds.externalIdId, Array.from(externalIdIds))),
    workIds.size === 0
      ? []
      : db
          .select()
          .from(catalogExternalIds)
          .where(inArray(catalogExternalIds.workId, Array.from(workIds))),
  ]);
  for (const externalId of [...externalIdRows, ...workExternalIdRows]) {
    if (externalId.sourceProvenanceId !== null) {
      provenanceIds.add(externalId.sourceProvenanceId);
    }
  }

  const provenanceRows =
    provenanceIds.size === 0
      ? []
      : await db
          .select()
          .from(catalogSourceProvenance)
          .where(inArray(catalogSourceProvenance.sourceProvenanceId, Array.from(provenanceIds)));

  const provenanceById = new Map(
    provenanceRows.map((row) => [row.sourceProvenanceId, sourceProvenanceFromRow(row)]),
  );
  const exactLinkById = new Map(
    externalIdRows.map((row) => [row.externalIdId, exactLinkRefFromExternalIdRow(row)]),
  );
  const exactLinksByWorkId = new Map<string, CatalogConflictReviewExactLinkRef[]>();
  for (const row of workExternalIdRows) {
    const ref = exactLinkRefFromExternalIdRow(row);
    const existing = exactLinksByWorkId.get(ref.workId) ?? [];
    existing.push(ref);
    exactLinksByWorkId.set(ref.workId, existing);
  }
  const evidenceByConflictId = new Map<string, (typeof catalogConflictEvidence.$inferSelect)[]>();
  for (const evidence of evidenceRows) {
    const existing = evidenceByConflictId.get(evidence.conflictId) ?? [];
    existing.push(evidence);
    evidenceByConflictId.set(evidence.conflictId, existing);
  }

  const candidateRowsBySource = new Map<string, (typeof catalogCandidateMatches.$inferSelect)[]>();
  for (const candidate of candidateRows) {
    const sourceKey = `${candidate.sourceCatalogSource}:${candidate.sourceId}:${candidate.generatorVersion}`;
    const existing = candidateRowsBySource.get(sourceKey) ?? [];
    existing.push(candidate);
    candidateRowsBySource.set(sourceKey, existing);
  }

  const conflictReviewRows = conflictRows.map((conflict) =>
    catalogConflictReviewRowFromConflict(
      conflict,
      evidenceByConflictId.get(conflict.conflictId) ?? [],
      provenanceById,
      exactLinkById,
    ),
  );
  const candidateReviewRows = candidateRows.map((candidate) =>
    catalogConflictReviewRowFromCandidate(
      candidate,
      candidateRowsBySource.get(
        `${candidate.sourceCatalogSource}:${candidate.sourceId}:${candidate.generatorVersion}`,
      ) ?? [candidate],
      provenanceById,
      exactLinksByWorkId.get(candidate.targetWorkId) ?? [],
    ),
  );

  return [...conflictReviewRows, ...candidateReviewRows].sort(compareCatalogConflictReviewRows);
}

async function readCatalogCompletenessBenchmarkPools(
  db: ItotoriDatabase,
  filter: NormalizedCompletenessPoolFilter,
): Promise<CatalogCompletenessBenchmarkPools> {
  const [workRows, statusRows, externalIdRows, conflictReviewRows] = await Promise.all([
    db.select().from(catalogWorks),
    db
      .select()
      .from(catalogLanguageStatuses)
      .where(eq(catalogLanguageStatuses.language, filter.targetLanguage)),
    db.select().from(catalogExternalIds),
    readCatalogConflictReview(db),
  ]);

  const sourceProvenanceIds = new Set<string>();
  for (const status of statusRows) {
    if (status.sourceProvenanceId !== null) {
      sourceProvenanceIds.add(status.sourceProvenanceId);
    }
  }
  for (const externalId of externalIdRows) {
    if (externalId.sourceProvenanceId !== null) {
      sourceProvenanceIds.add(externalId.sourceProvenanceId);
    }
  }

  const sourceRows =
    sourceProvenanceIds.size === 0
      ? []
      : await db
          .select()
          .from(catalogSourceProvenance)
          .where(
            inArray(catalogSourceProvenance.sourceProvenanceId, Array.from(sourceProvenanceIds)),
          );
  const sourcesById = new Map(
    sourceRows.map((row) => [row.sourceProvenanceId, sourceSummaryFromRow(row)]),
  );

  const statusesByWorkId = new Map<string, (typeof catalogLanguageStatuses.$inferSelect)[]>();
  for (const status of statusRows) {
    if (!status.isCurrent) {
      continue;
    }
    const existing = statusesByWorkId.get(status.workId) ?? [];
    existing.push(status);
    statusesByWorkId.set(status.workId, existing);
  }

  const externalIdsByWorkId = new Map<string, (typeof catalogExternalIds.$inferSelect)[]>();
  for (const externalId of externalIdRows) {
    const existing = externalIdsByWorkId.get(externalId.workId) ?? [];
    existing.push(externalId);
    externalIdsByWorkId.set(externalId.workId, existing);
  }

  const languageConflictRows = conflictReviewRows.filter(
    (row) =>
      row.conflictKind === catalogConflictKindValues.languageStatus &&
      row.status === catalogConflictStatusValues.open,
  );
  const conflictsByWorkId = new Map<string, CatalogConflictReviewRow[]>();
  for (const conflict of languageConflictRows) {
    const existing = conflictsByWorkId.get(conflict.catalogRecordId) ?? [];
    existing.push(conflict);
    conflictsByWorkId.set(conflict.catalogRecordId, existing);
  }

  const pools = emptyCompletenessPools();
  for (const workRow of workRows) {
    const currentStatusRows = statusesByWorkId.get(workRow.workId) ?? [];
    const statusFacts = currentStatusRows
      .map((status) => completenessStatusFactFromRow(status, sourcesById))
      .sort(compareCompletenessStatusFacts);
    const sourceIds = sourceIdsForCompletenessWork(
      statusFacts,
      externalIdsByWorkId.get(workRow.workId) ?? [],
    );
    const conflicts = (conflictsByWorkId.get(workRow.workId) ?? []).map((row) => ({
      conflictId: row.conflictId ?? row.reviewId,
      status: row.status as CatalogConflictStatus,
      reasonCode: row.reasonCode,
      sourceIds: row.sourceIds,
    }));
    const poolWork: CatalogCompletenessPoolWork = {
      workId: workRow.workId,
      canonicalTitle: workRow.canonicalTitle,
      originalLanguage: workRow.originalLanguage,
      sourceIds,
      statuses: statusFacts,
      conflicts,
    };

    for (const pool of poolsForCompletenessWork(poolWork)) {
      pools[pool].push(poolWork);
    }
  }

  for (const pool of catalogCompletenessPools) {
    pools[pool].sort(compareCompletenessPoolWorks);
  }

  const selectedPools =
    filter.pool === undefined
      ? pools
      : {
          ...emptyCompletenessPools(),
          [filter.pool]: pools[filter.pool],
        };

  return {
    targetLanguage: filter.targetLanguage,
    pools: selectedPools,
    publicReport: publicCompletenessReport(filter.targetLanguage, selectedPools),
  };
}

async function readCatalogAlphaBenchmarkOpportunityRanking(
  db: ItotoriDatabase,
  filter: NormalizedAlphaBenchmarkOpportunityRankingFilter,
): Promise<CatalogAlphaBenchmarkOpportunityRanking> {
  const [pools, conflictRows] = await Promise.all([
    readCatalogCompletenessBenchmarkPools(db, { targetLanguage: filter.targetLanguage }),
    readCatalogConflictReview(db),
  ]);
  const candidatesByWorkId = new Map<string, DraftCatalogAlphaBenchmarkOpportunity>();
  for (const pool of [
    catalogCompletenessPoolValues.noEnglish,
    catalogCompletenessPoolValues.mtlOnly,
    catalogCompletenessPoolValues.fanPartial,
    catalogCompletenessPoolValues.unknown,
  ]) {
    for (const work of pools.pools[pool]) {
      const existing = candidatesByWorkId.get(work.workId);
      if (existing === undefined || alphaBenchmarkPoolBaseScore(pool) > existing.baseScore) {
        candidatesByWorkId.set(work.workId, {
          work,
          candidatePool: pool,
          baseScore: alphaBenchmarkPoolBaseScore(pool),
          demotions: [],
        });
      }
    }
  }

  const openLanguageConflicts = conflictRows.filter(
    (row) =>
      row.conflictKind === catalogConflictKindValues.languageStatus &&
      row.status === catalogConflictStatusValues.open,
  );
  for (const conflict of openLanguageConflicts) {
    const demotion = alphaBenchmarkDemotionFromConflict(conflict);
    const directCandidate = candidatesByWorkId.get(conflict.catalogRecordId);
    if (directCandidate === undefined) {
      const conflictWork = pools.pools[catalogCompletenessPoolValues.conflict].find(
        (work) => work.workId === conflict.catalogRecordId,
      );
      if (conflictWork !== undefined) {
        candidatesByWorkId.set(conflictWork.workId, {
          work: conflictWork,
          candidatePool: catalogCompletenessPoolValues.conflict,
          baseScore: alphaBenchmarkPoolBaseScore(catalogCompletenessPoolValues.conflict),
          demotions: [demotion],
        });
      }
    } else {
      directCandidate.demotions.push(demotion);
    }

    for (const candidate of candidatesByWorkId.values()) {
      if (candidate.work.workId === conflict.catalogRecordId) {
        continue;
      }
      if (hasSharedSourceId(candidate.work.sourceIds, conflict.sourceIds)) {
        candidate.demotions.push(demotion);
      }
    }
  }

  const ranked = Array.from(candidatesByWorkId.values())
    .filter((candidate) => filter.includeDemoted || candidate.demotions.length === 0)
    .map(alphaBenchmarkOpportunityFromDraft)
    .sort(compareAlphaBenchmarkOpportunities)
    .map((row, index) => ({ ...row, rank: index + 1 }));

  let seedRank = 0;
  const rows = ranked.map((row) => {
    if (row.decision === "demoted") {
      return row;
    }
    seedRank += 1;
    return { ...row, seedRank };
  });

  return {
    schemaVersion: "catalog.alpha_benchmark_opportunity_ranking.v0.1",
    targetLanguage: filter.targetLanguage,
    generatedAt: new Date(),
    rows,
  };
}

function assertCompletenessPoolFilter(
  filter: CatalogCompletenessPoolFilter,
): NormalizedCompletenessPoolFilter {
  if (filter.pool !== undefined) {
    assertEnumValue(filter.pool, catalogCompletenessPools, "pool");
  }
  const normalized: NormalizedCompletenessPoolFilter = {
    targetLanguage:
      filter.targetLanguage === undefined
        ? "en-US"
        : requiredString(filter.targetLanguage, "targetLanguage"),
  };
  if (filter.pool !== undefined) {
    normalized.pool = filter.pool;
  }
  return normalized;
}

function assertAlphaBenchmarkOpportunityRankingFilter(
  filter: CatalogAlphaBenchmarkOpportunityRankingFilter,
): NormalizedAlphaBenchmarkOpportunityRankingFilter {
  return {
    targetLanguage:
      filter.targetLanguage === undefined
        ? "en-US"
        : requiredString(filter.targetLanguage, "targetLanguage"),
    includeDemoted: filter.includeDemoted ?? true,
  };
}

function emptyCompletenessPools(): Record<CatalogCompletenessPool, CatalogCompletenessPoolWork[]> {
  return {
    [catalogCompletenessPoolValues.mtlOnly]: [],
    [catalogCompletenessPoolValues.fanPartial]: [],
    [catalogCompletenessPoolValues.noEnglish]: [],
    [catalogCompletenessPoolValues.unknown]: [],
    [catalogCompletenessPoolValues.conflict]: [],
  };
}

function poolsForCompletenessWork(work: CatalogCompletenessPoolWork): CatalogCompletenessPool[] {
  const statuses = work.statuses.map((status) => status.status);
  const pools: CatalogCompletenessPool[] = [];
  if (work.conflicts.length > 0) {
    pools.push(catalogCompletenessPoolValues.conflict);
  }
  if (statuses.includes(catalogLanguageStatusValues.fanPartial)) {
    pools.push(catalogCompletenessPoolValues.fanPartial);
  }
  if (
    statuses.includes(catalogLanguageStatusValues.mtl) &&
    statuses.every(
      (status) =>
        status === catalogLanguageStatusValues.mtl ||
        status === catalogLanguageStatusValues.unknown,
    )
  ) {
    pools.push(catalogCompletenessPoolValues.mtlOnly);
  }
  if (
    statuses.includes(catalogLanguageStatusValues.none) &&
    statuses.every(
      (status) =>
        status === catalogLanguageStatusValues.none ||
        status === catalogLanguageStatusValues.unknown,
    )
  ) {
    pools.push(catalogCompletenessPoolValues.noEnglish);
  }
  if (
    statuses.length === 0 ||
    statuses.every((status) => status === catalogLanguageStatusValues.unknown)
  ) {
    pools.push(catalogCompletenessPoolValues.unknown);
  }
  return pools;
}

function completenessStatusFactFromRow(
  row: typeof catalogLanguageStatuses.$inferSelect,
  sourcesById: Map<string, CatalogCompletenessSourceSummary>,
): CatalogCompletenessStatusFact {
  return {
    languageStatusId: row.languageStatusId,
    language: row.language,
    status: row.status as CatalogLanguageStatus,
    statusScope: row.statusScope as CatalogLanguageStatusScope,
    platform: row.platform,
    releaseId: row.releaseId,
    sourceProvenanceId: row.sourceProvenanceId,
    source:
      row.sourceProvenanceId === null ? null : (sourcesById.get(row.sourceProvenanceId) ?? null),
    confidence: row.confidence as CatalogConfidence,
    observedAt: row.observedAt,
    importedAt: row.importedAt,
    parserVersion: row.parserVersion,
    rawContentRedactionClass: row.rawContentRedactionClass as CatalogRawContentRedactionClass,
  };
}

function sourceSummaryFromRow(
  row: typeof catalogSourceProvenance.$inferSelect,
): CatalogCompletenessSourceSummary {
  return {
    sourceProvenanceId: row.sourceProvenanceId,
    catalogSource: row.catalogSource as CatalogSource,
    sourceRecordKind: row.sourceRecordKind as CatalogSourceRecordKind,
    sourceId: row.sourceId,
    sourceVersion: row.sourceVersion,
    fetchedAt: row.fetchedAt,
    rawContentRedactionClass: row.rawContentRedactionClass as CatalogRawContentRedactionClass,
  };
}

function sourceIdsForCompletenessWork(
  facts: CatalogCompletenessStatusFact[],
  externalIds: (typeof catalogExternalIds.$inferSelect)[],
): CatalogConflictReviewSourceId[] {
  return uniqueSourceIds([
    ...facts
      .map((fact) =>
        fact.source === null
          ? null
          : { catalogSource: fact.source.catalogSource, sourceId: fact.source.sourceId },
      )
      .filter((sourceId): sourceId is CatalogConflictReviewSourceId => sourceId !== null),
    ...externalIds.map((externalId) => ({
      catalogSource: externalId.catalogSource as CatalogSource,
      sourceId: externalId.sourceId,
    })),
  ]);
}

type DraftCatalogAlphaBenchmarkOpportunity = {
  work: CatalogCompletenessPoolWork;
  candidatePool: CatalogCompletenessPool;
  baseScore: number;
  demotions: CatalogAlphaBenchmarkOpportunityDemotion[];
};

function alphaBenchmarkPoolBaseScore(pool: CatalogCompletenessPool): number {
  switch (pool) {
    case catalogCompletenessPoolValues.noEnglish:
      return 80;
    case catalogCompletenessPoolValues.mtlOnly:
      return 60;
    case catalogCompletenessPoolValues.fanPartial:
      return 50;
    case catalogCompletenessPoolValues.unknown:
      return 20;
    case catalogCompletenessPoolValues.conflict:
      return 10;
  }
}

function alphaBenchmarkDemotionFromConflict(
  row: CatalogConflictReviewRow,
): CatalogAlphaBenchmarkOpportunityDemotion {
  return {
    reasonCode: row.reasonCode,
    reasonDetail: row.reasonDetail,
    conflictId: row.conflictId,
    severity: row.severity,
    sourceIds: row.sourceIds,
    provenance: row.provenance,
  };
}

function alphaBenchmarkOpportunityFromDraft(
  draft: DraftCatalogAlphaBenchmarkOpportunity,
): CatalogAlphaBenchmarkOpportunity {
  const demotions = uniqueAlphaBenchmarkDemotions(draft.demotions);
  const decision: CatalogAlphaBenchmarkOpportunityDecision =
    demotions.length === 0 ? "seed" : "demoted";
  const score = draft.baseScore - demotions.length * 1000;
  return {
    rank: 0,
    seedRank: decision === "seed" ? 0 : null,
    workId: draft.work.workId,
    canonicalTitle: draft.work.canonicalTitle,
    originalLanguage: draft.work.originalLanguage,
    candidatePool: draft.candidatePool,
    decision,
    score,
    explanation:
      decision === "seed"
        ? alphaBenchmarkSeedExplanation(draft.candidatePool)
        : `Demoted from alpha benchmark seed output because ${demotions
            .map((demotion) => demotion.reasonCode)
            .join(", ")}.`,
    sourceIds: draft.work.sourceIds,
    statuses: draft.work.statuses,
    demotions,
  };
}

function alphaBenchmarkSeedExplanation(pool: CatalogCompletenessPool): string {
  switch (pool) {
    case catalogCompletenessPoolValues.noEnglish:
      return "Eligible alpha benchmark seed: current catalog evidence says no English localization exists.";
    case catalogCompletenessPoolValues.mtlOnly:
      return "Eligible alpha benchmark seed: current catalog evidence says only machine translation exists.";
    case catalogCompletenessPoolValues.fanPartial:
      return "Eligible alpha benchmark seed: current catalog evidence says only partial fan localization exists.";
    case catalogCompletenessPoolValues.unknown:
      return "Eligible alpha benchmark seed: current catalog evidence is unknown and needs review.";
    case catalogCompletenessPoolValues.conflict:
      return "Eligible alpha benchmark seed: conflict review is required before use.";
  }
}

function uniqueAlphaBenchmarkDemotions(
  demotions: CatalogAlphaBenchmarkOpportunityDemotion[],
): CatalogAlphaBenchmarkOpportunityDemotion[] {
  const byKey = new Map<string, CatalogAlphaBenchmarkOpportunityDemotion>();
  for (const demotion of demotions) {
    byKey.set(`${demotion.conflictId ?? ""}:${demotion.reasonCode}`, demotion);
  }
  return Array.from(byKey.values()).sort((left, right) =>
    `${left.reasonCode}:${left.conflictId ?? ""}`.localeCompare(
      `${right.reasonCode}:${right.conflictId ?? ""}`,
    ),
  );
}

function hasSharedSourceId(
  left: CatalogConflictReviewSourceId[],
  right: CatalogConflictReviewSourceId[],
): boolean {
  const rightKeys = new Set(right.map((sourceId) => sourceIdKey(sourceId)));
  return left.some((sourceId) => rightKeys.has(sourceIdKey(sourceId)));
}

function sourceIdKey(sourceId: CatalogConflictReviewSourceId): string {
  return `${sourceId.catalogSource}:${sourceId.sourceId}`;
}

function compareAlphaBenchmarkOpportunities(
  left: CatalogAlphaBenchmarkOpportunity,
  right: CatalogAlphaBenchmarkOpportunity,
): number {
  return (
    right.score - left.score ||
    left.canonicalTitle.localeCompare(right.canonicalTitle) ||
    left.workId.localeCompare(right.workId)
  );
}

function publicCompletenessReport(
  targetLanguage: string,
  pools: Record<CatalogCompletenessPool, CatalogCompletenessPoolWork[]>,
): CatalogCompletenessPublicReport {
  const workIds = new Set<string>();
  const statusReports = new Map<CatalogLanguageStatus, CatalogCompletenessPublicStatusReport>();
  let conflictCount = 0;
  for (const works of Object.values(pools)) {
    for (const work of works) {
      workIds.add(work.workId);
      conflictCount += work.conflicts.length;
      for (const status of work.statuses) {
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
    conflictCount,
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

function compareCompletenessPoolWorks(
  left: CatalogCompletenessPoolWork,
  right: CatalogCompletenessPoolWork,
): number {
  return (
    left.canonicalTitle.localeCompare(right.canonicalTitle) ||
    left.workId.localeCompare(right.workId)
  );
}

function compareCompletenessStatusFacts(
  left: CatalogCompletenessStatusFact,
  right: CatalogCompletenessStatusFact,
): number {
  return (
    left.status.localeCompare(right.status) ||
    left.languageStatusId.localeCompare(right.languageStatusId)
  );
}

function catalogConflictReviewRowFromConflict(
  conflict: typeof catalogConflicts.$inferSelect,
  evidenceRows: (typeof catalogConflictEvidence.$inferSelect)[],
  provenanceById: Map<string, CatalogSourceProvenanceRecord>,
  exactLinkById: Map<string, CatalogConflictReviewExactLinkRef>,
): CatalogConflictReviewRow {
  const exactLinkRefs = evidenceRows
    .filter((evidence) => evidence.subjectKind === catalogConflictSubjectKindValues.externalId)
    .map((evidence) => exactLinkById.get(evidence.subjectId))
    .filter((ref): ref is CatalogConflictReviewExactLinkRef => ref !== undefined);
  const provenance = [
    ...evidenceRows
      .map((evidence) =>
        evidence.sourceProvenanceId === null
          ? undefined
          : provenanceById.get(evidence.sourceProvenanceId),
      )
      .filter((record): record is CatalogSourceProvenanceRecord => record !== undefined),
    ...exactLinkRefs
      .map((ref) =>
        ref.sourceProvenanceId === null ? undefined : provenanceById.get(ref.sourceProvenanceId),
      )
      .filter((record): record is CatalogSourceProvenanceRecord => record !== undefined),
  ].map(conflictReviewProvenanceFromRecord);
  const metadata = conflict.metadata;
  const priorCandidateIds = stringArrayMetadata(metadata, "priorCandidateIds");
  const candidateIds = uniqueStrings([
    ...priorCandidateIds,
    ...evidenceRows
      .filter((evidence) => evidence.subjectKind === catalogConflictSubjectKindValues.work)
      .flatMap((evidence) => stringArrayMetadata(evidence.metadata, "candidateIds")),
  ]);
  const candidateCatalogIds = uniqueStrings([
    conflict.workId,
    ...evidenceRows
      .filter((evidence) => evidence.subjectKind === catalogConflictSubjectKindValues.work)
      .map((evidence) => evidence.subjectId),
    ...exactLinkRefs.map((ref) => ref.workId),
  ]);

  return {
    reviewId: `catalog-conflict:${conflict.conflictId}`,
    catalogRecordId: conflict.workId,
    conflictId: conflict.conflictId,
    candidateIds,
    candidateCatalogIds,
    exactLinkRefs: exactLinkRefs.sort(compareExactLinkRefs),
    fuzzyScores: [],
    sourceIds: uniqueSourceIds([
      ...exactLinkRefs,
      ...metadataSourceIds(metadata),
      ...provenance.map(({ catalogSource, sourceId }) => ({ catalogSource, sourceId })),
    ]),
    provenance: uniqueProvenance(provenance),
    severity: conflictSeverity(conflict, exactLinkRefs),
    status: conflict.status as CatalogConflictStatus,
    reasonCode: conflictReasonCode(conflict, exactLinkRefs),
    reasonDetail: conflict.summary,
    conflictKind: conflict.conflictKind as CatalogConflictKind,
    detectedAt: conflict.detectedAt,
    resolution: conflictResolutionFromMetadata(conflict.status as CatalogConflictStatus, metadata),
  };
}

function catalogConflictReviewRowFromCandidate(
  candidate: typeof catalogCandidateMatches.$inferSelect,
  sourcePeerRows: (typeof catalogCandidateMatches.$inferSelect)[],
  provenanceById: Map<string, CatalogSourceProvenanceRecord>,
  targetExactLinkRefs: CatalogConflictReviewExactLinkRef[],
): CatalogConflictReviewRow {
  const candidateRecord = candidateMatchFromRow(candidate);
  const provenanceRecord =
    candidate.sourceProvenanceId === null
      ? undefined
      : provenanceById.get(candidate.sourceProvenanceId);
  const provenance = [
    provenanceRecord,
    ...targetExactLinkRefs.map((ref) =>
      ref.sourceProvenanceId === null ? undefined : provenanceById.get(ref.sourceProvenanceId),
    ),
  ]
    .filter((record): record is CatalogSourceProvenanceRecord => record !== undefined)
    .map(conflictReviewProvenanceFromRecord);
  const fuzzyScores = sourcePeerRows
    .map(candidateMatchFromRow)
    .map((row) => ({
      candidateId: row.candidateId,
      score: row.score,
      diagnosticCode: row.diagnosticCode,
      generatorVersion: row.generatorVersion,
    }))
    .sort(compareFuzzyScores);

  return {
    reviewId: `catalog-candidate:${candidate.candidateId}`,
    catalogRecordId: candidate.targetWorkId,
    conflictId: null,
    candidateIds: uniqueStrings(sourcePeerRows.map((row) => row.candidateId)),
    candidateCatalogIds: uniqueStrings(sourcePeerRows.map((row) => row.targetWorkId)),
    exactLinkRefs: targetExactLinkRefs.sort(compareExactLinkRefs),
    fuzzyScores,
    sourceIds: uniqueSourceIds([
      { catalogSource: candidateRecord.sourceCatalogSource, sourceId: candidateRecord.sourceId },
      ...provenance.map(({ catalogSource, sourceId }) => ({ catalogSource, sourceId })),
      ...targetExactLinkRefs,
    ]),
    provenance,
    severity: candidateSeverity(candidateRecord, sourcePeerRows),
    status: candidateRecord.status,
    reasonCode: candidateReasonCode(candidateRecord, sourcePeerRows),
    reasonDetail: candidateReasonDetail(candidateRecord, sourcePeerRows),
    conflictKind: catalogConflictKindValues.title,
    detectedAt: candidateRecord.createdAt,
    resolution: null,
  };
}

function assertCatalogConflictReviewFilter(
  filter: CatalogConflictReviewFilter,
): CatalogConflictReviewFilter {
  if (filter.source !== undefined) {
    assertEnumValue(filter.source, catalogSources, "source");
  }
  if (filter.severity !== undefined) {
    assertEnumValue(filter.severity, ["error", "warning", "info"], "severity");
  }
  if (filter.status !== undefined) {
    assertEnumValue(
      filter.status,
      [...catalogConflictStatuses, ...catalogCandidateMatchStatuses],
      "status",
    );
  }
  return {
    ...(filter.source === undefined ? {} : { source: filter.source }),
    ...(filter.severity === undefined ? {} : { severity: filter.severity }),
    ...(filter.status === undefined ? {} : { status: filter.status }),
    ...(filter.catalogRecordId === undefined
      ? {}
      : { catalogRecordId: requiredString(filter.catalogRecordId, "catalogRecordId") }),
  };
}

function catalogConflictReviewRowMatches(
  row: CatalogConflictReviewRow,
  filter: CatalogConflictReviewFilter,
): boolean {
  if (
    filter.source !== undefined &&
    !row.sourceIds.some((sourceId) => sourceId.catalogSource === filter.source)
  ) {
    return false;
  }
  if (filter.severity !== undefined && row.severity !== filter.severity) {
    return false;
  }
  if (filter.status !== undefined && row.status !== filter.status) {
    return false;
  }
  if (filter.catalogRecordId !== undefined) {
    const id = filter.catalogRecordId;
    const matchesId =
      row.reviewId === id ||
      row.conflictId === id ||
      row.catalogRecordId === id ||
      row.candidateIds.includes(id) ||
      row.candidateCatalogIds.includes(id) ||
      row.exactLinkRefs.some((ref) => ref.externalIdId === id || ref.workId === id) ||
      row.resolution?.priorCandidateIds.includes(id) === true;
    if (!matchesId) {
      return false;
    }
  }
  return true;
}

function conflictSeverity(
  conflict: typeof catalogConflicts.$inferSelect,
  exactLinkRefs: CatalogConflictReviewExactLinkRef[],
): CatalogConflictReviewSeverity {
  const metadataSeverity = stringMetadata(conflict.metadata, "severity");
  if (
    metadataSeverity === "error" ||
    metadataSeverity === "warning" ||
    metadataSeverity === "info"
  ) {
    return metadataSeverity;
  }
  if (
    conflict.status === catalogConflictStatusValues.resolved ||
    conflict.status === catalogConflictStatusValues.ignored
  ) {
    return "info";
  }
  if (conflict.conflictKind === catalogConflictKindValues.externalId || exactLinkRefs.length > 1) {
    return "error";
  }
  return "warning";
}

function conflictReasonCode(
  conflict: typeof catalogConflicts.$inferSelect,
  exactLinkRefs: CatalogConflictReviewExactLinkRef[],
): string {
  const metadataReasonCode = stringMetadata(conflict.metadata, "reasonCode");
  if (metadataReasonCode !== null) {
    return metadataReasonCode;
  }
  if (conflict.conflictKind === catalogConflictKindValues.externalId && exactLinkRefs.length > 1) {
    return "duplicate_external_id";
  }
  if (conflict.conflictKind === catalogConflictKindValues.languageStatus) {
    return "source_disagreement";
  }
  return `${conflict.conflictKind}_conflict`;
}

function candidateSeverity(
  candidate: CatalogCandidateMatchRecord,
  sourcePeerRows: (typeof catalogCandidateMatches.$inferSelect)[],
): CatalogConflictReviewSeverity {
  const metadataSeverity = stringMetadata(candidate.metadata, "severity");
  if (
    metadataSeverity === "error" ||
    metadataSeverity === "warning" ||
    metadataSeverity === "info"
  ) {
    return metadataSeverity;
  }
  if (candidate.status === catalogCandidateMatchStatusValues.duplicateSource) {
    return "info";
  }
  if (sourcePeerRows.length > 1 || candidate.score >= 850) {
    return "warning";
  }
  return "info";
}

function candidateReasonCode(
  candidate: CatalogCandidateMatchRecord,
  sourcePeerRows: (typeof catalogCandidateMatches.$inferSelect)[],
): string {
  const metadataReasonCode = stringMetadata(candidate.metadata, "reasonCode");
  if (metadataReasonCode !== null) {
    return metadataReasonCode;
  }
  if (candidate.status === catalogCandidateMatchStatusValues.duplicateSource) {
    return "stale_candidate";
  }
  if (sourcePeerRows.length > 1) {
    return "fuzzy_collision";
  }
  return candidate.diagnosticCode;
}

function candidateReasonDetail(
  candidate: CatalogCandidateMatchRecord,
  sourcePeerRows: (typeof catalogCandidateMatches.$inferSelect)[],
): string {
  if (candidate.status === catalogCandidateMatchStatusValues.duplicateSource) {
    return "Fuzzy candidate was retained as an audit row after a newer source candidate replaced it.";
  }
  if (sourcePeerRows.length > 1) {
    return "Fuzzy source record matches multiple catalog candidates and requires reviewer selection.";
  }
  return "Fuzzy source record requires reviewer selection before catalog identity can change.";
}

function conflictResolutionFromMetadata(
  status: CatalogConflictStatus,
  metadata: CatalogJsonRecord,
): CatalogConflictReviewResolution | null {
  if (status !== catalogConflictStatusValues.resolved) {
    return null;
  }
  const reviewerId = stringMetadata(metadata, "reviewerId");
  const action = stringMetadata(metadata, "resolutionAction");
  const resolvedAt = stringMetadata(metadata, "resolvedAt");
  if (reviewerId === null || action === null || resolvedAt === null) {
    return null;
  }
  return {
    reviewerId,
    action,
    resolvedAt: dateInput(resolvedAt, "metadata.resolvedAt"),
    priorCandidateIds: stringArrayMetadata(metadata, "priorCandidateIds"),
  };
}

function conflictReviewProvenanceFromRecord(
  row: CatalogSourceProvenanceRecord,
): CatalogConflictReviewProvenance {
  return {
    sourceProvenanceId: row.sourceProvenanceId,
    catalogSource: row.catalogSource,
    sourceId: row.sourceId,
    sourceRecordKind: row.sourceRecordKind,
    payloadHash: row.payloadHash,
    fetchedAt: row.fetchedAt,
  };
}

function exactLinkRefFromExternalIdRow(
  row: typeof catalogExternalIds.$inferSelect,
): CatalogConflictReviewExactLinkRef {
  return {
    externalIdId: row.externalIdId,
    catalogSource: row.catalogSource as CatalogSource,
    sourceId: row.sourceId,
    externalIdKind: row.externalIdKind as CatalogExternalIdKind,
    workId: row.workId,
    sourceProvenanceId: row.sourceProvenanceId,
  };
}

function uniqueSourceIds(
  sourceIds: CatalogConflictReviewSourceId[],
): CatalogConflictReviewSourceId[] {
  const byKey = new Map<string, CatalogConflictReviewSourceId>();
  for (const sourceId of sourceIds) {
    byKey.set(`${sourceId.catalogSource}:${sourceId.sourceId}`, sourceId);
  }
  return Array.from(byKey.values()).sort((left, right) =>
    `${left.catalogSource}:${left.sourceId}`.localeCompare(
      `${right.catalogSource}:${right.sourceId}`,
    ),
  );
}

function uniqueProvenance(
  provenance: CatalogConflictReviewProvenance[],
): CatalogConflictReviewProvenance[] {
  const byId = new Map<string, CatalogConflictReviewProvenance>();
  for (const entry of provenance) {
    byId.set(entry.sourceProvenanceId, entry);
  }
  return Array.from(byId.values()).sort((left, right) =>
    left.sourceProvenanceId.localeCompare(right.sourceProvenanceId),
  );
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function stringMetadata(metadata: CatalogJsonRecord, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function stringArrayMetadata(metadata: CatalogJsonRecord, key: string): string[] {
  const value = metadata[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function metadataSourceIds(metadata: CatalogJsonRecord): CatalogConflictReviewSourceId[] {
  const sources = metadata.sources;
  if (!Array.isArray(sources)) {
    return [];
  }
  return sources
    .map((source): CatalogConflictReviewSourceId | null => {
      if (source === null || typeof source !== "object" || Array.isArray(source)) {
        return null;
      }
      const sourceRecord = source as Record<string, unknown>;
      const catalogSource = sourceRecord.catalogSource;
      const sourceId = sourceRecord.sourceId;
      if (
        typeof catalogSource !== "string" ||
        typeof sourceId !== "string" ||
        !catalogSources.includes(catalogSource as CatalogSource)
      ) {
        return null;
      }
      return { catalogSource: catalogSource as CatalogSource, sourceId };
    })
    .filter((sourceId): sourceId is CatalogConflictReviewSourceId => sourceId !== null);
}

function compareCatalogConflictReviewRows(
  left: CatalogConflictReviewRow,
  right: CatalogConflictReviewRow,
): number {
  return (
    severityRank(left.severity) - severityRank(right.severity) ||
    left.status.localeCompare(right.status) ||
    left.reasonCode.localeCompare(right.reasonCode) ||
    left.reviewId.localeCompare(right.reviewId)
  );
}

function severityRank(severity: CatalogConflictReviewSeverity): number {
  switch (severity) {
    case "error":
      return 0;
    case "warning":
      return 1;
    case "info":
      return 2;
  }
}

function compareExactLinkRefs(
  left: CatalogConflictReviewExactLinkRef,
  right: CatalogConflictReviewExactLinkRef,
): number {
  return left.externalIdId.localeCompare(right.externalIdId);
}

function compareFuzzyScores(
  left: CatalogConflictReviewFuzzyScore,
  right: CatalogConflictReviewFuzzyScore,
): number {
  return right.score - left.score || left.candidateId.localeCompare(right.candidateId);
}

async function recordSourceProvenanceUnchecked(
  db: ItotoriDatabase,
  input: NormalizedSourceProvenanceInput,
): Promise<CatalogSourceProvenanceRecord> {
  const rows = await db
    .insert(catalogSourceProvenance)
    .values(input)
    .onConflictDoUpdate({
      target: catalogSourceProvenance.sourceProvenanceId,
      set: {
        catalogSource: input.catalogSource,
        sourceRecordKind: input.sourceRecordKind,
        sourceId: input.sourceId,
        sourceVersion: input.sourceVersion,
        requestId: input.requestId,
        httpStatus: input.httpStatus,
        ok: input.ok,
        payloadHash: input.payloadHash,
        rawContentRedactionClass: input.rawContentRedactionClass,
        payload: input.payload,
        fetchedAt: input.fetchedAt,
        metadata: input.metadata,
      },
    })
    .returning();
  return sourceProvenanceFromRow(requiredRow(rows, input.sourceProvenanceId));
}

async function recordSeedTargetUnchecked(
  db: ItotoriDatabase,
  input: NormalizedSeedTargetInput,
): Promise<CatalogSeedTargetRecord> {
  const result = await db.execute<typeof catalogSeedTargets.$inferSelect>(sql`
    insert into ${catalogSeedTargets} (
      seed_target_id,
      catalog_source,
      source_id,
      seed_origin,
      origin_ref,
      local_scan_entry_id,
      source_provenance_id,
      status,
      priority,
      added_at,
      metadata
    )
    values (
      ${input.seedTargetId},
      ${input.catalogSource},
      ${input.sourceId},
      ${input.seedOrigin},
      ${input.originRef},
      ${input.localScanEntryId},
      ${input.sourceProvenanceId},
      ${input.status},
      ${input.priority},
      ${input.addedAt},
      ${input.metadata}::jsonb
    )
    on conflict (catalog_source, source_id, seed_origin, coalesce(origin_ref, ''))
    do update set
      catalog_source = excluded.catalog_source,
      source_id = excluded.source_id,
      seed_origin = excluded.seed_origin,
      origin_ref = excluded.origin_ref,
      local_scan_entry_id = excluded.local_scan_entry_id,
      source_provenance_id = excluded.source_provenance_id,
      status = excluded.status,
      priority = excluded.priority,
      added_at = excluded.added_at,
      metadata = excluded.metadata,
      updated_at = now()
    returning
      seed_target_id as "seedTargetId",
      catalog_source as "catalogSource",
      source_id as "sourceId",
      seed_origin as "seedOrigin",
      origin_ref as "originRef",
      local_scan_entry_id as "localScanEntryId",
      source_provenance_id as "sourceProvenanceId",
      status,
      priority,
      added_at as "addedAt",
      metadata,
      updated_at as "updatedAt"
  `);
  return seedTargetFromRow(requiredRow(result.rows, input.seedTargetId));
}

async function readWorkSnapshot(
  db: ItotoriDatabase,
  workId: string,
): Promise<CatalogWorkSnapshot | null> {
  const workRows = await db
    .select()
    .from(catalogWorks)
    .where(eq(catalogWorks.workId, workId))
    .limit(1);
  const workRow = workRows[0];
  if (workRow === undefined) {
    return null;
  }

  const [
    externalIdRows,
    releaseRows,
    releaseMappingRows,
    installStateRows,
    languageStatusRows,
    demandFactRows,
    conflictRows,
    localScanEntryRows,
  ] = await Promise.all([
    db.select().from(catalogExternalIds).where(eq(catalogExternalIds.workId, workId)),
    db.select().from(catalogReleases).where(eq(catalogReleases.workId, workId)),
    db.select().from(catalogReleaseMappings).where(eq(catalogReleaseMappings.workId, workId)),
    db
      .select()
      .from(catalogReleaseInstallStates)
      .where(eq(catalogReleaseInstallStates.workId, workId)),
    db.select().from(catalogLanguageStatuses).where(eq(catalogLanguageStatuses.workId, workId)),
    db.select().from(catalogDemandFacts).where(eq(catalogDemandFacts.workId, workId)),
    db.select().from(catalogConflicts).where(eq(catalogConflicts.workId, workId)),
    db.select().from(catalogLocalScanEntries).where(eq(catalogLocalScanEntries.workId, workId)),
  ]);
  const localScanEntryIds = localScanEntryRows.map((row) => row.localScanEntryId);
  const seedTargetRows =
    localScanEntryIds.length === 0
      ? []
      : await db
          .select()
          .from(catalogSeedTargets)
          .where(inArray(catalogSeedTargets.localScanEntryId, localScanEntryIds));

  const conflictEvidenceRows =
    conflictRows.length === 0
      ? []
      : await db
          .select()
          .from(catalogConflictEvidence)
          .where(
            inArray(
              catalogConflictEvidence.conflictId,
              conflictRows.map((row) => row.conflictId),
            ),
          );
  const evidenceByConflict = new Map<string, CatalogConflictEvidenceRecord[]>();
  for (const row of conflictEvidenceRows) {
    const evidence = conflictEvidenceFromRow(row);
    const existing = evidenceByConflict.get(evidence.conflictId) ?? [];
    existing.push(evidence);
    evidenceByConflict.set(evidence.conflictId, existing);
  }

  const localScanEntries = await localScanEntriesWithChildren(db, localScanEntryRows);

  return {
    ...workFromRow(workRow),
    externalIds: externalIdRows.map(externalIdFromRow),
    releases: releaseRows.map(releaseFromRow),
    releaseMappings: releaseMappingRows.map(releaseMappingFromRow),
    installStates: installStateRows.map(releaseInstallStateFromRow),
    languageStatuses: languageStatusRows.map(languageStatusFromRow),
    demandFacts: demandFactRows.map(demandFactFromRow),
    conflicts: conflictRows.map((row) => ({
      ...conflictFromRow(row),
      evidence: evidenceByConflict.get(row.conflictId) ?? [],
    })),
    localScanEntries,
    seedTargets: seedTargetRows.map(seedTargetFromRow),
  };
}

async function readLocalScan(
  db: ItotoriDatabase,
  localScanId: string,
): Promise<CatalogLocalScanRecord | null> {
  const scanRows = await db
    .select()
    .from(catalogLocalScans)
    .where(eq(catalogLocalScans.localScanId, localScanId))
    .limit(1);
  const scanRow = scanRows[0];
  if (scanRow === undefined) {
    return null;
  }

  const entryRows = await db
    .select()
    .from(catalogLocalScanEntries)
    .where(eq(catalogLocalScanEntries.localScanId, localScanId));
  return {
    ...localScanFromRow(scanRow),
    entries: await localScanEntriesWithChildren(db, entryRows),
  };
}

async function localScanEntriesWithChildren(
  db: ItotoriDatabase,
  entries: (typeof catalogLocalScanEntries.$inferSelect)[],
): Promise<CatalogLocalScanEntryRecord[]> {
  const records: CatalogLocalScanEntryRecord[] = [];
  for (const entry of entries) {
    const [detectedExternalIdRows, seedTargetRows] = await Promise.all([
      db
        .select()
        .from(catalogLocalScanExternalIds)
        .where(eq(catalogLocalScanExternalIds.localScanEntryId, entry.localScanEntryId)),
      db
        .select()
        .from(catalogSeedTargets)
        .where(eq(catalogSeedTargets.localScanEntryId, entry.localScanEntryId)),
    ]);
    records.push({
      ...localScanEntryFromRow(entry),
      detectedExternalIds: detectedExternalIdRows.map(localScanDetectedExternalIdFromRow),
      seedTargets: seedTargetRows.map(seedTargetFromRow),
    });
  }
  return records;
}

type NormalizedSourceProvenanceInput = {
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
};

function assertSourceProvenanceInput(
  input: CatalogSourceProvenanceInput,
): NormalizedSourceProvenanceInput {
  assertEnumValue(input.catalogSource, catalogSources, "catalogSource");
  assertEnumValue(input.sourceRecordKind, catalogSourceRecordKinds, "sourceRecordKind");
  const httpStatus = input.httpStatus ?? null;
  if (
    httpStatus !== null &&
    (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599)
  ) {
    throw new Error("httpStatus must be a valid HTTP status code");
  }
  if (input.payloadHash !== undefined) {
    assertSha256(input.payloadHash, "payloadHash");
  }
  if (input.rawContentRedactionClass !== undefined) {
    assertEnumValue(
      input.rawContentRedactionClass,
      catalogRawContentRedactionClasses,
      "rawContentRedactionClass",
    );
  }
  return {
    sourceProvenanceId: input.sourceProvenanceId ?? createUuid7(),
    catalogSource: input.catalogSource,
    sourceRecordKind: input.sourceRecordKind,
    sourceId: requiredString(input.sourceId, "sourceId"),
    sourceVersion: optionalString(input.sourceVersion, "sourceVersion"),
    requestId: optionalString(input.requestId, "requestId"),
    httpStatus,
    ok: input.ok ?? true,
    payloadHash: input.payloadHash ?? null,
    rawContentRedactionClass:
      input.rawContentRedactionClass ?? catalogRawContentRedactionClassValues.publicMetadata,
    payload: jsonRecord(input.payload ?? {}, "payload"),
    fetchedAt: dateInput(input.fetchedAt, "fetchedAt"),
    metadata: jsonRecord(input.metadata ?? {}, "metadata"),
  };
}

type NormalizedCatalogWorkInput = {
  workId: string;
  canonicalTitle: string;
  originalLanguage: string | null;
  firstReleaseYear: number | null;
  workKind: string;
  engine: NormalizedCatalogEngineInput | null;
  metadata: CatalogJsonRecord;
  externalIds: NormalizedExternalIdInput[];
  releases: NormalizedReleaseInput[];
  releaseMappings: NormalizedReleaseMappingInput[];
  installStates: NormalizedReleaseInstallStateInput[];
  languageStatuses: NormalizedLanguageStatusInput[];
  demandFacts: NormalizedDemandFactInput[];
  conflicts: NormalizedConflictInput[];
};

type NormalizedCatalogEngineInput = {
  engineName: string;
  engineSource: CatalogEngineSource;
  engineConfidence: CatalogConfidence;
  engineProvenanceId: string | null;
};

type NormalizedExternalIdInput = {
  externalIdId: string;
  catalogSource: CatalogSource;
  sourceId: string;
  externalIdKind: CatalogExternalIdKind;
  sourceProvenanceId: string | null;
  confidence: CatalogConfidence;
  discoveredAt: Date;
  metadata: CatalogJsonRecord;
};

type NormalizedReleaseInput = {
  releaseId: string;
  catalogSource: CatalogSource;
  sourceReleaseId: string | null;
  releaseTitle: string;
  releaseKind: CatalogReleaseKind;
  editionName: string | null;
  milestone: string | null;
  packageKind: CatalogReleasePackageKind;
  engine: NormalizedCatalogEngineInput | null;
  platform: string | null;
  language: string | null;
  releaseDate: string | null;
  releaseYear: number | null;
  isOfficial: boolean;
  sourceProvenanceId: string | null;
  metadata: CatalogJsonRecord;
};

type NormalizedReleaseMappingInput = {
  releaseMappingId: string;
  sourceReleaseId: string;
  targetReleaseId: string;
  relationKind: CatalogReleaseMappingKind;
  portability: CatalogTranslationPortability;
  sourceProvenanceId: string | null;
  confidence: CatalogConfidence;
  observedAt: Date;
  metadata: CatalogJsonRecord;
};

type NormalizedReleaseInstallStateInput = {
  installStateId: string;
  releaseId: string;
  localScanEntryId: string | null;
  installState: CatalogInstallState;
  targetArtifactLabel: string | null;
  sourceProvenanceId: string | null;
  confidence: CatalogConfidence;
  observedAt: Date;
  metadata: CatalogJsonRecord;
};

type NormalizedLanguageStatusInput = {
  languageStatusId: string;
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
};

type NormalizedDemandFactInput = {
  demandFactId: string;
  catalogSource: CatalogSource;
  sourceId: string;
  factKind: CatalogDemandFactKind;
  factValue: CatalogJsonRecord;
  observedAt: Date;
  sourceProvenanceId: string | null;
  parserVersion: string;
  metadata: CatalogJsonRecord;
};

type NormalizedConflictInput = {
  conflictId: string;
  conflictKind: CatalogConflictKind;
  status: CatalogConflictStatus;
  summary: string;
  detectedAt: Date;
  metadata: CatalogJsonRecord;
  evidence: NormalizedConflictEvidenceInput[];
};

type NormalizedConflictEvidenceInput = {
  conflictEvidenceId: string;
  subjectKind: CatalogConflictSubjectKind;
  subjectId: string;
  sourceProvenanceId: string | null;
  evidencePosition: number;
  metadata: CatalogJsonRecord;
};

function assertCatalogWorkInput(input: CatalogWorkInput): NormalizedCatalogWorkInput {
  const firstReleaseYear = optionalYear(input.firstReleaseYear, "firstReleaseYear");
  let engine: NormalizedCatalogEngineInput | null = null;
  if (input.engine !== undefined) {
    assertEnumValue(input.engine.engineSource, catalogEngineSources, "engine.engineSource");
    if (input.engine.engineConfidence !== undefined) {
      assertEnumValue(input.engine.engineConfidence, catalogConfidences, "engine.engineConfidence");
    }
    engine = {
      engineName: requiredString(input.engine.engineName, "engine.engineName"),
      engineSource: input.engine.engineSource,
      engineConfidence: input.engine.engineConfidence ?? catalogConfidenceValues.unknown,
      engineProvenanceId: input.engine.engineProvenanceId ?? null,
    };
  }

  return {
    workId: input.workId ?? createUuid7(),
    canonicalTitle: requiredString(input.canonicalTitle, "canonicalTitle"),
    originalLanguage: optionalString(input.originalLanguage, "originalLanguage"),
    firstReleaseYear,
    workKind: input.workKind === undefined ? "game" : requiredString(input.workKind, "workKind"),
    engine,
    metadata: jsonRecord(input.metadata ?? {}, "metadata"),
    externalIds: (input.externalIds ?? []).map(assertExternalIdInput),
    releases: (input.releases ?? []).map(assertReleaseInput),
    releaseMappings: (input.releaseMappings ?? []).map(assertReleaseMappingInput),
    installStates: (input.installStates ?? []).map(assertReleaseInstallStateInput),
    languageStatuses: (input.languageStatuses ?? []).map(assertLanguageStatusInput),
    demandFacts: (input.demandFacts ?? []).map(assertDemandFactInput),
    conflicts: (input.conflicts ?? []).map(assertConflictInput),
  };
}

function assertExternalIdInput(input: CatalogExternalIdInput): NormalizedExternalIdInput {
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

function assertReleaseInput(input: CatalogReleaseInput): NormalizedReleaseInput {
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

function assertReleaseMappingInput(
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
    throw new Error("releaseMapping source and target releases must differ");
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

function assertReleaseInstallStateInput(
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

function assertLanguageStatusInput(
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

function assertDemandFactInput(input: CatalogDemandFactInput): NormalizedDemandFactInput {
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

function assertConflictInput(input: CatalogConflictInput): NormalizedConflictInput {
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

function assertConflictEvidenceInput(
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

type NormalizedLocalScanInput = {
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

type NormalizedLocalScanEntryInput = {
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

type NormalizedLocalScanDetectedExternalIdInput = {
  catalogSource: CatalogSource;
  sourceId: string;
  externalIdKind: CatalogExternalIdKind;
  sourceProvenanceId: string | null;
  metadata: CatalogJsonRecord;
};

type NormalizedSeedTargetInput = {
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

type NormalizedCandidateMatchInput = {
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
};

type NormalizedCompletenessPoolFilter = {
  targetLanguage: string;
  pool?: CatalogCompletenessPool;
};

type NormalizedAlphaBenchmarkOpportunityRankingFilter = {
  targetLanguage: string;
  includeDemoted: boolean;
};

function assertLocalScanInput(input: CatalogLocalScanInput): NormalizedLocalScanInput {
  assertSha256(input.scanRootPathHash, "scanRootPathHash");
  const startedAt =
    input.startedAt === undefined ? new Date() : dateInput(input.startedAt, "startedAt");
  const completedAt =
    input.completedAt === undefined ? startedAt : dateInput(input.completedAt, "completedAt");
  if (completedAt.getTime() < startedAt.getTime()) {
    throw new Error("completedAt must not be before startedAt");
  }
  return {
    localScanId: input.localScanId ?? createUuid7(),
    scanRootLabel: requiredString(input.scanRootLabel, "scanRootLabel"),
    scanRootPathHash: input.scanRootPathHash,
    scannerName: requiredString(input.scannerName, "scannerName"),
    scannerVersion: requiredString(input.scannerVersion, "scannerVersion"),
    startedAt,
    completedAt,
    metadata: jsonRecord(input.metadata ?? {}, "metadata"),
    entries: input.entries.map((entry) => assertLocalScanEntryInput(entry, completedAt)),
  };
}

function assertLocalScanEntryInput(
  input: CatalogLocalScanEntryInput,
  defaultScannedAt: Date,
): NormalizedLocalScanEntryInput {
  assertSha256(input.pathHash, "entry.pathHash");
  if (input.pathRedactionClass !== undefined) {
    assertEnumValue(
      input.pathRedactionClass,
      catalogPathRedactionClasses,
      "entry.pathRedactionClass",
    );
  }
  if (input.engineSource !== undefined) {
    assertEnumValue(input.engineSource, catalogEngineSources, "entry.engineSource");
  }
  if (input.engineConfidence !== undefined) {
    assertEnumValue(input.engineConfidence, catalogConfidences, "entry.engineConfidence");
  }
  const normalizedEntryId = input.localScanEntryId ?? createUuid7();
  return {
    localScanEntryId: normalizedEntryId,
    workId: input.workId ?? null,
    pathHash: input.pathHash,
    pathRedactionClass: input.pathRedactionClass ?? catalogPathRedactionClassValues.privatePathHash,
    owned: input.owned ?? true,
    engineName: optionalString(input.engineName, "entry.engineName"),
    engineSource: input.engineSource ?? null,
    engineConfidence: input.engineConfidence ?? null,
    signals: jsonRecord(input.signals ?? {}, "entry.signals"),
    sourceProvenanceId: input.sourceProvenanceId ?? null,
    scannedAt:
      input.scannedAt === undefined
        ? defaultScannedAt
        : dateInput(input.scannedAt, "entry.scannedAt"),
    metadata: jsonRecord(input.metadata ?? {}, "entry.metadata"),
    detectedExternalIds: (input.detectedExternalIds ?? []).map(
      assertLocalScanDetectedExternalIdInput,
    ),
    seedTargets: (input.seedTargets ?? []).map((seedTarget) =>
      assertSeedTargetInput({
        ...seedTarget,
        localScanEntryId: seedTarget.localScanEntryId ?? normalizedEntryId,
      }),
    ),
  };
}

function assertLocalScanDetectedExternalIdInput(
  input: CatalogLocalScanDetectedExternalIdInput,
): NormalizedLocalScanDetectedExternalIdInput {
  assertEnumValue(input.catalogSource, catalogSources, "detectedExternalId.catalogSource");
  if (input.externalIdKind !== undefined) {
    assertEnumValue(
      input.externalIdKind,
      catalogExternalIdKinds,
      "detectedExternalId.externalIdKind",
    );
  }
  return {
    catalogSource: input.catalogSource,
    sourceId: requiredString(input.sourceId, "detectedExternalId.sourceId"),
    externalIdKind: input.externalIdKind ?? catalogExternalIdKindValues.localDetection,
    sourceProvenanceId: input.sourceProvenanceId ?? null,
    metadata: jsonRecord(input.metadata ?? {}, "detectedExternalId.metadata"),
  };
}

function assertSeedTargetInput(input: CatalogSeedTargetInput): NormalizedSeedTargetInput {
  assertEnumValue(input.catalogSource, catalogSources, "seedTarget.catalogSource");
  if (input.seedOrigin !== undefined) {
    assertEnumValue(input.seedOrigin, catalogSeedOrigins, "seedTarget.seedOrigin");
  }
  if (input.status !== undefined) {
    assertEnumValue(input.status, catalogSeedStatuses, "seedTarget.status");
  }
  const priority = input.priority ?? 0;
  if (!Number.isInteger(priority)) {
    throw new Error("seedTarget.priority must be an integer");
  }
  return {
    seedTargetId: input.seedTargetId ?? createUuid7(),
    catalogSource: input.catalogSource,
    sourceId: requiredString(input.sourceId, "seedTarget.sourceId"),
    seedOrigin: input.seedOrigin ?? catalogSeedOriginValues.manual,
    originRef: optionalString(input.originRef, "seedTarget.originRef"),
    localScanEntryId: input.localScanEntryId ?? null,
    sourceProvenanceId: input.sourceProvenanceId ?? null,
    status: input.status ?? catalogSeedStatusValues.pending,
    priority,
    addedAt:
      input.addedAt === undefined ? new Date() : dateInput(input.addedAt, "seedTarget.addedAt"),
    metadata: jsonRecord(input.metadata ?? {}, "seedTarget.metadata"),
  };
}

function assertCandidateMatchInput(
  input: CatalogCandidateMatchInput,
): NormalizedCandidateMatchInput {
  assertEnumValue(input.sourceCatalogSource, catalogSources, "candidate.sourceCatalogSource");
  if (input.status !== undefined) {
    assertEnumValue(input.status, catalogCandidateMatchStatuses, "candidate.status");
  }
  if (!Number.isInteger(input.score) || input.score < 0 || input.score > 1000) {
    throw new Error("candidate.score must be an integer between 0 and 1000");
  }
  return {
    candidateId: input.candidateId ?? createUuid7(),
    sourceCatalogSource: input.sourceCatalogSource,
    sourceId: requiredString(input.sourceId, "candidate.sourceId"),
    sourceTitle: requiredString(input.sourceTitle, "candidate.sourceTitle"),
    sourceProvenanceId: input.sourceProvenanceId ?? null,
    targetWorkId: requiredString(input.targetWorkId, "candidate.targetWorkId"),
    score: input.score,
    matchedFields: jsonRecord(input.matchedFields, "candidate.matchedFields"),
    status: input.status ?? catalogCandidateMatchStatusValues.reviewPending,
    diagnosticCode: requiredString(input.diagnosticCode, "candidate.diagnosticCode"),
    generatorVersion: requiredString(input.generatorVersion, "candidate.generatorVersion"),
    metadata: jsonRecord(input.metadata ?? {}, "candidate.metadata"),
  };
}

function sourceProvenanceFromRow(
  row: typeof catalogSourceProvenance.$inferSelect,
): CatalogSourceProvenanceRecord {
  return {
    sourceProvenanceId: row.sourceProvenanceId,
    catalogSource: row.catalogSource as CatalogSource,
    sourceRecordKind: row.sourceRecordKind as CatalogSourceRecordKind,
    sourceId: row.sourceId,
    sourceVersion: row.sourceVersion,
    requestId: row.requestId,
    httpStatus: row.httpStatus,
    ok: row.ok,
    payloadHash: row.payloadHash,
    rawContentRedactionClass: row.rawContentRedactionClass as CatalogRawContentRedactionClass,
    payload: row.payload,
    fetchedAt: row.fetchedAt,
    metadata: row.metadata,
    recordedAt: row.recordedAt,
  };
}

function workFromRow(row: typeof catalogWorks.$inferSelect): CatalogWorkRecord {
  return {
    workId: row.workId,
    canonicalTitle: row.canonicalTitle,
    originalLanguage: row.originalLanguage,
    firstReleaseYear: row.firstReleaseYear,
    workKind: row.workKind,
    engineName: row.engineName,
    engineSource: row.engineSource as CatalogEngineSource | null,
    engineConfidence: row.engineConfidence as CatalogConfidence | null,
    engineProvenanceId: row.engineProvenanceId,
    metadata: row.metadata,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function externalIdFromRow(row: typeof catalogExternalIds.$inferSelect): CatalogExternalIdRecord {
  return {
    externalIdId: row.externalIdId,
    workId: row.workId,
    catalogSource: row.catalogSource as CatalogSource,
    sourceId: row.sourceId,
    externalIdKind: row.externalIdKind as CatalogExternalIdKind,
    sourceProvenanceId: row.sourceProvenanceId,
    confidence: row.confidence as CatalogConfidence,
    discoveredAt: row.discoveredAt,
    metadata: row.metadata,
  };
}

function releaseFromRow(row: typeof catalogReleases.$inferSelect): CatalogReleaseRecord {
  return {
    releaseId: row.releaseId,
    workId: row.workId,
    catalogSource: row.catalogSource as CatalogSource,
    sourceReleaseId: row.sourceReleaseId,
    releaseTitle: row.releaseTitle,
    releaseKind: row.releaseKind as CatalogReleaseKind,
    editionName: row.editionName,
    milestone: row.milestone,
    packageKind: row.packageKind as CatalogReleasePackageKind,
    engineName: row.engineName,
    engineSource: row.engineSource as CatalogEngineSource | null,
    engineConfidence: row.engineConfidence as CatalogConfidence | null,
    engineProvenanceId: row.engineProvenanceId,
    platform: row.platform,
    language: row.language,
    releaseDate: row.releaseDate,
    releaseYear: row.releaseYear,
    isOfficial: row.isOfficial,
    sourceProvenanceId: row.sourceProvenanceId,
    metadata: row.metadata,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function releaseMappingFromRow(
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

function releaseInstallStateFromRow(
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

function languageStatusFromRow(
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

function demandFactFromRow(row: typeof catalogDemandFacts.$inferSelect): CatalogDemandFactRecord {
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

function conflictFromRow(
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

function conflictEvidenceFromRow(
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

function localScanFromRow(
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

function localScanEntryFromRow(
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

function localScanDetectedExternalIdFromRow(
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

function seedTargetFromRow(row: typeof catalogSeedTargets.$inferSelect): CatalogSeedTargetRecord {
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

function candidateMatchFromRow(
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

function requiredSnapshot(
  snapshot: CatalogWorkSnapshot | null,
  workId: string,
): CatalogWorkSnapshot {
  if (snapshot === null) {
    throw new Error(`catalog work ${workId} was not persisted`);
  }
  return snapshot;
}

function requiredLocalScan(
  scan: CatalogLocalScanRecord | null,
  localScanId: string,
): CatalogLocalScanRecord {
  if (scan === null) {
    throw new Error(`local scan ${localScanId} was not persisted`);
  }
  return scan;
}

function requiredRow<T>(rows: T[], id: string): T {
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`record ${id} was not persisted`);
  }
  return row;
}

function requiredString(value: string | undefined, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${fieldName} is required`);
  }
  return value;
}

function optionalString(value: string | undefined, fieldName: string): string | null {
  if (value === undefined) {
    return null;
  }
  return requiredString(value, fieldName);
}

function optionalYear(value: number | undefined, fieldName: string): number | null {
  if (value === undefined) {
    return null;
  }
  if (!Number.isInteger(value) || value < 1970 || value > 2200) {
    throw new Error(`${fieldName} must be an integer year`);
  }
  return value;
}

function dateInput(value: CatalogDateInput, fieldName: string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${fieldName} must be a valid date`);
  }
  return date;
}

function jsonRecord(value: CatalogJsonRecord, fieldName: string): CatalogJsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${fieldName} must be a JSON object`);
  }
  return value;
}

function assertSha256(value: string, fieldName: string): void {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${fieldName} must be a sha256 hash`);
  }
}

function assertEnumValue<T extends string>(
  value: string,
  allowed: readonly T[],
  fieldName: string,
): asserts value is T {
  if (!allowed.includes(value as T)) {
    throw new Error(`${fieldName} must be one of ${allowed.join(", ")}`);
  }
}
