#!/usr/bin/env node
// @itotori-meta-check
// synthetic-fixture-differential-validation — COVERAGE-PARITY check.
//
// The second safeguard (paired with scripts/mutation-differential.mjs). It
// asserts the SYNTHETIC corpus exercises the SAME decode / patchback / replay
// component surface the real-bytes tests do, so a synthetic-only per-gate lane
// cannot silently under-cover a component the real lanes would have caught.
//
// It cross-checks THREE artifacts and fails loud (exit 1) on any mismatch:
//
//   1. fixtures/synthetic/coverage-manifest.v0.json — the per-engine-family
//      enumeration of every UNIQUE component the REAL corpora + real-bytes tests
//      exercise, each entry DERIVED from a named source-of-truth
//      catalogue/enum/assertion (already 100%-instantiated; enforced by
//      scripts/synthetic-coverage-manifest.mjs --check).
//
//   2. INSTANTIATION_MAP — for EVERY manifest component group, the synthetic
//      test file + `#[test]` fn that drives that group's components through the
//      REAL decoder and asserts 100% instantiation. If a manifest group has no
//      synthetic instantiation test, synthetic is NOT a superset of real for
//      that group ⇒ FAIL. (This is what makes "synthetic ⊇ real" enforced, not
//      asserted in prose.)
//
//   3. REAL_ONLY_SURFACES — the explicitly-documented residual surfaces that
//      ONLY real bytes exercise (with the reason each cannot be closed by a
//      synthetic fixture). This is the honest, reviewed gap list — nothing is
//      hidden. Each entry is a real-only *integration* surface whose underlying
//      decode LOGIC is still covered by a targeted synthetic fixture or unit
//      test (documented per entry), so no decode-correctness regression can
//      escape the synthetic suite.
//
// A synthetic fixture QUALIFIES to replace a real-bytes test in a per-gate lane
// only when BOTH safeguards hold: mutation-kill(synthetic) >= mutation-kill(real)
// (mutation-differential) AND coverage-parity (synthetic ⊇ real, this script).
//
// Exit codes:
//   0 — synthetic ⊇ real for every manifest component group.
//   1 — a manifest group lacks a synthetic instantiation test, a mapped test
//       file/fn is missing, or the manifest carries a group the map does not
//       cover. Details to stderr.
//
// Run: node scripts/coverage-parity.mjs         (enforce)
//      node scripts/coverage-parity.mjs --json   (machine-readable ledger)

import { existsSync, globSync, lstatSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { evaluateWorkspaceDelegationExclusion } from "./delegation-coverage-guard.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const MANIFEST_PATH = "fixtures/synthetic/coverage-manifest.v0.json";
const CAPABILITY_MATRIX_PATH =
  "apps/itotori/src/engine-capability/engine-capability-matrix.v0.1.json";

// ---------------------------------------------------------------------------
// Per-item declarations — no central registry to edit when a new synthetic
// proof is added. A descriptor lives beside its Rust integration-test file:
//
//   <test>.rs.coverage-parity/<manifest-group>.json
//
// Each file declares exactly one manifest group and one `fn`; discovery below
// derives the historical family -> group -> test map. Residual real-only
// integration surfaces follow the same model: one reviewed JSON record per
// surface under fixtures/synthetic/coverage-parity/real-only-surfaces/.
// ---------------------------------------------------------------------------
export const INSTANTIATION_SCHEMA = "itotori.coverage-parity-instantiation.v1";
export const REAL_ONLY_SURFACE_SCHEMA = "itotori.coverage-parity-real-only-surface.v1";
export const REAL_ONLY_SURFACE_DIRECTORY = "fixtures/synthetic/coverage-parity/real-only-surfaces";

const INSTANTIATION_DESCRIPTOR_GLOB = "**/*.rs.coverage-parity/*.json";
const INSTANTIATION_DIRECTORY_SUFFIX = ".rs.coverage-parity";
const IDENTIFIER = /^[a-z0-9]+(?:_[a-z0-9]+)*$/u;
const RUST_FUNCTION = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const lexical = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).toSorted(lexical);
  const sortedExpected = expected.toSorted(lexical);
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error(`coverage-parity-${label}-keys-invalid`);
  }
}

