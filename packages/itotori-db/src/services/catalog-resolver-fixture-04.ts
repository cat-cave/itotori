import type { CatalogConflictReviewReadModel } from "../repositories/catalog-repository.js";
import {
  catalogExactExternalIdLinkSchemaVersion,
  catalogExactExternalIdLinkStatusValues,
  type CatalogExactExternalIdLinkDiagnostic,
  type CatalogExactExternalIdLinkResult,
} from "./catalog-exact-external-id-linker.js";
import {
  catalogFuzzyCandidateGeneratorVersion,
  catalogFuzzyCandidateSchemaVersion,
  catalogFuzzyCandidateStatusValues,
  type CatalogFuzzyCandidateDiagnostic,
  type CatalogFuzzyCandidateResult,
} from "./catalog-fuzzy-candidate-generator.js";

import {
  type CatalogResolverFixtureExactLinkArtifactRecord,
  type CatalogResolverFixtureFuzzyCandidateArtifactRecord,
} from "./catalog-resolver-fixture-01.js";
import { stringValue } from "./catalog-resolver-fixture-03.js";
import {
  arraysEqual,
  hasDateLikeValue,
  isEnumValue,
  isRecord,
} from "./catalog-resolver-fixture-05.js";

export function isArtifactExactLinkRecord(
  value: unknown,
): value is CatalogResolverFixtureExactLinkArtifactRecord {
  return (
    isRecord(value) &&
    stringValue(value.exactLinkId) !== null &&
    isEnumValue(value.status, catalogExactExternalIdLinkStatusValues) &&
    "workId" in value &&
    isNullableString(value.workId) &&
    Array.isArray(value.matchIds) &&
    value.matchIds.every((entry) => stringValue(entry) !== null) &&
    Array.isArray(value.matches) &&
    value.matches.every(isExactLinkMatch) &&
    Array.isArray(value.diagnostics) &&
    value.diagnostics.every(isBasicDiagnostic)
  );
}

export function isArtifactFuzzyCandidates(value: unknown): boolean {
  return (
    isRecord(value) &&
    isEnumValue(value.status, catalogFuzzyCandidateStatusValues) &&
    value.generatorVersion === catalogFuzzyCandidateGeneratorVersion &&
    Array.isArray(value.candidateIds) &&
    value.candidateIds.every((entry) => stringValue(entry) !== null) &&
    Array.isArray(value.candidates) &&
    value.candidates.every(isFuzzyCandidateRecord) &&
    arraysEqual(
      value.candidateIds,
      value.candidates.map((candidate) => candidate.candidateId),
    ) &&
    Array.isArray(value.diagnostics) &&
    value.diagnostics.every(isBasicDiagnostic)
  );
}

export function isArtifactConflicts(value: unknown): boolean {
  return (
    isRecord(value) &&
    Array.isArray(value.conflictIds) &&
    value.conflictIds.every((entry) => stringValue(entry) !== null) &&
    Array.isArray(value.rows) &&
    value.rows.every(isConflictReviewRow) &&
    arraysEqual(
      value.conflictIds,
      value.rows.map((row) => row.reviewId),
    )
  );
}

export function isExactLinkSubject(value: unknown): boolean {
  if (value === null) {
    return true;
  }
  return isRecord(value) && stringValue(value.kind) !== null && stringValue(value.id) !== null;
}

export function isExactLinkMatch(value: unknown): boolean {
  return (
    isRecord(value) &&
    isFiniteNumber(value.inputIndex) &&
    stringValue(value.catalogSource) !== null &&
    stringValue(value.sourceId) !== null &&
    stringValue(value.externalIdKind) !== null &&
    stringValue(value.workId) !== null &&
    stringValue(value.canonicalTitle) !== null
  );
}

export function isFuzzyCandidateRecord(
  value: unknown,
): value is CatalogResolverFixtureFuzzyCandidateArtifactRecord {
  return (
    isRecord(value) &&
    stringValue(value.candidateId) !== null &&
    stringValue(value.sourceCatalogSource) !== null &&
    stringValue(value.sourceId) !== null &&
    stringValue(value.sourceTitle) !== null &&
    isNullableString(value.sourceProvenanceId) &&
    stringValue(value.targetWorkId) !== null &&
    isFiniteNumber(value.score) &&
    isRecord(value.matchedFields) &&
    stringValue(value.status) !== null &&
    stringValue(value.diagnosticCode) !== null &&
    stringValue(value.generatorVersion) !== null &&
    isRecord(value.metadata) &&
    hasDateLikeValue(value.createdAt) &&
    hasDateLikeValue(value.updatedAt)
  );
}

export function isConflictReviewRow(
  value: unknown,
): value is CatalogConflictReviewReadModel["rows"][number] {
  return (
    isRecord(value) &&
    stringValue(value.reviewId) !== null &&
    stringValue(value.catalogRecordId) !== null &&
    isNullableString(value.conflictId) &&
    isStringArray(value.candidateIds) &&
    isStringArray(value.candidateCatalogIds) &&
    Array.isArray(value.exactLinkRefs) &&
    value.exactLinkRefs.every(isExactLinkRef) &&
    Array.isArray(value.fuzzyScores) &&
    value.fuzzyScores.every(isFuzzyScore) &&
    Array.isArray(value.sourceIds) &&
    value.sourceIds.every(isSourceId) &&
    Array.isArray(value.provenance) &&
    value.provenance.every(isProvenance) &&
    ["error", "warning", "info"].includes(String(value.severity)) &&
    stringValue(value.status) !== null &&
    stringValue(value.reasonCode) !== null &&
    stringValue(value.reasonDetail) !== null &&
    isNullableString(value.conflictKind) &&
    hasDateLikeValue(value.detectedAt) &&
    (value.resolution === null || isRecord(value.resolution))
  );
}

export function isExactLinkRef(value: unknown): boolean {
  return (
    isRecord(value) &&
    stringValue(value.externalIdId) !== null &&
    stringValue(value.externalIdKind) !== null &&
    stringValue(value.workId) !== null &&
    stringValue(value.catalogSource) !== null &&
    stringValue(value.sourceId) !== null &&
    isNullableString(value.sourceProvenanceId)
  );
}

export function isFuzzyScore(value: unknown): boolean {
  return (
    isRecord(value) &&
    stringValue(value.candidateId) !== null &&
    isFiniteNumber(value.score) &&
    stringValue(value.diagnosticCode) !== null &&
    stringValue(value.generatorVersion) !== null
  );
}

export function isSourceId(value: unknown): boolean {
  return (
    isRecord(value) &&
    stringValue(value.catalogSource) !== null &&
    stringValue(value.sourceId) !== null
  );
}

export function isProvenance(value: unknown): boolean {
  return (
    isRecord(value) &&
    stringValue(value.sourceProvenanceId) !== null &&
    stringValue(value.catalogSource) !== null &&
    stringValue(value.sourceId) !== null &&
    stringValue(value.sourceRecordKind) !== null &&
    isNullableString(value.payloadHash) &&
    hasDateLikeValue(value.fetchedAt)
  );
}

export function isBasicDiagnostic(value: unknown): boolean {
  return (
    isRecord(value) &&
    stringValue(value.code) !== null &&
    ["info", "warning", "error"].includes(String(value.severity)) &&
    stringValue(value.message) !== null
  );
}

export function isNullableString(value: unknown): boolean {
  return value === null || stringValue(value) !== null;
}

export function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => stringValue(entry) !== null);
}

export function isFiniteNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}
