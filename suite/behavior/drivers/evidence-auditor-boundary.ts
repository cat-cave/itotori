import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  digest,
  isRecord,
  parseEvidenceRecord,
  producerIdentity,
  productRequest,
  publicKeyForRole,
  verifyEvidenceSignature,
  type EvidenceRecord,
  type ProducerRole,
  type PublicEvidenceRecord,
} from "./evidence-contract.js";
import {
  expectedReferenceKind,
  portableFile,
  portableReferenceSyntax,
  publishableTreeIsSafe,
  referenceHasExpectedKind,
  scanForbiddenClasses,
  treeDigest,
} from "./evidence-portability.js";
import { verifyIsolatedLocalControls } from "./evidence-local-controls.js";
import { publicPopulation, randomizedFactCommitment } from "./evidence-audit-facts.js";
import { restrictedDetailsAreValid } from "./evidence-restricted-details.js";
import { resolveSemanticOutput } from "./evidence-semantic-output.js";
import {
  producerImplementationBinding,
  productBuildDigest,
  runProductBoundary,
} from "./evidence-producer-support.js";
import type { AuditOptions, AuditReceipt, FieldPopulation } from "./evidence-audit-types.js";

export type { AuditOptions, AuditReceipt, FieldPopulation } from "./evidence-audit-types.js";
type ResolutionReason =
  | "valid"
  | "unsafe"
  | "stale"
  | "mixed-lineage"
  | "local-reference"
  | "hash-mismatch"
  | "signature-invalid"
  | "producer-not-independent"
  | "expectation-copied"
  | "reference-kind-mismatch"
  | "source-invalid"
  | "unsafe-publication"
  | "product-proof-invalid"
  | "semantic-output-invalid"
  | "semantic-output-mismatch";

interface PairReference {
  evaluated: string;
  expectation: string;
}
type RecordResolution =
  | { valid: true; record: EvidenceRecord }
  | { valid: false; reason: ResolutionReason };
interface PairResolution {
  reason: ResolutionReason;
  evaluated?: EvidenceRecord;
  expectation?: EvidenceRecord;
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label}-invalid`);
  return value;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).toSorted();
  const expected = [...keys].toSorted();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    throw new Error(`${label}-keys-invalid`);
}

function pairReference(value: unknown, label: string): PairReference {
  if (!isRecord(value)) throw new Error(`${label}-invalid`);
  exactKeys(value, ["evaluated", "expectation"], label);
  return {
    evaluated: text(value.evaluated, `${label}-evaluated`),
    expectation: text(value.expectation, `${label}-expectation`),
  };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = isRecord(value) ? value : {};
  return `{${Object.keys(record)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function withoutScenario(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "scenarioOutput"));
}

function validProductProof(record: EvidenceRecord, options: AuditOptions): boolean {
  if (
    record.productSourceDigest !== options.expectedProductSourceDigest ||
    record.productBuildDigest !== options.expectedProductBuildDigest ||
    productBuildDigest(options.productBoundaryPath) !== options.expectedProductBuildDigest ||
    record.productProof.evidenceKind !== options.evidenceKind ||
    record.productProof.contentCase !== options.contentCase ||
    record.productProof.sourceRevision !== record.sourceRevision ||
    record.productProof.scanClasses.join("\0") !== record.scanClasses.join("\0")
  )
    return false;
  const request = productRequest({
    caseId: record.caseId,
    scope: record.scope,
    role: record.role,
    evidenceKind: record.evidenceKind,
    privacyClass: record.privacyClass,
    safe: record.safe,
    contentCase: options.contentCase,
    sourceRevision: record.productProof.sourceRevision,
    currentRevision: record.productProof.currentRevision,
    anchorRevision: record.productProof.anchorRevision,
    peerRevision: record.productProof.peerRevision,
    alternateRevision: record.productProof.alternateRevision,
    unaffectedRevision: record.productProof.unaffectedRevision,
    scanClasses: record.scanClasses,
  });
  let actual;
  try {
    actual = runProductBoundary(options.productBoundaryPath, request);
  } catch {
    return false;
  }
  if (
    stableJson(withoutScenario(actual)) !== stableJson(withoutScenario(record.productProof)) ||
    (record.role === "evaluated" &&
      stableJson(actual.scenarioOutput) !== stableJson(record.productProof.scenarioOutput))
  )
    return false;
  if (
    !actual.uriNegativeControlsRejected ||
    actual.cleanupDecisions.join("\0") !==
      "retained\0deletable\0out_of_scope\0protected_source\0out_of_scope"
  )
    return false;
  if (record.privacyClass === "restricted") {
    return (
      actual.publicContent === false &&
      actual.publishedRef.uri === "[redacted-private-local-artifact]" &&
      !("hash" in actual.publishedRef)
    );
  }
  return actual.publicContent === record.safe;
}

