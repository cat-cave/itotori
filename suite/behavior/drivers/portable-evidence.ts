import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildEvidenceBundle } from "./evidence-bundle-builder.js";
import { digest, isRecord } from "./evidence-contract.js";
import { treeDigest } from "./evidence-portability.js";
import { producerImplementationBinding, productBuildDigest } from "./evidence-producer-support.js";
import type { AuditReceipt, FieldPopulation } from "./evidence-audit-types.js";

export interface EvidenceRequest {
  caseId: string;
  evidenceKind: string;
  sourceClass: string;
  privacyClass: string;
  contentCase: string;
  referenceKind: string;
  candidateRevision: string;
  repositoryRoot: string;
  workRoot: string;
}

export interface EvidenceObservation {
  auditOutcome: string;
  metadataComplete: boolean;
  freshResolution: boolean;
  independentProducer: boolean;
  copiedExpectationRejected: boolean;
  coherentLineage: boolean;
  deterministicDependents: boolean;
  tamperRejected: boolean;
  staleRevisionRejected: boolean;
  localLocationRejected: boolean;
  restrictedPublicationWithheld: boolean;
  observedFields: number;
  observedTotalFields: number;
}

const PRODUCT_SOURCE_PATHS = [
  "suite/behavior/product/managed-artifact-boundary.ts",
  "suite/behavior/product/evidence-scenario-projection.ts",
  "suite/behavior/product/evidence-expectation-scenario-boundary.ts",
  "suite/behavior/product/evidence-product-fixture.ts",
  "packages/itotori-db/src/managed-artifact-refs.ts",
  "packages/itotori-db/src/localization-artifact-integrity.ts",
  "packages/localization-bridge-schema/src/synthetic-large-project.ts",
  "packages/localization-bridge-schema/src/linecap-schema/patch-compatibility-validation.ts",
  "packages/localization-bridge-schema/src/linecap-schema/runtime-evidence-validation.ts",
  "apps/itotori/src/patchback/bind-scoped-targets.ts",
  "apps/itotori/src/patchback/build-patch-export.ts",
];

const EVALUATED_PRODUCER = fileURLToPath(
  new URL("./evidence-evaluated-producer-boundary.js", import.meta.url),
);
const EXPECTATION_PRODUCER = fileURLToPath(
  new URL("./evidence-expectation-producer-boundary.js", import.meta.url),
);
const EXPECTATION_SCENARIO_CLIENT = fileURLToPath(
  new URL("./evidence-expectation-scenario-client.js", import.meta.url),
);
const PRODUCER_SUPPORT = fileURLToPath(new URL("./evidence-producer-support.js", import.meta.url));
const AUDITOR_SCRIPT = fileURLToPath(new URL("./evidence-auditor-cli.js", import.meta.url));
const AUDITOR_MODULE = fileURLToPath(new URL("./evidence-auditor-boundary.js", import.meta.url));
const CONTRACT_SCRIPT = fileURLToPath(new URL("./evidence-contract.js", import.meta.url));
const PRODUCT_PROOF_KEYS_SCRIPT = fileURLToPath(
  new URL("./evidence-product-proof-keys.js", import.meta.url),
);
const PORTABILITY_SCRIPT = fileURLToPath(new URL("./evidence-portability.js", import.meta.url));
const LOCAL_CONTROLS_SCRIPT = fileURLToPath(
  new URL("./evidence-local-controls.js", import.meta.url),
);
const AUDIT_FACTS_SCRIPT = fileURLToPath(new URL("./evidence-audit-facts.js", import.meta.url));
const RESTRICTED_DETAILS_SCRIPT = fileURLToPath(
  new URL("./evidence-restricted-details.js", import.meta.url),
);
const SEMANTIC_OUTPUT_SCRIPT = fileURLToPath(
  new URL("./evidence-semantic-output.js", import.meta.url),
);
const PRODUCT_BOUNDARY = fileURLToPath(
  new URL("../product/suite/behavior/product/managed-artifact-boundary.js", import.meta.url),
);
function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label}-invalid`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label}-invalid`);
  return value;
}

