// @itotori-meta-check
// Regression suite for scripts/coverage-parity.mjs — asserts the synthetic
// corpus is a proven superset of the real-bytes component surface, and that the
// parity evaluator fails loud on a stale map or an uncovered manifest group.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  INSTANTIATION_MAP,
  INSTANTIATION_SCHEMA,
  REAL_ONLY_SURFACE_DIRECTORY,
  REAL_ONLY_SURFACES,
  REAL_ONLY_SURFACE_SCHEMA,
  discoverInstantiationMap,
  discoverRealOnlySurfaces,
  evaluateParity,
  loadManifest,
} from "./coverage-parity.mjs";
import {
  collectCapabilityCoverageAdapterIds,
  collectEngineDecodeCoveragePaths,
  delegationMarkerState,
  discoverCoverageIneligiblePorts,
  evaluateDelegationCoverageExclusion,
  parseCargoPackageName,
} from "./delegation-coverage-guard.mjs";
import { parseLaneCrates } from "./audit-strictness.mjs";

const repoRoot = new URL("..", import.meta.url).pathname;
const manifest = loadManifest(repoRoot);
const capabilityMatrix = JSON.parse(
  readFileSync(
    join(repoRoot, "apps/itotori/src/engine-capability/engine-capability-matrix.v0.1.json"),
    "utf8",
  ),
);

function temporaryRoot() {
  return mkdtempSync(join(tmpdir(), "itotori-coverage-parity-"));
}

function writeInstantiation(
  root,
  { source = "sample.rs", group = "sample_group", test = "sample_test", sourceTest = test } = {},
) {
  const tests = join(root, "crates", "example", "tests");
  mkdirSync(join(tests, `${source}.coverage-parity`), { recursive: true });
  writeFileSync(join(tests, source), `#[test]\nfn ${sourceTest}() {}\n`);
  writeFileSync(
    join(tests, `${source}.coverage-parity`, `${group}.json`),
    `${JSON.stringify({ schema: INSTANTIATION_SCHEMA, family: "example", group, test })}\n`,
  );
}

function writeRealOnlySurface(
  root,
  { filename = "sample_surface.json", id = "sample_surface" } = {},
) {
  const directory = join(root, REAL_ONLY_SURFACE_DIRECTORY);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, filename),
    `${JSON.stringify({
      schema: REAL_ONLY_SURFACE_SCHEMA,
      id,
      family: "example",
      surface: "an integration surface",
      why_real_only: "a fixture cannot reproduce it",
      logic_still_covered_by: "a synthetic proof covers its logic",
    })}\n`,
  );
}

test("every manifest component group has a synthetic instantiation test (synthetic ⊇ real)", () => {
  const violations = evaluateParity(manifest.engineFamilies, INSTANTIATION_MAP);
  assert.deepEqual(violations, [], `parity violations: ${JSON.stringify(violations, null, 2)}`);
});

