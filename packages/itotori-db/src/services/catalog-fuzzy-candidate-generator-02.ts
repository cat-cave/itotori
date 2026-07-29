import type { AuthorizationActor } from "../authorization.js";
import type {
  CatalogCandidateMatchRecord,
  CatalogCandidateTargetWorkRecord,
  ItotoriCatalogRepositoryPort,
} from "../repositories/catalog-repository.js";
import {
  catalogCandidateMatchStatusValues,
  catalogExternalIdKindValues,
  catalogSourceValues,
  type CatalogExternalIdKind,
  type CatalogSource,
} from "../schema.js";

import {
  type CatalogFuzzyCandidateDiagnostic,
  catalogFuzzyCandidateDiagnosticCodeValues,
  type CatalogFuzzyCandidateExternalId,
  catalogFuzzyCandidateGeneratorVersion,
  catalogFuzzyCandidateSchemaVersion,
  type CatalogFuzzyCandidateSourceFact,
  type NormalizedRequest,
} from "./catalog-fuzzy-candidate-generator-01.js";
import {
  diagnostic,
  isCatalogSource,
  isRecord,
  normalizeExternalId,
} from "./catalog-fuzzy-candidate-generator-03.js";

export function normalizeRequest(request: unknown): NormalizedRequest {
  const diagnostics: CatalogFuzzyCandidateDiagnostic[] = [];
  if (!isRecord(request)) {
    diagnostics.push(
      diagnostic(
        catalogFuzzyCandidateDiagnosticCodeValues.invalidRequest,
        "error",
        "Fuzzy candidate request must be a JSON object.",
        "invalid_request_shape",
      ),
    );
    return {
      sourceFacts: [],
      minScore: 650,
      maxCandidatesPerSource: 3,
      generatorVersion: catalogFuzzyCandidateGeneratorVersion,
      diagnostics,
    };
  }

  if (
    request.schemaVersion !== undefined &&
    request.schemaVersion !== catalogFuzzyCandidateSchemaVersion
  ) {
    diagnostics.push(
      diagnostic(
        catalogFuzzyCandidateDiagnosticCodeValues.invalidRequest,
        "error",
        `Unsupported fuzzy candidate request schemaVersion ${request.schemaVersion}.`,
        "unsupported_schema_version",
      ),
    );
  }
  if (
    request.generatorVersion !== undefined &&
    request.generatorVersion !== catalogFuzzyCandidateGeneratorVersion
  ) {
    diagnostics.push(
      diagnostic(
        catalogFuzzyCandidateDiagnosticCodeValues.invalidRequest,
        "error",
        `Unsupported fuzzy candidate generatorVersion ${request.generatorVersion}.`,
        "unsupported_generator_version",
      ),
    );
  }
  const generatorVersion = catalogFuzzyCandidateGeneratorVersion;
  const rawMinScore = request.minScore;
  const minScore = typeof rawMinScore === "number" ? rawMinScore : 650;
  if (
    rawMinScore !== undefined &&
    (typeof rawMinScore !== "number" ||
      !Number.isInteger(rawMinScore) ||
      rawMinScore < 0 ||
      rawMinScore > 1000)
  ) {
    diagnostics.push(
      diagnostic(
        catalogFuzzyCandidateDiagnosticCodeValues.invalidRequest,
        "error",
        "minScore must be an integer between 0 and 1000.",
        "invalid_min_score",
      ),
    );
  }
  const rawMaxCandidatesPerSource = request.maxCandidatesPerSource;
  const maxCandidatesPerSource =
    typeof rawMaxCandidatesPerSource === "number" ? rawMaxCandidatesPerSource : 3;
  if (
    rawMaxCandidatesPerSource !== undefined &&
    (typeof rawMaxCandidatesPerSource !== "number" ||
      !Number.isInteger(rawMaxCandidatesPerSource) ||
      rawMaxCandidatesPerSource < 1 ||
      rawMaxCandidatesPerSource > 10)
  ) {
    diagnostics.push(
      diagnostic(
        catalogFuzzyCandidateDiagnosticCodeValues.invalidRequest,
        "error",
        "maxCandidatesPerSource must be an integer between 1 and 10.",
        "invalid_max_candidates",
      ),
    );
  }
  if (!Array.isArray(request.sourceFacts) || request.sourceFacts.length === 0) {
    diagnostics.push(
      diagnostic(
        catalogFuzzyCandidateDiagnosticCodeValues.invalidRequest,
        "error",
        "Fuzzy candidate generation requires at least one source fact.",
        "missing_source_facts",
      ),
    );
  }

  return {
    sourceFacts: Array.isArray(request.sourceFacts)
      ? request.sourceFacts
          .map((sourceFact, index) => normalizeSourceFact(sourceFact, index, diagnostics))
          .filter((sourceFact): sourceFact is CatalogFuzzyCandidateSourceFact => {
            return sourceFact !== null;
          })
      : [],
    minScore,
    maxCandidatesPerSource,
    generatorVersion,
    diagnostics,
  };
}

