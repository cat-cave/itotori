#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { parseFeature } from "./audit-behavior-catalog-gherkin.mjs";
import { auditBehaviorRoadmapCases } from "./audit-behavior-roadmap-cases.mjs";
import {
  computeContractHash,
  lineCount,
  listFiles,
  validateEvidenceRegister,
} from "./audit-behavior-roadmap-contract.mjs";
import {
  buildDependencyGraph,
  expandRoadmap,
  reachableFrom,
  validateCommittedInstances,
} from "./audit-behavior-roadmap-graph.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(here, "..");
const SCRIPT_FILES = [
  "audit-behavior-roadmap-cases.mjs",
  "audit-behavior-roadmap-contract.mjs",
  "audit-behavior-roadmap.mjs",
  "audit-behavior-roadmap-graph.mjs",
  "audit-behavior-roadmap.test.mjs",
];
const CLASSIFICATION_FIELDS = [
  "behavior",
  "variation",
  "applicability",
  "gherkin",
  "capabilityMap",
  "implementation",
  "reason",
  "designFinding",
];
const BUNDLE_FIELDS = [
  "name",
  "scope",
  "behaviors",
  "dependsOn",
  "afterFirstProduction",
  "estimateLines",
  "estimatedFiles",
  "basis",
  "rationale",
  "acceptance",
  "nonGoal",
];
const VARIATIONS = new Set(["engine-invariant", "engine-varying", "profile-varying"]);
const APPLICABILITIES = new Set(["shared", "canonical-engines", "production-targets"]);
const SCOPES = new Set([
  "shared",
  "admitted-production",
  "unqualified-production",
  "non-production",
]);
const ROOT_SPEC = "proof-ledger-and-explicit-failures";
const LINK_LIMIT = 50;
const EXPECTED_EXAMPLE_ROWS = 570;
const DELETED_PLANNING_TOKEN = String.fromCharCode(113, 100);
const NUMBERED_ROADMAP_TOKEN = /\b(?:P|E)\d{2}\b|BP-/u;

function readJsonl(root, relativePath, errors) {
  const path = join(root, relativePath);
  if (!existsSync(path)) {
    errors.push(`${relativePath}: missing required JSONL file`);
    return [];
  }
  const lines = readFileSync(path, "utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const rows = [];
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") {
      errors.push(`${relativePath}:${index + 1}: blank JSONL row`);
      continue;
    }
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      errors.push(`${relativePath}:${index + 1}: invalid JSON: ${error.message}`);
    }
  }
  return rows;
}
function exactFields(row, fields, location, errors) {
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    errors.push(`${location}: row must be a JSON object`);
    return false;
  }
  const actual = Object.keys(row).toSorted();
  const expected = fields.toSorted();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    errors.push(`${location}: fields must be exactly ${fields.join(", ")}`);
    return false;
  }
  return true;
}
function nonemptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function substantive(value) {
  return (
    nonemptyString(value) && value.trim().length >= 40 && value.trim().split(/\s+/u).length >= 6
  );
}

function stringArray(value, allowEmpty = false) {
  return (
    Array.isArray(value) &&
    (allowEmpty || value.length > 0) &&
    value.every((item) => nonemptyString(item))
  );
}

function validateCitation(root, citation, prefix, location, errors) {
  if (typeof citation !== "string") {
    errors.push(`${location}: citation must be a path:line string`);
    return;
  }
  const match = /^(.*):([1-9]\d*)$/u.exec(citation);
  if (!match) {
    errors.push(`${location}: citation must end in a positive line number`);
    return;
  }
  const [, citedPath, lineText] = match;
  if (isAbsolute(citedPath) || citedPath.includes("..") || !citedPath.startsWith(prefix)) {
    errors.push(`${location}: citation path must start with ${prefix}`);
    return;
  }
  const absolute = resolve(root, citedPath);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) {
    errors.push(`${location}: cited file does not exist: ${citedPath}`);
    return;
  }
  const citedLine = Number(lineText);
  const lines = lineCount(readFileSync(absolute, "utf8"));
  if (citedLine > lines) {
    errors.push(`${location}: cited line ${citedLine} exceeds ${citedPath}'s ${lines} lines`);
  }
}

