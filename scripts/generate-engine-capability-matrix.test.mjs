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
  buildArtifacts,
  generateEngineCapabilityMatrix,
  loadInputs,
  renderKnownLimitations,
  repoRoot,
} from "./generate-engine-capability-matrix.mjs";

const inputs = loadInputs(repoRoot);
const matrix = generateEngineCapabilityMatrix(inputs);
const rowsById = new Map(matrix.rows.map((row) => [row.rowId, row]));

test("matrix is generated from every required input category", () => {
  for (const category of REQUIRED_INPUT_CATEGORIES) {
    assert.ok(
      matrix.inputCategoriesCovered.includes(category),
      `expected input category ${category} to be consumed`,
    );
  }
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
  // Exactly the synthetic fixture adapter (a real extract+patch adapter,
  // evidenced by claimed-support tuples) is a positive adapter.
  const positives = matrix.rows.filter((r) => r.evidencePosture === "positive_adapter");
  assert.deepEqual(
    positives.map((r) => r.rowId),
    ["synthetic-fixture-plaintext-identity"],
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

test("RenPy is not presented as an alpha Japanese opportunity driver", () => {
  const renpyRows = matrix.rows.filter((r) => r.engineFamily === "renpy");
  assert.equal(renpyRows.length, 0, "RenPy must not appear as a capability row");
  const exclusion = matrix.exclusions.find((e) => e.engineFamily === "renpy");
  assert.ok(exclusion, "RenPy must be recorded as an explicit non-driver exclusion");
  assert.match(exclusion.reason, /opportunity driver/i);
});

test("KiriKiri breadth is XP3/readiness evidence, not plaintext-only support", () => {
  const kirikiri = matrix.rows.filter((r) => r.engineFamily === "kiri_kiri_xp3");
  // Plain, compressed, and encrypted XP3 variants are all represented.
  assert.ok(kirikiri.length >= 3, "KiriKiri must span multiple XP3 variants");
  const scenarios = kirikiri.map((r) => r.scenario).join(",");
  for (const variant of ["plain", "compressed", "encrypted"]) {
    assert.match(scenarios, new RegExp(`xp3-${variant}`), `missing XP3 ${variant} row`);
  }
  // None claim plaintext-only extract/patch: XP3 readiness extracts/patches none.
  for (const row of kirikiri) {
    assert.equal(row.levels.extract.status, "unsupported");
    assert.equal(row.levels.patch.status, "unsupported");
    assert.ok(
      row.limitations.some((l) => /XP3 container\/readiness/i.test(l)),
      `${row.rowId} must record the XP3-readiness (not plaintext-only) limitation`,
    );
  }
  // The crypt smoke row is present.
  assert.ok(rowsById.has("kirikiri-xp3-encrypted-crypt-smoke"));
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

test("Softpal is a first-class engine family row (parity with RealLive readiness registration)", () => {
  const softpal = rowsById.get("softpal-pac-detector-readiness");
  assert.ok(softpal, "Softpal readiness row must exist");
  assert.equal(softpal.engineFamily, "softpal");
  assert.equal(softpal.adapterId, "kaifuu.softpal");
  assert.equal(softpal.evidencePosture, "readiness_only");
  assert.equal(softpal.levels.identify.status, "supported");
  assert.equal(softpal.levels.extract.status, "unsupported");
  assert.equal(softpal.levels.patch.status, "unsupported");
  assert.equal(softpal.levels.runtime.status, "unsupported");
  // RealLive remains registered the same way — Softpal is not a one-off island.
  const reallive = rowsById.get("reallive-seen-txt-detector-readiness");
  assert.ok(reallive, "RealLive readiness row must still exist");
  assert.equal(reallive.adapterId, "kaifuu.reallive");
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
