/*
 * KAIFUU-067 — deterministic unit + integration tests for the private-local
 * key-hunting run workflow. `node --test`, no network, no DB, no build, no
 * private corpora, no Wine/Windows: the no-corpus path and STUB redacted
 * manifests drive everything. Proves:
 *   - the workflow scans a STUB fixture dir and records all FIVE outcome
 *     categories (attempted / succeeded / failed / skipped / unsupported);
 *   - the attempt planner SELECTS attempts by engine + capability (unknown engine
 *     -> unsupported; capability below the attempt minimum -> not runnable);
 *   - a validated-key result carries ONLY a local-secret: ref + a sha256: proof
 *     hash; a raw key in ANY field THROWS (both the ref-scan and the report-scan);
 *   - with NO private inputs the workflow emits the DETERMINISTIC REDACTED
 *     no-corpus artifact (status skipped, reason private_inputs_absent,
 *     helperAttempts [], no raw local paths) and never fails;
 *   - a seeded raw key / absolute path / local-secret ref in the emitted report
 *     is REJECTED by the deep-scan before anything is written;
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
  ENGINES,
  OUTCOMES,
  assertNoRawKey,
  assertNoSecrets,
  buildKeyHuntReport,
  buildNoCorpusArtifact,
  findRawKeyLeak,
  findSecretLeak,
  normalizeAttempt,
  normalizeKeyValidation,
  normalizeManifest,
  planAttempts,
  plannedAttemptKinds,
  stableStringify,
} from "./key-hunt.mjs";
import { discoverManifestPaths, keyHunt, parseArgs } from "./run.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = join(HERE, "examples");
const MANIFEST_FILENAME = "kaifuu-key-hunt-manifest.local.json";

function readExample(name) {
  return readFileSync(join(EXAMPLES, name), "utf8");
}

function readExampleJson(name) {
  return JSON.parse(readExample(name));
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "k067-key-hunt-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const PROOF_A = "sha256:8a14979472c4c27f0183a34e9dd37c0935d46e9379a790d22063d7b32ec4b87f";

// A STUB manifest exercising all five outcome categories across engines.
function stubManifest() {
  return {
    schemaVersion: "itotori.kaifuu-key-hunt-manifest.v0.1",
    helperAttempts: [
      {
        corpusId: "corpus-siglus-01",
        engine: "siglus",
        capabilityLevel: "static-known-key",
        attemptKind: "siglus-known-key",
        helperClass: "staticParser",
        helperId: "kaifuu.siglus.known-key",
        helperVersion: "0.1.0",
        outcome: "succeeded",
        keyValidation: {
          keyProfileId: "profile-siglus-01",
          secretRef: "local-secret:fixture/siglus/known-key",
          proofHash: PROOF_A,
        },
        proofHashes: [PROOF_A],
        commandLines: ["kaifuu key-hunt --engine siglus --attempt known-key"],
      },
      {
        corpusId: "corpus-xp3-01",
        engine: "kirikiri-xp3",
        capabilityLevel: "static-known-key",
        attemptKind: "xp3-key",
        helperClass: "staticParser",
        helperId: "kaifuu.kirikiri.xp3-key",
        helperVersion: "0.1.0",
        outcome: "failed",
      },
      {
        corpusId: "corpus-mv-01",
        engine: "rpg-maker-mv",
        capabilityLevel: "static-known-key",
        attemptKind: "mv-mz-key",
        helperClass: "staticParser",
        helperId: "kaifuu.rpgmaker.mv-mz-key",
        outcome: "attempted",
      },
      {
        corpusId: "corpus-wolf-01",
        engine: "wolf",
        capabilityLevel: "detect-only",
        attemptKind: "wolf-archive-key",
        helperClass: "runtimeHelper",
        helperId: "kaifuu.wolf.archive-key",
        outcome: "skipped",
      },
      {
        corpusId: "corpus-siglus-variant-01",
        engine: "siglus",
        capabilityLevel: "detect-only",
        attemptKind: "none",
        helperClass: "none",
        outcome: "unsupported",
      },
    ],
  };
}

test("parseArgs ignores the `vp run -- ` separator", () => {
  assert.equal(parseArgs(["--", "--no-corpus"]).noCorpus, true);
  assert.equal(parseArgs(["--no-corpus"]).noCorpus, true);
});

test("attempt planner selects attempts by engine + capability", () => {
  // Siglus at static-known-key: the known-key attempt is planned and RUNNABLE.
  const siglus = planAttempts("siglus", "static-known-key");
  assert.equal(siglus.supportedEngine, true);
  assert.equal(siglus.attempts.length, 1);
  assert.equal(siglus.attempts[0].attemptKind, "siglus-known-key");
  assert.equal(siglus.attempts[0].runnable, true);

  // XP3 at static-known-key: planned and runnable.
  assert.equal(planAttempts("kirikiri-xp3", "static-known-key").attempts[0].attemptKind, "xp3-key");

  // Wolf needs wine-local: at detect-only the attempt is planned but NOT runnable
  // (it must be skipped, not brute-forced).
  const wolfLow = planAttempts("wolf", "detect-only");
  assert.equal(wolfLow.attempts[0].attemptKind, "wolf-archive-key");
  assert.equal(wolfLow.attempts[0].runnable, false);
  assert.equal(planAttempts("wolf", "wine-local").attempts[0].runnable, true);

  // Detect-only Siglus: the attempt is still SELECTED, just not runnable.
  assert.equal(planAttempts("siglus", "detect-only").attempts[0].runnable, false);

  // An unknown engine yields an empty plan -> every attempt is unsupported.
  const unknown = planAttempts("unity", "native-windows");
  assert.equal(unknown.supportedEngine, false);
  assert.deepEqual(unknown.attempts, []);
  assert.deepEqual(plannedAttemptKinds("unity"), []);
});

test("scanning a STUB manifest records all five outcome categories", () => {
  const attempts = normalizeManifest(stubManifest(), "stub");
  const report = buildKeyHuntReport(attempts, {
    command: "vp run kaifuu:key-hunt -- --manifest x",
  });
  assert.equal(report.status, "ok");
  assert.equal(report.aggregateCounts.attempts, 5);
  assert.equal(report.aggregateCounts.corpora, 5);
  for (const outcome of OUTCOMES) {
    assert.equal(report.outcomeBins[outcome], 1, `outcome ${outcome} must be recorded once`);
  }
  assert.equal(report.engineOutcomeBins.siglus.succeeded, 1);
  assert.equal(report.engineOutcomeBins.siglus.unsupported, 1);
  assert.equal(report.engineOutcomeBins["kirikiri-xp3"].failed, 1);
  assert.equal(report.engineOutcomeBins["rpg-maker-mv"].attempted, 1);
  assert.equal(report.engineOutcomeBins.wolf.skipped, 1);
  // Citable aggregate metadata is present.
  assert.ok(report.toolVersions.includes("kaifuu.siglus.known-key@0.1.0"));
  assert.ok(report.commandLines.length >= 1);
});

test("the workflow scans a STUB corpus DIR and records the five outcomes", () => {
  withTempDir((root) => {
    const corpusDir = join(root, "corpora", "game-a");
    mkdirSync(corpusDir, { recursive: true });
    writeFileSync(join(corpusDir, MANIFEST_FILENAME), JSON.stringify(stubManifest()));
    const { kind, artifact } = keyHunt({ corpusDir: join(root, "corpora") }, "/");
    assert.equal(kind, "report");
    for (const outcome of OUTCOMES) {
      assert.equal(artifact.outcomeBins[outcome], 1);
    }
  });
});

test("a validated-key result carries ONLY a secret-ref + proof hash", () => {
  const result = normalizeKeyValidation(
    {
      keyProfileId: "profile-siglus-01",
      secretRef: "local-secret:fixture/siglus/known-key",
      proofHash: PROOF_A,
    },
    0,
  );
  assert.deepEqual(Object.keys(result).sort(), ["keyProfileId", "proofHash", "secretRef"]);
  // The ref-scan ALLOWS the local-secret ref but the report-scan REJECTS it, so
  // the emitted report can never carry the ref.
  assert.doesNotThrow(() => assertNoRawKey(result));
  assert.throws(() => assertNoSecrets(result), /secret-leak \(local-secret-ref\)/);
});

test("a raw key smuggled into a validated-key field THROWS (ref-scan)", () => {
  // Raw 16-byte key hidden inside the secretRef string.
  assert.throws(
    () =>
      normalizeKeyValidation(
        {
          keyProfileId: "profile-siglus-01",
          secretRef: "local-secret:00112233445566778899aabbccddeeff",
          proofHash: PROOF_A,
        },
        0,
      ),
    /key-validation-leak \(raw-key-or-hex-blob\)/,
  );
  // Raw key as an unexpected extra field is caught by assertNoRawKey directly.
  assert.throws(
    () => assertNoRawKey({ keyProfileId: "p", key: "00112233445566778899aabbccddeeff" }),
    /key-validation-leak \(raw-key-or-hex-blob\)/,
  );
});

test("a succeeded attempt REQUIRES a keyValidation; others FORBID one", () => {
  const base = stubManifest().helperAttempts[0];
  assert.throws(
    () => normalizeAttempt({ ...base, keyValidation: undefined }, 0),
    /outcome "succeeded" requires a keyValidation/,
  );
  assert.throws(
    () =>
      normalizeAttempt(
        {
          ...stubManifest().helperAttempts[1],
          keyValidation: { keyProfileId: "p", secretRef: "local-secret:x", proofHash: PROOF_A },
        },
        1,
      ),
    /keyValidation is only valid for outcome "succeeded"/,
  );
});

test("the emitted report never carries the secret ref or a raw key", () => {
  const attempts = normalizeManifest(stubManifest(), "stub");
  const report = buildKeyHuntReport(attempts, {});
  assert.doesNotThrow(() => assertNoSecrets(report));
  const serialized = stableStringify(report);
  assert.doesNotMatch(serialized, /local-secret:/i, "no secret refs in the report");
  assert.doesNotMatch(serialized, /\/home\/|\/Users\/|\/scratch\//, "no absolute local paths");
  // The confirmed key surfaces ONLY as key-profile id + proof hash.
  assert.match(serialized, /profile-siglus-01/);
  assert.match(serialized, /sha256:[0-9a-f]{64}/);
});

test("a seeded raw key / absolute path in the report is REJECTED before write", () => {
  // Directly seed a leaking string into a report-shaped object.
  assert.throws(
    () => assertNoSecrets({ helperAttempts: [{ note: "00112233445566778899aabbccddeeff" }] }),
    /secret-leak \(raw-key-or-hex-blob\)/,
  );
  assert.throws(
    () => assertNoSecrets({ path: "/home/operator/games/retail/System.json" }),
    /secret-leak \(absolute-local-path\)/,
  );
});

test("secret scanners classify key material, paths, refs, and hashes", () => {
  // Report scanner (base): local-secret refs ARE leaks.
  assert.equal(findSecretLeak("profile-siglus-01"), null);
  assert.equal(findSecretLeak(PROOF_A), null);
  assert.equal(findSecretLeak("local-secret:fixture/siglus/known-key"), "local-secret-ref");
  assert.equal(findSecretLeak("00112233445566778899aabbccddeeff"), "raw-key-or-hex-blob");
  assert.equal(findSecretLeak("/home/op/game/System.json"), "absolute-local-path");
  // Ref scanner: local-secret refs are ALLOWED, raw keys/paths still rejected.
  assert.equal(findRawKeyLeak("local-secret:fixture/siglus/known-key"), null);
  assert.equal(findRawKeyLeak(PROOF_A), null);
  assert.equal(findRawKeyLeak("00112233445566778899aabbccddeeff"), "raw-key-or-hex-blob");
  assert.equal(findRawKeyLeak("C:\\Games\\Retail\\data.xp3"), "absolute-local-path");
});

test("manifest validation rejects unknown engines and off-plan attempt kinds", () => {
  assert.throws(
    () =>
      normalizeManifest({
        schemaVersion: "itotori.kaifuu-key-hunt-manifest.v0.1",
        helperAttempts: [
          {
            corpusId: "x",
            engine: "unity",
            capabilityLevel: "detect-only",
            attemptKind: "none",
            helperClass: "none",
            outcome: "unsupported",
          },
        ],
      }),
    /engine must be one of/,
  );
  // xp3-key does not belong to the siglus plan.
  assert.throws(
    () =>
      normalizeManifest({
        schemaVersion: "itotori.kaifuu-key-hunt-manifest.v0.1",
        helperAttempts: [
          {
            corpusId: "x",
            engine: "siglus",
            capabilityLevel: "static-known-key",
            attemptKind: "xp3-key",
            helperClass: "staticParser",
            outcome: "failed",
          },
        ],
      }),
    /is not in the siglus plan/,
  );
  // Non-hash proof ref rejected.
  assert.throws(
    () =>
      normalizeManifest({
        schemaVersion: "itotori.kaifuu-key-hunt-manifest.v0.1",
        helperAttempts: [
          {
            corpusId: "x",
            engine: "siglus",
            capabilityLevel: "static-known-key",
            attemptKind: "siglus-known-key",
            helperClass: "staticParser",
            outcome: "failed",
            proofHashes: ["deadbeef"],
          },
        ],
      }),
    /proofHashes must be sha256/,
  );
});

test("no-corpus: deterministic redacted artifact, stable across runs", () => {
  const a = keyHunt({ noCorpus: true }).artifact;
  const b = keyHunt({ noCorpus: true }).artifact;
  assert.equal(stableStringify(a), stableStringify(b), "no-corpus artifact must be deterministic");
  assert.equal(a.status, "skipped");
  assert.equal(a.reason, "private_inputs_absent");
  assert.deepEqual(a.helperAttempts, []);
  assert.deepEqual(a.checkedPaths, ["private-local-root"]);
  assert.equal(a.command, "vp run kaifuu:key-hunt -- --no-corpus");
  assert.equal(a.aggregateCounts.corpora, 0);
  assert.equal(a.aggregateCounts.attempts, 0);
  for (const outcome of OUTCOMES) {
    assert.equal(a.outcomeBins[outcome], 0);
  }
  for (const engine of ENGINES) {
    for (const outcome of OUTCOMES) {
      assert.equal(a.engineOutcomeBins[engine][outcome], 0);
    }
  }
  // No raw local paths anywhere.
  assert.doesNotMatch(stableStringify(a), /\/home\/|\/Users\/|\/scratch\//);
});

test("no-corpus: matches the committed README-safe example", () => {
  assert.deepEqual(
    buildNoCorpusArtifact(),
    readExampleJson("key-hunt-no-corpus-skipped.example.json"),
  );
});

test("absent private-local root falls back to the no-corpus artifact (never fails)", () => {
  withTempDir((root) => {
    const { kind, artifact } = keyHunt({ root: "fixtures/private-local" }, root);
    assert.equal(kind, "no-corpus");
    assert.equal(artifact.status, "skipped");
    assert.equal(artifact.reason, "private_inputs_absent");
    assert.deepEqual(artifact.helperAttempts, []);
  });
});

test("aggregate report: STUB manifest matches the committed example", () => {
  const { kind, artifact } = keyHunt(
    { manifest: "examples/kaifuu-key-hunt-manifest.local.example.json" },
    HERE,
  );
  assert.equal(kind, "report");
  assert.deepEqual(artifact, readExampleJson("key-hunt-report.example.json"));
});

test("corpus-dir scan discovers per-corpus manifests deterministically", () => {
  withTempDir((root) => {
    const corpusDir = join(root, "corpora");
    const one = (id, engine, attemptKind, helperClass) =>
      JSON.stringify({
        schemaVersion: "itotori.kaifuu-key-hunt-manifest.v0.1",
        helperAttempts: [
          {
            corpusId: id,
            engine,
            capabilityLevel: "static-known-key",
            attemptKind,
            helperClass,
            outcome: "failed",
          },
        ],
      });
    for (const [sub, id, engine, kind, cls] of [
      ["b-corpus", "corpus-b", "kirikiri-xp3", "xp3-key", "staticParser"],
      ["a-corpus", "corpus-a", "siglus", "siglus-known-key", "staticParser"],
    ]) {
      const dir = join(corpusDir, sub);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, MANIFEST_FILENAME), one(id, engine, kind, cls));
    }
    const paths = discoverManifestPaths(corpusDir);
    assert.equal(paths.length, 2);
    assert.ok(paths[0] < paths[1], "manifest paths must be sorted");
    const { kind, artifact } = keyHunt({ corpusDir }, "/");
    assert.equal(kind, "report");
    assert.equal(artifact.aggregateCounts.corpora, 2);
    assert.equal(artifact.engineOutcomeBins.siglus.failed, 1);
    assert.equal(artifact.engineOutcomeBins["kirikiri-xp3"].failed, 1);
  });
});

test("capability levels and outcomes are the documented fixed sets", () => {
  assert.deepEqual(CAPABILITY_LEVELS, [
    "detect-only",
    "static-known-key",
    "wine-local",
    "native-windows",
  ]);
  assert.deepEqual(OUTCOMES, ["attempted", "succeeded", "failed", "skipped", "unsupported"]);
});

test("committed examples validate against the committed schemas", () => {
  const ajv = new Ajv({ allErrors: true });
  const manifestSchema = JSON.parse(readFileSync(join(HERE, "manifest.schema.json"), "utf8"));
  const reportSchema = JSON.parse(readFileSync(join(HERE, "key-hunt-report.schema.json"), "utf8"));
  const validateManifest = ajv.compile(manifestSchema);
  const validateReport = ajv.compile(reportSchema);

  const manifest = readExampleJson("kaifuu-key-hunt-manifest.local.example.json");
  assert.ok(validateManifest(manifest), ajv.errorsText(validateManifest.errors));

  for (const name of ["key-hunt-report.example.json", "key-hunt-no-corpus-skipped.example.json"]) {
    const report = readExampleJson(name);
    assert.ok(validateReport(report), `${name}: ${ajv.errorsText(validateReport.errors)}`);
  }
});
