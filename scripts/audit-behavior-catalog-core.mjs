import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { validateEngineFamilies } from "./audit-behavior-catalog-engines.mjs";
import { namesImplementationInternal, parseFeature } from "./audit-behavior-catalog-gherkin.mjs";
import { validateHumanViews } from "./audit-behavior-catalog-human.mjs";

export const EXPECTED_SOURCE_HASH =
  "e2c30430ed92f2888e8b30b1f42d60ba6c72a33dc74e9ef63a5f89e303595535";
export const EXPECTED_TOTAL = 582;
export const LINE_LIMIT = 500;

const SUBSYSTEMS = ["decode", "runtime", "localization", "quality", "product", "platform"];
const SOURCE_COUNTS = {
  decode: 150,
  runtime: 72,
  localization: 109,
  quality: 83,
  product: 95,
  platform: 73,
};
const SOURCE_STATE_COUNTS = {
  "proven-real": 25,
  "proven-synthetic": 190,
  built: 219,
  asserted: 38,
  intended: 94,
  dropped: 16,
};
const DISPOSITION_COUNTS = {
  dropped: 58,
  folded: 188,
  merged: 190,
  split: 146,
};
const STATE_STRENGTH = {
  intended: 0,
  asserted: 1,
  built: 2,
  "proven-synthetic": 3,
  "proven-real": 4,
};
const CATALOG_KEYS = [
  "boundaries",
  "feature",
  "id",
  "parameters",
  "personas",
  "portabilityTest",
  "state",
  "title",
];
const SOURCE_KEYS = ["a", "c", "e", "m", "s", "st"];
const OBSERVABLE_BOUNDARIES = new Set([
  "artifact-reference",
  "billing-record",
  "command",
  "content-free-receipt",
  "http",
  "identity-provider",
  "installation-package",
  "persisted-record",
  "produced-artifact",
  "produced-bytes",
  "provider-receipt",
  "recorded-input",
  "rendered-interface",
  "runtime-observation",
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

function countLines(contents) {
  if (contents.length === 0) return 0;
  const pieces = contents.split(/\r?\n/u);
  return pieces.length - (pieces.at(-1) === "" ? 1 : 0);
}

function listFilesRecursively(root) {
  if (!existsSync(root)) return [];
  const files = [];
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) files.push(...listFilesRecursively(path));
    else files.push(path);
  }
  return files;
}

