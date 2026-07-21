import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  CAPABILITY_LEVELS,
  MatrixGenerationError,
  OUTPUT_JSON_PATH,
  REQUIRED_INPUT_CATEGORIES,
  REQUIRED_INPUT_KINDS,
  assertRequiredCoverage,
  buildArtifacts,
  collectConsumedNamespaces,
  generateEngineCapabilityMatrix,
  loadInputs,
  renderKnownLimitations,
  repoRoot,
} from "./generate-engine-capability-matrix.mjs";

const inputs = loadInputs(repoRoot);
const matrix = generateEngineCapabilityMatrix(inputs);
const rowsById = new Map(matrix.rows.map((row) => [row.rowId, row]));

test("matrix is generated from every required input category and kind", () => {
  for (const category of REQUIRED_INPUT_CATEGORIES) {
    assert.ok(
      matrix.inputCategoriesCovered.includes(category),
      `expected input category ${category} to be consumed`,
    );
  }
  for (const kind of REQUIRED_INPUT_KINDS) {
    assert.ok(
      matrix.inputKindsCovered.includes(kind),
      `expected input kind ${kind} to be consumed`,
    );
  }
  // Category coverage list must not include pure-kind labels like adapter_registry.
  assert.ok(
    !matrix.inputCategoriesCovered.includes("adapter_registry"),
    "adapter_registry is a kind, not a category — must not appear in inputCategoriesCovered",
  );
  // Covered namespaces must match a fresh collect (no cross-namespace bleed).
  const collected = collectConsumedNamespaces(matrix.rows);
  assert.deepEqual(matrix.inputCategoriesCovered, collected.categories);
  assert.deepEqual(matrix.inputKindsCovered, collected.kinds);
});

test("a kind value does not satisfy a required category (and vice versa)", () => {
  // Evidence whose KIND is "fixture_output" must not cover the CATEGORY
  // fixture_output. All required kinds are present; one required category is
  // only present as a kind string.
  const kindDoesNotCoverCategory = collectConsumedNamespaces([
    {
      evidence: [
        { sourceId: "synth-a", category: "claimed_support_tuples", kind: "adapter_registry" },
        { sourceId: "synth-b", category: "readiness_profile", kind: "fixture_output" },
        { sourceId: "synth-c", category: "validation_artifact", kind: "validation_artifact" },
      ],
    },
  ]);
  assert.deepEqual(kindDoesNotCoverCategory.categories, [
    "claimed_support_tuples",
    "readiness_profile",
    "validation_artifact",
  ]);
  assert.ok(kindDoesNotCoverCategory.kinds.includes("fixture_output"));
  assert.ok(!kindDoesNotCoverCategory.categories.includes("fixture_output"));
  assert.throws(
    () => assertRequiredCoverage(kindDoesNotCoverCategory),
    (error) =>
      error instanceof MatrixGenerationError &&
      /required input category/.test(error.message) &&
      /fixture_output/.test(error.message),
  );

  // Evidence whose CATEGORY is "adapter_registry" must not cover the KIND
  // adapter_registry. All required categories are present as categories only.
  const categoryDoesNotCoverKind = collectConsumedNamespaces([
    {
      evidence: [
        { sourceId: "synth-d", category: "adapter_registry", kind: "detector_profile" },
        { sourceId: "synth-e", category: "fixture_output", kind: "detector_profile" },
        { sourceId: "synth-f", category: "readiness_profile", kind: "readiness_profile" },
        {
          sourceId: "synth-g",
          category: "claimed_support_tuples",
          kind: "production_capability_tuple",
        },
        { sourceId: "synth-h", category: "validation_artifact", kind: "validation_artifact" },
      ],
    },
  ]);
  assert.ok(categoryDoesNotCoverKind.categories.includes("adapter_registry"));
  assert.ok(!categoryDoesNotCoverKind.kinds.includes("adapter_registry"));
  assert.throws(
    () => assertRequiredCoverage(categoryDoesNotCoverKind),
    (error) =>
      error instanceof MatrixGenerationError &&
      /required input kind/.test(error.message) &&
      /adapter_registry/.test(error.message),
  );

  // Happy path: distinct namespaces both satisfied.
  assertRequiredCoverage(
    collectConsumedNamespaces([
      {
        evidence: [
          { sourceId: "synth-ok", category: "fixture_output", kind: "adapter_registry" },
          { sourceId: "synth-ok-2", category: "readiness_profile", kind: "readiness_profile" },
          {
            sourceId: "synth-ok-3",
            category: "claimed_support_tuples",
            kind: "production_capability_tuple",
          },
          { sourceId: "synth-ok-4", category: "validation_artifact", kind: "validation_artifact" },
        ],
      },
    ]),
  );
});

