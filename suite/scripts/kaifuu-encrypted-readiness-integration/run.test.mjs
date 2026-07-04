/*
 * KAIFUU-042 — deterministic unit + integration tests for the alpha
 * encrypted-readiness evidence INTEGRATION workflow. `node --test`, no network,
 * no DB, no build, no private corpora: the no-corpus path + the committed public
 * prerequisite fixtures + a MOCK redacted private-corpus manifest drive
 * everything. Proves:
 *   - the composed evidence path NAMES its prerequisites (surfaces, adapters,
 *     command evidence, proof artifacts) and AGGREGATES their proofs by content
 *     hash, WITHOUT re-owning any prerequisite slice;
 *   - with NO private encrypted corpus (default / --no-corpus) it emits the
 *     DETERMINISTIC REDACTED no-corpus artifact — status skipped, reason
 *     private_inputs_absent, redacted corpus ids, ZERO aggregate counts, NO
 *     local paths — byte-stable across runs and matching the committed example;
 *   - an UNSUPPORTED / MISSING / TAMPERED prerequisite stays a SEMANTIC
 *     DIAGNOSTIC (status failed), never a hidden success (boundary regression);
 *   - NO raw key/secret/path/decrypted bytes reach any output;
 *   - the committed examples validate against the committed schemas.
 */
"use strict";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import {
  ENGINES,
  READINESS_BINS,
  SUPPORTED_PREREQUISITE_ENGINE_FAMILIES,
  assertNoSecrets,
  buildNoCorpusArtifact,
  canonicalHash,
  composePrerequisites,
  findSecretLeak,
  normalizePrivateManifest,
  stableStringify,
} from "./compose.mjs";
import { REPO_ROOT, compose, integrate, parseArgs } from "./run.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = join(HERE, "examples");
const PREREQ_MANIFEST = JSON.parse(readFileSync(join(HERE, "prerequisites.manifest.json"), "utf8"));

function readExample(name) {
  return readFileSync(join(EXAMPLES, name), "utf8");
}

function readExampleJson(name) {
  return JSON.parse(readExample(name));
}

test("parseArgs ignores the `vp run -- ` separator", () => {
  assert.equal(parseArgs(["--", "--no-corpus"]).noCorpus, true);
  assert.equal(parseArgs(["--no-corpus"]).noCorpus, true);
});

test("composed evidence path NAMES prerequisites and AGGREGATES their proofs", () => {
  const composed = compose({ prerequisites: PREREQ_PATH() });
  // Names the prerequisite surfaces, adapters, command evidence, and artifacts.
  assert.deepEqual(composed.composes.surfaces.map((s) => s.sourceNodeId).sort(), [
    "KAIFUU-103",
    "KAIFUU-104",
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
  assert.equal(composed.composes.prerequisiteCounts.coveredSourceNodes, 2);
  assert.match(composed.composedEvidenceHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(composed.findings.length, 0);
});

function PREREQ_PATH() {
  return "suite/scripts/kaifuu-encrypted-readiness-integration/prerequisites.manifest.json";
}

test("no-corpus: deterministic redacted artifact, stable across runs", () => {
  const a = integrate({ noCorpus: true, prerequisites: PREREQ_PATH() }).artifact;
  const b = integrate({ noCorpus: true, prerequisites: PREREQ_PATH() }).artifact;
  assert.equal(stableStringify(a), stableStringify(b), "no-corpus artifact must be deterministic");
  assert.equal(a.status, "skipped");
  assert.equal(a.reason, "private_inputs_absent");
  assert.deepEqual(a.corpusIds, [], "redacted corpus ids empty");
  assert.deepEqual(a.checkedInputs, ["private-encrypted-corpus-root"]);
  assert.equal(a.command, "vp run kaifuu:encrypted-readiness -- --no-corpus");
  // ZERO aggregate counts.
  for (const key of Object.keys(a.aggregateCounts)) {
    assert.equal(a.aggregateCounts[key], 0, `no-corpus ${key} count must be zero`);
  }
  // Per-engine bins present and all zero.
  for (const engine of ENGINES) {
    for (const bin of READINESS_BINS) {
      assert.equal(a.engineReadinessBins[engine][bin], 0);
    }
  }
  assert.deepEqual(a.entries, []);
  // NO local paths anywhere.
  assert.doesNotMatch(stableStringify(a), /\/home\/|\/Users\/|\/scratch\/|[A-Za-z]:\\/);
});

test("no-corpus: matches the committed README-safe example", () => {
  const { artifact } = integrate({ noCorpus: true, prerequisites: PREREQ_PATH() });
  assert.deepEqual(artifact, readExampleJson("no-corpus-skipped.example.json"));
});

test("default (no --private-manifest) falls back to the no-corpus artifact", () => {
  const { kind, artifact } = integrate({ prerequisites: PREREQ_PATH() });
  assert.equal(kind, "no-corpus");
  assert.equal(artifact.status, "skipped");
  assert.equal(artifact.reason, "private_inputs_absent");
});

test("a configured but absent private manifest still skips (never fails)", () => {
  const { kind, artifact } = integrate({
    prerequisites: PREREQ_PATH(),
    privateManifest: "does/not/exist/private.local.json",
  });
  assert.equal(kind, "no-corpus");
  assert.equal(artifact.status, "skipped");
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
    readExampleJson("no-corpus-skipped.example.json").composedEvidenceHash,
    "composed prerequisite hash is stable across modes",
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
  // And the built no-corpus artifact status is FAILED — never "ok"/"skipped".
  assert.equal(buildNoCorpusArtifact({ composed }).status, "failed");
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

test("TAMPERED prerequisite (wrong source node) is a source_node_mismatch diagnostic", () => {
  const manifest = structuredClone(PREREQ_MANIFEST);
  const composed = composePrerequisites(manifest, (relPath) => {
    const parsed = JSON.parse(readFileSync(join(REPO_ROOT, relPath), "utf8"));
    // Simulate someone swapping in an artifact from a different slice.
    return { ...parsed, sourceNodeId: "KAIFUU-999" };
  });
  assert.ok(
    composed.findings.some((f) => f.code === "kaifuu.encrypted_readiness.source_node_mismatch"),
  );
});

test("prerequisite content hash changes iff the proof content changes (formatter-independent)", () => {
  const base = { sourceNodeId: "KAIFUU-103", engineFamily: "siglus", a: 1, b: 2 };
  const reordered = { b: 2, engineFamily: "siglus", a: 1, sourceNodeId: "KAIFUU-103" };
  const changed = { sourceNodeId: "KAIFUU-103", engineFamily: "siglus", a: 1, b: 3 };
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

  for (const name of ["no-corpus-skipped.example.json", "composed-readiness-report.example.json"]) {
    const report = readExampleJson(name);
    assert.ok(validateReport(report), `${name}: ${ajv.errorsText(validateReport.errors)}`);
  }
  const manifest = readExampleJson("private-encrypted-corpus-manifest.local.example.json");
  assert.ok(validatePrivate(manifest), ajv.errorsText(validatePrivate.errors));
});
