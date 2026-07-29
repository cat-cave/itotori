import {
  type CatalogResolverFixtureArtifact,
  type CatalogResolverFixtureDiagnostic,
  catalogResolverFixtureDiagnosticCodeValues,
  type CatalogResolverFixtureExactLinkRecord,
  type CatalogResolverFixtureReviewReadModel,
  catalogResolverFixtureSchemaVersion,
  type CatalogResolverFixtureSourceRegistryEntry,
} from "./catalog-resolver-fixture-01.js";
import {
  diagnostic,
  normalizeExactLinkResult,
  stringValue,
} from "./catalog-resolver-fixture-03.js";
import {
  isArtifactConflicts,
  isArtifactExactLinkRecord,
  isArtifactFuzzyCandidates,
} from "./catalog-resolver-fixture-04.js";
import { isRecord } from "./catalog-resolver-fixture-05.js";

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
  for (const [index, exactLink] of value.exactLinks.entries()) {
    if (!isArtifactExactLinkRecord(exactLink)) {
      throw new Error(`catalog resolver artifact exactLinks[${index}] is malformed`);
    }
  }
  if (!isArtifactFuzzyCandidates(value.fuzzyCandidates)) {
    throw new Error("catalog resolver artifact fuzzyCandidates must include candidateIds");
  }
  if (!isArtifactConflicts(value.conflicts)) {
    throw new Error("catalog resolver artifact conflicts must include conflictIds");
  }
  if (!Array.isArray(value.diagnostics)) {
    throw new Error("catalog resolver artifact diagnostics must be an array");
  }
  if (!isRecord(value.review)) {
    throw new Error("catalog resolver artifact review must be a JSON object");
  }
}

export function normalizeSourceRegistry(
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

export function normalizeExactLinks(
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
    const result = normalizeExactLinkResult(entry.result, index, entry.exactLinkId, diagnostics);
    if (result === null) {
      return [];
    }
    return [{ exactLinkId: entry.exactLinkId, result }];
  });
}
