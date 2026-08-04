import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LIVE_EVIDENCE_RUNNERS,
  appLiveEvidencePlaywrightFiles,
  appLiveEvidencePlaywrightTestPaths,
  appLiveEvidenceVitestFiles,
  liveEvidenceSuites,
  publicAppVitestExclusionArguments,
  suitesForLiveEvidenceRunner,
} from "./live-evidence-suite-manifest.mjs";
import {
  assertRequiredEnvironment,
  assertZeroSkippedReceipt,
  invocationForLiveEvidenceRunner,
  parsePlaywrightReceipt,
  parseVitestReceipt,
} from "./run-live-evidence-suite.mjs";

const root = path.join(import.meta.dirname, "..");
const appPrefix = "apps/itotori/";
const periodicOracleWorkflow = readFileSync(
  path.join(root, ".github/workflows/real-bytes-oracle.yml"),
  "utf8",
);

test("every private suite has one concrete named owner", () => {
  const files = liveEvidenceSuites.map((suite) => suite.file);
  assert.equal(new Set(files).size, files.length);
  for (const suite of liveEvidenceSuites) {
    assert.equal(suite.file.startsWith(appPrefix), true, suite.file);
    assert.equal(existsSync(path.join(root, suite.file)), true, suite.file);
    assert.equal(LIVE_EVIDENCE_RUNNERS.includes(suite.runner), true, suite.runner);
  }
});

test("public configurations exclude exactly the manifest-owned private suites", () => {
  assert.deepEqual(
    publicAppVitestExclusionArguments(),
    appLiveEvidenceVitestFiles.flatMap((file) => ["--exclude", file]),
  );
  assert.deepEqual(
    appLiveEvidencePlaywrightTestPaths,
    appLiveEvidencePlaywrightFiles.map((file) => file.slice("e2e/".length)),
  );

  const vitestConfig = readFileSync(path.join(root, "apps/itotori/vitest.config.ts"), "utf8");
  assert.match(vitestConfig, /appLiveEvidenceVitestFiles/u);
  assert.match(vitestConfig, /\.\.\.appLiveEvidenceVitestFiles/u);

  const playwrightConfig = readFileSync(
    path.join(root, "apps/itotori/e2e/playwright.config.ts"),
    "utf8",
  );
  assert.match(playwrightConfig, /testIgnore:\s*appLiveEvidencePlaywrightTestPaths/u);

  const namedVitestConfig = readFileSync(
    path.join(root, "apps/itotori/vitest.live-evidence.config.ts"),
    "utf8",
  );
  assert.match(namedVitestConfig, /test\/live-evidence\/\*\*\/\*\.test\.ts/u);

  const namedPlaywrightConfig = readFileSync(
    path.join(root, "apps/itotori/e2e/playwright.live-evidence.config.ts"),
    "utf8",
  );
  assert.match(namedPlaywrightConfig, /testMatch:\s*\/live-evidence/u);
});

test("each named runner invokes only its manifest-owned suite paths", () => {
  for (const runner of LIVE_EVIDENCE_RUNNERS) {
    const expected = suitesForLiveEvidenceRunner(runner).map((suite) =>
      suite.file.slice(appPrefix.length),
    );
    const invocation = invocationForLiveEvidenceRunner(runner, "/tmp/live-evidence-receipt.json");
    assert.deepEqual(invocation.files, expected, runner);
    for (const file of expected) assert.equal(invocation.args.includes(file), true, file);
    assert.equal(invocation.reportPath, "/tmp/live-evidence-receipt.json");
  }
});

test("named runners reject absent required inputs before test registration can pass", () => {
  assert.throws(() => assertRequiredEnvironment("real-bytes", {}), /DATABASE_URL/u);
  assert.throws(
    () => assertRequiredEnvironment("model-profile", { DATABASE_URL: "postgres://example" }),
    /OPENROUTER_API_KEY/u,
  );
  assert.throws(
    () => assertRequiredEnvironment("browser-real-bytes", {}),
    /PLAYWRIGHT_CHROMIUM_BIN/u,
  );
});

test("the self-hosted browser evidence job invokes the private browser runner", () => {
  assert.match(periodicOracleWorkflow, /\$just_bin" test browser\n/u);
  assert.match(periodicOracleWorkflow, /\$just_bin" test browser-real-bytes/u);
});

test("named receipts count skipped cases as a failure condition", () => {
  assert.deepEqual(
    parseVitestReceipt(
      JSON.stringify({
        numTotalTests: 2,
        numPassedTests: 1,
        numFailedTests: 0,
        numPendingTests: 1,
        numTodoTests: 0,
      }),
    ),
    { executed: 1, failed: 0, skipped: 1, total: 2 },
  );
  assert.deepEqual(
    parsePlaywrightReceipt(
      JSON.stringify({ stats: { expected: 1, skipped: 1, unexpected: 0, flaky: 0 } }),
    ),
    { executed: 1, failed: 0, skipped: 1, total: 2 },
  );
});

test("a named runner rejects a receipt containing a skipped test", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "itotori-live-evidence-receipt-"));
  const reportPath = path.join(directory, "receipt.json");
  try {
    writeFileSync(
      reportPath,
      JSON.stringify({
        numTotalTests: 1,
        numPassedTests: 0,
        numFailedTests: 0,
        numPendingTests: 1,
        numTodoTests: 0,
      }),
    );
    assert.throws(
      () => assertZeroSkippedReceipt({ framework: "vitest", lane: "fixture", reportPath }),
      /1 skipped/u,
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
