import type {
  CatalogConflictEvidenceInput,
  CatalogJsonRecord,
} from "../repositories/catalog-repository.js";
import {
  catalogConflictKindValues,
  catalogConflictSubjectKindValues,
  catalogConflictStatusValues,
  catalogExternalIdKindValues,
  catalogLanguageStatusScopeValues,
  catalogLanguageStatusValues,
  catalogSourceValues,
  type CatalogConflictKind,
  type CatalogConflictStatus,
  type CatalogExternalIdKind,
  type CatalogLanguageStatus,
  type CatalogLanguageStatusScope,
  type CatalogSource,
} from "../schema.js";

export const catalogPlatformLanguageConflictSchemaVersion =
  "catalog.platform_language_conflict.v0.1" as const;

export const catalogPlatformLanguageConflictReasonCode =
  "official_english_platform_disagreement" as const;

/**
 * How a platform-language conflict's candidate payload was produced.
 *
 * - `fixture_authored`: the candidate evidence was hand-authored by a fixture (the
 *   caller passed an explicit `candidateEvidence` array).
 * - `repository_derived`: the candidate evidence was derived by reading the current
 *   VNDB / EGS / DLsite / local candidate rows out of the catalog repository.
 *
 * The origin is stamped into the conflict metadata so downstream demotion
 * explanations can distinguish a hand-authored conflict from one generated against
 * live repository evidence.
 */
export const catalogPlatformLanguageConflictOriginValues = {
  fixtureAuthored: "fixture_authored",
  repositoryDerived: "repository_derived",
} as const;

export type CatalogPlatformLanguageConflictOrigin =
  (typeof catalogPlatformLanguageConflictOriginValues)[keyof typeof catalogPlatformLanguageConflictOriginValues];

export const catalogPlatformLanguageConflictStatusValues = {
  conflict: "conflict",
  noConflict: "no_conflict",
  unknown: "unknown",
  invalid: "invalid",
} as const;

export type CatalogPlatformLanguageConflictStatus =
  (typeof catalogPlatformLanguageConflictStatusValues)[keyof typeof catalogPlatformLanguageConflictStatusValues];

export const catalogPlatformLanguageConflictDiagnosticCodeValues = {
  invalidRequest: "catalog.platform_language_conflict.invalid_request",
  officialEvidenceNotPositive: "catalog.platform_language_conflict.official_evidence_not_positive",
  candidateAlreadyOfficial: "catalog.platform_language_conflict.candidate_already_official",
  candidateEvidenceUnknown: "catalog.platform_language_conflict.candidate_evidence_unknown",
  candidatePlatformIncompatible:
    "catalog.platform_language_conflict.candidate_platform_incompatible",
  noCandidateGap: "catalog.platform_language_conflict.no_candidate_gap",
} as const;

export type CatalogPlatformLanguageConflictDiagnosticCode =
  (typeof catalogPlatformLanguageConflictDiagnosticCodeValues)[keyof typeof catalogPlatformLanguageConflictDiagnosticCodeValues];

/**
 * Basis on which a candidate gap is judged comparable (or not) with the official
 * target-language evidence. Only the demoting bases end up in a conflict fact; an
 * `incompatible_platform` candidate is review-only and never benchmark-demotes.
 */
export const catalogPlatformLanguageConflictCompatibilityBasisValues = {
  /** Candidate names the same platform as the official evidence. */
  samePlatform: "same_platform",
  /** Candidate is work-scoped, so its claim spans every platform of the work. */
  workScoped: "work_scoped",
  /** Official evidence names no specific platform, so it is platform-agnostic. */
  officialPlatformAgnostic: "official_platform_agnostic",
  /** Candidate is release/platform-scoped but names no platform to compare against. */
  candidatePlatformUnspecified: "candidate_platform_unspecified",
  /** Candidate explicitly declares its gap comparable across platforms. */
  crossPlatformDeclared: "cross_platform_declared",
  /** Candidate names a different, incompatible platform (review-only, never demotes). */
  incompatiblePlatform: "incompatible_platform",
} as const;

