/*
 * the relevant capability — deterministic unit + integration tests for the alpha
 * encrypted-readiness evidence INTEGRATION workflow. `node --test`, no network,
 * no DB, no build, no private corpora: typed absent-input failures, committed
 * public prerequisite fixtures, and a MOCK redacted private-corpus manifest drive
 * everything. Proves:
 *   - the composed evidence path NAMES its prerequisites (surfaces, adapters,
 *     command evidence, proof artifacts) and AGGREGATES their proofs by content
 *     hash, WITHOUT re-owning any prerequisite slice;
 *   - missing or empty private inputs fail with no evidence artifact effects;
 *   - an UNSUPPORTED / MISSING / TAMPERED prerequisite stays a SEMANTIC
 *     DIAGNOSTIC (status failed), never a hidden success (boundary regression);
 *   - NO raw key/secret/path/decrypted bytes reach any output;
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
  PRIVATE_MANIFEST_SCHEMA_VERSION,
  SUPPORTED_PREREQUISITE_ENGINE_FAMILIES,
  assertNoSecrets,
  buildComposedReport,
  canonicalHash,
  composePrerequisites,
  findSecretLeak,
  normalizePrivateManifest,
  stableStringify,
} from "./compose.mjs";
import { REPO_ROOT, compose, integrate, parseArgs } from "./run.mjs";
import { PRIVATE_INPUT_DIAGNOSTIC_SCHEMA_VERSION } from "../kaifuu-private-local-triage/triage.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = join(HERE, "examples");
const RUNNER = join(HERE, "run.mjs");
const TASK = "kaifuu:encrypted-readiness";
const RAW_SECRET = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const PREREQ_MANIFEST = JSON.parse(readFileSync(join(HERE, "prerequisites.manifest.json"), "utf8"));

function readExample(name) {
  return readFileSync(join(EXAMPLES, name), "utf8");
}

function readExampleJson(name) {
  return JSON.parse(readExample(name));
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "k800-encrypted-readiness-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("parseArgs ignores the `vp run -- ` separator", () => {
  assert.equal(parseArgs(["--", "--no-corpus"]).noCorpus, true);
  assert.equal(parseArgs(["--no-corpus"]).noCorpus, true);
});

test("composed evidence path NAMES prerequisites and AGGREGATES their proofs", () => {
  const composed = compose({ prerequisites: PREREQ_PATH() });
  // Names the prerequisite surfaces, adapters, command evidence, and artifacts.
  assert.deepEqual(composed.composes.surfaces.map((surface) => surface.id).sort(), [
    "alpha-encrypted-readiness-evidence",
    "packed-engine-readiness",
  ]);
  assert.deepEqual(
    composed.composes.adapters.map((a) => a.engineFamily).sort(),
    [...SUPPORTED_PREREQUISITE_ENGINE_FAMILIES].sort(),
  );
  assert.equal(composed.composes.commandEvidence.length, 2);
  // Aggregates 7 committed prerequisite proof artifacts by content hash.
  assert.equal(composed.composes.artifacts.length, 7);
  for (const artifact of composed.composes.artifacts) {
    assert.match(artifact.contentHash, /^sha256:[0-9a-f]{64}$/);
  }
  assert.equal(composed.composes.prerequisiteCounts.readinessProfiles, 5);
  assert.equal(composed.composes.prerequisiteCounts.patchEvidence, 2);
  assert.match(composed.composedEvidenceHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(composed.findings.length, 0);
});

function PREREQ_PATH() {
  return "suite/scripts/kaifuu-encrypted-readiness-integration/prerequisites.manifest.json";
}

test("selected_private_task_without_manifest_fails_cell", () => {
  withTempDir((root) => {
    const zeroBytes = join(root, "zero.json");
    const emptySelection = join(root, "empty-selection.json");
    const manifestDirectory = join(root, "manifest-directory");
    const leakingManifest = join(root, "private-manifest.json");
    mkdirSync(manifestDirectory);
    writeFileSync(zeroBytes, "");
    writeFileSync(
      emptySelection,
      JSON.stringify({ schemaVersion: PRIVATE_MANIFEST_SCHEMA_VERSION, corpora: [] }),
    );
    writeFileSync(
      leakingManifest,
      JSON.stringify({
        schemaVersion: PRIVATE_MANIFEST_SCHEMA_VERSION,
        corpora: [
          {
            corpusIdRedacted: "private-corpus",
            engine: "siglus",
            readinessBin: "ready",
            proofHash: RAW_SECRET,
          },
        ],
      }),
    );
    const cases = [
      [[], "private-input-manifest-missing"],
      [["--no-corpus"], "private-input-explicitly-absent"],
      [["--private-manifest", join(root, "missing.json")], "private-input-manifest-missing"],
      [["--private-manifest", zeroBytes], "private-input-zero-bytes"],
      [["--private-manifest", emptySelection], "private-input-selection-empty"],
      [["--private-manifest"], "private-input-argument-missing", "invalid-input"],
      [["--no-corpus", "--help"], "private-input-invalid", "invalid-input"],
      [
        ["--private-manifest", manifestDirectory],
        "private-input-manifest-not-file",
        "invalid-input",
      ],
      [["--private-manifest", leakingManifest], "private-input-invalid", "invalid-input"],
      [
        ["--no-corpus", "--private-manifest", leakingManifest],
        "private-input-invalid",
        "invalid-input",
      ],
      [
        ["--private-manifest", leakingManifest, "--private-manifest", leakingManifest],
        "private-input-invalid",
        "invalid-input",
      ],
    ];
    for (const [args, reasonCode, failureClass = "missing-input"] of cases) {
      const out = join(root, "effects", "encrypted-readiness-report.json");
      const result = spawnSync(process.execPath, [RUNNER, ...args, "--out", out], {
        encoding: "utf8",
      });
      assert.equal(result.status, 1, reasonCode);
      assert.equal(result.stdout, "", reasonCode);
      assert.deepEqual(JSON.parse(result.stderr), {
        schemaVersion: PRIVATE_INPUT_DIAGNOSTIC_SCHEMA_VERSION,
        status: "failed",
        task: TASK,
        failureClass,
        reasonCode,
        diagnosticOutcome: "safe-actionable-remediation",
        effectOutcome: "no-effects",
      });
      assert.equal(result.stderr.includes(RAW_SECRET), false, reasonCode);
      assert.equal(result.stderr.includes(root), false, reasonCode);
      assert.equal(existsSync(join(root, "effects")), false, reasonCode);
    }
  });
});

test("valid manifest command writes the schema-valid composed report", () => {
  withTempDir((root) => {
    const out = join(root, `${RAW_SECRET}.json`);
    const manifest = join(EXAMPLES, "private-encrypted-corpus-manifest.local.example.json");
    const result = spawnSync(
      process.execPath,
      [RUNNER, "--private-manifest", manifest, "--out", out],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.includes(root), false);
    assert.equal(result.stdout.includes(RAW_SECRET), false);
    assert.deepEqual(
      JSON.parse(readFileSync(out, "utf8")),
      readExampleJson("composed-readiness-report.example.json"),
    );
  });
});

test("aggregate report: mock manifest yields redacted report matching the example", () => {
  const { kind, artifact } = integrate({
    prerequisites: PREREQ_PATH(),
    privateManifest:
      "suite/scripts/kaifuu-encrypted-readiness-integration/examples/private-encrypted-corpus-manifest.local.example.json",
  });
  assert.equal(kind, "report");
  assert.deepEqual(artifact, readExampleJson("composed-readiness-report.example.json"));
  assert.equal(artifact.status, "ok");
  assert.equal(artifact.reason, null);
  assert.equal(artifact.aggregateCounts.corpora, 3);
  assert.equal(artifact.engineReadinessBins["kirikiri-xp3"].ready, 1);
  assert.equal(artifact.engineReadinessBins.siglus.helper_required, 1);
  assert.equal(artifact.engineReadinessBins["rpg-maker-mz"].key_missing, 1);
  // The composed prerequisite evidence rides along even with a private corpus.
  assert.equal(artifact.composes.artifacts.length, 7);
  assert.equal(
    artifact.composedEvidenceHash,
    compose({ prerequisites: PREREQ_PATH() }).composedEvidenceHash,
    "composed prerequisite hash is stable",
  );
});

// --- Boundary regression: unsupported / missing / tampered prerequisites ------

test("UNSUPPORTED prerequisite engine is a semantic diagnostic, not a hidden success", () => {
  const manifest = structuredClone(PREREQ_MANIFEST);
  manifest.adapters.push({ id: "unity-il2cpp", engineFamily: "unity_il2cpp" });
  const composed = composePrerequisites(manifest, (relPath) =>
    JSON.parse(readFileSync(join(REPO_ROOT, relPath), "utf8")),
  );
  const codes = composed.findings.map((f) => f.code);
  assert.ok(codes.includes("kaifuu.encrypted_readiness.unsupported_adapter"), codes.join(","));
  const entries = normalizePrivateManifest({
    schemaVersion: PRIVATE_MANIFEST_SCHEMA_VERSION,
    corpora: [{ corpusIdRedacted: "x", engine: "siglus", readinessBin: "ready" }],
  });
  assert.equal(buildComposedReport(entries, { composed }).status, "failed");
});

test("MISSING prerequisite proof is a semantic diagnostic (status failed)", () => {
  const manifest = structuredClone(PREREQ_MANIFEST);
  const composed = composePrerequisites(manifest, () => null);
  const codes = composed.findings.map((f) => f.code);
  assert.ok(
    codes.every((c) => c === "kaifuu.encrypted_readiness.prerequisite_missing"),
    codes.join(","),
  );
  assert.equal(composed.findings.length, manifest.artifacts.length);
});

test("prerequisite content hash changes iff the proof content changes (formatter-independent)", () => {
  const base = { engineFamily: "siglus", a: 1, b: 2 };
  const reordered = { b: 2, engineFamily: "siglus", a: 1 };
  const changed = { engineFamily: "siglus", a: 1, b: 3 };
  assert.equal(canonicalHash(base), canonicalHash(reordered), "key order must not change the hash");
  assert.notEqual(canonicalHash(base), canonicalHash(changed), "a content change must move it");
});

// --- Secret / redaction enforcement ------------------------------------------

test("report entries carry ONLY redacted fields (no raw key/path/secret leaks)", () => {
  const { artifact } = integrate({
    prerequisites: PREREQ_PATH(),
    privateManifest:
      "suite/scripts/kaifuu-encrypted-readiness-integration/examples/private-encrypted-corpus-manifest.local.example.json",
  });
  assert.doesNotThrow(() => assertNoSecrets(artifact));
  const serialized = stableStringify(artifact);
  assert.doesNotMatch(serialized, /local-secret:/i, "no raw secret refs");
  assert.doesNotMatch(serialized, /\/home\/|\/Users\/|\/scratch\//, "no absolute local paths");
});

test("secret scanner rejects raw key material, absolute paths, and local-secret refs", () => {
  assert.equal(findSecretLeak("corpus-alpha"), null);
  assert.equal(
    findSecretLeak("sha256:2c22b6c9e76383ee06844122c0bd099a0bddacc12c78f81b01cd0d0dc5be0532"),
    null,
  );
  assert.equal(findSecretLeak("00112233445566778899aabbccddeeff"), "raw-key-or-hex-blob");
  assert.equal(findSecretLeak("local-secret:fixture/siglus/secondary-key"), "local-secret-ref");
  assert.equal(findSecretLeak("/home/operator/games/retail/Scene.pck"), "absolute-local-path");
  assert.equal(findSecretLeak("C:\\Games\\Retail\\data.xp3"), "absolute-local-path");
});

test("a private manifest carrying a raw key is REJECTED (schema) before any output", () => {
  const leaking = {
    schemaVersion: "itotori.kaifuu-encrypted-readiness-private-corpus-manifest.v0.1",
    corpora: [
      {
        corpusIdRedacted: "leaky-corpus",
        engine: "siglus",
        readinessBin: "ready",
        // A raw 32-byte key smuggled into proofHash — the sha256: shape check rejects it.
        proofHash: "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
      },
    ],
  };
  assert.throws(() => normalizePrivateManifest(leaking), /proofHash must be a sha256/);
});

test("private manifest validation rejects unknown engines", () => {
  assert.throws(
    () =>
      normalizePrivateManifest({
        schemaVersion: "itotori.kaifuu-encrypted-readiness-private-corpus-manifest.v0.1",
        corpora: [{ corpusIdRedacted: "x", engine: "godot", readinessBin: "ready" }],
      }),
    /engine must be one of/,
  );
});

test("committed examples validate against the committed schemas", () => {
  const ajv = new Ajv({ allErrors: true });
  const reportSchema = JSON.parse(readFileSync(join(HERE, "composed-report.schema.json"), "utf8"));
  const privateSchema = JSON.parse(
    readFileSync(join(HERE, "private-corpus-manifest.schema.json"), "utf8"),
  );
  const validateReport = ajv.compile(reportSchema);
  const validatePrivate = ajv.compile(privateSchema);

  for (const name of ["composed-readiness-report.example.json"]) {
    const report = readExampleJson(name);
    assert.ok(validateReport(report), `${name}: ${ajv.errorsText(validateReport.errors)}`);
    const missingCorpusIds = structuredClone(report);
    delete missingCorpusIds.corpusIds;
    assert.equal(validateReport(missingCorpusIds), false, `${name}: corpusIds must be required`);
  }
  const manifest = readExampleJson("private-encrypted-corpus-manifest.local.example.json");
  assert.ok(validatePrivate(manifest), ajv.errorsText(validatePrivate.errors));
});
