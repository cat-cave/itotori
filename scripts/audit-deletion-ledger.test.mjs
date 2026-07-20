// Regression suite for the deletion-ledger CI guard.
//
// Proves the guard catches every mismatch kind: a missing path, a stale line
// count, a path that should be gone but is still present, and a contractual
// total that disagrees with its parts. A clean ledger passes.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  collectFiles,
  countLinesInDir,
  evaluateLedger,
  loadLedger,
} from "./audit-deletion-ledger.mjs";

function makeTree() {
  const root = mkdtempSync(join(tmpdir(), "ledger-"));
  return root;
}

function writeTs(dir, name, lines) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `${"x\n".repeat(lines)}`);
}

function baseLedger() {
  return {
    version: 1,
    contractualTotalLines: 0,
    delete: {
      appSurface: [],
      providerCollateral: [],
      qaCollateral: [],
      dbCollateral: [],
      schemaCollateral: [],
      migrationsRetired: [],
      migrationsSurgery: [],
    },
    rehome: [],
    keepSeams: [],
    retiredDbTables: [],
    llmLayer: {},
  };
}

test("collectFiles finds .ts and .tsx files recursively", () => {
  const root = makeTree();
  writeTs(join(root, "a"), "f.ts", 3);
  writeTs(join(root, "a", "b"), "g.tsx", 2);
  writeFileSync(join(root, "a", "ignore.md"), "noise\n");
  const files = collectFiles(join(root, "a"), new Set([".ts", ".tsx"]));
  assert.equal(files.length, 2);
});

test("countLinesInDir sums all matching files", () => {
  const root = makeTree();
  writeTs(join(root, "d"), "a.ts", 10);
  writeTs(join(root, "d"), "b.ts", 5);
  assert.equal(countLinesInDir(join(root, "d"), new Set([".ts"])), 15);
});

test("a clean glob entry with correct line count passes", () => {
  const root = makeTree();
  writeTs(join(root, "agents"), "a.ts", 40);
  writeTs(join(root, "agents"), "b.ts", 60);
  const ledger = baseLedger();
  ledger.contractualTotalLines = 100;
  ledger.delete.appSurface = [
    {
      id: "agents",
      kind: "glob",
      root: "agents/",
      extensions: [".ts", ".tsx"],
      lines: 100,
      expected: "present",
    },
  ];
  const { ok, violations } = evaluateLedger(ledger, root);
  assert.equal(ok, true);
  assert.equal(violations.length, 0);
});

test("a planted line-count drift fails", () => {
  const root = makeTree();
  writeTs(join(root, "agents"), "a.ts", 30);
  const ledger = baseLedger();
  ledger.contractualTotalLines = 100;
  ledger.delete.appSurface = [
    {
      id: "agents",
      kind: "glob",
      root: "agents/",
      extensions: [".ts"],
      lines: 999,
      expected: "present",
    },
  ];
  const { ok, violations } = evaluateLedger(ledger, root);
  assert.equal(ok, false);
  assert.equal(violations[0].kind, "line-count-drift");
});

test("a missing glob directory fails", () => {
  const root = makeTree();
  const ledger = baseLedger();
  ledger.delete.appSurface = [
    {
      id: "ghost",
      kind: "glob",
      root: "nonexistent/",
      extensions: [".ts"],
      lines: 0,
      expected: "present",
    },
  ];
  const { ok, violations } = evaluateLedger(ledger, root);
  assert.equal(ok, false);
  assert.equal(violations[0].kind, "missing-dir");
});

test("a present file expected absent fails", () => {
  const root = makeTree();
  writeTs(join(root, "x"), "f.ts", 5);
  const ledger = baseLedger();
  ledger.delete.appSurface = [
    {
      id: "x",
      kind: "files",
      files: [join("x", "f.ts")],
      lines: 5,
      expected: "absent",
    },
  ];
  ledger.contractualTotalLines = 0;
  const { ok, violations } = evaluateLedger(ledger, root);
  assert.equal(ok, false);
  assert.equal(violations[0].kind, "should-be-gone");
});

test("a missing collateral file fails", () => {
  const root = makeTree();
  const ledger = baseLedger();
  ledger.delete.providerCollateral = [join("nonexistent", "types.ts")];
  const { ok, violations } = evaluateLedger(ledger, root);
  assert.equal(ok, false);
  assert.equal(violations[0].kind, "missing");
});

