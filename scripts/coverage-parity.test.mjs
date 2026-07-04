// Regression suite for scripts/coverage-parity.mjs — asserts the synthetic
// corpus is a proven superset of the real-bytes component surface, and that the
// parity evaluator fails loud on a stale map or an uncovered manifest group.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  INSTANTIATION_MAP,
  REAL_ONLY_SURFACES,
  evaluateParity,
  loadManifest,
} from "./coverage-parity.mjs";

const repoRoot = new URL("..", import.meta.url).pathname;
const manifest = loadManifest(repoRoot);

test("every manifest component group has a synthetic instantiation test (synthetic ⊇ real)", () => {
  const violations = evaluateParity(manifest.engineFamilies, INSTANTIATION_MAP);
  assert.deepEqual(violations, [], `parity violations: ${JSON.stringify(violations, null, 2)}`);
});

test("evaluateParity flags a manifest group with no mapped synthetic test", () => {
  const families = {
    reallive: { componentGroups: { opcode_tuple: { count: 1 }, brand_new_group: { count: 1 } } },
  };
  const map = { reallive: { opcode_tuple: { file: "f", test: "t" } } };
  const violations = evaluateParity(families, map);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].group, "brand_new_group");
  assert.match(violations[0].rule, /no synthetic instantiation test/u);
});

test("evaluateParity flags a stale map entry the manifest dropped", () => {
  const families = { reallive: { componentGroups: { opcode_tuple: { count: 1 } } } };
  const map = {
    reallive: { opcode_tuple: { file: "f", test: "t" }, removed_group: { file: "f", test: "t" } },
  };
  const violations = evaluateParity(families, map);
  assert.ok(violations.some((v) => v.group === "removed_group" && /stale map/u.test(v.rule)));
});

test("evaluateParity flags a whole family present in the map but absent from the manifest", () => {
  const families = { reallive: { componentGroups: { opcode_tuple: { count: 1 } } } };
  const map = {
    reallive: { opcode_tuple: { file: "f", test: "t" } },
    ghost_family: { g: { file: "f", test: "t" } },
  };
  const violations = evaluateParity(families, map);
  assert.ok(violations.some((v) => v.family === "ghost_family"));
});

test("every mapped synthetic test file exists and contains its named #[test] fn", () => {
  for (const [family, groups] of Object.entries(INSTANTIATION_MAP)) {
    for (const [group, map] of Object.entries(groups)) {
      const abs = join(repoRoot, map.file);
      assert.ok(existsSync(abs), `${family}/${group}: mapped file missing ${map.file}`);
      const text = readFileSync(abs, "utf8");
      assert.match(text, new RegExp(`fn\\s+${map.test}\\b`, "u"), `${family}/${group}: fn missing`);
    }
  }
});

test("each documented real-only surface names its family, reason, and residual-logic coverage", () => {
  assert.ok(REAL_ONLY_SURFACES.length > 0, "the real-only ledger must be explicit, not empty");
  for (const s of REAL_ONLY_SURFACES) {
    assert.ok(s.id && s.family && s.surface, `real-only surface incomplete: ${JSON.stringify(s)}`);
    assert.ok(s.why_real_only, `${s.id}: missing why_real_only`);
    assert.ok(s.logic_still_covered_by, `${s.id}: missing logic_still_covered_by`);
    assert.ok(manifest.engineFamilies[s.family], `${s.id}: family not in manifest`);
  }
});
