import {
  CapabilityLevel,
  CatalogCandidateMatchStatus,
  CatalogConfidence,
  CatalogEngineSource,
  CatalogExternalIdKind,
  CatalogLanguageStatus,
  CatalogRawContentRedactionClass,
  CatalogReleaseKind,
  CatalogReleasePackageKind,
  CatalogSource,
  CatalogSourceRecordKind,
  catalogCandidateMatchStatusValues,
  catalogExternalIdKindValues,
  catalogExternalIds,
  catalogPathRedactionClassValues,
  catalogReleases,
  catalogSeedOriginValues,
  catalogSeedStatusValues,
  catalogSourceProvenance,
  catalogWorks,
  createUuid7,
} from "./dependencies.js";
import {
  CatalogExternalIdRecord,
  CatalogJsonRecord,
  CatalogReleaseRecord,
  CatalogSourceProvenanceRecord,
} from "./catalog-domain-01.js";
import {
  CatalogCandidateMatchInput,
  CatalogLocalScanDetectedExternalIdInput,
  CatalogLocalScanEntryInput,
  CatalogLocalScanInput,
  CatalogSeedTargetInput,
  CatalogWorkRecord,
} from "./catalog-domain-02.js";
import {
  CatalogBenchmarkDemandBucket,
  CatalogBenchmarkLocalOwnership,
  CatalogCompletenessPool,
} from "./catalog-domain-03.js";
import {
  catalogCandidateMatchStatuses,
  catalogConfidences,
  catalogEngineSources,
  catalogExternalIdKinds,
  catalogPathRedactionClasses,
  catalogSeedOrigins,
  catalogSeedStatuses,
  catalogSources,
} from "./catalog-domain-04.js";
import {
  NormalizedLocalScanDetectedExternalIdInput,
  NormalizedLocalScanEntryInput,
  NormalizedLocalScanInput,
  NormalizedSeedTargetInput,
} from "./catalog-domain-20.js";
import { assertSha256, dateInput, jsonRecord, optionalString } from "./catalog-domain-22.js";
import { requiredString } from "../../required-string.js";
import { assertEnumValue } from "./catalog-domain-23.js";

export type NormalizedCandidateMatchInput = {
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

export type NormalizedCompletenessPoolFilter = {
  targetLanguage: string;
  pool?: CatalogCompletenessPool;
};

export type NormalizedAlphaBenchmarkOpportunityRankingFilter = {
  targetLanguage: string;
  includeDemoted: boolean;
};

export type NormalizedBenchmarkSeedFinderFilter = {
  targetLanguage: string;
  pools: CatalogCompletenessPool[] | null;
  minCapabilityLevel: CapabilityLevel | null;
  requiredCapabilities: CapabilityLevel[];
  adapterIds: string[] | null;
  demandBucket: CatalogBenchmarkDemandBucket | null;
  translationCompleteness: CatalogLanguageStatus[] | null;
  provenanceRequired: boolean;
  localOwnership: CatalogBenchmarkLocalOwnership | null;
  includeDemoted: boolean;
  limit: number;
};

export type NormalizedCatalogOpportunityRankingFilter = {
  targetLanguage: string;
  includeDemoted: boolean;
  limit: number;
  engine: string | null;
  pool: CatalogCompletenessPool | null;
  minCapabilityLevel: CapabilityLevel | null;
  localOwnership: CatalogBenchmarkLocalOwnership | null;
  demandBucket: CatalogBenchmarkDemandBucket | null;
};

export function assertLocalScanInput(input: CatalogLocalScanInput): NormalizedLocalScanInput {
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

export function assertLocalScanEntryInput(
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

export function assertLocalScanDetectedExternalIdInput(
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

export function assertSeedTargetInput(input: CatalogSeedTargetInput): NormalizedSeedTargetInput {
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

export function assertCandidateMatchInput(
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

export function sourceProvenanceFromRow(
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

export function workFromRow(row: typeof catalogWorks.$inferSelect): CatalogWorkRecord {
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

export function externalIdFromRow(
  row: typeof catalogExternalIds.$inferSelect,
): CatalogExternalIdRecord {
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

export function releaseFromRow(row: typeof catalogReleases.$inferSelect): CatalogReleaseRecord {
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