function population(value: unknown): readonly FieldPopulation[] {
  if (!Array.isArray(value)) throw new Error("evidence-audit-population-invalid");
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`evidence-audit-population-${index}-invalid`);
    const field = text(entry.field, `evidence-audit-population-${index}-field`);
    const nonemptyCount = entry.nonemptyCount;
    const totalCount = entry.totalCount;
    if (
      typeof nonemptyCount !== "number" ||
      !Number.isInteger(nonemptyCount) ||
      nonemptyCount < 0 ||
      typeof totalCount !== "number" ||
      !Number.isInteger(totalCount) ||
      totalCount <= 0 ||
      nonemptyCount > totalCount
    )
      throw new Error(`evidence-audit-population-${index}-counts-invalid`);
    return { field, nonemptyCount, totalCount };
  });
}

function pairOfTexts(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length !== 2) throw new Error(`${label}-invalid`);
  return value.map((entry, index) => text(entry, `${label}-${index}`));
}

function dependencyDigests(value: unknown): {
  support: string;
  contract: string;
  portability: string;
} {
  if (!isRecord(value)) throw new Error("evidence-audit-dependency-digests-invalid");
  return {
    support: text(value.support, "evidence-audit-support-digest"),
    contract: text(value.contract, "evidence-audit-contract-digest"),
    portability: text(value.portability, "evidence-audit-portability-digest"),
  };
}

export function parseAuditReceipt(value: unknown): AuditReceipt {
  if (
    !isRecord(value) ||
    value.schema !== "itotori.portable-evidence-audit.v2" ||
    value.trustRole !== "local-candidate-contract" ||
    value.protectedAttestationPresent !== false
  )
    throw new Error("evidence-audit-receipt-invalid");
  return {
    schema: value.schema,
    caseId: text(value.caseId, "evidence-audit-case-id"),
    evidenceKind: text(value.evidenceKind, "evidence-audit-kind"),
    sourceClass: text(value.sourceClass, "evidence-audit-source-class"),
    privacyClass: text(value.privacyClass, "evidence-audit-privacy-class"),
    contentCase: text(value.contentCase, "evidence-audit-content-case"),
    referenceKind: text(value.referenceKind, "evidence-audit-reference-kind"),
    auditOutcome: text(value.auditOutcome, "evidence-audit-outcome"),
    metadataComplete: boolean(value.metadataComplete, "evidence-audit-metadata"),
    freshResolution: boolean(value.freshResolution, "evidence-audit-fresh"),
    independentProducer: boolean(value.independentProducer, "evidence-audit-independence"),
    copiedExpectationRejected: boolean(value.copiedExpectationRejected, "evidence-audit-copy"),
    coherentLineage: boolean(value.coherentLineage, "evidence-audit-lineage"),
    deterministicDependents: boolean(value.deterministicDependents, "evidence-audit-determinism"),
    tamperRejected: boolean(value.tamperRejected, "evidence-audit-tamper"),
    staleRevisionRejected: boolean(value.staleRevisionRejected, "evidence-audit-stale"),
    localLocationRejected: boolean(value.localLocationRejected, "evidence-audit-local"),
    restrictedPublicationWithheld: boolean(
      value.restrictedPublicationWithheld,
      "evidence-audit-withheld",
    ),
    trustRole: value.trustRole,
    protectedAttestationPresent: value.protectedAttestationPresent,
    fieldPopulation: population(value.fieldPopulation),
    bundleDigest: text(value.bundleDigest, "evidence-audit-bundle"),
    productSourceDigest: text(value.productSourceDigest, "evidence-audit-product-source"),
    productBuildDigest: text(value.productBuildDigest, "evidence-audit-product-build"),
    producerImplementationDigests: pairOfTexts(
      value.producerImplementationDigests,
      "evidence-audit-implementations",
    ),
    producerDependencyDigests: dependencyDigests(value.producerDependencyDigests),
    producerIdentities: pairOfTexts(value.producerIdentities, "evidence-audit-identities"),
    verifierRandomizedCommitment: text(
      value.verifierRandomizedCommitment,
      "evidence-audit-randomized-commitment",
    ),
  };
}

