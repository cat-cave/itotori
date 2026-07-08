#!/usr/bin/env node
// fe-test-behavior-standard — BEHAVIOR-FIRST test-seam classifier.
//
// Trevor's mandate (2026-07-07): prefer BLACK-BOX tests that assert
// OBSERVABLE behavior through a PUBLIC boundary (a real HTTP response, a row
// persisted to and read back from Postgres, bytes a real decoder produced, a
// rendered DOM node) over WHITE-BOX / mocked / implementation-coupled tests
// that assert on internal call shape or stubbed return values. This is a BIAS,
// not a ban: a pure model-logic unit test (no boundary to observe) is fine.
// See docs/dev/testing-standard.md § "Behavior-First Principle".
//
// This script makes drift VISIBLE. It scans the tracked test suites
// (apps/*/test, packages/*/test, crates/) and classifies each test FILE into
// exactly one PRIMARY SEAM by the strongest signal it emits, then prints a
// by-seam count + a behavior-vs-internal RATIO. It is a REPORT, not a gate:
// it always exits 0 (unless it crashes), so it can run anywhere
// (`just test-ratio`, CI dashboards, PR notes) to anchor a baseline and surface
// the trend. The first run on the current tree establishes the baseline ratio;
// future runs diff against it by eye. Promoting it to a hard fail is a later
// decision (see § "Promoting to a gate" in the testing standard).
//
// It MIRRORS scripts/audit-strictness.mjs / scripts/audit-no-hardcoded-cost.mjs
// in structure, style, exit codes, comment-skipping, and file-scanning; the
// companion regression suite scripts/classify-test-seams.test.mjs exercises
// every signal below.
//
// Seams (highest precedence first; a file maps to its strongest signal):
//   real-bytes        Rust *_real_bytes.rs OR a #[ignore = "…"] naming a live
//                     corpus env (ITOTORI_REAL_GAME_ROOT* / ITOTORI_VAULT_ROOT).
//                     BEHAVIOR — a real decoder produced these bytes.
//   real-http         TS that starts the real Itotori HTTP server
//                     (startItotoriServer / createItotoriServer) and fetches.
//                     BEHAVIOR — the public HTTP contract.
//   internal-handler  TS that calls handleItotoriApiRequest(…) DIRECTLY,
//                     bypassing HTTP. WHITE-BOX — the file chose the internal
//                     handler seam over the public one (this outranks real-db
//                     and dom because bypassing the boundary is the defining
//                     choice; it is the canonical white-box example in the
//                     brief).
//   dom               TS with `@vitest-environment jsdom` (renders real DOM).
//                     BEHAVIOR — observable rendered output.
//   real-db           TS that drives a real Postgres (isolatedMigratedContext
//                     / migratedContext / db-test-context / DATABASE_URL).
//                     BEHAVIOR — a real row persisted and read back.
//   mocked            TS whose only signal is stubs (setupServer/MSW, vi.fn,
//                     vi.mock) with NO public boundary. WHITE-BOX — asserts on
//                     stubbed return values / mock call shape.
//   internal          default for TS (pure logic) AND for Rust #[test]s that
//                     are not real-bytes (pure model logic — acceptable
//                     white-box per the brief).
//
// BEHAVIOR = { real-bytes, real-http, dom, real-db }
// WHITE-BOX = { internal-handler, mocked, internal }
//
// Exit codes:
//   0 — report printed (always; this is a report, not a gate)
//   1 — unrecoverable scanner error (bad git invocation, etc.)
//
// Run: `node scripts/classify-test-seams.mjs`            (scan the tracked tree)
//      `node scripts/classify-test-seams.mjs --files a,b` (unused; the regression
//        suite calls the exported helpers directly)
// Wired into the justfile as `just test-ratio`.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { execSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

// ---- Signal detectors ------------------------------------------------------
// Each detector takes (path, contents) and returns true if the file emits that
// seam's signal. A file may emit several; precedence (below) picks the primary.
// Detectors are deliberately CHEAP and SPECIFIC: a false-positive is worse than
// a miss because the ratio drives a bias, so signals anchor on unambiguous
// boundary markers (server start, handler-direct call, jsdom pragma, db-test
// context, MSW setupServer, real-bytes path/ignore-reason) rather than fuzzy
// heuristics.

