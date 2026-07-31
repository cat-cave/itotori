#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseFeature } from "./audit-behavior-catalog-gherkin.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(here, "..");
const EXPECTED_OUTLINES = 47;
const EXPECTED_AUTHORED_CASES = 570;
const EXPECTED_SELECTED_CASES = 3_400;
const EXPECTED_PARTIAL_CASES = 2_940;

const FULL_CANONICAL = new Set([
  "support.qualify-profile",
  "content.extract-complete-scope",
  "patch.produce-safe-output",
  "play.launch-patched-content",
]);

const repeat = (value, count) => Array.from({ length: count }, () => value);
const canonical = (sourceCapability) => `canonical:${sourceCapability}`;
const PARTIAL_RULES = new Map([
  [
    "source.prepare-owned-content",
    ["native", "plain", "native", ...repeat("production", 4), "mixed"],
  ],
  ["run.localize-complete-scope", ["native", "web", ...repeat("production", 9)]],
  ["journey.localize-owned-release", ["native", "web", ...repeat("production", 3)]],
  [
    "play.control-reproducible-session",
    [
      "native",
      "web",
      ...repeat("production", 5),
      canonical("decode.engine.softpal"),
      canonical("decode.engine.kirikiri-kag-xp3"),
    ],
  ],
  ["play.explore-routes", ["native", "web"]],
  [
    "play.observe-localized-surfaces",
    [
      "native",
      "web",
      "production",
      ...repeat("native", 5),
      ...repeat("production", 3),
      canonical("decode.engine.softpal"),
      canonical("decode.engine.rpg-maker-mv-mz"),
      canonical("decode.engine.rpg-maker-vx-ace-rgss3"),
      canonical("decode.engine.kirikiri-kag-xp3"),
      canonical("decode.engine.renpy"),
      canonical("decode.engine.wolf-rpg-editor"),
      canonical("decode.engine.bgi-ethornell"),
      canonical("decode.engine.unity-i2"),
      canonical("decode.engine.unity-naninovel"),
    ],
  ],
  ["evidence.capture-runtime-observation", ["native", "web", ...repeat("production", 5)]],
  ["evidence.publish-safe-runtime-proof", repeat("shared", 2)],
  ["quality.untrusted-inputs-fail-without-harm", repeat("production", 12)],
  ["quality.output-completeness-is-reported", repeat("production", 3)],
  [
    "quality.same-inputs-reproduce-equivalent-results",
    ["native", "web", ...repeat("production", 4)],
  ],
  ["review.play-exact-patch", repeat("production", 9)],
  ["export.download-played-patch", ["native", "web", "production"]],
  ["evaluation.compare-contestants", repeat("shared", 13)],
]);
const SHARED_ENGINE_VALUES = new Map([
  ["evidence.publish-safe-runtime-proof", ["registered native family", "registered web family"]],
  [
    "evaluation.compare-contestants",
    ["MAGES benchmark reference", ...repeat("registered production family", 12)],
  ],
]);

const WEB = new Set([
  "decode.engine.rpg-maker-mv-mz",
  "decode.engine.renpy",
  "decode.engine.tyranoscript",
  "decode.engine.unity-i2",
  "decode.engine.unity-naninovel",
]);
const WEB_ONLY = new Set([
  "decode.engine.rpg-maker-mv-mz",
  "decode.engine.tyranoscript",
  "decode.engine.unity-i2",
  "decode.engine.unity-naninovel",
]);
const PLAIN = new Set([
  "decode.engine.softpal",
  "decode.engine.nexas",
  "decode.engine.rpg-maker-mv-mz",
  "decode.engine.kirikiri-kag-xp3",
  "decode.engine.renpy",
  "decode.engine.bgi-ethornell",
  "decode.engine.tyranoscript",
  "decode.engine.unity-i2",
  "decode.engine.unity-naninovel",
]);

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

function actualSelector(row, enginesByName, errors, location, shared) {
  if (shared) return "shared";
  const value = row.engine_family;
  const generic = new Map([
    ["registered family", "production"],
    ["registered production family", "production"],
    ["registered native family", "native"],
    ["registered web family", "web"],
    ["registered plain family", "plain"],
    ["mixed registered families", "mixed"],
  ]);
  if (generic.has(value)) return generic.get(value);
  const engine = enginesByName.get(value);
  if (!engine) {
    errors.push(`${location}: unknown literal engine family ${JSON.stringify(value)}`);
    return "unknown";
  }
  if (engine.supportRole !== "production-target") {
    errors.push(`${location}: literal ${value} is not a production target`);
  }
  return canonical(engine.sourceCapability);
}

function validateComparisonInputs(id, row, location, errors) {
  if (id === "quality.same-inputs-reproduce-equivalent-results" && !row.comparison_source) {
    errors.push(`${location}: comparison_source must remain comparison evidence`);
  }
  if (id === "evidence.capture-runtime-observation" && !row.producer_class) {
    errors.push(`${location}: producer_class must remain producer/comparison evidence`);
  }
  if (id === "evaluation.compare-contestants" && !row.contestant_set) {
    errors.push(`${location}: contestant_set must remain comparison evidence`);
  }
}

function selectorSize(selector, counts) {
  if (selector === "production" || selector === "mixed") return counts.production;
  if (selector === "native") return counts.native;
  if (selector === "web") return counts.web;
  if (selector === "plain") return counts.plain;
  if (selector === "shared" || selector.startsWith("canonical:")) return 1;
  return 0;
}

