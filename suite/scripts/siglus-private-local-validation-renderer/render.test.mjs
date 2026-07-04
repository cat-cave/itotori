/*
 * KAIFUU-094 — deterministic unit + integration tests for the Siglus
 * private-local redacted validation summary renderer. `node --test`, no
 * network, no DB, no build, no private corpora: the no-corpus path and a MOCK
 * redacted manifest drive everything. Proves:
 *   - with NO private inputs the renderer emits the DETERMINISTIC REDACTED
 *     no-corpus artifact (stable across runs, matches the committed example);
 *   - with a mock/fixture manifest it produces the aggregate validation summary
 *     (redacted fields only, matches the committed example, correct
 *     capability-level / helper-outcome / validation-status / failure bins);
 *   - the renderer THROWS (emits nothing) when an input is SEEDED with any of:
 *     a raw key, a decrypted-script string, a story/scene filename, a helper raw
 *     dump, or an absolute local path — one seeded-secret category per test;
 *   - the four renderer diagnostics stay distinct (missing corpus, redaction
 *     violation, unknown profile, helper-required);
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
  CAPABILITY_LEVELS,
  FAILURE_CATEGORIES,
  HELPER_OUTCOME_CATEGORIES,
  MANIFEST_SCHEMA_VERSION,
  VALIDATION_STATUSES,
  assertNoSecrets,
  buildNoCorpusArtifact,
  buildValidationSummary,
  findSecretLeak,
  normalizeManifest,
  stableStringify,
} from "./render.mjs";
import { discoverManifestPaths, parseArgs, render } from "./run.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = join(HERE, "examples");
const MANIFEST_FILENAME = "siglus-validation-manifest.local.json";

function readExample(name) {
  return readFileSync(join(EXAMPLES, name), "utf8");
}

function readExampleJson(name) {
  return JSON.parse(readExample(name));
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "k094-siglus-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A minimal well-formed run the seeded-secret tests mutate one field at a time.
function baseRun(overrides = {}) {
  return {
    profileId: "profile-siglus-knownkey-smoke-01",
    capabilityLevel: "known-key-patch-verify",
    validationStatus: "passed",
    helperOutcomeCategory: "not_required",
    failureCategory: "none",
    counts: {
      scenesValidated: 1,
      unitsValidated: 3,
      gameexeEntriesValidated: 3,
      filesProcessed: 2,
    },
    proofHashes: [],
    ...overrides,
  };
}

function manifestWith(run) {
  return { schemaVersion: MANIFEST_SCHEMA_VERSION, runs: [run] };
}

// Render an in-memory manifest object end-to-end (normalize -> aggregate ->
// deep-scan) so a seeded secret is proven to THROW before any emit.
function renderManifestObject(manifest) {
  const runs = normalizeManifest(manifest, "test");
  return buildValidationSummary(runs);
}

test("parseArgs ignores the `vp run -- ` separator", () => {
  assert.equal(parseArgs(["--", "--no-corpus"]).noCorpus, true);
  assert.equal(parseArgs(["--no-corpus"]).noCorpus, true);
});

test("no-corpus: deterministic redacted artifact, stable across runs", () => {
  const a = render({ noCorpus: true }).artifact;
  const b = render({ noCorpus: true }).artifact;
  assert.equal(stableStringify(a), stableStringify(b), "no-corpus artifact must be deterministic");
  assert.equal(a.status, "skipped");
  assert.equal(a.reason, "private_inputs_absent");
  assert.deepEqual(a.checkedPaths, ["private-local-root"]);
  assert.equal(a.command, "vp run siglus:private-local-validation-render -- --no-corpus");
  assert.equal(a.engineFamily, "siglus");
  assert.equal(a.aggregateCounts.profiles, 0);
  assert.equal(a.aggregateCounts.runs, 0);
  for (const key of [
    "scenesValidated",
    "unitsValidated",
    "gameexeEntriesValidated",
    "filesProcessed",
  ]) {
    assert.equal(a.aggregateCounts[key], 0, `no-corpus ${key} count must be zero`);
  }
  for (const level of CAPABILITY_LEVELS) {
    assert.equal(a.capabilityLevelBins[level], 0);
  }
  for (const status of VALIDATION_STATUSES) {
    assert.equal(a.validationStatusBins[status], 0);
  }
});

test("no-corpus: matches the committed public-safe example", () => {
  assert.deepEqual(buildNoCorpusArtifact(), readExampleJson("no-corpus-skipped.example.json"));
});

test("absent private-local root falls back to the no-corpus artifact (never fails)", () => {
  withTempDir((root) => {
    const { kind, artifact } = render({ root: "fixtures/private-local" }, root);
    assert.equal(kind, "no-corpus");
    assert.equal(artifact.status, "skipped");
    assert.equal(artifact.reason, "private_inputs_absent");
  });
});

test("aggregate summary: mock manifest yields redacted summary matching the example", () => {
  const { kind, artifact } = render(
    { manifest: "examples/siglus-validation-manifest.local.example.json" },
    HERE,
  );
  assert.equal(kind, "summary");
  assert.deepEqual(artifact, readExampleJson("validation-summary.example.json"));
  assert.equal(artifact.status, "ok");
  assert.equal(artifact.reason, null);
  assert.equal(artifact.aggregateCounts.profiles, 4);
  assert.equal(artifact.aggregateCounts.runs, 4);
  assert.equal(artifact.aggregateCounts.scenesValidated, 13);
  assert.equal(artifact.aggregateCounts.unitsValidated, 8803);
  // Capability-level / helper-outcome / status / failure bins all populated.
  assert.equal(artifact.capabilityLevelBins["known-key-patch-verify"], 1);
  assert.equal(artifact.capabilityLevelBins["broad-unsupported"], 1);
  assert.equal(artifact.helperOutcomeBins.required_missing, 1);
  assert.equal(artifact.validationStatusBins.helper_required, 1);
  assert.equal(artifact.validationStatusBins.unknown_profile, 1);
  assert.equal(artifact.validationStatusBins.out_of_profile, 1);
  assert.equal(artifact.failureCategoryBins.out_of_profile_compression, 1);
  assert.equal(artifact.failureCategoryBins.bad_magic, 1);
});

test("summary carries ONLY redacted fields (no raw key/path/secret/content leaks)", () => {
  const { artifact } = render(
    { manifest: "examples/siglus-validation-manifest.local.example.json" },
    HERE,
  );
  assert.doesNotThrow(() => assertNoSecrets(artifact));
  const serialized = stableStringify(artifact);
  assert.doesNotMatch(serialized, /local-secret:/i, "no raw secret refs");
  assert.doesNotMatch(serialized, /\/home\/|\/Users\/|\/scratch\//, "no absolute local paths");
  // eslint-disable-next-line no-control-regex -- ASCII-only assertion; range boundary includes \u0000
  assert.doesNotMatch(serialized, /[^\u0000-\u007F]/u, "ASCII-only (no decrypted content)");
});

// --- Leak scanner unit coverage (each secret category) ----------------------

test("secret scanner recognizes each Siglus leak category and passes safe fields", () => {
  // Safe redacted fields.
  assert.equal(findSecretLeak("profile-siglus-knownkey-smoke-01"), null);
  assert.equal(findSecretLeak("known-key-patch-verify"), null);
  assert.equal(
    findSecretLeak("sha256:8a14979472c4c27f0183a34e9dd37c0935d46e9379a790d22063d7b32ec4b87f"),
    null,
  );
  assert.equal(
    findSecretLeak("suite/scripts/siglus-private-local-validation-renderer/run.mjs"),
    null,
  );
  // Raw key material (hex run) + PEM + local-secret ref (inherited base scan).
  assert.equal(findSecretLeak("00112233445566778899aabbccddeeff"), "raw-key-or-hex-blob");
  assert.equal(findSecretLeak("local-secret:siglus-secondary-key"), "local-secret-ref");
  assert.equal(findSecretLeak("/home/operator/games/Siglus/Scene.pck"), "absolute-local-path");
  // Story/scene filename (asset extension).
  assert.equal(findSecretLeak("Scene.pck"), "story-or-scene-filename");
  assert.equal(findSecretLeak("SEEN0513.txt"), "story-or-scene-filename");
  assert.equal(findSecretLeak("Gameexe.dat"), "story-or-scene-filename");
  // Decrypted script / source text (non-ASCII content).
  assert.equal(findSecretLeak("「こんにちは、世界」"), "decrypted-script-or-source-text");
  // Helper raw dump (control chars / newlines).
  assert.equal(findSecretLeak("helper stdout:\n0x00 0x01 dump"), "helper-raw-dump");
});

// --- Seeded-secret rejection (one category per test) ------------------------

test("seeded RAW KEY in a run is REJECTED before any emit", () => {
  // Raw 16-byte key smuggled into proofHashes (bypasses the sha256 shape? no —
  // caught by the deep scan if it slipped past). Route it where free strings can
  // reach the summary: a would-be extra field the normalizer drops is not it, so
  // seed a run object the deep-scan sees via a hand-built summary.
  const leakingRuns = [{ ...baseRun(), profileId: "profile-ok-01" }];
  const summary = buildValidationSummary(leakingRuns);
  // Now inject a raw key post-build and prove the deep scan catches it.
  summary.runs[0].proofHashes = ["00112233445566778899aabbccddeeffdeadbeefcafef00d"];
  assert.throws(
    () => assertNoSecrets(summary),
    /siglus-redaction-violation \(raw-key-or-hex-blob\)/,
  );
  // And a manifest seeding a raw key end-to-end is rejected before emit: a
  // 32-hex-char run is a valid logical-id SHAPE, so the deep scan is the guard
  // that throws (raw-key-or-hex-blob) — never a silent emit.
  assert.throws(
    () =>
      renderManifestObject(
        manifestWith(baseRun({ profileId: "00112233445566778899aabbccddeeff" })),
      ),
    /siglus-redaction-violation \(raw-key-or-hex-blob\)/,
  );
});

test("seeded DECRYPTED SCRIPT string is REJECTED before any emit", () => {
  const summary = buildValidationSummary([baseRun()]);
  summary.runs[0].profileId = "「復号されたスクリプト」";
  assert.throws(
    () => assertNoSecrets(summary),
    /siglus-redaction-violation \(decrypted-script-or-source-text\)/,
  );
});

test("seeded STORY/SCENE FILENAME is REJECTED before any emit", () => {
  const summary = buildValidationSummary([baseRun()]);
  summary.runs[0].profileId = "seen0513.txt";
  assert.throws(
    () => assertNoSecrets(summary),
    /siglus-redaction-violation \(story-or-scene-filename\)/,
  );
  // Via the normalizer, a Scene.pck filename fails the logical-id gate too.
  assert.throws(
    () => renderManifestObject(manifestWith(baseRun({ profileId: "Scene.pck" }))),
    /profileId must be a lowercase logical id/,
  );
});

test("seeded HELPER RAW DUMP is REJECTED before any emit", () => {
  const summary = buildValidationSummary([baseRun()]);
  summary.runs[0].profileId = "helper-dump:\n0xDE 0xAD raw bytes";
  assert.throws(() => assertNoSecrets(summary), /siglus-redaction-violation \(helper-raw-dump\)/);
});

test("seeded ABSOLUTE LOCAL PATH is REJECTED before any emit", () => {
  const summary = buildValidationSummary([baseRun()]);
  summary.runs[0].profileId = "/home/operator/games/siglus-title";
  assert.throws(
    () => assertNoSecrets(summary),
    /siglus-redaction-violation \(absolute-local-path\)/,
  );
});

// --- Diagnostics stay distinct ----------------------------------------------

test("renderer diagnostics distinguish the four acceptance cases", () => {
  // (1) missing private corpus -> skipped no-corpus artifact.
  assert.equal(render({ noCorpus: true }).artifact.status, "skipped");
  // (2) redaction violation -> THROW (never a status).
  const dirty = buildValidationSummary([baseRun()]);
  dirty.runs[0].profileId = "Gameexe.dat";
  assert.throws(() => assertNoSecrets(dirty), /siglus-redaction-violation/);
  // (3) unknown profile -> a distinct validation status bin.
  const unknown = renderManifestObject(
    manifestWith(baseRun({ validationStatus: "unknown_profile", helperOutcomeCategory: "error" })),
  );
  assert.equal(unknown.validationStatusBins.unknown_profile, 1);
  // (4) helper-required -> a distinct validation status bin.
  const helper = renderManifestObject(
    manifestWith(
      baseRun({ validationStatus: "helper_required", helperOutcomeCategory: "required_missing" }),
    ),
  );
  assert.equal(helper.validationStatusBins.helper_required, 1);
});

test("manifest validation rejects unknown capability levels and non-hash proof refs", () => {
  assert.throws(
    () => renderManifestObject(manifestWith(baseRun({ capabilityLevel: "full-production" }))),
    /capabilityLevel must be one of/,
  );
  assert.throws(
    () => renderManifestObject(manifestWith(baseRun({ proofHashes: ["deadbeef"] }))),
    /proofHashes must be sha256/,
  );
  assert.throws(
    () => renderManifestObject(manifestWith(baseRun({ validationStatus: "totally-fine" }))),
    /validationStatus must be one of/,
  );
});

test("corpus-dir scan discovers per-corpus manifests deterministically", () => {
  withTempDir((root) => {
    const corpusDir = join(root, "corpora");
    const runJson = (profileId, status) =>
      JSON.stringify(manifestWith(baseRun({ profileId, validationStatus: status })));
    for (const [sub, id, status] of [
      ["b-corpus", "profile-b-01", "helper_required"],
      ["a-corpus", "profile-a-01", "passed"],
    ]) {
      const dir = join(corpusDir, sub);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, MANIFEST_FILENAME), runJson(id, status));
    }
    const paths = discoverManifestPaths(corpusDir);
    assert.equal(paths.length, 2);
    assert.ok(paths[0] < paths[1], "manifest paths must be sorted");
    const { kind, artifact } = render({ corpusDir }, "/");
    assert.equal(kind, "summary");
    assert.equal(artifact.aggregateCounts.profiles, 2);
    assert.equal(artifact.validationStatusBins.passed, 1);
    assert.equal(artifact.validationStatusBins.helper_required, 1);
  });
});

test("committed examples validate against the committed schemas", () => {
  const ajv = new Ajv({ allErrors: true });
  const manifestSchema = JSON.parse(readFileSync(join(HERE, "manifest.schema.json"), "utf8"));
  const summarySchema = JSON.parse(
    readFileSync(join(HERE, "validation-summary.schema.json"), "utf8"),
  );
  const validateManifest = ajv.compile(manifestSchema);
  const validateSummary = ajv.compile(summarySchema);

  const manifest = readExampleJson("siglus-validation-manifest.local.example.json");
  assert.ok(validateManifest(manifest), ajv.errorsText(validateManifest.errors));

  for (const name of ["validation-summary.example.json", "no-corpus-skipped.example.json"]) {
    const summary = readExampleJson(name);
    assert.ok(validateSummary(summary), `${name}: ${ajv.errorsText(validateSummary.errors)}`);
  }
  // Exercise the full enum surfaces so the schema + code stay in lockstep.
  assert.equal(HELPER_OUTCOME_CATEGORIES.length, 5);
  assert.equal(FAILURE_CATEGORIES.length, 9);
});