function publicResolution(
  bundleRoot: string,
  record: PublicEvidenceRecord,
): ResolutionReason | null {
  if (
    !/^[a-f0-9]{64}$/u.test(record.sourceRevision) ||
    record.inputHash !== record.sourceRevision ||
    record.lineage !== digest(`itotori.evidence-lineage.v2\0${record.inputHash}`) ||
    record.safe !== (record.scanClasses.length === 0)
  )
    return "source-invalid";
  if (!portableReferenceSyntax(record.reference)) return "local-reference";
  if (!referenceHasExpectedKind(record.reference, record.referenceKind))
    return "reference-kind-mismatch";
  if (!record.published) {
    if (
      record.safe ||
      record.outcome !== "publication-refused" ||
      record.outputHash !== digest(Buffer.alloc(0)) ||
      existsSync(resolve(bundleRoot, record.reference))
    )
      return "unsafe-publication";
    return null;
  }
  if (!record.safe || record.outcome === "publication-refused") return "unsafe-publication";
  const path = portableFile(bundleRoot, record.reference);
  if (path === null) return "local-reference";
  const output = readFileSync(path);
  if (digest(output) !== record.outputHash) return "hash-mismatch";
  return scanForbiddenClasses(output).length === 0 ? null : "unsafe-publication";
}

