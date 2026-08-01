#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

function count(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label}-invalid`);
  return value;
}

export function assertNoCellRegression({
  candidateCount,
  baselineCount,
  applicableCount,
  baselineApplicableCount,
}) {
  const candidate = count(candidateCount, "candidate-count");
  const baseline = count(baselineCount, "baseline-count");
  const applicable = count(applicableCount, "applicable-count");
  const baselineApplicable = count(baselineApplicableCount, "baseline-applicable-count");
  if (applicable !== baselineApplicable) {
    throw new Error(`applicable-count-drift:${applicable}/${baselineApplicable}`);
  }
  if (candidate < baseline) throw new Error(`cell-count-regression:${candidate}/${baseline}`);
}

function readReport(path, label) {
  let contents;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    throw new Error(`${label}-report-missing:${path}`);
  }
  try {
    return JSON.parse(contents);
  } catch {
    throw new Error(`${label}-report-invalid-json:${path}`);
  }
}

export function assertReportsDoNotRegress(candidateReport, baselineReport) {
  return assertNoCellRegression({
    candidateCount: candidateReport?.summary?.passingCellCount,
    baselineCount: baselineReport?.summary?.passingCellCount,
    applicableCount: candidateReport?.summary?.applicableCellCount,
    baselineApplicableCount: baselineReport?.summary?.applicableCellCount,
  });
}

function parseArgs(args) {
  if (args.length !== 2) {
    throw new Error("usage: behavior-cell-ratchet.mjs <candidate-report> <baseline-report>");
  }
  return args;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [candidatePath, baselinePath] = parseArgs(process.argv.slice(2));
    const candidateReport = readReport(candidatePath, "candidate");
    const baselineReport = readReport(baselinePath, "baseline");
    assertReportsDoNotRegress(candidateReport, baselineReport);
    process.stdout.write(
      `cell-count-ratchet-passed:${candidateReport.summary.passingCellCount}/${baselineReport.summary.passingCellCount}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
