import { spawnSync } from "node:child_process";
import { createHash, randomUUID, sign as signBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

import {
  digest,
  isRecord,
  parseProductProof,
  producerIdentity,
  publicKeyForRole,
  signedEvidencePayload,
  type LocalEvidenceChecks,
  type ProducerRequest,
  type ProducerRole,
  type ProductProof,
  type PublicEvidenceRecord,
  type RestrictedEvidenceReceipt,
  type SourceKind,
} from "./evidence-contract.js";
import { portableFile, scanForbiddenClasses } from "./evidence-portability.js";

const FIELDS: readonly string[] = [
  "producer",
  "sourceRevision",
  "inputHash",
  "outputHash",
  "privacyClass",
  "outcome",
];

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label}-invalid`);
  return value;
}

function role(value: unknown, allowed: readonly ProducerRole[]): ProducerRole {
  if (
    (value === "evaluated" || value === "expectation" || value === "unaffected") &&
    allowed.includes(value)
  )
    return value;
  throw new Error("evidence-producer-role-invalid");
}

function sourceKind(value: unknown): SourceKind {
  if (
    value === "tracked-production-source" ||
    value === "synthetic-public-source" ||
    value === "evaluated-output-copy"
  )
    return value;
  throw new Error("evidence-producer-source-kind-invalid");
}

export function parseProducerRequest(
  value: string | undefined,
  allowed: readonly ProducerRole[],
): ProducerRequest {
  if (value === undefined) throw new Error("evidence-producer-request-missing");
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) throw new Error("evidence-producer-request-invalid");
  return {
    role: role(parsed.role, allowed),
    caseId: text(parsed.caseId, "producer-case"),
    scope: text(parsed.scope, "producer-scope"),
    sourceLabel: text(parsed.sourceLabel, "producer-source-label"),
    sourceKind: sourceKind(parsed.sourceKind),
    bundleRoot: text(parsed.bundleRoot, "producer-bundle-root"),
    inputRoot: text(parsed.inputRoot, "producer-input-root"),
    inputReference: text(parsed.inputReference, "producer-input-reference"),
    currentInputReference: text(parsed.currentInputReference, "producer-current-reference"),
    pairAnchorReference: text(parsed.pairAnchorReference, "producer-anchor-reference"),
    peerInputReference: text(parsed.peerInputReference, "producer-peer-reference"),
    alternateInputReference: text(parsed.alternateInputReference, "producer-alternate-reference"),
    unaffectedInputReference: text(
      parsed.unaffectedInputReference,
      "producer-unaffected-reference",
    ),
    censusReference: text(parsed.censusReference, "producer-census-reference"),
    privateArtifactReference: text(
      parsed.privateArtifactReference,
      "producer-private-artifact-reference",
    ),
    artifactReference: text(parsed.artifactReference, "producer-artifact-reference"),
    recordReference: text(parsed.recordReference, "producer-record-reference"),
    buildRevision: text(parsed.buildRevision, "producer-build-revision"),
    evidenceKind: text(parsed.evidenceKind, "producer-evidence-kind"),
    contentCase: text(parsed.contentCase, "producer-content-case"),
    sourceClass: text(parsed.sourceClass, "producer-source-class"),
    privacyClass: text(parsed.privacyClass, "producer-privacy-class"),
    referenceKind: text(parsed.referenceKind, "producer-reference-kind"),
    productBoundaryPath: text(parsed.productBoundaryPath, "producer-product-boundary"),
    productSourceDigest: text(parsed.productSourceDigest, "producer-product-source"),
    productBuildDigest: text(parsed.productBuildDigest, "producer-product-build"),
  };
}

export function safeWritePath(root: string, reference: string): string {
  if (
    reference.includes("\\") ||
    reference.includes(":") ||
    reference.startsWith("/") ||
    reference
      .split("/")
      .some(
        (part) =>
          part.length === 0 || part === "." || part === ".." || !/^[A-Za-z0-9._-]+$/u.test(part),
      )
  ) {
    throw new Error("evidence-producer-output-reference-invalid");
  }
  const canonicalRoot = realpathSync(root);
  const path = resolve(canonicalRoot, reference);
  let current = canonicalRoot;
  for (const part of reference.split("/").slice(0, -1)) {
    current = resolve(current, part);
    if (!existsSync(current)) mkdirSync(current);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error("evidence-producer-output-reference-invalid");
  }
  const parent = realpathSync(dirname(path));
  const fromRoot = relative(canonicalRoot, parent);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`))
    throw new Error("evidence-producer-output-reference-invalid");
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new Error("evidence-producer-output-reference-invalid");
  }
  return path;
}

