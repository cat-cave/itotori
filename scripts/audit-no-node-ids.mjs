#!/usr/bin/env node
// CI guard: no node-id references in production code.
//
// A "node id" is a roadmap / ticket cross-ref (`<PREFIX>-<number>`, a
// `p0-core-<slug>`, or the prose forms "follow-up node" / "see node" /
// "deferred for node"). Provenance like that is stale-on-write: it belongs in
// git history + the PR description, never in a doc comment or source line.
// This is an absolute rule: zero node-id references are permitted.
//
// Scope: tracked source under `crates/` (`.rs`) and `packages/`
// (`.ts`/`.tsx`/`.js`/`.mjs`/`.cjs`). Excluded as immutable/prose/delete-zone:
// `apps/itotori/**`, `**/fixtures/**`, `**/target/**`, `**/dist/**`,
// `**/migrations/**/*.sql` (checksum-locked historical SQL), `docs/**`,
// `roadmap/**`, `.qd/**`, `.plan/**`, and `CHANGELOG*`.
//
// Exit codes: 0 = clean; 1 = violation. Wired into `just ci-tier0-meta`.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

export const SCAN_EXTENSIONS = new Set([".rs", ".ts", ".tsx", ".js", ".mjs", ".cjs"]);

const EXCLUDE_PATTERNS = [
  "apps/itotori/",
  "migrations/",
  "/fixtures/",
  "/target/",
  "/dist/",
  "docs/",
  "roadmap/",
  ".qd/",
  ".plan/",
  "CHANGELOG",
];

const NODE_ID_PATTERNS = [
  /\b(?:RB|ITOTORI|KAIFUU|UTSUSHI)-\d+\b/gi,
  /\bp0-core-[a-z0-9-]+\b/gi,
  /\bfollow-up node\b/gi,
  /\bsee node\b/gi,
  /\bdeferred for node\b/gi,
];

export function isExcludedPath(path) {
  return EXCLUDE_PATTERNS.some((pattern) => path.includes(pattern));
}

export function shouldScan(path) {
  if (isExcludedPath(path)) return false;
  const dot = path.lastIndexOf(".");
  return dot !== -1 && SCAN_EXTENSIONS.has(path.slice(dot));
}

export function findNodeIdViolations(path, contents) {
  const found = [];
  const lines = contents.split(/\r?\n/u);
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed === "") continue;
    for (const regex of NODE_ID_PATTERNS) {
      const re = new RegExp(regex.source, regex.flags);
      for (const match of trimmed.matchAll(re)) {
        found.push({
          file: path,
          line: i + 1,
          token: match[0].toLowerCase(),
          excerpt: trimmed.slice(0, 160),
        });
      }
    }
  }
  return found;
}

export function listScanFiles(root) {
  return execSync("git ls-files crates packages", { cwd: root, encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function scanFiles(root, files) {
  const violations = [];
  let scanned = 0;
  for (const file of files) {
    if (!shouldScan(file)) continue;
    try {
      const target = root === null ? file : join(root, file);
      violations.push(...findNodeIdViolations(file, readFileSync(target, "utf8")));
      scanned += 1;
    } catch {
      // A disappeared file cannot produce a violation.
    }
  }
  return { violations, scanned };
}

function parseArgs(argv) {
  const options = { root: repoRoot, files: [], help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") options.root = resolve(argv[(i += 1)]);
    else if (arg.startsWith("--root=")) options.root = resolve(arg.slice("--root=".length));
    else if (arg === "--help" || arg === "-h") options.help = true;
    else options.files.push(arg);
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write("usage: node scripts/audit-no-node-ids.mjs [--root DIR] [<file>...]\n");
    return;
  }
  const result =
    options.files.length > 0
      ? scanFiles(null, options.files)
      : scanFiles(options.root, listScanFiles(options.root));
  if (result.violations.length === 0) {
    process.stdout.write(
      `node-id guard: passed. 0 references across ${result.scanned} scanned files.\n`,
    );
    return;
  }
  process.stderr.write(
    `node-id guard: FAILED. ${result.violations.length} node-id reference(s) found.\n` +
      "Node-id references are stale-on-write; remove them instead of encoding planning provenance.\n\n",
  );
  for (const violation of result.violations) {
    process.stderr.write(
      `  ${violation.file}:${violation.line}  ${violation.token}  ${violation.excerpt}\n`,
    );
  }
  process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
