#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildCellReport,
  canonicalDigest,
  formatCellReportSummary,
  renderCellJunit,
} from "./build-cell-report.mjs";
import { buildBehaviorProofPlan, renderSelectedFeature } from "./behavior-proof-plan.mjs";
import {
  fragmentArtifactPaths,
  laneFragmentKey,
  normalizePlanLaneFragments,
} from "./behavior-proof-fragments.mjs";
import { readCucumberExecution } from "./cucumber-message-ledger.mjs";
import {
  collectPortableEvidence,
  publishPortableEvidence,
} from "./portable-evidence-artifacts.mjs";
import { compileBehaviorGlue, computeBehaviorBuildDigest } from "./behavior-proof-build.mjs";
import { buildLocalArtifactReceipt } from "./local-behavior-receipt.mjs";

export { compileBehaviorGlue, computeBehaviorBuildDigest } from "./behavior-proof-build.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(here, "../..");
const OWNED_CELLS = [
  "cell::quality.evidence-is-traceable-and-portable::all",
  "cell::quality.failures-stay-explicit::all",
];

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJsonl(path) {
  return readFileSync(path, "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`case-result-invalid-json:${index + 1}`);
      }
    });
}

function run(command, args, root) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status === null) throw new Error(`${command} ended without an exit status`);
  return result;
}

