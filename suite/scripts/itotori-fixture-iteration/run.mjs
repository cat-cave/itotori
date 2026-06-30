#!/usr/bin/env node
/*
 * ITOTORI-095 — `pnpm exec vp run itotori:fixture-iteration`
 *
 * Durable CI proof command that runs PUBLIC RECORDED inputs through one full
 * Itotori iteration and emits a schema-valid, hash-addressed artifact for
 * every stage:
 *
 *   import -> draft -> QA -> reviewer action -> export -> feedback import ->
 *   targeted rerun -> final result
 *
 * It COMPOSES the existing Itotori seams (it threads their recorded public
 * outputs + reads the (model, provider) pair / cost / token usage verbatim
 * from a recorded provider-proof ledger) — it does NOT re-implement any stage.
 *
 * Emitted under artifacts/itotori/fixture-iteration/<scenario>/:
 *   - import.json, draft.json, qa.json, reviewer.json,
 *     export.json, feedback.json, rerun.json   (per-stage FixtureIterationResult)
 *   - fixture-iteration-result.json            (the iteration manifest, SHARED-025)
 *
 * Hard contracts:
 *   - PUBLIC RECORDED fixtures ONLY (no private corpora, no live creds, no raw
 *     prompts / responses).
 *   - Cost is read verbatim from the recorded ledger; never coined.
 *   - Every anomaly is a structured finding (stage id + artifact id +
 *     remediation code); a failed stage stays visible; a broken iteration or a
 *     verdict that disagrees with the scenario's expectation exits non-zero.
 */
"use strict";

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { assertSchemaValid } from "./schema-validate.mjs";
import {
  assertPublicInputPath,
  composeIteration,
  listPublicInputs,
  loadIterationInputs,
  portableRelativePath,
  REPO_ROOT,
  repoRelativePath,
  sha256OfBytes,
  STAGE_ORDER,
  validateIteration,
} from "./iteration.mjs";

const SCENARIOS_DIR = join(REPO_ROOT, "suite", "scripts", "itotori-fixture-iteration", "scenarios");
const DEFAULT_SCENARIO = "success";
const DEFAULT_OUT_BASE = join(REPO_ROOT, "artifacts", "itotori", "fixture-iteration");