export type CatalogPlatformLanguageConflictCompatibilityBasis =
  (typeof catalogPlatformLanguageConflictCompatibilityBasisValues)[keyof typeof catalogPlatformLanguageConflictCompatibilityBasisValues];

export type CatalogPlatformLanguageConflictEvidence = {
  catalogSource: CatalogSource;
  sourceId: string;
  externalIdKind?: CatalogExternalIdKind;
  language: string;
  status: CatalogLanguageStatus;
  statusScope?: CatalogLanguageStatusScope;
  platform?: string | null;
  /**
   * When true, an otherwise cross-platform candidate gap is explicitly declared
   * comparable with the official evidence (e.g. a work whose script is shared across
   * platforms). Cross-platform declarations must be explicit; the default is false.
   */
  crossPlatformComparable?: boolean;
  sourceProvenanceId?: string;
  languageStatusId?: string;
  evidenceRef?: string;
  metadata?: CatalogJsonRecord;
};

export type CatalogPlatformLanguageConflictRequest = {
  schemaVersion?: typeof catalogPlatformLanguageConflictSchemaVersion;
  targetLanguage?: string;
  officialEvidence: CatalogPlatformLanguageConflictEvidence;
  candidateEvidence: CatalogPlatformLanguageConflictEvidence[];
  summary?: string;
  sourceField?: string;
  fixtureId?: string;
  detectedAt?: string;
  /**
   * How the candidate evidence was produced. Defaults to `fixture_authored`; the
   * repository-derived augmentation service sets this to `repository_derived`.
   */
  conflictOrigin?: CatalogPlatformLanguageConflictOrigin;
};

export type CatalogPlatformLanguageConflictFact = {
  conflictKind: CatalogConflictKind;
  status: CatalogConflictStatus;
  summary: string;
  reasonCode: typeof catalogPlatformLanguageConflictReasonCode;
  severity: "warning";
  detectedAt?: string;
  metadata: CatalogJsonRecord;
  evidence: CatalogConflictEvidenceInput[];
};

export type CatalogPlatformLanguageConflictDiagnostic = {
  code: CatalogPlatformLanguageConflictDiagnosticCode;
  severity: "info" | "warning" | "error";
  message: string;
  metadata?: CatalogJsonRecord;
};

export type CatalogPlatformLanguageConflictResult = {
  schemaVersion: typeof catalogPlatformLanguageConflictSchemaVersion;
  status: CatalogPlatformLanguageConflictStatus;
  targetLanguage: string;
  conflicts: CatalogPlatformLanguageConflictFact[];
  diagnostics: CatalogPlatformLanguageConflictDiagnostic[];
};

const catalogSources = Object.values(catalogSourceValues) as CatalogSource[];
const languageStatuses = Object.values(catalogLanguageStatusValues) as CatalogLanguageStatus[];
const languageStatusScopes = Object.values(
  catalogLanguageStatusScopeValues,
) as CatalogLanguageStatusScope[];
const externalIdKinds = Object.values(catalogExternalIdKindValues) as CatalogExternalIdKind[];

const conflictGapStatuses = new Set<CatalogLanguageStatus>([
  catalogLanguageStatusValues.none,
  catalogLanguageStatusValues.mtl,
  catalogLanguageStatusValues.fanPartial,
  catalogLanguageStatusValues.interfaceOnly,
  catalogLanguageStatusValues.unverifiedConsole,
]);

type CatalogPlatformLanguageConflictConflictCandidate = {
  evidence: CatalogPlatformLanguageConflictEvidence;
  compatibilityBasis: CatalogPlatformLanguageConflictCompatibilityBasis;
};

