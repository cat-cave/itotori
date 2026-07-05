#!/usr/bin/env node
// KAIFUU-166 regression: the public encrypted-matrix fixture generator must
// PRESERVE the KAIFUU-093 Siglus parser-boundary smoke expected output across a
// regeneration (never delete or stale it), reproduce it byte-idempotently, keep
// it public-safe, and record it in the manifest. Regeneration and manifest
// validation must FAIL loudly if that committed expected output is omitted.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatorPath = resolve(repoRoot, "fixtures/generate-kaifuu-encrypted-public-fixtures.mjs");
const manifestPath = resolve(repoRoot, "fixtures/public/kaifuu-encrypted-matrix.manifest.json");
const expectedRelPath =
  "fixtures/public/kaifuu-encrypted-matrix/expected/siglus-parser-boundary-smoke-v0.1.json";
const expectedPath = resolve(repoRoot, expectedRelPath);

// Public-safety tripwires mirrored from the Siglus parser-boundary CLI leak scan
// (crates/kaifuu-cli): the preserved report must never carry raw key material,
// the fixture secret label, decrypted script text, or local absolute paths.
const FORBIDDEN = [
  "rawKey",
  "keyMaterial",
  "00112233445566778899aabbccddeeff",
  "fixture-only-siglus-secondary-key-v1",
  "decrypted script",
  "/home/",
  "C:\\",
];

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function runGenerator() {
  return execFileSync(process.execPath, [generatorPath], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// Snapshot the committed expected report before touching anything so every
// assertion (and the fail-if-omitted restore) compares against known bytes.
const committedExpected = readFileSync(expectedPath);

test("regeneration preserves the KAIFUU-093 Siglus parser-boundary expected output byte-for-byte", () => {
  runGenerator();

  const regenerated = readFileSync(expectedPath);
  assert.deepEqual(
    regenerated,
    committedExpected,
    "generator must reproduce the parser-boundary smoke output identically (not delete or stale it)",
  );

  // Idempotent: a second run yields the exact same bytes.
  runGenerator();
  assert.deepEqual(
    readFileSync(expectedPath),
    committedExpected,
    "regeneration must be idempotent",
  );
});

test("regenerated manifest records the parser-boundary expected output with matching hash", () => {
  runGenerator();

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const entry = manifest.files.find((file) => file.path === expectedRelPath);
  assert.ok(entry, "manifest must list the Siglus parser-boundary expected output");
  assert.equal(entry.role, "expected-output");

  const bytes = statSync(expectedPath).size;
  assert.equal(entry.bytes, bytes, "manifest byte count must match the preserved file");
  assert.equal(
    entry.sha256,
    sha256(readFileSync(expectedPath)),
    "manifest sha256 must match the preserved file",
  );

  // Provenance must acknowledge the generator now owns the parser-boundary output.
  assert.match(manifest.fixture.summary, /parser-boundary/);
  assert.match(manifest.fixture.provenance.creationMethod, /parser-boundary/);
  assert.match(manifest.aggregateStats.notes, /parser-boundary/);
});

test("the preserved parser-boundary output stays public-safe", () => {
  runGenerator();
  const text = readFileSync(expectedPath, "utf8");
  for (const forbidden of FORBIDDEN) {
    assert.ok(
      !text.includes(forbidden),
      `parser-boundary output must not leak ${JSON.stringify(forbidden)}`,
    );
  }
});

test("regeneration FAILS loudly if the parser-boundary expected output is omitted", () => {
  const stashed = `${expectedPath}.k166-omitted-regression`;
  renameSync(expectedPath, stashed);
  try {
    let failed = false;
    let stderr = "";
    try {
      runGenerator();
    } catch (error) {
      failed = true;
      stderr = String(error.stderr ?? "");
    }
    assert.ok(failed, "generator must exit non-zero when the expected output is missing");
    assert.match(
      stderr,
      /siglus-parser-boundary-smoke-v0\.1\.json/,
      "the failure must name the missing preserved expected output",
    );
  } finally {
    // The generator throws while reading the preserved outputs, BEFORE it wipes
    // the fixture tree, so the renamed-away file is the only mutation to undo.
    // Restore exact committed bytes defensively (rename back, or rewrite from the
    // snapshot), then normalize the tree with one clean, idempotent run.
    if (existsSync(stashed)) {
      renameSync(stashed, expectedPath);
    }
    if (!existsSync(expectedPath)) {
      writeFileSync(expectedPath, committedExpected);
    }
    runGenerator();
    assert.deepEqual(readFileSync(expectedPath), committedExpected);
  }
});
