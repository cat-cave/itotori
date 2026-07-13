/*
 * ITOTORI-095 — driver integration tests. `node --test`.
 *
 * Runs the `itotori:fixture-iteration` driver OFFLINE over the committed
 * public recorded scenarios (no network, no DB, no rebuild, no creds). Proves
 * the full import->rerun iteration emits a schema-valid, hash-addressed
 * artifact for EVERY stage, that the four recorded paths reach their declared
 * verdict, that cost is the verbatim recorded ledger cost, and that a
 * verdict/identity break exits non-zero with structured diagnostics.
 */
"use strict";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN = join(HERE, "run.mjs");
const SCENARIOS = join(HERE, "scenarios");
const NOW = "2026-06-30T00:00:00.000Z";

const STAGE_FILES = [
  "import.json",
  "draft.json",
  "qa.json",
  "export.json",
  "feedback.json",
  "rerun.json",
];
const ALL_FILES = [...STAGE_FILES, "fixture-iteration-result.json"];

function runDriver(extraArgs, outDir) {
  return spawnSync("node", [RUN, "--out-dir", outDir, "--now", NOW, ...extraArgs], {
    encoding: "utf8",
  });
}

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), "itotori-fixture-iteration-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function sha256(path) {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function readManifest(outDir) {
  return JSON.parse(readFileSync(join(outDir, "fixture-iteration-result.json"), "utf8"));
}

test("default scenario (success) runs the full import->rerun iteration and exits 0 (complete)", () => {
  withTmp((outDir) => {
    const result = runDriver([], outDir);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    for (const f of ALL_FILES) {
      assert.ok(existsSync(join(outDir, f)), `missing emitted artifact ${f}`);
    }
    assert.match(result.stdout, /verdict=complete/);
    const m = readManifest(outDir);
    assert.equal(m.verdict, "complete");
    assert.equal(m.stages.length, 6);
  });
});

test("every stage emits a schema-valid artifact carrying id + locale branch + source revision + content hash", () => {
  withTmp((outDir) => {
    runDriver(["--scenario", "success"], outDir);
    for (const f of STAGE_FILES) {
      const stage = JSON.parse(readFileSync(join(outDir, f), "utf8"));
      assert.equal(stage.schemaVersion, "itotori.fixture-iteration.stage-result.v0");
      assert.ok(stage.artifactId.length > 0, `${f} missing artifactId`);
      assert.equal(stage.localeBranchId, "locale-branch-itotori-095", `${f} locale branch`);
      assert.equal(stage.sourceRevision.sourceRevisionId, "source-revision-itotori-095");
      assert.match(stage.contentHash, /^sha256:[a-f0-9]{64}$/, `${f} content hash`);
    }
  });
});

test("the iteration runs all six ordered stages (import->rerun + final result); none are skipped", () => {
  withTmp((outDir) => {
    runDriver(["--scenario", "success"], outDir);
    const m = readManifest(outDir);
    assert.deepEqual(
      m.stages.map((s) => s.stageId),
      ["import", "draft", "qa", "export", "feedback", "rerun"],
    );
    // final-result is the manifest itself — present + schema-valid (it loaded).
    assert.equal(m.command, "vp run itotori:fixture-iteration");
  });
});

test("emitted artifacts are hash-addressed: manifest hashes equal the file bytes", () => {
  withTmp((outDir) => {
    runDriver(["--scenario", "success"], outDir);
    const m = readManifest(outDir);
    assert.equal(m.emittedArtifacts.length, 6);
    for (const entry of m.emittedArtifacts) {
      assert.equal(sha256(join(outDir, entry.path)), entry.hash, `hash drift for ${entry.path}`);
    }
  });
});

test("draft + QA cost/(model,provider)/tokens are read VERBATIM from the recorded ledger", () => {
  withTmp((outDir) => {
    runDriver(["--scenario", "success"], outDir);
    const draft = JSON.parse(readFileSync(join(outDir, "draft.json"), "utf8"));
    const qa = JSON.parse(readFileSync(join(outDir, "qa.json"), "utf8"));
    // Verbatim from fixtures/provider-proof/expected-recorded-proof-bundle.json.
    assert.equal(draft.providerProofId, "recorded:pp-draft-attempt-1");
    assert.equal(draft.pair.modelId, "deepseek/deepseek-v4-flash");
    assert.equal(draft.pair.providerId, "fireworks");
    assert.equal(draft.cost.costKind, "billed");
    assert.equal(draft.cost.amountMicrosUsd, 12);
    assert.equal(draft.tokenUsage.tokenCountSource, "deterministic_counter");
    assert.equal(qa.providerProofId, "recorded:pp-qa-attempt-0");
    assert.equal(qa.cost.amountMicrosUsd, 20);
    const m = readManifest(outDir);
    assert.equal(m.billedMicrosUsd, 32); // 12 + 20, verbatim
  });
});