export function normalizeSourceFact(
  sourceFact: unknown,
  index: number,
  diagnostics: CatalogFuzzyCandidateDiagnostic[],
): CatalogFuzzyCandidateSourceFact | null {
  const sourceId =
    isRecord(sourceFact) && typeof sourceFact.sourceId === "string"
      ? sourceFact.sourceId
      : undefined;
  if (!isRecord(sourceFact)) {
    diagnostics.push(
      diagnostic(
        catalogFuzzyCandidateDiagnosticCodeValues.invalidRequest,
        "error",
        `sourceFacts[${index}] must include catalogSource, sourceId, and title.`,
        "invalid_source_fact",
        sourceId === undefined ? { field: "sourceFacts" } : { sourceId, field: "sourceFacts" },
      ),
    );
    return null;
  }

  const catalogSource = sourceFact.catalogSource;
  if (
    !isCatalogSource(catalogSource) ||
    typeof sourceFact.sourceId !== "string" ||
    sourceFact.sourceId.trim().length === 0 ||
    typeof sourceFact.title !== "string" ||
    sourceFact.title.trim().length === 0
  ) {
    diagnostics.push(
      diagnostic(
        catalogFuzzyCandidateDiagnosticCodeValues.invalidRequest,
        "error",
        `sourceFacts[${index}] must include catalogSource, sourceId, and title.`,
        "invalid_source_fact",
        sourceId === undefined ? { field: "sourceFacts" } : { sourceId, field: "sourceFacts" },
      ),
    );
    return null;
  }
  const releaseYear = sourceFact.releaseYear;
  if (
    releaseYear !== undefined &&
    (typeof releaseYear !== "number" ||
      !Number.isInteger(releaseYear) ||
      releaseYear < 1970 ||
      releaseYear > 2200)
  ) {
    diagnostics.push(
      diagnostic(
        catalogFuzzyCandidateDiagnosticCodeValues.invalidRequest,
        "error",
        `sourceFacts[${index}].releaseYear must be an integer between 1970 and 2200.`,
        "invalid_release_year",
        { sourceId: sourceFact.sourceId, field: "releaseYear" },
      ),
    );
    return null;
  }

  let externalIds: CatalogFuzzyCandidateExternalId[] | undefined;
  if (sourceFact.externalIds !== undefined) {
    if (!Array.isArray(sourceFact.externalIds)) {
      diagnostics.push(
        diagnostic(
          catalogFuzzyCandidateDiagnosticCodeValues.invalidRequest,
          "error",
          `sourceFacts[${index}].externalIds must be an array when present.`,
          "invalid_external_ids_shape",
          { sourceId: sourceFact.sourceId, field: "externalIds" },
        ),
      );
      return null;
    }
    externalIds = [];
    for (const [externalIndex, externalId] of sourceFact.externalIds.entries()) {
      const normalized = normalizeExternalId(
        externalId,
        index,
        externalIndex,
        sourceFact.sourceId,
        diagnostics,
      );
      if (normalized === null) {
        return null;
      }
      externalIds.push(normalized);
    }
  }

  return {
    catalogSource,
    sourceId: sourceFact.sourceId,
    title: sourceFact.title,
    ...(releaseYear === undefined ? {} : { releaseYear }),
    ...(typeof sourceFact.sourceProvenanceId === "string" &&
    sourceFact.sourceProvenanceId.trim().length > 0
      ? { sourceProvenanceId: sourceFact.sourceProvenanceId }
      : {}),
    ...(externalIds === undefined ? {} : { externalIds }),
  };
}