test("every row carries all six capability levels with traceable derivation", () => {
  for (const row of matrix.rows) {
    for (const level of CAPABILITY_LEVELS) {
      const c = row.levels[level];
      assert.ok(c, `${row.rowId} missing level ${level}`);
      assert.ok(
        typeof c.derivedFrom === "string" && c.derivedFrom.length > 0,
        `${row.rowId}.${level} has no derivedFrom evidence pointer`,
      );
    }
    assert.ok(row.evidence.length > 0, `${row.rowId} has no evidence sources`);
  }
});

test("positive extraction/patch adapter and readiness-only profiles are mechanically distinguished", () => {
  // The synthetic fixture, bounded plain XP3 writer, JSON-text engine path,
  // and Softpal are positive extract+patch adapters. The production rows are
  // admitted only through their strict real-byte proof tuples; every other
  // row is readiness-only.
  const positives = matrix.rows.filter((r) => r.evidencePosture === "positive_adapter");
  assert.deepEqual(
    positives.map((r) => r.rowId),
    [
      "synthetic-fixture-plaintext-identity",
      "kirikiri-xp3-plain-extract-patch",
      "rpg-maker-mv-mz-json-text-extract-patch",
      "softpal-script-src-text-dat-extract-patch",
    ],
  );
  const fixture = rowsById.get("synthetic-fixture-plaintext-identity");
  assert.equal(fixture.levels.extract.status, "supported");

  // A readiness/validation smoke that parsed some text (Siglus known-key)
  // still extracts==partial but must NOT be promoted to a positive adapter.
  const siglusSmoke = rowsById.get("siglus-known-key-scene-gameexe-smoke");
  assert.equal(siglusSmoke.levels.extract.status, "partial");
  assert.equal(siglusSmoke.evidencePosture, "readiness_only");

  // Every packed/encrypted profile row is readiness-only and claims no patch.
  for (const row of matrix.rows) {
    if (row.evidencePosture === "readiness_only") {
      assert.notEqual(
        row.levels.patch.status,
        "supported",
        `${row.rowId} is readiness-only but claims patch support`,
      );
    }
  }
});

test("Softpal is a positive extract+patch adapter derived from real capability tuples", () => {
  const softpal = rowsById.get("softpal-script-src-text-dat-extract-patch");
  assert.ok(softpal, "Softpal capability row must exist");
  assert.equal(softpal.engineFamily, "softpal");
  assert.equal(softpal.adapterId, "kaifuu.softpal");
  assert.equal(softpal.evidencePosture, "positive_adapter");
  // Level statuses mirror `kaifuu-cli capabilities` -> kaifuu.softpal: extract
  // Supported, patch Partial (patching/patch_back Limited), runtime Unsupported.
  assert.equal(softpal.levels.identify.status, "supported");
  assert.equal(softpal.levels.inventory.status, "supported");
  assert.equal(softpal.levels.extract.status, "supported");
  assert.equal(softpal.levels.patch.status, "partial");
  assert.equal(softpal.levels.runtime.status, "unsupported");
  // TEXT.DAT crypto is internal (crypto_access + encrypted_input Supported, no
  // key_profile): the helper rung is not_applicable, not "unknown".
  assert.equal(softpal.levels.helper.status, "not_applicable");

  // The status is genuinely derived: flipping the real extraction tuple to
  // Unsupported must demote the extract rung (no silent/hand-set cells).
  const tampered = structuredClone(inputs);
  const softpalAdapter = tampered["reallive-detector-capabilities"].find(
    (a) => a.adapterId === "kaifuu.softpal",
  );
  for (const report of softpalAdapter.reports) {
    if (report.capability === "extraction") {
      report.status = "unsupported";
    }
  }
  const regenerated = generateEngineCapabilityMatrix(tampered).rows.find(
    (r) => r.rowId === "softpal-script-src-text-dat-extract-patch",
  );
  assert.equal(regenerated.levels.extract.status, "unsupported");
});