function readJsonl(path, errors) {
  if (!existsSync(path)) {
    errors.push(`missing JSONL file: ${path}`);
    return [];
  }
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

function validateSources(root, errors) {
  const sourceRoot = join(root, "docs", "behaviors", "source-inventory");
  const sources = [];
  for (const subsystem of SUBSYSTEMS) {
    const rows = readJsonl(join(sourceRoot, `${subsystem}.jsonl`), errors);
    if (rows.length !== SOURCE_COUNTS[subsystem]) {
      errors.push(
        `source ${subsystem}: expected ${SOURCE_COUNTS[subsystem]}, found ${rows.length}`,
      );
    }
    for (const row of rows) {
      if (!sameStrings(Object.keys(row), SOURCE_KEYS)) {
        errors.push(`source ${row.c ?? subsystem}: expected keys ${SOURCE_KEYS.join(", ")}`);
      }
      if (row.s !== subsystem || !SUBSYSTEMS.includes(row.s)) {
        errors.push(`source ${row.c ?? "<unknown>"}: subsystem does not match ${subsystem}`);
      }
      for (const key of SOURCE_KEYS) {
        if (typeof row[key] !== "string")
          errors.push(`source ${row.c ?? "<unknown>"}: ${key} not string`);
      }
      if (!row.c || !row.m || !row.a)
        errors.push(`source ${row.c ?? "<unknown>"}: empty identity text`);
      const proven = row.st === "proven-real" || row.st === "proven-synthetic";
      if (proven !== Boolean(row.e?.trim())) {
        errors.push(`source ${row.c}: evidence population contradicts ${row.st}`);
      }
    }
    sources.push(...rows);
  }
  if (sources.length !== EXPECTED_TOTAL) {
    errors.push(`source coverage: ${sources.length}/${EXPECTED_TOTAL} capabilities`);
  }
  const duplicateIds = duplicateValues(sources.map((row) => row.c));
  if (duplicateIds.length > 0)
    errors.push(`duplicate source capabilities: ${duplicateIds.join(", ")}`);
  const canonical = stableStringify(
    [...sources].sort((left, right) => left.c.localeCompare(right.c)),
  );
  const hash = createHash("sha256").update(`${canonical}\n`).digest("hex");
  if (hash !== EXPECTED_SOURCE_HASH)
    errors.push(`source inventory hash ${hash} != ${EXPECTED_SOURCE_HASH}`);
  const stateCounts = Object.fromEntries(
    Object.keys(SOURCE_STATE_COUNTS).map((state) => [state, 0]),
  );
  for (const source of sources) stateCounts[source.st] = (stateCounts[source.st] ?? 0) + 1;
  for (const [state, expected] of Object.entries(SOURCE_STATE_COUNTS)) {
    if (stateCounts[state] !== expected) {
      errors.push(`source state ${state}: expected ${expected}, found ${stateCounts[state]}`);
    }
  }
  return sources;
}

function validateMappings(root, sources, behaviorIds, errors) {
  const mappingRoot = join(root, "docs", "behaviors", "capability-map");
  const mappings = [];
  const sourceById = new Map(sources.map((source) => [source.c, source]));
  for (const subsystem of SUBSYSTEMS) {
    const rows = readJsonl(join(mappingRoot, `${subsystem}.jsonl`), errors);
    const expected = sources.filter((source) => source.s === subsystem);
    if (rows.length !== expected.length) {
      errors.push(`mapping ${subsystem}: ${rows.length}/${expected.length} capabilities`);
    }
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const source = sourceById.get(row.capability);
      if (!source)
        errors.push(`mapping ${row.capability ?? "<unknown>"}: capability is not in source`);
      if (expected[index] && row.capability !== expected[index].c) {
        errors.push(
          `mapping ${subsystem}:${index + 1}: expected ${expected[index].c}, found ${row.capability}`,
        );
      }
      if (source && row.sourceState !== source.st) {
        errors.push(`mapping ${row.capability}: sourceState ${row.sourceState} != ${source.st}`);
      }
      validateMappingShape(row, behaviorIds, errors);
      if (source?.st === "dropped" && row.disposition !== "dropped") {
        errors.push(`mapping ${row.capability}: source-dropped capability must remain dropped`);
      }
    }
    mappings.push(...rows);
  }
  const mappedIds = mappings.map((row) => row.capability);
  if (mappings.length !== EXPECTED_TOTAL) {
    errors.push(`mapping coverage: ${mappings.length}/${EXPECTED_TOTAL} capabilities`);
  }
  const duplicates = duplicateValues(mappedIds);
  if (duplicates.length > 0) errors.push(`duplicate mapped capabilities: ${duplicates.join(", ")}`);
  const missing = sources.map((source) => source.c).filter((id) => !mappedIds.includes(id));
  if (missing.length > 0) errors.push(`missing mapped capabilities: ${missing.join(", ")}`);
  return mappings;
}

function validateMappingShape(row, behaviorIds, errors) {
  const allowed = new Set(["folded", "merged", "split", "dropped"]);
  if (!allowed.has(row.disposition)) {
    errors.push(`mapping ${row.capability}: invalid disposition ${row.disposition}`);
    return;
  }
  const expectedKeys = ["capability", "disposition", "sourceState"];
  if (row.disposition !== "dropped") expectedKeys.push("behaviors");
  if (row.disposition !== "folded") expectedKeys.push("reason");
  if (!sameStrings(Object.keys(row), expectedKeys)) {
    errors.push(`mapping ${row.capability}: fields do not match ${row.disposition} shape`);
  }
  const hasReason = typeof row.reason === "string" && row.reason.trim().length >= 20;
  const refs = Array.isArray(row.behaviors) ? row.behaviors : [];
  if (row.disposition === "dropped") {
    if ("behaviors" in row || !hasReason) {
      errors.push(`mapping ${row.capability}: dropped needs a reason and no behavior`);
    }
    return;
  }
  if (refs.length === 0 || duplicateValues(refs).length > 0) {
    errors.push(`mapping ${row.capability}: behavior references must be nonempty and unique`);
  }
  if (row.disposition !== "split" && refs.length !== 1) {
    errors.push(`mapping ${row.capability}: multiple behaviors require split disposition`);
  }
  if (row.disposition === "folded" && "reason" in row) {
    errors.push(`mapping ${row.capability}: direct fold must omit reason`);
  }
  if ((row.disposition === "merged" || row.disposition === "split") && !hasReason) {
    errors.push(`mapping ${row.capability}: ${row.disposition} needs a reason`);
  }
  if (row.disposition === "split" && refs.length < 2) {
    errors.push(`mapping ${row.capability}: split needs at least two behaviors`);
  }
  for (const behavior of refs) {
    if (!behaviorIds.has(behavior))
      errors.push(`mapping ${row.capability}: unknown behavior ${behavior}`);
  }
}

