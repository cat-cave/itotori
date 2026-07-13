/*
 * ITOTORI-095 — composition + diagnostics core unit tests. `node --test`.
 *
 * Exercises the PURE iteration engine directly (no disk, no driver): every
 * stage's identity/cost projection, the structured-finding semantics, the
 * four verdict paths, and the guardrails (missing stage, locale-branch
 * conflation, recorded-cost integrity, schema validity of every emitted body).
 */
"use strict";

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertSchemaValid } from "./schema-validate.mjs";
import {
  composeIteration,
  loadIterationInputs,
  STAGE_ORDER,
  validateIteration,
} from "./iteration.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCENARIOS = join(HERE, "scenarios");
const NOW = "2026-06-30T00:00:00.000Z";

function load(scenario) {
  return loadIterationInputs({
    scenarioPath: join(SCENARIOS, `${scenario}.json`),
  });
}

function run(scenario) {
  const inputs = load(scenario);
  const composed = composeIteration(inputs, { now: NOW });
  const validated = validateIteration(composed);
  return { inputs, composed, ...validated };
}

test("recorded ledger is read from a public fixtures/ path", () => {
  const inputs = load("success");
  assert.match(inputs.ledgerUri, /^fixtures\//);
  assert.match(inputs.ledgerHash, /^sha256:[a-f0-9]{64}$/);
  assert.ok(inputs.ledgerByRole.has("draft"));
  assert.ok(inputs.ledgerByRole.has("qa"));
});

test("compose produces exactly the six ordered stages, each schema-valid", () => {
  const { composed } = run("success");
  assert.deepEqual(
    composed.stageResults.map((s) => s.stageId),
    STAGE_ORDER,
  );
  for (const s of composed.stageResults) {
    assertSchemaValid("stage-result", s); // throws if invalid
  }
});

test("provider-backed stages surface verbatim recorded cost; non-provider stages carry null cost", () => {
  const { composed } = run("success");
  const draft = composed.stageResults.find((s) => s.stageId === "draft");
  const qa = composed.stageResults.find((s) => s.stageId === "qa");
  const importStage = composed.stageResults.find((s) => s.stageId === "import");
  assert.equal(draft.cost.amountMicrosUsd, 12);
  assert.equal(draft.cost.costKind, "billed");
  assert.equal(qa.cost.amountMicrosUsd, 20);
  assert.equal(importStage.cost, null);
  assert.equal(importStage.providerProofId, null);
});

test("complete path: no blocking findings -> verdict complete; billed cost is the verbatim sum", () => {
  const { verdict, billedMicrosUsd, findings } = run("success");
  assert.equal(verdict, "complete");
  assert.equal(billedMicrosUsd, 32);
  assert.equal(findings.filter((f) => f.severity === "blocking").length, 0);
});

test("QA finding path remains blocked until canonical context correction starts an iteration", () => {
  const { verdict, findings } = run("qa-finding");
  assert.equal(verdict, "blocked");
  assert.ok(findings.some((f) => f.code === "qa.defect_found" && f.severity === "blocking"));
  assert.equal(findings.filter((f) => f.severity === "blocking").length, 1);
});

test("context-correction rerun path clears the QA finding", () => {
  const { verdict, findings } = run("context-correction-rerun");
  assert.equal(verdict, "repaired");
  assert.ok(findings.some((f) => f.code === "rerun.repaired" && f.severity === "info"));
  assert.equal(findings.filter((f) => f.severity === "blocking").length, 0);
});

test("a missing stage recording is a blocking finding -> verdict broken (no silent skip)", () => {
  const inputs = load("success");
  delete inputs.recording.stages.feedback;
  const composed = composeIteration(inputs, { now: NOW });
  const { verdict, findings } = validateIteration(composed);
  assert.equal(verdict, "broken");
  const missing = findings.find((f) => f.code === "iteration.stage_missing");
  assert.ok(missing);
  assert.equal(missing.stageId, "feedback");
  assert.equal(missing.severity, "blocking");
  // The feedback stage is still emitted (as a visible 'missing' artifact).
  const feedback = composed.stageResults.find((s) => s.stageId === "feedback");
  assert.equal(feedback.status, "missing");
  assertSchemaValid("stage-result", feedback);
});

test("locale-branch conflation (059) on any stage is a blocking diagnostic -> broken", () => {
  const inputs = load("success");
  inputs.recording.stages.export.localeBranchId = "locale-branch-WRONG";
  const composed = composeIteration(inputs, { now: NOW });
  const { verdict, findings } = validateIteration(composed);
  assert.equal(verdict, "broken");
  const mismatch = findings.find((f) => f.code === "linkage.locale_branch_mismatch");
  assert.ok(mismatch);
  assert.equal(mismatch.stageId, "export");
});

test("recorded cost integrity: a fabricated token source is a blocking finding (assertReportedTokenUsage)", () => {
  const inputs = load("success");
  // Tamper the in-memory recorded ledger entry to use a forbidden token source.
  const draftEntry = { ...inputs.ledgerByRole.get("draft"), tokenCountSource: "estimated" };
  inputs.ledgerByRole.set("draft", draftEntry);
  const composed = composeIteration(inputs, { now: NOW });
  const { verdict, findings } = validateIteration(composed);
  assert.equal(verdict, "broken");
  assert.ok(findings.some((f) => f.code === "provider.token_count_not_real"));
});

test("no raw prompts or raw provider responses appear in any emitted stage artifact", () => {
  const { composed } = run("success");
  for (const s of composed.stageResults) {
    const serialized = JSON.stringify(s);
    assert.ok(!/prompt/i.test(serialized), `${s.stageId} leaked a prompt`);
    assert.ok(!/messages"\s*:/.test(serialized), `${s.stageId} leaked raw messages`);
  }
});
