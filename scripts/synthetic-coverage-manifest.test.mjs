import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  OUTPUT_JSON_PATH,
  buildArtifact,
  buildManifest,
  diffManifests,
  extractCipherCases,
  extractEnumVariants,
  extractFamilyFor,
  extractG00Types,
  extractRealliveCatalogTuples,
  extractRpgMakerCodes,
  loadSources,
  repoRoot,
} from "./synthetic-coverage-manifest.mjs";

const sources = loadSources(repoRoot);
const manifest = buildManifest(sources);

// ---------------------------------------------------------------------------
// The manifest is DERIVED and byte-identical to the committed artifact.
// ---------------------------------------------------------------------------

test("committed manifest is byte-identical to the freshly re-derived one (no drift, no hand-edit)", () => {
  const { json } = buildArtifact(repoRoot);
  const committed = readFileSync(resolve(repoRoot, OUTPUT_JSON_PATH), "utf8");
  assert.equal(
    committed,
    json,
    "committed coverage manifest is stale — regenerate with `node scripts/synthetic-coverage-manifest.mjs`",
  );
});

test("the check reports ZERO missing components against the committed manifest (100% real coverage)", () => {
  const committed = JSON.parse(readFileSync(resolve(repoRoot, OUTPUT_JSON_PATH), "utf8"));
  const { missing, extra } = diffManifests(committed, manifest);
  assert.deepEqual(missing, [], "manifest must catalogue every real-bytes-exercised component");
  assert.deepEqual(extra, [], "manifest must not contain invented/stale components");
});

// ---------------------------------------------------------------------------
// Every extractor parses its real source-of-truth symbol (provably derived).
// ---------------------------------------------------------------------------

test("RealLive opcode tuples are extracted from REAL_CATALOG and family-tagged from family_for", () => {
  const familyOf = extractFamilyFor(sources.realliveCatalog);
  const tuples = extractRealliveCatalogTuples(sources.realliveCatalog);
  assert.ok(tuples.length > 200, `expected the full REAL_CATALOG, got ${tuples.length}`);
  // Spot pins from the real catalogue.
  assert.ok(tuples.some((t) => t.moduleId === 2 && t.opcode === 2));
  assert.ok(tuples.some((t) => t.moduleId === 33 && t.opcode === 73));
  // family_for mapping (with `|` and `..=` arms) resolves.
  assert.equal(familyOf(2), "sel");
  assert.equal(familyOf(33), "grp");
  assert.equal(familyOf(5), "sys"); // `4 | 5 => "sys"` alternation arm
  assert.equal(familyOf(72), "grp_obj"); // `71..=73 => "grp_obj"` range arm
});

test("RealLive element/expression enums, openers, named opcodes, cipher, g00 all extract", () => {
  assert.ok(extractEnumVariants(sources.realliveOpcode, "RealLiveOpcode").includes("MetaKidoku"));
  assert.deepEqual(extractEnumVariants(sources.realliveOpcode, "Expr").sort(), [
    "Binary",
    "Complex",
    "IntLiteral",
    "MemoryRef",
    "SpecialParam",
    "StoreRegister",
    "StrLiteral",
    "Unary",
  ]);
  const cipher = extractCipherCases(sources.realliveXor2);
  assert.ok(cipher.some((c) => c.compilerVersion === 110002 && c.usesXor2 === true));
  assert.ok(cipher.some((c) => c.compilerVersion === 10002 && c.usesXor2 === false));
  const g00 = extractG00Types(sources.realliveG00);
  assert.equal(g00.length, 3);
  assert.equal(g00.find((t) => t.name === "G00_TYPE_RAW_BGR").lzss, false);
});

test("RPG Maker classify() codes extract text-bearing + text-adjacent + structural codes", () => {
  const codes = extractRpgMakerCodes(sources.rpgMakerCodes);
  const byCode = new Map(codes.map((c) => [c.code, c]));
  assert.deepEqual(byCode.get(401), { code: 401, class: "Text", role: "DialogueLine" });
  assert.deepEqual(byCode.get(102), { code: 102, class: "Text", role: "ChoiceList" });
  assert.equal(byCode.get(101).class, "ShowTextSetup");
  assert.equal(byCode.get(356).class, "Plugin");
  // Structural codes from the multi-number `|` block are captured too.
  assert.equal(byCode.get(201).class, "Structural");
});

// ---------------------------------------------------------------------------
// DRIFT GUARD: a new real-bytes-exercised component that is NOT re-catalogued
// makes the check FAIL. Proven by feeding the extractor mutated source text
// (a fake un-catalogued REAL_CATALOG tuple) and by dropping a component from
// the committed manifest.
// ---------------------------------------------------------------------------

test("adding a fake un-catalogued REAL_CATALOG tuple makes the coverage check FAIL", () => {
  const committed = JSON.parse(readFileSync(resolve(repoRoot, OUTPUT_JSON_PATH), "utf8"));

  // Inject a fake tuple into the REAL_CATALOG source (as if a new real-bytes
  // opcode had just been catalogued in the Rust source).
  const mutatedSources = {
    ...sources,
    realliveCatalog: sources.realliveCatalog.replace("(2, 2),", "(2, 2),\n    (99, 9999),"),
  };
  const mutatedManifest = buildManifest(mutatedSources);

  const { missing } = diffManifests(committed, mutatedManifest);
  assert.ok(
    missing.some((entry) => entry.includes("9999")),
    `drift guard must flag the un-catalogued (99, 9999) tuple; got: ${missing.join("; ")}`,
  );
});

test("dropping a catalogued component from the manifest makes the coverage check FAIL", () => {
  const dropped = structuredClone(manifest);
  const tuples = dropped.engineFamilies.reallive.componentGroups.opcode_tuple.components;
  const removed = tuples.pop();

  // Treat `dropped` as the committed manifest and `manifest` as the derived
  // one: the derived manifest still exercises the tuple the dropped one lacks.
  const { missing } = diffManifests(dropped, manifest);
  assert.ok(
    missing.some((entry) => entry.includes(`"opcode":${removed.opcode}`)),
    `dropping ${JSON.stringify(removed)} must surface as a missing real-coverage component`,
  );
});