function usage() {
  return [
    "usage: node suite/scripts/itotori-fixture-iteration/run.mjs [options]",
    "",
    "Options:",
    "  --scenario <NAME|PATH>   recorded scenario: success | qa-rejection |",
    "                           runtime-feedback | rerun-repair, or a path",
    "                           (default: success)",
    "  --out-dir <PATH>         emitted artifact dir",
    "                           (default artifacts/itotori/fixture-iteration/<scenario>)",
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
function emit(outDir, filename, role, value) {
  assertSchemaValid(role, value);
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  const path = join(outDir, filename);
  writeFileSync(path, bytes);
  return { role, filename, path, hash: sha256OfBytes(Buffer.from(bytes, "utf8")) };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const scenarioPath = resolveScenarioPath(args.scenario);
  const scenarioName = args.scenario.includes("/") ? "custom" : args.scenario;
  const outDir = args.outDir ?? join(DEFAULT_OUT_BASE, scenarioName);

  if (args.listInputs || args.dryRun) {
    const inputs = loadIterationInputs({ scenarioPath });
    for (const uri of listPublicInputs(inputs)) assertPublicInputPath(uri);
    if (args.listInputs) {
      process.stdout.write(`${listPublicInputs(inputs).join("\n")}\n`);
      return 0;
    }
    process.stdout.write("[itotori:fixture-iteration] --dry-run iteration plan:\n");
    process.stdout.write(`  scenario: ${inputs.recording.scenario ?? scenarioName}\n`);
    process.stdout.write("  inputs (public recorded fixtures only):\n");
    for (const uri of listPublicInputs(inputs)) process.stdout.write(`    - ${uri}\n`);
    process.stdout.write(`  stages: ${STAGE_ORDER.join(" -> ")} -> final-result\n`);
    process.stdout.write(
      `  emit -> ${repoRelativePath(outDir)}/{${STAGE_ORDER.join(",")},fixture-iteration-result}.json\n`,
    );
    return 0;
  }

  const inputs = loadIterationInputs({ scenarioPath });
  for (const uri of listPublicInputs(inputs)) assertPublicInputPath(uri);

  const composed = composeIteration(inputs, { now: args.now ?? new Date() });
  const { verdict, findings, billedMicrosUsd } = validateIteration(composed);
  const allFindings = [...inputs.hashFindings, ...findings];

  // Distribute the resolved findings to their stage so each emitted stage
  // artifact carries its own diagnostics; the manifest carries all of them.
  const byStage = new Map();
  for (const f of allFindings) {
    if (!byStage.has(f.stageId)) byStage.set(f.stageId, []);
    byStage.get(f.stageId).push(f);
  }
  for (const s of composed.stageResults) {
    s.findings = byStage.get(s.stageId) ?? [];
  }

  // Expected-verdict gate: a recorded scenario declares the verdict it must
  // produce. A mismatch is a blocking, manifest-level diagnostic.
  const expectedVerdict = composed.manifest.expectedVerdict;
  let finalVerdict = verdict;
  if (expectedVerdict !== null && expectedVerdict !== undefined && verdict !== expectedVerdict) {
    allFindings.push({
      code: "iteration.verdict_mismatch",
      severity: "blocking",
      stageId: "final-result",
      artifactId: composed.manifest.fixtureId ?? "fixture-iteration-result",
      remediation: "reconcile-recorded-scenario-with-expected-verdict",
      message: `iteration verdict '${verdict}' disagrees with the scenario's expectedVerdict '${expectedVerdict}'`,
    });
    finalVerdict = "broken";
  }

  mkdirSync(outDir, { recursive: true });

  const emitted = [];
  for (const s of composed.stageResults) {
    emitted.push(emit(outDir, `${s.stageId}.json`, "stage-result", s));
  }

  const blocking = allFindings.filter((f) => f.severity === "blocking");
  // emittedArtifacts ties every per-stage artifact id to its on-disk file hash
  // (hash-addressing for SHARED-025). The manifest is the index over them and
  // is not listed in its own emittedArtifacts (mirrors the alpha vertical).
  const manifest = {
    ...composed.manifest,
    billedMicrosUsd,
    stages: composed.stageResults.map((s) => ({
      stageId: s.stageId,
      artifactId: s.artifactId,
      contentHash: s.contentHash,
      status: s.status,
      providerProofId: s.providerProofId,
    })),
    emittedArtifacts: emitted.map((e) => ({
      role: e.role,
      path: portableRelativePath(outDir, e.path),
      hash: e.hash,
    })),
    verdict: finalVerdict,
    findingCount: allFindings.length,
    blockingFindingCount: blocking.length,
    findings: allFindings,
  };
  assertSchemaValid("iteration-result", manifest);
  writeJson(join(outDir, "fixture-iteration-result.json"), manifest);

  for (const f of allFindings) {
    process.stdout.write(
      `[itotori:fixture-iteration] finding [${f.severity}] ${f.code} (${f.stageId}/${f.artifactId}) remediation=${f.remediation}: ${f.message}\n`,
    );
  }
  process.stdout.write(
    `[itotori:fixture-iteration] scenario=${scenarioName} verdict=${finalVerdict} fixture=${manifest.fixtureId} localeBranch=${manifest.localeBranchId} target=${manifest.targetLocale} billedMicrosUsd=${billedMicrosUsd} stages=${composed.stageResults.length}\n`,
  );
  process.stdout.write(
    `[itotori:fixture-iteration] emitted ${emitted.length + 1} artifacts under ${repoRelativePath(outDir)}\n`,
  );

  if (finalVerdict === "broken") {
    process.stderr.write(
      `[itotori:fixture-iteration] FAILED: verdict=broken (${blocking.length} blocking finding(s)) — see ${repoRelativePath(join(outDir, "fixture-iteration-result.json"))}\n`,
    );
    return 1;
  }
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main());
  } catch (error) {
    process.stderr.write(`[itotori:fixture-iteration] FAILED: ${error.message}\n`);
    process.exit(1);
  }
}

export { main };