export function productBuildDigest(boundaryPath: string): string {
  const productRoot = resolve(dirname(boundaryPath), "../../..");
  const hash = createHash("sha256");
  function filesBelow(root: string): string[] {
    return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
      const path = resolve(root, entry.name);
      if (entry.isSymbolicLink()) throw new Error("product-build-symlink-invalid");
      return entry.isDirectory() ? filesBelow(path) : [path];
    });
  }
  for (const path of filesBelow(productRoot).sort())
    hash.update(relative(productRoot, path)).update("\0").update(readFileSync(path)).update("\n");
  return hash.digest("hex");
}

export interface ProducerImplementationBinding {
  implementationDigest: string;
  supportDigest: string;
  contractDigest: string;
  portabilityDigest: string;
}

export function producerImplementationBinding(producerPath: string): ProducerImplementationBinding {
  const supportPath = resolve(dirname(producerPath), "evidence-producer-support.js");
  const contractPath = resolve(dirname(producerPath), "evidence-contract.js");
  const productProofKeysPath = resolve(dirname(producerPath), "evidence-product-proof-keys.js");
  const portabilityPath = resolve(dirname(producerPath), "evidence-portability.js");
  const supportDigest = digest(readFileSync(supportPath));
  const contractDigest = createHash("sha256")
    .update("contract\0")
    .update(readFileSync(contractPath))
    .update("\nproduct-proof-keys\0")
    .update(readFileSync(productProofKeysPath))
    .digest("hex");
  const portabilityDigest = digest(readFileSync(portabilityPath));
  const hash = createHash("sha256");
  const paths: Array<readonly [string, string]> = [
    ["producer", producerPath],
    ["support", supportPath],
    ["contract", contractPath],
    ["product-proof-keys", productProofKeysPath],
    ["portability", portabilityPath],
  ];
  if (producerPath.endsWith("evidence-expectation-producer-boundary.js")) {
    paths.push([
      "expectation-scenario-client",
      resolve(dirname(producerPath), "evidence-expectation-scenario-client.js"),
    ]);
  }
  for (const [name, path] of paths)
    hash.update(name).update("\0").update(readFileSync(path)).update("\n");
  return {
    implementationDigest: hash.digest("hex"),
    supportDigest,
    contractDigest,
    portabilityDigest,
  };
}

export function runProductBoundary(boundaryPath: string, request: unknown): ProductProof {
  const result = spawnSync(process.execPath, [boundaryPath, JSON.stringify(request)], {
    cwd: dirname(boundaryPath),
    encoding: "utf8",
  });
  if (result.status !== 0 || result.stderr !== "" || !result.stdout.endsWith("\n")) {
    throw new Error(
      `managed-artifact-product-boundary-failed:${result.status ?? "no-status"}:${result.stderr.trim()}`,
    );
  }
  return parseProductProof(JSON.parse(result.stdout));
}

function inputBytes(root: string, reference: string, label: string): Buffer {
  const path = portableFile(root, reference);
  if (path === null) throw new Error(`${label}-invalid`);
  const bytes = readFileSync(path);
  if (bytes.length === 0) throw new Error(`${label}-empty`);
  return bytes;
}

