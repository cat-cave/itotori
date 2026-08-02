import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import { canonicalDigest } from "./build-cell-report.mjs";
import {
  assertExactBundleLayout,
  namesBelow,
  portableEvidenceTreeDigest,
  readJson,
  requiredType,
} from "./portable-evidence-layout.mjs";
import {
  projectionDocument,
  restrictedProjectionEntry,
  validateProjection,
} from "./portable-evidence-projection.mjs";
import { behaviorCells } from "./behavior-cell-registry.mjs";

export { portableEvidenceTreeDigest } from "./portable-evidence-layout.mjs";

const INDEX_SCHEMA = "itotori.portable-evidence-index.v1";
const RECEIPT_SCHEMA = "itotori.portable-evidence-audit.v2";
const RECEIPT_FIELDS = [
  "inputHash",
  "outcome",
  "outputHash",
  "privacyClass",
  "producer",
  "sourceRevision",
];
const RECEIPT_KEYS = [
  "schema",
  "caseId",
  "evidenceKind",
  "sourceClass",
  "privacyClass",
  "contentCase",
  "referenceKind",
  "auditOutcome",
  "metadataComplete",
  "freshResolution",
  "independentProducer",
  "copiedExpectationRejected",
  "coherentLineage",
  "deterministicDependents",
  "tamperRejected",
  "staleRevisionRejected",
  "localLocationRejected",
  "restrictedPublicationWithheld",
  "trustRole",
  "protectedAttestationPresent",
  "fieldPopulation",
  "bundleDigest",
  "productSourceDigest",
  "productBuildDigest",
  "producerImplementationDigests",
  "producerDependencyDigests",
  "producerIdentities",
  "verifierRandomizedCommitment",
];
const REQUIRED_FACTS = [
  "metadataComplete",
  "freshResolution",
  "independentProducer",
  "copiedExpectationRejected",
  "coherentLineage",
  "deterministicDependents",
  "tamperRejected",
  "staleRevisionRejected",
  "localLocationRejected",
  "restrictedPublicationWithheld",
];
const lexical = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function record(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label}-invalid`);
  }
  return value;
}

function exactKeys(value, keys, label) {
  const actual = Object.keys(value).toSorted(lexical);
  const expected = [...keys].toSorted(lexical);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label}-keys-mismatch`);
  }
}