function copyVerifier(verifierRoot: string): void {
  mkdirSync(verifierRoot, { recursive: true });
  for (const path of [
    AUDITOR_SCRIPT,
    AUDITOR_MODULE,
    CONTRACT_SCRIPT,
    PRODUCT_PROOF_KEYS_SCRIPT,
    PORTABILITY_SCRIPT,
    LOCAL_CONTROLS_SCRIPT,
    AUDIT_FACTS_SCRIPT,
    RESTRICTED_DETAILS_SCRIPT,
    SEMANTIC_OUTPUT_SCRIPT,
    PRODUCER_SUPPORT,
    EVALUATED_PRODUCER,
    EXPECTATION_PRODUCER,
    EXPECTATION_SCENARIO_CLIENT,
  ])
    copyFileSync(path, resolve(verifierRoot, path.slice(dirname(path).length + 1)));
  const productRoot = resolve(dirname(PRODUCT_BOUNDARY), "../../..");
  cpSync(productRoot, resolve(verifierRoot, "product"), { recursive: true });
}

function auditFreshCopy(
  evidenceRoot: string,
  request: EvidenceRequest,
  productSourceDigest: string,
  productBuild: string,
): { receipt: AuditReceipt; digest: string } {
  const freshParent = mkdtempSync(join(tmpdir(), "behavior-evidence-"));
  const freshBundle = resolve(freshParent, "bundle");
  const verifierRoot = resolve(freshParent, "verifier");
  cpSync(evidenceRoot, freshBundle, { recursive: true, verbatimSymlinks: true });
  copyVerifier(verifierRoot);
  try {
    const freshCopyNonce = randomUUID();
    writeFileSync(resolve(verifierRoot, "fresh-copy-token"), `${freshCopyNonce}\n`);
    const result = spawnSync(
      process.execPath,
      [
        "evidence-auditor-cli.js",
        JSON.stringify({
          freshCopyNonce,
          expectedBuildRevision: request.candidateRevision,
          expectedProductSourceDigest: productSourceDigest,
          expectedProductBuildDigest: productBuild,
          caseId: request.caseId,
          evidenceKind: request.evidenceKind,
          sourceClass: request.sourceClass,
          privacyClass: request.privacyClass,
          contentCase: request.contentCase,
          referenceKind: request.referenceKind,
        }),
      ],
      { cwd: verifierRoot, encoding: "utf8" },
    );
    if (
      result.status !== 0 ||
      result.stderr !== "" ||
      !result.stdout.endsWith("\n") ||
      result.stdout.trimEnd().split("\n").length !== 1
    )
      throw new Error(
        `evidence-auditor-failed:${result.status ?? "no-status"}:${result.stderr.trim()}`,
      );
    const receipt = parseAuditReceipt(JSON.parse(result.stdout));
    const evaluated = producerImplementationBinding(EVALUATED_PRODUCER);
    const expectation = producerImplementationBinding(EXPECTATION_PRODUCER);
    if (
      receipt.bundleDigest !== treeDigest(freshBundle) ||
      receipt.productSourceDigest !== productSourceDigest ||
      receipt.productBuildDigest !== productBuild ||
      receipt.producerImplementationDigests[0] !== evaluated.implementationDigest ||
      receipt.producerImplementationDigests[1] !== expectation.implementationDigest ||
      receipt.producerDependencyDigests.support !== evaluated.supportDigest ||
      receipt.producerDependencyDigests.contract !== evaluated.contractDigest ||
      receipt.producerDependencyDigests.portability !== evaluated.portabilityDigest ||
      receipt.producerIdentities[0] === receipt.producerIdentities[1] ||
      !/^[a-f0-9]{64}$/u.test(receipt.verifierRandomizedCommitment) ||
      receipt.caseId !== request.caseId ||
      receipt.evidenceKind !== request.evidenceKind ||
      receipt.sourceClass !== request.sourceClass ||
      receipt.privacyClass !== request.privacyClass ||
      receipt.contentCase !== request.contentCase ||
      receipt.referenceKind !== request.referenceKind ||
      !receipt.restrictedPublicationWithheld
    )
      throw new Error("evidence-audit-trust-binding-invalid");
    return { receipt, digest: digest(JSON.stringify(receipt)) };
  } finally {
    rmSync(freshParent, { force: true, recursive: true });
  }
}

