import { createHash, verify as verifyBytes } from "node:crypto";

import { assertExactProductProofKeys } from "./evidence-product-proof-keys.js";

export type ProducerRole = "evaluated" | "expectation" | "unaffected";
export type SourceKind =
  | "tracked-production-source"
  | "synthetic-public-source"
  | "evaluated-output-copy";

export interface ProductRequest {
  artifactClass: "corpus_sidecar" | "benchmark";
  scopeId: string;
  artifactId: string;
  artifactKind:
    | "corpus_manifest"
    | "structure_index"
    | "scan_report"
    | "benchmark_seed"
    | "benchmark_report"
    | "benchmark_system_output";
  publicContent: boolean;
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

export interface ProductProof extends ProductRequest {
  schema: "itotori.managed-artifact-product-proof.v1";
  publishedRef: Record<string, unknown>;
  scopePrefix: string;
  cleanupDecisions: readonly string[];
  identityChangeChangesHash: boolean;
  scenarioOutput: Record<string, unknown>;
  uriNegativeControlsRejected: boolean;
}

export interface LocalEvidenceChecks {
  sourceMatchesCurrent: boolean;
  sourceMatchesPairAnchor: boolean;
  sourceSafe: boolean;
  deterministicRepeat: boolean;
  changedDependent: boolean;
  unaffectedStable: boolean;
}

interface EvidenceRecordCommon {
  role: ProducerRole;
  caseId: string;
  scope: string;
  producer: string;
  producerImplementationDigest: string;
  publicKey: string;
  invocationId: string;
  buildRevision: string;
  sourceKind: SourceKind;
  sourceClass: string;
  evidenceKind: string;
  privacyClass: string;
  outcome: string;
  referenceKind: string;
  safe: boolean;
  published: boolean;
  localFactsVerified: boolean;
  restrictedValuesWithheld: boolean;
  trustRole: "local-candidate-contract";
  protectedAttestationPresent: false;
  localChecks: LocalEvidenceChecks;
  productSourceDigest: string;
  productBuildDigest: string;
  productProof: ProductProof;
  semanticCommitment: string;
  sourceRevision: string;
  inputHash: string;
  outputHash: string;
  lineage: string;
  reference: string;
  scanClasses: readonly string[];
  signature: string;
}

export interface PublicEvidenceRecord extends EvidenceRecordCommon {
  schema: "itotori.public-portable-evidence.v1";
  recordClass: "public-evidence";
  privacyClass: "public-safe";
}

export interface RestrictedEvidenceReceipt extends EvidenceRecordCommon {
  schema: "itotori.restricted-local-evidence-receipt.v1";
  recordClass: "restricted-local-receipt";
  privacyClass: "restricted";
  published: false;
  censusReference: string;
}

export type EvidenceRecord = PublicEvidenceRecord | RestrictedEvidenceReceipt;
export type UnsignedEvidenceRecord =
  | Omit<PublicEvidenceRecord, "signature">
  | Omit<RestrictedEvidenceReceipt, "signature">;

export interface ProducerRequest {
  role: ProducerRole;
  caseId: string;
  scope: string;
  sourceLabel: string;
  sourceKind: SourceKind;
  bundleRoot: string;
  inputRoot: string;
  inputReference: string;
  currentInputReference: string;
  pairAnchorReference: string;
  peerInputReference: string;
  alternateInputReference: string;
  unaffectedInputReference: string;
  censusReference: string;
  privateArtifactReference: string;
  artifactReference: string;
  recordReference: string;
  buildRevision: string;
  evidenceKind: string;
  contentCase: string;
  sourceClass: string;
  privacyClass: string;
  referenceKind: string;
  productBoundaryPath: string;
  productSourceDigest: string;
  productBuildDigest: string;
}

const PUBLIC_KEYS: Readonly<Record<ProducerRole, string>> = {
  evaluated:
    "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAP6dAGj7RpVKHM4uicvqZLSo1mQKgWKVkoIBZ3oFWyhA=\n-----END PUBLIC KEY-----\n",
  expectation:
    "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAe/xbe2DUrKKvYgpls/LdJ1hWrwWfpwsvzkZdAj2ZFZ8=\n-----END PUBLIC KEY-----\n",
  unaffected:
    "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAzv0t5OycoSMuGBrUOeRI7LBlW9WfbIeXFU72OxqUFZI=\n-----END PUBLIC KEY-----\n",
};

const COMMON_KEYS = [
  "role",
  "caseId",
  "scope",
  "producer",
  "producerImplementationDigest",
  "publicKey",
  "invocationId",
  "buildRevision",
  "sourceKind",
  "sourceClass",
  "evidenceKind",
  "privacyClass",
  "outcome",
  "referenceKind",
  "safe",
  "published",
  "localFactsVerified",
  "restrictedValuesWithheld",
  "trustRole",
  "protectedAttestationPresent",
  "localChecks",
  "productSourceDigest",
  "productBuildDigest",
  "productProof",
  "semanticCommitment",
  "sourceRevision",
  "inputHash",
  "outputHash",
  "lineage",
  "reference",
  "scanClasses",
  "signature",
];

export function digest(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label}-invalid`);
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label}-invalid`);
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).toSorted();
  const sortedExpected = [...expected].toSorted();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error(`${label}-keys-invalid`);
  }
}

