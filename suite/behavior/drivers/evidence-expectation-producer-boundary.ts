import { fileURLToPath, pathToFileURL } from "node:url";

import {
  digest,
  productRequest,
  type ProductProof,
  type ProductRequest,
} from "./evidence-contract.js";
import { independentlyEvaluateScenario } from "./evidence-expectation-scenario-client.js";
import {
  finishRecord,
  parseProducerRequest,
  productBuildDigest,
  sourceObservation,
  type SourceObservation,
} from "./evidence-producer-support.js";

const PRIVATE_KEY =
  "-----BEGIN " +
  "PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIHmeIzfdVbYxSeE6NpY448QWtAqeUwQphxJL8cRD17Fz\n-----END PRIVATE KEY-----\n";

const DIRECTORIES: Readonly<Record<string, string>> = {
  corpus_manifest: "manifests",
  structure_index: "structure",
  scan_report: "scan-reports",
  benchmark_seed: "seeds",
  benchmark_report: "reports",
  benchmark_system_output: "system-outputs",
};

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) record[key] = entry;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function expectedProductProof(
  input: ProductRequest,
  scenarioOutput: Record<string, unknown>,
): ProductProof {
  const directory = DIRECTORIES[input.artifactKind];
  if (directory === undefined) throw new Error("expectation-product-kind-invalid");
  const root =
    input.artifactClass === "corpus_sidecar"
      ? "artifacts/itotori/corpus-sidecars"
      : "artifacts/itotori/benchmarks";
  const uri = `${root}/${input.scopeId}/${directory}/${input.artifactId}.json`;
  const hash = `sha256:${digest(
    stableJson({ artifactId: input.artifactId, artifactKind: input.artifactKind, uri }),
  )}`;
  const changedId = `${input.artifactId}-identity-control`;
  const changedUri = `${root}/${input.scopeId}/${directory}/${changedId}.json`;
  const changedHash = `sha256:${digest(
    stableJson({ artifactId: changedId, artifactKind: input.artifactKind, uri: changedUri }),
  )}`;
  const raw =
    input.artifactClass === "corpus_sidecar"
      ? {
          artifactClass: input.artifactClass,
          localCorpusEntryId: input.scopeId,
          artifactId: input.artifactId,
          artifactKind: input.artifactKind,
          uri,
          hash,
          publicContent: input.publicContent,
        }
      : {
          artifactClass: input.artifactClass,
          benchmarkRunId: input.scopeId,
          artifactId: input.artifactId,
          artifactKind: input.artifactKind,
          uri,
          hash,
          publicContent: input.publicContent,
        };
  const publishedRef = input.publicContent
    ? { ...raw, redactedFields: [] }
    : Object.fromEntries(
        Object.entries({
          ...raw,
          uri: "[redacted-private-local-artifact]",
          redactedFields: ["uri", "hash"],
        }).filter(([key]) => key !== "hash"),
      );
  return {
    schema: "itotori.managed-artifact-product-proof.v1",
    ...input,
    publishedRef,
    scopePrefix: `${root}/${input.scopeId}/`,
    cleanupDecisions: ["retained", "deletable", "out_of_scope", "protected_source", "out_of_scope"],
    identityChangeChangesHash: hash !== changedHash,
    scenarioOutput,
    uriNegativeControlsRejected: true,
  };
}

function normalizeExpectation(value: unknown): unknown {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.map((entry) => normalizeExpectation(entry));
  if (typeof value !== "object") throw new Error("expectation-semantic-value-invalid");
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, normalizeExpectation(entry)]),
  );
}