function classifyEngines(engines, errors) {
  const admitted = engines.filter(
    ({ supportRole, profile }) =>
      supportRole === "production-target" &&
      ["registered production profile", "bounded production profile"].includes(profile),
  );
  const unqualified = engines.filter(
    ({ supportRole, profile }) =>
      supportRole === "production-target" && profile === "unqualified target profile",
  );
  const nonProduction = engines.filter(({ supportRole }) => supportRole !== "production-target");
  const counts = [admitted.length, unqualified.length, nonProduction.length];
  if (JSON.stringify(counts) !== JSON.stringify([15, 24, 8])) {
    errors.push(`engine scope counts are ${counts.join("/")}; expected 15/24/8`);
  }
  return new Map([
    ["shared", [null]],
    ["admitted-production", admitted],
    ["unqualified-production", unqualified],
    ["non-production", nonProduction],
  ]);
}

function validateClassifications(root, rows, catalog, errors) {
  const counts = new Map([...VARIATIONS].map((variation) => [variation, 0]));
  const applicabilityCounts = new Map([...APPLICABILITIES].map((value) => [value, 0]));
  for (const [index, row] of rows.entries()) {
    const location = `docs/roadmap/classification.jsonl:${index + 1}`;
    if (!exactFields(row, CLASSIFICATION_FIELDS, location, errors)) continue;
    const expectedBehavior = catalog[index]?.id;
    if (row.behavior !== expectedBehavior) {
      errors.push(`${location}: expected catalog behavior ${expectedBehavior ?? "none"}`);
    }
    if (!VARIATIONS.has(row.variation)) errors.push(`${location}: invalid variation`);
    else counts.set(row.variation, counts.get(row.variation) + 1);
    if (!APPLICABILITIES.has(row.applicability)) errors.push(`${location}: invalid applicability`);
    else applicabilityCounts.set(row.applicability, applicabilityCounts.get(row.applicability) + 1);
    if ((row.variation === "engine-invariant") !== (row.applicability === "shared")) {
      errors.push(`${location}: only engine-invariant behavior may use shared applicability`);
    }
    validateCitation(
      root,
      row.gherkin,
      `docs${sep}behaviors${sep}features${sep}`,
      `${location} gherkin`,
      errors,
    );
    validateCitation(
      root,
      row.capabilityMap,
      `docs${sep}behaviors${sep}capability-map${sep}`,
      `${location} capabilityMap`,
      errors,
    );
    if (!stringArray(row.implementation)) {
      errors.push(`${location}: implementation must be a nonempty citation array`);
    } else {
      for (const [citationIndex, citation] of row.implementation.entries()) {
        validateCitation(
          root,
          citation,
          "",
          `${location} implementation[${citationIndex}]`,
          errors,
        );
        const citedPath = /^(.*):[1-9]\d*$/u.exec(citation)?.[1] ?? "";
        if (
          citedPath === join("docs", "behaviors") ||
          citedPath.startsWith(`docs${sep}behaviors${sep}`)
        ) {
          errors.push(`${location}: implementation citation must be outside docs/behaviors`);
        }
      }
    }
    if (!substantive(row.reason)) errors.push(`${location}: reason is not substantive`);
    if (typeof row.designFinding !== "string") {
      errors.push(`${location}: designFinding must be a string`);
    }
  }
  if (rows.length !== 47) errors.push(`classification has ${rows.length}/47 rows`);
  const actualCounts = [...counts.values()];
  if (JSON.stringify(actualCounts) !== JSON.stringify([31, 11, 5])) {
    errors.push(`classification counts are ${actualCounts.join("/")}; expected 31/11/5`);
  }
  const actualApplicability = [...applicabilityCounts.values()];
  if (JSON.stringify(actualApplicability) !== JSON.stringify([31, 4, 12])) {
    errors.push(`applicability counts are ${actualApplicability.join("/")}; expected 31/4/12`);
  }
  return counts;
}

