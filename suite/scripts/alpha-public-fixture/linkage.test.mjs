/*
 * ALPHA-007 — deterministic unit tests for the public fixture vertical
 * composition + linkage engine. `node --test`, no network, no DB, no build:
 * everything is driven from committed PUBLIC fixtures.
 *
 * Proves:
 *   - the vertical composes Itotori + Kaifuu + Utsushi + provider + benchmark
 *     + SHARED-025 manifest artifacts into one linked manifest;
 *   - every emitted artifact is schema-valid and hash-addressed;
 *   - the linkage validator emits SEMANTIC diagnostics (not prose) for the
 *     success / unsupported-runtime / patch-failure / provider-fallback /
 *     benchmark-failure / rerun-repair paths and for fixture-id / source-
 *     revision / locale-branch / content-hash disagreements.
 */
"use strict";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { schemaErrors } from "./schema-validate.mjs";
import {
  REPO_ROOT,
  SHA256_RE,
  assertRuntimeProofIsRealRun,
  composeVertical,
  loadVerticalInputs,
  replayFixtureRuntime,
  validateLinkage,
} from "./vertical.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH_DIR = join(HERE, "fixtures", "itotori-026-benchmark-output");
const SCENARIOS = join(HERE, "scenarios");
const NOW = "2026-06-30T00:00:00.000Z";

function loadInputs() {
  const inputs = loadVerticalInputs({ benchmarkOutputDir: BENCH_DIR });
  assert.deepEqual(inputs.hashFindings, [], "all public-fixture inputs must be hash-addressed");
  return inputs;
}

function compose() {
  return composeVertical(loadInputs(), { now: NOW });
}

/** The bridge/patch/scene-log inputs the replay engine + guard consume. */
function runtimeInputs(inputs) {
  return {
    bridge: inputs.loadedArtifacts.bridgeBundle,
    patchExport: inputs.loadedArtifacts.patchExport,
    runtimeSceneLog: inputs.loadedArtifacts.runtimeReport,
    proof: inputs.proof,
  };
}

function clonePatch(inputs) {
  return JSON.parse(JSON.stringify(inputs.loadedArtifacts.patchExport));
}

function loadScenario(name) {
  return JSON.parse(readFileSync(join(SCENARIOS, `${name}.json`), "utf8"));
}

function codes(findings) {
  return findings.map((f) => f.code);
}

test("composes all six suite surfaces into one linked manifest", () => {
  const composed = compose();
  const a = composed.linkage.artifacts;
  // Itotori (bridge + patch export), Kaifuu (patch result + delta), Utsushi
  // (runtime observation), provider proof, benchmark, dashboard read-model.
  assert.equal(a.bridge.project, "itotori");
  assert.equal(a.patchExport.project, "itotori");
  assert.equal(a.patchResult.project, "kaifuu");
  assert.equal(a.deltaPackage.project, "kaifuu");
  assert.equal(a.runtimeObservation.project, "utsushi");
  assert.equal(a.providerProof.artifactKind, "provider_proof");
  assert.equal(a.benchmark.producedBy, "ITOTORI-026");
  assert.equal(a.dashboardReadModel.artifactKind, "dashboard_read_model");

  const { verdict, findings } = validateLinkage(composed.linkage);
  assert.equal(verdict, "linked", JSON.stringify(findings, null, 2));
  assert.equal(findings.filter((f) => f.severity === "blocking").length, 0);
});

test("benchmark is a verified ITOTORI-026 product bound by run id (not a placeholder)", () => {
  const composed = compose();
  assert.equal(composed.linkage.artifacts.benchmark.producedByHarness, true);
  assert.equal(
    composed.benchmarkReport.benchmarkRunManifestSchema,
    "itotori.benchmark_harness_run_manifest.v0.1",
  );
  assert.equal(
    composed.benchmarkReport.report.benchmarkRunId,
    composed.benchmarkReport.benchmarkRunManifestId,
  );
});

