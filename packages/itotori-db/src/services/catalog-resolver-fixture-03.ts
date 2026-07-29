import type { CatalogConflictReviewReadModel } from "../repositories/catalog-repository.js";
import {
  catalogExactExternalIdLinkSchemaVersion,
  catalogExactExternalIdLinkStatusValues,
  type CatalogExactExternalIdLinkResult,
} from "./catalog-exact-external-id-linker.js";
import {
  catalogFuzzyCandidateGeneratorVersion,
  catalogFuzzyCandidateSchemaVersion,
  catalogFuzzyCandidateStatusValues,
  type CatalogFuzzyCandidateResult,
} from "./catalog-fuzzy-candidate-generator.js";

import {
  type CatalogResolverFixtureArtifact,
  type CatalogResolverFixtureDiagnostic,
  type CatalogResolverFixtureDiagnosticCode,
  catalogResolverFixtureDiagnosticCodeValues,
  catalogResolverFixtureSchemaVersion,
  type CatalogResolverFixtureStatus,
  catalogResolverFixtureStatusValues,
} from "./catalog-resolver-fixture-01.js";
import { catalogResolverFixtureReviewReadModel } from "./catalog-resolver-fixture-02.js";
import {
  isBasicDiagnostic,
  isConflictReviewRow,
  isExactLinkMatch,
  isExactLinkSubject,
  isFuzzyCandidateRecord,
  isNullableString,
} from "./catalog-resolver-fixture-04.js";
import { isEnumValue, isRecord } from "./catalog-resolver-fixture-05.js";

export function normalizeFuzzyCandidates(
  value: unknown,
  diagnostics: CatalogResolverFixtureDiagnostic[],
): CatalogFuzzyCandidateResult {
  if (!isRecord(value) || !Array.isArray(value.candidates) || !Array.isArray(value.diagnostics)) {
    diagnostics.push(
      diagnostic(
        catalogResolverFixtureDiagnosticCodeValues.invalidFuzzyCandidateResult,
        "error",
        "Catalog resolver fixture fuzzyCandidates must be a recorded fuzzy candidate result.",
        "$.fuzzyCandidates",
      ),
    );
    return {
      schemaVersion: catalogFuzzyCandidateSchemaVersion,
      generatorVersion: catalogFuzzyCandidateGeneratorVersion,
      status: "invalid",
      candidates: [],
      diagnostics: [],
    };
  }
  const invalidPaths: string[] = [];
  if (
    value.schemaVersion !== catalogFuzzyCandidateSchemaVersion ||
    value.generatorVersion !== catalogFuzzyCandidateGeneratorVersion ||
    !isEnumValue(value.status, catalogFuzzyCandidateStatusValues)
  ) {
    invalidPaths.push("$.fuzzyCandidates");
  }
  for (const [index, candidate] of value.candidates.entries()) {
    if (!isFuzzyCandidateRecord(candidate)) {
      invalidPaths.push(`$.fuzzyCandidates.candidates[${index}]`);
    }
  }
  for (const [index, entry] of value.diagnostics.entries()) {
    if (!isBasicDiagnostic(entry)) {
      invalidPaths.push(`$.fuzzyCandidates.diagnostics[${index}]`);
    }
  }
  if (invalidPaths.length > 0) {
    for (const path of invalidPaths) {
      diagnostics.push(
        diagnostic(
          catalogResolverFixtureDiagnosticCodeValues.invalidFuzzyCandidateResult,
          "error",
          "Catalog resolver fixture fuzzyCandidates includes malformed nested records.",
          path,
        ),
      );
    }
    return {
      schemaVersion: catalogFuzzyCandidateSchemaVersion,
      generatorVersion: catalogFuzzyCandidateGeneratorVersion,
      status: "invalid",
      candidates: [],
      diagnostics: [],
    };
  }
  return value as CatalogFuzzyCandidateResult;
}

export function normalizeConflictReview(
  value: unknown,
  diagnostics: CatalogResolverFixtureDiagnostic[],
): CatalogConflictReviewReadModel {
  if (!isRecord(value) || !Array.isArray(value.rows)) {
    diagnostics.push(
      diagnostic(
        catalogResolverFixtureDiagnosticCodeValues.invalidConflictReview,
        "error",
        "Catalog resolver fixture conflicts must be a recorded conflict review read model.",
        "$.conflicts",
      ),
    );
    return { rows: [] };
  }
  const invalidPaths: string[] = [];
  for (const [index, row] of value.rows.entries()) {
    if (!isConflictReviewRow(row)) {
      invalidPaths.push(`$.conflicts.rows[${index}]`);
    }
  }
  if (invalidPaths.length > 0) {
    for (const path of invalidPaths) {
      diagnostics.push(
        diagnostic(
          catalogResolverFixtureDiagnosticCodeValues.invalidConflictReview,
          "error",
          "Catalog resolver fixture conflicts includes malformed nested rows.",
          path,
        ),
      );
    }
    return { rows: [] };
  }
  return value as CatalogConflictReviewReadModel;
}

