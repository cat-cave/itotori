// fe-test-behavior-standard — regression suite for the test-seam classifier.
//
// Proves each detector fires on a synthetic MATCHING snippet and stays silent
// on a non-matching one, that classifyFile applies the precedence rules
// correctly (a file with several signals maps to its strongest seam), that
// summarize computes the behavior ratio correctly, and that the CLI exits 0 on
// the current (green) repo and prints the baseline ratio. Mirrors
// scripts/audit-strictness.test.mjs.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  classifyFile,
  countCases,
  isRealBytes,
  isRealHttp,
  isInternalHandler,
  isDom,
  isRealDb,
  isMocked,
  rustFileHasTests,
  summarize,
  SEAM_ORDER,
  BEHAVIOR_SEAMS,
  WHITEBOX_SEAMS,
} from "./classify-test-seams.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, "classify-test-seams.mjs");

const TS_PATH = "apps/itotori/test/some.test.ts";
const RUST_PATH = "crates/kaifuu-reallive/tests/thing_real_bytes.rs";
const RUST_SRC_PATH = "crates/kaifuu-core/src/lib.rs";

// ---- detector: real-bytes -------------------------------------------------
test("real-bytes: a *_real_bytes.rs path is real-bytes regardless of contents", () => {
  assert.equal(isRealBytes(RUST_PATH, "fn main() {}\n"), true);
});

test("real-bytes: a #[ignore] reason naming the corpus env is real-bytes", () => {
  const contents = '#[ignore = "set ITOTORI_REAL_GAME_ROOT to run"]\nfn live() {}\n';
  assert.equal(isRealBytes(RUST_SRC_PATH, contents), true);
  const vaultContents = '#[ignore = "needs ITOTORI_VAULT_ROOT"]\nfn live() {}\n';
  assert.equal(isRealBytes(RUST_SRC_PATH, vaultContents), true);
});

test("real-bytes: a plain Rust src file with no real-bytes signal is NOT real-bytes", () => {
  assert.equal(
    isRealBytes(RUST_SRC_PATH, "#[test]\nfn pure_logic() { assert_eq!(2 + 2, 4); }\n"),
    false,
  );
});

test("real-bytes: a TS file is never real-bytes (real-bytes is a Rust-only seam)", () => {
  assert.equal(isRealBytes(TS_PATH, "it('does a thing', () => {})\n"), false);
});

// ---- detector: real-http --------------------------------------------------
test("real-http: importing/using startItotoriServer fires", () => {
  assert.equal(
    isRealHttp(TS_PATH, "const { startItotoriServer } = await import('../src/server.js');"),
    true,
  );
});

test("real-http: createItotoriServer fires", () => {
  assert.equal(isRealHttp(TS_PATH, "const server = createItotoriServer({ port: 0 });"), true);
});

test("real-http: a fetch against a hard-coded URL alone does NOT fire (server start is the anchor)", () => {
  // A bare fetch could be hitting a mocked endpoint; the stable signal is the
  // real server factory import. This avoids false positives on MSW-only suites.
  assert.equal(isRealHttp(TS_PATH, "await fetch('http://example.com/api');"), false);
});

// ---- detector: internal-handler -------------------------------------------
test("internal-handler: a direct handleItotoriApiRequest( call fires", () => {
  assert.equal(
    isInternalHandler(
      TS_PATH,
      "const response = await handleItotoriApiRequest(request, services);",
    ),
    true,
  );
});

test("internal-handler: an import-only reference (no call) does NOT fire", () => {
  // The call site `(` is what proves the file opted out of HTTP, not a bare
  // import that may be a type-only reference.
  assert.equal(
    isInternalHandler(TS_PATH, "import { handleItotoriApiRequest } from '../src/api-handlers.js';"),
    false,
  );
});

// ---- detector: dom --------------------------------------------------------
test("dom: the @vitest-environment jsdom pragma fires", () => {
  assert.equal(
    isDom(TS_PATH, "// @vitest-environment jsdom\nimport { describe } from 'vitest';"),
    true,
  );
});

test("dom: a non-jsdom file does NOT fire", () => {
  assert.equal(isDom(TS_PATH, "import { describe, it } from 'vitest';\n"), false);
});

// ---- detector: real-db ----------------------------------------------------
test("real-db: isolatedMigratedContext fires", () => {
  assert.equal(isRealDb(TS_PATH, "const ctx = await isolatedMigratedContext();"), true);
});

test("real-db: a db-test-context import fires", () => {
  assert.equal(
    isRealDb(TS_PATH, "import { isolatedMigratedContext } from './db-test-context.js';"),
    true,
  );
});

