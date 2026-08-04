#!/usr/bin/env node
// @itotori-meta-check
// AST-based CI guard for the permission-based authorization invariant. The
// scanners are separated by language; this entrypoint remains the public API
// and CLI contract used by the regression suite and developer commands.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { findRustViolations } from "./audit-no-hardcoded-roles-rust-scanner.mjs";
import { findTsViolations } from "./audit-no-hardcoded-roles-ts-scanner.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const TS_LIKE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const SCANNABLE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".rs"];

// Return every forbidden auth-role-branch violation in `contents`, tagged with
// its repo-relative `path`. This is the original module's sole public export.
export function findViolations(path, contents) {
  const lines = contents.split(/\r?\n/u);
  if (path.endsWith(".rs")) return findRustViolations(path, contents, lines);
  if (TS_LIKE_EXTENSIONS.some((extension) => path.endsWith(extension))) {
    return findTsViolations(path, contents, lines);
  }
  return [];
}

function shouldScan(path) {
  const inShippedSrc = /(?:^|\/)(?:apps|packages|crates)\/[^/]+\/src\//u.test(path);
  const isExcluded = /(?:^|\/)(?:tests?|fixtures|node_modules|docs)\//u.test(path);
  return (
    inShippedSrc &&
    !isExcluded &&
    SCANNABLE_EXTENSIONS.some((extension) => path.endsWith(extension))
  );
}

function resolveScanTargets(args) {
  if (args.length === 0) {
    const tracked = execSync("git ls-files apps packages crates", {
      cwd: repoRoot,
      encoding: "utf8",
    });
    return tracked
      .split("\n")
      .map((file) => file.trim())
      .filter((file) => file.length > 0)
      .map((relPath) => ({ relPath, absPath: join(repoRoot, relPath) }));
  }
  return args.map((arg) => {
    const absPath = resolve(arg);
    const relPath = relative(repoRoot, absPath);
    return { relPath: relPath.startsWith("..") ? absPath : relPath, absPath };
  });
}

function runAudit(args) {
  const violations = [];
  let scannedCount = 0;
  for (const { relPath, absPath } of resolveScanTargets(args)) {
    if (!shouldScan(relPath)) continue;
    let contents;
    try {
      contents = readFileSync(absPath, "utf8");
    } catch {
      continue;
    }
    scannedCount += 1;
    violations.push(...findViolations(relPath, contents));
  }
  if (violations.length > 0) {
    process.stderr.write(
      `no-hardcoded-roles audit failed: ${violations.length} forbidden ` +
        `auth-role-branching pattern${violations.length === 1 ? "" : "s"} found.\n` +
        "Itotori authorization is PERMISSION-BASED: never branch an auth " +
        "decision on a role name. Use `requirePermission` with a typed " +
        "permission value instead. See docs/permissions.md.\n\n",
    );
    for (const violation of violations) {
      process.stderr.write(
        `  ${violation.file}:${violation.line}  [${violation.pattern}]\n    ${violation.excerpt}\n`,
      );
    }
    return 1;
  }
  process.stdout.write(
    `no-hardcoded-roles audit passed: ${scannedCount} shipped-src files scanned; ` +
      "no auth-role-name branching found.\n",
  );
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) process.exit(runAudit(process.argv.slice(2)));
