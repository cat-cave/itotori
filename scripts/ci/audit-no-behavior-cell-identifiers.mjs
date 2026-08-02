#!/usr/bin/env node
// CI guard: shared behavior harnesses must not name registered cells.
//
// Cell identity belongs in a proof capsule. Keeping the shared discovery and
// harness files below identifier-free means a new cell does not create a
// concurrent edit hotspot. The prohibited identifiers are derived from the
// discovered capsules, rather than copied here.
//
// Scope: exactly the three shared discovery and behavior-harness files below.
// Limit: this detects literal discovered identifiers only; dynamically
// assembled, encoded, or undiscovered identifiers are outside its reach.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { behaviorCells } from "./behavior-cell-registry.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

export const SHARED_BEHAVIOR_HARNESS_FILES = [
  "scripts/ci/behavior-cell-registry.mjs",
  "scripts/ci/run-behavior-proof.mjs",
  "suite/behavior/support/world.ts",
];

export function registeredCellIdentifiers(cells = behaviorCells) {
  if (!Array.isArray(cells) || cells.length === 0)
    throw new Error("behavior-cell-identifier-guard-invalid-registry");
  const identifiers = new Set();
  for (const entry of cells) {
    if (entry === null || typeof entry !== "object")
      throw new Error("behavior-cell-identifier-guard-invalid-entry");
    for (const field of ["cell", "behavior"]) {
      const value = entry[field];
      if (typeof value !== "string" || value.length === 0)
        throw new Error(`behavior-cell-identifier-guard-invalid-${field}`);
      identifiers.add(value);
    }
  }
  return [...identifiers].toSorted(
    (left, right) => right.length - left.length || left.localeCompare(right),
  );
}

function lineAt(contents, index) {
  return contents.slice(0, index).split(/\r?\n/u).length;
}

function excerptAt(contents, index) {
  const lineStart = contents.lastIndexOf("\n", index) + 1;
  const lineEnd = contents.indexOf("\n", index);
  return contents
    .slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
    .trim()
    .slice(0, 160);
}

export function findBehaviorCellIdentifierViolations(path, contents, identifiers) {
  const found = [];
  for (const identifier of identifiers) {
    let index = contents.indexOf(identifier);
    while (index !== -1) {
      found.push({
        file: path,
        line: lineAt(contents, index),
        token: identifier,
        excerpt: excerptAt(contents, index),
      });
      index = contents.indexOf(identifier, index + identifier.length);
    }
  }
  return found.toSorted(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.token.localeCompare(right.token),
  );
}

export function scanSharedBehaviorHarnesses(root, identifiers = registeredCellIdentifiers()) {
  const violations = [];
  for (const file of SHARED_BEHAVIOR_HARNESS_FILES) {
    let contents;
    try {
      contents = readFileSync(resolve(root, file), "utf8");
    } catch {
      throw new Error(`behavior-cell-identifier-guard-shared-file-unreadable:${file}`);
    }
    violations.push(...findBehaviorCellIdentifierViolations(file, contents, identifiers));
  }
  return violations;
}

function parseArgs(argv) {
  let root = repoRoot;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") root = resolve(argv[(index += 1)]);
    else if (arg.startsWith("--root=")) root = resolve(arg.slice("--root=".length));
    else if (arg === "--help" || arg === "-h") return { help: true, root };
    else throw new Error("usage: audit-no-behavior-cell-identifiers.mjs [--root DIR]");
  }
  return { help: false, root };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      "usage: node scripts/ci/audit-no-behavior-cell-identifiers.mjs [--root DIR]\n",
    );
    return;
  }
  const violations = scanSharedBehaviorHarnesses(options.root);
  const limit =
    "Limit: literal discovered identifiers only; dynamically assembled, encoded, or undiscovered identifiers are not detected.\n";
  if (violations.length === 0) {
    process.stdout.write(
      `behavior-cell identifier guard: passed. 0 references across ${SHARED_BEHAVIOR_HARNESS_FILES.length} shared files.\n${limit}`,
    );
    return;
  }
  process.stderr.write(
    `behavior-cell identifier guard: FAILED. ${violations.length} registered identifier reference(s) found.\n${limit}`,
  );
  for (const violation of violations) {
    process.stderr.write(
      `  ${violation.file}:${violation.line}  ${violation.token}  ${violation.excerpt}\n`,
    );
  }
  process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
