#!/usr/bin/env node
/*
 * ITOTORI-028 — `pnpm exec vp run itotori:iteration-fixture`
 *
 * Durable CI proof command that runs PUBLIC RECORDED inputs through ONE
 * end-to-end, manifest-bound iteration that composes three engines:
 *
 *   Itotori loop (ITOTORI-095)          Kaifuu                Utsushi
 *   import -> draft -> qa -> export      patch result          runtime observation
 *   -> feedback -> rerun  ────────────────────────────────────────────────────────┐
 *                                                                                 │
 *   -> patch-result -> runtime-observation -> SHARED-025 iteration-fixture result │
 *
 * It COMPOSES the existing seams (it imports the ITOTORI-095 iteration engine
 * verbatim and reads recorded public Kaifuu/Utsushi artifacts) — it does NOT
 * re-implement any stage.
 *
 * Emitted under artifacts/itotori/iteration-fixture/<scenario>/:
 *   - import.json, draft.json, qa.json, export.json, feedback.json, rerun.json
 *                                            (ITOTORI-095 stage-result artifacts)
 *   - patch-result.json, runtime-observation.json  (cross-tool stage artifacts)
 *   - iteration-fixture-result.json        (SHARED-025 cross-tool manifest)
 *
 * Hard contracts:
 *   - PUBLIC RECORDED fixtures ONLY (no private corpora, no live creds, no raw
 *     prompts / responses).
 *   - Cost / tokens / (model, provider) pair are read verbatim from the
 *     ITOTORI-095 recorded ledger; never coined.
 *   - Every anomaly is a structured finding (stage id + artifact id +
 *     remediation code). A failed stage stays visible; a broken run or a
 *     verdict that disagrees with the scenario's expectation exits non-zero.
 */
"use strict";

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  portableRelativePath,
  repoRelativePath,
  sha256OfBytes,
} from "../itotori-fixture-iteration/iteration.mjs";
import { assertSchemaValid as assertLoopStageValid } from "../itotori-fixture-iteration/schema-validate.mjs";
import {
  composeIterationFixture,
  CROSS_STAGE_ORDER,
  listPublicInputs,
  loadIterationFixtureInputs,
  REPO_ROOT,
  validateIterationFixture,
} from "./iteration-fixture.mjs";
import { assertSchemaValid as assertCrossValid } from "./schema-validate.mjs";

const SCENARIOS_DIR = join(REPO_ROOT, "suite", "scripts", "itotori-iteration-fixture", "scenarios");
const DEFAULT_SCENARIO = "success";
const DEFAULT_OUT_BASE = join(REPO_ROOT, "artifacts", "itotori", "iteration-fixture");

const LOOP_STAGE_ORDER = ["import", "draft", "qa", "export", "feedback", "rerun"];
const ALL_STAGE_ORDER = [...LOOP_STAGE_ORDER, ...CROSS_STAGE_ORDER];

function usage() {
  return [
    "usage: node suite/scripts/itotori-iteration-fixture/run.mjs [options]",
    "",
    "Options:",
    "  --scenario <NAME|PATH>   recorded scenario: success | qa-finding |",
    "                           runtime-feedback | patch-failure |",
    "                           provider-fallback | context-correction-rerun, or a path",
    "                           (default: success)",
    "  --out-dir <PATH>         emitted artifact dir",
    "                           (default artifacts/itotori/iteration-fixture/<scenario>)",
    "  --now <ISO>              fixed generatedAt timestamp (determinism)",
    "  --dry-run                print the iteration plan and exit 0; emit nothing",
    "  --list-inputs            print the public input files and exit 0",
    "  -h, --help               print this help",
  ].join("\n");
}

function resolveScenarioPath(value) {
  if (value.includes("/") || value.endsWith(".json")) {
    return resolvePath(value);
  }
  return join(SCENARIOS_DIR, `${value}.json`);
}

