import { pathToFileURL } from "node:url";

import {
  assertManagedArtifactUri,
  benchmarkManagedArtifactRef,
  corpusSidecarArtifactRef,
  managedArtifactCleanupScopePrefix,
  planManagedArtifactCleanup,
  redactPrivateLocalManagedArtifactRef,
} from "../../../packages/itotori-db/src/managed-artifact-refs.js";
import { buildScenarioProjection } from "./evidence-scenario-projection.js";

interface ScenarioFields {
  evidenceKind: string;
  contentCase: string;
  sourceRevision: string;
  currentRevision: string;
  anchorRevision: string;
  peerRevision: string;
  alternateRevision: string;
  unaffectedRevision: string;
  scanClasses: readonly string[];
}

type ArtifactRequest =
  | (ScenarioFields & {
      artifactClass: "corpus_sidecar";
      scopeId: string;
      artifactId: string;
      artifactKind: "corpus_manifest" | "structure_index" | "scan_report";
      publicContent: boolean;
    })
  | (ScenarioFields & {
      artifactClass: "benchmark";
      scopeId: string;
      artifactId: string;
      artifactKind: "benchmark_seed" | "benchmark_report" | "benchmark_system_output";
      publicContent: boolean;
    });

interface BoundaryResult extends ScenarioFields {
  schema: "itotori.managed-artifact-product-proof.v1";
  artifactClass: "corpus_sidecar" | "benchmark";
  scopeId: string;
  artifactId: string;
  artifactKind: string;
  publicContent: boolean;
  publishedRef: Record<string, unknown>;
  scopePrefix: string;
  cleanupDecisions: readonly string[];
  identityChangeChangesHash: boolean;
  scenarioOutput: Record<string, unknown>;
  uriNegativeControlsRejected: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label}-invalid`);
  return value;
}

function strings(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
    throw new Error(`${label}-invalid`);
  return value.filter((entry): entry is string => typeof entry === "string");
}

function isCorpusKind(
  value: string,
): value is "corpus_manifest" | "structure_index" | "scan_report" {
  return value === "corpus_manifest" || value === "structure_index" || value === "scan_report";
}

function isBenchmarkKind(
  value: string,
): value is "benchmark_seed" | "benchmark_report" | "benchmark_system_output" {
  return (
    value === "benchmark_seed" ||
    value === "benchmark_report" ||
    value === "benchmark_system_output"
  );
}

function request(value: string | undefined): ArtifactRequest {
  if (value === undefined) throw new Error("managed-artifact-request-missing");
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed) || typeof parsed.publicContent !== "boolean") {
    throw new Error("managed-artifact-request-invalid");
  }
  const artifactClass = text(parsed.artifactClass, "managed-artifact-class");
  const scopeId = text(parsed.scopeId, "managed-artifact-scope");
  const artifactId = text(parsed.artifactId, "managed-artifact-id");
  const artifactKind = text(parsed.artifactKind, "managed-artifact-kind");
  const scenario = {
    evidenceKind: text(parsed.evidenceKind, "managed-artifact-evidence-kind"),
    contentCase: text(parsed.contentCase, "managed-artifact-content-case"),
    sourceRevision: text(parsed.sourceRevision, "managed-artifact-source-revision"),
    currentRevision: text(parsed.currentRevision, "managed-artifact-current-revision"),
    anchorRevision: text(parsed.anchorRevision, "managed-artifact-anchor-revision"),
    peerRevision: text(parsed.peerRevision, "managed-artifact-peer-revision"),
    alternateRevision: text(parsed.alternateRevision, "managed-artifact-alternate-revision"),
    unaffectedRevision: text(parsed.unaffectedRevision, "managed-artifact-unaffected-revision"),
    scanClasses: strings(parsed.scanClasses, "managed-artifact-scan-classes"),
  };
  if (artifactClass === "corpus_sidecar" && isCorpusKind(artifactKind)) {
    return {
      artifactClass,
      scopeId,
      artifactId,
      artifactKind,
      publicContent: parsed.publicContent,
      ...scenario,
    };
  }
  if (artifactClass === "benchmark" && isBenchmarkKind(artifactKind)) {
    return {
      artifactClass,
      scopeId,
      artifactId,
      artifactKind,
      publicContent: parsed.publicContent,
      ...scenario,
    };
  }
  throw new Error("managed-artifact-request-invalid");
}

function productRef(input: ArtifactRequest) {
  return input.artifactClass === "corpus_sidecar"
    ? corpusSidecarArtifactRef({
        localCorpusEntryId: input.scopeId,
        artifactId: input.artifactId,
        artifactKind: input.artifactKind,
        publicContent: input.publicContent,
      })
    : benchmarkManagedArtifactRef({
        benchmarkRunId: input.scopeId,
        artifactId: input.artifactId,
        artifactKind: input.artifactKind,
        publicContent: input.publicContent,
      });
}

function rejects(action: () => void): boolean {
  try {
    action();
    return false;
  } catch {
    return true;
  }
}

function cleanupProof(input: ArtifactRequest, created: ReturnType<typeof productRef>) {
  const superseded = productRef({ ...input, artifactId: `${input.artifactId}-superseded` });
  const candidates = [
    { artifactId: created.artifactId, uri: created.uri },
    { artifactId: superseded.artifactId, uri: superseded.uri },
    { artifactId: "outside", uri: "artifacts/utsushi/runtime/outside.bin" },
    { artifactId: "source", uri: "custody-source/read-only.bin" },
    { artifactId: "metadata", uri: null },
  ];
  const common = {
    candidates,
    retainedArtifactIds: [created.artifactId],
    protectedSourceRoots: ["custody-source"],
  };
  if (input.artifactClass === "corpus_sidecar") {
    const scope: { class: "corpus_sidecar"; localCorpusEntryId: string } = {
      class: "corpus_sidecar",
      localCorpusEntryId: input.scopeId,
    };
    return {
      cleanup: planManagedArtifactCleanup({ ...common, scope }),
      expectedPrefix: managedArtifactCleanupScopePrefix(scope),
    };
  }
  const scope: { class: "benchmark"; benchmarkRunId: string } = {
    class: "benchmark",
    benchmarkRunId: input.scopeId,
  };
  return {
    cleanup: planManagedArtifactCleanup({ ...common, scope }),
    expectedPrefix: managedArtifactCleanupScopePrefix(scope),
  };
}

function prove(input: ArtifactRequest): BoundaryResult {
  const created = productRef(input);
  const changedIdentity = productRef({
    ...input,
    artifactId: `${input.artifactId}-identity-control`,
  });
  assertManagedArtifactUri(created.uri, created.artifactClass);
  const identityChangeChangesHash = created.hash !== changedIdentity.hash;
  if (!identityChangeChangesHash) throw new Error("managed-artifact-hash-binding-invalid");
  const negativeUris = [
    "/absolute/evidence",
    "file://evidence",
    "../evidence",
    "managed\\evidence",
    input.artifactClass === "benchmark"
      ? "artifacts/itotori/corpus-sidecars/wrong/report.json"
      : "artifacts/itotori/benchmarks/wrong/report.json",
  ];
  const uriNegativeControlsRejected = negativeUris.every((uri) =>
    rejects(() => assertManagedArtifactUri(uri, input.artifactClass)),
  );
  if (!uriNegativeControlsRejected) throw new Error("managed-artifact-uri-control-survived");

  const cleanupResult = cleanupProof(input, created);
  const cleanup = cleanupResult.cleanup;
  const cleanupDecisions = cleanup.classifications.map(({ decision }) => decision);
  if (
    cleanup.scopePrefix !== cleanupResult.expectedPrefix ||
    cleanupDecisions.join("\0") !==
      ["retained", "deletable", "out_of_scope", "protected_source", "out_of_scope"].join("\0")
  ) {
    throw new Error("managed-artifact-cleanup-proof-invalid");
  }
  const publishedRef = redactPrivateLocalManagedArtifactRef(created);
  if (
    input.publicContent
      ? publishedRef.uri !== created.uri ||
        publishedRef.hash !== created.hash ||
        publishedRef.redactedFields.length !== 0
      : publishedRef.uri !== "[redacted-private-local-artifact]" ||
        "hash" in publishedRef ||
        publishedRef.redactedFields.join("\0") !== "uri\0hash"
  ) {
    throw new Error("managed-artifact-redaction-proof-invalid");
  }
  return {
    schema: "itotori.managed-artifact-product-proof.v1",
    artifactClass: input.artifactClass,
    scopeId: input.scopeId,
    artifactId: input.artifactId,
    artifactKind: input.artifactKind,
    publicContent: input.publicContent,
    evidenceKind: input.evidenceKind,
    contentCase: input.contentCase,
    sourceRevision: input.sourceRevision,
    currentRevision: input.currentRevision,
    anchorRevision: input.anchorRevision,
    peerRevision: input.peerRevision,
    alternateRevision: input.alternateRevision,
    unaffectedRevision: input.unaffectedRevision,
    scanClasses: input.scanClasses,
    publishedRef,
    scopePrefix: cleanup.scopePrefix,
    cleanupDecisions,
    identityChangeChangesHash,
    scenarioOutput: buildScenarioProjection(input),
    uriNegativeControlsRejected,
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${JSON.stringify(prove(request(process.argv[2])))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
