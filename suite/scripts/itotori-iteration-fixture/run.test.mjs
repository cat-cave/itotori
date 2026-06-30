/*
 * ITOTORI-028 — driver integration tests. `node --test`.
 *
 * Runs the `itotori:iteration-fixture` driver OFFLINE over the committed
 * public recorded scenarios (no network, no DB, no rebuild, no creds). Proves
 * the end-to-end run composes the ITOTORI-095 Itotori loop with the Kaifuu
 * patch result + Utsushi runtime observation into ONE manifest-bound run,
 * emits a schema-valid + hash-addressed artifact for EVERY stage, surfaces the
 * patch-result id / runtime-report id / provider-proof ids / feedback ids /
 * rerun ids, proves all nine stages belong to the same fixture id + source
 * revision, and that every recorded path reaches its declared verdict with
 * structured diagnostics.
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

const LOOP_FILES = [
  "import.json",
  "draft.json",
  "qa.json",
  "reviewer.json",
  "export.json",
  "feedback.json",
  "rerun.json",
];
const CROSS_FILES = ["patch-result.json", "runtime-observation.json"];
const STAGE_FILES = [...LOOP_FILES, ...CROSS_FILES];
const ALL_FILES = [...STAGE_FILES, "iteration-fixture-result.json"];

function runDriver(extraArgs, outDir) {
  return spawnSync("node", [RUN, "--out-dir", outDir, "--now", NOW, ...extraArgs], {
    encoding: "utf8",
  });
}

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), "itotori-iteration-fixture-test-"));
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
  return JSON.parse(readFileSync(join(outDir, "iteration-fixture-result.json"), "utf8"));
}

function readJson(outDir, file) {
  return JSON.parse(readFileSync(join(outDir, file), "utf8"));
}

test("success: full Itotori-loop + Kaifuu + Utsushi composition exits 0 (accepted), emits all 10 artifacts", () => {
  withTmp((outDir) => {
    const result = runDriver([], outDir);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    for (const f of ALL_FILES)
      assert.ok(existsSync(join(outDir, f)), `missing emitted artifact ${f}`);
    assert.match(result.stdout, /verdict=accepted/);
    const m = readManifest(outDir);
    assert.equal(m.verdict, "accepted");
    assert.equal(m.command, "vp run itotori:iteration-fixture");
    assert.equal(m.stages.length, 9);
    assert.equal(m.emittedArtifacts.length, 9);
  });
});

test("the run threads ALL nine ordered stages across three engines; none are skipped", () => {
  withTmp((outDir) => {
    runDriver(["--scenario", "success"], outDir);
    const m = readManifest(outDir);
    assert.deepEqual(
      m.stages.map((s) => s.stageId),
      [
        "import",
        "draft",
        "qa",
        "reviewer",
        "export",
        "feedback",
        "rerun",
        "patch-result",
        "runtime-observation",
      ],
    );
    assert.deepEqual(
      m.stages.map((s) => s.project),
      [
        "itotori",
        "itotori",
        "itotori",
        "itotori",
        "itotori",
        "itotori",
        "itotori",
        "kaifuu",
        "utsushi",
      ],
    );
  });
});

test("every stage emits a schema-valid artifact carrying id + source revision + content hash", () => {
  withTmp((outDir) => {
    runDriver(["--scenario", "success"], outDir);
    for (const f of LOOP_FILES) {
      const s = readJson(outDir, f);
      assert.equal(s.schemaVersion, "itotori.fixture-iteration.stage-result.v0");
      assert.ok(s.artifactId.length > 0, `${f} missing artifactId`);
      assert.equal(s.sourceRevision.sourceBridgeId, "019ed012-0000-7000-8000-000000000001");
      assert.match(s.contentHash, /^sha256:[a-f0-9]{64}$/, `${f} content hash`);
    }
    for (const f of CROSS_FILES) {
      const s = readJson(outDir, f);
      assert.equal(s.schemaVersion, "itotori.iteration-fixture.cross-stage.v0");
      assert.ok(s.artifactId.length > 0, `${f} missing artifactId`);
      assert.match(s.sourceHash, /^sha256:[a-f0-9]{64}$/, `${f} source hash`);
      assert.match(s.contentHash, /^sha256:[a-f0-9]{64}$/, `${f} content hash`);
    }
  });
});

test("emitted artifacts are hash-addressed: manifest hashes equal the file bytes", () => {
  withTmp((outDir) => {
    runDriver(["--scenario", "success"], outDir);
    const m = readManifest(outDir);
    assert.equal(m.emittedArtifacts.length, 9);
    for (const entry of m.emittedArtifacts) {
      assert.equal(sha256(join(outDir, entry.path)), entry.hash, `hash drift for ${entry.path}`);
    }
  });
});

test("manifest surfaces patch-result id, runtime-report id, provider-proof ids, feedback ids, and rerun ids", () => {
  withTmp((outDir) => {
    runDriver(["--scenario", "success"], outDir);
    const m = readManifest(outDir);
    assert.equal(m.patchResultId, "019ed012-0000-7000-8000-000000000902");
    assert.equal(m.runtimeReportId, "019ed012-0000-7000-8000-000000000904");
    assert.deepEqual(m.providerProofIds, [
      "recorded:pp-draft-attempt-1",
      "recorded:pp-qa-attempt-0",
    ]);
    assert.deepEqual(m.feedbackIds, ["feedback:feedback-report-hello-game-ctx"]);
    assert.deepEqual(m.rerunIds, ["rerun:rerun-hello-game-noop"]);
  });
});

test("the manifest proves Itotori, Kaifuu, and Utsushi artifacts share ONE fixture id + source revision", () => {
  withTmp((outDir) => {
    runDriver(["--scenario", "success"], outDir);
    const m = readManifest(outDir);
    const patch = readJson(outDir, "patch-result.json");
    const runtime = readJson(outDir, "runtime-observation.json");
    // Source-revision anchor: every cross-tool stage shares the iteration's
    // sourceBridgeId + sourceBundleHash (the cryptographic binding).
    assert.equal(patch.sourceRevision.sourceBridgeId, m.sourceRevision.sourceBridgeId);
    assert.equal(patch.sourceRevision.sourceBundleHash, m.sourceRevision.sourceBundleHash);
    assert.equal(runtime.sourceRevision.sourceBridgeId, m.sourceRevision.sourceBridgeId);
    assert.equal(runtime.sourceRevision.sourceBundleHash, m.sourceRevision.sourceBundleHash);
    assert.equal(runtime.targetLocale, m.targetLocale);
    assert.equal(patch.fixtureId, m.fixtureId);
    assert.equal(runtime.fixtureId, m.fixtureId);
    // No cross-tool blocking linkage diagnostics on the success path.
    assert.equal(m.blockingFindingCount, 0);
  });
});

test("draft + QA cost/(model,provider)/tokens are composed VERBATIM from the ITOTORI-095 recorded ledger", () => {
  withTmp((outDir) => {
    runDriver(["--scenario", "success"], outDir);
    const draft = readJson(outDir, "draft.json");
    const qa = readJson(outDir, "qa.json");
    assert.equal(draft.providerProofId, "recorded:pp-draft-attempt-1");
    assert.equal(draft.pair.modelId, "deepseek/deepseek-v4-flash");
    assert.equal(draft.pair.providerId, "fireworks");
    assert.equal(draft.cost.amountMicrosUsd, 12);
    assert.equal(qa.cost.amountMicrosUsd, 20);
    const m = readManifest(outDir);
    assert.equal(m.billedMicrosUsd, 32); // 12 + 20, verbatim; cross-tool stages bill nothing
    assert.equal(m.iteration.verdict, "accepted");
  });
});

test("qa-rejection path -> rejected; the QA defect stays visible as a demoted rationale", () => {
  withTmp((outDir) => {
    const result = runDriver(["--scenario", "qa-rejection"], outDir);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const m = readManifest(outDir);
    assert.equal(m.verdict, "rejected");
    assert.ok(m.findings.some((f) => f.code === "qa.defect_found.rejected"));
    assert.ok(m.findings.some((f) => f.code === "reviewer.rejected"));
  });
});

test("runtime-feedback path -> repaired (feedback import -> reviewer -> runtime-validation rerun)", () => {
  withTmp((outDir) => {
    const result = runDriver(["--scenario", "runtime-feedback"], outDir);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const m = readManifest(outDir);
    assert.equal(m.verdict, "repaired");
    assert.ok(m.findings.some((f) => f.code === "feedback.runtime_issue.repaired"));
    assert.ok(m.findings.some((f) => f.code === "rerun.repaired"));
  });
});

test("rerun-repair path -> repaired; the rerun re-bills the recorded draft cost (12) -> 44 total", () => {
  withTmp((outDir) => {
    const result = runDriver(["--scenario", "rerun-repair"], outDir);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const m = readManifest(outDir);
    assert.equal(m.verdict, "repaired");
    assert.equal(m.blockingFindingCount, 0);
    assert.ok(m.findings.some((f) => f.code === "qa.defect_found.repaired"));
    assert.equal(m.billedMicrosUsd, 44);
  });
});

test("patch-failure path: Kaifuu patch status='failed' is a BLOCKING diagnostic -> broken, exit 1", () => {
  withTmp((outDir) => {
    const result = runDriver(["--scenario", "patch-failure"], outDir);
    assert.equal(result.status, 1, result.stdout);
    const m = readManifest(outDir);
    assert.equal(m.verdict, "broken");
    const f = m.findings.find((x) => x.code === "patch.failed");
    assert.ok(f, "patch.failed diagnostic must be present");
    assert.equal(f.stageId, "patch-result");
    assert.equal(f.remediation, "resolve-failing-patch-apply");
    // The failed patch-result stage is still emitted (a failed stage stays visible).
    assert.ok(existsSync(join(outDir, "patch-result.json")));
    assert.equal(readJson(outDir, "patch-result.json").status, "failed");
  });
});

test("provider-fallback path: OR fallback is a non-blocking diagnostic; cost is the recorded fallback cost", () => {
  withTmp((outDir) => {
    const result = runDriver(["--scenario", "provider-fallback"], outDir);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const m = readManifest(outDir);
    assert.equal(m.verdict, "accepted");
    assert.equal(m.blockingFindingCount, 0);
    const f = m.findings.find((x) => x.code === "provider.fallback_used");
    assert.ok(f, "provider.fallback_used diagnostic must be present");
    assert.equal(f.severity, "warn");
    assert.equal(f.stageId, "draft");
    assert.equal(m.billedMicrosUsd, 35); // 15 (draft, fallback) + 20 (qa), verbatim
  });
});

test("hash-addressing is enforced: a drifted cross-tool expectedHash -> broken with content_hash_mismatch", () => {
  withTmp((outDir) => {
    const scenario = JSON.parse(readFileSync(join(SCENARIOS, "success.json"), "utf8"));
    scenario.runtimeReport.expectedHash = `sha256:${"0".repeat(64)}`;
    const tampered = join(outDir, "tampered.json");
    writeFileSync(tampered, `${JSON.stringify(scenario, null, 2)}\n`);
    const result = runDriver(["--scenario", tampered], outDir);
    assert.equal(result.status, 1, result.stdout);
    const m = readManifest(outDir);
    assert.equal(m.verdict, "broken");
    assert.ok(m.findings.some((f) => f.code === "linkage.content_hash_mismatch"));
  });
});

test("a non-public cross-tool input path is refused (no private corpora)", () => {
  withTmp((outDir) => {
    const scenario = JSON.parse(readFileSync(join(SCENARIOS, "success.json"), "utf8"));
    scenario.patchResult.uri = "private-local/secret-patch-result.json";
    const tampered = join(outDir, "tampered.json");
    writeFileSync(tampered, `${JSON.stringify(scenario, null, 2)}\n`);
    const result = runDriver(["--scenario", tampered], outDir);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /refusing (non-public|private\/traversing) input path/);
  });
});

test("--dry-run makes zero writes and lists only public inputs", () => {
  withTmp((outDir) => {
    const result = runDriver(["--scenario", "success", "--dry-run"], outDir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /dry-run iteration plan/);
    for (const line of result.stdout.split("\n")) {
      const mm = line.match(/^\s+- (\S+)/);
      if (mm) {
        assert.ok(
          mm[1].startsWith("fixtures/") || mm[1].startsWith("suite/"),
          `non-public input listed: ${mm[1]}`,
        );
      }
    }
    for (const f of ALL_FILES) assert.ok(!existsSync(join(outDir, f)), `${f} must not be written`);
  });
});

test("--list-inputs prints only public fixture/suite paths (incl. the composed ITOTORI-095 inputs)", () => {
  withTmp((outDir) => {
    const result = runDriver(["--scenario", "success", "--list-inputs"], outDir);
    assert.equal(result.status, 0);
    const lines = result.stdout
      .trim()
      .split("\n")
      .filter((l) => l.startsWith("fixtures/") || l.startsWith("suite/"));
    assert.ok(
      lines.length >= 4,
      `expected the cross-tool + composed loop inputs, got ${lines.length}`,
    );
    for (const l of lines) assert.ok(!l.includes("private-local"));
    // The composed ITOTORI-095 provider ledger is among the listed public inputs.
    assert.ok(lines.some((l) => l.includes("provider-proof")));
  });
});