test("RealLive accepted-output patched-build produce is declared and gate-enforced", () => {
  const produce = rowsById.get("reallive-accepted-output-patchback-produce");
  assert.ok(produce, "patchback-produce capability row must exist");
  assert.equal(produce.engineFamily, "reallive");
  assert.equal(produce.scenario, "accepted-output-patched-build-produce");
  assert.equal(produce.evidencePosture, "readiness_only");
  assert.equal(produce.levels.extract.status, "partial");
  assert.equal(produce.levels.patch.status, "partial");
  assert.deepEqual(produce.evidence, [
    {
      sourceId: "reallive-patchback-produce",
      category: "validation_artifact",
      kind: "validation_artifact",
    },
  ]);

  // This row cannot survive as a hand-written claim: losing either the real
  // two-corpus proof declaration or the shared native seam demotes patching.
  for (const [path, value] of [
    [["status"], "failed"],
    [["nativeSeam"], "mockPatchback"],
    [["realBytes", "minimumDistinctGames"], 1],
  ]) {
    const tampered = structuredClone(inputs);
    let target = tampered["reallive-patchback-produce"];
    for (const key of path.slice(0, -1)) target = target[key];
    target[path.at(-1)] = value;
    const regenerated = generateEngineCapabilityMatrix(tampered).rows.find(
      (row) => row.rowId === "reallive-accepted-output-patchback-produce",
    );
    assert.equal(regenerated.levels.patch.status, "unsupported");
  }
});

test("RenPy is not presented as an alpha Japanese opportunity driver", () => {
  const renpyRows = matrix.rows.filter((r) => r.engineFamily === "renpy");
  assert.equal(renpyRows.length, 0, "RenPy must not appear as a capability row");
  const exclusion = matrix.exclusions.find((e) => e.engineFamily === "renpy");
  assert.ok(exclusion, "RenPy must be recorded as an explicit non-driver exclusion");
  assert.match(exclusion.reason, /opportunity driver/i);
});

test("KiriKiri keeps detector breadth separate from its bounded plain-XP3 writer", () => {
  const kirikiri = matrix.rows.filter((r) => r.engineFamily === "kiri_kiri_xp3");
  // Plain, compressed, and encrypted XP3 variants are all represented.
  assert.ok(kirikiri.length >= 4, "KiriKiri must span detector variants plus the writer");
  const scenarios = kirikiri.map((r) => r.scenario).join(",");
  for (const variant of ["plain", "compressed", "encrypted"]) {
    assert.match(scenarios, new RegExp(`xp3-${variant}`), `missing XP3 ${variant} row`);
  }
  // The broad detector profiles remain readiness-only and do not claim
  // extraction or patching merely because they identified a container.
  const readinessRows = kirikiri.filter((row) => row.evidencePosture === "readiness_only");
  assert.equal(readinessRows.length, 3);
  for (const row of readinessRows) {
    assert.equal(row.levels.extract.status, "unsupported");
    assert.equal(row.levels.patch.status, "unsupported");
    assert.ok(
      row.limitations.some((l) => /XP3 container\/readiness/i.test(l)),
      `${row.rowId} must record the XP3-readiness (not plaintext-only) limitation`,
    );
  }
  const writer = rowsById.get("kirikiri-xp3-plain-extract-patch");
  assert.ok(writer, "plain XP3 writer production row must exist");
  assert.equal(writer.evidencePosture, "positive_adapter");
  assert.equal(writer.levels.extract.status, "supported");
  assert.equal(writer.levels.patch.status, "supported");
  assert.ok(
    writer.limitations.some((limitation) => /compressed-entry replacement/i.test(limitation)),
    "writer row must retain its compressed/encrypted boundary",
  );
  // The crypt smoke row is present.
  assert.ok(rowsById.has("kirikiri-xp3-encrypted-crypt-smoke"));
});