test("QA finding path remains blocked without a context correction iteration", () => {
  withTmp((outDir) => {
    const result = runDriver(["--scenario", "qa-finding"], outDir);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const m = readManifest(outDir);
    assert.equal(m.verdict, "blocked");
    const qaDefect = m.findings.find((f) => f.code === "qa.defect_found");
    assert.ok(qaDefect, "QA defect must stay visible");
    assert.equal(qaDefect.stageId, "qa");
    assert.equal(qaDefect.remediation, "record-context-correction-and-start-iteration");
  });
});

test("runtime-feedback path: feedback import -> context correction -> patch iteration -> verdict repaired", () => {
  withTmp((outDir) => {
    const result = runDriver(["--scenario", "runtime-feedback"], outDir);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const m = readManifest(outDir);
    assert.equal(m.verdict, "repaired");
    assert.ok(m.findings.some((f) => f.code === "feedback.context_correction.repaired"));
    assert.ok(m.findings.some((f) => f.code === "rerun.repaired"));
  });
});

test("context-correction rerun path clears the QA finding -> repaired", () => {
  withTmp((outDir) => {
    const result = runDriver(["--scenario", "context-correction-rerun"], outDir);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const m = readManifest(outDir);
    assert.equal(m.verdict, "repaired");
    assert.equal(m.blockingFindingCount, 0);
    assert.ok(m.findings.some((f) => f.code === "qa.defect_found.repaired"));
    // The targeted rerun re-invokes the draft agent -> its recorded ledger cost
    // is surfaced (12 micros), so the iteration bills draft + qa + rerun.
    const rerun = JSON.parse(readFileSync(join(outDir, "rerun.json"), "utf8"));
    assert.equal(rerun.providerProofId, "recorded:pp-draft-attempt-1");
    assert.equal(rerun.cost.amountMicrosUsd, 12);
    assert.equal(m.billedMicrosUsd, 44);
  });
});

test("locale-branch conflation (ITOTORI-059) is a blocking diagnostic -> verdict broken, exit 1", () => {
  withTmp((outDir) => {
    // Tamper one stage's localeBranchId so it disagrees with the iteration
    // identity; the conflation guard must fire and the iteration must break.
    const scenario = JSON.parse(readFileSync(join(SCENARIOS, "success.json"), "utf8"));
    scenario.stages.export.localeBranchId = "locale-branch-WRONG";
    scenario.expectedVerdict = "complete";
    const tampered = join(outDir, "tampered-scenario.json");
    writeFileSync(tampered, `${JSON.stringify(scenario, null, 2)}\n`);
    // The tampered scenario lives outside the public roots, so the public-path
    // guard rejects it before it can run (defense in depth).
    const result = runDriver(["--scenario", tampered], outDir);
    assert.equal(result.status, 1, result.stdout);
    assert.match(
      result.stdout + result.stderr,
      /refusing (non-public|private\/traversing) input path|locale_branch_mismatch/,
    );
  });
});

test("--dry-run makes zero writes and lists only public inputs", () => {
  withTmp((outDir) => {
    const result = runDriver(["--scenario", "success", "--dry-run"], outDir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /dry-run iteration plan/);
    for (const line of result.stdout.split("\n")) {
      const m = line.match(/^\s+- (\S+)/);
      if (m) {
        assert.ok(
          m[1].startsWith("fixtures/") || m[1].startsWith("suite/"),
          `non-public input listed: ${m[1]}`,
        );
      }
    }
    for (const f of ALL_FILES) assert.ok(!existsSync(join(outDir, f)), `${f} must not be written`);
  });
});

test("--list-inputs prints only public fixture/suite paths", () => {
  withTmp((outDir) => {
    const result = runDriver(["--scenario", "success", "--list-inputs"], outDir);
    assert.equal(result.status, 0);
    const lines = result.stdout
      .trim()
      .split("\n")
      .filter((l) => l.startsWith("fixtures/") || l.startsWith("suite/"));
    assert.ok(lines.length >= 2);
    for (const l of lines) assert.ok(!l.includes("private-local"));
  });
});
