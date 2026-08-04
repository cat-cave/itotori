#!/usr/bin/env node
// Execute one manifest-owned private-evidence runner. Missing private inputs
// fail this named lane; they never register a skipped test in a public lane.

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { suitesForLiveEvidenceRunner } from "./live-evidence-suite-manifest.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const appPrefix = "apps/itotori/";

const requiredEnvironment = Object.freeze({
  "real-bytes": ["DATABASE_URL"],
  "model-profile": ["DATABASE_URL", "OPENROUTER_API_KEY"],
  "browser-real-bytes": ["PLAYWRIGHT_CHROMIUM_BIN"],
});

function requiredNonNegativeInteger(value, field, format) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${format} receipt has no non-negative integer ${field}`);
  }
  return value;
}

export function requiredEnvironmentForLiveEvidenceRunner(runner) {
  const names = requiredEnvironment[runner];
  if (names === undefined)
    throw new Error(`unknown live evidence runner ${JSON.stringify(runner)}`);
  return names;
}

export function parseVitestReceipt(contents) {
  const report = JSON.parse(contents);
  const total = requiredNonNegativeInteger(report.numTotalTests, "numTotalTests", "Vitest JSON");
  const passed = requiredNonNegativeInteger(report.numPassedTests, "numPassedTests", "Vitest JSON");
  const failed = requiredNonNegativeInteger(report.numFailedTests, "numFailedTests", "Vitest JSON");
  const pending = requiredNonNegativeInteger(
    report.numPendingTests,
    "numPendingTests",
    "Vitest JSON",
  );
  const todo = requiredNonNegativeInteger(report.numTodoTests, "numTodoTests", "Vitest JSON");
  const executed = passed + failed;
  const skipped = pending + todo;
  if (total !== executed + skipped) {
    throw new Error("Vitest JSON receipt has inconsistent test totals");
  }
  return { executed, failed, skipped, total };
}

export function parsePlaywrightReceipt(contents) {
  const report = JSON.parse(contents);
  const stats = report.stats;
  if (stats === null || typeof stats !== "object") {
    throw new Error("Playwright JSON receipt has no stats object");
  }
  const expected = requiredNonNegativeInteger(stats.expected, "stats.expected", "Playwright JSON");
  const skipped = requiredNonNegativeInteger(stats.skipped, "stats.skipped", "Playwright JSON");
  const unexpected = requiredNonNegativeInteger(
    stats.unexpected,
    "stats.unexpected",
    "Playwright JSON",
  );
  const flaky = requiredNonNegativeInteger(stats.flaky, "stats.flaky", "Playwright JSON");
  return {
    executed: expected + unexpected + flaky,
    failed: unexpected,
    skipped,
    total: expected + skipped + unexpected + flaky,
  };
}

export function assertZeroSkippedReceipt({ framework, lane, reportPath }) {
  if (!existsSync(reportPath)) {
    throw new Error(`${lane} did not write its ${framework} test receipt`);
  }
  const contents = readFileSync(reportPath, "utf8");
  const receipt =
    framework === "vitest" ? parseVitestReceipt(contents) : parsePlaywrightReceipt(contents);
  if (receipt.skipped !== 0) {
    throw new Error(
      `${lane} receipt reports ${receipt.skipped} skipped/todo test(s); zero is required`,
    );
  }
  if (receipt.executed === 0 || receipt.total === 0) {
    throw new Error(`${lane} receipt reports zero executed tests`);
  }
  process.stdout.write(
    `live-evidence receipt: ${lane}: ${receipt.executed} executed, 0 skipped (${framework}).\n`,
  );
  return receipt;
}

export function invocationForLiveEvidenceRunner(runner, reportPath) {
  const suites = suitesForLiveEvidenceRunner(runner);
  const framework = suites[0]?.framework;
  if (framework === undefined || suites.some((suite) => suite.framework !== framework)) {
    throw new Error(`live evidence runner ${runner} must own one test framework`);
  }
  const files = suites.map((suite) => {
    if (!suite.file.startsWith(appPrefix)) {
      throw new Error(`live evidence suite is outside the app package: ${suite.file}`);
    }
    return suite.file.slice(appPrefix.length);
  });
  const lane = `live-evidence-${runner}`;
  const defaultReportPath = join(repoRoot, ".tmp", "itotori-test-results", `${lane}.json`);

  if (framework === "vitest") {
    return {
      args: [
        "--filter",
        "@itotori/app",
        "exec",
        "vitest",
        "run",
        "--config",
        "vitest.live-evidence.config.ts",
        "--exclude",
        "**/.direnv/**",
        ...files,
        "--reporter=json",
        `--outputFile=${reportPath ?? defaultReportPath}`,
      ],
      command: "pnpm",
      files,
      framework,
      lane,
      reportPath: reportPath ?? defaultReportPath,
    };
  }

  if (framework === "playwright") {
    return {
      args: [
        "--filter",
        "@itotori/app",
        "exec",
        "playwright",
        "test",
        "--config",
        "e2e/playwright.live-evidence.config.ts",
        ...files,
        "--reporter=json",
      ],
      command: "pnpm",
      files,
      framework,
      lane,
      reportPath: reportPath ?? defaultReportPath,
    };
  }

  throw new Error(`unsupported live evidence framework ${framework}`);
}

export function assertRequiredEnvironment(runner, env = process.env) {
  const missing = requiredEnvironmentForLiveEvidenceRunner(runner).filter((name) => {
    const value = env[name];
    return value === undefined || value.trim() === "";
  });
  if (missing.length > 0) {
    throw new Error(
      `${runner} live-evidence runner requires ${missing.join(", ")}; missing private inputs fail this named proof lane`,
    );
  }
}

function runInvocation(invocation) {
  if (invocation.framework === "vitest") {
    return spawnSync(invocation.command, invocation.args, { cwd: repoRoot, stdio: "inherit" });
  }

  const report = openSync(invocation.reportPath, "w");
  try {
    return spawnSync(invocation.command, invocation.args, {
      cwd: repoRoot,
      stdio: ["inherit", report, "inherit"],
    });
  } finally {
    closeSync(report);
  }
}

export function runLiveEvidenceSuite(runner, env = process.env) {
  assertRequiredEnvironment(runner, env);
  const reportDirectory = mkdtempSync(join(tmpdir(), "itotori-live-evidence-"));
  const invocation = invocationForLiveEvidenceRunner(runner, join(reportDirectory, "receipt.json"));
  let preserveReport = false;
  try {
    const result = runInvocation(invocation);
    if (result.error) throw result.error;
    assertZeroSkippedReceipt(invocation);
    if (result.status !== 0 || result.signal !== null) {
      preserveReport = true;
      return result.status ?? 1;
    }
    return 0;
  } catch (error) {
    preserveReport = true;
    throw error;
  } finally {
    if (preserveReport) {
      process.stderr.write(
        `live-evidence runner: preserving receipt at ${invocation.reportPath}\n`,
      );
    } else {
      rmSync(reportDirectory, { force: true, recursive: true });
    }
  }
}

function invokedAsMain() {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(entry).href;
}

if (invokedAsMain()) {
  try {
    const runner = process.argv[2];
    if (runner === undefined) {
      throw new Error(
        "usage: run-live-evidence-suite.mjs <real-bytes|model-profile|browser-real-bytes>",
      );
    }
    process.exitCode = runLiveEvidenceSuite(runner);
  } catch (error) {
    process.stderr.write(
      `live-evidence runner: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
