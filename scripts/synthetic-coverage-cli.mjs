import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  GENERATOR_PATH,
  ManifestGenerationError,
  OUTPUT_JSON_PATH,
  buildArtifact,
  repoRoot,
} from "./synthetic-coverage-manifest.mjs";
import { diffManifests } from "./synthetic-coverage-diff.mjs";

function readOrNull(absolute) {
  try {
    return readFileSync(absolute, "utf8");
  } catch {
    return null;
  }
}

export function run(argv) {
  const check = argv.includes("--check");
  const { manifest, json } = buildArtifact(repoRoot);
  const jsonPath = resolve(repoRoot, OUTPUT_JSON_PATH);
  if (!check) {
    mkdirSync(dirname(jsonPath), { recursive: true });
    writeFileSync(jsonPath, json);
    console.log(`wrote ${OUTPUT_JSON_PATH}`);
    return;
  }
  const committedRaw = readOrNull(jsonPath);
  if (committedRaw === null) {
    throw new ManifestGenerationError(
      `coverage manifest missing at ${OUTPUT_JSON_PATH}; generate it with \`node ${GENERATOR_PATH}\``,
    );
  }
  let committed;
  try {
    committed = JSON.parse(committedRaw);
  } catch (error) {
    throw new ManifestGenerationError(
      `committed coverage manifest is not valid JSON: ${error?.message}`,
    );
  }
  const { missing, extra } = diffManifests(committed, manifest);
  const problems = [];
  if (missing.length > 0) {
    problems.push(
      `MANIFEST DROPPED BELOW REAL COVERAGE — ${missing.length} real-bytes-exercised component(s) not catalogued:\n    ${missing.join("\n    ")}`,
    );
  }
  if (extra.length > 0) {
    problems.push(
      `stale/invented component(s) no longer produced by the sources:\n    ${extra.join("\n    ")}`,
    );
  }
  if (committedRaw !== json && problems.length === 0) {
    problems.push(
      "committed manifest differs from the re-derived manifest (metadata/formatting drift)",
    );
  }
  if (problems.length > 0) {
    throw new ManifestGenerationError(
      `synthetic coverage manifest is stale; regenerate with \`node ${GENERATOR_PATH}\`:\n  ${problems.join("\n  ")}`,
    );
  }
  console.log("synthetic coverage manifest covers 100% of the real-bytes-exercised components");
}
