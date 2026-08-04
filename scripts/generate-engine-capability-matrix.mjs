#!/usr/bin/env node
// @itotori-meta-check
// ALPHA-004: Alpha engine capability matrix generator.
//
// This is the stable public and CLI façade. The generator's input registry,
// mechanical row derivation, document assembly, and renderers live in focused
// sibling modules; all original public exports remain available from here.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  GENERATOR_PATH,
  MatrixGenerationError,
  OUTPUT_JSON_PATH,
  OUTPUT_MD_PATH,
  loadInputs,
  repoRoot,
} from "./generate-engine-capability-matrix-inputs.mjs";
import { generateEngineCapabilityMatrix } from "./generate-engine-capability-matrix-document.mjs";
import { renderMatrixMarkdown } from "./generate-engine-capability-matrix-render.mjs";

export {
  CAPABILITY_LEVELS,
  EVIDENCE_POSTURES,
  GENERATOR_PATH,
  INPUT_SOURCES,
  LEVEL_STATUSES,
  MATRIX_SCHEMA_VERSION,
  MatrixGenerationError,
  NON_DRIVER_EXCLUSIONS,
  OUTPUT_JSON_PATH,
  OUTPUT_MD_PATH,
  REQUIRED_INPUT_CATEGORIES,
  REQUIRED_INPUT_KINDS,
  loadInputs,
  repoRoot,
} from "./generate-engine-capability-matrix-inputs.mjs";
export {
  assertRequiredCoverage,
  collectConsumedNamespaces,
  generateEngineCapabilityMatrix,
} from "./generate-engine-capability-matrix-document.mjs";
export {
  renderKnownLimitations,
  renderMatrixMarkdown,
} from "./generate-engine-capability-matrix-render.mjs";

function serializeJson(matrix) {
  return `${JSON.stringify(matrix, null, 2)}\n`;
}

export function buildArtifacts(root = repoRoot) {
  const inputs = loadInputs(root);
  const matrix = generateEngineCapabilityMatrix(inputs);
  return { matrix, json: serializeJson(matrix), markdown: renderMatrixMarkdown(matrix) };
}

function readOrNull(absolute) {
  try {
    return readFileSync(absolute, "utf8");
  } catch {
    return null;
  }
}

function run(argv) {
  const check = argv.includes("--check");
  const { json, markdown } = buildArtifacts(repoRoot);
  const jsonPath = resolve(repoRoot, OUTPUT_JSON_PATH);
  const mdPath = resolve(repoRoot, OUTPUT_MD_PATH);

  if (check) {
    const drift = [];
    if (readOrNull(jsonPath) !== json) {
      drift.push(OUTPUT_JSON_PATH);
    }
    if (readOrNull(mdPath) !== markdown) {
      drift.push(OUTPUT_MD_PATH);
    }
    if (drift.length > 0) {
      console.error(
        `engine capability matrix is stale or hand-edited; regenerate with \`node ${GENERATOR_PATH}\`:\n  ${drift.join(
          "\n  ",
        )}`,
      );
      process.exit(1);
    }
    console.log("engine capability matrix is up to date");
    return;
  }

  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, json);
  writeFileSync(mdPath, markdown);
  console.log(`wrote ${OUTPUT_JSON_PATH} and ${OUTPUT_MD_PATH}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    if (error instanceof MatrixGenerationError) {
      console.error(`MatrixGenerationError: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}