function recordResolution(
  options: AuditOptions,
  reference: string,
  expectedRole: ProducerRole,
  implementationDigest: string,
): RecordResolution {
  const path = portableFile(options.bundleRoot, reference);
  if (path === null) return { valid: false, reason: "local-reference" };
  let record: EvidenceRecord;
  try {
    record = parseEvidenceRecord(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return { valid: false, reason: "signature-invalid" };
  }
  const trustedKey = publicKeyForRole(expectedRole);
  if (
    record.role !== expectedRole ||
    record.publicKey !== trustedKey ||
    record.producerImplementationDigest !== implementationDigest ||
    record.producer !== producerIdentity(expectedRole, implementationDigest, trustedKey) ||
    record.buildRevision !== options.expectedBuildRevision ||
    record.caseId !== options.caseId ||
    !record.localFactsVerified ||
    record.safe !== record.localChecks.sourceSafe
  )
    return { valid: false, reason: "signature-invalid" };
  try {
    if (!verifyEvidenceSignature(record)) return { valid: false, reason: "signature-invalid" };
  } catch {
    return { valid: false, reason: "signature-invalid" };
  }
  if (!validProductProof(record, options)) return { valid: false, reason: "product-proof-invalid" };
  const requiredKind = expectedReferenceKind(record.evidenceKind);
  if (requiredKind === null || record.referenceKind !== requiredKind)
    return { valid: false, reason: "reference-kind-mismatch" };
  if (record.recordClass === "restricted-local-receipt") {
    if (
      record.published ||
      !record.restrictedValuesWithheld ||
      record.productProof.publicContent ||
      !restrictedDetailsAreValid(options.bundleRoot, record)
    )
      return { valid: false, reason: "unsafe-publication" };
  } else {
    const reason = publicResolution(options.bundleRoot, record);
    if (reason !== null) return { valid: false, reason };
  }
  return { valid: true, record };
}

function pairResolution(
  options: AuditOptions,
  pair: PairReference,
  evaluatedDigest: string,
  expectationDigest: string,
): PairResolution {
  const evaluated = recordResolution(options, pair.evaluated, "evaluated", evaluatedDigest);
  if (!evaluated.valid) return { reason: evaluated.reason };
  const expectation = recordResolution(options, pair.expectation, "expectation", expectationDigest);
  if (!expectation.valid) return { reason: expectation.reason, evaluated: evaluated.record };
  const left = evaluated.record;
  const right = expectation.record;
  const records = { evaluated: left, expectation: right };
  if (
    left.producer === right.producer ||
    left.invocationId === right.invocationId ||
    evaluatedDigest === expectationDigest
  )
    return { reason: "producer-not-independent", ...records };
  if (
    left.evidenceKind !== right.evidenceKind ||
    left.sourceClass !== right.sourceClass ||
    left.privacyClass !== right.privacyClass ||
    left.referenceKind !== right.referenceKind
  )
    return { reason: "reference-kind-mismatch", ...records };
  if (right.sourceKind === "evaluated-output-copy")
    return { reason: "expectation-copied", ...records };
  if (
    left.productProof.peerRevision !== right.sourceRevision ||
    right.productProof.peerRevision !== left.sourceRevision ||
    left.productProof.currentRevision !== right.productProof.currentRevision ||
    left.productProof.anchorRevision !== right.productProof.anchorRevision ||
    left.productProof.unaffectedRevision !== right.productProof.unaffectedRevision
  )
    return { reason: "semantic-output-mismatch", ...records };
  const leftSemantic = resolveSemanticOutput(options.bundleRoot, left);
  const rightSemantic = resolveSemanticOutput(options.bundleRoot, right);
  if (!leftSemantic.valid || !rightSemantic.valid)
    return { reason: "semantic-output-invalid", ...records };
  if (leftSemantic.commitment !== rightSemantic.commitment) {
    return { reason: "semantic-output-mismatch", ...records };
  }
  if (!left.localChecks.sourceMatchesPairAnchor || !right.localChecks.sourceMatchesPairAnchor)
    return { reason: "mixed-lineage", ...records };
  if (!left.localChecks.sourceMatchesCurrent || !right.localChecks.sourceMatchesCurrent)
    return { reason: "stale", ...records };
  if (!left.safe || !right.safe)
    return left.safe === right.safe
      ? { reason: "unsafe", ...records }
      : { reason: "unsafe-publication", ...records };
  return { reason: "valid", ...records };
}

function auditOutcome(resolution: PairResolution): string {
  if (resolution.reason === "unsafe") return "rejected as unsafe";
  if (resolution.reason === "stale") return "invalid hash mismatch";
  if (resolution.reason === "mixed-lineage") return "rejected as mixed lineage";
  if (resolution.reason !== "valid" || resolution.evaluated === undefined)
    return "evidence invalid";
  const kind = resolution.evaluated.evidenceKind;
  if (kind === "independent comparison") return "separate producer identities resolve";
  if (kind === "coherent evidence set") return "the complete coherent set resolves";
  if (kind === "regenerated evidence set")
    return "every dependent hash changes deterministically or stays identical when unaffected";
  return resolution.evaluated.sourceClass === "synthetic input"
    ? "synthetic evidence resolves"
    : "exact evidence resolves";
}

function exactBinding(parsed: Record<string, unknown>, options: AuditOptions): boolean {
  return (
    parsed.caseId === options.caseId &&
    parsed.evidenceKind === options.evidenceKind &&
    parsed.sourceClass === options.sourceClass &&
    parsed.privacyClass === options.privacyClass &&
    parsed.contentCase === options.contentCase &&
    parsed.referenceKind === options.referenceKind &&
    parsed.candidateRevision === options.expectedBuildRevision &&
    parsed.trustRole === "local-candidate-contract" &&
    parsed.protectedAttestationPresent === false &&
    parsed.productSourceDigest === options.expectedProductSourceDigest &&
    parsed.productBuildDigest === options.expectedProductBuildDigest &&
    parsed.ephemeralFactsVerified === true
  );
}

export function auditCopiedEvidenceBundle(options: AuditOptions): AuditReceipt {
  if (!publishableTreeIsSafe(options.bundleRoot)) throw new Error("evidence-bundle-unsafe-tree");
  const path = portableFile(options.bundleRoot, "manifest.json");
  if (path === null) throw new Error("evidence-bundle-manifest-missing");
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    !isRecord(parsed) ||
    parsed.schema !== "itotori.portable-evidence-bundle.v2" ||
    !isRecord(parsed.controls)
  )
    throw new Error("evidence-bundle-binding-invalid");
  exactKeys(
    parsed,
    [
      "schema",
      "caseId",
      "candidateRevision",
      "evidenceKind",
      "sourceClass",
      "privacyClass",
      "contentCase",
      "referenceKind",
      "trustRole",
      "protectedAttestationPresent",
      "productSourceDigest",
      "productBuildDigest",
      "ephemeralFactsVerified",
      "main",
      "controls",
    ],
    "evidence-bundle",
  );
  if (!exactBinding(parsed, options)) throw new Error("evidence-bundle-binding-invalid");
  const evaluated = producerImplementationBinding(options.evaluatedProducerImplementationPath);
  const expectation = producerImplementationBinding(options.expectationProducerImplementationPath);
  if (
    evaluated.supportDigest !== expectation.supportDigest ||
    evaluated.contractDigest !== expectation.contractDigest ||
    evaluated.portabilityDigest !== expectation.portabilityDigest
  )
    throw new Error("producer-dependency-binding-invalid");
  const main = pairResolution(
    options,
    pairReference(parsed.main, "main"),
    evaluated.implementationDigest,
    expectation.implementationDigest,
  );
  if (main.reason === "semantic-output-mismatch")
    throw new Error("main-evidence-semantic-output-mismatch");
  if (main.reason === "semantic-output-invalid")
    throw new Error("main-evidence-semantic-output-invalid");
  if (main.evaluated === undefined || main.expectation === undefined)
    throw new Error(`main-evidence-unreadable:${main.reason}`);
  if (
    main.evaluated.evidenceKind !== options.evidenceKind ||
    main.evaluated.sourceClass !== options.sourceClass ||
    main.evaluated.privacyClass !== options.privacyClass ||
    main.evaluated.referenceKind !== options.referenceKind
  )
    throw new Error("main-evidence-binding-invalid");
  const expectedSourceKind =
    options.sourceClass === "synthetic input"
      ? "synthetic-public-source"
      : "tracked-production-source";
  if (
    main.evaluated.sourceKind !== expectedSourceKind ||
    main.expectation.sourceKind !== expectedSourceKind
  )
    throw new Error("main-evidence-source-provenance-invalid");
  const copied = pairResolution(
    options,
    pairReference(parsed.controls.copied, "copied"),
    evaluated.implementationDigest,
    expectation.implementationDigest,
  );
  const tampered = pairResolution(
    options,
    pairReference(parsed.controls.tampered, "tampered"),
    evaluated.implementationDigest,
    expectation.implementationDigest,
  );
  const stale = pairResolution(
    options,
    pairReference(parsed.controls.stale, "stale"),
    evaluated.implementationDigest,
    expectation.implementationDigest,
  );
  const expectedLocalKinds = ["absolute", "scheme", "dot-segment", "backslash", "drive", "symlink"];
  if (
    !Array.isArray(parsed.controls.localKinds) ||
    parsed.controls.localKinds.join("\0") !== expectedLocalKinds.join("\0")
  )
    throw new Error("local-control-declaration-invalid");
  const localMetadataComplete =
    main.evaluated.localFactsVerified && main.expectation.localFactsVerified;
  // Private population counts never cross the publication boundary. Restricted
  // censuses remain only in the ephemeral bundle through this fresh audit.
  const fieldPopulation =
    options.privacyClass === "restricted" ? [] : publicPopulation(main.evaluated, main.expectation);
  const deterministic = [main.evaluated, main.expectation].every(
    ({ localChecks }) =>
      localChecks.deterministicRepeat &&
      localChecks.changedDependent &&
      localChecks.unaffectedStable,
  );
  return {
    schema: "itotori.portable-evidence-audit.v2",
    caseId: options.caseId,
    evidenceKind: options.evidenceKind,
    sourceClass: options.sourceClass,
    privacyClass: options.privacyClass,
    contentCase: options.contentCase,
    referenceKind: options.referenceKind,
    auditOutcome: auditOutcome(main),
    metadataComplete:
      localMetadataComplete &&
      fieldPopulation.every(({ nonemptyCount, totalCount }) => nonemptyCount === totalCount),
    freshResolution: false,
    independentProducer:
      main.evaluated.producer !== main.expectation.producer &&
      main.evaluated.invocationId !== main.expectation.invocationId &&
      evaluated.implementationDigest !== expectation.implementationDigest,
    copiedExpectationRejected: copied.reason === "expectation-copied",
    coherentLineage:
      main.reason === "mixed-lineage" ||
      (main.evaluated.localChecks.sourceMatchesPairAnchor &&
        main.expectation.localChecks.sourceMatchesPairAnchor),
    deterministicDependents: deterministic,
    tamperRejected: tampered.reason === "signature-invalid",
    staleRevisionRejected: stale.reason === "stale",
    localLocationRejected: verifyIsolatedLocalControls(),
    restrictedPublicationWithheld:
      options.privacyClass !== "restricted" ||
      [main.evaluated, main.expectation].every(
        (record) => record.recordClass === "restricted-local-receipt" && !record.published,
      ),
    trustRole: "local-candidate-contract",
    protectedAttestationPresent: false,
    fieldPopulation,
    bundleDigest: treeDigest(options.bundleRoot),
    productSourceDigest: options.expectedProductSourceDigest,
    productBuildDigest: options.expectedProductBuildDigest,
    producerImplementationDigests: [
      evaluated.implementationDigest,
      expectation.implementationDigest,
    ],
    producerDependencyDigests: {
      support: evaluated.supportDigest,
      contract: evaluated.contractDigest,
      portability: evaluated.portabilityDigest,
    },
    producerIdentities: [main.evaluated.producer, main.expectation.producer],
    verifierRandomizedCommitment: randomizedFactCommitment(
      options.bundleRoot,
      stableJson({ main, copied, tampered, stale }),
    ),
  };
}
