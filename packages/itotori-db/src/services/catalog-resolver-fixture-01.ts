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
  catalogResolverFixtureReviewReadModel,
  normalizeExactLinks,
  normalizeSourceRegistry,
} from "./catalog-resolver-fixture-02.js";
import {
  diagnostic,
  invalidArtifact,
  normalizeConflictReview,
  normalizeFuzzyCandidates,
  statusForDiagnostics,
  stringOrDefault,
} from "./catalog-resolver-fixture-03.js";
import { isRecord } from "./catalog-resolver-fixture-05.js";

export const catalogResolverFixtureSchemaVersion = "catalog.resolver_fixture.v0.1" as const;

export const catalogResolverFixtureStatusValues = {
  reviewable: "reviewable",
  reviewableWithDiagnostics: "reviewable_with_diagnostics",
  invalid: "invalid",
} as const;

export type CatalogResolverFixtureStatus =
  (typeof catalogResolverFixtureStatusValues)[keyof typeof catalogResolverFixtureStatusValues];

export const catalogResolverFixtureDiagnosticCodeValues = {
  invalidFixture: "catalog.resolver_fixture.invalid_fixture",
  invalidSourceRegistry: "catalog.resolver_fixture.invalid_source_registry",
  invalidExactLinkResult: "catalog.resolver_fixture.invalid_exact_link_result",
  invalidFuzzyCandidateResult: "catalog.resolver_fixture.invalid_fuzzy_candidate_result",
  invalidConflictReview: "catalog.resolver_fixture.invalid_conflict_review",
  noMatch: "catalog.resolver_fixture.no_match",
  unsupportedSourcePayload: "catalog.resolver_fixture.unsupported_source_payload",
} as const;

export type CatalogResolverFixtureDiagnosticCode =
  (typeof catalogResolverFixtureDiagnosticCodeValues)[keyof typeof catalogResolverFixtureDiagnosticCodeValues];

export type CatalogResolverFixtureDiagnostic = {
  code: CatalogResolverFixtureDiagnosticCode;
  severity: "info" | "warning" | "error";
  message: string;
  path: string;
  sourceRegistryId?: string;
  sourceId?: string;
  exactLinkId?: string;
  metadata?: Record<string, unknown>;
};

export type CatalogResolverFixtureSourceRegistryEntry = {
  sourceRegistryId: string;
  catalogSource: string;
  sourceId: string;
  sourceRecordKind: string;
  payloadHash: string;
  provenanceHash: string;
  payloadSchemaVersion: string;
  payloadShape: "catalog_source_record";
};

export type CatalogResolverFixtureExactLinkRecord = {
  exactLinkId: string;
  result: CatalogExactExternalIdLinkResult;
};

export type CatalogResolverFixtureInput = {
  schemaVersion?: typeof catalogResolverFixtureSchemaVersion;
  artifactId: string;
  generatedAt: string;
  sourceRegistry: unknown[];
  exactLinks: unknown[];
  fuzzyCandidates: unknown;
  conflicts: unknown;
};

export type CatalogResolverFixtureExactLinkArtifactRecord = {
  exactLinkId: string;
  status: CatalogExactExternalIdLinkResult["status"];
  workId: string | null;
  matchIds: string[];
  matches: CatalogExactExternalIdLinkResult["matches"];
  diagnostics: CatalogExactExternalIdLinkDiagnostic[];
};

export type CatalogResolverFixtureFuzzyCandidateArtifactRecord =
  CatalogFuzzyCandidateResult["candidates"][number];

export type CatalogResolverFixtureArtifact = {
  schemaVersion: typeof catalogResolverFixtureSchemaVersion;
  artifactId: string;
  generatedAt: string;
  status: CatalogResolverFixtureStatus;
  sourceRegistry: CatalogResolverFixtureSourceRegistryEntry[];
  provenanceHashes: {
    sourceRegistryId: string;
    catalogSource: string;
    sourceId: string;
    payloadHash: string;
    provenanceHash: string;
  }[];
  exactLinks: CatalogResolverFixtureExactLinkArtifactRecord[];
  fuzzyCandidates: {
    status: CatalogFuzzyCandidateResult["status"];
    generatorVersion: CatalogFuzzyCandidateResult["generatorVersion"];
    candidateIds: string[];
    candidates: CatalogResolverFixtureFuzzyCandidateArtifactRecord[];
    diagnostics: CatalogFuzzyCandidateDiagnostic[];
  };
  conflicts: {
    conflictIds: string[];
    rows: CatalogConflictReviewReadModel["rows"];
  };
  diagnostics: CatalogResolverFixtureDiagnostic[];
  review: CatalogResolverFixtureReviewReadModel;
};