function requiredText(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`coverage-parity-${label}-invalid`);
  }
  return value;
}

function requiredIdentifier(value, label) {
  const identifier = requiredText(value, label);
  if (!IDENTIFIER.test(identifier)) throw new Error(`coverage-parity-${label}-invalid`);
  return identifier;
}

function requiredRegularFile(path, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`coverage-parity-${label}-missing:${path}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`coverage-parity-${label}-type-invalid:${path}`);
  }
}

function requiredDirectory(path, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`coverage-parity-${label}-missing:${path}`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`coverage-parity-${label}-type-invalid:${path}`);
  }
}

function parseJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`coverage-parity-${label}-json-invalid:${path}`);
  }
}

function instantiationSourceFile(sidecar) {
  const marker = `${INSTANTIATION_DIRECTORY_SUFFIX}/`;
  const markerIndex = sidecar.lastIndexOf(marker);
  if (markerIndex === -1 || !sidecar.endsWith(".json")) {
    throw new Error(`coverage-parity-instantiation-sidecar-name-invalid:${sidecar}`);
  }
  const source = sidecar.slice(0, markerIndex + ".rs".length);
  if (!source.startsWith("crates/") || !source.includes("/tests/") || !source.endsWith(".rs")) {
    throw new Error(`coverage-parity-instantiation-test-path-invalid:${sidecar}`);
  }
  return source;
}

function readInstantiationDescriptor(root, sidecar) {
  const path = join(root, sidecar);
  requiredRegularFile(path, "instantiation-descriptor");
  const value = parseJson(path, "instantiation-descriptor");
  if (!isRecord(value)) throw new Error(`coverage-parity-instantiation-entry-invalid:${sidecar}`);
  exactKeys(value, ["family", "group", "schema", "test"], `instantiation-entry:${sidecar}`);
  if (value.schema !== INSTANTIATION_SCHEMA) {
    throw new Error(`coverage-parity-instantiation-schema-invalid:${sidecar}`);
  }
  const family = requiredIdentifier(value.family, `instantiation-family:${sidecar}`);
  const group = requiredIdentifier(value.group, `instantiation-group:${sidecar}`);
  const test = requiredText(value.test, `instantiation-test:${sidecar}`);
  if (!RUST_FUNCTION.test(test)) {
    throw new Error(`coverage-parity-instantiation-test-invalid:${sidecar}`);
  }
  const expectedName = `${group}.json`;
  if (sidecar.slice(sidecar.lastIndexOf("/") + 1) !== expectedName) {
    throw new Error(`coverage-parity-instantiation-file-name-invalid:${sidecar}`);
  }
  return { family, group, test, file: instantiationSourceFile(sidecar) };
}

export function discoverInstantiationMap(root = repoRoot) {
  const repositoryRoot = resolve(root);
  const sidecars = globSync(INSTANTIATION_DESCRIPTOR_GLOB, {
    cwd: repositoryRoot,
    exclude: ["**/.git/**", "**/.direnv/**", "**/node_modules/**", "**/target/**"],
  }).toSorted(lexical);
  const map = {};
  for (const sidecar of sidecars) {
    const entry = readInstantiationDescriptor(repositoryRoot, sidecar);
    const source = join(repositoryRoot, entry.file);
    requiredRegularFile(source, `instantiation-test:${entry.file}`);
    const contents = readFileSync(source, "utf8");
    if (!new RegExp(`fn\\s+${entry.test}\\b`, "u").test(contents)) {
      throw new Error(`coverage-parity-instantiation-function-missing:${entry.file}:${entry.test}`);
    }
    const family = (map[entry.family] ??= {});
    if (family[entry.group] !== undefined) {
      throw new Error(`coverage-parity-instantiation-duplicate:${entry.family}/${entry.group}`);
    }
    family[entry.group] = Object.freeze({ file: entry.file, test: entry.test });
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(map).map(([family, groups]) => [family, Object.freeze(groups)]),
    ),
  );
}

function readRealOnlySurface(root, filename) {
  const path = join(root, REAL_ONLY_SURFACE_DIRECTORY, filename);
  requiredRegularFile(path, "real-only-surface");
  const value = parseJson(path, "real-only-surface");
  if (!isRecord(value)) throw new Error(`coverage-parity-real-only-surface-invalid:${filename}`);
  exactKeys(
    value,
    ["family", "id", "logic_still_covered_by", "schema", "surface", "why_real_only"],
    `real-only-surface:${filename}`,
  );
  if (value.schema !== REAL_ONLY_SURFACE_SCHEMA) {
    throw new Error(`coverage-parity-real-only-surface-schema-invalid:${filename}`);
  }
  const id = requiredIdentifier(value.id, `real-only-surface-id:${filename}`);
  if (filename !== `${id}.json`) {
    throw new Error(`coverage-parity-real-only-surface-file-name-invalid:${filename}`);
  }
  return Object.freeze({
    id,
    family: requiredIdentifier(value.family, `real-only-surface-family:${filename}`),
    surface: requiredText(value.surface, `real-only-surface-surface:${filename}`),
    why_real_only: requiredText(value.why_real_only, `real-only-surface-why:${filename}`),
    logic_still_covered_by: requiredText(
      value.logic_still_covered_by,
      `real-only-surface-logic:${filename}`,
    ),
  });
}

export function discoverRealOnlySurfaces(root = repoRoot) {
  const repositoryRoot = resolve(root);
  const directory = join(repositoryRoot, REAL_ONLY_SURFACE_DIRECTORY);
  requiredDirectory(directory, "real-only-surface-directory");
  const ids = new Set();
  return Object.freeze(
    globSync("*.json", { cwd: directory })
      .toSorted(lexical)
      .map((filename) => {
        const surface = readRealOnlySurface(repositoryRoot, filename);
        if (ids.has(surface.id)) {
          throw new Error(`coverage-parity-real-only-surface-duplicate:${surface.id}`);
        }
        ids.add(surface.id);
        return surface;
      }),
  );
}

export const INSTANTIATION_MAP = discoverInstantiationMap();
export const REAL_ONLY_SURFACES = discoverRealOnlySurfaces();

// ---------------------------------------------------------------------------
export function loadManifest(root = repoRoot) {
  return JSON.parse(readFileSync(join(root, MANIFEST_PATH), "utf8"));
}

/**
 * Pure evaluator: given the manifest's engineFamilies and the INSTANTIATION_MAP,
 * return the list of violations (a manifest group with no mapped synthetic test,
 * or a mapped group absent from the manifest).
 */
export function evaluateParity(engineFamilies, instantiationMap) {
  const violations = [];
  for (const [family, famObj] of Object.entries(engineFamilies)) {
    const groups = Object.keys(famObj.componentGroups || {});
    const mapped = instantiationMap[family] || {};
    for (const group of groups) {
      if (!mapped[group]) {
        violations.push({
          family,
          group,
          rule: "manifest component group has no synthetic instantiation test (synthetic NOT ⊇ real)",
        });
      }
    }
    // Also flag a mapped group that no longer exists in the manifest (stale map).
    for (const group of Object.keys(mapped)) {
      if (!groups.includes(group)) {
        violations.push({
          family,
          group,
          rule: "INSTANTIATION_MAP references a group absent from the manifest (stale map)",
        });
      }
    }
  }
  // Flag a whole family in the map that the manifest dropped.
  for (const family of Object.keys(instantiationMap)) {
    if (!engineFamilies[family]) {
      violations.push({
        family,
        group: "*",
        rule: "INSTANTIATION_MAP references a family absent from the manifest (stale map)",
      });
    }
  }
  return violations;
}

function fileContainsTest(relFile, testFn, root = repoRoot) {
  const abs = join(root, relFile);
  if (!existsSync(abs)) return { exists: false, hasTest: false };
  const text = readFileSync(abs, "utf8");
  return { exists: true, hasTest: new RegExp(`fn\\s+${testFn}\\b`, "u").test(text) };
}

function run({ json } = {}) {
  const manifest = loadManifest();
  const capabilityMatrix = JSON.parse(readFileSync(join(repoRoot, CAPABILITY_MATRIX_PATH), "utf8"));
  const families = manifest.engineFamilies || {};

  const violations = evaluateParity(families, INSTANTIATION_MAP);
  const delegationExclusion = evaluateWorkspaceDelegationExclusion({
    root: repoRoot,
    manifest,
    instantiationMap: INSTANTIATION_MAP,
    capabilityMatrix,
    justfileText: readFileSync(join(repoRoot, "justfile"), "utf8"),
  });
  violations.push(...delegationExclusion.violations);

  // Verify every mapped test file exists and contains the named test fn.
  const ledger = [];
  for (const [family, famObj] of Object.entries(families)) {
    for (const group of Object.keys(famObj.componentGroups || {})) {
      const map = (INSTANTIATION_MAP[family] || {})[group];
      const count = famObj.componentGroups[group].count;
      if (!map) {
        ledger.push({ family, group, count, instantiatedBy: null, ok: false });
        continue;
      }
      const { exists, hasTest } = fileContainsTest(map.file, map.test);
      const ok = exists && hasTest;
      if (!ok) {
        violations.push({
          family,
          group,
          rule: `mapped synthetic test ${map.file}#${map.test} is missing`,
        });
      }
      ledger.push({
        family,
        group,
        count,
        instantiatedBy: `${map.file}#${map.test}`,
        ok,
      });
    }
  }

  const report = {
    schema: "itotori.coverage_parity.v0",
    manifest: MANIFEST_PATH,
    ledger,
    realOnlySurfaces: REAL_ONLY_SURFACES,
    excludedDelegationPorts: delegationExclusion.ports,
    violations,
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write("coverage-parity: synthetic ⊇ real component-surface ledger\n");
    for (const row of ledger) {
      const mark = row.ok ? "ok " : "MISS";
      process.stdout.write(
        `  [${mark}] ${row.family}/${row.group} (${row.count} components) <- ${row.instantiatedBy || "(no synthetic test)"}\n`,
      );
    }
    process.stdout.write(
      `\ncoverage-parity: ${REAL_ONLY_SURFACES.length} documented real-only residual surface(s) ` +
        "(decode LOGIC still covered — see REAL_ONLY_SURFACES):\n",
    );
    for (const s of REAL_ONLY_SURFACES) {
      process.stdout.write(`  - ${s.id} [${s.family}]\n`);
    }
    process.stdout.write(
      `\ncoverage-parity: ${delegationExclusion.ports.length} delegation-only engine port(s) ` +
        "excluded from engine-decode and real-game coverage by source markers:\n",
    );
    for (const port of delegationExclusion.ports) {
      process.stdout.write(`  - ${port.root}\n`);
    }
  }

  if (violations.length > 0) {
    process.stderr.write(
      `\ncoverage-parity FAILED: ${violations.length} violation(s) — the synthetic corpus is ` +
        "NOT a proven superset of the real-bytes component surface:\n",
    );
    for (const v of violations) {
      process.stderr.write(`  ${v.family}/${v.group}: ${v.rule}\n`);
    }
    return 1;
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  process.exit(run({ json: process.argv.includes("--json") }));
}

export { run };
