#!/usr/bin/env node
// CI guard: no game is mentioned by name in production / shared code.
//
// A concrete game name in shared or production source is a generalization bug:
// engine substrate, CLI defaults, app surfaces, and scripts must be
// title-agnostic. Game identity belongs only in per-game DATA records
// (fixtures, presets, and test corpora), never in a code path.
//
// This is an absolute rule: every scanned reference is an error. The scanner
// deliberately retains the known title, vendor, VNDB-id, and
// `corpus-observed` patterns so newly introduced coupling is rejected.
//
// Scope: tracked source under `crates/`, `packages/`, `apps/`, and `scripts/`
// (`.rs`/`.ts`/`.tsx`/`.js`/`.mjs`/`.cjs`). Excluded as DATA / test / research
// prose: `**/tests?/**`, `**/*.test.*`, `**/*_test.rs`, `**/fixtures?/**` +
// `*fixture*` modules, `**/examples?/**`, build output, `scripts/history/**`,
// migrations, docs, roadmap, `.plan/`, `.qd/`, presets, and the two scanners
// that must name terms to document and enforce them.
//
// Exit codes: 0 = clean; 1 = violation. Wired into `just ci tier0-meta`.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

export const SCAN_EXTENSIONS = new Set([".rs", ".ts", ".tsx", ".js", ".mjs", ".cjs"]);

const EXCLUDE_PATTERNS = [
  "/tests/",
  "/test/",
  "/fixtures/",
  "/fixture/",
  "fixture",
  "/examples/",
  "/example/",
  "/target/",
  "/dist/",
  "/node_modules/",
  "scripts/history/",
  "/migrations/",
  "docs/",
  "roadmap/",
  ".plan/",
  ".qd/",
  "presets/",
  "scripts/audit-no-game-names.mjs",
  "scripts/validate-no-specific-game-references.mjs",
];

const EXCLUDE_SUFFIXES = [
  ".test.ts",
  ".test.tsx",
  ".test.js",
  ".test.mjs",
  ".test.cjs",
  "_test.rs",
  "/tests.rs",
  "/test.rs",
  "fixtures.ts",
  "fixtures.rs",
];

const GAME_NAME_PATTERNS = [
  // Deliberately no word boundaries: `_`, letters, and digits surround title
  // fragments in Rust and TypeScript identifiers, but JavaScript `\b` treats
  // `_` as a word character and would miss them.
  /(?:sweetie|karetoshi|gamekoi|oshioki|sukara)/gi,
  /オシオキ/g,
  /\bv(?:11180|31045|60663|21465|55293|57740)\b/gi,
  /\bcorpus-observed\b/gi,
];

export function isExcludedPath(path) {
  return (
    EXCLUDE_PATTERNS.some((pattern) => path.includes(pattern)) ||
    EXCLUDE_SUFFIXES.some((suffix) => path.endsWith(suffix))
  );
}

export function shouldScan(path) {
  if (isExcludedPath(path)) return false;
  const dot = path.lastIndexOf(".");
  return dot !== -1 && SCAN_EXTENSIONS.has(path.slice(dot));
}

export function findGameNameViolations(path, contents) {
  const found = [];
  const lines = contents.split(/\r?\n/u);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "") continue;
    for (const regex of GAME_NAME_PATTERNS) {
      const re = new RegExp(regex.source, regex.flags);
      for (const match of line.matchAll(re)) {
        found.push({
          file: path,
          line: i + 1,
          token: match[0].toLowerCase(),
          excerpt: line.trim().slice(0, 160),
        });
      }
    }
  }
  return found;
}

export function listScanFiles(root) {
  return execSync("git ls-files crates packages apps scripts", { cwd: root, encoding: "utf8" })
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
      violations.push(...findGameNameViolations(file, readFileSync(target, "utf8")));
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
    process.stdout.write("usage: node scripts/audit-no-game-names.mjs [--root DIR] [<file>...]\n");
    return;
  }
  const result =
    options.files.length > 0
      ? scanFiles(null, options.files)
      : scanFiles(options.root, listScanFiles(options.root));
  if (result.violations.length === 0) {
    process.stdout.write(
      `game-name guard: passed. 0 references across ${result.scanned} scanned files.\n`,
    );
    return;
  }
  process.stderr.write(
    `game-name guard: FAILED. ${result.violations.length} game-name reference(s) found.\n` +
      "Genericize the reference; a game's identity belongs in per-game DATA, not code.\n\n",
  );
  for (const violation of result.violations) {
    process.stderr.write(
      `  ${violation.file}:${violation.line}  ${violation.token}  ${violation.excerpt}\n`,
    );
  }
  process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