export function invalidArtifact(
  artifactId: string,
  generatedAt: string,
  diagnostics: CatalogResolverFixtureDiagnostic[],
): CatalogResolverFixtureArtifact {
  const artifact: Omit<CatalogResolverFixtureArtifact, "review"> = {
    schemaVersion: catalogResolverFixtureSchemaVersion,
    artifactId,
    generatedAt,
    status: catalogResolverFixtureStatusValues.invalid,
    sourceRegistry: [],
    provenanceHashes: [],
    exactLinks: [],
    fuzzyCandidates: {
      status: "invalid",
      generatorVersion: catalogFuzzyCandidateGeneratorVersion,
      candidateIds: [],
      candidates: [],
      diagnostics: [],
    },
    conflicts: { conflictIds: [], rows: [] },
    diagnostics,
  };
  return { ...artifact, review: catalogResolverFixtureReviewReadModel(artifact) };
}

export function statusForDiagnostics(
  diagnostics: CatalogResolverFixtureDiagnostic[],
): CatalogResolverFixtureStatus {
  const structuralFailureCodes = new Set<CatalogResolverFixtureDiagnosticCode>([
    catalogResolverFixtureDiagnosticCodeValues.invalidFixture,
    catalogResolverFixtureDiagnosticCodeValues.invalidSourceRegistry,
    catalogResolverFixtureDiagnosticCodeValues.invalidExactLinkResult,
    catalogResolverFixtureDiagnosticCodeValues.invalidFuzzyCandidateResult,
    catalogResolverFixtureDiagnosticCodeValues.invalidConflictReview,
  ]);
  if (diagnostics.some((entry) => structuralFailureCodes.has(entry.code))) {
    return catalogResolverFixtureStatusValues.invalid;
  }
  if (diagnostics.length > 0) {
    return catalogResolverFixtureStatusValues.reviewableWithDiagnostics;
  }
  return catalogResolverFixtureStatusValues.reviewable;
}

export function diagnostic(
  code: CatalogResolverFixtureDiagnosticCode,
  severity: CatalogResolverFixtureDiagnostic["severity"],
  message: string,
  path: string,
  options: {
    sourceRegistryId?: string;
    sourceId?: string;
    exactLinkId?: string;
    metadata?: Record<string, unknown>;
  } = {},
): CatalogResolverFixtureDiagnostic {
  return { code, severity, message, path, ...options };
}

export function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function stringOrDefault(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

export function normalizeExactLinkResult(
  value: unknown,
  index: number,
  exactLinkId: string,
  diagnostics: CatalogResolverFixtureDiagnostic[],
): CatalogExactExternalIdLinkResult | null {
  if (!isRecord(value)) {
    diagnostics.push(
      diagnostic(
        catalogResolverFixtureDiagnosticCodeValues.invalidExactLinkResult,
        "error",
        `exactLinks[${index}].result is not a recorded exact-link result.`,
        `$.exactLinks[${index}].result`,
        { exactLinkId },
      ),
    );
    return null;
  }
  const invalidPaths: string[] = [];
  if (
    value.schemaVersion !== catalogExactExternalIdLinkSchemaVersion ||
    !isEnumValue(value.status, catalogExactExternalIdLinkStatusValues) ||
    !("workId" in value) ||
    !isNullableString(value.workId) ||
    !isExactLinkSubject(value.subject)
  ) {
    invalidPaths.push(`$.exactLinks[${index}].result`);
  }
  if (!Array.isArray(value.matches)) {
    invalidPaths.push(`$.exactLinks[${index}].result.matches`);
  } else {
    for (const [matchIndex, match] of value.matches.entries()) {
      if (!isExactLinkMatch(match)) {
        invalidPaths.push(`$.exactLinks[${index}].result.matches[${matchIndex}]`);
      }
    }
  }
  if (!Array.isArray(value.diagnostics)) {
    invalidPaths.push(`$.exactLinks[${index}].result.diagnostics`);
  } else {
    for (const [diagnosticIndex, entry] of value.diagnostics.entries()) {
      if (!isBasicDiagnostic(entry)) {
        invalidPaths.push(`$.exactLinks[${index}].result.diagnostics[${diagnosticIndex}]`);
      }
    }
  }
  if (
    value.status === catalogExactExternalIdLinkStatusValues.linked &&
    !stringValue(value.workId)
  ) {
    invalidPaths.push(`$.exactLinks[${index}].result.workId`);
  }
  if (invalidPaths.length > 0) {
    for (const path of invalidPaths) {
      diagnostics.push(
        diagnostic(
          catalogResolverFixtureDiagnosticCodeValues.invalidExactLinkResult,
          "error",
          `exactLinks[${index}].result includes malformed nested resolver fields.`,
          path,
          { exactLinkId },
        ),
      );
    }
    return null;
  }
  return value as CatalogExactExternalIdLinkResult;
}
