#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  OWNED_CELLS,
  assertValidCellReport,
  buildCellReport,
  canonicalDigest,
  formatCellReportSummary,
  renderCellJunit,
} from "./build-cell-report.mjs";
import { buildBehaviorProofPlan } from "./behavior-proof-plan.mjs";
import { readCucumberExecution } from "./cucumber-message-ledger.mjs";
import {
  buildMutationResults,
  compileBehaviorGlue,
  computeBehaviorBuildDigest,
} from "./run-behavior-proof.mjs";
import { verifyPublishedPortableEvidence } from "./portable-evidence-artifacts.mjs";
import { productImplementationBinding } from "./behavior-proof-build.mjs";
import { verifyArtifactLayout } from "./behavior-proof-artifact-layout.mjs";
import {
  fragmentArtifactPaths,
  laneFragmentKey,
  normalizePlanLaneFragments,
  observedFragmentKey,
} from "./behavior-proof-fragments.mjs";
import { buildLocalArtifactReceipt } from "./local-behavior-receipt.mjs";
import { parseBehaviorGateArgs, requireCompleteBehaviorMatrix } from "./behavior-gate-mode.mjs";

const lexical = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readArtifact(path, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`${label}-missing:${path}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label}-type-invalid:${path}`);
  return readFileSync(path);
}