function validateBundles(rows, catalogIds, errors) {
  const names = new Set();
  for (const [index, row] of rows.entries()) {
    const location = `docs/roadmap/spec-bundles.jsonl:${index + 1}`;
    if (!exactFields(row, BUNDLE_FIELDS, location, errors)) continue;
    if (!nonemptyString(row.name) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(row.name)) {
      errors.push(`${location}: name must be a lowercase hyphenated identifier`);
    } else if (names.has(row.name)) errors.push(`${location}: duplicate bundle ${row.name}`);
    names.add(row.name);
    if (!SCOPES.has(row.scope)) errors.push(`${location}: invalid scope`);
    if (!stringArray(row.behaviors)) errors.push(`${location}: behaviors must be nonempty`);
    else {
      if (new Set(row.behaviors).size !== row.behaviors.length) {
        errors.push(`${location}: duplicate behavior`);
      }
      for (const behavior of row.behaviors) {
        if (!catalogIds.has(behavior)) errors.push(`${location}: unknown behavior ${behavior}`);
      }
    }
    if (!stringArray(row.dependsOn, true)) errors.push(`${location}: dependsOn must be an array`);
    else if (new Set(row.dependsOn).size !== row.dependsOn.length) {
      errors.push(`${location}: duplicate bundle dependency`);
    }
    if (row.afterFirstProduction !== false && !nonemptyString(row.afterFirstProduction)) {
      errors.push(`${location}: afterFirstProduction must be false or a bundle name`);
    }
    if (
      !Number.isInteger(row.estimateLines) ||
      row.estimateLines < 500 ||
      row.estimateLines > 1000
    ) {
      errors.push(`${location}: estimateLines must be an integer from 500 through 1000`);
    }
    if (!Number.isInteger(row.estimatedFiles) || row.estimatedFiles < 3) {
      errors.push(`${location}: estimatedFiles must be an integer of at least 3`);
    }
    for (const field of ["basis", "rationale", "acceptance", "nonGoal"]) {
      if (!nonemptyString(row[field])) errors.push(`${location}: ${field} must be nonempty`);
    }
  }
  if (rows.length !== 26) errors.push(`bundle definitions have ${rows.length}/26 rows`);
  return names;
}

function validateGherkin(root, catalog, errors) {
  const featureDir = join(root, "docs", "behaviors", "features");
  if (!existsSync(featureDir)) {
    errors.push("docs/behaviors/features: missing feature directory");
    return { outlines: 0, rows: 0 };
  }
  const parseErrors = [];
  const scenarios = readdirSync(featureDir)
    .filter((name) => name.endsWith(".feature"))
    .sort()
    .flatMap((name) => parseFeature(join(featureDir, name), parseErrors));
  errors.push(...parseErrors);
  const counts = new Map();
  for (const scenario of scenarios) counts.set(scenario.id, (counts.get(scenario.id) ?? 0) + 1);
  for (const { id } of catalog) {
    if ((counts.get(id) ?? 0) !== 1) {
      errors.push(`expected one Gherkin outline for ${id}, found ${counts.get(id) ?? 0}`);
    }
  }
  for (const id of counts.keys()) {
    if (!catalog.some((row) => row.id === id)) errors.push(`unknown Gherkin behavior ${id}`);
  }
  const rows = scenarios.reduce((total, scenario) => total + scenario.exampleRows.length, 0);
  if (scenarios.length !== 47 || rows !== EXPECTED_EXAMPLE_ROWS) {
    errors.push(
      `Gherkin identity is ${scenarios.length}/47 outlines and ${rows}/570 Examples rows`,
    );
  }
  return { outlines: scenarios.length, rows };
}