export type CatalogResolverFixtureReviewReadModel = {
  artifactId: string;
  status: CatalogResolverFixtureStatus;
  exactLinkIds: string[];
  exactLinkedWorkIds: string[];
  fuzzyCandidateIds: string[];
  conflictIds: string[];
  sourceRegistryIds: string[];
  provenanceHashes: string[];
  noMatchDiagnostics: CatalogResolverFixtureDiagnostic[];
  semanticDiagnostics: CatalogResolverFixtureDiagnostic[];
  reviewable: {
    exactLinks: CatalogResolverFixtureExactLinkArtifactRecord[];
    fuzzyCandidates: CatalogResolverFixtureFuzzyCandidateArtifactRecord[];
    conflicts: CatalogConflictReviewReadModel["rows"];
  };
};

export function createCatalogResolverFixtureArtifact(
  input: CatalogResolverFixtureInput,
): CatalogResolverFixtureArtifact {
  const diagnostics: CatalogResolverFixtureDiagnostic[] = [];
  if (!isRecord(input)) {
    return invalidArtifact("catalog-resolver-fixture", "1970-01-01T00:00:00.000Z", [
      diagnostic(
        catalogResolverFixtureDiagnosticCodeValues.invalidFixture,
        "error",
        "Catalog resolver fixture input must be a JSON object.",
        "$",
      ),
    ]);
  }

  if (
    input.schemaVersion !== undefined &&
    input.schemaVersion !== catalogResolverFixtureSchemaVersion
  ) {
    diagnostics.push(
      diagnostic(
        catalogResolverFixtureDiagnosticCodeValues.invalidFixture,
        "error",
        `Unsupported catalog resolver fixture schemaVersion ${String(input.schemaVersion)}.`,
        "$.schemaVersion",
      ),
    );
  }

  const sourceRegistry = normalizeSourceRegistry(input.sourceRegistry, diagnostics);
  const exactLinks = normalizeExactLinks(input.exactLinks, diagnostics);
  const fuzzyCandidates = normalizeFuzzyCandidates(input.fuzzyCandidates, diagnostics);
  const conflicts = normalizeConflictReview(input.conflicts, diagnostics);

  for (const exactLink of exactLinks) {
    if (exactLink.result.status === "no_match") {
      diagnostics.push(
        diagnostic(
          catalogResolverFixtureDiagnosticCodeValues.noMatch,
          "info",
          "Exact external-id fixture path produced no catalog match.",
          `$.exactLinks[${exactLink.exactLinkId}]`,
          {
            exactLinkId: exactLink.exactLinkId,
            metadata: {
              subject: exactLink.result.subject,
              exactDiagnostics: exactLink.result.diagnostics,
            },
          },
        ),
      );
    }
  }

  const artifact: Omit<CatalogResolverFixtureArtifact, "review"> = {
    schemaVersion: catalogResolverFixtureSchemaVersion,
    artifactId: stringOrDefault(input.artifactId, "catalog-resolver-fixture"),
    generatedAt: stringOrDefault(input.generatedAt, "1970-01-01T00:00:00.000Z"),
    status: statusForDiagnostics(diagnostics),
    sourceRegistry,
    provenanceHashes: sourceRegistry.map((entry) => ({
      sourceRegistryId: entry.sourceRegistryId,
      catalogSource: entry.catalogSource,
      sourceId: entry.sourceId,
      payloadHash: entry.payloadHash,
      provenanceHash: entry.provenanceHash,
    })),
    exactLinks: exactLinks.map((entry) => ({
      exactLinkId: entry.exactLinkId,
      status: entry.result.status,
      workId: entry.result.workId,
      matchIds: entry.result.matches.map(
        (match) =>
          `${match.catalogSource}:${match.sourceId}:${match.externalIdKind}:${match.workId}`,
      ),
      matches: entry.result.matches,
      diagnostics: entry.result.diagnostics,
    })),
    fuzzyCandidates: {
      status: fuzzyCandidates.status,
      generatorVersion: fuzzyCandidates.generatorVersion,
      candidateIds: fuzzyCandidates.candidates.map((candidate) => candidate.candidateId),
      candidates: fuzzyCandidates.candidates,
      diagnostics: fuzzyCandidates.diagnostics,
    },
    conflicts: {
      conflictIds: conflicts.rows.map((row) => row.reviewId),
      rows: conflicts.rows,
    },
    diagnostics,
  };
  const review = catalogResolverFixtureReviewReadModel(artifact);
  return { ...artifact, review };
}
