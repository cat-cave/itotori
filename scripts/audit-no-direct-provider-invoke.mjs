#!/usr/bin/env node
// CI guard: no direct legacy ModelProvider invocation.
//
// This is the public façade for the provider-invocation audit. The AST and
// taint-analysis implementation lives in focused sibling modules; callers
// continue to import this entrypoint and invoke this script unchanged.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findViolations as scanForViolations } from "./audit-no-direct-provider-invoke-scanner.mjs";
import { normalizeRepoPath, TS_LIKE_EXTENSIONS } from "./audit-no-direct-provider-invoke-paths.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const LLM_DISPATCHER_PATH = "apps/itotori/src/llm/dispatch.ts";

export function isExemptPath(path) {
  // There is no remaining direct-invocation adapter or supervisor exemption.
  // Keep this exported predicate for the regression suite; its false value is
  // itself the guard against reviving the deleted provider stack.
  void path;
  return false;
}

export function shouldScanPath(path) {
  const normalized = normalizeRepoPath(path);
  return (
    normalized.startsWith("apps/itotori/src/") &&
    TS_LIKE_EXTENSIONS.some((extension) => normalized.endsWith(extension))
  );
}

/**
 * Find forbidden provider-dispatch surfaces in one source file.
 * Exported for the companion regression suite.
 */
export function findViolations(path, contents) {
  if (isExemptPath(normalizeRepoPath(path))) return [];
  return scanForViolations(path, contents);
}

function listSourceFiles() {
  const output = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "apps/itotori/src"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  return (
    output
      .split("\n")
      .map((line) => line.trim())
      // `git ls-files --cached` retains index entries for worktree deletions.
      // A deleted forbidden caller must disappear from the scan rather than
      // crashing the guard before it can inspect the replacement path.
      .filter((line) => line.length > 0 && shouldScanPath(line) && existsSync(join(repoRoot, line)))
  );
}

function resolveScanTargets(args) {
  if (args.length === 0) {
    return listSourceFiles().map((path) => ({ path, absolutePath: join(repoRoot, path) }));
  }
  return args.map((argument) => {
    const absolutePath = resolve(argument);
    const repoRelative = relative(repoRoot, absolutePath);
    return {
      path: normalizeRepoPath(repoRelative.startsWith("..") ? absolutePath : repoRelative),
      absolutePath,
    };
  });
}

export function runAudit(args = []) {
  const violations = [];
  let scannedCount = 0;

  for (const target of resolveScanTargets(args)) {
    if (args.length === 0 && !shouldScanPath(target.path)) continue;
    if (!TS_LIKE_EXTENSIONS.some((extension) => target.path.endsWith(extension))) continue;
    const contents = readFileSync(target.absolutePath, "utf8");
    scannedCount += 1;
    violations.push(...findViolations(target.path, contents));
  }

  if (violations.length > 0) {
    process.stderr.write(
      `no-direct-provider-invoke audit failed: ${violations.length} forbidden provider dispatch${violations.length === 1 ? "" : "es"} found.\n` +
        "Direct provider invocation is retired; route model work through " +
        `${LLM_DISPATCHER_PATH}.\n\n`,
    );
    for (const violation of violations) {
      process.stderr.write(
        `  ${violation.file}:${violation.line}:${violation.column}  [receiver: ${violation.receiver}]\n` +
          `    ${violation.excerpt}\n`,
      );
    }
    return 1;
  }

  process.stdout.write(
    `no-direct-provider-invoke audit passed: ${scannedCount} shipped source files scanned.\n`,
  );
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) process.exit(runAudit(process.argv.slice(2)));
