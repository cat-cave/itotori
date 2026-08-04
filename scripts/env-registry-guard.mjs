#!/usr/bin/env node
// @itotori-meta-check
// Static ratchet for literal project-environment reads. It intentionally does
// not claim to find dynamically constructed names or untracked files.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const budgetPath = path.join(root, "scripts", "env-registry-guard-budget.json");
const example = readFileSync(path.join(root, ".env.example"), "utf8");
const declared = new Set([...example.matchAll(/^([A-Z][A-Z0-9_]*)=$/gmu)].map((match) => match[1]));
const readForms =
  /(?:process\.env\.|env::var(?:_os)?\(|env!\(|option_env!\(|\.env\()\s*["']?((?:ITOTORI|KAIFUU|UTSUSHI)_[A-Z0-9_]+)/g;
const exemptPaths = new Map([
  [
    "scripts/fixtures/surface-budget-forms.fixture",
    "surface-budget parser fixture: names are test data, not environment reads",
  ],
]);

export function undeclaredReads(text) {
  const out = [];
  for (const match of text.matchAll(readForms)) {
    const name = match[1];
    if (!declared.has(name)) out.push(name);
  }
  return out;
}

export function declaredNames() {
  return new Set(declared);
}

export function trackedRegularFiles(indexEntries) {
  return indexEntries
    .split("\n")
    .filter(Boolean)
    .map((entry) => {
      const [metadata, file] = entry.split("\t");
      return { mode: metadata.split(" ", 1)[0], file };
    })
    .filter(({ mode }) => mode.startsWith("100"))
    .map(({ file }) => file);
}

export function checkBudget(actual, budget) {
  if (actual === 0) {
    if (budget !== undefined) {
      return "undeclared reads reached zero; delete scripts/env-registry-guard-budget.json to enable the absolute check";
    }
    return undefined;
  }
  if (budget === undefined) {
    return `found ${actual} undeclared reads without a ratchet budget; add scripts/env-registry-guard-budget.json`;
  }
  if (actual > budget.undeclaredReads) {
    return `undeclared reads rose from budget ${budget.undeclaredReads} to ${actual}`;
  }
  if (actual < budget.undeclaredReads) {
    return `undeclared reads fell from budget ${budget.undeclaredReads} to ${actual}; lower scripts/env-registry-guard-budget.json in the same change`;
  }
  return undefined;
}

function loadBudget() {
  try {
    const parsed = JSON.parse(readFileSync(budgetPath, "utf8"));
    if (!Number.isInteger(parsed.undeclaredReads) || parsed.undeclaredReads < 0) {
      throw new Error("undeclaredReads must be a non-negative integer");
    }
    return parsed;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw new Error(
      `environment registry guard: invalid budget: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // The index records Corepack launchers as symlinks whose Nix-store targets
  // are intentionally host-specific. Scan tracked regular source files, not
  // link targets that might not exist on the runner.
  const files = trackedRegularFiles(
    execFileSync("git", ["ls-files", "--stage"], { cwd: root, encoding: "utf8" }),
  );
  const failures = [];
  const exemptions = [];
  for (const file of files) {
    // `git ls-files` includes a tracked path deleted in the working tree. The
    // zero-budget transition deletes its own budget file, so scan only files
    // that exist in the tree being checked.
    if (!existsSync(path.join(root, file))) continue;
    const exemption = exemptPaths.get(file);
    if (exemption !== undefined) {
      exemptions.push(`${file}: ${exemption}`);
      continue;
    }
    const lines = readFileSync(path.join(root, file), "utf8").split(/\r?\n/u);
    lines.forEach((line, index) => {
      for (const name of undeclaredReads(line)) failures.push(`${file}:${index + 1}: ${name}`);
    });
  }
  const budget = loadBudget();
  const budgetError = checkBudget(failures.length, budget);
  if (budgetError !== undefined) {
    process.stderr.write(
      `environment registry guard: FAILED (${failures.length} undeclared literal reads)\n`,
    );
    if (failures.length > 0) process.stderr.write(`${failures.join("\n")}\n`);
    if (budgetError !== undefined) process.stderr.write(`${budgetError}\n`);
    if (exemptions.length > 0) process.stderr.write(`exemptions:\n${exemptions.join("\n")}\n`);
    process.stderr.write(
      "limits: scans tracked literal read forms only; dynamic names and untracked files are invisible.\n",
    );
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `environment registry guard: passed (${failures.length} undeclared literal reads; ${
        budget === undefined ? "absolute check" : "ratchet budget matched"
      }).` +
        `${exemptions.length > 0 ? ` exemptions: ${exemptions.join("; ")}.` : ""}` +
        " limits: scans tracked literal read forms only; dynamic names and untracked files are invisible.\n",
    );
  }
}
