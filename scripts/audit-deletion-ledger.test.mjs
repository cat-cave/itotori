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

import { collectFiles, countLinesInDir, evaluateLedger } from "./audit-deletion-ledger.mjs";

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
