// Regression suite for the LLM-layer LOC-budget guard.
//
// Proves the budget catches an over-limit tree, passes a clean one, and
// correctly excludes prompts, generated schemas, and test files.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { collectCountedFiles, countLines, evaluateBudget } from "./audit-llm-loc-budget.mjs";

function makeTree() {
  return mkdtempSync(join(tmpdir(), "loc-budget-"));
}

function writeLines(dir, name, lines) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `${"x\n".repeat(lines)}`);
}

function ledger(budget, excluded = ["prompts/", "schemas/"]) {
  return {
    llmLayer: {
      root: "llm/",
      locBudget: budget,
      locExcludedSubdirs: excluded,
    },
  };
}

test("countLines counts newline characters (wc -l semantics)", () => {
  assert.equal(countLines("a\nb\nc\n"), 3);
  assert.equal(countLines("a\nb"), 1);
  assert.equal(countLines(""), 0);
});

test("collectCountedFiles finds .ts files but excludes tests + subdirs", () => {
  const root = makeTree();
  const llmRoot = "llm/";
  writeLines(join(root, "llm"), "dispatch.ts", 100);
  writeLines(join(root, "llm"), "dispatch.test.ts", 999);
  writeLines(join(root, "llm", "prompts"), "system.ts", 999);
  writeLines(join(root, "llm", "schemas"), "generated.ts", 999);
  writeLines(join(root, "llm"), "tools.tsx", 50);
  writeLines(join(root, "llm"), "ignore.md", 999);

  const files = collectCountedFiles(join(root, "llm"), llmRoot, ["prompts/", "schemas/"]);
  const paths = files.map((f) => f.path).sort();
  assert.deepEqual(paths, ["llm/dispatch.ts", "llm/tools.tsx"]);
});

test("a tree under budget passes", () => {
  const root = makeTree();
  writeLines(join(root, "llm"), "a.ts", 50);
  writeLines(join(root, "llm"), "b.ts", 30);
  const { ok, counted, budget } = evaluateBudget(ledger(100), root);
  assert.equal(ok, true);
  assert.equal(counted, 80);
  assert.equal(budget, 100);
});

test("a tree over budget fails", () => {
  const root = makeTree();
  writeLines(join(root, "llm"), "big.ts", 90);
  writeLines(join(root, "llm"), "also.ts", 20);
  const { ok, counted, budget } = evaluateBudget(ledger(100), root);
  assert.equal(ok, false);
  assert.equal(counted, 110);
  assert.equal(budget, 100);
});

test("prompt and schema files are excluded from the count", () => {
  const root = makeTree();
  writeLines(join(root, "llm"), "dispatch.ts", 50);
  writeLines(join(root, "llm", "prompts"), "system.ts", 9999);
  writeLines(join(root, "llm", "schemas"), "gen.ts", 9999);
  const { ok, counted } = evaluateBudget(ledger(100), root);
  assert.equal(ok, true);
  assert.equal(counted, 50);
});

test("test files are excluded from the count", () => {
  const root = makeTree();
  writeLines(join(root, "llm"), "dispatch.ts", 50);
  writeLines(join(root, "llm"), "dispatch.test.ts", 9999);
  writeLines(join(root, "llm"), "dispatch.spec.ts", 9999);
  const { ok, counted } = evaluateBudget(ledger(100), root);
  assert.equal(ok, true);
  assert.equal(counted, 50);
});

test("a missing LLM-layer directory passes at zero lines", () => {
  const root = makeTree();
  const { ok, counted } = evaluateBudget(ledger(5000), root);
  assert.equal(ok, true);
  assert.equal(counted, 0);
});

test("evaluateBudget returns per-file breakdown sorted by size", () => {
  const root = makeTree();
  writeLines(join(root, "llm"), "small.ts", 10);
  writeLines(join(root, "llm"), "big.ts", 200);
  writeLines(join(root, "llm"), "medium.ts", 50);
  const { files } = evaluateBudget(ledger(5000), root);
  assert.equal(files[0].path, "llm/big.ts");
  assert.equal(files[0].lines, 200);
  assert.equal(files[1].path, "llm/medium.ts");
  assert.equal(files[2].path, "llm/small.ts");
});