function validateCatalogAndFeatures(root, mappings, errors) {
  const behaviorRoot = join(root, "docs", "behaviors");
  const catalog = readJsonl(join(behaviorRoot, "catalog.jsonl"), errors);
  const behaviorIds = new Set(catalog.map((behavior) => behavior.id));
  const duplicates = duplicateValues(catalog.map((behavior) => behavior.id));
  if (duplicates.length > 0) errors.push(`duplicate behaviors: ${duplicates.join(", ")}`);
  const personaText = readFileSync(join(behaviorRoot, "personas.md"), "utf8");
  const personaIds = [...personaText.matchAll(/<!-- persona-id: ([a-z0-9-]+) -->/gu)].map(
    (match) => match[1],
  );
  if (personaIds.length !== 8 || duplicateValues(personaIds).length > 0) {
    errors.push(`personas: expected 8 unique persona ids, found ${personaIds.length}`);
  }
  for (const [index, persona] of personaIds.entries()) {
    const start = personaText.indexOf(`<!-- persona-id: ${persona} -->`);
    const end =
      index + 1 < personaIds.length
        ? personaText.indexOf(`<!-- persona-id: ${personaIds[index + 1]} -->`)
        : personaText.indexOf("## Persona filter");
    const section = personaText.slice(start, end);
    for (const label of ["**Wants:**", "**Never wants to think about:**", "**Done means:**"]) {
      if (!section.includes(label)) errors.push(`persona ${persona}: missing ${label}`);
    }
  }
  const scenarios = [];
  const featureRoot = join(behaviorRoot, "features");
  for (const path of listFilesRecursively(featureRoot).filter((item) =>
    item.endsWith(".feature"),
  )) {
    scenarios.push(...parseFeature(path, errors));
  }
  const scenarioDuplicates = duplicateValues(scenarios.map((scenario) => scenario.id));
  if (scenarioDuplicates.length > 0)
    errors.push(`duplicate behavior scenarios: ${scenarioDuplicates.join(", ")}`);
  const mappedRefs = new Set(mappings.flatMap((row) => row.behaviors ?? []));
  for (const behavior of catalog) {
    if (!sameStrings(Object.keys(behavior), CATALOG_KEYS)) {
      errors.push(`behavior ${behavior.id}: unexpected catalog fields`);
    }
    if (!Array.isArray(behavior.personas) || behavior.personas.length === 0) {
      errors.push(`behavior ${behavior.id}: at least one persona is required`);
    } else {
      for (const persona of behavior.personas) {
        if (!personaIds.includes(persona))
          errors.push(`behavior ${behavior.id}: unknown persona ${persona}`);
      }
    }
    if (!Array.isArray(behavior.boundaries) || behavior.boundaries.length === 0) {
      errors.push(`behavior ${behavior.id}: observable boundaries are required`);
    } else if (
      duplicateValues(behavior.boundaries).length > 0 ||
      behavior.boundaries.some((boundary) => !OBSERVABLE_BOUNDARIES.has(boundary))
    ) {
      errors.push(`behavior ${behavior.id}: boundaries must use unique observable values`);
    }
    if (typeof behavior.portabilityTest !== "string" || behavior.portabilityTest.length < 80) {
      errors.push(`behavior ${behavior.id}: portability test is missing or too vague`);
    }
    if (namesImplementationInternal(behavior.title)) {
      errors.push(`behavior ${behavior.id}: title names implementation internals`);
    }
    if (namesImplementationInternal(behavior.portabilityTest)) {
      errors.push(`behavior ${behavior.id}: portability test names implementation internals`);
    }
    if (!mappedRefs.has(behavior.id))
      errors.push(`behavior ${behavior.id}: no capability contributes`);
    const scenario = scenarios.find((candidate) => candidate.id === behavior.id);
    if (!scenario) {
      errors.push(`behavior ${behavior.id}: no Scenario Outline`);
      continue;
    }
    const expectedPath = join(behaviorRoot, behavior.feature);
    if (scenario.path !== expectedPath)
      errors.push(`behavior ${behavior.id}: feature path mismatch`);
    if (scenario.title !== behavior.title)
      errors.push(`behavior ${behavior.id}: scenario title mismatch`);
    if (!sameStrings(scenario.columns, behavior.parameters)) {
      errors.push(`behavior ${behavior.id}: catalog parameters do not match Examples columns`);
    }
    if (!sameStrings(scenario.placeholders, scenario.columns)) {
      errors.push(`behavior ${behavior.id}: placeholders must exactly match Examples columns`);
    }
    const keywords = new Set(scenario.steps.map((step) => step.keyword));
    for (const keyword of ["Given", "When", "Then"]) {
      if (!keywords.has(keyword))
        errors.push(`behavior ${behavior.id}: missing observable ${keyword} step`);
    }
    for (const step of scenario.steps) {
      if (namesImplementationInternal(step.text)) {
        errors.push(
          `${scenario.path}:${step.line}: ${behavior.id} step names implementation internals`,
        );
      }
    }
  }
  const scenarioIds = new Set(scenarios.map((scenario) => scenario.id));
  for (const id of scenarioIds)
    if (!behaviorIds.has(id)) errors.push(`scenario ${id}: no catalog behavior`);
  const usedPersonas = new Set(catalog.flatMap((behavior) => behavior.personas ?? []));
  for (const persona of personaIds)
    if (!usedPersonas.has(persona)) errors.push(`persona ${persona}: no behavior`);
  return { catalog, behaviorIds, personaIds, scenarios };
}

