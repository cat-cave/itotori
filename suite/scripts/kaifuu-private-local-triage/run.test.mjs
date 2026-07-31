/*
 * the relevant capability — deterministic unit + integration tests for the private-local
 * encrypted corpus triage workflow. `node --test`, no network, no DB, no build,
 * no private corpora: typed absent-input failures and a MOCK redacted manifest
 * drive everything. Proves:
 *   - missing or empty private inputs fail with no evidence artifact effects;
 *   - with a mock/fixture manifest it produces the aggregate readiness report
 *     (redacted fields only, matches the committed example, correct per-engine
 *     bins covering MV/MZ/XP3/Siglus/Wolf/RGSS3);
 *   - NO raw key/secret/copyrighted bytes reach any output — a manifest that
 *     carries a raw key, absolute path, or local-secret ref is REJECTED;
 *   - the committed examples validate against the committed schemas.
 */
"use strict";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import {
  PRIVATE_INPUT_DIAGNOSTIC_SCHEMA_VERSION,
  TRIAGE_TASK,
  assertNoSecrets,
  findSecretLeak,
  normalizeManifest,
  stableStringify,
} from "./triage.mjs";
import { discoverManifestPaths, parseArgs, triage } from "./run.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = join(HERE, "examples");
const MANIFEST_FILENAME = "private-triage-manifest.local.json";
const RUNNER = join(HERE, "run.mjs");
const RAW_SECRET = "00112233445566778899aabbccddeeff";

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

test("selected_private_task_without_manifest_fails_cell", () => {
  withTempDir((root) => {
    const emptyDir = join(root, "empty");
    const zeroBytes = join(root, "zero.json");
    const emptySelection = join(root, "empty-selection.json");
    const leakingManifest = join(root, "private-manifest.json");
    mkdirSync(emptyDir);
    writeFileSync(zeroBytes, "");
    writeFileSync(
      emptySelection,
      JSON.stringify({
        schemaVersion: "itotori.kaifuu-private-local-triage-manifest.v0.1",
        corpora: [],
      }),
    );
    writeFileSync(
      leakingManifest,
      JSON.stringify({
        schemaVersion: "itotori.kaifuu-private-local-triage-manifest.v0.1",
        corpora: [
          {
            corpusId: "private-corpus",
            engine: "siglus",
            readinessBin: "ready",
            proofHashes: [RAW_SECRET],
          },
        ],
      }),
    );
    const mixedDir = join(root, "mixed-selection");
    mkdirSync(join(mixedDir, "empty"), { recursive: true });
    mkdirSync(join(mixedDir, "valid"), { recursive: true });
    writeFileSync(join(mixedDir, "empty", MANIFEST_FILENAME), readFileSync(emptySelection));
    writeFileSync(
      join(mixedDir, "valid", MANIFEST_FILENAME),
      readExample("private-triage-manifest.local.example.json"),
    );
    const cases = [
      [["--no-corpus"], "private-input-explicitly-absent"],
      [["--manifest", join(root, "missing.json")], "private-input-manifest-missing"],
      [["--root", join(root, "missing-root")], "private-input-root-missing"],
      [["--corpus-dir", emptyDir], "private-input-directory-empty"],
      [["--manifest", zeroBytes], "private-input-zero-bytes"],
      [["--manifest", emptySelection], "private-input-selection-empty"],
      [["--corpus-dir", mixedDir], "private-input-selection-empty"],
      [["--manifest"], "private-input-argument-missing", "invalid-input"],
      [["--no-corpus", "--help"], "private-input-invalid", "invalid-input"],
      [["--manifest", emptyDir], "private-input-manifest-not-file", "invalid-input"],
      [["--manifest", leakingManifest], "private-input-invalid", "invalid-input"],
      [
        ["--manifest", leakingManifest, "--corpus-dir", emptyDir],
        "private-input-invalid",
        "invalid-input",
      ],
      [
        ["--manifest", leakingManifest, "--manifest", leakingManifest],
        "private-input-invalid",
        "invalid-input",
      ],
    ];
    for (const [args, reasonCode, failureClass = "missing-input"] of cases) {
      const out = join(root, "effects", "readiness-report.json");
      const result = spawnSync(process.execPath, [RUNNER, ...args, "--out", out], {
        encoding: "utf8",
      });
      assert.equal(result.status, 1, reasonCode);
      assert.equal(result.stdout, "", reasonCode);
      assert.deepEqual(JSON.parse(result.stderr), {
        schemaVersion: PRIVATE_INPUT_DIAGNOSTIC_SCHEMA_VERSION,
        status: "failed",
        task: TRIAGE_TASK,
        failureClass,
        reasonCode,
        diagnosticOutcome: "safe-actionable-remediation",
        effectOutcome: "no-effects",
      });
      assert.equal(result.stderr.includes(RAW_SECRET), false, reasonCode);
      assert.equal(result.stderr.includes(root), false, reasonCode);
      assert.equal(existsSync(join(root, "effects")), false, reasonCode);
    }
    assert.throws(() => discoverManifestPaths(zeroBytes), /private-input-directory-unreadable/);
  });
});

test("valid manifest command writes the schema-valid aggregate", () => {
  withTempDir((root) => {
    const out = join(root, `${RAW_SECRET}.json`);
    const manifest = join(EXAMPLES, "private-triage-manifest.local.example.json");
    const result = spawnSync(process.execPath, [RUNNER, "--manifest", manifest, "--out", out], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.includes(root), false);
    assert.equal(result.stdout.includes(RAW_SECRET), false);
    assert.deepEqual(
      JSON.parse(readFileSync(out, "utf8")),
      readExampleJson("aggregate-readiness-report.example.json"),
    );
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

  for (const name of ["aggregate-readiness-report.example.json"]) {
    const report = JSON.parse(readExample(name));
    assert.ok(validateReport(report), `${name}: ${ajv.errorsText(validateReport.errors)}`);
  }
});