test("instantiation declarations are discovered from one record beside each Rust test", () => {
  const root = temporaryRoot();
  try {
    writeInstantiation(root);
    assert.deepEqual(discoverInstantiationMap(root), {
      example: {
        sample_group: {
          file: "crates/example/tests/sample.rs",
          test: "sample_test",
        },
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an injected instantiation declaration without its named test fails before it can mask coverage", () => {
  const root = temporaryRoot();
  try {
    writeInstantiation(root, { test: "missing_test", sourceTest: "actual_test" });
    assert.throws(
      () => discoverInstantiationMap(root),
      /coverage-parity-instantiation-function-missing/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

test("real-only surfaces are one-file records, and a misnamed injected record fails", () => {
  const root = temporaryRoot();
  try {
    writeRealOnlySurface(root, { filename: "wrong_name.json" });
    assert.throws(
      () => discoverRealOnlySurfaces(root),
      /coverage-parity-real-only-surface-file-name-invalid/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("delegation-only engine ports are excluded from decode and real-game coverage", () => {
  const ports = discoverCoverageIneligiblePorts(repoRoot);
  assert.ok(ports.length > 0, "the marker-derived delegation set must not be vacuous");
  for (const port of ports) {
    assert.equal(port.markers.implementsEnginePort, true);
    assert.equal(port.markers.zeroOpcodeHandlers || port.markers.noReferenceComparison, true);
  }

  const decodePaths = collectEngineDecodeCoveragePaths(
    manifest,
    INSTANTIATION_MAP,
    capabilityMatrix,
  );
  const laneCrates = parseLaneCrates(readFileSync(join(repoRoot, "justfile"), "utf8"));
  const adapterIds = collectCapabilityCoverageAdapterIds(capabilityMatrix);
  assert.deepEqual(
    evaluateDelegationCoverageExclusion(ports, decodePaths, laneCrates, adapterIds),
    [],
  );
});

test("either delegation marker excludes an engine port from coverage", () => {
  const traitImpl = "impl<T> EnginePort for ExamplePort<T> {}";
  const zeroOnly = delegationMarkerState(
    `${traitImpl}\npub const OPCODE_HANDLER_COUNT: usize = 0;`,
  );
  const noReferenceOnly = delegationMarkerState(
    `${traitImpl}\ncapture_method: CaptureMethod::NoReferenceComparison,`,
  );
  assert.equal(zeroOnly.coverageIneligible, true);
  assert.equal(noReferenceOnly.coverageIneligible, true);
});

test("delegation markers in comments do not classify an engine port", () => {
  const comments = [
    "// impl EnginePort for ExamplePort {}",
    "/// pub const OPCODE_HANDLER_COUNT: usize = 0;",
    "// capture_method: CaptureMethod::NoReferenceComparison,",
  ].join("\n");
  assert.equal(delegationMarkerState(comments).coverageIneligible, false);
});

test("a delegation marker without an EnginePort implementation is not classified", () => {
  const source = "pub const OPCODE_HANDLER_COUNT: usize = 0;";
  const markers = delegationMarkerState(source);
  assert.equal(markers.hasDelegationMarker, true);
  assert.equal(markers.coverageIneligible, false);
  const violations = evaluateDelegationCoverageExclusion(
    [
      {
        crate: "engine-package",
        root: "crates/engine-package",
        portId: null,
        ownsRealBytes: false,
        markers,
      },
    ],
    new Set(),
    new Set(),
  );
  assert.ok(violations.some((violation) => violation.rule.includes("not recognizable")));
});

test("Cargo package names, not directory basenames, identify real-game lane entries", () => {
  assert.equal(
    parseCargoPackageName('[package]\nname = "engine-package"\nversion = "0.0.0"\n'),
    "engine-package",
  );
});

test("a delegation-only coverage citation or real-game lane entry fails the guard", () => {
  const ports = [
    {
      crate: "engine-package",
      root: "crates/different-directory",
      portId: "engine-port",
      ownsRealBytes: true,
      markers: { implementsEnginePort: true, coverageIneligible: true },
    },
  ];
  const decodePaths = collectEngineDecodeCoveragePaths(
    { sources: [{ path: "crates/other/../different-directory/src/decoder.rs" }] },
    {},
    { inputs: [] },
  );
  const laneCrates = new Set(["engine-package"]);
  const capabilityIds = collectCapabilityCoverageAdapterIds({
    rows: [
      {
        adapterId: "engine-port",
        levels: { extract: { status: "supported" } },
      },
    ],
  });
  const violations = evaluateDelegationCoverageExclusion(
    ports,
    decodePaths,
    laneCrates,
    capabilityIds,
  );
  assert.equal(violations.length, 4);
  assert.ok(violations.some((violation) => violation.rule.includes("engine-decode")));
  assert.ok(violations.some((violation) => violation.rule.includes("real-game")));
  assert.ok(violations.some((violation) => violation.rule.includes("owning")));
  assert.ok(violations.some((violation) => violation.rule.includes("capability matrix")));
});
