#!/usr/bin/env node
// @itotori-meta-check
// CI guard: corpus identities in tracked artifacts must be opaque.
//
// A corpus is addressed by engine/ordinal/variant or a content hash. A title
// must not be copied into code, test names, docs, or workflows. The detector
// deliberately recognises identifier *shapes*, rather
// than a hand-maintained title vocabulary: adding another title-shaped corpus
// identity therefore changes the result without changing this guard.
//
// Scope: every tracked UTF-8 text file. The two files below are individually
// exempt because one defines the detection shapes and the other supplies
// synthetic negative examples.
//
// Limit: unstructured prose names and encrypted/opaque byte blobs cannot be
// identified reliably without an authoritative title inventory. Shift-JIS
// hex literals are checked when their surrounding symbol identifies a title.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

const SELF_REFERENTIAL_FILES = new Set([
  "scripts/audit-no-game-names.mjs",
  "scripts/audit-no-game-names.test.mjs",
]);

const TITLE_SHAPES = [
  /\b[a-z][a-z0-9-]{2,}\.v[1-9][0-9]{4,}\b/giu,
  /\bv[1-9][0-9]{3,}_(?:[a-z0-9]+_){2,}[a-z0-9]+\b/giu,
  /\bv[1-9][0-9]{3,}\s+[A-Z][\p{Ll}]+(?:-[A-Z][\p{Ll}]+){2,}\b/gu,
];
const HEX_BYTE = /0x([0-9a-f]{2})/giu;
const SHIFT_JIS = new TextDecoder("shift_jis", { fatal: true });

export function isExcludedPath(path) {
  return SELF_REFERENTIAL_FILES.has(path);
}

export function shouldScan(path) {
  return !isExcludedPath(path);
}

function findShiftJisTitleLiterals(path, contents) {
  if (!path.endsWith(".rs")) return [];
  const found = [];
  const literal =
    /\b(?:fn|const)\b[\s\S]{0,120}?\btitle[\s\S]{0,120}?=\s*(?:vec!|&)\[([\s\S]{0,600}?)\]/giu;
  for (const match of contents.matchAll(literal)) {
    const bytes = [...match[1].matchAll(HEX_BYTE)].map((entry) => Number.parseInt(entry[1], 16));
    if (bytes.length < 6) continue;
    try {
      const decoded = SHIFT_JIS.decode(Uint8Array.from(bytes));
      if (
        !/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(decoded) ||
        !/[A-Za-z]{4}/u.test(decoded)
      )
        continue;
      const prefix = contents.slice(0, match.index);
      const line = prefix.split(/\r?\n/u).length;
      found.push({
        file: path,
        line,
        token: "shift-jis-title-literal",
        excerpt: contents.slice(match.index, match.index + 160).replace(/\s+/gu, " "),
      });
    } catch {
      // A byte array that is not valid Shift-JIS is not a title literal.
    }
  }
  return found;
}

export function findGameNameViolations(path, contents) {
  const found = [];
  const lines = contents.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const pattern of TITLE_SHAPES) {
      const matcher = new RegExp(pattern.source, pattern.flags);
      for (const match of line.matchAll(matcher)) {
        found.push({
          file: path,
          line: index + 1,
          token: match[0],
          excerpt: line.trim().slice(0, 160),
        });
      }
    }
  }
  return [...found, ...findShiftJisTitleLiterals(path, contents)];
}

export function listScanFiles(root) {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
}

function readUtf8(path) {
  const bytes = readFileSync(path);
  if (bytes.includes(0)) return null;
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function scanFiles(root, files) {
  const violations = [];
  let scanned = 0;
  for (const file of files) {
    if (!shouldScan(file)) continue;
    try {
      const target = root === null ? file : join(root, file);
      const contents = readUtf8(target);
      if (contents === null) continue;
      violations.push(...findGameNameViolations(file, contents));
      scanned += 1;
    } catch {
      // A disappeared, binary, or non-UTF-8 file cannot be text-scanned.
    }
  }
  return { violations, scanned };
}

function parseArgs(argv) {
  const options = { root: repoRoot, files: [], help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") options.root = resolve(argv[(index += 1)]);
    else if (arg.startsWith("--root=")) options.root = resolve(arg.slice("--root=".length));
    else if (arg === "--help" || arg === "-h") options.help = true;
    else options.files.push(arg);
  }
  return options;
}

function printReferences(label, references) {
  process.stderr.write(`${label}: ${references.length} reference(s).\n`);
  for (const violation of references) {
    process.stderr.write(
      `  ${violation.file}:${violation.line}  ${violation.token}  ${violation.excerpt}\n`,
    );
  }
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
      `game-name guard: passed. 0 enforced references across ${result.scanned} scanned files. ` +
        `Limit: unstructured prose names and opaque bytes need an authoritative inventory.\n`,
    );
    return;
  }
  printReferences("game-name guard: FAILED", result.violations);
  process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