test("real-db: a DATABASE_URL reference fires", () => {
  assert.equal(isRealDb(TS_PATH, "const url = process.env.DATABASE_URL;"), true);
});

test("real-db: a plain vitest file with no DB marker does NOT fire", () => {
  assert.equal(isRealDb(TS_PATH, "it('does a thing', () => {})\n"), false);
});

// ---- detector: mocked -----------------------------------------------------
test("mocked: setupServer( fires", () => {
  assert.equal(isMocked(TS_PATH, "const server = setupServer(...handlers);"), true);
});

test("mocked: vi.fn( fires", () => {
  assert.equal(isMocked(TS_PATH, "const fn = vi.fn(async () => null);"), true);
});

test("mocked: vi.mock( fires", () => {
  assert.equal(isMocked(TS_PATH, "vi.mock('../src/server.js');"), true);
});

test("mocked: a pure-logic vitest file with no stubs does NOT fire", () => {
  assert.equal(isMocked(TS_PATH, "it('adds', () => { expect(1 + 1).toBe(2); });\n"), false);
});

// ---- detector: rustFileHasTests -------------------------------------------
test("rustFileHasTests: a #[test] attribute counts", () => {
  assert.equal(rustFileHasTests(RUST_SRC_PATH, "#[test]\nfn thing() {}\n"), true);
});

test("rustFileHasTests: a #[tokio::test] attribute counts", () => {
  assert.equal(rustFileHasTests(RUST_SRC_PATH, "#[tokio::test]\nasync fn thing() {}\n"), true);
});

test("rustFileHasTests: a Rust src file with no tests is excluded from the scan", () => {
  assert.equal(rustFileHasTests(RUST_SRC_PATH, "pub fn thing() {}\n"), false);
});

// ---- classifyFile precedence ----------------------------------------------
test("classifyFile: api-handlers-style (handler-direct + real-db) -> internal-handler (white-box)", () => {
  // The brief names handleItotoriApiRequest-direct as the canonical white-box
  // example: bypassing the HTTP boundary is the defining choice, so it outranks
  // real-db even when the file ALSO drives a real Postgres.
  const contents = [
    "import { isolatedMigratedContext } from './db-test-context.js';",
    "const response = await handleItotoriApiRequest(request, services);",
  ].join("\n");
  assert.equal(classifyFile(TS_PATH, contents), "internal-handler");
  assert.ok(WHITEBOX_SEAMS.has(classifyFile(TS_PATH, contents)));
});

test("classifyFile: server.test.ts-style (real-http + vi.fn mocks) -> real-http (behavior)", () => {
  // server.test.ts stubs every service with vi.fn BUT goes through real HTTP,
  // so the public-boundary signal wins. The brief calls this black-box.
  const contents = [
    "const { startItotoriServer } = await import('../src/server.js');",
    "const getDashboardStatus = vi.fn(async () => fixture);",
    "const response = await fetch(`http://127.0.0.1:${port}/api/projects/status`);",
  ].join("\n");
  assert.equal(classifyFile(TS_PATH, contents), "real-http");
  assert.ok(BEHAVIOR_SEAMS.has(classifyFile(TS_PATH, contents)));
});

test("classifyFile: a repository test (real-db only, no handler-direct) -> real-db (behavior)", () => {
  const contents = "import { isolatedMigratedContext } from './db-test-context.js';";
  assert.equal(classifyFile("packages/itotori-db/test/repository.test.ts", contents), "real-db");
  assert.ok(
    BEHAVIOR_SEAMS.has(classifyFile("packages/itotori-db/test/repository.test.ts", contents)),
  );
});

test("classifyFile: a jsdom + MSW suite (dom + mocked) -> dom (behavior)", () => {
  const contents = [
    "// @vitest-environment jsdom",
    "import { setupServer } from 'msw/node';",
    "const server = setupServer(...handlers);",
  ].join("\n");
  assert.equal(classifyFile(TS_PATH, contents), "dom");
  assert.ok(BEHAVIOR_SEAMS.has(classifyFile(TS_PATH, contents)));
});

test("classifyFile: a pure vi.fn mock test (no boundary) -> mocked (white-box)", () => {
  const contents = "const getDashboardStatus = vi.fn(async () => fixture);";
  assert.equal(classifyFile(TS_PATH, contents), "mocked");
  assert.ok(WHITEBOX_SEAMS.has(classifyFile(TS_PATH, contents)));
});

test("classifyFile: a pure-logic vitest file with no signal -> internal (acceptable white-box)", () => {
  const contents = "it('adds', () => { expect(1 + 1).toBe(2); });";
  assert.equal(classifyFile(TS_PATH, contents), "internal");
  assert.ok(WHITEBOX_SEAMS.has(classifyFile(TS_PATH, contents)));
});

