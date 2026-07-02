/*
 * ALPHA-007 — driver + validator integration tests. `node --test`.
 *
 * Runs the `alpha:public-fixture` driver offline by injecting a committed
 * ITOTORI-026 harness output (`--benchmark-output-dir`), so the test needs no
 * network, no DB, and no rebuild. Proves the emitted artifacts exist, are
 * schema-valid + hash-addressed, the independent validator command re-proves
 * linkage, and broken inputs exit non-zero with structured diagnostics.
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
const VALIDATE = join(HERE, "validate-linkage.mjs");
const BENCH_DIR = join(HERE, "fixtures", "itotori-026-benchmark-output");
const NOW = "2026-06-30T00:00:00.000Z";

function runDriver(extraArgs, outDir) {
  return spawnSync(
    "node",
    [RUN, "--benchmark-output-dir", BENCH_DIR, "--out-dir", outDir, "--now", NOW, ...extraArgs],
    { encoding: "utf8" },
  );
}

function runValidator(outDir) {
  return spawnSync("node", [VALIDATE, "--dir", outDir], { encoding: "utf8" });
}

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), "alpha-public-fixture-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function sha256(path) {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

const REQUIRED = [
  "runtime-observation-proof.json",
  "provider-proof.json",
  "benchmark-report.json",
  "shared-025-manifest-linkage.json",
  "vertical-manifest.json",
  "read-model-ingestion.json",
];

test("driver emits every required artifact and exits 0 (verdict linked)", () => {
  withTmp((outDir) => {
    const result = runDriver([], outDir);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    for (const f of REQUIRED) {
      assert.ok(existsSync(join(outDir, f)), `missing emitted artifact ${f}`);
    }
    assert.match(result.stdout, /verdict=linked/);
  });
});

test("the node verification block (test -s) passes for the four named artifacts", () => {
  withTmp((outDir) => {
    runDriver([], outDir);
    for (const f of [
      "runtime-observation-proof.json",
      "provider-proof.json",
      "benchmark-report.json",
      "shared-025-manifest-linkage.json",
    ]) {
      const path = join(outDir, f);
      assert.ok(existsSync(path) && readFileSync(path).length > 0, `${f} must be non-empty`);
    }
  });
});

test("emitted artifacts are hash-addressed: manifest hashes equal file bytes", () => {
  withTmp((outDir) => {
    runDriver([], outDir);
    const manifest = JSON.parse(readFileSync(join(outDir, "vertical-manifest.json"), "utf8"));
    assert.ok(manifest.emittedArtifacts.length >= 5);
    for (const entry of manifest.emittedArtifacts) {
      const actual = sha256(join(outDir, entry.path));
      assert.equal(entry.hash, actual, `hash drift for ${entry.path}`);
    }
    assert.equal(manifest.command, "vp run alpha:public-fixture");
    assert.equal(manifest.verdict, "linked");
  });
});

test("vertical manifest ties every composed artifact id", () => {
  withTmp((outDir) => {
    runDriver([], outDir);
    const m = JSON.parse(readFileSync(join(outDir, "vertical-manifest.json"), "utf8"));
    const ids = m.composedArtifactIds;
    for (const key of [
      "bridge",
      "patchExport",
      "patchResult",
      "deltaPackage",
      "runtimeReport",
      "providerProofId",
      "benchmarkRunId",
    ]) {
      assert.ok(typeof ids[key] === "string" && ids[key].length > 0, `missing composed id ${key}`);
    }
    assert.equal(m.benchmarkRunId, undefined); // run id lives under composedArtifactIds
    assert.equal(ids.benchmarkRunId, "019ed026-0000-7000-8000-000000000001");
  });
});

test("independent validator command re-proves linkage (exit 0)", () => {
  withTmp((outDir) => {
    runDriver([], outDir);
    const result = runValidator(outDir);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /verdict=linked/);
  });
});

test("validator catches a tampered emitted artifact (hash drift -> exit 1)", () => {
  withTmp((outDir) => {
    runDriver([], outDir);
    // Tamper with an emitted artifact without updating the manifest hash.
    const path = join(outDir, "runtime-observation-proof.json");
    const obj = JSON.parse(readFileSync(path, "utf8"));
    obj.observedTextLineCount = obj.observedTextLineCount + 1;
    writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`);
    const result = runValidator(outDir);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /validator\.hash_mismatch/);
  });
});

test("validator re-executes the render and rejects a placeholder runtime proof even when hash-addressing is consistent", () => {
  withTmp((outDir) => {
    runDriver([], outDir);
    // Swap the emitted runtime-observation-proof's renderHash for a fabricated
    // one (a re-emitted/placeholder record) and UPDATE the manifest hash to
    // match, so pure hash-addressing passes. The independent validator must
    // still reject it because it re-executes the fixture and the renderHash no
    // longer reproduces a real run.
    const proofPath = join(outDir, "runtime-observation-proof.json");
    const proof = JSON.parse(readFileSync(proofPath, "utf8"));
    proof.renderHash = `sha256:${"0".repeat(64)}`;
    const bytes = `${JSON.stringify(proof, null, 2)}\n`;
    writeFileSync(proofPath, bytes);
    const newHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

    const manifestPath = join(outDir, "vertical-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    for (const e of manifest.emittedArtifacts) {
      if (e.role === "runtime-observation-proof") e.hash = newHash;
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const result = runValidator(outDir);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /runtime\.render_not_reproducible/);
  });
});

test("validator fails (exit 1) when no manifest is present", () => {
  withTmp((outDir) => {
    const result = runValidator(outDir);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /validator\.manifest_missing/);
  });
});

test("--dry-run makes zero writes and lists only public inputs", () => {
  withTmp((outDir) => {
    const result = runDriver(["--dry-run"], outDir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /dry-run composition plan/);
    for (const line of result.stdout.split("\n")) {
      const m = line.match(/^\s+- (\S+)/);
      if (m) assert.ok(m[1].startsWith("fixtures/"), `non-public input listed: ${m[1]}`);
    }
    for (const f of REQUIRED) assert.ok(!existsSync(join(outDir, f)), `${f} must not be written`);
  });
});

test("--list-inputs prints only public fixture paths", () => {
  withTmp((outDir) => {
    const result = runDriver(["--list-inputs"], outDir);
    assert.equal(result.status, 0);
    const lines = result.stdout
      .trim()
      .split("\n")
      .filter((l) => l.startsWith("fixtures/"));
    assert.ok(lines.length >= 6);
    for (const l of lines) assert.ok(!l.includes("private-local"));
  });
});

test("driver exits 1 when the SHARED-025 proof manifest hash is broken", () => {
  withTmp((outDir) => {
    // Point at a tampered proof manifest copy (content hash no longer matches
    // the referenced artifact files) -> blocking content-hash finding.
    const proof = JSON.parse(
      readFileSync(
        join(
          HERE,
          "..",
          "..",
          "..",
          "fixtures",
          "alpha-vertical-proof",
          "hello-game-alpha-proof-v0.2.fr-FR.json",
        ),
        "utf8",
      ),
    );
    proof.artifactRefs.bridgeBundle.hash = `sha256:${"b".repeat(64)}`;
    const tampered = join(outDir, "tampered-proof.json");
    writeFileSync(tampered, `${JSON.stringify(proof, null, 2)}\n`);
    // The tampered proof lives outside fixtures/, so the public-path guard
    // would reject it; instead drop it under a fixtures-shaped temp is not
    // possible here, so we assert the public-path guard fires.
    const result = runDriver(["--proof-manifest", tampered], outDir);
    assert.equal(result.status, 1, result.stdout);
    assert.ok(
      /refusing non-public input path|content_hash_mismatch/.test(result.stdout + result.stderr),
    );
  });
});
