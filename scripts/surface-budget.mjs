#!/usr/bin/env node
// Ratchet the project control-plane surface: tracked prefixed names and recipes.

import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
export const BUDGET_PATH = "scripts/lint/surface-budget.json";
export const PREFIXED_NAME =
  /(?<![A-Za-z0-9_])(?:ITOTORI|KAIFUU|UTSUSHI)_[A-Z0-9_]+(?![A-Za-z0-9_])/g;
const BUDGETS = [
  { field: "envVarNames", label: "env-var names" },
  { field: "justRecipes", label: "just recipes" },
];
const STATED_LIMITS =
  "stated limits: static tracked-text scan; dynamically constructed names and untracked files are not counted.\n";

export function findEnvVarNames(contents) {
  return new Set([...contents.matchAll(PREFIXED_NAME)].map((match) => match[0]));
}

export function findRecipeNames(contents) {
  const names = new Set();
  for (const line of contents.split(/\r?\n/u)) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*)(?:\s+[^:#]+)?\s*:/u);
    if (match !== null && !line.includes(":=")) names.add(match[1]);
  }
  return names;
}

export function listTrackedFiles(root) {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "buffer" })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

export function readTrackedFile(root, file) {
  const path = join(root, file);
  return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : readFileSync(path, "utf8");
}

export function measureSurface(root, files = listTrackedFiles(root)) {
  const names = new Set();
  for (const file of files) {
    const contents = readTrackedFile(root, file);
    for (const name of findEnvVarNames(contents)) names.add(name);
  }
  const justfile = readFileSync(join(root, "justfile"), "utf8");
  return { envVarNames: names.size, justRecipes: findRecipeNames(justfile).size };
}

export function parseBudget(contents) {
  const budget = JSON.parse(contents);
  for (const { field } of BUDGETS) {
    if (!Number.isInteger(budget[field]) || budget[field] < 0) {
      throw new Error(`${BUDGET_PATH}: ${field} must be a non-negative integer`);
    }
  }
  if (typeof budget.increaseJustification !== "string") {
    throw new Error(`${BUDGET_PATH}: increaseJustification must be a string`);
  }
  return budget;
}

export function evaluateBudget(actual, budget, previous) {
  const failures = [];
  for (const { field, label } of BUDGETS) {
    if (actual[field] > budget[field]) {
      failures.push(`${label} exceeded: measured ${actual[field]}, recorded ${budget[field]}.`);
    }
    if (actual[field] < budget[field]) {
      failures.push(
        `${label} is stale: measured ${actual[field]}, recorded ${budget[field]}; lower ${field}.`,
      );
    }
    if (
      previous !== null &&
      budget[field] > previous[field] &&
      (budget.increaseJustification.trim() === "" ||
        budget.increaseJustification.trim() === previous.increaseJustification.trim())
    ) {
      failures.push(`${label} increase lacks a changed non-empty increaseJustification.`);
    }
  }
  return failures;
}

export function regeneratedBudget(actual, budget) {
  return { ...budget, ...actual };
}

function git(root, args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export function previousBudget(root) {
  const base = git(root, ["merge-base", "HEAD", "origin/main"]);
  if (base === null)
    throw new Error("cannot establish merge-base with origin/main for budget review");
  const contents = git(root, ["show", `${base}:${BUDGET_PATH}`]);
  return contents === null ? null : parseBudget(contents);
}

function main() {
  const update = process.argv.slice(2).includes("--update");
  const unexpectedArgs = process.argv.slice(2).filter((arg) => arg !== "--update");
  if (unexpectedArgs.length > 0) {
    process.stderr.write("usage: node scripts/surface-budget.mjs [--update]\n");
    process.exitCode = 1;
    return;
  }
  let actual;
  let budget;
  let previous;
  try {
    actual = measureSurface(repoRoot);
    budget = parseBudget(readFileSync(join(repoRoot, BUDGET_PATH), "utf8"));
    previous = previousBudget(repoRoot);
  } catch (error) {
    process.stderr.write(`surface budget: FAILED. ${error.message}\n`);
    process.exitCode = 1;
    return;
  }

  const nextBudget = update ? regeneratedBudget(actual, budget) : budget;
  const failures = evaluateBudget(actual, nextBudget, previous);
  if (failures.length > 0) {
    process.stderr.write(
      `surface budget: FAILED.\n${failures.map((failure) => `  ${failure}`).join("\n")}\n${STATED_LIMITS}`,
    );
    process.exitCode = 1;
    return;
  }
  if (update) {
    writeFileSync(join(repoRoot, BUDGET_PATH), `${JSON.stringify(nextBudget, null, 2)}\n`);
    process.stdout.write(
      `surface budget: regenerated. env-var names: ${actual.envVarNames}; ` +
        `just recipes: ${actual.justRecipes}.\n` +
        STATED_LIMITS,
    );
    return;
  }
  const bootstrap = previous === null ? " (initial record)" : "";
  process.stdout.write(
    `surface budget: passed. env-var names: ${actual.envVarNames}/${budget.envVarNames}; ` +
      `just recipes: ${actual.justRecipes}/${budget.justRecipes}.${bootstrap}\n` +
      STATED_LIMITS,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
