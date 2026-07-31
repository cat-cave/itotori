import { fileURLToPath, pathToFileURL } from "node:url";

import {
  digest,
  productRequest,
  type ProducerRequest,
  type ProductProof,
} from "./evidence-contract.js";
import {
  finishRecord,
  parseProducerRequest,
  productBuildDigest,
  runProductBoundary,
  sourceObservation,
  type SourceObservation,
} from "./evidence-producer-support.js";

const PRIVATE_KEYS = {
  evaluated:
    "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIGuDUTb7KlmdPC0FQ178bpyXGcqXwu58DoMqkfYZjEzK\n-----END PRIVATE KEY-----\n",
  unaffected:
    "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIICBpdOh7LNnKvhftijM9UeMf4OMaMRk7XX7pB2HFi1o\n-----END PRIVATE KEY-----\n",
};

function normalized(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return value;
  if (Array.isArray(value)) return value.map(normalized);
  if (typeof value !== "object") throw new Error("evaluated-semantic-value-invalid");
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  ))
    output[key] = normalized(entry);
  return output;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value)
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

function semanticProjection(
  request: ProducerRequest,
  observation: SourceObservation,
  proof: ProductProof,
) {
  if (
    !proof.identityChangeChangesHash ||
    !proof.uriNegativeControlsRejected ||
    proof.cleanupDecisions.join("\0") !==
      "retained\0deletable\0out_of_scope\0protected_source\0out_of_scope" ||
    proof.evidenceKind !== request.evidenceKind ||
    proof.contentCase !== request.contentCase ||
    proof.sourceRevision !== digest(observation.source) ||
    proof.currentRevision !== digest(observation.current) ||
    proof.anchorRevision !== digest(observation.anchor) ||
    proof.peerRevision !== digest(observation.peer) ||
    proof.alternateRevision !== digest(observation.alternate) ||
    proof.unaffectedRevision !== digest(observation.unaffected) ||
    proof.scanClasses.join("\0") !== observation.scans.join("\0")
  )
    throw new Error("evaluated-semantic-observation-binding-invalid");
  const projection = normalized({
    evidenceKind: request.evidenceKind,
    contentCase: request.contentCase,
    pairRevisions: [digest(observation.source), digest(observation.peer)].sort(),
    currentRevision: digest(observation.current),
    anchorRevision: digest(observation.anchor),
    alternatePairRevisions: [digest(observation.source), digest(observation.alternate)].sort(),
    unaffectedRevision: digest(observation.unaffected),
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
  role: string,
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
    `${JSON.stringify({
      schema: "itotori.evaluated-product-evidence.v4",
      role,
      semanticOutput,
      managedArtifact: proof.publishedRef,
    })}\n`,
    "utf8",
  );
}

function artifacts(
  caseId: string,
  scope: string,
  role: string,
  observation: SourceObservation,
  proof: ProductProof,
  facts: ReturnType<typeof semanticProjection>,
) {
  return {
    artifact: artifact(caseId, scope, role, observation.source, proof, facts),
    repeatedArtifact: artifact(caseId, scope, role, observation.source, proof, facts),
    alternateArtifact: artifact(caseId, scope, role, observation.alternate, proof, facts),
    unaffectedArtifact: artifact(caseId, scope, role, observation.unaffected, proof, facts),
    repeatedUnaffectedArtifact: artifact(caseId, scope, role, observation.unaffected, proof, facts),
  };
}

function produce(value: string | undefined): void {
  const request = parseProducerRequest(value, ["evaluated", "unaffected"]);
  const observation = sourceObservation(request);
  if (productBuildDigest(request.productBoundaryPath) !== request.productBuildDigest) {
    throw new Error("evaluated-product-build-digest-mismatch");
  }
  const proof = runProductBoundary(
    request.productBoundaryPath,
    productRequest({
      caseId: request.caseId,
      scope: request.scope,
      role: request.role,
      evidenceKind: request.evidenceKind,
      privacyClass: request.privacyClass,
      safe: observation.scans.length === 0,
      contentCase: request.contentCase,
      sourceRevision: digest(observation.source),
      currentRevision: digest(observation.current),
      anchorRevision: digest(observation.anchor),
      peerRevision: digest(observation.peer),
      alternateRevision: digest(observation.alternate),
      unaffectedRevision: digest(observation.unaffected),
      scanClasses: observation.scans,
    }),
  );
  if (request.role === "expectation") throw new Error("evaluated-producer-role-invalid");
  const facts = semanticProjection(request, observation, proof);
  finishRecord({
    request,
    producerPath: fileURLToPath(import.meta.url),
    privateKey: request.role === "evaluated" ? PRIVATE_KEYS.evaluated : PRIVATE_KEYS.unaffected,
    productProof: proof,
    semanticCommitment: facts.projectionCommitment,
    observation,
    artifacts: artifacts(request.caseId, request.scope, request.role, observation, proof, facts),
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