export interface SourceObservation {
  source: Buffer;
  current: Buffer;
  anchor: Buffer;
  peer: Buffer;
  alternate: Buffer;
  unaffected: Buffer;
  scans: readonly string[];
}

export function sourceObservation(input: ProducerRequest): SourceObservation {
  const source = inputBytes(input.inputRoot, input.inputReference, "evidence-producer-source");
  return {
    source,
    current: inputBytes(input.inputRoot, input.currentInputReference, "evidence-producer-current"),
    anchor: inputBytes(input.inputRoot, input.pairAnchorReference, "evidence-producer-anchor"),
    peer: inputBytes(input.inputRoot, input.peerInputReference, "evidence-producer-peer"),
    alternate: inputBytes(
      input.inputRoot,
      input.alternateInputReference,
      "evidence-producer-alternate",
    ),
    unaffected: inputBytes(
      input.inputRoot,
      input.unaffectedInputReference,
      "evidence-producer-unaffected",
    ),
    scans: scanForbiddenClasses(source),
  };
}

export interface GeneratedArtifacts {
  artifact: Buffer;
  repeatedArtifact: Buffer;
  alternateArtifact: Buffer;
  unaffectedArtifact: Buffer;
  repeatedUnaffectedArtifact: Buffer;
}

function checks(
  observation: SourceObservation,
  artifacts: GeneratedArtifacts,
): LocalEvidenceChecks {
  return {
    sourceMatchesCurrent: observation.source.equals(observation.current),
    sourceMatchesPairAnchor: observation.source.equals(observation.anchor),
    sourceSafe: observation.scans.length === 0,
    deterministicRepeat: artifacts.artifact.equals(artifacts.repeatedArtifact),
    changedDependent:
      !observation.source.equals(observation.alternate) &&
      !artifacts.artifact.equals(artifacts.alternateArtifact),
    unaffectedStable: artifacts.unaffectedArtifact.equals(artifacts.repeatedUnaffectedArtifact),
  };
}

function writeCensus(input: {
  request: ProducerRequest;
  producer: string;
  observation: SourceObservation;
  artifacts: GeneratedArtifacts;
  outcome: string;
  localChecks: LocalEvidenceChecks;
}): boolean {
  const values = [
    input.producer,
    digest(input.observation.source),
    digest(input.observation.source),
    digest(input.artifacts.artifact),
    input.request.privacyClass,
    input.outcome,
  ];
  const census = {
    schema: "itotori.ephemeral-private-evidence-census.v1",
    sourceHash: digest(input.observation.source),
    currentHash: digest(input.observation.current),
    anchorHash: digest(input.observation.anchor),
    alternateHash: digest(input.observation.alternate),
    unaffectedSourceHash: digest(input.observation.unaffected),
    artifactHash: digest(input.artifacts.artifact),
    repeatedArtifactHash: digest(input.artifacts.repeatedArtifact),
    alternateArtifactHash: digest(input.artifacts.alternateArtifact),
    unaffectedArtifactHash: digest(input.artifacts.unaffectedArtifact),
    repeatedUnaffectedArtifactHash: digest(input.artifacts.repeatedUnaffectedArtifact),
    localChecks: input.localChecks,
    fields: FIELDS.map((field, index) => ({
      field,
      nonemptyCount: values[index]?.length === 0 ? 0 : 1,
      totalCount: 1,
    })),
  };
  const censusRoot =
    input.request.privacyClass === "restricted"
      ? input.request.bundleRoot
      : input.request.inputRoot;
  writeFileSync(
    safeWritePath(censusRoot, input.request.censusReference),
    `${JSON.stringify(census)}\n`,
  );
  return values.every((entry) => entry.length > 0);
}

