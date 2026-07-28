import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  evaluateBudget,
  findEnvVarNames,
  findRecipeNames,
  measureSurface,
} from "./surface-budget.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const fixture = join(here, "fixtures", "surface-budget-forms.fixture");

test("finds every supported source form in the coverage fixture", () => {
  const names = findEnvVarNames(readFileSync(fixture, "utf8"));
  assert.deepEqual([...names].sort(), [
    "ITOTORI_PRODUCT_VERSION",
    "ITOTORI_TARGET_LOCALE",
    "UTSUSHI_BROWSER_BIN",
  ]);
});

test("counts just recipe headers but not just assignments", () => {
  assert.deepEqual([...findRecipeNames("export X := 'value'\ncheck: lint\nrun *ARGS:\n")].sort(), [
    "check",
    "run",
  ]);
});

test("scans tracked symlink text rather than an untracked target", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "surface-budget-"));
  try {
    writeFileSync(join(temporaryRoot, "justfile"), "check:\n  true\n");
    writeFileSync(
      join(temporaryRoot, "untracked-target"),
      ["ITOTORI", "UNTRACKED_TARGET"].join("_"),
    );
    symlinkSync("untracked-target", join(temporaryRoot, "tracked-link"));
    execFileSync("git", ["init", "--quiet"], { cwd: temporaryRoot });
    execFileSync("git", ["add", "justfile", "tracked-link"], { cwd: temporaryRoot });

    assert.deepEqual(measureSurface(temporaryRoot), { envVarNames: 0, justRecipes: 1 });
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test("rejects growth and demands a lower budget after a shrink", () => {
  const budget = { envVarNames: 4, justRecipes: 2, increaseJustification: "" };
  assert.match(
    evaluateBudget({ envVarNames: 5, justRecipes: 2 }, budget, budget).join("\n"),
    /env-var names exceeded/u,
  );
  assert.match(
    evaluateBudget({ envVarNames: 4, justRecipes: 1 }, budget, budget).join("\n"),
    /just recipes is stale/u,
  );
});

test("rejects a budget increase without a changed justification", () => {
  const previous = { envVarNames: 4, justRecipes: 2, increaseJustification: "" };
  const budget = { envVarNames: 5, justRecipes: 2, increaseJustification: "" };
  assert.match(
    evaluateBudget({ envVarNames: 5, justRecipes: 2 }, budget, previous).join("\n"),
    /changed non-empty increaseJustification/u,
  );
  const unchanged = { envVarNames: 5, justRecipes: 2, increaseJustification: "reviewed" };
  const reviewedPrevious = { envVarNames: 4, justRecipes: 2, increaseJustification: "reviewed" };
  assert.match(
    evaluateBudget({ envVarNames: 5, justRecipes: 2 }, unchanged, reviewedPrevious).join("\n"),
    /changed non-empty increaseJustification/u,
  );
});

test("Tier 0 runs the budget gate and aggregates that required workflow", () => {
  const workflow = readFileSync(join(root, ".github/workflows/_tier0.yml"), "utf8");
  assert.match(workflow, /node scripts\/surface-budget\.mjs/u);
  assert.match(workflow, /name: Tier 0 \/ required/u);
  assert.match(workflow, /needs: \[gate\]/u);
});