test("production extract/patch rows require their strict real-byte proof", () => {
  const rpg = rowsById.get("rpg-maker-mv-mz-json-text-extract-patch");
  assert.ok(rpg, "JSON-text production row must exist");
  assert.equal(rpg.evidencePosture, "positive_adapter");
  assert.equal(rpg.levels.extract.status, "supported");
  assert.equal(rpg.levels.patch.status, "supported");
  assert.ok(
    rpg.limitations.some((limitation) => /plugin JavaScript and encrypted media/i.test(limitation)),
    "JSON-text row must retain its non-text boundary",
  );

  for (const claimId of ["kirikiri-xp3-plain-writer", "rpg-maker-mv-mz-json-text"]) {
    const tampered = structuredClone(inputs);
    const claim = tampered["production-extract-patch-proofs"].claims.find(
      (candidate) => candidate.claimId === claimId,
    );
    claim.realBytes.status = "failed";
    const regenerated = generateEngineCapabilityMatrix(tampered).rows.find((row) =>
      claimId === "kirikiri-xp3-plain-writer"
        ? row.rowId === "kirikiri-xp3-plain-extract-patch"
        : row.rowId === "rpg-maker-mv-mz-json-text-extract-patch",
    );
    assert.equal(regenerated.levels.extract.status, "unsupported");
    assert.equal(regenerated.levels.patch.status, "unsupported");
    assert.equal(regenerated.evidencePosture, "readiness_only");
  }

  const malformed = structuredClone(inputs);
  malformed["production-extract-patch-proofs"].claims[0].capabilityTuple.kind = "wrong";
  assert.throws(
    () => generateEngineCapabilityMatrix(malformed),
    (error) =>
      error instanceof MatrixGenerationError &&
      /invalid production-proof shape/.test(error.message),
  );
});

test("BGI is detector/profile readiness evidence with no parser or patch claim", () => {
  const bgi = rowsById.get("bgi-ethornell-container-readiness");
  assert.ok(bgi, "BGI readiness row must exist");
  assert.equal(bgi.evidencePosture, "readiness_only");
  assert.equal(bgi.levels.identify.status, "supported");
  assert.equal(bgi.levels.extract.status, "unsupported");
  assert.equal(bgi.levels.patch.status, "unsupported");
  assert.equal(bgi.levels.runtime.status, "unsupported");
});

test("the four required encrypted/known-key scenarios are separate capability rows", () => {
  for (const rowId of [
    "rpg-maker-mv-mz-encrypted-media",
    "siglus-known-key-scene-gameexe-smoke",
    "kirikiri-xp3-encrypted-crypt-smoke",
    "wolf-rpg-editor-encrypted-archive-smoke",
  ]) {
    assert.ok(rowsById.has(rowId), `missing required scenario row ${rowId}`);
  }
});

test("a missing input artifact fails with a structured diagnostic naming it", () => {
  const emptyRoot = mkdtempSync(join(tmpdir(), "alpha004-empty-"));
  assert.throws(
    () => loadInputs(emptyRoot),
    (error) =>
      error instanceof MatrixGenerationError &&
      /missing input artifact "reallive-detector-capabilities"/.test(error.message),
  );
});

test("a hand-edited claimed-support input changes the derived posture (no silent cells)", () => {
  // Mutate the fixture adapter's extraction claim to Unsupported; the row must
  // mechanically demote from positive_adapter to readiness_only.
  const tampered = structuredClone(inputs);
  const fixtureAdapter = tampered["reallive-detector-capabilities"].find(
    (a) => a.adapterId === "kaifuu.fixture",
  );
  for (const report of fixtureAdapter.reports) {
    if (report.capability === "extraction") {
      report.status = "unsupported";
    }
  }
  const regenerated = generateEngineCapabilityMatrix(tampered);
  const fixtureRow = regenerated.rows.find(
    (r) => r.rowId === "synthetic-fixture-plaintext-identity",
  );
  assert.equal(fixtureRow.levels.extract.status, "unsupported");
  // patch is still partial, so it remains a positive adapter; flip patch too.
  assert.equal(fixtureRow.evidencePosture, "positive_adapter");
  for (const report of fixtureAdapter.reports) {
    if (report.capability === "patching" || report.capability === "patch_back") {
      report.status = "unsupported";
    }
  }
  const demoted = generateEngineCapabilityMatrix(tampered).rows.find(
    (r) => r.rowId === "synthetic-fixture-plaintext-identity",
  );
  assert.equal(demoted.evidencePosture, "readiness_only");
});

test("generation is deterministic and the committed artifact is not stale", () => {
  const first = buildArtifacts(repoRoot).json;
  const second = buildArtifacts(repoRoot).json;
  assert.equal(first, second, "generation must be deterministic");
  const committed = readFileSync(resolve(repoRoot, OUTPUT_JSON_PATH), "utf8");
  assert.equal(committed, first, "committed engine capability matrix is stale; regenerate it");
});

test("known-limitation renderer surfaces row limitations and the RenPy exclusion", () => {
  const rendered = renderKnownLimitations(matrix);
  assert.match(rendered, /## Known limitations/);
  assert.match(rendered, /\[exclusion:renpy\]/);
  assert.match(rendered, /kirikiri-xp3-encrypted-crypt-smoke/);
});