function validateStates(catalog, mappings, errors) {
  const contributions = new Map(catalog.map((behavior) => [behavior.id, []]));
  for (const row of mappings) {
    for (const behavior of row.behaviors ?? []) contributions.get(behavior)?.push(row.sourceState);
  }
  for (const behavior of catalog) {
    const states = contributions.get(behavior.id) ?? [];
    if (states.length === 0) continue;
    const weakest = states.reduce((left, right) =>
      STATE_STRENGTH[left] <= STATE_STRENGTH[right] ? left : right,
    );
    if (behavior.state !== weakest) {
      errors.push(
        `behavior ${behavior.id}: state ${behavior.state} is stronger than derived ${weakest}`,
      );
    }
  }
}

function validateLineCaps(root, errors) {
  const behaviorRoot = join(root, "docs", "behaviors");
  const files = listFilesRecursively(behaviorRoot);
  for (const path of files) {
    const lines = countLines(readFileSync(path, "utf8"));
    if (lines > LINE_LIMIT) {
      errors.push(
        `${relative(root, path)}: ${lines} lines exceeds absolute ${LINE_LIMIT}-line cap`,
      );
    }
  }
  return files.length;
}

export function validateBehaviorCatalog(root) {
  const errors = [];
  const placeholderCatalog = readJsonl(join(root, "docs", "behaviors", "catalog.jsonl"), errors);
  const behaviorIds = new Set(placeholderCatalog.map((behavior) => behavior.id));
  const sources = validateSources(root, errors);
  const mappings = validateMappings(root, sources, behaviorIds, errors);
  const parsed = validateCatalogAndFeatures(root, mappings, errors);
  const engines = validateEngineFamilies(root, sources, mappings, parsed.scenarios, errors);
  validateHumanViews(root, sources, mappings, errors);
  validateStates(parsed.catalog, mappings, errors);
  const behaviorFiles = validateLineCaps(root, errors);
  const dispositions = {};
  for (const row of mappings)
    dispositions[row.disposition] = (dispositions[row.disposition] ?? 0) + 1;
  for (const [disposition, expected] of Object.entries(DISPOSITION_COUNTS)) {
    const actual = dispositions[disposition] ?? 0;
    if (actual !== expected) {
      errors.push(`disposition ${disposition}: expected ${expected}, found ${actual}`);
    }
  }
  const behaviorStates = {};
  for (const behavior of parsed.catalog) {
    behaviorStates[behavior.state] = (behaviorStates[behavior.state] ?? 0) + 1;
  }
  return {
    ok: errors.length === 0,
    errors,
    summary: {
      sources: sources.length,
      mappings: mappings.length,
      behaviors: parsed.catalog.length,
      personas: parsed.personaIds.length,
      engineFamilies: engines.length,
      behaviorFiles,
      dispositions,
      behaviorStates,
    },
  };
}

export function formatBehaviorCatalogResult(result) {
  const summary = result.summary;
  if (!result.ok) {
    return [
      `behavior catalog audit: FAILED with ${result.errors.length} violation(s).`,
      ...result.errors.map((error) => `  - ${error}`),
    ].join("\n");
  }
  const dispositions = Object.entries(summary.dispositions)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, count]) => `${name}=${count}`)
    .join(", ");
  const states = Object.entries(summary.behaviorStates)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, count]) => `${name}=${count}`)
    .join(", ");
  return [
    `behavior catalog audit: passed. ${summary.mappings}/${EXPECTED_TOTAL} capabilities -> ` +
      `${summary.behaviors} portable behaviors for ${summary.personas} personas.`,
    `engine slots: ${summary.engineFamilies}; dispositions: ${dispositions}.`,
    `weakest behavior states: ${states}.`,
    `line cap: ${summary.behaviorFiles} behavior files are <= ${LINE_LIMIT} lines.`,
  ].join("\n");
}
