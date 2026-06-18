import type { CatalogConflictReviewReadModel } from "../repositories/catalog-repository.js";
import type {
  CatalogExactExternalIdLinkDiagnostic,
  CatalogExactExternalIdLinkResult,
} from "./catalog-exact-external-id-linker.js";
import type {
  CatalogFuzzyCandidateDiagnostic,
  CatalogFuzzyCandidateResult,
} from "./catalog-fuzzy-candidate-generator.js";

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

export function catalogResolverFixtureReviewReadModel(
  artifact: Omit<CatalogResolverFixtureArtifact, "review"> | CatalogResolverFixtureArtifact,
): CatalogResolverFixtureReviewReadModel {
  const diagnostics = artifact.diagnostics;
  return {
    artifactId: artifact.artifactId,
    status: artifact.status,
    exactLinkIds: artifact.exactLinks.map((entry) => entry.exactLinkId),
    exactLinkedWorkIds: artifact.exactLinks
      .map((entry) => entry.workId)
      .filter((workId): workId is string => workId !== null),
    fuzzyCandidateIds: artifact.fuzzyCandidates.candidateIds,
    conflictIds: artifact.conflicts.conflictIds,
    sourceRegistryIds: artifact.sourceRegistry.map((entry) => entry.sourceRegistryId),
    provenanceHashes: artifact.provenanceHashes.map((entry) => entry.provenanceHash),
    noMatchDiagnostics: diagnostics.filter(
      (entry) => entry.code === catalogResolverFixtureDiagnosticCodeValues.noMatch,
    ),
    semanticDiagnostics: diagnostics,
    reviewable: {
      exactLinks: artifact.exactLinks,
      fuzzyCandidates: artifact.fuzzyCandidates.candidates,
      conflicts: artifact.conflicts.rows,
    },
  };
}

export function assertCatalogResolverFixtureArtifact(
  value: unknown,
): asserts value is CatalogResolverFixtureArtifact {
  if (!isRecord(value)) {
    throw new Error("catalog resolver artifact must be a JSON object");
  }
  if (value.schemaVersion !== catalogResolverFixtureSchemaVersion) {
    throw new Error("catalog resolver artifact has an unsupported schemaVersion");
  }
  for (const field of [
    "artifactId",
    "generatedAt",
    "status",
    "sourceRegistry",
    "provenanceHashes",
    "exactLinks",
    "fuzzyCandidates",
    "conflicts",
    "diagnostics",
    "review",
  ]) {
    if (!(field in value)) {
      throw new Error(`catalog resolver artifact missing ${field}`);
    }
  }
  if (!Array.isArray(value.sourceRegistry)) {
    throw new Error("catalog resolver artifact sourceRegistry must be an array");
  }
  if (!Array.isArray(value.provenanceHashes)) {
    throw new Error("catalog resolver artifact provenanceHashes must be an array");
  }
  if (!Array.isArray(value.exactLinks)) {
    throw new Error("catalog resolver artifact exactLinks must be an array");
  }
  if (!isRecord(value.fuzzyCandidates) || !Array.isArray(value.fuzzyCandidates.candidateIds)) {
    throw new Error("catalog resolver artifact fuzzyCandidates must include candidateIds");
  }
  if (!isRecord(value.conflicts) || !Array.isArray(value.conflicts.conflictIds)) {
    throw new Error("catalog resolver artifact conflicts must include conflictIds");
  }
  if (!Array.isArray(value.diagnostics)) {
    throw new Error("catalog resolver artifact diagnostics must be an array");
  }
  if (!isRecord(value.review)) {
    throw new Error("catalog resolver artifact review must be a JSON object");
  }
}

