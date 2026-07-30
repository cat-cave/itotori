import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const EXPECTED_ENGINE_FAMILIES = 47;
const EXPECTED_ENGINE_MATRIX_HASH =
  "4e7d40a4fc50ff6b6d37554eeedaedd4f9cce930620ae39a1fb24e650a2a499a";
const EXPECTED_ENGINE_OUTCOME_HASH =
  "b4dd20f91461d057f4e5d13094726ad7ada7fae09cf9fd371c979766d7fd8ef3";
const ENGINE_KEYS = ["engineFamily", "profile", "sourceCapability", "sourceState", "supportRole"];
const FULL_ENGINE_MATRIX_BEHAVIORS = new Set([
  "support.qualify-profile",
  "support.disclose-compatibility",
  "content.extract-complete-scope",
  "patch.produce-safe-output",
  "play.launch-patched-content",
]);
const SPECIAL_POLICIES = new Map([
  ["decode.engine.fixture-reference", ["synthetic-reference", "synthetic conformance profile"]],
  ["decode.engine.artemis-engine", ["research-only", "research profile"]],
  ["decode.engine.nscripter", ["explicit-exclusion", "excluded profile"]],
  ["decode.engine.shiina-rio", ["research-only", "research profile"]],
  ["decode.engine.system-nnn", ["research-only", "research profile"]],
  ["decode.engine.livemaker", ["research-only", "research profile"]],
  ["runtime.engine.rpg-maker-xp-parity-reference", ["parity-reference", "parity profile"]],
  ["quality.engine.mages-benchmark-reference", ["benchmark-reference", "benchmark profile"]],
]);
const PRODUCTION_PROFILES = new Set([
  "registered production profile",
  "bounded production profile",
  "unqualified target profile",
]);
const OUTCOME_MARKERS = new Map([
  ["synthetic-reference", /\bsynthetic\b/iu],
  ["research-only", /\bresearch\b/iu],
  ["explicit-exclusion", /\b(?:exclusion|out-of-scope)\b/iu],
  ["parity-reference", /\bparity\b/iu],
  ["benchmark-reference", /\bbenchmark\b/iu],
]);

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameStrings(actual, expected) {
  return (
    actual.length === expected.length &&
    [...actual].sort().every((value, index) => value === [...expected].sort()[index])
  );
}

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function readEngineRows(root, errors) {
  const path = join(root, "docs", "behaviors", "engine-families.jsonl");
  const rows = [];
  for (const [index, line] of readFileSync(path, "utf8").split(/\r?\n/u).entries()) {
    if (line.trim() === "") continue;
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      errors.push(`${path}:${index + 1}: invalid JSON: ${error.message}`);
    }
  }
  return rows;
}

function validatePolicy(rows, errors) {
  for (const row of rows) {
    if (!sameStrings(Object.keys(row), ENGINE_KEYS)) {
      errors.push(`engine example ${row.engineFamily}: unexpected fields`);
    }
    if (ENGINE_KEYS.some((key) => typeof row[key] !== "string" || row[key].trim() === "")) {
      errors.push(`engine example ${row.engineFamily}: every field must be populated`);
    }
    const special = SPECIAL_POLICIES.get(row.sourceCapability);
    const expectedRole = special?.[0] ?? "production-target";
    if (row.supportRole !== expectedRole) {
      errors.push(
        `engine example ${row.engineFamily}: role ${row.supportRole} contradicts ${expectedRole}`,
      );
    }
    if (special && row.profile !== special[1]) {
      errors.push(`engine example ${row.engineFamily}: profile contradicts ${special[1]}`);
    }
    if (!special && !PRODUCTION_PROFILES.has(row.profile)) {
      errors.push(`engine example ${row.engineFamily}: invalid production profile ${row.profile}`);
    }
  }
  const canonical = stableStringify(
    [...rows].sort((left, right) => left.sourceCapability.localeCompare(right.sourceCapability)),
  );
  const hash = createHash("sha256").update(`${canonical}\n`).digest("hex");
  if (hash !== EXPECTED_ENGINE_MATRIX_HASH) {
    errors.push(`engine matrix hash ${hash} != ${EXPECTED_ENGINE_MATRIX_HASH}`);
  }
}