function validateFileRules(root, errors) {
  const roadmapDir = join(root, "docs", "roadmap");
  for (const file of listFiles(roadmapDir)) {
    const contents = readFileSync(join(roadmapDir, file), "utf8");
    const count = lineCount(contents);
    if (count > 500) errors.push(`docs/roadmap/${file}: ${count} lines exceeds the 500-line cap`);
    if (NUMBERED_ROADMAP_TOKEN.test(contents)) {
      errors.push(`docs/roadmap/${file}: contains a forbidden numbered roadmap token`);
    }
    const tokenPattern = new RegExp(`\\b${DELETED_PLANNING_TOKEN}\\b`, "iu");
    if (tokenPattern.test(contents)) {
      errors.push(`docs/roadmap/${file}: contains the forbidden planning-tool token`);
    }
  }
  for (const file of SCRIPT_FILES) {
    const path = join(root, "scripts", file);
    if (!existsSync(path)) {
      errors.push(`scripts/${file}: missing validator source`);
      continue;
    }
    const count = lineCount(readFileSync(path, "utf8"));
    if (count > 500) errors.push(`scripts/${file}: ${count} lines exceeds the 500-line cap`);
  }
}

export function validateRoadmap(root = defaultRoot) {
  const errors = [];
  const catalog = readJsonl(root, join("docs", "behaviors", "catalog.jsonl"), errors);
  const engines = readJsonl(root, join("docs", "behaviors", "engine-families.jsonl"), errors);
  const classifications = readJsonl(root, join("docs", "roadmap", "classification.jsonl"), errors);
  const bundles = readJsonl(root, join("docs", "roadmap", "spec-bundles.jsonl"), errors);
  const committedInstances = readJsonl(
    root,
    join("docs", "roadmap", "spec-instances.jsonl"),
    errors,
  );
  if (catalog.length !== 47) errors.push(`behavior catalog has ${catalog.length}/47 rows`);
  if (engines.length !== 47) errors.push(`engine registry has ${engines.length}/47 rows`);

  const classCounts = validateClassifications(root, classifications, catalog, errors);
  const bundleNames = validateBundles(bundles, new Set(catalog.map(({ id }) => id)), errors);
  for (const [index, bundle] of bundles.entries()) {
    if (!bundle || typeof bundle !== "object") continue;
    for (const dependency of Array.isArray(bundle.dependsOn) ? bundle.dependsOn : []) {
      if (!bundleNames.has(dependency)) {
        errors.push(
          `docs/roadmap/spec-bundles.jsonl:${index + 1}: unknown dependency ${dependency}`,
        );
      }
    }
    if (bundle.afterFirstProduction !== false && !bundleNames.has(bundle.afterFirstProduction)) {
      errors.push(
        `docs/roadmap/spec-bundles.jsonl:${index + 1}: unknown afterFirstProduction bundle`,
      );
    }
  }

  const scopeEngines = classifyEngines(engines, errors);
  const { instances: generatedInstances, cells } = expandRoadmap(
    bundles,
    classifications,
    scopeEngines,
    engines,
    errors,
  );
  if (cells.length !== 687) errors.push(`classification expands to ${cells.length}/687 cells`);
  if (generatedInstances.length !== 241) {
    errors.push(`bundle definitions expand to ${generatedInstances.length}/241 specs`);
  }
  validateCommittedInstances(committedInstances, generatedInstances, exactFields, errors);

  const graph = buildDependencyGraph(generatedInstances);
  errors.push(...graph.errors);
  if (!graph.acyclic) errors.push("expanded dependency graph contains a cycle");
  if (graph.redundantEdges.length > 0) {
    const [blocker, blocked] = graph.redundantEdges[0];
    errors.push(
      `expanded dependency graph has ${graph.redundantEdges.length} redundant edges; ${blocker} → ${blocked}`,
    );
  }
  if (graph.roots.length !== 1 || graph.roots[0] !== ROOT_SPEC) {
    errors.push(`expanded dependency graph roots are ${graph.roots.join(", ") || "none"}`);
  }
  const reachable = reachableFrom(graph, ROOT_SPEC);
  if (reachable.size !== graph.nodes.size) {
    errors.push(`${ROOT_SPEC} reaches ${reachable.size}/${graph.nodes.size} specs`);
  }
  if (graph.maxOutgoing > LINK_LIMIT || graph.maxIncoming > LINK_LIMIT) {
    errors.push(
      `native dependency limit exceeded: ${graph.maxOutgoing} outgoing, ${graph.maxIncoming} incoming`,
    );
  }

  const gherkin = validateGherkin(root, catalog, errors);
  const cases = auditBehaviorRoadmapCases(root);
  errors.push(...cases.errors);
  const evidence = validateEvidenceRegister(root, cells, engines, errors);
  validateFileRules(root, errors);
  const contractHash = computeContractHash(root, errors);
  const hashPath = join(root, "docs", "roadmap", "roadmap-contract.sha256");
  if (!existsSync(hashPath))
    errors.push("docs/roadmap/roadmap-contract.sha256: missing contract hash");
  else {
    const expectedHash = readFileSync(hashPath, "utf8").trim();
    if (!/^[a-f0-9]{64}$/u.test(expectedHash)) {
      errors.push("roadmap-contract.sha256 must contain one lowercase SHA-256");
    } else if (contractHash !== expectedHash) {
      errors.push(`roadmap contract hash changed: ${contractHash}`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    summary: {
      behaviors: catalog.length,
      engines: engines.length,
      engineInvariant: classCounts.get("engine-invariant") ?? 0,
      engineVarying: classCounts.get("engine-varying") ?? 0,
      profileVarying: classCounts.get("profile-varying") ?? 0,
      cells: cells.length,
      bundleDefinitions: bundles.length,
      specs: generatedInstances.length,
      relationships: graph.relationships,
      graphRoots: graph.roots.length,
      reachableSpecs: reachable.size,
      graphAcyclic: graph.acyclic,
      maxOutgoingLinks: graph.maxOutgoing,
      maxIncomingLinks: graph.maxIncoming,
      gherkinOutlines: gherkin.outlines,
      gherkinRows: gherkin.rows,
      selectedCases: cases.selectedCases,
      partialSelectedCases: cases.partialCases,
      evidenceEntries: evidence.entries,
    },
  };
}

export function formatRoadmapResult(result) {
  if (!result.ok) {
    return `Behavior roadmap audit failed:\n${result.errors
      .map((error) => `- ${error}`)
      .join("\n")}`;
  }
  const summary = result.summary;
  return (
    `Behavior roadmap audit: ${summary.behaviors} behaviors and ${summary.engines} engines; ` +
    `${summary.engineInvariant}/${summary.engineVarying}/${summary.profileVarying} classification; ` +
    `${summary.cells} cells owned by ${summary.bundleDefinitions} bundles and ${summary.specs} specs; ` +
    `${summary.selectedCases} selected cases with ${summary.evidenceEntries} owned observations; ` +
    `${summary.relationships} transitively reduced relationships, sole root, full reachability; ` +
    `maximum native links ${summary.maxOutgoingLinks} outgoing/${summary.maxIncomingLinks} incoming.`
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--print-contract-hash")) {
    const errors = [];
    const hash = computeContractHash(defaultRoot, errors);
    if (hash) console.log(hash);
    else {
      console.error(errors.join("\n"));
      process.exitCode = 1;
    }
  } else {
    const result = validateRoadmap();
    (result.ok ? console.log : console.error)(formatRoadmapResult(result));
    if (!result.ok) process.exitCode = 1;
  }
}
