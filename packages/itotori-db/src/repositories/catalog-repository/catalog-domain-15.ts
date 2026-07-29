import {
  CatalogConflictStatus,
  CatalogExternalIdKind,
  CatalogRawContentRedactionClass,
  CatalogSource,
  catalogCandidateMatchStatusValues,
  catalogCandidateMatches,
  catalogConflictKindValues,
  catalogConflictStatusValues,
  catalogConflicts,
  catalogExternalIds,
  catalogPlatformLanguageConflictOriginValues,
  catalogRawContentRedactionClassValues,
} from "./dependencies.js";
import { CatalogJsonRecord, CatalogSourceProvenanceRecord } from "./catalog-domain-01.js";
import {
  CatalogCandidateMatchRecord,
  CatalogConflictReviewExactLinkRef,
  CatalogConflictReviewProvenance,
  CatalogConflictReviewResolution,
  CatalogConflictReviewSeverity,
  CatalogConflictReviewSourceId,
} from "./catalog-domain-02.js";
import { CatalogConflictReviewFilter, CatalogConflictReviewRow } from "./catalog-domain-03.js";
import {
  catalogCandidateMatchStatuses,
  catalogConflictStatuses,
  catalogSources,
} from "./catalog-domain-04.js";
import {
  compareExactLinkRefs,
  compareFuzzyScores,
  countPrivateSourceIdentities,
  isPrivateSourceProvenance,
  isPublicSourceId,
  stringArrayMetadata,
  stringMetadata,
  uniqueSourceIds,
  uniqueStrings,
} from "./catalog-domain-16.js";
import { candidateMatchFromRow, dateInput } from "./catalog-domain-22.js";
import { requiredString } from "../../required-string.js";
import { assertEnumValue } from "./catalog-domain-23.js";

export function catalogConflictReviewRowFromCandidate(
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
  const rawProvenance = [
    provenanceRecord,
    ...targetExactLinkRefs.map((ref) =>
      ref.sourceProvenanceId === null ? undefined : provenanceById.get(ref.sourceProvenanceId),
    ),
  ].filter((record): record is CatalogSourceProvenanceRecord => record !== undefined);
  const publicTargetExactLinkRefs = targetExactLinkRefs.filter(isPublicSourceId);
  const provenance = rawProvenance
    .filter((record) => !isPrivateSourceProvenance(record))
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
  const candidateSourceId: CatalogConflictReviewSourceId = {
    catalogSource: candidateRecord.sourceCatalogSource,
    sourceId: candidateRecord.sourceId,
  };

  return {
    reviewId: `catalog-candidate:${candidate.candidateId}`,
    catalogRecordId: candidate.targetWorkId,
    conflictId: null,
    candidateIds: uniqueStrings(sourcePeerRows.map((row) => row.candidateId)),
    candidateCatalogIds: uniqueStrings(sourcePeerRows.map((row) => row.targetWorkId)),
    exactLinkRefs: publicTargetExactLinkRefs.sort(compareExactLinkRefs),
    fuzzyScores,
    sourceIds: uniqueSourceIds([
      ...[candidateSourceId].filter(isPublicSourceId),
      ...provenance.map(({ catalogSource, sourceId }) => ({ catalogSource, sourceId })),
      ...publicTargetExactLinkRefs,
    ]),
    provenance,
    privateSourceCount: countPrivateSourceIdentities(
      [candidateSourceId, ...targetExactLinkRefs],
      rawProvenance,
    ),
    severity: candidateSeverity(candidateRecord, sourcePeerRows),
    status: candidateRecord.status,
    reasonCode: candidateReasonCode(candidateRecord, sourcePeerRows),
    reasonDetail: candidateReasonDetail(candidateRecord, sourcePeerRows),
    conflictOrigin: catalogPlatformLanguageConflictOriginValues.fixtureAuthored,
    conflictKind: catalogConflictKindValues.title,
    detectedAt: candidateRecord.createdAt,
    resolution: null,
  };
}

export function assertCatalogConflictReviewFilter(
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

export function catalogConflictReviewRowMatches(
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

export function conflictSeverity(
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

export function conflictReasonCode(
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

export function candidateSeverity(
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

export function candidateReasonCode(
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

export function candidateReasonDetail(
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

export function conflictResolutionFromMetadata(
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

export function conflictReviewProvenanceFromRecord(
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

export function publicRawContentRedactionClass(
  redactionClass: CatalogRawContentRedactionClass,
): CatalogRawContentRedactionClass {
  return redactionClass === catalogRawContentRedactionClassValues.privateCorpus
    ? catalogRawContentRedactionClassValues.redacted
    : redactionClass;
}

export function exactLinkRefFromExternalIdRow(
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
