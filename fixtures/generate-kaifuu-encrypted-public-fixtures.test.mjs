#!/usr/bin/env node
// KAIFUU-157/166 regression: the public encrypted-matrix fixture generator must
// REGENERATE Siglus expected outputs from the current detector/parser commands
// (never preserve stale hand-edited JSON), reproduce them byte-idempotently, keep
// them public-safe, and fail `--check` when a committed Siglus expected output
// drifts from the command output.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatorPath = resolve(repoRoot, "fixtures/generate-kaifuu-encrypted-public-fixtures.mjs");
const manifestPath = resolve(repoRoot, "fixtures/public/kaifuu-encrypted-matrix.manifest.json");
const siglusExpectedRelPaths = [
  "fixtures/public/kaifuu-encrypted-matrix/expected/siglus-detection-report-v0.1.json",
  "fixtures/public/kaifuu-encrypted-matrix/expected/siglus-detector-profile-v0.1.json",
  "fixtures/public/kaifuu-encrypted-matrix/expected/siglus-asset-inventory-v0.1.json",
  "fixtures/public/kaifuu-encrypted-matrix/expected/siglus-parser-boundary-smoke-v0.1.json",
];
const parserBoundaryRelPath = siglusExpectedRelPaths[3];
const parserBoundaryPath = resolve(repoRoot, parserBoundaryRelPath);

// Public-safety tripwires mirrored from the Siglus parser-boundary CLI leak scan
// (crates/kaifuu-cli): regenerated reports must never carry raw key material,
// the fixture secret label, decrypted script text, or local absolute paths.
const FORBIDDEN = [
  "rawKey",
  "00112233445566778899aabbccddeeff",
  "fixture-only-siglus-secondary-key-v1",
  "decrypted script",
  "/home/",
  "C:\\",
];
const PARSER_BOUNDARY_FORBIDDEN = [...FORBIDDEN, "keyMaterial"];

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function runGenerator(args = []) {
  return execFileSync(process.execPath, [generatorPath, ...args], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function expectedPath(relativePath) {
  return resolve(repoRoot, relativePath);
}

function restoreCommittedSiglusExpectedOutputs() {
  for (const [relativePath, bytes] of committedExpected.entries()) {
    writeFileSync(expectedPath(relativePath), bytes);
  }
  runGenerator();
}

// Snapshot committed expected reports before touching anything so assertions and
// deliberate-drift restores compare against known bytes.
const committedExpected = new Map(
  siglusExpectedRelPaths.map((relativePath) => [
    relativePath,
    readFileSync(expectedPath(relativePath)),
  ]),
);

test("regeneration re-derives Siglus command expected outputs byte-for-byte", () => {
  runGenerator();

  for (const [relativePath, bytes] of committedExpected.entries()) {
    assert.deepEqual(
      readFileSync(expectedPath(relativePath)),
      bytes,
      `${relativePath} must match the current command-regenerated output`,
    );
  }

  // Idempotent: a second run yields the exact same bytes.
  runGenerator();
  for (const [relativePath, bytes] of committedExpected.entries()) {
    assert.deepEqual(readFileSync(expectedPath(relativePath)), bytes);
  }
});

test("regenerated manifest records Siglus command-owned expected outputs with matching hashes", () => {
  runGenerator();

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const relativePath of siglusExpectedRelPaths) {
    const entry = manifest.files.find((file) => file.path === relativePath);
    assert.ok(entry, `manifest must list ${relativePath}`);
    assert.equal(entry.role, "expected-output");

    const path = expectedPath(relativePath);
    const bytes = statSync(path).size;
    assert.equal(entry.bytes, bytes, "manifest byte count must match");
    assert.equal(entry.sha256, sha256(readFileSync(path)), "manifest sha256 must match");
  }

  // Provenance must acknowledge the generator now owns the Siglus command outputs.
  assert.match(manifest.fixture.summary, /parser-boundary/);
  assert.match(manifest.fixture.provenance.creationMethod, /command-regenerated Siglus/);
  assert.match(manifest.aggregateStats.notes, /parser-boundary/);
});

test("regenerated Siglus expected outputs stay public-safe", () => {
  runGenerator();
  for (const relativePath of siglusExpectedRelPaths) {
    const text = readFileSync(expectedPath(relativePath), "utf8");
    const forbiddenValues =
      relativePath === parserBoundaryRelPath ? PARSER_BOUNDARY_FORBIDDEN : FORBIDDEN;
    for (const forbidden of forbiddenValues) {
      assert.ok(
        !text.includes(forbidden),
        `${relativePath} must not leak ${JSON.stringify(forbidden)}`,
      );
    }
  }
});

test("regeneration overwrites a stale Siglus expected output instead of preserving it", () => {
  writeFileSync(
    parserBoundaryPath,
    `${JSON.stringify({ stale: "siglus parser boundary drift" }, null, 2)}\n`,
  );
  try {
    runGenerator();
    assert.deepEqual(
      readFileSync(parserBoundaryPath),
      committedExpected.get(parserBoundaryRelPath),
      "normal regeneration must replace stale Siglus JSON with current command output",
    );
  } finally {
    restoreCommittedSiglusExpectedOutputs();
  }
});

test("check mode fails loudly when committed Siglus expected output drifts", () => {
  writeFileSync(
    parserBoundaryPath,
    `${JSON.stringify({ stale: "siglus parser boundary drift" }, null, 2)}\n`,
  );
  try {
    let failed = false;
    let stderr = "";
    try {
      runGenerator(["--check"]);
    } catch (error) {
      failed = true;
      stderr = String(error.stderr ?? "");
    }
    assert.ok(failed, "--check must exit non-zero when committed Siglus output is stale");
    assert.match(
      stderr,
      /siglus-parser-boundary-smoke-v0\.1\.json changed/,
      "the failure must name the stale Siglus expected output",
    );
  } finally {
    restoreCommittedSiglusExpectedOutputs();
  }
});