function emptyObservation(): EvidenceObservation {
  return {
    auditOutcome: "success",
    metadataComplete: false,
    freshResolution: false,
    independentProducer: false,
    copiedExpectationRejected: false,
    coherentLineage: false,
    deterministicDependents: false,
    tamperRejected: false,
    staleRevisionRejected: false,
    localLocationRejected: false,
    restrictedPublicationWithheld: false,
    observedFields: 0,
    observedTotalFields: 0,
  };
}

export function evidenceCaseRoot(workRoot: string, caseId: string): string {
  return resolve(workRoot, digest(caseId).slice(0, 20));
}

export function observeEvidence(
  request: EvidenceRequest,
  fixedSuccess: boolean,
): EvidenceObservation {
  if (fixedSuccess) return emptyObservation();
  const caseRoot = evidenceCaseRoot(request.workRoot, request.caseId);
  const evidenceRoot = resolve(caseRoot, "evidence-bundle");
  const inputRoot = resolve(caseRoot, "private-inputs");
  rmSync(caseRoot, { force: true, recursive: true });
  const productSourceDigest = digest(
    PRODUCT_SOURCE_PATHS.map(
      (path) => `${path}\0${digest(readFileSync(resolve(request.repositoryRoot, path)))}`,
    ).join("\n"),
  );
  const productBuild = productBuildDigest(PRODUCT_BOUNDARY);
  buildEvidenceBundle(
    evidenceRoot,
    inputRoot,
    {
      evaluatedProducerPath: EVALUATED_PRODUCER,
      expectationProducerPath: EXPECTATION_PRODUCER,
      productBoundaryPath: PRODUCT_BOUNDARY,
      productSourceDigest,
      productBuildDigest: productBuild,
    },
    request,
  );
  if (existsSync(inputRoot)) throw new Error("ephemeral-private-inputs-not-removed");
  const audited = auditFreshCopy(evidenceRoot, request, productSourceDigest, productBuild);
  const receiptPath = resolve(caseRoot, "audit-receipt.json");
  writeFileSync(
    receiptPath,
    `${JSON.stringify({ receipt: audited.receipt, receiptDigest: audited.digest })}\n`,
    "utf8",
  );
  const persisted: unknown = JSON.parse(readFileSync(receiptPath, "utf8"));
  if (
    !isRecord(persisted) ||
    persisted.receiptDigest !== audited.digest ||
    digest(JSON.stringify(persisted.receipt)) !== audited.digest
  )
    throw new Error("evidence-audit-receipt-persistence-invalid");
  const restricted = request.privacyClass === "restricted";
  const observedFields = restricted
    ? audited.receipt.metadataComplete && audited.receipt.restrictedPublicationWithheld
      ? 1
      : 0
    : audited.receipt.fieldPopulation.reduce((total, field) => total + field.nonemptyCount, 0);
  const observedTotalFields = restricted
    ? 1
    : audited.receipt.fieldPopulation.reduce((total, field) => total + field.totalCount, 0);
  return {
    auditOutcome: audited.receipt.auditOutcome,
    metadataComplete: audited.receipt.metadataComplete && observedFields === observedTotalFields,
    freshResolution: audited.receipt.freshResolution,
    independentProducer: audited.receipt.independentProducer,
    copiedExpectationRejected: audited.receipt.copiedExpectationRejected,
    coherentLineage: audited.receipt.coherentLineage,
    deterministicDependents: audited.receipt.deterministicDependents,
    tamperRejected: audited.receipt.tamperRejected,
    staleRevisionRejected: audited.receipt.staleRevisionRejected,
    localLocationRejected: audited.receipt.localLocationRejected,
    restrictedPublicationWithheld: audited.receipt.restrictedPublicationWithheld,
    observedFields,
    observedTotalFields,
  };
}
