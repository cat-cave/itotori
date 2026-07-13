/*
 * ITOTORI-028 — cross-tool composition + diagnostics core unit tests.
 * `node --test`.
 *
 * Exercises the PURE composition engine directly (no disk writes, no driver):
 * that the Itotori loop is composed VERBATIM from the ITOTORI-095 engine, that
 * the Kaifuu patch-result + Utsushi runtime-observation cross stages are
 * schema-valid and bound to the iteration's source revision, the verdict
 * folding across the three engines, and the cross-tool guardrails
 * (source-revision linkage, patch failure, runtime regression, provider
 * fallback, no leaked prompts).
 */
"use strict";

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertSchemaValid as assertLoopStageValid } from "../itotori-fixture-iteration/schema-validate.mjs";
import {
  composeIterationFixture,
  loadIterationFixtureInputs,
  validateIterationFixture,
} from "./iteration-fixture.mjs";
import { assertSchemaValid as assertCrossValid } from "./schema-validate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCENARIOS = join(HERE, "scenarios");
const NOW = "2026-06-30T00:00:00.000Z";

function load(scenario) {
  return loadIterationFixtureInputs({ scenarioPath: join(SCENARIOS, `${scenario}.json`) });
}

function run(scenario) {
  const inputs = load(scenario);
  const composed = composeIterationFixture(inputs, { now: NOW });
  const validated = validateIterationFixture(composed);
  return { inputs, composed, ...validated };
}

test("the Itotori loop is composed VERBATIM from the ITOTORI-095 engine (six schema-valid stages)", () => {
  const { composed } = run("success");
  assert.deepEqual(
    composed.loop.stageResults.map((s) => s.stageId),
    ["import", "draft", "qa", "export", "feedback", "rerun"],
  );
  for (const s of composed.loop.stageResults) assertLoopStageValid("stage-result", s);
  // The loop verdict comes straight from ITOTORI-095's validateIteration.
  assert.equal(composed.loopValidation.verdict, "complete");
});

test("the two cross-tool stages are schema-valid and bound to the iteration source revision", () => {
  const { composed } = run("success");
  for (const s of [composed.patchResultStage, composed.runtimeObservationStage]) {
    assertCrossValid("cross-stage", s);
    assert.equal(s.sourceRevision.sourceBridgeId, composed.sourceRevision.sourceBridgeId);
    assert.equal(s.sourceRevision.sourceBundleHash, composed.sourceRevision.sourceBundleHash);
  }
  assert.equal(composed.patchResultStage.project, "kaifuu");
  assert.equal(composed.runtimeObservationStage.project, "utsushi");
  assert.equal(composed.runtimeObservationStage.targetLocale, composed.targetLocale);
});

test("success: no blocking findings -> verdict complete; billed cost is the verbatim ITOTORI-095 sum", () => {
  const { verdict, billedMicrosUsd, crossFindings } = run("success");
  assert.equal(verdict, "complete");
  assert.equal(billedMicrosUsd, 32);
  assert.equal(crossFindings.filter((f) => f.severity === "blocking").length, 0);
});

test("patch-failure: a non-passed Kaifuu patch status folds the run to broken with a structured finding", () => {
  const { verdict, crossFindings } = run("patch-failure");
  assert.equal(verdict, "broken");
  const f = crossFindings.find((x) => x.code === "patch.failed");
  assert.ok(f);
  assert.equal(f.severity, "blocking");
  assert.equal(f.stageId, "patch-result");
  assert.ok(f.remediation.length > 0);
});

test("provider-fallback: a served!=requested provider is a non-blocking diagnostic; verdict stays complete", () => {
  const { verdict, crossFindings } = run("provider-fallback");
  assert.equal(verdict, "complete");
  const f = crossFindings.find((x) => x.code === "provider.fallback_used");
  assert.ok(f);
  assert.equal(f.severity, "warn");
  assert.equal(f.stageId, "draft");
});

test("source-revision linkage: a Utsushi artifact on a different source revision is a blocking finding", () => {
  const inputs = load("success");
  // Tamper the loaded Utsushi runtime report so it claims a different source
  // bundle hash than the Itotori iteration; the cross-tool anchor must fire.
  inputs.runtimeReport.content.sourceBundleHash = `sha256:${"f".repeat(64)}`;
  const composed = composeIterationFixture(inputs, { now: NOW });
  const { verdict, crossFindings } = validateIterationFixture(composed);
  assert.equal(verdict, "broken");
  const f = crossFindings.find(
    (x) => x.code === "linkage.source_revision_mismatch" && x.stageId === "runtime-observation",
  );
  assert.ok(f);
});

test("hash-addressing: a drifted recorded expectedHash is a blocking finding from the loader", () => {
  // Pristine inputs hash-match: no findings.
  const pristine = load("success");
  assert.equal(pristine.hashFindings.length, 0);

  // A scenario whose recorded patch-result expectedHash drifts from the real
  // file bytes must produce a blocking content_hash_mismatch from the loader.
  const dir = mkdtempSync(join(tmpdir(), "itotori-iteration-fixture-core-"));
  try {
    const scenario = JSON.parse(readFileSync(join(SCENARIOS, "success.json"), "utf8"));
    scenario.patchResult.expectedHash = `sha256:${"0".repeat(64)}`;
    const tamperedPath = join(dir, "tampered.json");
    writeFileSync(tamperedPath, `${JSON.stringify(scenario, null, 2)}\n`);
    const tampered = loadIterationFixtureInputs({ scenarioPath: tamperedPath });
    const f = tampered.hashFindings.find((x) => x.code === "linkage.content_hash_mismatch");
    assert.ok(f, "loader must flag a drifted expectedHash");
    assert.equal(f.severity, "blocking");
    assert.equal(f.stageId, "patch-result");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no raw prompts or raw provider responses appear in any composed cross-tool stage", () => {
  const { composed } = run("success");
  for (const s of [composed.patchResultStage, composed.runtimeObservationStage]) {
    const serialized = JSON.stringify(s);
    assert.ok(!/prompt/i.test(serialized), `${s.stageId} leaked a prompt`);
    assert.ok(!/messages"\s*:/.test(serialized), `${s.stageId} leaked raw messages`);
  }
});

test("manifest skeleton carries the cross-tool ids, ledger linkage, and the composed loop verdict", () => {
  const { composed } = run("success");
  const m = composed.manifest;
  assert.equal(m.command, "vp run itotori:iteration-fixture");
  assert.equal(m.patchResultId, composed.patchResultStage.artifactId);
  assert.equal(m.runtimeReportId, composed.runtimeObservationStage.artifactId);
  assert.match(m.iteration.providerLedger.hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(m.iteration.verdict, "complete");
  assert.ok(m.providerProofIds.length >= 2);
});