function role(value: unknown): ProducerRole {
  if (value === "evaluated" || value === "expectation" || value === "unaffected") return value;
  throw new Error("evidence-role-invalid");
}

function sourceKind(value: unknown): SourceKind {
  if (
    value === "tracked-production-source" ||
    value === "synthetic-public-source" ||
    value === "evaluated-output-copy"
  )
    return value;
  throw new Error("evidence-source-kind-invalid");
}

function strings(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
    throw new Error(`${label}-invalid`);
  return value.filter((entry): entry is string => typeof entry === "string");
}

function artifactKind(value: unknown): ProductProof["artifactKind"] {
  if (
    value === "corpus_manifest" ||
    value === "structure_index" ||
    value === "scan_report" ||
    value === "benchmark_seed" ||
    value === "benchmark_report" ||
    value === "benchmark_system_output"
  )
    return value;
  throw new Error("evidence-product-kind-invalid");
}

function localChecks(value: unknown): LocalEvidenceChecks {
  if (!isRecord(value)) throw new Error("evidence-local-checks-invalid");
  exactKeys(
    value,
    [
      "sourceMatchesCurrent",
      "sourceMatchesPairAnchor",
      "sourceSafe",
      "deterministicRepeat",
      "changedDependent",
      "unaffectedStable",
    ],
    "evidence-local-checks",
  );
  return {
    sourceMatchesCurrent: boolean(value.sourceMatchesCurrent, "source-matches-current"),
    sourceMatchesPairAnchor: boolean(value.sourceMatchesPairAnchor, "source-matches-anchor"),
    sourceSafe: boolean(value.sourceSafe, "source-safe"),
    deterministicRepeat: boolean(value.deterministicRepeat, "deterministic-repeat"),
    changedDependent: boolean(value.changedDependent, "changed-dependent"),
    unaffectedStable: boolean(value.unaffectedStable, "unaffected-stable"),
  };
}

export function publicKeyForRole(value: ProducerRole): string {
  return PUBLIC_KEYS[value];
}

export function producerIdentity(
  value: ProducerRole,
  implementationDigest: string,
  publicKey: string,
): string {
  return digest(
    `itotori.portable-evidence-producer.v3\0${value}\0${implementationDigest}\0${publicKey}`,
  );
}

