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
  noCandidateGap: "catalog.platform_language_conflict.no_candidate_gap",
} as const;

export type CatalogPlatformLanguageConflictDiagnosticCode =
  (typeof catalogPlatformLanguageConflictDiagnosticCodeValues)[keyof typeof catalogPlatformLanguageConflictDiagnosticCodeValues];

export type CatalogPlatformLanguageConflictEvidence = {
  catalogSource: CatalogSource;
  sourceId: string;
  externalIdKind?: CatalogExternalIdKind;
  language: string;
  status: CatalogLanguageStatus;
  statusScope?: CatalogLanguageStatusScope;
  platform?: string | null;
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
        .filter((candidate): candidate is CatalogPlatformLanguageConflictEvidence =>
          candidate !== null,
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

  const conflictCandidates: CatalogPlatformLanguageConflictEvidence[] = [];
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
    if (conflictGapStatuses.has(candidate.status)) {
      conflictCandidates.push(candidate);
    }
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
      hasUnknownEvidence
        ? catalogPlatformLanguageConflictStatusValues.unknown
        : catalogPlatformLanguageConflictStatusValues.noConflict,
      targetLanguage,
      [],
      [...diagnostics],
    );
  }

  const metadata = compactJson({
    reasonCode: catalogPlatformLanguageConflictReasonCode,
    severity: "warning",
    targetLanguage,
    sourceField: request.sourceField,
    fixtureId: request.fixtureId,
    officialEvidence: evidenceMetadata(official),
    candidateGaps: conflictCandidates.map(evidenceMetadata),
    platformScope: official.platform ?? official.statusScope ?? null,
    sources: [official, ...conflictCandidates].map(sourceMetadata),
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
      `${conflictCandidates.map(sourceLabel).join(", ")} candidate evidence does not.`;

  const conflict: CatalogPlatformLanguageConflictFact = {
    conflictKind: catalogConflictKindValues.languageStatus,
    status: catalogConflictStatusValues.open,
    summary,
    reasonCode: catalogPlatformLanguageConflictReasonCode,
    severity: "warning",
    metadata,
    evidence: [official, ...conflictCandidates].map((entry, index) =>
      conflictEvidenceFromLanguageEvidence(entry, index),
    ),
  };
  if (request.detectedAt !== undefined) {
    conflict.detectedAt = request.detectedAt;
  }

  return result(catalogPlatformLanguageConflictStatusValues.conflict, targetLanguage, [conflict], [
    ...diagnostics,
  ]);
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
    evidence.languageStatusId ?? evidence.sourceProvenanceId ?? `${evidence.catalogSource}:${evidence.sourceId}`;
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
  if (
    evidence.statusScope !== undefined &&
    !languageStatusScopes.includes(evidence.statusScope)
  ) {
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