function parseArgs(argv) {
  const args = {
    scenario: DEFAULT_SCENARIO,
    outDir: undefined,
    now: undefined,
    dryRun: false,
    listInputs: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} requires a value`);
      return v;
    };
    switch (arg) {
      case "--scenario":
        args.scenario = next();
        break;
      case "--out-dir":
        args.outDir = resolvePath(next());
        break;
      case "--now":
        args.now = next();
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--list-inputs":
        args.listInputs = true;
        break;
      case "-h":
      case "--help":
        process.stdout.write(`${usage()}\n`);
        process.exit(0);
        break;
      default:
        throw new Error(`unknown flag: ${arg}\n\n${usage()}`);
    }
  }
  return args;
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Write an emitted artifact + return its repo-relative path and sha256. */
function emit(outDir, filename, value) {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  const path = join(outDir, filename);
  writeFileSync(path, bytes);
  return { filename, path, hash: sha256OfBytes(Buffer.from(bytes, "utf8")) };
}

function projectForStage(stageId) {
  if (stageId === "patch-result") return "kaifuu";
  if (stageId === "runtime-observation") return "utsushi";
  return "itotori";
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const scenarioPath = resolveScenarioPath(args.scenario);
  const scenarioName = args.scenario.includes("/") ? "custom" : args.scenario;
  const outDir = args.outDir ?? join(DEFAULT_OUT_BASE, scenarioName);

  if (args.listInputs || args.dryRun) {
    const inputs = loadIterationFixtureInputs({ scenarioPath });
    if (args.listInputs) {
      process.stdout.write(`${listPublicInputs(inputs).join("\n")}\n`);
      return 0;
    }
    process.stdout.write("[itotori:iteration-fixture] --dry-run iteration plan:\n");
    process.stdout.write(`  scenario: ${inputs.recording.scenario ?? scenarioName}\n`);
    process.stdout.write("  inputs (public recorded fixtures only):\n");
    for (const uri of listPublicInputs(inputs)) process.stdout.write(`    - ${uri}\n`);
    process.stdout.write(`  stages: ${ALL_STAGE_ORDER.join(" -> ")} -> iteration-fixture-result\n`);
    process.stdout.write(
      `  emit -> ${repoRelativePath(outDir)}/{${ALL_STAGE_ORDER.join(",")},iteration-fixture-result}.json\n`,
    );
    return 0;
  }

  const inputs = loadIterationFixtureInputs({ scenarioPath });
  const composed = composeIterationFixture(inputs, { now: args.now ?? new Date() });
  const { verdict, crossFindings, billedMicrosUsd } = validateIterationFixture(composed);

  // Assemble every finding: input-hash + Itotori loop + cross-tool.
  const allFindings = [
    ...inputs.hashFindings,
    ...composed.loopValidation.findings,
    ...crossFindings,
  ];

  // Distribute the findings to their stage so each emitted stage artifact
  // carries its own diagnostics; the manifest carries all of them.
  const byStage = new Map();
  for (const f of allFindings) {
    if (!byStage.has(f.stageId)) byStage.set(f.stageId, []);
    byStage.get(f.stageId).push(f);
  }
  for (const s of composed.loop.stageResults) s.findings = byStage.get(s.stageId) ?? [];
  composed.patchResultStage.findings = byStage.get("patch-result") ?? [];
  composed.runtimeObservationStage.findings = byStage.get("runtime-observation") ?? [];

  // Expected-verdict gate: a recorded scenario declares the verdict it must
  // produce. A mismatch is a blocking, manifest-level diagnostic.
  const expectedVerdict = composed.manifest.expectedVerdict;
  let finalVerdict = verdict;
  if (expectedVerdict !== null && expectedVerdict !== undefined && verdict !== expectedVerdict) {
    allFindings.push({
      code: "iteration.verdict_mismatch",
      severity: "blocking",
      stageId: "final-result",
      artifactId: composed.manifest.fixtureId ?? "iteration-fixture-result",
      remediation: "reconcile-recorded-scenario-with-expected-verdict",
      message: `iteration verdict '${verdict}' disagrees with the scenario's expectedVerdict '${expectedVerdict}'`,
    });
    finalVerdict = "broken";
  }

  mkdirSync(outDir, { recursive: true });

  // Emit the six Itotori loop stage artifacts (ITOTORI-095 stage schema).
  const emitted = [];
  for (const s of composed.loop.stageResults) {
    assertLoopStageValid("stage-result", s);
    const e = emit(outDir, `${s.stageId}.json`, s);
    emitted.push({ stageId: s.stageId, project: "itotori", ...e });
  }
  // Emit the two cross-tool stage artifacts (Kaifuu + Utsushi).
  for (const s of [composed.patchResultStage, composed.runtimeObservationStage]) {
    assertCrossValid("cross-stage", s);
    const e = emit(outDir, `${s.stageId}.json`, s);
    emitted.push({ stageId: s.stageId, project: s.project, ...e });
  }

  const allStages = [
    ...composed.loop.stageResults,
    composed.patchResultStage,
    composed.runtimeObservationStage,
  ];
  const blocking = allFindings.filter((f) => f.severity === "blocking");

  // The SHARED-025 manifest is the index over every per-stage artifact: each
  // stage's contentHash + each emitted file's byte hash (hash-addressing). The
  // manifest is not listed in its own emittedArtifacts (mirrors ITOTORI-095).
  const manifest = {
    ...composed.manifest,
    billedMicrosUsd,
    stages: allStages.map((s) => ({
      stageId: s.stageId,
      project: projectForStage(s.stageId),
      artifactId: s.artifactId,
      contentHash: s.contentHash,
      status: s.status,
      providerProofId: s.providerProofId ?? null,
    })),
    emittedArtifacts: emitted.map((e) => ({
      role: e.stageId,
      project: e.project,
      path: portableRelativePath(outDir, e.path),
      hash: e.hash,
    })),
    verdict: finalVerdict,
    findingCount: allFindings.length,
    blockingFindingCount: blocking.length,
    findings: allFindings,
  };
  assertCrossValid("iteration-fixture-result", manifest);
  writeJson(join(outDir, "iteration-fixture-result.json"), manifest);

  for (const f of allFindings) {
    process.stdout.write(
      `[itotori:iteration-fixture] finding [${f.severity}] ${f.code} (${f.stageId}/${f.artifactId}) remediation=${f.remediation}: ${f.message}\n`,
    );
  }
  process.stdout.write(
    `[itotori:iteration-fixture] scenario=${scenarioName} verdict=${finalVerdict} fixture=${manifest.fixtureId} localeBranch=${manifest.localeBranchId} target=${manifest.targetLocale} patchResult=${manifest.patchResultId} runtimeReport=${manifest.runtimeReportId} billedMicrosUsd=${billedMicrosUsd} stages=${allStages.length}\n`,
  );
  process.stdout.write(
    `[itotori:iteration-fixture] emitted ${emitted.length + 1} artifacts under ${repoRelativePath(outDir)}\n`,
  );

  if (finalVerdict === "broken") {
    process.stderr.write(
      `[itotori:iteration-fixture] FAILED: verdict=broken (${blocking.length} blocking finding(s)) — see ${repoRelativePath(join(outDir, "iteration-fixture-result.json"))}\n`,
    );
    return 1;
  }
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main());
  } catch (error) {
    process.stderr.write(`[itotori:iteration-fixture] FAILED: ${error.message}\n`);
    process.exit(1);
  }
}

export { main };