// real-bytes: a Rust file whose path names a real-bytes suite OR whose
// `#[ignore = "…"]` reason names a live corpus env (mirrors audit-strictness's
// crateOwnsRealBytes). These are the strict ground-truth lanes; the bytes a
// real decoder/patcher produced are the observable.
const REAL_BYTES_PATH = /_real_bytes\.rs$/u;
const IGNORE_REASON_REAL_BYTES = /ITOTORI_REAL_GAME_ROOT|ITOTORI_VAULT_ROOT/u;

export function isRealBytes(path, contents) {
  if (REAL_BYTES_PATH.test(path)) return true;
  if (!path.endsWith(".rs")) return false;
  for (const line of contents.split(/\r?\n/u)) {
    const m = line.trim().match(/^#\[\s*ignore\s*=\s*"([^"]*)"/u);
    if (m && IGNORE_REASON_REAL_BYTES.test(m[1])) return true;
  }
  return false;
}

// real-http: the file starts the real Itotori HTTP server. The unambiguous
// markers are the server-factory entry points (startItotoriServer /
// createItotoriServer); a fetch( against an ephemeral port derived from a
// bound AddressInfo is the matching client side, but the server start import
// is the stable anchor (it is what makes the HTTP boundary real).
const REAL_HTTP = /\b(?:start|create)ItotoriServer\b/u;

export function isRealHttp(_path, contents) {
  return REAL_HTTP.test(contents);
}

// internal-handler: the file calls the API handler function DIRECTLY, opting
// out of the HTTP boundary. This is the canonical white-box seam named in the
// brief (handleItotoriApiRequest-direct). Matching the call site `(` (not just
// the import) keeps an import-only reference from triggering.
const INTERNAL_HANDLER = /\bhandleItotoriApiRequest\s*\(/u;

export function isInternalHandler(_path, contents) {
  return INTERNAL_HANDLER.test(contents);
}

// dom: the file renders real DOM in jsdom. The unambiguous anchor is the
// vitest environment pragma; @testing-library / react-dom imports are the
// matching render side but the pragma is the stable signal.
const DOM = /@vitest-environment\s+jsdom/u;

export function isDom(_path, contents) {
  return DOM.test(contents);
}

// real-db: the file drives a real Postgres. Anchors: the shared db-test-context
// helper (isolatedMigratedContext / migratedContext), a direct import of that
// module, or a DATABASE_URL reference. (Repository method calls alone are not a
// signal — they could be against an in-memory fake; the context helper / env
// reference is what proves a real Postgres.)
const REAL_DB = /\bisolatedMigratedContext\b|\bmigratedContext\b|db-test-context|\bDATABASE_URL\b/u;

export function isRealDb(_path, contents) {
  return REAL_DB.test(contents);
}

// mocked: the file's ONLY signal is stubs. setupServer( = MSW (the HTTP wire
// is faked, not real); vi.fn( / vi.mock( = vitest stubs. Because this is the
// LOWEST-precedence white-box signal above `internal`, it only wins for files
// with NO behavior seam and NO internal-handler seam — i.e. a pure mock test
// asserting on stubbed returns / mock call shape. (server.test.ts uses vi.fn
// heavily but real-http outranks it, so it correctly counts as behavior.)
const MOCKED = /\bsetupServer\s*\(|\bvi\.fn\s*\(|\bvi\.mock\s*\(/u;

export function isMocked(_path, contents) {
  return MOCKED.test(contents);
}

// A Rust file "has tests" if it carries at least one #[test]-style attribute.
// Rust files without tests (pure src/ library code) are excluded from the
// report so the denominator is honest.
const RUST_TEST_ATTR = /^#\[\s*(?:tokio::)?test\s*\]/mu;

export function rustFileHasTests(_path, contents) {
  return RUST_TEST_ATTR.test(contents);
}

// ---- Precedence ------------------------------------------------------------
// A file maps to exactly one primary seam. The order encodes the brief's
// mental model: the strongest PUBLIC-BOUNDARY signal wins; when a file opts
// OUT of the public boundary (internal-handler) that choice is defining, even
// if the file ALSO does real-db work; pure-stub tests fall below behavior;
// pure-logic tests with no signal default to `internal`.
//
// BEHAVIOR seams: real-bytes, real-http, dom, real-db.
// WHITE-BOX seams: internal-handler, mocked, internal.
export const SEAM_ORDER = [
  "real-bytes",
  "real-http",
  "internal-handler",
  "dom",
  "real-db",
  "mocked",
  "internal",
];

export const BEHAVIOR_SEAMS = new Set(["real-bytes", "real-http", "dom", "real-db"]);
export const WHITEBOX_SEAMS = new Set(["internal-handler", "mocked", "internal"]);

// Pure evaluator (exported for the regression suite): given a test file's path
// and contents, return its primary seam. Detectors are consulted in precedence
// order; the first match wins. A TS test file with no detector match (rare —
// e.g. a pure-logic .test.ts with no vi.fn) falls through to `internal`; a
// Rust test file with no real-bytes signal also falls to `internal`.
export function classifyFile(path, contents) {
  const isRust = path.endsWith(".rs");
  // Rust: real-bytes is the only non-`internal` seam.
  if (isRust) {
    return isRealBytes(path, contents) ? "real-bytes" : "internal";
  }
  // TS: consult detectors in precedence order.
  if (isRealHttp(path, contents)) return "real-http";
  if (isInternalHandler(path, contents)) return "internal-handler";
  if (isDom(path, contents)) return "dom";
  if (isRealDb(path, contents)) return "real-db";
  if (isMocked(path, contents)) return "mocked";
  return "internal";
}

// ---- Test-case counting ----------------------------------------------------
// A SECONDARY metric (files is the primary). Counting test cases per seam
// gives the ratio a denominator that reflects test-writing effort, not just
// file-chunking. Kept deliberately simple: a test file's cases all roll up to
// its primary seam. TS counts vitest `it(`/`test(`; Rust counts
// `#[test]`-style attributes.
const TS_CASE = /\b(?:it|test)\s*\(/gu;
const RUST_CASE = /^#\[\s*(?:tokio::)?test\s*\]/gmu;

export function countCases(path, contents) {
  const re = path.endsWith(".rs") ? RUST_CASE : TS_CASE;
  let count = 0;
  for (const _m of contents.matchAll(re)) count += 1;
  return count;
}

// ---- File discovery --------------------------------------------------------
// TS test files under the product test roots. Rust files under crates/ that
// carry at least one test. The dev-harness suites (scripts/, suite/scripts/)
// are deliberately EXCLUDED — they test the dev tooling, not the product, and
// would skew the ratio; the report says so explicitly.
const TS_TEST_GLOBS = [
  "apps/itotori/test",
  "packages/itotori-db/test",
  "packages/localization-bridge-schema/test",
  "packages/spec-dag-dashboard/test",
];

function listTsTestFiles() {
  const out = execSync(`git ls-files ${TS_TEST_GLOBS.join(" ")}`, {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.endsWith(".test.ts") || l.endsWith(".test.tsx"));
}

function listRustTestFiles() {
  const out = execSync("git ls-files crates", { cwd: repoRoot, encoding: "utf8" });
  const files = out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.endsWith(".rs"));
  // Keep only Rust files that actually carry tests.
  return files.filter((relPath) => {
    const contents = readRepoFile(relPath);
    return contents !== undefined && rustFileHasTests(relPath, contents);
  });
}

function readRepoFile(relPath) {
  try {
    return readFileSync(join(repoRoot, relPath), "utf8");
  } catch {
    return undefined;
  }
}

// ---- Report ----------------------------------------------------------------
// Pure evaluator (exported for the regression suite): given a list of
// { path, seam, cases } rows, return the aggregate by-seam counts + the
// behavior ratio (by files and by cases).
export function summarize(rows) {
  const bySeamFiles = new Map();
  const bySeamCases = new Map();
  for (const seam of SEAM_ORDER) {
    bySeamFiles.set(seam, 0);
    bySeamCases.set(seam, 0);
  }
  for (const row of rows) {
    bySeamFiles.set(row.seam, bySeamFiles.get(row.seam) + 1);
    bySeamCases.set(row.seam, bySeamCases.get(row.seam) + row.cases);
  }
  let behaviorFiles = 0;
  let whiteboxFiles = 0;
  let behaviorCases = 0;
  let whiteboxCases = 0;
  for (const seam of SEAM_ORDER) {
    const files = bySeamFiles.get(seam);
    const cases = bySeamCases.get(seam);
    if (BEHAVIOR_SEAMS.has(seam)) {
      behaviorFiles += files;
      behaviorCases += cases;
    } else {
      whiteboxFiles += files;
      whiteboxCases += cases;
    }
  }
  const totalFiles = behaviorFiles + whiteboxFiles;
  const totalCases = behaviorCases + whiteboxCases;
  return {
    bySeamFiles,
    bySeamCases,
    behaviorFiles,
    whiteboxFiles,
    behaviorCases,
    whiteboxCases,
    totalFiles,
    totalCases,
    behaviorFileRatio: totalFiles === 0 ? 0 : behaviorFiles / totalFiles,
    behaviorCaseRatio: totalCases === 0 ? 0 : behaviorCases / totalCases,
  };
}

function pct(n) {
  return `${(n * 100).toFixed(1)}%`;
}

function runScan() {
  const tsFiles = listTsTestFiles();
  const rustFiles = listRustTestFiles();
  const rows = [];
  for (const relPath of tsFiles) {
    const contents = readRepoFile(relPath);
    if (contents === undefined) continue;
    rows.push({
      path: relPath,
      seam: classifyFile(relPath, contents),
      cases: countCases(relPath, contents),
    });
  }
  for (const relPath of rustFiles) {
    const contents = readRepoFile(relPath);
    if (contents === undefined) continue;
    rows.push({
      path: relPath,
      seam: classifyFile(relPath, contents),
      cases: countCases(relPath, contents),
    });
  }
  const s = summarize(rows);

  const out = process.stdout;
  out.write("fe-test-behavior-standard: test-seam classifier (behavior-first bias)\n");
  out.write("see docs/dev/testing-standard.md § Behavior-First Principle\n");
  out.write(`scanned: ${tsFiles.length} TS test files + ${rustFiles.length} Rust test files `);
  out.write(
    "(apps/*/test, packages/*/test, crates/; dev-harness suites under scripts/ + suite/scripts/ are excluded)\n\n",
  );

  out.write("by seam (files / cases):\n");
  for (const seam of SEAM_ORDER) {
    const files = s.bySeamFiles.get(seam);
    const cases = s.bySeamCases.get(seam);
    const kind = BEHAVIOR_SEAMS.has(seam) ? "behavior" : "white-box";
    out.write(
      `  ${seam.padEnd(16)} ${String(files).padStart(4)} files / ${String(cases).padStart(5)} cases   [${kind}]\n`,
    );
  }
  out.write("\n");
  out.write(
    `behavior  (real-bytes + real-http + dom + real-db): ${s.behaviorFiles}/${s.totalFiles} files ` +
      `(${pct(s.behaviorFileRatio)}) / ${s.behaviorCases}/${s.totalCases} cases (${pct(s.behaviorCaseRatio)})\n`,
  );
  out.write(
    `white-box (internal-handler + mocked + internal):   ${s.whiteboxFiles}/${s.totalFiles} files ` +
      `(${pct(1 - s.behaviorFileRatio)}) / ${s.whiteboxCases}/${s.totalCases} cases (${pct(1 - s.behaviorCaseRatio)})\n`,
  );
  out.write("\n");
  out.write(
    "baseline ratio — behavior files = " +
      pct(s.behaviorFileRatio) +
      ", behavior cases = " +
      pct(s.behaviorCaseRatio) +
      ".\n",
  );
  out.write(
    "this is a REPORT, not a gate (exit 0). Diff against this baseline by eye; promote to a hard fail later.\n",
  );
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    process.exit(runScan());
  } catch (err) {
    process.stderr.write(`classify-test-seams: scanner error: ${err?.message ?? err}\n`);
    process.exit(1);
  }
}
