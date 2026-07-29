import type {
  CatalogConflictEvidenceInput,
  CatalogJsonRecord,
} from "../repositories/catalog-repository.js";
import {
  catalogConflictSubjectKindValues,
  catalogExternalIdKindValues,
  catalogLanguageStatusScopeValues,
  catalogLanguageStatusValues,
} from "../schema.js";

import {
  type CatalogPlatformLanguageConflictCompatibilityBasis,
  catalogPlatformLanguageConflictCompatibilityBasisValues,
  type CatalogPlatformLanguageConflictDiagnostic,
  type CatalogPlatformLanguageConflictDiagnosticCode,
  catalogPlatformLanguageConflictDiagnosticCodeValues,
  type CatalogPlatformLanguageConflictEvidence,
  type CatalogPlatformLanguageConflictFact,
  type CatalogPlatformLanguageConflictResult,
  catalogPlatformLanguageConflictSchemaVersion,
  type CatalogPlatformLanguageConflictStatus,
  catalogSources,
  externalIdKinds,
  languageStatuses,
  languageStatusScopes,
} from "./catalog-platform-language-conflict-types.js";
import { compactJson, nonEmptyString } from "./catalog-platform-language-conflict-helpers.js";

export function conflictEvidenceFromLanguageEvidence(
  evidence: CatalogPlatformLanguageConflictEvidence,
  evidencePosition: number,
): CatalogConflictEvidenceInput {
  const subjectKind =
    evidence.languageStatusId === undefined
      ? catalogConflictSubjectKindValues.sourceProvenance
      : catalogConflictSubjectKindValues.languageStatus;
  const subjectId =
    evidence.languageStatusId ??
    evidence.sourceProvenanceId ??
    `${evidence.catalogSource}:${evidence.sourceId}`;
  return compactJson({
    subjectKind,
    subjectId,
    sourceProvenanceId: evidence.sourceProvenanceId,
    evidencePosition,
    metadata: evidenceMetadata(evidence),
  }) as CatalogConflictEvidenceInput;
}

export function normalizeEvidence(
  evidence: CatalogPlatformLanguageConflictEvidence,
  label: string,
  diagnostics: CatalogPlatformLanguageConflictDiagnostic[],
): CatalogPlatformLanguageConflictEvidence | null {
  if (evidence === null || typeof evidence !== "object" || Array.isArray(evidence)) {
    diagnostics.push(invalidDiagnostic(`${label} must be a JSON object.`));
    return null;
  }
  if (!catalogSources.includes(evidence.catalogSource)) {
    diagnostics.push(invalidDiagnostic(`${label}.catalogSource is unsupported.`));
    return null;
  }
  if (!nonEmptyString(evidence.sourceId)) {
    diagnostics.push(invalidDiagnostic(`${label}.sourceId must be a non-empty string.`));
    return null;
  }
  if (!nonEmptyString(evidence.language)) {
    diagnostics.push(invalidDiagnostic(`${label}.language must be a non-empty string.`));
    return null;
  }
  if (!languageStatuses.includes(evidence.status)) {
    diagnostics.push(invalidDiagnostic(`${label}.status is unsupported.`));
    return null;
  }
  if (evidence.statusScope !== undefined && !languageStatusScopes.includes(evidence.statusScope)) {
    diagnostics.push(invalidDiagnostic(`${label}.statusScope is unsupported.`));
    return null;
  }
  if (evidence.externalIdKind !== undefined && !externalIdKinds.includes(evidence.externalIdKind)) {
    diagnostics.push(invalidDiagnostic(`${label}.externalIdKind is unsupported.`));
    return null;
  }
  return {
    ...evidence,
    externalIdKind: evidence.externalIdKind ?? catalogExternalIdKindValues.sourceRecord,
    statusScope: evidence.statusScope ?? catalogLanguageStatusScopeValues.platform,
  };
}

export function isOfficialPositiveEvidence(
  evidence: CatalogPlatformLanguageConflictEvidence,
  targetLanguage: string,
): boolean {
  return (
    evidence.language === targetLanguage &&
    evidence.status === catalogLanguageStatusValues.officialFull
  );
}

/**
 * Decide whether a candidate gap can be demoted by the official target-language
 * evidence, and on what basis. Official platform-A evidence must not demote a gap that
 * is only known on platform B: cross-platform gaps stay review-only unless they are
 * work-scoped, share the official platform, or explicitly declare cross-platform
 * comparability.
 */
