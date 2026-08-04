#!/usr/bin/env node
// Static CI guard for test registrations that do not execute, plus the
// intentionally separate private-corpus Rust ignore inventory.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  isMemberExpression,
  memberPropertyName,
  parseTypeScript,
  sourceLocation,
  walk,
} from "./stable-ts-ast.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "..");
export const MAX_RUST_IGNORED_TESTS = 169;

const sourceExtension = /\.(?:[cm]?[jt]sx?)$/u;
const testPath = /(?:^|\/)(?:test|tests|e2e)\/|\.(?:test|spec|e2e)\.(?:[cm]?[jt]sx?)$/u;
const testApiNames = new Set(["describe", "it", "test", "context", "suite"]);
const nonExecutingModifiers = new Set(["skip", "todo", "skipIf", "runIf"]);

function isDistPath(file) {
  return file.split("/").includes("dist");
}

function identifierName(node) {
  return node?.type === "Identifier" ? node.name : undefined;
}

function objectPropertyName(node) {
  if (node?.type !== "ObjectProperty") return undefined;
  if (node.key.type === "Identifier") return node.key.name;
  return node.key.type === "StringLiteral" ? node.key.value : undefined;
}

/** Return tracked and untracked, non-ignored working-tree paths. */
export function listWorkingTreeFiles(root = repoRoot) {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
  })
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();
}

export function isTestSource(file) {
  return sourceExtension.test(file) && !isDistPath(file) && testPath.test(file);
}

function isRustSource(file) {
  return file.startsWith("crates/") && file.endsWith(".rs") && !isDistPath(file);
}

function isTestApiReceiver(node) {
  const name = identifierName(node);
  if (name !== undefined) return testApiNames.has(name);
  if (node?.type === "CallExpression" || node?.type === "OptionalCallExpression") {
    return isTestApiReceiver(node.callee);
  }
  if (!isMemberExpression(node)) return false;
  return testApiNames.has(memberPropertyName(node) ?? "") || isTestApiReceiver(node.object);
}

function isTestRegistration(node) {
  if (isTestApiReceiver(node)) return true;
  return (
    (node?.type === "CallExpression" || node?.type === "OptionalCallExpression") &&
    isTestApiReceiver(node.callee)
  );
}

function containsTestRegistration(node) {
  let found = false;
  if (node) {
    walk(node, (child) => {
      if (isTestRegistration(child)) found = true;
    });
  }
  return found;
}

function containsNonExecutingTestExpression(node) {
  let found = false;
  if (node) {
    walk(node, (child) => {
      if (isNonExecutingTestExpression(child)) found = true;
    });
  }
  return found;
}

function isNonExecutingTestExpression(node) {
  if (isMemberExpression(node)) {
    return (
      nonExecutingModifiers.has(memberPropertyName(node) ?? "") && isTestApiReceiver(node.object)
    );
  }
  if (node?.type === "CallExpression" || node?.type === "OptionalCallExpression") {
    return isNonExecutingTestExpression(node.callee);
  }
  return false;
}

function isNodeTestContextModifier(node) {
  return (
    isMemberExpression(node) &&
    identifierName(node.object) === "t" &&
    nonExecutingModifiers.has(memberPropertyName(node) ?? "")
  );
}

function isProcessEnvRead(node) {
  if (!isMemberExpression(node)) return false;
  const environment = node.object;
  return (
    isMemberExpression(environment) &&
    memberPropertyName(environment) === "env" &&
    identifierName(environment.object) === "process"
  );
}

function containsProcessEnvRead(node) {
  let found = false;
  if (node) {
    walk(node, (child) => {
      if (isProcessEnvRead(child)) found = true;
    });
  }
  return found;
}