function validateScenarioMatrices(rows, scenarios, errors) {
  const matrix = rows
    .map((row) => [row.engineFamily, row.profile, row.supportRole].join("\t"))
    .sort();
  const outcomes = [];
  for (const id of FULL_ENGINE_MATRIX_BEHAVIORS) {
    const scenario = scenarios.find((candidate) => candidate.id === id);
    if (!scenario) continue;
    const actual = scenario.exampleRows
      .map((row) => [row.engine_family, row.profile, row.support_role].join("\t"))
      .sort();
    if (!sameStrings(actual, matrix)) {
      errors.push(`${id}: Examples do not contain the exact 47 engine slots`);
    }
    for (const example of scenario.exampleRows) {
      outcomes.push([
        id,
        example.engine_family,
        example.profile,
        example.support_role,
        example.expected_outcome,
      ]);
      const marker = OUTCOME_MARKERS.get(example.support_role);
      if (marker && !marker.test(example.expected_outcome)) {
        errors.push(`${id}: ${example.engine_family} outcome contradicts ${example.support_role}`);
      }
    }
  }
  outcomes.sort((left, right) => left.join("\t").localeCompare(right.join("\t")));
  const outcomeHash = createHash("sha256")
    .update(`${stableStringify(outcomes)}\n`)
    .digest("hex");
  if (outcomeHash !== EXPECTED_ENGINE_OUTCOME_HASH) {
    errors.push(
      `engine behavior outcome matrix hash ${outcomeHash} != ${EXPECTED_ENGINE_OUTCOME_HASH}`,
    );
  }
}

function validateEngineLiterals(rows, scenarios, errors) {
  const featureFiles = [...new Set(scenarios.map((scenario) => scenario.path))];
  for (const path of featureFiles) {
    const lines = readFileSync(path, "utf8").split(/\r?\n/u);
    for (const [index, line] of lines.entries()) {
      if (/^\s*\|/u.test(line)) continue;
      for (const row of rows) {
        if (
          row.engineFamily.length >= 4 &&
          line.toLowerCase().includes(row.engineFamily.toLowerCase())
        ) {
          errors.push(
            `${path}:${index + 1}: engine literal "${row.engineFamily}" must be an Examples cell`,
          );
        }
      }
    }
  }
}

export function validateEngineFamilies(root, sources, mappings, scenarios, errors) {
  const rows = readEngineRows(root, errors);
  if (rows.length !== EXPECTED_ENGINE_FAMILIES) {
    errors.push(`engine examples: expected ${EXPECTED_ENGINE_FAMILIES}, found ${rows.length}`);
  }
  const sourceById = new Map(sources.map((source) => [source.c, source]));
  const expectedIds = sources
    .filter((source) => /^(?:decode|runtime|quality)\.engine\./u.test(source.c))
    .map((source) => source.c)
    .sort();
  const actualIds = rows.map((row) => row.sourceCapability).sort();
  if (!sameStrings(actualIds, expectedIds)) {
    errors.push("engine examples do not cover the exact 47 engine rows");
  }
  for (const row of rows) {
    const source = sourceById.get(row.sourceCapability);
    if (!source || source.st !== row.sourceState) {
      errors.push(`engine example ${row.engineFamily}: source identity or state mismatch`);
    }
  }
  if (duplicateValues(rows.map((row) => row.engineFamily)).length > 0) {
    errors.push("engine examples contain duplicate family labels");
  }
  validatePolicy(rows, errors);
  validateScenarioMatrices(rows, scenarios, errors);
  validateEngineLiterals(rows, scenarios, errors);
  const excluded = mappings.find((row) => row.capability === "decode.engine.nscripter");
  if (excluded?.disposition !== "dropped") {
    errors.push("dedicated NScripter support must remain dropped");
  }
  return rows;
}