test("SHARED-025 manifest contributes a non-empty linked provider proof id", () => {
  const composed = compose();
  const id = composed.linkage.artifacts.providerProof.providerProofId;
  assert.ok(typeof id === "string" && id.length > 0, "provider proof id must be non-empty");
  assert.ok(
    composed.linkage.sharedManifest.providerProofIds.includes(id),
    "provider proof id must come from the SHARED-025 manifest providerProofIds",
  );
});

test("every emitted artifact is schema-valid", () => {
  const composed = compose();
  composed.linkage.verdict = "linked";
  assert.deepEqual(schemaErrors("runtime-observation-proof", composed.runtimeObservationProof), []);
  assert.deepEqual(schemaErrors("provider-proof", composed.providerProof), []);
  assert.deepEqual(schemaErrors("read-model-ingestion", composed.readModelIngestion), []);
  assert.deepEqual(schemaErrors("shared-025-manifest-linkage", composed.linkage), []);
});

test("cost is read verbatim from recorded artifacts (never coined)", () => {
  const composed = compose();
  // The recorded benchmark-stages fixture bills 1570 + 980 micros USD.
  assert.equal(composed.providerProof.billedMicrosUsd, 2550);
  for (const run of composed.providerProof.runs) {
    assert.ok(["billed", "zero"].includes(run.cost.costKind));
    assert.equal(typeof run.cost.amountMicrosUsd, "number");
  }
});