function semanticProjection(
  request: ReturnType<typeof parseProducerRequest>,
  observation: SourceObservation,
  proof: ProductProof,
) {
  const revisions = {
    source: digest(observation.source),
    current: digest(observation.current),
    anchor: digest(observation.anchor),
    peer: digest(observation.peer),
    alternate: digest(observation.alternate),
    unaffected: digest(observation.unaffected),
  };
  if (
    proof.evidenceKind !== request.evidenceKind ||
    proof.contentCase !== request.contentCase ||
    proof.sourceRevision !== revisions.source ||
    proof.currentRevision !== revisions.current ||
    proof.anchorRevision !== revisions.anchor ||
    proof.peerRevision !== revisions.peer ||
    proof.alternateRevision !== revisions.alternate ||
    proof.unaffectedRevision !== revisions.unaffected ||
    proof.scanClasses.join("\0") !== observation.scans.join("\0") ||
    !proof.identityChangeChangesHash ||
    !proof.uriNegativeControlsRejected ||
    proof.cleanupDecisions.join("\0") !==
      "retained\0deletable\0out_of_scope\0protected_source\0out_of_scope"
  )
    throw new Error("expectation-semantic-observation-binding-invalid");
  const projection = normalizeExpectation({
    evidenceKind: request.evidenceKind,
    contentCase: request.contentCase,
    pairRevisions: [revisions.source, revisions.peer].sort(),
    currentRevision: revisions.current,
    anchorRevision: revisions.anchor,
    alternatePairRevisions: [revisions.source, revisions.alternate].sort(),
    unaffectedRevision: revisions.unaffected,
    scanClasses: [...observation.scans].sort(),
    managedProduct: {
      artifactClass: proof.artifactClass,
      artifactKind: proof.artifactKind,
      publicContent: proof.publicContent,
      scopePrefix: proof.scopePrefix,
      cleanupDecisions: proof.cleanupDecisions,
      identityChangeChangesHash: proof.identityChangeChangesHash,
      uriNegativeControlsRejected: proof.uriNegativeControlsRejected,
      publishedReferenceHasHash: "hash" in proof.publishedRef,
      publishedReferenceRedactedFields: proof.publishedRef.redactedFields,
    },
    scenarioOutput: proof.scenarioOutput,
  });
  return {
    projection,
    projectionCommitment: digest(
      `itotori.evidence-observed-projection.v1\0${stableJson(projection)}`,
    ),
  };
}

function artifact(
  caseId: string,
  scope: string,
  source: Buffer,
  proof: ProductProof,
  facts: ReturnType<typeof semanticProjection>,
): Buffer {
  const sourceRevision = digest(source);
  const semanticOutput = {
    schema: "itotori.evidence-semantic-output.v2",
    caseId,
    scope,
    sourceRevision,
    projection: facts.projection,
    projectionCommitment: facts.projectionCommitment,
    resultRevision: digest(
      `itotori.evidence-semantic-result.v2\0${caseId}\0${scope}\0${sourceRevision}\0${facts.projectionCommitment}`,
    ),
  };
  return Buffer.from(
    `ITOTORI-INDEPENDENT-PRODUCT-EXPECTATION-V4\n${stableJson({
      semanticOutput,
      managedArtifact: proof.publishedRef,
    })}\n`,
    "utf8",
  );
}

function artifacts(
  caseId: string,
  scope: string,
  observation: SourceObservation,
  proof: ProductProof,
  facts: ReturnType<typeof semanticProjection>,
) {
  return {
    artifact: artifact(caseId, scope, observation.source, proof, facts),
    repeatedArtifact: artifact(caseId, scope, observation.source, proof, facts),
    alternateArtifact: artifact(caseId, scope, observation.alternate, proof, facts),
    unaffectedArtifact: artifact(caseId, scope, observation.unaffected, proof, facts),
    repeatedUnaffectedArtifact: artifact(caseId, scope, observation.unaffected, proof, facts),
  };
}

function produce(value: string | undefined): void {
  const request = parseProducerRequest(value, ["expectation"]);
  const source = sourceObservation(request);
  if (productBuildDigest(request.productBoundaryPath) !== request.productBuildDigest) {
    throw new Error("expectation-product-build-digest-mismatch");
  }
  const productInput = productRequest({
    caseId: request.caseId,
    scope: request.scope,
    role: request.role,
    evidenceKind: request.evidenceKind,
    privacyClass: request.privacyClass,
    safe: source.scans.length === 0,
    contentCase: request.contentCase,
    sourceRevision: digest(source.source),
    currentRevision: digest(source.current),
    anchorRevision: digest(source.anchor),
    peerRevision: digest(source.peer),
    alternateRevision: digest(source.alternate),
    unaffectedRevision: digest(source.unaffected),
    scanClasses: source.scans,
  });
  const proof = expectedProductProof(
    productInput,
    independentlyEvaluateScenario(request.productBoundaryPath, productInput),
  );
  const facts = semanticProjection(request, source, proof);
  finishRecord({
    request,
    producerPath: fileURLToPath(import.meta.url),
    privateKey: PRIVATE_KEY,
    productProof: proof,
    semanticCommitment: facts.projectionCommitment,
    observation: source,
    artifacts: artifacts(request.caseId, request.scope, source, proof, facts),
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    produce(process.argv[2]);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