test("a missing rehome source fails", () => {
  const root = makeTree();
  const ledger = baseLedger();
  ledger.rehome = [{ from: join("missing", "kernel.ts"), reason: "test" }];
  const { ok, violations } = evaluateLedger(ledger, root);
  assert.equal(ok, false);
  assert.equal(violations[0].kind, "missing");
});

test("contractual total mismatch with parts fails", () => {
  const root = makeTree();
  writeTs(join(root, "a"), "f.ts", 10);
  const ledger = baseLedger();
  ledger.contractualTotalLines = 999;
  ledger.delete.appSurface = [
    {
      id: "a",
      kind: "glob",
      root: "a/",
      extensions: [".ts"],
      lines: 10,
      expected: "present",
    },
  ];
  const { ok, violations } = evaluateLedger(ledger, root);
  assert.equal(ok, false);
  const totalViolation = violations.find((v) => v.kind === "total-mismatch");
  assert.ok(totalViolation, "expected a total-mismatch violation");
});

test("a malformed or duplicate retired table name fails", () => {
  const ledger = baseLedger();
  ledger.retiredDbTables = ["not_itotori", "itotori_retired", "itotori_retired"];
  const { ok, violations } = evaluateLedger(ledger, makeTree());
  assert.equal(ok, false);
  assert.deepEqual(
    violations.map((violation) => violation.kind),
    ["invalid-table-name", "duplicate-table-name"],
  );
});

test("a missing retained deterministic seam fails", () => {
  const ledger = baseLedger();
  ledger.keepSeams = ["apps/itotori/src/gates/protected-spans.ts"];
  const { ok, violations } = evaluateLedger(ledger, makeTree());
  assert.equal(ok, false);
  assert.equal(violations[0].id, "keepSeams");
  assert.equal(violations[0].kind, "missing");
});

test("multiple globs entry sums line counts correctly", () => {
  const root = makeTree();
  writeTs(join(root, "bench1"), "a.ts", 20);
  writeTs(join(root, "bench2"), "b.ts", 30);
  const ledger = baseLedger();
  ledger.contractualTotalLines = 50;
  ledger.delete.appSurface = [
    {
      id: "benchmarks",
      kind: "globs",
      roots: ["bench1/", "bench2/"],
      extensions: [".ts"],
      lines: 50,
      expected: "present",
    },
  ];
  const { ok } = evaluateLedger(ledger, root);
  assert.equal(ok, true);
});

test("the checked-in ledger forbids reviving the retired roots and isolated residues", () => {
  const ledger = loadLedger(join("scripts", "lint", "deletion-ledger.json"));
  const absentRoots = ledger.delete.appSurface.flatMap((entry) => {
    if (entry.expected !== "absent") return [];
    if (entry.kind === "glob") return [entry.root];
    return entry.kind === "globs" ? entry.roots : [];
  });

  assert.ok(absentRoots.includes("apps/itotori/src/providers/"));
  assert.ok(absentRoots.includes("apps/itotori/src/provider-proof/"));

  const absentFiles = ledger.delete.appSurface.flatMap((entry) =>
    entry.expected === "absent" && entry.kind === "files" ? entry.files : [],
  );
  assert.ok(absentFiles.includes("apps/itotori/src/bmk-cockpit-read-model.ts"));
  assert.ok(
    absentFiles.includes("packages/itotori-db/src/repositories/benchmark-run-repository.ts"),
  );
  assert.ok(absentFiles.includes("packages/itotori-ds/src/components/data/ContestantSwatch.tsx"));
  assert.ok(
    absentFiles.includes(
      "packages/itotori-ds/test/visual-baselines/data-contestantswatch--all-roles.png",
    ),
  );
  assert.ok(
    absentFiles.includes("packages/localization-bridge-schema/src/raw-mtl-baseline-proof.ts"),
  );
  assert.ok(absentFiles.includes("packages/localization-bridge-schema/src/agentic-loop-bundle.ts"));
  assert.ok(absentFiles.includes("scripts/generate-qa-calibration-bundles.mjs"));

  assert.deepEqual(ledger.keepSeams, [
    "apps/itotori/src/structure/index.ts",
    "apps/itotori/src/runtime-evidence/tools.ts",
    "apps/itotori/src/gates/glossary-exact.ts",
    "apps/itotori/src/gates/protected-spans.ts",
  ]);
  assert.ok(ledger.retiredDbTables.includes("itotori_benchmark_runs"));
  assert.ok(ledger.retiredDbTables.includes("itotori_localization_journal_runs"));
  assert.ok(ledger.retiredDbTables.includes("itotori_localization_cost_reservations"));
  assert.ok(ledger.retiredDbTables.includes("itotori_context_artifacts"));
});