function existingDirectory(path, label, allowMissing = false) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return;
    throw new Error(`${label}-missing`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label}-type-invalid`);
}

export function resolveBehaviorProofOutput(root, output) {
  if (output === "behavior-proof") {
    const target = resolve(root, output);
    existingDirectory(target, "behavior-proof-output", true);
    return target;
  }
  if (typeof output !== "string" || !/^\.tmp\/behavior-gate-test-[A-Za-z0-9]{6}$/u.test(output)) {
    throw new Error(`behavior-proof-output-not-allowed:${String(output)}`);
  }
  const temporaryRoot = resolve(root, ".tmp");
  existingDirectory(temporaryRoot, "behavior-proof-temporary-root");
  const target = resolve(root, output);
  if (dirname(target) !== temporaryRoot) throw new Error("behavior-proof-output-escapes-temp-root");
  existingDirectory(target, "behavior-proof-test-output");
  return target;
}

function validateCaseResults(results, selectedCases, execution) {
  const selectedById = new Map(selectedCases.map((entry) => [entry.id, entry]));
  const resultsById = new Map();
  for (const result of results) {
    const selected = selectedById.get(result.caseId);
    if (selected === undefined) throw new Error(`unexpected-case-result:${result.caseId}`);
    if (resultsById.has(result.caseId)) throw new Error(`duplicate-case-result:${result.caseId}`);
    if (
      result.behavior !== selected.behavior ||
      result.subject !== selected.subject ||
      result.cell !== selected.cell ||
      (result.status !== "pass" && result.status !== "fail") ||
      !Number.isInteger(result.assertionCount) ||
      !Number.isInteger(result.observationCount) ||
      !Array.isArray(result.reasonCodes)
    ) {
      throw new Error(`invalid-case-result:${result.caseId}`);
    }
    if (execution.caseStatuses.get(result.caseId) !== result.status) {
      throw new Error(`cucumber-result-status-mismatch:${result.caseId}`);
    }
    if (
      result.assertionCount > selected.requiredAssertionCount ||
      (result.status === "pass" && result.assertionCount !== selected.requiredAssertionCount)
    ) {
      throw new Error(`case-assertion-count-mismatch:${result.caseId}`);
    }
    resultsById.set(result.caseId, result);
  }
  const selectedIds = [...selectedById.keys()].toSorted();
  const resultIds = [...resultsById.keys()].toSorted();
  if (
    selectedIds.length !== resultIds.length ||
    selectedIds.some((caseId, index) => caseId !== resultIds[index])
  ) {
    throw new Error(
      `selected-reported-case-set-mismatch:${selectedIds.length}/${resultIds.length}`,
    );
  }
  const normalized = [...resultsById.values()].toSorted((left, right) =>
    left.caseId.localeCompare(right.caseId),
  );
  if (canonicalDigest(normalized) !== canonicalDigest(execution.caseResults)) {
    throw new Error("case-result-attachment-file-mismatch");
  }
  return execution.caseResults;
}

function prepareRun(workRoot, plan, mutationOnly, fragment) {
  mkdirSync(resolve(workRoot, "features"), { recursive: true });
  mkdirSync(resolve(workRoot, "cucumber"), { recursive: true });
  mkdirSync(resolve(workRoot, "work"), { recursive: true });
  writeJson(resolve(workRoot, "selection-plan.json"), plan);
  writeFileSync(
    resolve(workRoot, "features", "selected.feature"),
    renderSelectedFeature(plan, { mutationOnly }),
    "utf8",
  );
  writeFileSync(resolve(workRoot, "case-results.jsonl"), "", "utf8");
  const key = laneFragmentKey(fragment);
  rmSync(resolve(workRoot, "cucumber", `${key}.ndjson`), { force: true });
  rmSync(resolve(workRoot, "cucumber", `${key}.xml`), { force: true });
}

function executePlan(root, workRoot, plan, mutationOnly) {
  const fragments = normalizePlanLaneFragments(plan);
  if (fragments.length !== 1 || laneFragmentKey(fragments[0]) !== "public-ts-1of1") {
    throw new Error("local-runner-requires-single-root-fragment");
  }
  const fragment = fragments[0];
  prepareRun(workRoot, plan, mutationOnly, fragment);
  const selectedCases = mutationOnly
    ? plan.cases.filter(({ cell }) => OWNED_CELLS.includes(cell))
    : plan.cases;
  const result = run(
    "pnpm",
    ["exec", "cucumber-js", "--config", "suite/behavior/cucumber.mjs"],
    root,
  );
  const key = laneFragmentKey(fragment);
  const messagePath = resolve(workRoot, "cucumber", `${key}.ndjson`);
  const execution = readCucumberExecution(messagePath, selectedCases);
  const caseResults = validateCaseResults(
    readJsonl(resolve(workRoot, "case-results.jsonl")),
    selectedCases,
    execution,
  );
  const allPass = caseResults.every(({ status }) => status === "pass");
  if ((allPass && result.status !== 0) || (!allPass && result.status === 0)) {
    throw new Error(`cucumber-process-result-disagrees:${result.status}/${allPass}`);
  }
  return {
    processStatus: result.status,
    caseResults,
    execution,
    fragment,
    messagePath,
    junitPath: resolve(workRoot, "cucumber", `${key}.xml`),
  };
}

function assertCellOutcome(results, status, label) {
  for (const cell of OWNED_CELLS) {
    const cellResults = results.filter((result) => result.cell === cell);
    if (cellResults.length === 0 || cellResults.some((result) => result.status !== status)) {
      throw new Error(`${label}:${cell}:${cellResults.length}/${status}`);
    }
  }
}

function preserveMutationRun(workRoot, runResult) {
  const mutationRoot = resolve(workRoot, "mutation");
  mkdirSync(mutationRoot, { recursive: true });
  const key = laneFragmentKey(runResult.fragment);
  copyFileSync(runResult.messagePath, resolve(mutationRoot, `fixed-success-${key}.ndjson`));
  copyFileSync(runResult.junitPath, resolve(mutationRoot, `fixed-success-${key}.xml`));
  writeJson(
    resolve(mutationRoot, "case-results.json"),
    runResult.caseResults.toSorted((left, right) => left.caseId.localeCompare(right.caseId)),
  );
}

export async function runMutationProof({ root = defaultRoot } = {}) {
  const workRoot = resolve(root, ".tmp", "behavior-proof");
  rmSync(workRoot, { force: true, recursive: true });
  compileBehaviorGlue(root);
  const { plan: mutantPlan } = await buildBehaviorProofPlan({ root, mode: "fixed-success" });
  const mutant = executePlan(root, workRoot, mutantPlan, true);
  assertCellOutcome(mutant.caseResults, "fail", "fixed-success-did-not-turn-red");
  preserveMutationRun(workRoot, mutant);
  const { plan: baselinePlan } = await buildBehaviorProofPlan({ root, mode: "normal" });
  const baseline = executePlan(root, workRoot, baselinePlan, true);
  assertCellOutcome(baseline.caseResults, "pass", "real-driver-did-not-turn-green");
  return { mutant, baseline, mutantPlan, baselinePlan, workRoot };
}

export function buildMutationResults(mutantResults, baselineResults) {
  return OWNED_CELLS.map((cell) => {
    const baselineCases = baselineResults.filter((result) => result.cell === cell);
    const mutantCases = mutantResults.filter((result) => result.cell === cell);
    const baselineStatus =
      baselineCases.length > 0 && baselineCases.every(({ status }) => status === "pass")
        ? "pass"
        : "fail";
    const mutantStatus =
      mutantCases.length > 0 && mutantCases.every(({ status }) => status === "pass")
        ? "pass"
        : "fail";
    const outcome =
      baselineStatus !== "pass" ? "invalid" : mutantStatus === "fail" ? "killed" : "escaped";
    return {
      mutationId: `kill::${cell.slice("cell::".length)}`,
      cell,
      outcome,
      baselineStatus,
      mutantStatus,
      reasonCodes: [
        outcome === "killed"
          ? "fixed-success-rejected"
          : outcome === "escaped"
            ? "fixed-success-survived"
            : "baseline-failed",
      ],
    };
  });
}

function publishArtifacts(
  outputRoot,
  workRoot,
  plan,
  mutantPlan,
  report,
  mutationReport,
  mutations,
  receipt,
  fullRun,
  portable,
) {
  rmSync(outputRoot, { force: true, recursive: true });
  mkdirSync(resolve(outputRoot, "cucumber"), { recursive: true });
  mkdirSync(resolve(outputRoot, "receipts"), { recursive: true });
  const fragmentKey = laneFragmentKey(fullRun.fragment);
  copyFileSync(fullRun.messagePath, resolve(outputRoot, "cucumber", `${fragmentKey}.ndjson`));
  copyFileSync(fullRun.junitPath, resolve(outputRoot, "cucumber", `${fragmentKey}.xml`));
  writeJson(resolve(outputRoot, "cell-report.json"), report);
  writeFileSync(resolve(outputRoot, "cell-report.junit.xml"), renderCellJunit(report), "utf8");
  writeJson(resolve(outputRoot, "selection-plan.json"), plan);
  writeJson(
    resolve(outputRoot, "case-results.json"),
    fullRun.caseResults.toSorted((left, right) => left.caseId.localeCompare(right.caseId)),
  );
  writeJson(resolve(outputRoot, "mutations.json"), mutations);
  writeFileSync(resolve(outputRoot, "summary.txt"), `${formatCellReportSummary(report)}\n`, "utf8");
  writeJson(resolve(outputRoot, "receipts", "root-cells.json"), receipt);
  cpSync(resolve(workRoot, "mutation"), resolve(outputRoot, "mutation"), { recursive: true });
  writeJson(resolve(outputRoot, "mutation", "fixed-success-selection-plan.json"), mutantPlan);
  writeJson(resolve(outputRoot, "mutation", "fixed-success-cell-report.json"), mutationReport);
  writeFileSync(
    resolve(outputRoot, "mutation", "fixed-success-cell-report.junit.xml"),
    renderCellJunit(mutationReport),
    "utf8",
  );
  writeFileSync(
    resolve(outputRoot, "mutation", "fixed-success-summary.txt"),
    `${formatCellReportSummary(mutationReport)}\n`,
    "utf8",
  );
  publishPortableEvidence(outputRoot, portable);
}

export async function runBehaviorProof({ root = defaultRoot, output = "behavior-proof" } = {}) {
  const outputRoot = resolveBehaviorProofOutput(root, output);
  const relativeOutput = relative(root, outputRoot);
  const artifactPrefix = relativeOutput.split(sep).join("/");
  const proof = await runMutationProof({ root });
  const { plan: mutantPlan } = await buildBehaviorProofPlan({ root, mode: "fixed-success" });
  const fullMutant = executePlan(root, proof.workRoot, mutantPlan, false);
  assertCellOutcome(fullMutant.caseResults, "fail", "fixed-success-full-report-did-not-turn-red");
  if (fullMutant.caseResults.some(({ status }) => status !== "fail")) {
    throw new Error("fixed-success-full-report-has-passing-case");
  }
  preserveMutationRun(proof.workRoot, fullMutant);
  const { plan } = await buildBehaviorProofPlan({ root, mode: "normal" });
  const fullRun = executePlan(root, proof.workRoot, plan, false);
  assertCellOutcome(fullRun.caseResults, "pass", "real-driver-did-not-stay-green");
  const expectedFailures = fullRun.caseResults.filter(({ status }) => status === "fail");
  if (
    expectedFailures.length !== 3_376 ||
    expectedFailures.some(({ reasonCodes }) => !reasonCodes.includes("missing-execution"))
  ) {
    throw new Error(`unexpected-unimplemented-case-count:${expectedFailures.length}/3376`);
  }
  const mutations = buildMutationResults(fullMutant.caseResults, fullRun.caseResults);
  const selectionPlanDigest = canonicalDigest(plan);
  const candidateBuildDigest = computeBehaviorBuildDigest(root, proof.workRoot);
  const portable = collectPortableEvidence(resolve(proof.workRoot, "work"), plan);
  const fragmentPaths = fragmentArtifactPaths(fullRun.fragment, artifactPrefix);
  const lane = {
    lane: fullRun.fragment.lane,
    shard: fullRun.fragment.shard,
    shardCount: fullRun.fragment.shardCount,
    messagePath: fragmentPaths.messagePath,
    messageDigest: fullRun.execution.messageDigest,
    junitPath: fragmentPaths.junitPath,
    junitDigest: createHash("sha256").update(readFileSync(fullRun.junitPath)).digest("hex"),
  };
  const receipt = buildLocalArtifactReceipt(
    plan,
    selectionPlanDigest,
    candidateBuildDigest,
    [lane],
    fullRun.caseResults,
    mutations,
    portable,
  );
  const receiptDigest = canonicalDigest(receipt);
  const report = buildCellReport({
    selectionPlan: plan,
    selectionPlanDigest,
    candidateBuildDigest,
    laneFragments: [
      {
        lane: lane.lane,
        shard: lane.shard,
        shardCount: lane.shardCount,
        messagePath: lane.messagePath,
        messageDigest: lane.messageDigest,
        junitPath: lane.junitPath,
        junitDigest: lane.junitDigest,
      },
    ],
    caseResults: fullRun.caseResults,
    mutationResults: mutations,
    verifiedReceiptDigests: Object.fromEntries(OWNED_CELLS.map((cell) => [cell, receiptDigest])),
    artifacts: {
      cellReport: `${artifactPrefix}/cell-report.json`,
      cellJunit: `${artifactPrefix}/cell-report.junit.xml`,
      mutations: `${artifactPrefix}/mutations.json`,
      summary: `${artifactPrefix}/summary.txt`,
    },
  });
  const mutationPaths = fragmentArtifactPaths(fullMutant.fragment, artifactPrefix, "mutation");
  const mutationLane = {
    lane: fullMutant.fragment.lane,
    shard: fullMutant.fragment.shard,
    shardCount: fullMutant.fragment.shardCount,
    messagePath: mutationPaths.messagePath,
    messageDigest: fullMutant.execution.messageDigest,
    junitPath: mutationPaths.junitPath,
    junitDigest: createHash("sha256")
      .update(
        readFileSync(
          resolve(
            proof.workRoot,
            "mutation",
            `fixed-success-${laneFragmentKey(fullMutant.fragment)}.xml`,
          ),
        ),
      )
      .digest("hex"),
  };
  const mutationReport = buildCellReport({
    selectionPlan: mutantPlan,
    selectionPlanDigest: canonicalDigest(mutantPlan),
    candidateBuildDigest,
    laneFragments: [mutationLane],
    caseResults: fullMutant.caseResults,
    mutationResults: mutations,
    verifiedReceiptDigests: {},
    artifacts: {
      cellReport: `${artifactPrefix}/mutation/fixed-success-cell-report.json`,
      cellJunit: `${artifactPrefix}/mutation/fixed-success-cell-report.junit.xml`,
      mutations: `${artifactPrefix}/mutations.json`,
      summary: `${artifactPrefix}/mutation/fixed-success-summary.txt`,
    },
  });
  if (
    mutationReport.summary.passingCellCount !== 0 ||
    mutationReport.cells
      .filter(({ cell }) => OWNED_CELLS.includes(cell))
      .some(({ status }) => status !== "fail")
  ) {
    throw new Error("fixed-success-full-cell-report-not-red");
  }
  publishArtifacts(
    outputRoot,
    proof.workRoot,
    plan,
    mutantPlan,
    report,
    mutationReport,
    mutations,
    receipt,
    fullRun,
    portable,
  );
  return { report, mutationReport, mutations, proof, fullMutant, fullRun, outputRoot };
}

function parseOutput(args) {
  if (args.length === 0) return "behavior-proof";
  if (args.length === 2 && args[0] === "--output" && args[1].length > 0) return args[1];
  throw new Error("usage: run-behavior-proof.mjs [--output <relative-directory>]");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runBehaviorProof({ output: parseOutput(process.argv.slice(2)) })
    .then(({ report, mutationReport, proof }) => {
      process.stdout.write(
        `Mutation fixed-success: ${OWNED_CELLS.length}/2 cells red (${proof.mutant.caseResults.length} cases failed).\n`,
      );
      process.stdout.write(
        `Restored drivers: ${OWNED_CELLS.length}/2 cells green (${proof.baseline.caseResults.length} cases passed).\n`,
      );
      process.stdout.write(
        `Cucumber execution: ${report.summary.passingCellCount === 2 ? "3400/3400" : "invalid"} selected cases reported; 24 passed and 3376 failed explicitly.\n`,
      );
      process.stdout.write(`Fixed-success report: ${formatCellReportSummary(mutationReport)}\n`);
      process.stdout.write(`${formatCellReportSummary(report)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    });
}
