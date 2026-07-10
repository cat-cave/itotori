#!/usr/bin/env node
// KAIFUU-157/166 regression: the public encrypted-matrix fixture generator must
// REGENERATE Siglus expected outputs from the current detector/parser commands
// (never preserve stale hand-edited JSON), reproduce them byte-idempotently, keep
// them public-safe, and fail `--check` when a committed Siglus expected output
// drifts from the command output.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

function runGenerator(args = [], environment = {}) {
  return execFileSync(process.execPath, [generatorPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function expectedPath(relativePath) {
  return resolve(repoRoot, relativePath);
}

function snapshotTree(root, relativeDir = "") {
  const entries = new Map();
  if (!existsSync(root)) {
    return entries;
  }
  const directory = resolve(root, relativeDir);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      for (const [path, bytes] of snapshotTree(root, relativePath)) {
        entries.set(path, bytes);
      }
    } else if (entry.isFile()) {
      entries.set(relativePath, readFileSync(resolve(root, relativePath)));
    }
  }
  return entries;
}

function assertTreeEqual(actual, expected, label) {
  assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort(), `${label} paths`);
  for (const [relativePath, bytes] of expected) {
    assert.deepEqual(actual.get(relativePath), bytes, `${label} ${relativePath}`);
  }
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
  const obsoletePath = expectedPath(
    "fixtures/public/kaifuu-encrypted-matrix/expected/obsolete-generator-output.json",
  );
  writeFileSync(
    parserBoundaryPath,
    `${JSON.stringify({ stale: "siglus parser boundary drift" }, null, 2)}\n`,
  );
  writeFileSync(obsoletePath, `${JSON.stringify({ stale: true }, null, 2)}\n`);
  try {
    runGenerator();
    assert.deepEqual(
      readFileSync(parserBoundaryPath),
      committedExpected.get(parserBoundaryRelPath),
      "normal regeneration must replace stale Siglus JSON with current command output",
    );
    assert.ok(!existsSync(obsoletePath), "normal regeneration must prune obsolete files last");
  } finally {
    restoreCommittedSiglusExpectedOutputs();
  }
});

test("check mode fails loudly when committed Siglus expected output drifts", () => {
  const staleBytes = Buffer.from(
    `${JSON.stringify({ stale: "siglus parser boundary drift" }, null, 2)}\n`,
  );
  writeFileSync(parserBoundaryPath, staleBytes);
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
    assert.deepEqual(
      readFileSync(parserBoundaryPath),
      staleBytes,
      "check mode must leave live fixtures untouched when it finds drift",
    );
  } finally {
    restoreCommittedSiglusExpectedOutputs();
  }
});

test("first Siglus command failure preserves the live fixture tree and manifest", () => {
  const fixtureRoot = resolve(repoRoot, "fixtures/public/kaifuu-encrypted-matrix");
  const beforeTree = snapshotTree(fixtureRoot);
  const beforeManifest = readFileSync(manifestPath);
  const beforeSiglusOutputs = new Map(
    siglusExpectedRelPaths.map((relativePath) => [
      relativePath,
      readFileSync(expectedPath(relativePath)),
    ]),
  );

  let failed = false;
  let stderr = "";
  try {
    runGenerator([], { KAIFUU_FIXTURE_GENERATOR_TEST_FAIL_FIRST_SIGLUS_COMMAND: "1" });
  } catch (error) {
    failed = true;
    stderr = String(error.stderr ?? "");
  }

  assert.ok(failed, "the injected first command failure must exit non-zero");
  assert.match(stderr, /test-only injected failure before the first Siglus fixture command/);
  assertTreeEqual(snapshotTree(fixtureRoot), beforeTree, "live fixture tree after command failure");
  assert.deepEqual(
    readFileSync(manifestPath),
    beforeManifest,
    "live manifest after command failure",
  );
  for (const [relativePath, bytes] of beforeSiglusOutputs) {
    assert.deepEqual(
      readFileSync(expectedPath(relativePath)),
      bytes,
      `${relativePath} must survive the first command failure byte-for-byte`,
    );
  }
});