test("classifyFile: a Rust *_real_bytes.rs file -> real-bytes (behavior)", () => {
  assert.equal(classifyFile(RUST_PATH, "fn main() {}\n"), "real-bytes");
});

test("classifyFile: a plain Rust #[test] (pure model logic) -> internal (acceptable white-box)", () => {
  const contents = "#[test]\nfn extracts_bridge_units() { assert!(true); }\n";
  assert.equal(classifyFile(RUST_SRC_PATH, contents), "internal");
  assert.ok(WHITEBOX_SEAMS.has(classifyFile(RUST_SRC_PATH, contents)));
});

// ---- countCases -----------------------------------------------------------
test("countCases: counts vitest it( and test( occurrences in a TS file", () => {
  const contents =
    "describe('x', () => {\n  it('does a', () => {});\n  test('does b', () => {});\n});\n";
  assert.equal(countCases(TS_PATH, contents), 2);
});

test("countCases: counts #[test]-style attributes in a Rust file", () => {
  const contents = "#[test]\nfn a() {}\n#[tokio::test]\nasync fn b() {}\n";
  assert.equal(countCases(RUST_SRC_PATH, contents), 2);
});

// ---- summarize ------------------------------------------------------------
test("summarize: aggregates by seam and computes the behavior ratio", () => {
  const rows = [
    { path: "a.test.ts", seam: "real-http", cases: 3 },
    { path: "b.test.ts", seam: "internal-handler", cases: 5 },
    { path: "c.test.ts", seam: "real-db", cases: 4 },
    { path: "d.rs", seam: "internal", cases: 2 },
  ];
  const s = summarize(rows);
  assert.equal(s.bySeamFiles.get("real-http"), 1);
  assert.equal(s.bySeamCases.get("real-http"), 3);
  assert.equal(s.bySeamFiles.get("internal-handler"), 1);
  assert.equal(s.bySeamCases.get("internal-handler"), 5);
  assert.equal(s.bySeamFiles.get("real-db"), 1);
  assert.equal(s.bySeamCases.get("real-db"), 4);
  assert.equal(s.bySeamFiles.get("internal"), 1);
  assert.equal(s.bySeamCases.get("internal"), 2);
  assert.equal(s.behaviorFiles, 2); // real-http + real-db
  assert.equal(s.behaviorCases, 7);
  assert.equal(s.whiteboxFiles, 2); // internal-handler + internal
  assert.equal(s.whiteboxCases, 7);
  assert.equal(s.totalFiles, 4);
  assert.equal(s.totalCases, 14);
  assert.equal(s.behaviorFileRatio, 0.5);
  assert.equal(s.behaviorCaseRatio, 0.5);
});

test("summarize: every SEAM_ORDER key is present even when no file maps to it", () => {
  const s = summarize([]);
  for (const seam of SEAM_ORDER) {
    assert.equal(s.bySeamFiles.get(seam), 0);
    assert.equal(s.bySeamCases.get(seam), 0);
  }
  assert.equal(s.totalFiles, 0);
  assert.equal(s.behaviorFileRatio, 0);
});

test("summarize: BEHAVIOR_SEAMS and WHITEBOX_SEAMS partition SEAM_ORDER", () => {
  for (const seam of SEAM_ORDER) {
    assert.ok(BEHAVIOR_SEAMS.has(seam) || WHITEBOX_SEAMS.has(seam), `${seam} is uncategorized`);
    assert.ok(!(BEHAVIOR_SEAMS.has(seam) && WHITEBOX_SEAMS.has(seam)), `${seam} is in both sets`);
  }
});

// ---- CLI end-to-end -------------------------------------------------------
test("CLI exits 0 on the current repo and prints the baseline ratio (report, not gate)", () => {
  // The classifier is a REPORT: it always exits 0 so it can run anywhere to
  // anchor a baseline. A scanner error (exit 1) would be a regression.
  let stdout;
  try {
    stdout = execFileSync("node", [scriptPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    assert.fail(`classifier CLI exited non-zero: ${err?.status}; stderr: ${err?.stderr}`);
  }
  assert.match(stdout, /by seam \(files \/ cases\):/u);
  assert.match(stdout, /baseline ratio — behavior files = \d+\.\d+%/u);
  assert.match(stdout, /this is a REPORT, not a gate \(exit 0\)/u);
  // Every declared seam must appear in the by-seam table.
  for (const seam of SEAM_ORDER) {
    assert.ok(stdout.includes(`  ${seam.padEnd(16)}`), `seam '${seam}' missing from by-seam table`);
  }
});