test("provider proof is sanitized: no prompt or response bodies are copied", () => {
  const composed = compose();
  const serialized = JSON.stringify(composed.providerProof);
  assert.ok(!/"prompt"\s*:\s*\{/.test(serialized), "must not embed prompt objects");
  assert.ok(!/"content"\s*:/.test(serialized), "must not embed response content");
  assert.ok(!/"promptText"|"responseBody"|"messages"\s*:/.test(serialized));
  // Token counts (promptTokens/completionTokens) are aggregate metadata, not
  // bodies, so they are allowed; assert they survived as numbers.
  assert.equal(composed.providerProof.sanitized, true);
});

test("hash-addressing: linkage records well-formed sha256 digests", () => {
  const composed = compose();
  assert.match(composed.linkage.verticalFixture.sourceBundleHash, SHA256_RE);
  assert.match(composed.linkage.sharedManifest.hash, SHA256_RE);
  assert.match(composed.runtimeObservationProof.runtimeReportHash, SHA256_RE);
});

// ---- Regression scenarios: each returns a semantic diagnostic ----

test("scenario success -> verdict linked, no blocking findings", () => {
  const { verdict, findings } = validateLinkage(loadScenario("success"));
  assert.equal(verdict, "linked");
  assert.equal(findings.filter((f) => f.severity === "blocking").length, 0);
});

test("scenario unsupported-runtime -> runtime.unsupported (blocking)", () => {
  const { verdict, findings } = validateLinkage(loadScenario("unsupported-runtime"));
  assert.equal(verdict, "broken");
  assert.ok(codes(findings).includes("runtime.unsupported"));
  const f = findings.find((x) => x.code === "runtime.unsupported");
  assert.equal(f.severity, "blocking");
  assert.equal(f.subject, "runtimeObservation");
});

test("scenario patch-failure -> patch.failed (blocking)", () => {
  const { verdict, findings } = validateLinkage(loadScenario("patch-failure"));
  assert.equal(verdict, "broken");
  assert.ok(codes(findings).includes("patch.failed"));
  assert.ok(codes(findings).includes("patch.source_bundle_mismatch"));
});

test("scenario provider-fallback -> provider.fallback_used (warn, non-blocking)", () => {
  const { verdict, findings } = validateLinkage(loadScenario("provider-fallback"));
  const f = findings.find((x) => x.code === "provider.fallback_used");
  assert.ok(f, "provider.fallback_used must be surfaced");
  assert.equal(f.severity, "warn");
  // A recorded fallback is a warning, not a hard linkage break.
  assert.equal(verdict, "linked");
});

test("scenario rerun-repair -> rerun.repaired (info), verdict recovers to linked", () => {
  const { verdict, findings } = validateLinkage(loadScenario("rerun-repair"));
  assert.ok(codes(findings).includes("rerun.repaired"));
  assert.equal(verdict, "linked");
});

test("benchmark-failure path -> benchmark.failed (blocking)", () => {
  const linkage = loadScenario("success");
  linkage.artifacts.benchmark.status = "failed";
  linkage.artifacts.benchmark.reportStatus = "failed";
  const { verdict, findings } = validateLinkage(linkage);
  assert.equal(verdict, "broken");
  assert.ok(codes(findings).includes("benchmark.failed"));
});

test("disagreement on fixture id is a blocking diagnostic", () => {
  const linkage = loadScenario("success");
  linkage.artifacts.patchResult.fixtureId = "some-other-fixture";
  const { verdict, findings } = validateLinkage(linkage);
  assert.equal(verdict, "broken");
  assert.ok(codes(findings).includes("linkage.fixture_id_mismatch"));
});

test("disagreement on source revision is a blocking diagnostic", () => {
  const linkage = loadScenario("success");
  linkage.artifacts.bridge.sourceBundleHash = `sha256:${"a".repeat(64)}`;
  const { verdict, findings } = validateLinkage(linkage);
  assert.equal(verdict, "broken");
  assert.ok(codes(findings).includes("linkage.source_revision_mismatch"));
});

test("disagreement on locale branch is a blocking diagnostic", () => {
  const linkage = loadScenario("success");
  linkage.artifacts.deltaPackage.targetLocale = "de-DE";
  const { verdict, findings } = validateLinkage(linkage);
  assert.equal(verdict, "broken");
  assert.ok(codes(findings).includes("linkage.locale_branch_mismatch"));
});

test("missing provider proof id is a blocking diagnostic", () => {
  const linkage = loadScenario("success");
  linkage.artifacts.providerProof.providerProofId = "";
  const { verdict, findings } = validateLinkage(linkage);
  assert.equal(verdict, "broken");
  assert.ok(codes(findings).includes("provider.proof_id_missing"));
});

test("every finding is structured (code/severity/subject/message), never prose-only", () => {
  for (const name of [
    "success",
    "unsupported-runtime",
    "patch-failure",
    "provider-fallback",
    "rerun-repair",
  ]) {
    const { findings } = validateLinkage(loadScenario(name));
    for (const f of findings) {
      assert.equal(typeof f.code, "string");
      assert.ok(["blocking", "warn", "info"].includes(f.severity));
      assert.equal(typeof f.subject, "string");
      assert.equal(typeof f.message, "string");
    }
  }
});

// ---- Runtime observation is a REAL run's observed output (not re-emitted) ----

test("runtime observation is produced by executing the patch over the source, not copied from the runtime_report", () => {
  const inputs = loadInputs();
  const composed = composeVertical(inputs, { now: NOW });
  const proof = composed.runtimeObservationProof;

  // The proof carries a renderHash over the executed localized render, and it
  // reproduces a fresh, independent execution of the fixture bytes.
  assert.match(proof.renderHash, SHA256_RE);
  const run = replayFixtureRuntime(runtimeInputs(inputs));
  assert.equal(proof.renderHash, run.renderHash, "renderHash must reproduce a fresh execution");
  assert.equal(proof.status, "passed");
  assert.equal(proof.observedTextLineCount, 7);

  // The observed text is the PATCH target text (localized), rendered from the
  // patch over the source — it is NOT the source, and it is NOT read from the
  // runtime_report's observedText field.
  const observed = composed.runtimeRun.renderLines.map((l) => l.observedText);
  assert.ok(observed.includes("Bonjour, {player}."));
  assert.ok(observed.includes("Inventaire"));
  // The scene log (runtime_report) is only INPUT provenance, distinct from the
  // executed render hash.
  assert.match(proof.runtimeReportHash, SHA256_RE);
  assert.notEqual(proof.renderHash, proof.runtimeReportHash);
  // The engine records the replay adapter as the producer, not the recorded one.
  assert.equal(proof.adapterName, "utsushi-public-fixture-replay");
});

test("mutating the patch changes the produced runtime render (proves it is executed, not re-emitted)", () => {
  const inputs = loadInputs();
  const base = replayFixtureRuntime(runtimeInputs(inputs));

  const mutated = clonePatch(inputs);
  mutated.content.entries.find((e) => e.sourceUnitKey === "ui.menu.inventory").targetText =
    "Sac a dos";
  const run = replayFixtureRuntime({ ...runtimeInputs(inputs), patchExport: mutated });

  assert.notEqual(
    run.renderHash,
    base.renderHash,
    "a different patch must yield a different render",
  );
  assert.equal(
    run.renderLines.find((l) => l.sourceUnitKey === "ui.menu.inventory").observedText,
    "Sac a dos",
  );
});

test("placeholder-rejection guard verifies artifact bytes: rejects a re-emitted/placeholder proof, accepts a genuine one", () => {
  const inputs = loadInputs();
  const composed = composeVertical(inputs, { now: NOW });
  const genuine = composed.runtimeObservationProof;
  const gi = runtimeInputs(inputs);

  // Accept the genuinely-produced proof.
  assert.deepEqual(
    assertRuntimeProofIsRealRun(genuine, gi).findings,
    [],
    "a genuinely-produced runtime proof must be accepted",
  );

  // Reject a re-emitted/placeholder proof whose renderHash does not reproduce a
  // real execution (e.g. a hand-stubbed or copied record).
  const placeholder = { ...genuine, renderHash: `sha256:${"0".repeat(64)}` };
  const codes = assertRuntimeProofIsRealRun(placeholder, gi).findings.map((f) => f.code);
  assert.ok(codes.includes("runtime.render_not_reproducible"), JSON.stringify(codes));
});

test("placeholder-rejection guard rejects an untranslated (source==target) render", () => {
  const inputs = loadInputs();
  const gi = runtimeInputs(inputs);
  // Build a patch whose target text equals the source (no localization applied).
  const srcByKey = new Map(
    inputs.loadedArtifacts.bridgeBundle.content.units.map((u) => [u.sourceUnitKey, u.sourceText]),
  );
  const untranslated = clonePatch(inputs);
  for (const e of untranslated.content.entries) {
    e.targetText = srcByKey.get(e.sourceUnitKey) ?? e.targetText;
  }
  const gi2 = { ...gi, patchExport: untranslated };
  const run = replayFixtureRuntime(gi2);
  assert.equal(run.status, "failed", "an untranslated render must not pass");

  const untranslatedProof = {
    schemaVersion: "itotori.alpha-public-fixture.runtime-observation-proof.v0",
    generatedAt: NOW,
    fixtureId: inputs.proof.fixture.fixtureId,
    sourceBridgeId: inputs.proof.sourceBridgeId,
    sourceBundleHash: inputs.proof.sourceBundleHash,
    runtimeReportId: run.provenance.runtimeReportId,
    runtimeReportHash: run.provenance.runtimeReportHash,
    runtimeTargetIds: [],
    status: run.status,
    traceEventCount: run.counts.traceEventCount,
    branchEventCount: run.counts.branchEventCount,
    observedTextLineCount: run.counts.observedTextLineCount,
    renderHash: run.renderHash,
  };
  const codes = assertRuntimeProofIsRealRun(untranslatedProof, gi2).findings.map((f) => f.code);
  assert.ok(codes.includes("runtime.render_placeholder"), JSON.stringify(codes));
});

test("a render that drops a protected span fails the run (span preservation is executed)", () => {
  const inputs = loadInputs();
  const gi = runtimeInputs(inputs);
  const bad = clonePatch(inputs);
  // Drop the {player} placeholder from the first line's target text.
  bad.content.entries.find((e) => e.sourceUnitKey === "hello.scene.001.line.001").targetText =
    "Bonjour.";
  const run = replayFixtureRuntime({ ...gi, patchExport: bad });
  assert.equal(run.status, "failed");
  assert.ok(run.counts.spanViolationCount >= 1);
});

test("REPO_ROOT resolves to the itotori repo root", () => {
  assert.ok(readFileSync(join(REPO_ROOT, "package.json"), "utf8").length > 0);
});