function isInsideEnvironmentVanish(node) {
  let current = node.parent;
  while (current) {
    if (
      current.type === "ConditionalExpression" &&
      containsProcessEnvRead(current.test) &&
      (isNonExecutingTestExpression(current.consequent) ||
        isNonExecutingTestExpression(current.alternate) ||
        isTestRegistration(current.consequent) !== isTestRegistration(current.alternate))
    ) {
      return true;
    }
    if (
      current.type === "LogicalExpression" &&
      containsProcessEnvRead(current.left) &&
      isTestRegistration(current.right)
    ) {
      return true;
    }
    if (
      current.type === "IfStatement" &&
      containsProcessEnvRead(current.test) &&
      (containsNonExecutingTestExpression(current.consequent) ||
        containsNonExecutingTestExpression(current.alternate) ||
        containsTestRegistration(current.consequent) !==
          containsTestRegistration(current.alternate))
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function hasDisabledTestOption(node) {
  if (node?.type !== "ObjectExpression") return false;
  return node.properties.some((property) => {
    const name = objectPropertyName(property);
    if (!name || !["skip", "todo"].includes(name) || property.type !== "ObjectProperty") {
      return false;
    }
    return property.value.type !== "BooleanLiteral" || property.value.value;
  });
}

/**
 * Find source registrations that can create a skipped, todo, or absent suite.
 * @param {string} file
 * @param {string} contents
 */
export function findSkippedTestViolations(file, contents) {
  const root = parseTypeScript(contents, file);
  const violations = [];
  const seen = new Set();

  function add(node, kind) {
    const location = sourceLocation(file, node);
    const key = `${location}:${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    violations.push({ file, kind, location });
  }

  walk(root, (node) => {
    if (node.type === "ConditionalExpression" && containsProcessEnvRead(node.test)) {
      const consequentRuns = isTestRegistration(node.consequent);
      const alternateRuns = isTestRegistration(node.alternate);
      if (
        isNonExecutingTestExpression(node.consequent) ||
        isNonExecutingTestExpression(node.alternate) ||
        consequentRuns !== alternateRuns
      ) {
        add(node, "process.env conditional silently vanishes a test registration");
      }
      return;
    }

    if (
      node.type === "LogicalExpression" &&
      containsProcessEnvRead(node.left) &&
      isTestRegistration(node.right)
    ) {
      add(node, "process.env logical expression conditionally registers a test");
      return;
    }

    if (node.type === "IfStatement" && containsProcessEnvRead(node.test)) {
      const consequentRuns = containsTestRegistration(node.consequent);
      const alternateRuns = containsTestRegistration(node.alternate);
      if (
        containsNonExecutingTestExpression(node.consequent) ||
        containsNonExecutingTestExpression(node.alternate) ||
        consequentRuns !== alternateRuns
      ) {
        add(node, "process.env conditional statement silently vanishes a test registration");
      }
      return;
    }

    if (node.type === "CallExpression" || node.type === "OptionalCallExpression") {
      const name = identifierName(node.callee);
      if (name !== undefined && ["xit", "xtest", "xdescribe"].includes(name)) {
        add(node, `${name} disables a test definition`);
        return;
      }
      if (isTestApiReceiver(node.callee) && node.arguments.some(hasDisabledTestOption)) {
        add(node, "test skip/todo option creates a non-executed case");
      }
      return;
    }

    if (
      !isMemberExpression(node) ||
      (!isNonExecutingTestExpression(node) && !isNodeTestContextModifier(node))
    ) {
      return;
    }
    if (isInsideEnvironmentVanish(node)) return;
    add(node, `test .${memberPropertyName(node)} modifier creates a non-executed case`);
  });

  return violations;
}

/** Scan conventional JS/TS test source, including untracked source fixtures. */
export function scanSkippedTestSource(root = repoRoot) {
  const files = listWorkingTreeFiles(root).filter(isTestSource);
  const violations = [];
  for (const file of files) {
    try {
      violations.push(
        ...findSkippedTestViolations(file, readFileSync(path.join(root, file), "utf8")),
      );
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") continue;
      throw error;
    }
  }
  return { files, violations };
}

function ignoredAttributeLocations(file, contents) {
  const locations = [];
  const pattern = /^\s*#\s*\[\s*ignore\s*=/gmu;
  for (const match of contents.matchAll(pattern)) {
    const offset = match.index ?? 0;
    const line = contents.slice(0, offset).split("\n").length;
    locations.push(`${file}:${line}`);
  }
  return locations;
}

/** Count reasoned Rust `#[ignore = "..."]` attributes in crate source only. */
export function countRustIgnoredTests(root = repoRoot) {
  const files = listWorkingTreeFiles(root).filter(isRustSource);
  const locations = [];
  for (const file of files) {
    try {
      locations.push(
        ...ignoredAttributeLocations(file, readFileSync(path.join(root, file), "utf8")),
      );
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") continue;
      throw error;
    }
  }
  return { files, locations, count: locations.length };
}

export function evaluateGuard(root = repoRoot) {
  const tests = scanSkippedTestSource(root);
  const rust = countRustIgnoredTests(root);
  return {
    ...tests,
    rust,
    ok: tests.violations.length === 0 && rust.count === MAX_RUST_IGNORED_TESTS,
  };
}

function parseArgs(argv) {
  const options = { root: repoRoot };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--root") throw new Error(`unknown argument ${argv[index]}`);
    const root = argv[index + 1];
    if (!root) throw new Error("--root requires a directory");
    options.root = path.resolve(root);
    index += 1;
  }
  return options;
}

function runCli() {
  const { root } = parseArgs(process.argv.slice(2));
  const result = evaluateGuard(root);
  process.stdout.write(
    `zero-skipped-test guard: ${result.files.length} JS/TS test source file(s) scanned; ` +
      `Rust #[ignore = ...] count ${result.rust.count}/${MAX_RUST_IGNORED_TESTS}.\n`,
  );
  process.stdout.write(
    "Limit: the AST scan recognizes conventional test APIs and direct process.env registration conditions; dynamic aliases and runtime-generated registrations are outside its scope. The Rust inventory scans reasoned attributes in crates/ source and does not claim they executed.\n",
  );

  if (result.violations.length > 0) {
    process.stderr.write(
      `zero-skipped-test guard: FAILED — ${result.violations.length} prohibited test registration(s)\n`,
    );
    for (const violation of result.violations) {
      process.stderr.write(`  ${violation.location}: ${violation.kind}\n`);
    }
  }
  if (result.rust.count !== MAX_RUST_IGNORED_TESTS) {
    process.stderr.write(
      result.rust.count > MAX_RUST_IGNORED_TESTS
        ? `zero-skipped-test guard: FAILED — Rust ignored-test count grew from ` +
            `${MAX_RUST_IGNORED_TESTS} to ${result.rust.count}.\n`
        : `zero-skipped-test guard: FAILED — Rust ignored-test count changed from ` +
            `${MAX_RUST_IGNORED_TESTS} to ${result.rust.count}.\n`,
    );
  }
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(
      `zero-skipped-test guard: FAILED — ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