export function augmentCatalogPlatformLanguageConflicts(
  request: CatalogPlatformLanguageConflictRequest,
): CatalogPlatformLanguageConflictResult {
  const targetLanguage = request.targetLanguage ?? "en-US";
  const diagnostics: CatalogPlatformLanguageConflictDiagnostic[] = [];
  const official = normalizeEvidence(request.officialEvidence, "officialEvidence", diagnostics);
  const candidates = Array.isArray(request.candidateEvidence)
    ? request.candidateEvidence
        .map((candidate, index) =>
          normalizeEvidence(candidate, `candidateEvidence[${index}]`, diagnostics),
        )
        .filter(
          (candidate): candidate is CatalogPlatformLanguageConflictEvidence => candidate !== null,
        )
    : [];

  if (
    request.schemaVersion !== undefined &&
    request.schemaVersion !== catalogPlatformLanguageConflictSchemaVersion
  ) {
    diagnostics.push(
      diagnostic(
        catalogPlatformLanguageConflictDiagnosticCodeValues.invalidRequest,
        "error",
        `Unsupported platform-language conflict schemaVersion ${request.schemaVersion}.`,
      ),
    );
  }

  if (official === null) {
    return result(
      catalogPlatformLanguageConflictStatusValues.invalid,
      targetLanguage,
      [],
      diagnostics,
    );
  }

  if (!isOfficialPositiveEvidence(official, targetLanguage)) {
    diagnostics.push(
      diagnostic(
        catalogPlatformLanguageConflictDiagnosticCodeValues.officialEvidenceNotPositive,
        "info",
        "Official evidence does not assert full official support for the target language.",
        { officialEvidence: evidenceMetadata(official) },
      ),
    );
    return result(
      diagnostics.some((entry) => entry.severity === "error")
        ? catalogPlatformLanguageConflictStatusValues.invalid
        : catalogPlatformLanguageConflictStatusValues.noConflict,
      targetLanguage,
      [],
      diagnostics,
    );
  }

  const conflictCandidates: CatalogPlatformLanguageConflictConflictCandidate[] = [];
  const incompatibleCandidates: CatalogPlatformLanguageConflictEvidence[] = [];
  for (const candidate of candidates) {
    if (candidate.language !== targetLanguage) {
      continue;
    }
    if (candidate.status === catalogLanguageStatusValues.unknown) {
      diagnostics.push(
        diagnostic(
          catalogPlatformLanguageConflictDiagnosticCodeValues.candidateEvidenceUnknown,
          "info",
          "Candidate evidence is unknown, so it remains unknown instead of negative.",
          { candidateEvidence: evidenceMetadata(candidate) },
        ),
      );
      continue;
    }
    if (candidate.status === catalogLanguageStatusValues.officialFull) {
      diagnostics.push(
        diagnostic(
          catalogPlatformLanguageConflictDiagnosticCodeValues.candidateAlreadyOfficial,
          "info",
          "Candidate already has official full target-language evidence.",
          { candidateEvidence: evidenceMetadata(candidate) },
        ),
      );
      continue;
    }
    if (!conflictGapStatuses.has(candidate.status)) {
      continue;
    }
    const compatibilityBasis = candidateCompatibilityBasis(official, candidate);
    if (
      compatibilityBasis ===
      catalogPlatformLanguageConflictCompatibilityBasisValues.incompatiblePlatform
    ) {
      incompatibleCandidates.push(candidate);
      diagnostics.push(
        diagnostic(
          catalogPlatformLanguageConflictDiagnosticCodeValues.candidatePlatformIncompatible,
          "info",
          "Candidate gap evidence is on an incompatible platform, so it stays review-only" +
            " instead of demoting the benchmark candidate.",
          {
            candidateEvidence: evidenceMetadata(candidate),
            officialPlatform: official.platform ?? null,
            candidatePlatform: candidate.platform ?? null,
          },
        ),
      );
      continue;
    }
    conflictCandidates.push({ evidence: candidate, compatibilityBasis });
  }

  if (conflictCandidates.length === 0) {
    const hasUnknownEvidence = diagnostics.some(
      (entry) =>
        entry.code === catalogPlatformLanguageConflictDiagnosticCodeValues.candidateEvidenceUnknown,
    );
    diagnostics.push(
      diagnostic(
        catalogPlatformLanguageConflictDiagnosticCodeValues.noCandidateGap,
        "info",
        "No candidate gap evidence conflicts with official target-language support.",
      ),
    );
    return result(
      hasUnknownEvidence || incompatibleCandidates.length > 0
        ? catalogPlatformLanguageConflictStatusValues.unknown
        : catalogPlatformLanguageConflictStatusValues.noConflict,
      targetLanguage,
      [],
      [...diagnostics],
    );
  }

  const conflictOrigin =
    request.conflictOrigin ?? catalogPlatformLanguageConflictOriginValues.fixtureAuthored;
  const conflictEvidence = conflictCandidates.map((candidate) => candidate.evidence);
  const metadata = compactJson({
    reasonCode: catalogPlatformLanguageConflictReasonCode,
    conflictOrigin,
    severity: "warning",
    targetLanguage,
    sourceField: request.sourceField,
    fixtureId: request.fixtureId,
    officialEvidence: evidenceMetadata(official),
    candidateGaps: conflictCandidates.map((candidate) => ({
      ...evidenceMetadata(candidate.evidence),
      compatibilityBasis: candidate.compatibilityBasis,
    })),
    platformScope: official.platform ?? official.statusScope ?? null,
    sources: [official, ...conflictEvidence].map(sourceMetadata),
    reviewOnlyGaps: incompatibleCandidates.map((candidate) => ({
      ...evidenceMetadata(candidate),
      compatibilityBasis:
        catalogPlatformLanguageConflictCompatibilityBasisValues.incompatiblePlatform,
    })),
    unknownEvidence: candidates
      .filter(
        (candidate) =>
          candidate.language === targetLanguage &&
          candidate.status === catalogLanguageStatusValues.unknown,
      )
      .map(evidenceMetadata),
  });

  const summary =
    request.summary ??
    `${sourceLabel(official)} reports official ${targetLanguage} support` +
      ` on ${official.platform ?? official.statusScope ?? "platform scope"}, while ` +
      `${conflictEvidence.map(sourceLabel).join(", ")} candidate evidence does not.`;

  const conflict: CatalogPlatformLanguageConflictFact = {
    conflictKind: catalogConflictKindValues.languageStatus,
    status: catalogConflictStatusValues.open,
    summary,
    reasonCode: catalogPlatformLanguageConflictReasonCode,
    severity: "warning",
    metadata,
    evidence: [official, ...conflictEvidence].map((entry, index) =>
      conflictEvidenceFromLanguageEvidence(entry, index),
    ),
  };
  if (request.detectedAt !== undefined) {
    conflict.detectedAt = request.detectedAt;
  }

  return result(
    catalogPlatformLanguageConflictStatusValues.conflict,
    targetLanguage,
    [conflict],
    [...diagnostics],
  );
}

function conflictEvidenceFromLanguageEvidence(
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

function normalizeEvidence(
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

function isOfficialPositiveEvidence(
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
function candidateCompatibilityBasis(
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

function normalizePlatform(platform: string | null | undefined): string | null {
  if (typeof platform !== "string") {
    return null;
  }
  const trimmed = platform.trim().toLowerCase();
  return trimmed.length === 0 ? null : trimmed;
}

function invalidDiagnostic(message: string): CatalogPlatformLanguageConflictDiagnostic {
  return diagnostic(
    catalogPlatformLanguageConflictDiagnosticCodeValues.invalidRequest,
    "error",
    message,
  );
}

function diagnostic(
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

function result(
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

function evidenceMetadata(evidence: CatalogPlatformLanguageConflictEvidence): CatalogJsonRecord {
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

function sourceMetadata(evidence: CatalogPlatformLanguageConflictEvidence): CatalogJsonRecord {
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

function sourceLabel(evidence: CatalogPlatformLanguageConflictEvidence): string {
  return `${evidence.catalogSource} ${evidence.sourceId}`;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function compactJson<T extends CatalogJsonRecord>(record: T): T {
  const compacted: CatalogJsonRecord = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) {
      compacted[key] = value;
    }
  }
  return compacted as T;
}
