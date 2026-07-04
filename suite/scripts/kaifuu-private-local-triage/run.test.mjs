/*
 * KAIFUU-036 — deterministic unit + integration tests for the private-local
 * encrypted corpus triage workflow. `node --test`, no network, no DB, no build,
 * no private corpora: the no-corpus path and a MOCK redacted manifest drive
 * everything. Proves:
 *   - with NO private inputs the triage emits the DETERMINISTIC REDACTED
 *     no-corpus artifact (stable across runs, matches the committed example);
 *   - with a mock/fixture manifest it produces the aggregate readiness report
 *     (redacted fields only, matches the committed example, correct per-engine
 *     bins covering MV/MZ/XP3/Siglus/Wolf/RGSS3);
 *   - NO raw key/secret/copyrighted bytes reach any output — a manifest that
 *     carries a raw key, absolute path, or local-secret ref is REJECTED;
 *   - the committed examples validate against the committed schemas.
 */
"use strict";

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import {
  ENGINES,
  READINESS_BINS,
  assertNoSecrets,
  buildNoCorpusArtifact,
  findSecretLeak,
  normalizeManifest,
  stableStringify,
} from "./triage.mjs";
import { discoverManifestPaths, parseArgs, triage } from "./run.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = join(HERE, "examples");
const MANIFEST_FILENAME = "private-triage-manifest.local.json";

function readExample(name) {
  return readFileSync(join(EXAMPLES, name), "utf8");
}

function readExampleJson(name) {
  return JSON.parse(readExample(name));
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "k036-triage-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("parseArgs ignores the `vp run -- ` separator", () => {
  assert.deepEqual(parseArgs(["--", "--no-corpus"]).noCorpus, true);
  assert.deepEqual(parseArgs(["--no-corpus"]).noCorpus, true);
});

test("no-corpus: deterministic redacted artifact, stable across runs", () => {
  const a = triage({ noCorpus: true }).artifact;
  const b = triage({ noCorpus: true }).artifact;
  assert.equal(stableStringify(a), stableStringify(b), "no-corpus artifact must be deterministic");
  assert.equal(a.status, "skipped");
  assert.equal(a.reason, "private_inputs_absent");
  assert.deepEqual(a.checkedPaths, ["private-local-root"]);
  assert.equal(a.command, "vp run kaifuu:private-local-triage -- --no-corpus");
  assert.equal(a.aggregateCounts.corpora, 0);
  assert.equal(a.aggregateCounts.entries, 0);
  for (const key of ["assets", "encryptedAssets", "textUnits", "archives"]) {
    assert.equal(a.aggregateCounts[key], 0, `no-corpus ${key} count must be zero`);
  }
  // Per-engine bins present and all zero.
  for (const engine of ENGINES) {
    for (const bin of READINESS_BINS) {
      assert.equal(a.engineReadinessBins[engine][bin], 0);
    }
  }
});

test("no-corpus: matches the committed README-safe example", () => {
  // Structural parity with the committed example (the example is repo-formatted;
  // byte-determinism of the emitted artifact is proven by the run above).
  const artifact = buildNoCorpusArtifact();
  assert.deepEqual(artifact, readExampleJson("no-corpus-skipped.example.json"));
});

test("absent private-local root falls back to the no-corpus artifact (never fails)", () => {
  withTempDir((root) => {
    // No fixtures/private-local under this fresh root.
    const { kind, artifact } = triage({ root: "fixtures/private-local" }, root);
    assert.equal(kind, "no-corpus");
    assert.equal(artifact.status, "skipped");
    assert.equal(artifact.reason, "private_inputs_absent");
  });
});

test("aggregate report: mock manifest yields redacted report matching the example", () => {
  const { kind, artifact } = triage(
    { manifest: "examples/private-triage-manifest.local.example.json" },
    HERE,
  );
  assert.equal(kind, "report");
  assert.deepEqual(artifact, readExampleJson("aggregate-readiness-report.example.json"));
  assert.equal(artifact.status, "ok");
  assert.equal(artifact.reason, null);
  assert.equal(artifact.aggregateCounts.corpora, 6);
  // Per-engine bins cover MV/MZ/XP3/Siglus/Wolf/RGSS3.
  assert.equal(artifact.engineReadinessBins["rpg-maker-mv"].ready, 1);
  assert.equal(artifact.engineReadinessBins["rpg-maker-mz"].helper_required, 1);
  assert.equal(artifact.engineReadinessBins["kirikiri-xp3"].key_missing, 1);
  assert.equal(artifact.engineReadinessBins.siglus.helper_required, 1);
  assert.equal(artifact.engineReadinessBins.wolf.unsupported_variant, 1);
  assert.equal(artifact.engineReadinessBins["rgss3-vx-ace"].detector_unknown, 1);
});

