#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseFeature } from "./audit-behavior-catalog-gherkin.mjs";
import { buildBehaviorCaseSelection } from "./behavior-case-selection.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(here, "..");
const EXPECTED_OUTLINES = 47;
const EXPECTED_AUTHORED_CASES = 570;
const EXPECTED_SELECTED_CASES = 3_400;
const EXPECTED_PARTIAL_CASES = 2_940;

function readJsonl(path, label, errors) {
  if (!existsSync(path)) {
    errors.push(`${label}: missing required registry`);
    return [];
  }
  const rows = [];
  for (const [index, line] of readFileSync(path, "utf8").split(/\r?\n/u).entries()) {
    if (line === "") continue;
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      errors.push(`${label}:${index + 1}: invalid JSON: ${error.message}`);
    }
  }
  return rows;
}

export function auditBehaviorRoadmapCases(root = defaultRoot) {
  const errors = [];
  const registryPath = join(root, "docs", "behaviors", "engine-families.jsonl");
  const engines = readJsonl(registryPath, "docs/behaviors/engine-families.jsonl", errors);
  const classificationPath = join(root, "docs", "roadmap", "classification.jsonl");
  const classifications = readJsonl(
    classificationPath,
    "docs/roadmap/classification.jsonl",
    errors,
  );

  const featureDirectory = join(root, "docs", "behaviors", "features");
  const featureFiles = existsSync(featureDirectory)
    ? readdirSync(featureDirectory)
        .filter((path) => path.endsWith(".feature"))
        .toSorted()
    : [];
  if (featureFiles.length === 0) {
    errors.push("docs/behaviors/features: no feature files");
  }
  const scenarios = featureFiles.flatMap((path) =>
    parseFeature(join(featureDirectory, path), errors),
  );
  const selection = buildBehaviorCaseSelection({ scenarios, engines, classifications });
  errors.push(...selection.errors);
  const summary = selection.summary;
  if (summary.outlines !== EXPECTED_OUTLINES) {
    errors.push(`Gherkin outline count is ${summary.outlines}; expected ${EXPECTED_OUTLINES}`);
  }
  if (summary.authoredCases !== EXPECTED_AUTHORED_CASES) {
    errors.push(
      `authored case count is ${summary.authoredCases}; expected ${EXPECTED_AUTHORED_CASES}`,
    );
  }
  if (summary.partialOutlines !== 14) {
    errors.push(`partial rule count is ${summary.partialOutlines}; expected 14`);
  }
  if (summary.partialCases !== EXPECTED_PARTIAL_CASES) {
    errors.push(
      `partial selected case count is ${summary.partialCases}; expected ${EXPECTED_PARTIAL_CASES}`,
    );
  }
  if (summary.selectedCases !== EXPECTED_SELECTED_CASES) {
    errors.push(
      `selected case count is ${summary.selectedCases}; expected ${EXPECTED_SELECTED_CASES}`,
    );
  }
  if (summary.canonicalEngines !== 47) {
    errors.push(`canonical engine count is ${summary.canonicalEngines}; expected 47`);
  }
  if (summary.productionEngines !== 39) {
    errors.push(`production engine count is ${summary.productionEngines}; expected 39`);
  }
  if (summary.nativeEngines !== 35 || summary.webEngines !== 5 || summary.plainEngines !== 9) {
    errors.push(
      `trait counts are native=${summary.nativeEngines}, web=${summary.webEngines}, plain=${summary.plainEngines}; expected 35/5/9`,
    );
  }
  if (summary.applicableCells !== 687) {
    errors.push(`applicable cell count is ${summary.applicableCells}; expected 687`);
  }
  if (summary.nonApplicablePairs !== 96) {
    errors.push(`non-applicable pair count is ${summary.nonApplicablePairs}; expected 96`);
  }

  return {
    ok: errors.length === 0,
    errors,
    ...summary,
  };
}

export function formatBehaviorRoadmapCases(result) {
  if (!result.ok) {
    return `Behavior roadmap case audit failed:\n${result.errors
      .map((error) => `- ${error}`)
      .join("\n")}`;
  }
  return (
    `Behavior roadmap cases: ${result.outlines} outlines, ${result.authoredCases} authored rows, ` +
    `${result.selectedCases} selected cases (${result.partialCases} from 14 partial outlines); ` +
    `${result.canonicalEngines} canonical and ${result.productionEngines} production subjects.`
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = auditBehaviorRoadmapCases();
  (result.ok ? console.log : console.error)(formatBehaviorRoadmapCases(result));
  if (!result.ok) process.exitCode = 1;
}
