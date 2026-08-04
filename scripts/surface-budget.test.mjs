import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  evaluateSurface,
  findEnvVarNames,
  findRecipeNames,
  measureMergeBaseSurface,
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

test("rejects growth and reports a shrink against the derived merge-base surface", () => {
  const base = { envVarNames: 4, justRecipes: 2 };
  const grown = evaluateSurface({ envVarNames: 5, justRecipes: 3 }, base).join("\n");
  assert.match(grown, /env-var names grew/u);
  assert.match(grown, /just recipes grew/u);
  const shrunk = evaluateSurface({ envVarNames: 3, justRecipes: 1 }, base).join("\n");
  assert.match(shrunk, /env-var names shrank/u);
  assert.match(shrunk, /just recipes shrank/u);
  assert.deepEqual(evaluateSurface({ envVarNames: 4, justRecipes: 2 }, base), []);
});

test("derives the comparison surface from the merge base rather than stored totals", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "surface-budget-base-"));
  try {
    writeFileSync(join(temporaryRoot, "justfile"), "check:\n  true\n");
    writeFileSync(join(temporaryRoot, "tracked"), `${["ITOTORI", "BASE_NAME"].join("_")}\n`);
    execFileSync("git", ["init", "--initial-branch=main", "--quiet"], { cwd: temporaryRoot });
    execFileSync("git", ["config", "user.email", "surface-budget@example.test"], {
      cwd: temporaryRoot,
    });
    execFileSync("git", ["config", "user.name", "Surface Budget Test"], { cwd: temporaryRoot });
    execFileSync("git", ["add", "justfile", "tracked"], { cwd: temporaryRoot });
    execFileSync("git", ["commit", "--quiet", "-m", "base surface"], { cwd: temporaryRoot });
    const base = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: temporaryRoot,
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["update-ref", "refs/remotes/origin/main", base], { cwd: temporaryRoot });

    writeFileSync(join(temporaryRoot, "justfile"), "check:\n  true\nnew-recipe:\n  true\n");
    writeFileSync(
      join(temporaryRoot, "tracked"),
      [["ITOTORI", "BASE_NAME"].join("_"), ["ITOTORI", "GROWN_NAME"].join("_")].join(" "),
    );
    execFileSync("git", ["add", "justfile", "tracked"], { cwd: temporaryRoot });
    execFileSync("git", ["commit", "--quiet", "-m", "grow surface"], { cwd: temporaryRoot });

    assert.deepEqual(measureMergeBaseSurface(temporaryRoot), {
      revision: base,
      surface: { envVarNames: 1, justRecipes: 1 },
    });
    assert.match(
      evaluateSurface(measureSurface(temporaryRoot), { envVarNames: 1, justRecipes: 1 }).join("\n"),
      /grew/u,
    );
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test("stores no shared numeric surface baseline", () => {
  assert.equal(existsSync(join(root, "scripts", "lint", "surface-budget.json")), false);
});

test("Tier 0 runs the budget gate and aggregates that required workflow", () => {
  const workflow = readFileSync(join(root, ".github/workflows/_tier0.yml"), "utf8");
  assert.match(workflow, /node scripts\/surface-budget\.mjs/u);
  assert.match(workflow, /name: Tier 0 \/ required/u);
  assert.match(workflow, /needs: \[gate\]/u);
});