test("report entries carry ONLY redacted fields (no raw key/path/secret leaks)", () => {
  const { artifact } = triage(
    { manifest: "examples/private-triage-manifest.local.example.json" },
    HERE,
  );
  // The deep scanner is the enforcement point; it throws on any leak.
  assert.doesNotThrow(() => assertNoSecrets(artifact));
  const serialized = stableStringify(artifact);
  assert.doesNotMatch(serialized, /local-secret:/i, "no raw secret refs");
  assert.doesNotMatch(serialized, /\/home\/|\/Users\/|\/scratch\//, "no absolute local paths");
});

test("secret scanner rejects raw key material, absolute paths, and local-secret refs", () => {
  assert.equal(findSecretLeak("profile-mv-01"), null);
  assert.equal(
    findSecretLeak("sha256:2c22b6c9e76383ee06844122c0bd099a0bddacc12c78f81b01cd0d0dc5be0532"),
    null,
  );
  assert.equal(findSecretLeak("00112233445566778899aabbccddeeff"), "raw-key-or-hex-blob");
  assert.equal(findSecretLeak("local-secret:fixture/siglus/secondary-key"), "local-secret-ref");
  assert.equal(
    findSecretLeak("/home/operator/games/retail-title/System.json"),
    "absolute-local-path",
  );
  assert.equal(findSecretLeak("C:\\Games\\Retail\\data.rgss3a"), "absolute-local-path");
});

test("a manifest carrying a raw key is REJECTED before any output", () => {
  const leaking = {
    schemaVersion: "itotori.kaifuu-private-local-triage-manifest.v0.1",
    corpora: [
      {
        corpusId: "leaky-corpus",
        engine: "siglus",
        readinessBin: "ready",
        // Raw 16-byte key smuggled into a redacted field.
        keyProfileIdRedacted: "profile-siglus-01",
        detectorResults: ["00112233445566778899aabbccddeeff"],
      },
    ],
  };
  const entries = normalizeManifest(leaking, "test");
  assert.throws(() => assertNoSecrets({ entries }), /secret-leak \(raw-key-or-hex-blob\)/);
});

test("manifest validation rejects unknown engines and non-hash proof refs", () => {
  assert.throws(
    () =>
      normalizeManifest({
        schemaVersion: "itotori.kaifuu-private-local-triage-manifest.v0.1",
        corpora: [{ corpusId: "x", engine: "unity", readinessBin: "ready" }],
      }),
    /engine must be one of/,
  );
  assert.throws(
    () =>
      normalizeManifest({
        schemaVersion: "itotori.kaifuu-private-local-triage-manifest.v0.1",
        corpora: [
          { corpusId: "x", engine: "siglus", readinessBin: "ready", proofHashes: ["deadbeef"] },
        ],
      }),
    /proofHashes must be sha256/,
  );
});

test("corpus-dir scan discovers per-corpus manifests deterministically", () => {
  withTempDir((root) => {
    const corpusDir = join(root, "corpora");
    const entry = (id, engine, bin) =>
      JSON.stringify({
        schemaVersion: "itotori.kaifuu-private-local-triage-manifest.v0.1",
        corpora: [{ corpusId: id, engine, readinessBin: bin }],
      });
    for (const [sub, id, engine] of [
      ["b-corpus", "corpus-b", "wolf"],
      ["a-corpus", "corpus-a", "siglus"],
    ]) {
      const dir = join(corpusDir, sub);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, MANIFEST_FILENAME), entry(id, engine, "ready"));
    }
    const paths = discoverManifestPaths(corpusDir);
    assert.equal(paths.length, 2);
    assert.ok(paths[0] < paths[1], "manifest paths must be sorted");
    const { kind, artifact } = triage({ corpusDir }, "/");
    assert.equal(kind, "report");
    assert.equal(artifact.aggregateCounts.corpora, 2);
    assert.equal(artifact.engineReadinessBins.siglus.ready, 1);
    assert.equal(artifact.engineReadinessBins.wolf.ready, 1);
  });
});

test("committed examples validate against the committed schemas", () => {
  const ajv = new Ajv({ allErrors: true });
  const manifestSchema = JSON.parse(readFileSync(join(HERE, "manifest.schema.json"), "utf8"));
  const reportSchema = JSON.parse(readFileSync(join(HERE, "readiness-report.schema.json"), "utf8"));
  const validateManifest = ajv.compile(manifestSchema);
  const validateReport = ajv.compile(reportSchema);

  const manifest = JSON.parse(readExample("private-triage-manifest.local.example.json"));
  assert.ok(validateManifest(manifest), ajv.errorsText(validateManifest.errors));

  for (const name of [
    "aggregate-readiness-report.example.json",
    "no-corpus-skipped.example.json",
  ]) {
    const report = JSON.parse(readExample(name));
    assert.ok(validateReport(report), `${name}: ${ajv.errorsText(validateReport.errors)}`);
  }
});