export function productRequest(input: {
  caseId: string;
  scope: string;
  role: ProducerRole;
  evidenceKind: string;
  privacyClass: string;
  safe: boolean;
  contentCase: string;
  sourceRevision: string;
  currentRevision: string;
  anchorRevision: string;
  peerRevision: string;
  alternateRevision: string;
  unaffectedRevision: string;
  scanClasses: readonly string[];
}): ProductRequest {
  const corpus = ["patch receipt", "compatibility proof", "runtime observation"].includes(
    input.evidenceKind,
  );
  const identity = digest(`${input.caseId}\0${input.scope}\0${input.role}`).slice(0, 24);
  if (corpus)
    return {
      artifactClass: "corpus_sidecar",
      scopeId: digest(input.caseId).slice(0, 20),
      artifactId: identity,
      artifactKind:
        input.evidenceKind === "patch receipt"
          ? "corpus_manifest"
          : input.evidenceKind === "compatibility proof"
            ? "structure_index"
            : "scan_report",
      publicContent: input.safe && input.privacyClass === "public-safe",
      evidenceKind: input.evidenceKind,
      contentCase: input.contentCase,
      sourceRevision: input.sourceRevision,
      currentRevision: input.currentRevision,
      anchorRevision: input.anchorRevision,
      peerRevision: input.peerRevision,
      alternateRevision: input.alternateRevision,
      unaffectedRevision: input.unaffectedRevision,
      scanClasses: input.scanClasses,
    };
  return {
    artifactClass: "benchmark",
    scopeId: digest(input.caseId).slice(0, 20),
    artifactId: identity,
    artifactKind:
      input.evidenceKind === "independent comparison"
        ? "benchmark_system_output"
        : "benchmark_report",
    publicContent: input.safe && input.privacyClass === "public-safe",
    evidenceKind: input.evidenceKind,
    contentCase: input.contentCase,
    sourceRevision: input.sourceRevision,
    currentRevision: input.currentRevision,
    anchorRevision: input.anchorRevision,
    peerRevision: input.peerRevision,
    alternateRevision: input.alternateRevision,
    unaffectedRevision: input.unaffectedRevision,
    scanClasses: input.scanClasses,
  };
}

export function parseProductProof(value: unknown): ProductProof {
  if (
    !isRecord(value) ||
    value.schema !== "itotori.managed-artifact-product-proof.v1" ||
    !isRecord(value.publishedRef) ||
    !isRecord(value.scenarioOutput)
  )
    throw new Error("evidence-product-proof-invalid");
  assertExactProductProofKeys(value);
  const artifactClass = text(value.artifactClass, "evidence-product-class");
  if (artifactClass !== "corpus_sidecar" && artifactClass !== "benchmark")
    throw new Error("evidence-product-class-invalid");
  if (
    typeof value.publicContent !== "boolean" ||
    typeof value.identityChangeChangesHash !== "boolean" ||
    typeof value.uriNegativeControlsRejected !== "boolean"
  )
    throw new Error("evidence-product-proof-invalid");
  return {
    schema: value.schema,
    artifactClass,
    scopeId: text(value.scopeId, "evidence-product-scope"),
    artifactId: text(value.artifactId, "evidence-product-id"),
    artifactKind: artifactKind(value.artifactKind),
    publicContent: value.publicContent,
    evidenceKind: text(value.evidenceKind, "evidence-product-evidence-kind"),
    contentCase: text(value.contentCase, "evidence-product-content-case"),
    sourceRevision: text(value.sourceRevision, "evidence-product-source-revision"),
    currentRevision: text(value.currentRevision, "evidence-product-current-revision"),
    anchorRevision: text(value.anchorRevision, "evidence-product-anchor-revision"),
    peerRevision: text(value.peerRevision, "evidence-product-peer-revision"),
    alternateRevision: text(value.alternateRevision, "evidence-product-alternate-revision"),
    unaffectedRevision: text(value.unaffectedRevision, "evidence-product-unaffected-revision"),
    scanClasses: strings(value.scanClasses, "evidence-product-scan-classes"),
    publishedRef: value.publishedRef,
    scopePrefix: text(value.scopePrefix, "evidence-product-prefix"),
    cleanupDecisions: strings(value.cleanupDecisions, "evidence-product-cleanup"),
    identityChangeChangesHash: value.identityChangeChangesHash,
    scenarioOutput: value.scenarioOutput,
    uriNegativeControlsRejected: value.uriNegativeControlsRejected,
  };
}