export function finishRecord(input: {
  request: ProducerRequest;
  producerPath: string;
  privateKey: string;
  productProof: ProductProof;
  semanticCommitment: string;
  observation: SourceObservation;
  artifacts: GeneratedArtifacts;
}): void {
  const implementationDigest = producerImplementationBinding(
    input.producerPath,
  ).implementationDigest;
  const publicKey = publicKeyForRole(input.request.role);
  const producer = producerIdentity(input.request.role, implementationDigest, publicKey);
  const safe = input.observation.scans.length === 0;
  const published = input.request.privacyClass === "public-safe" && safe;
  const outcome = !safe
    ? "publication-refused"
    : published
      ? input.request.role === "expectation"
        ? "independent-expectation-produced"
        : "artifact-produced"
      : "local-private-facts-verified";
  const localChecks = checks(input.observation, input.artifacts);
  const restricted = input.request.privacyClass === "restricted";
  if (published || restricted)
    writeFileSync(
      safeWritePath(
        input.request.bundleRoot,
        restricted ? input.request.privateArtifactReference : input.request.artifactReference,
      ),
      input.artifacts.artifact,
    );
  else
    writeFileSync(
      safeWritePath(input.request.inputRoot, input.request.privateArtifactReference),
      input.artifacts.artifact,
    );
  const localFactsVerified = writeCensus({
    request: input.request,
    producer,
    observation: input.observation,
    artifacts: input.artifacts,
    outcome,
    localChecks,
  });
  const trustRole: "local-candidate-contract" = "local-candidate-contract";
  const protectedAttestationPresent: false = false;
  const sourceHash = digest(input.observation.source);
  const outputHash =
    published || restricted ? digest(input.artifacts.artifact) : digest(Buffer.alloc(0));
  const shared = {
    role: input.request.role,
    caseId: input.request.caseId,
    scope: input.request.scope,
    producer,
    producerImplementationDigest: implementationDigest,
    publicKey,
    invocationId: randomUUID(),
    buildRevision: input.request.buildRevision,
    sourceKind: input.request.sourceKind,
    sourceClass: input.request.sourceClass,
    evidenceKind: input.request.evidenceKind,
    outcome,
    referenceKind: input.request.referenceKind,
    safe,
    localFactsVerified,
    trustRole,
    protectedAttestationPresent,
    localChecks,
    productSourceDigest: input.request.productSourceDigest,
    productBuildDigest: input.request.productBuildDigest,
    productProof: input.productProof,
    semanticCommitment: input.semanticCommitment,
    sourceRevision: sourceHash,
    inputHash: sourceHash,
    outputHash,
    lineage: digest(`itotori.evidence-lineage.v2\0${sourceHash}`),
    reference: restricted
      ? input.request.privateArtifactReference
      : input.request.artifactReference,
    scanClasses: input.observation.scans,
  };
  let record: PublicEvidenceRecord | RestrictedEvidenceReceipt;
  if (input.request.privacyClass === "restricted") {
    const unsigned: Omit<RestrictedEvidenceReceipt, "signature"> = {
      schema: "itotori.restricted-local-evidence-receipt.v1",
      recordClass: "restricted-local-receipt",
      ...shared,
      privacyClass: "restricted",
      published: false,
      restrictedValuesWithheld: true,
      censusReference: input.request.censusReference,
    };
    record = {
      ...unsigned,
      signature: signBytes(
        null,
        Buffer.from(signedEvidencePayload(unsigned)),
        input.privateKey,
      ).toString("base64"),
    };
  } else if (input.request.privacyClass === "public-safe") {
    const unsigned: Omit<PublicEvidenceRecord, "signature"> = {
      schema: "itotori.public-portable-evidence.v1",
      recordClass: "public-evidence",
      ...shared,
      privacyClass: "public-safe",
      published,
      restrictedValuesWithheld: false,
    };
    record = {
      ...unsigned,
      signature: signBytes(
        null,
        Buffer.from(signedEvidencePayload(unsigned)),
        input.privateKey,
      ).toString("base64"),
    };
  } else throw new Error("evidence-producer-privacy-class-invalid");
  writeFileSync(
    safeWritePath(input.request.bundleRoot, input.request.recordReference),
    `${JSON.stringify(record)}\n`,
  );
}
