#!/usr/bin/env node
// @itotori-meta-check
// CI guard: no node-id references in tracked text artifacts.
//
// A "node id" is a roadmap / ticket cross-ref (`<PREFIX>-<number>`, a
// `p0-core-<slug>`, or three prose cross-reference forms. Provenance like that
// is stale-on-write: it belongs in
// git history + the PR description, never in a doc comment or source line.
// Planning provenance is stale-on-write outside immutable migration history.
// Every other tracked text artifact must be free of node ids.
//
// Scope: every tracked text file, regardless of extension. This includes source,
// documentation, configuration, workflows, manifests, and scripts. The generated,
// content-addressed artifacts under `fixtures/` and
// `packages/itotori-db/migrations/` applied checksum-locked migration history
// are scoped exemptions below.
// Binary files are scanned too: node-id tokens are ASCII, so a byte decode can
// find them without a file-type blind spot.
//
// Exit codes: 0 = clean; 1 = violation. Wired into `just ci tier0-meta`.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

const EXCLUDE_ROOTS = ["fixtures/", "packages/itotori-db/migrations/"];

const NODE_ID_PATTERNS = [
  // Deliberately no word boundaries: `_`, letters, and digits can surround a
  // stale node id in an identifier, while JavaScript `\b` considers `_` a
  // word character and would miss it.
  /(?:RB|ITOTORI|KAIFUU|UTSUSHI)-\d+/gi,
  /p0-core-[a-z0-9-]+/gi,
  new RegExp(["follow-up", "node"].join(" "), "gi"),
  new RegExp(["see", "node"].join(" "), "gi"),
  new RegExp(["deferred", "for", "node"].join(" "), "gi"),
];

export function isExcludedPath(path) {
  return EXCLUDE_ROOTS.some((root) => path.startsWith(root));
}

export function shouldScan(path) {
  return !isExcludedPath(path);
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
  return execSync("git ls-files", { cwd: root, encoding: "utf8" })
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
      violations.push(...findNodeIdViolations(file, readFileSync(target).toString("utf8")));
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
  const scope =
    "Scope: all tracked files (including binary files); exempt only generated, content-addressed " +
    "fixtures/ and applied packages/itotori-db/migrations/. Cannot see " +
    "untracked or ignored files.\n";
  if (result.violations.length === 0) {
    process.stdout.write(
      `node-id guard: passed. 0 references across ${result.scanned} scanned files.\n${scope}`,
    );
    return;
  }
  process.stderr.write(
    `node-id guard: FAILED. ${result.violations.length} node-id reference(s) found.\n` +
      "Node-id references are stale-on-write; remove them instead of encoding planning provenance.\n" +
      scope +
      "\n",
  );
  for (const violation of result.violations) {
    process.stderr.write(
      `  ${violation.file}:${violation.line}  ${violation.token}  ${violation.excerpt}\n`,
    );
  }
  process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