function common(value: Record<string, unknown>) {
  if (value.trustRole !== "local-candidate-contract" || value.protectedAttestationPresent !== false)
    throw new Error("evidence-trust-invalid");
  const privacyClass = text(value.privacyClass, "evidence-privacy");
  const trustRole: "local-candidate-contract" = "local-candidate-contract";
  const protectedAttestationPresent: false = false;
  return {
    role: role(value.role),
    caseId: text(value.caseId, "evidence-case"),
    scope: text(value.scope, "evidence-scope"),
    producer: text(value.producer, "evidence-producer"),
    producerImplementationDigest: text(
      value.producerImplementationDigest,
      "evidence-producer-digest",
    ),
    publicKey: text(value.publicKey, "evidence-public-key"),
    invocationId: text(value.invocationId, "evidence-invocation"),
    buildRevision: text(value.buildRevision, "evidence-build"),
    sourceKind: sourceKind(value.sourceKind),
    sourceClass: text(value.sourceClass, "evidence-source-class"),
    evidenceKind: text(value.evidenceKind, "evidence-kind"),
    privacyClass,
    outcome: text(value.outcome, "evidence-outcome"),
    referenceKind: text(value.referenceKind, "evidence-reference-kind"),
    safe: boolean(value.safe, "evidence-safe"),
    published: boolean(value.published, "evidence-published"),
    localFactsVerified: boolean(value.localFactsVerified, "evidence-local-facts"),
    restrictedValuesWithheld: boolean(value.restrictedValuesWithheld, "evidence-withheld"),
    trustRole,
    protectedAttestationPresent,
    localChecks: localChecks(value.localChecks),
    productSourceDigest: text(value.productSourceDigest, "evidence-product-source"),
    productBuildDigest: text(value.productBuildDigest, "evidence-product-build"),
    productProof: parseProductProof(value.productProof),
    semanticCommitment: text(value.semanticCommitment, "evidence-semantic-commitment"),
    sourceRevision: text(value.sourceRevision, "evidence-source-revision"),
    inputHash: text(value.inputHash, "evidence-input-hash"),
    outputHash: text(value.outputHash, "evidence-output-hash"),
    lineage: text(value.lineage, "evidence-lineage"),
    reference: text(value.reference, "evidence-reference"),
    scanClasses: strings(value.scanClasses, "evidence-scan-classes"),
    signature: text(value.signature, "evidence-signature"),
  };
}

export function signedEvidencePayload(record: UnsignedEvidenceRecord): string {
  function stable(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    const item = isRecord(value) ? value : {};
    return `{${Object.keys(item)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${stable(item[key])}`)
      .join(",")}}`;
  }
  return stable(record);
}

export function parseEvidenceRecord(value: unknown): EvidenceRecord {
  if (!isRecord(value)) throw new Error("evidence-record-not-object");
  const parsed = common(value);
  if (value.schema === "itotori.restricted-local-evidence-receipt.v1") {
    exactKeys(
      value,
      ["schema", "recordClass", ...COMMON_KEYS, "censusReference"],
      "restricted-evidence-record",
    );
    if (
      value.recordClass !== "restricted-local-receipt" ||
      parsed.privacyClass !== "restricted" ||
      parsed.published ||
      !parsed.restrictedValuesWithheld
    )
      throw new Error("restricted-evidence-record-invalid");
    return {
      schema: value.schema,
      recordClass: value.recordClass,
      ...parsed,
      privacyClass: "restricted",
      published: false,
      censusReference: text(value.censusReference, "evidence-census-reference"),
    };
  }
  if (value.schema !== "itotori.public-portable-evidence.v1")
    throw new Error("evidence-schema-invalid");
  exactKeys(value, ["schema", "recordClass", ...COMMON_KEYS], "public-evidence-record");
  if (
    value.recordClass !== "public-evidence" ||
    parsed.privacyClass !== "public-safe" ||
    parsed.restrictedValuesWithheld
  )
    throw new Error("public-evidence-record-invalid");
  return {
    schema: value.schema,
    recordClass: value.recordClass,
    ...parsed,
    privacyClass: "public-safe",
  };
}

export function verifyEvidenceSignature(record: EvidenceRecord): boolean {
  const { signature, ...unsigned } = record;
  return verifyBytes(
    null,
    Buffer.from(signedEvidencePayload(unsigned)),
    record.publicKey,
    Buffer.from(signature, "base64"),
  );
}