function text(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label}-invalid`);
  return value;
}

function caseKey(caseId) {
  return digest(caseId).slice(0, 20);
}

function portableEvidenceRegistration() {
  const registered = behaviorCells.filter(({ portableEvidence }) => portableEvidence !== undefined);
  if (registered.length !== 1) {
    throw new Error(`portable-evidence-registry-entry-count:${registered.length}/1`);
  }
  const [entry] = registered;
  const expectedCaseCount = entry.portableEvidence?.expectedCaseCount;
  if (!Number.isInteger(expectedCaseCount) || expectedCaseCount < 1) {
    throw new Error("portable-evidence-registry-case-count-invalid");
  }
  return { cell: entry.cell, expectedCaseCount };
}

function selectedCases(plan) {
  const registration = portableEvidenceRegistration();
  const cases = plan.cases
    .filter(({ cell }) => cell === registration.cell)
    .toSorted((left, right) => lexical(left.id, right.id));
  if (cases.length !== registration.expectedCaseCount) {
    throw new Error(
      `portable-evidence-plan-case-count:${cases.length}/${registration.expectedCaseCount}`,
    );
  }
  if (new Set(cases.map(({ id }) => caseKey(id))).size !== cases.length) {
    throw new Error("portable-evidence-case-key-collision");
  }
  return cases;
}

function requestDigest(plan, selected) {
  return canonicalDigest({
    caseId: selected.id,
    candidateRevision: plan.candidateTreeDigest,
    evidenceKind: selected.values.evidence_kind,
    sourceClass: selected.values.source_class,
    privacyClass: selected.values.privacy_class,
    contentCase: selected.values.content_case,
    referenceKind: selected.values.reference_kind,
    auditOutcome: selected.values.audit_outcome,
  });
}

function receiptWrapper(caseRoot, label) {
  const wrapper = record(readJson(resolve(caseRoot, "audit-receipt.json"), label), label);
  exactKeys(wrapper, ["receipt", "receiptDigest"], label);
  const receipt = record(wrapper.receipt, `${label}-receipt`);
  exactKeys(receipt, RECEIPT_KEYS, `${label}-receipt`);
  if (receipt.schema !== RECEIPT_SCHEMA) throw new Error(`${label}-schema-invalid`);
  if (
    receipt.trustRole !== "local-candidate-contract" ||
    receipt.protectedAttestationPresent !== false ||
    !/^[a-f0-9]{64}$/u.test(receipt.verifierRandomizedCommitment)
  ) {
    throw new Error(`${label}-trust-role-invalid`);
  }
  const dependencies = record(receipt.producerDependencyDigests, `${label}-producer-dependencies`);
  exactKeys(dependencies, ["support", "contract", "portability"], `${label}-producer-dependencies`);
  const receiptDigest = text(wrapper.receiptDigest, `${label}-digest`);
  if (receiptDigest !== digest(JSON.stringify(receipt))) {
    throw new Error(`${label}-digest-mismatch`);
  }
  const bundleRoot = resolve(caseRoot, "evidence-bundle");
  requiredType(bundleRoot, "directory", `${label}-bundle`);
  const bundleDigest = portableEvidenceTreeDigest(bundleRoot);
  if (receipt.bundleDigest !== bundleDigest) throw new Error(`${label}-bundle-digest-mismatch`);
  return { receipt, receiptDigest, bundleRoot, bundleDigest };
}

function publicEntry(plan, selected, evidence) {
  const key = caseKey(selected.id);
  return {
    caseId: selected.id,
    privacyClass: "public-safe",
    path: `cases/${key}`,
    requestDigest: requestDigest(plan, selected),
    evidenceTreeDigest: evidence.bundleDigest,
    auditReceiptDigest: evidence.receiptDigest,
  };
}

function aggregate(plan, entries) {
  const sortedEntries = entries.toSorted((left, right) => lexical(left.caseId, right.caseId));
  const index = {
    schema: INDEX_SCHEMA,
    candidateTreeDigest: plan.candidateTreeDigest,
    cases: sortedEntries,
  };
  const publicReceipts = sortedEntries
    .filter(({ privacyClass }) => privacyClass === "public-safe")
    .map(({ caseId, auditReceiptDigest }) => ({ caseId, auditReceiptDigest }));
  return {
    index,
    evidenceDigest: canonicalDigest(index),
    auditReceiptDigest: canonicalDigest(publicReceipts),
  };
}

export function collectPortableEvidence(workRoot, plan) {
  const selected = selectedCases(plan);
  let cases;
  try {
    cases = selected.map((selectedCase) => {
      const sourceRoot = resolve(workRoot, caseKey(selectedCase.id));
      const names = namesBelow(sourceRoot, `portable-evidence-${selectedCase.id}-case-root`);
      if (
        names.length !== 2 ||
        names[0] !== "audit-receipt.json" ||
        names[1] !== "evidence-bundle"
      ) {
        throw new Error(`portable-evidence-case-layout-mismatch:${selectedCase.id}`);
      }
      const evidence = receiptWrapper(sourceRoot, `portable-evidence-${selectedCase.id}`);
      assertExactBundleLayout(evidence.bundleRoot, `portable-evidence-${selectedCase.id}-bundle`);
      assertPlanBinding(selectedCase, evidence.receipt);
      const restricted = selectedCase.values.privacy_class === "restricted";
      const entry = restricted
        ? restrictedProjectionEntry(selectedCase, evidence.receipt)
        : publicEntry(plan, selectedCase, evidence);
      if (restricted) rmSync(sourceRoot, { force: true, recursive: true });
      return {
        selected: selectedCase,
        ...(restricted ? {} : { sourceRoot, evidence }),
        entry,
        publication: restricted ? "restricted" : "public-safe",
        productSourceDigest: evidence.receipt.productSourceDigest,
        productBuildDigest: evidence.receipt.productBuildDigest,
      };
    });
  } finally {
    for (const selectedCase of selected) {
      if (selectedCase.values.privacy_class !== "restricted") continue;
      rmSync(resolve(workRoot, caseKey(selectedCase.id)), { force: true, recursive: true });
    }
  }
  const productSources = new Set(cases.map(({ productSourceDigest }) => productSourceDigest));
  const productBuilds = new Set(cases.map(({ productBuildDigest }) => productBuildDigest));
  if (productSources.size !== 1 || productBuilds.size !== 1) {
    throw new Error("portable-evidence-product-binding-inconsistent");
  }
  return {
    ...aggregate(
      plan,
      cases.map(({ entry }) => entry),
    ),
    cases,
    projection: projectionDocument(
      cases.filter(({ publication }) => publication === "restricted").map(({ entry }) => entry),
    ),
    productSourceDigest: [...productSources][0],
    productBuildDigest: [...productBuilds][0],
  };
}

export function publishPortableEvidence(outputRoot, portable) {
  const evidenceRoot = resolve(outputRoot, "evidence");
  mkdirSync(resolve(evidenceRoot, "cases"), { recursive: true });
  for (const { sourceRoot, entry, publication } of portable.cases) {
    if (publication !== "public-safe") continue;
    cpSync(sourceRoot, resolve(evidenceRoot, entry.path), {
      recursive: true,
      verbatimSymlinks: true,
    });
  }
  writeFileSync(
    resolve(evidenceRoot, "index.json"),
    `${JSON.stringify(portable.index, null, 2)}\n`,
  );
  writeFileSync(
    resolve(evidenceRoot, "projection.json"),
    `${JSON.stringify(portable.projection, null, 2)}\n`,
  );
}

function assertPlanBinding(selected, receipt, caseResult) {
  for (const [field, value] of [
    ["caseId", selected.id],
    ["evidenceKind", selected.values.evidence_kind],
    ["sourceClass", selected.values.source_class],
    ["privacyClass", selected.values.privacy_class],
    ["contentCase", selected.values.content_case],
    ["referenceKind", selected.values.reference_kind],
  ]) {
    if (receipt[field] !== value) {
      throw new Error(`portable-evidence-plan-${field}-mismatch:${selected.id}`);
    }
  }
  if (receipt.auditOutcome !== selected.values.audit_outcome) {
    throw new Error(`portable-evidence-audit-outcome-mismatch:${selected.id}`);
  }
  for (const fact of REQUIRED_FACTS) {
    if (receipt[fact] !== true)
      throw new Error(`portable-evidence-audit-fact-failed:${selected.id}:${fact}`);
  }
  if (!Array.isArray(receipt.fieldPopulation)) {
    throw new Error(`portable-evidence-field-population-invalid:${selected.id}`);
  }
  const fields = receipt.fieldPopulation.toSorted((left, right) =>
    lexical(left.field, right.field),
  );
  if (receipt.privacyClass === "restricted") {
    if (fields.length !== 0) {
      throw new Error(`portable-evidence-restricted-population-exposed:${selected.id}`);
    }
  } else if (
    fields.length !== RECEIPT_FIELDS.length ||
    fields.some(
      (field, index) =>
        field.field !== RECEIPT_FIELDS[index] ||
        !Number.isInteger(field.nonemptyCount) ||
        field.nonemptyCount !== 2 ||
        field.totalCount !== 2,
    )
  ) {
    throw new Error(`portable-evidence-field-population-incomplete:${selected.id}`);
  }
  const observedFields = fields.reduce((total, { nonemptyCount }) => total + nonemptyCount, 0);
  if (receipt.privacyClass !== "restricted" && observedFields !== 12) {
    throw new Error(`portable-evidence-case-observation-mismatch:${selected.id}`);
  }
  if (
    caseResult !== undefined &&
    (caseResult.status !== "pass" ||
      caseResult.observationCount !== (receipt.privacyClass === "restricted" ? 1 : 12))
  ) {
    throw new Error(`portable-evidence-case-observation-mismatch:${selected.id}`);
  }
  if (
    !Array.isArray(receipt.producerImplementationDigests) ||
    receipt.producerImplementationDigests.length !== 2 ||
    receipt.producerImplementationDigests.some((value) => !/^[a-f0-9]{64}$/u.test(value)) ||
    receipt.producerImplementationDigests[0] === receipt.producerImplementationDigests[1] ||
    !Array.isArray(receipt.producerIdentities) ||
    receipt.producerIdentities.length !== 2 ||
    receipt.producerIdentities.some(
      (identity) => typeof identity !== "string" || identity.length === 0,
    ) ||
    receipt.producerIdentities[0] === receipt.producerIdentities[1]
  ) {
    throw new Error(`portable-evidence-producer-binding-invalid:${selected.id}`);
  }
}

function rerunAuditor(bundleRoot, compiledDriversRoot, productBinding, plan, selected) {
  const freshRoot = mkdtempSync(resolve(tmpdir(), "behavior-evidence-gate-"));
  const verifierRoot = resolve(freshRoot, "verifier");
  try {
    cpSync(bundleRoot, resolve(freshRoot, "bundle"), {
      recursive: true,
      verbatimSymlinks: true,
    });
    mkdirSync(verifierRoot, { recursive: true });
    for (const name of [
      "evidence-auditor-boundary.js",
      "evidence-auditor-cli.js",
      "evidence-audit-facts.js",
      "evidence-contract.js",
      "evidence-product-proof-keys.js",
      "evidence-portability.js",
      "evidence-local-controls.js",
      "evidence-restricted-details.js",
      "evidence-semantic-output.js",
      "evidence-producer-support.js",
      "evidence-evaluated-producer-boundary.js",
      "evidence-expectation-producer-boundary.js",
      "evidence-expectation-scenario-client.js",
    ]) {
      copyFileSync(resolve(compiledDriversRoot, name), resolve(verifierRoot, name));
    }
    const productRoot = resolve(dirname(productBinding.boundaryPath), "../../..");
    cpSync(productRoot, resolve(verifierRoot, "product"), { recursive: true });
    const freshCopyNonce = randomUUID();
    writeFileSync(resolve(verifierRoot, "fresh-copy-token"), `${freshCopyNonce}\n`);
    const result = spawnSync(
      process.execPath,
      [
        "evidence-auditor-cli.js",
        JSON.stringify({
          freshCopyNonce,
          expectedBuildRevision: plan.candidateTreeDigest,
          expectedProductSourceDigest: productBinding.productSourceDigest,
          expectedProductBuildDigest: productBinding.productBuildDigest,
          caseId: selected.id,
          evidenceKind: selected.values.evidence_kind,
          sourceClass: selected.values.source_class,
          privacyClass: selected.values.privacy_class,
          contentCase: selected.values.content_case,
          referenceKind: selected.values.reference_kind,
        }),
      ],
      { cwd: verifierRoot, encoding: "utf8" },
    );
    if (result.status !== 0 || result.stderr !== "" || !result.stdout.endsWith("\n")) {
      throw new Error(
        `portable-evidence-clean-audit-failed:${result.status ?? "no-status"}:${result.stderr.trim()}`,
      );
    }
    const lines = result.stdout.trimEnd().split("\n");
    if (lines.length !== 1) throw new Error("portable-evidence-clean-audit-output-invalid");
    return record(JSON.parse(lines[0]), "portable-evidence-clean-audit");
  } finally {
    rmSync(freshRoot, { force: true, recursive: true });
  }
}

export function verifyPublishedPortableEvidence(
  artifactDirectory,
  plan,
  caseResults,
  compiledDriversRoot,
  productBinding,
) {
  const evidenceRoot = resolve(artifactDirectory, "evidence");
  const rootNames = namesBelow(evidenceRoot, "portable-evidence-root");
  if (
    rootNames.length !== 3 ||
    rootNames[0] !== "cases" ||
    rootNames[1] !== "index.json" ||
    rootNames[2] !== "projection.json"
  ) {
    throw new Error("portable-evidence-root-layout-mismatch");
  }
  const publishedIndex = readJson(resolve(evidenceRoot, "index.json"), "portable-evidence-index");
  const publishedProjection = readJson(
    resolve(evidenceRoot, "projection.json"),
    "portable-evidence-projection",
  );
  const parsedIndex = record(publishedIndex, "portable-evidence-index");
  exactKeys(parsedIndex, ["schema", "candidateTreeDigest", "cases"], "portable-evidence-index");
  if (
    parsedIndex.schema !== INDEX_SCHEMA ||
    parsedIndex.candidateTreeDigest !== plan.candidateTreeDigest ||
    !Array.isArray(parsedIndex.cases)
  ) {
    throw new Error("portable-evidence-index-invalid");
  }
  const expectedCases = selectedCases(plan);
  const publicCases = expectedCases.filter(({ values }) => values.privacy_class === "public-safe");
  const expectedKeys = publicCases.map(({ id }) => caseKey(id)).toSorted(lexical);
  const casesRoot = resolve(evidenceRoot, "cases");
  const actualKeys = namesBelow(casesRoot, "portable-evidence-cases-root");
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error("portable-evidence-case-directory-set-mismatch");
  }
  const resultById = new Map(caseResults.map((result) => [result.caseId, result]));
  const cases = publicCases.map((selected) => {
    const sourceRoot = resolve(casesRoot, caseKey(selected.id));
    const names = namesBelow(sourceRoot, `portable-evidence-${selected.id}-case-root`);
    if (names.length !== 2 || names[0] !== "audit-receipt.json" || names[1] !== "evidence-bundle") {
      throw new Error(`portable-evidence-case-layout-mismatch:${selected.id}`);
    }
    const evidence = receiptWrapper(sourceRoot, `portable-evidence-${selected.id}`);
    assertExactBundleLayout(evidence.bundleRoot, `portable-evidence-${selected.id}-bundle`);
    const audited = rerunAuditor(
      evidence.bundleRoot,
      compiledDriversRoot,
      productBinding,
      plan,
      selected,
    );
    const { verifierRandomizedCommitment: storedCommitment, ...storedStable } = evidence.receipt;
    const { verifierRandomizedCommitment: freshCommitment, ...freshStable } = audited;
    if (
      canonicalDigest(freshStable) !== canonicalDigest(storedStable) ||
      !/^[a-f0-9]{64}$/u.test(freshCommitment) ||
      freshCommitment === storedCommitment
    ) {
      throw new Error(`portable-evidence-clean-audit-receipt-mismatch:${selected.id}`);
    }
    assertPlanBinding(selected, audited, resultById.get(selected.id));
    return {
      selected,
      sourceRoot,
      evidence,
      entry: publicEntry(plan, selected, evidence),
      publication: "public-safe",
    };
  });
  const restrictedEntries = validateProjection(publishedProjection, expectedCases, caseResults);
  const verified = {
    ...aggregate(plan, [...cases.map(({ entry }) => entry), ...restrictedEntries]),
    cases,
    projection: projectionDocument(restrictedEntries),
    productSourceDigest: productBinding.productSourceDigest,
    productBuildDigest: productBinding.productBuildDigest,
  };
  if (canonicalDigest(publishedIndex) !== canonicalDigest(verified.index)) {
    throw new Error("portable-evidence-index-rebuild-mismatch");
  }
  return verified;
}