export function candidateCompatibilityBasis(
  official: CatalogPlatformLanguageConflictEvidence,
  candidate: CatalogPlatformLanguageConflictEvidence,
): CatalogPlatformLanguageConflictCompatibilityBasis {
  // A work-scoped gap spans every platform of the work, so it is always comparable.
  if (candidate.statusScope === catalogLanguageStatusScopeValues.work) {
    return catalogPlatformLanguageConflictCompatibilityBasisValues.workScoped;
  }
  const officialPlatform = normalizePlatform(official.platform);
  // Official evidence that names no platform is platform-agnostic and comparable.
  if (officialPlatform === null) {
    return catalogPlatformLanguageConflictCompatibilityBasisValues.officialPlatformAgnostic;
  }
  const candidatePlatform = normalizePlatform(candidate.platform);
  // A release/platform-scoped gap that names no platform cannot be proven incompatible.
  if (candidatePlatform === null) {
    return catalogPlatformLanguageConflictCompatibilityBasisValues.candidatePlatformUnspecified;
  }
  if (candidatePlatform === officialPlatform) {
    return catalogPlatformLanguageConflictCompatibilityBasisValues.samePlatform;
  }
  // Different platforms only demote when the gap explicitly declares comparability.
  if (candidate.crossPlatformComparable === true) {
    return catalogPlatformLanguageConflictCompatibilityBasisValues.crossPlatformDeclared;
  }
  return catalogPlatformLanguageConflictCompatibilityBasisValues.incompatiblePlatform;
}

export function normalizePlatform(platform: string | null | undefined): string | null {
  if (typeof platform !== "string") {
    return null;
  }
  const trimmed = platform.trim().toLowerCase();
  return trimmed.length === 0 ? null : trimmed;
}

export function invalidDiagnostic(message: string): CatalogPlatformLanguageConflictDiagnostic {
  return diagnostic(
    catalogPlatformLanguageConflictDiagnosticCodeValues.invalidRequest,
    "error",
    message,
  );
}

export function diagnostic(
  code: CatalogPlatformLanguageConflictDiagnosticCode,
  severity: CatalogPlatformLanguageConflictDiagnostic["severity"],
  message: string,
  metadata?: CatalogJsonRecord,
): CatalogPlatformLanguageConflictDiagnostic {
  return {
    code,
    severity,
    message,
    ...(metadata === undefined ? {} : { metadata }),
  };
}

export function result(
  status: CatalogPlatformLanguageConflictStatus,
  targetLanguage: string,
  conflicts: CatalogPlatformLanguageConflictFact[],
  diagnostics: CatalogPlatformLanguageConflictDiagnostic[],
): CatalogPlatformLanguageConflictResult {
  return {
    schemaVersion: catalogPlatformLanguageConflictSchemaVersion,
    status,
    targetLanguage,
    conflicts,
    diagnostics,
  };
}

export function evidenceMetadata(
  evidence: CatalogPlatformLanguageConflictEvidence,
): CatalogJsonRecord {
  return compactJson({
    catalogSource: evidence.catalogSource,
    sourceId: evidence.sourceId,
    externalIdKind: evidence.externalIdKind ?? catalogExternalIdKindValues.sourceRecord,
    language: evidence.language,
    status: evidence.status,
    statusScope: evidence.statusScope ?? catalogLanguageStatusScopeValues.platform,
    platform: evidence.platform ?? null,
    crossPlatformComparable: evidence.crossPlatformComparable === true ? true : undefined,
    sourceProvenanceId: evidence.sourceProvenanceId,
    languageStatusId: evidence.languageStatusId,
    evidenceRef: evidence.evidenceRef,
    metadata: evidence.metadata,
  });
}

export function sourceMetadata(
  evidence: CatalogPlatformLanguageConflictEvidence,
): CatalogJsonRecord {
  return compactJson({
    catalogSource: evidence.catalogSource,
    sourceId: evidence.sourceId,
    externalIdKind: evidence.externalIdKind ?? catalogExternalIdKindValues.sourceRecord,
    language: evidence.language,
    status: evidence.status,
    statusScope: evidence.statusScope ?? catalogLanguageStatusScopeValues.platform,
    platform: evidence.platform ?? null,
    sourceProvenanceId: evidence.sourceProvenanceId,
  });
}