function readJson(path, label) {
  const bytes = readArtifact(path, label);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label}-invalid-json:${path}`);
  }
}

function readText(path, label) {
  return readArtifact(path, label).toString("utf8");
}

function sameCanonical(actual, expected, label) {
  if (canonicalDigest(actual) !== canonicalDigest(expected)) {
    throw new Error(`${label}-mismatch`);
  }
}

function artifactLocation(root, artifactRoot) {
  if (typeof artifactRoot !== "string" || artifactRoot.length === 0 || isAbsolute(artifactRoot)) {
    throw new Error(`artifact-root-invalid:${String(artifactRoot)}`);
  }
  const directory = resolve(root, artifactRoot);
  const relativeRoot = relative(root, directory);
  if (
    relativeRoot === "" ||
    relativeRoot === ".." ||
    relativeRoot.startsWith(`..${sep}`) ||
    isAbsolute(relativeRoot)
  ) {
    throw new Error(`artifact-root-escapes-repository:${artifactRoot}`);
  }
  return { directory, relativeRoot: relativeRoot.split(sep).join("/") };
}

function resolveArtifact(root, path) {
  if (typeof path !== "string" || path.length === 0 || isAbsolute(path)) {
    throw new Error(`lane-fragment-path-invalid:${String(path)}`);
  }
  const target = resolve(root, path);
  const prefix = `${resolve(root)}${sep}`;
  if (!target.startsWith(prefix)) throw new Error(`lane-fragment-path-escapes-root:${path}`);
  return target;
}

export function verifyLaneFragments(report, root) {
  if (!Array.isArray(report.laneFragments) || report.laneFragments.length === 0) {
    throw new Error("missing-lane-fragment:no fragments reported");
  }
  return report.laneFragments.map((fragment) => {
    const key = observedFragmentKey(fragment);
    for (const [kind, pathName, digestName] of [
      ["message", "messagePath", "messageDigest"],
      ["junit", "junitPath", "junitDigest"],
    ]) {
      const path = resolveArtifact(root, fragment[pathName]);
      const bytes = readArtifact(path, `missing-lane-fragment:${key}/${kind}`);
      if (bytes.length === 0) {
        throw new Error(`zero-byte-lane-fragment:${key}/${kind}`);
      }
      if (digest(bytes) !== fragment[digestName]) {
        throw new Error(`lane-fragment-digest-mismatch:${key}/${kind}`);
      }
    }
    return { ...fragment };
  });
}

function expectedArtifactPaths(relativeRoot) {
  return {
    cellReport: `${relativeRoot}/cell-report.json`,
    cellJunit: `${relativeRoot}/cell-report.junit.xml`,
    mutations: `${relativeRoot}/mutations.json`,
    summary: `${relativeRoot}/summary.txt`,
  };
}

function expectedMutationArtifactPaths(relativeRoot) {
  return {
    cellReport: `${relativeRoot}/mutation/fixed-success-cell-report.json`,
    cellJunit: `${relativeRoot}/mutation/fixed-success-cell-report.junit.xml`,
    mutations: `${relativeRoot}/mutations.json`,
    summary: `${relativeRoot}/mutation/fixed-success-summary.txt`,
  };
}

function normalizedResults(results) {
  return results.toSorted((left, right) => lexical(left.caseId, right.caseId));
}

function assertFragmentLayout(fragments, plan, relativeRoot, kind) {
  const planned = new Map(
    normalizePlanLaneFragments(plan).map((fragment) => [laneFragmentKey(fragment), fragment]),
  );
  if (fragments.length !== planned.size) throw new Error(`${kind}-fragment-set-mismatch`);
  for (const fragment of fragments) {
    const key = observedFragmentKey(fragment);
    const descriptor = planned.get(key);
    if (descriptor === undefined) throw new Error(`${kind}-fragment-unplanned:${key}`);
    const expected = fragmentArtifactPaths(descriptor, relativeRoot, kind);
    if (
      fragment.messagePath !== expected.messagePath ||
      fragment.junitPath !== expected.junitPath
    ) {
      throw new Error(`${kind}-fragment-layout-mismatch:${key}`);
    }
  }
}

function parseFragments(root, plan, fragments, label) {
  const casesById = new Map(plan.cases.map((selectedCase) => [selectedCase.id, selectedCase]));
  const planned = new Map(
    normalizePlanLaneFragments(plan).map((fragment) => [laneFragmentKey(fragment), fragment]),
  );
  const combined = [];
  for (const fragment of fragments) {
    const key = observedFragmentKey(fragment);
    const descriptor = planned.get(key);
    if (descriptor === undefined) throw new Error(`${label}-fragment-unplanned:${key}`);
    const selectedCases = descriptor.caseIds.map((caseId) => casesById.get(caseId));
    if (selectedCases.some((selectedCase) => selectedCase === undefined)) {
      throw new Error(`${label}-fragment-case-unselected:${key}`);
    }
    const execution = readCucumberExecution(
      resolveArtifact(root, fragment.messagePath),
      selectedCases,
    );
    if (execution.messageDigest !== fragment.messageDigest) {
      throw new Error(`${label}-fragment-message-reparse-mismatch:${key}`);
    }
    combined.push(...execution.caseResults);
  }
  const normalized = normalizedResults(combined);
  if (normalized.length !== plan.cases.length) {
    throw new Error(
      `selected-executed-case-count-mismatch:${plan.cases.length}/${normalized.length}`,
    );
  }
  return normalized;
}

function verifyMutationEvidence(root, location, mutantPlan, baselineResults, report) {
  const fragments = report.laneFragments;
  assertFragmentLayout(fragments, mutantPlan, location.relativeRoot, "mutation");
  verifyLaneFragments(report, root);
  const caseResults = parseFragments(root, mutantPlan, fragments, "fixed-success");
  const recorded = readJson(
    resolve(location.directory, "mutation", "case-results.json"),
    "mutation-case-results",
  );
  sameCanonical(recorded, caseResults, "mutation-case-results-attachment-binding");
  const mutations = buildMutationResults(caseResults, baselineResults);
  if (mutations.some(({ outcome }) => outcome !== "killed")) {
    throw new Error("fixed-success-mutation-not-killed");
  }
  return { mutations, caseResults, fragments };
}

function verifyMutationReport(location, plan, buildDigest, evidence, report) {
  const rebuilt = buildCellReport({
    selectionPlan: plan,
    selectionPlanDigest: canonicalDigest(plan),
    candidateBuildDigest: buildDigest,
    laneFragments: report.laneFragments,
    caseResults: evidence.caseResults,
    mutationResults: evidence.mutations,
    verifiedReceiptDigests: {},
    artifacts: expectedMutationArtifactPaths(location.relativeRoot),
  });
  sameCanonical(report, rebuilt, "fixed-success-cell-report-raw-evidence-rebuild");
  if (
    rebuilt.summary.passingCellCount !== 0 ||
    rebuilt.cells
      .filter(({ cell }) => OWNED_CELLS.includes(cell))
      .some(({ status }) => status !== "fail")
  ) {
    throw new Error("fixed-success-cell-report-not-red");
  }
  const summary = readText(
    resolve(location.directory, "mutation", "fixed-success-summary.txt"),
    "fixed-success-summary",
  );
  if (summary !== `${formatCellReportSummary(rebuilt)}\n`) {
    throw new Error("fixed-success-summary-artifact-mismatch");
  }
  const junit = readText(
    resolve(location.directory, "mutation", "fixed-success-cell-report.junit.xml"),
    "fixed-success-cell-junit",
  );
  if (junit !== renderCellJunit(rebuilt)) throw new Error("fixed-success-cell-junit-mismatch");
}

export function requireExternalVerifierReceipt(receipt) {
  if (receipt === undefined || receipt === null) {
    throw new Error("external-verifier-app-unavailable");
  }
  if (
    receipt?.trustRole === "local-candidate-contract" ||
    receipt?.protectedAttestationPresent === false
  ) {
    throw new Error("external-verifier-local-candidate-rejected");
  }
  throw new Error("external-verifier-receipt-validation-not-installed");
}

export async function verifyLocalCandidate({
  root = process.cwd(),
  artifactRoot = "behavior-proof",
} = {}) {
  const location = artifactLocation(root, artifactRoot);
  const artifactPlan = readJson(
    resolve(location.directory, "selection-plan.json"),
    "selection-plan",
  );
  const recordedMutantPlan = readJson(
    resolve(location.directory, "mutation", "fixed-success-selection-plan.json"),
    "fixed-success-selection-plan",
  );
  verifyArtifactLayout(location, artifactPlan, recordedMutantPlan);
  const report = readJson(resolve(location.directory, "cell-report.json"), "cell-report");
  assertValidCellReport(report);
  assertFragmentLayout(report.laneFragments, artifactPlan, location.relativeRoot, "normal");
  const fragments = verifyLaneFragments(report, root);

  const { plan } = await buildBehaviorProofPlan({ root, mode: "normal" });
  sameCanonical(artifactPlan, plan, "selection-plan-current-tree-binding");
  const selectionPlanDigest = canonicalDigest(plan);
  if (
    selectionPlanDigest !== report.selectionPlanDigest ||
    plan.candidateTreeDigest !== report.candidateTreeDigest ||
    plan.classificationDigest !== report.classificationDigest
  ) {
    throw new Error("selection-plan-report-binding-mismatch");
  }

  const caseResults = parseFragments(root, plan, fragments, "normal");
  const recordedCaseResults = readJson(
    resolve(location.directory, "case-results.json"),
    "case-results",
  );
  sameCanonical(recordedCaseResults, caseResults, "case-results-message-binding");

  const { plan: mutantPlan } = await buildBehaviorProofPlan({ root, mode: "fixed-success" });
  sameCanonical(
    recordedMutantPlan,
    mutantPlan,
    "fixed-success-selection-plan-current-tree-binding",
  );
  const mutationReport = readJson(
    resolve(location.directory, "mutation", "fixed-success-cell-report.json"),
    "fixed-success-cell-report",
  );
  assertValidCellReport(mutationReport);
  const mutationEvidence = verifyMutationEvidence(
    root,
    location,
    mutantPlan,
    caseResults,
    mutationReport,
  );
  const mutations = mutationEvidence.mutations;
  const recordedMutations = readJson(resolve(location.directory, "mutations.json"), "mutations");
  sameCanonical(recordedMutations, mutations, "mutation-results-raw-evidence-binding");

  compileBehaviorGlue(root);
  const candidateBuildDigest = computeBehaviorBuildDigest(root);
  if (candidateBuildDigest !== report.candidateBuildDigest) {
    throw new Error("candidate-build-digest-mismatch");
  }
  verifyMutationReport(
    location,
    mutantPlan,
    candidateBuildDigest,
    mutationEvidence,
    mutationReport,
  );
  const portable = verifyPublishedPortableEvidence(
    location.directory,
    plan,
    caseResults,
    resolve(root, ".tmp", "behavior-proof", "glue", "drivers"),
    productImplementationBinding(root),
  );
  const receipt = buildLocalArtifactReceipt(
    plan,
    selectionPlanDigest,
    candidateBuildDigest,
    report.laneFragments,
    caseResults,
    mutations,
    portable,
  );
  const recordedReceipt = readJson(
    resolve(location.directory, "receipts", "root-cells.json"),
    "root-cell-receipt",
  );
  sameCanonical(recordedReceipt, receipt, "root-cell-receipt-rebuild");
  const receiptDigest = canonicalDigest(receipt);

  const artifacts = expectedArtifactPaths(location.relativeRoot);
  const rebuilt = buildCellReport({
    selectionPlan: plan,
    selectionPlanDigest,
    candidateBuildDigest,
    laneFragments: report.laneFragments,
    caseResults,
    mutationResults: mutations,
    verifiedReceiptDigests: Object.fromEntries(OWNED_CELLS.map((cell) => [cell, receiptDigest])),
    artifacts,
  });
  sameCanonical(report, rebuilt, "cell-report-raw-evidence-rebuild");
  for (const cellIdentity of OWNED_CELLS) {
    const cell = rebuilt.cells.find(({ cell }) => cell === cellIdentity);
    if (cell?.status !== "pass") throw new Error(`owned-cell-not-locally-verified:${cellIdentity}`);
  }
  const summary = readText(resolve(location.directory, "summary.txt"), "summary");
  if (summary !== `${formatCellReportSummary(rebuilt)}\n`) {
    throw new Error("summary-artifact-mismatch");
  }
  const junit = readText(resolve(location.directory, "cell-report.junit.xml"), "cell-junit");
  if (junit !== renderCellJunit(rebuilt)) throw new Error("cell-junit-rebuild-mismatch");
  return rebuilt;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { mode, artifactRoot } = parseBehaviorGateArgs(process.argv.slice(2));
    verifyLocalCandidate({ artifactRoot })
      .then((report) => {
        if (mode === "accepted") requireExternalVerifierReceipt(undefined);
        if (mode === "full-matrix") requireCompleteBehaviorMatrix(report);
        process.stdout.write(`Local candidate verified: ${formatCellReportSummary(report)}\n`);
      })
      .catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