export function auditBehaviorRoadmapCases(root = defaultRoot) {
  const errors = [];
  const registryPath = join(root, "docs", "behaviors", "engine-families.jsonl");
  const engines = readJsonl(registryPath, "docs/behaviors/engine-families.jsonl", errors);
  const enginesByName = new Map();
  const enginesByCapability = new Map();
  for (const [index, engine] of engines.entries()) {
    const location = `docs/behaviors/engine-families.jsonl:${index + 1}`;
    if (enginesByName.has(engine.engineFamily)) {
      errors.push(`${location}: duplicate engineFamily ${engine.engineFamily}`);
    }
    if (enginesByCapability.has(engine.sourceCapability)) {
      errors.push(`${location}: duplicate sourceCapability ${engine.sourceCapability}`);
    }
    enginesByName.set(engine.engineFamily, engine);
    enginesByCapability.set(engine.sourceCapability, engine);
  }
  const production = engines.filter(({ supportRole }) => supportRole === "production-target");
  const native = production.filter(({ sourceCapability }) => !WEB_ONLY.has(sourceCapability));
  const counts = {
    production: production.length,
    native: native.length,
    web: WEB.size,
    plain: PLAIN.size,
  };
  if (engines.length !== 47)
    errors.push(`canonical engine count is ${engines.length}; expected 47`);
  if (counts.production !== 39) {
    errors.push(`production engine count is ${counts.production}; expected 39`);
  }
  if (counts.native !== 35 || counts.web !== 5 || counts.plain !== 9) {
    errors.push(
      `trait counts are native=${counts.native}, web=${counts.web}, plain=${counts.plain}; expected 35/5/9`,
    );
  }
  for (const [trait, members] of [
    ["web", WEB],
    ["plain", PLAIN],
  ]) {
    for (const capability of members) {
      const engine = enginesByCapability.get(capability);
      if (!engine || engine.supportRole !== "production-target") {
        errors.push(`${trait} trait member ${capability} is not a production registry row`);
      }
    }
  }

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
  const scenarioIds = new Set();
  let authoredCases = 0;
  let selectedCases = 0;
  let partialCases = 0;
  for (const scenario of scenarios) {
    if (scenarioIds.has(scenario.id)) errors.push(`${scenario.id}: duplicate outline`);
    scenarioIds.add(scenario.id);
    authoredCases += scenario.exampleRows.length;
    const expected = PARTIAL_RULES.get(scenario.id);
    if (expected) {
      if (scenario.exampleRows.length !== expected.length) {
        errors.push(
          `${scenario.id}: has ${scenario.exampleRows.length} authored rows; expected ${expected.length}`,
        );
      }
      const shared = expected.every((selector) => selector === "shared");
      for (const [index, row] of scenario.exampleRows.entries()) {
        const location = `${scenario.id} Examples row ${index + 1}`;
        const actual = actualSelector(row, enginesByName, errors, location, shared);
        if (actual !== expected[index]) {
          errors.push(`${location}: selector is ${actual}; expected ${expected[index]}`);
        }
        const expectedEngineValue = SHARED_ENGINE_VALUES.get(scenario.id)?.[index];
        if (expectedEngineValue && row.engine_family !== expectedEngineValue) {
          errors.push(
            `${location}: shared engine-shaped value is ${JSON.stringify(
              row.engine_family,
            )}; expected ${JSON.stringify(expectedEngineValue)}`,
          );
        }
        validateComparisonInputs(scenario.id, row, location, errors);
        const selected = selectorSize(actual, counts);
        selectedCases += selected;
        partialCases += selected;
      }
      continue;
    }
    if (FULL_CANONICAL.has(scenario.id)) {
      const selectedNames = scenario.exampleRows.map(({ engine_family }) => engine_family);
      if (
        selectedNames.length !== engines.length ||
        new Set(selectedNames).size !== engines.length ||
        selectedNames.some((name) => !enginesByName.has(name))
      ) {
        errors.push(`${scenario.id}: full-canonical rows must select every registry row once`);
      }
    }
    selectedCases += scenario.exampleRows.length;
  }
  for (const id of PARTIAL_RULES.keys()) {
    if (!scenarioIds.has(id)) errors.push(`${id}: missing partial outline`);
  }
  for (const id of FULL_CANONICAL) {
    if (!scenarioIds.has(id)) errors.push(`${id}: missing full-canonical outline`);
  }
  if (scenarios.length !== EXPECTED_OUTLINES) {
    errors.push(`Gherkin outline count is ${scenarios.length}; expected ${EXPECTED_OUTLINES}`);
  }
  if (authoredCases !== EXPECTED_AUTHORED_CASES) {
    errors.push(`authored case count is ${authoredCases}; expected ${EXPECTED_AUTHORED_CASES}`);
  }
  if (PARTIAL_RULES.size !== 14) {
    errors.push(`partial rule count is ${PARTIAL_RULES.size}; expected 14`);
  }
  if (partialCases !== EXPECTED_PARTIAL_CASES) {
    errors.push(
      `partial selected case count is ${partialCases}; expected ${EXPECTED_PARTIAL_CASES}`,
    );
  }
  if (selectedCases !== EXPECTED_SELECTED_CASES) {
    errors.push(`selected case count is ${selectedCases}; expected ${EXPECTED_SELECTED_CASES}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    selectedCases,
    partialCases,
    authoredCases,
    outlines: scenarios.length,
    canonicalEngines: engines.length,
    productionEngines: counts.production,
    nativeEngines: counts.native,
    webEngines: counts.web,
    plainEngines: counts.plain,
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