function normalizeSourceRegistry(
  entries: unknown,
  diagnostics: CatalogResolverFixtureDiagnostic[],
): CatalogResolverFixtureSourceRegistryEntry[] {
  if (!Array.isArray(entries)) {
    diagnostics.push(
      diagnostic(
        catalogResolverFixtureDiagnosticCodeValues.invalidSourceRegistry,
        "error",
        "Catalog resolver fixture sourceRegistry must be an array.",
        "$.sourceRegistry",
      ),
    );
    return [];
  }
  return entries.flatMap((entry, index) => {
    if (!isRecord(entry)) {
      diagnostics.push(
        diagnostic(
          catalogResolverFixtureDiagnosticCodeValues.invalidSourceRegistry,
          "error",
          `sourceRegistry[${index}] must be a JSON object.`,
          `$.sourceRegistry[${index}]`,
        ),
      );
      return [];
    }
    const sourceRegistryId = stringValue(entry.sourceRegistryId);
    const catalogSource = stringValue(entry.catalogSource);
    const sourceId = stringValue(entry.sourceId);
    const sourceRecordKind = stringValue(entry.sourceRecordKind);
    const payloadHash = stringValue(entry.payloadHash);
    const provenanceHash = stringValue(entry.provenanceHash);
    const payloadSchemaVersion = stringValue(entry.payloadSchemaVersion);
    const payloadShape = entry.payloadShape;
    if (
      sourceRegistryId === null ||
      catalogSource === null ||
      sourceId === null ||
      sourceRecordKind === null ||
      payloadHash === null ||
      provenanceHash === null ||
      payloadSchemaVersion === null
    ) {
      diagnostics.push(
        diagnostic(
          catalogResolverFixtureDiagnosticCodeValues.invalidSourceRegistry,
          "error",
          `sourceRegistry[${index}] is missing required source identity or provenance hash fields.`,
          `$.sourceRegistry[${index}]`,
        ),
      );
      return [];
    }
    if (payloadShape !== "catalog_source_record") {
      diagnostics.push(
        diagnostic(
          catalogResolverFixtureDiagnosticCodeValues.unsupportedSourcePayload,
          "error",
          `sourceRegistry[${index}] uses unsupported payloadShape ${String(payloadShape)}.`,
          `$.sourceRegistry[${index}].payloadShape`,
          { sourceRegistryId, sourceId },
        ),
      );
      return [];
    }
    return [
      {
        sourceRegistryId,
        catalogSource,
        sourceId,
        sourceRecordKind,
        payloadHash,
        provenanceHash,
        payloadSchemaVersion,
        payloadShape,
      },
    ];
  });
}

function normalizeExactLinks(
  entries: unknown,
  diagnostics: CatalogResolverFixtureDiagnostic[],
): CatalogResolverFixtureExactLinkRecord[] {
  if (!Array.isArray(entries)) {
    diagnostics.push(
      diagnostic(
        catalogResolverFixtureDiagnosticCodeValues.invalidExactLinkResult,
        "error",
        "Catalog resolver fixture exactLinks must be an array.",
        "$.exactLinks",
      ),
    );
    return [];
  }
  return entries.flatMap((entry, index) => {
    if (!isRecord(entry) || typeof entry.exactLinkId !== "string" || !isRecord(entry.result)) {
      diagnostics.push(
        diagnostic(
          catalogResolverFixtureDiagnosticCodeValues.invalidExactLinkResult,
          "error",
          `exactLinks[${index}] must include exactLinkId and result.`,
          `$.exactLinks[${index}]`,
        ),
      );
      return [];
    }
    const result = entry.result as CatalogExactExternalIdLinkResult;
    if (
      typeof result.status !== "string" ||
      !Array.isArray(result.matches) ||
      !Array.isArray(result.diagnostics)
    ) {
      diagnostics.push(
        diagnostic(
          catalogResolverFixtureDiagnosticCodeValues.invalidExactLinkResult,
          "error",
          `exactLinks[${index}].result is not a recorded exact-link result.`,
          `$.exactLinks[${index}].result`,
          { exactLinkId: entry.exactLinkId },
        ),
      );
      return [];
    }
    return [{ exactLinkId: entry.exactLinkId, result }];
  });
}

function normalizeFuzzyCandidates(
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
      schemaVersion: "catalog.fuzzy_candidates.v0.1",
      generatorVersion: "deterministic-title-year.v0.1",
      status: "invalid",
      candidates: [],
      diagnostics: [],
    };
  }
  return value as CatalogFuzzyCandidateResult;
}

function normalizeConflictReview(
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
  return value as CatalogConflictReviewReadModel;
}

function invalidArtifact(
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
      generatorVersion: "deterministic-title-year.v0.1",
      candidateIds: [],
      candidates: [],
      diagnostics: [],
    },
    conflicts: { conflictIds: [], rows: [] },
    diagnostics,
  };
  return { ...artifact, review: catalogResolverFixtureReviewReadModel(artifact) };
}

function statusForDiagnostics(
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

function diagnostic(
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

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function stringOrDefault(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
