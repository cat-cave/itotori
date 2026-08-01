import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

import { loadSources } from "@cucumber/cucumber/api";

import { parseFeature } from "../audit-behavior-catalog-gherkin.mjs";
import { buildBehaviorCaseSelection } from "../behavior-case-selection.mjs";
import { rootLaneFragments } from "./behavior-proof-fragments.mjs";

const EXPECTED_IDENTITY_DIGEST = "48777d244fafe26e8ba834ed6b456b1756217380ef6a4af17ef27b42a942bcb3";
const OWNED_BEHAVIORS = new Set([
  "platform.artifacts-are-immutable-and-retained-by-policy",
  "quality.failures-stay-explicit",
  "quality.evidence-is-traceable-and-portable",
]);

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readJsonl(path) {
  return readFileSync(path, "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function trackedCandidateDigest(root) {
  const listed = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root },
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .filter((path) => existsSync(resolve(root, path)))
    .toSorted();
  const hash = createHash("sha256");
  for (const path of listed) {
    hash.update(path);
    hash.update("\0");
    hash.update(digest(readFileSync(resolve(root, path))));
    hash.update("\n");
  }
  return hash.digest("hex");
}

function sourceIdentityDigest(root) {
  const directory = resolve(root, "docs", "behaviors", "source-inventory");
  const identities = readdirSync(directory)
    .filter((path) => path.endsWith(".jsonl"))
    .flatMap((path) => readJsonl(resolve(directory, path)).map(({ c }) => c))
    .toSorted();
  if (identities.length !== 582 || identities.some((value) => typeof value !== "string")) {
    throw new Error(`source identity collection is ${identities.length}/582`);
  }
  const actual = digest(`${identities.join("\n")}\n`);
  if (actual !== EXPECTED_IDENTITY_DIGEST) {
    throw new Error(`source identity digest ${actual} != ${EXPECTED_IDENTITY_DIGEST}`);
  }
  return actual;
}

function substitute(text, values) {
  return text.replace(/<([a-z][a-z0-9_]*)>/gu, (placeholder, name) => {
    const value = values[name];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`missing value ${name} while rendering ${placeholder}`);
    }
    return value;
  });
}

function requiredAssertionCount(steps) {
  let outcome = false;
  let count = 0;
  for (const { keyword } of steps) {
    if (keyword === "Then") outcome = true;
    else if (keyword !== "And" && keyword !== "But") outcome = false;
    if (outcome) count += 1;
  }
  if (count === 0) throw new Error("selected scenario has no outcome assertion");
  return count;
}

function caseCells(cases, classifications) {
  const byCell = new Map();
  const variation = new Map(classifications.map((row) => [row.behavior, row.variation]));
  for (const selectedCase of cases) {
    const existing = byCell.get(selectedCase.cell) ?? {
      cell: selectedCase.cell,
      behavior: selectedCase.behavior,
      subject: selectedCase.subject,
      requiredCaseIds: [],
      requiredLanes: [],
      requiredProfiles: [],
      profileSelectors: [],
      laneResolution: selectedCase.laneResolution,
      profileResolution:
        variation.get(selectedCase.behavior) === "profile-varying"
          ? "unclassified"
          : "not-required",
      profileRegistrationRequired: variation.get(selectedCase.behavior) === "profile-varying",
    };
    existing.requiredCaseIds.push(selectedCase.id);
    if (selectedCase.lane !== null) existing.requiredLanes.push(selectedCase.lane);
    const profileSelector = selectedCase.values.profile;
    if (typeof profileSelector === "string") existing.profileSelectors.push(profileSelector);
    byCell.set(selectedCase.cell, existing);
  }
  return [...byCell.values()]
    .map((cell) => ({
      ...cell,
      requiredCaseIds: cell.requiredCaseIds.toSorted(),
      requiredLanes: [...new Set(cell.requiredLanes)].toSorted(),
      profileSelectors: [...new Set(cell.profileSelectors)].toSorted(),
    }))
    .toSorted((left, right) => left.cell.localeCompare(right.cell));
}

export async function buildBehaviorProofPlan({ root = process.cwd(), mode = "normal" } = {}) {
  if (mode !== "normal" && mode !== "fixed-success") {
    throw new Error(`unknown behavior proof mode: ${mode}`);
  }
  const featureRoot = resolve(root, "docs", "behaviors", "features");
  const featurePaths = readdirSync(featureRoot)
    .filter((path) => path.endsWith(".feature"))
    .toSorted()
    .map((path) => resolve(featureRoot, path));
  const cucumber = await loadSources({
    paths: featurePaths,
    defaultDialect: "en",
    names: [],
    tagExpression: "",
    order: "defined",
  });
  if (cucumber.errors.length > 0 || cucumber.plan.length !== 570) {
    const detail = cucumber.errors.map(({ message }) => message).join("; ");
    throw new Error(`Cucumber collection is ${cucumber.plan.length}/570: ${detail}`);
  }
  const parseErrors = [];
  const scenarios = featurePaths.flatMap((path) => parseFeature(path, parseErrors));
  if (parseErrors.length > 0) throw new Error(parseErrors.join("; "));
  const cucumberOutlines = new Set(cucumber.plan.map(({ name, uri }) => `${uri}\0${name}`));
  const parsedOutlines = new Set(
    scenarios.map(({ path, title }) => `${relative(root, path)}\0${title}`),
  );
  if (
    cucumberOutlines.size !== 47 ||
    parsedOutlines.size !== 47 ||
    [...parsedOutlines].some((identity) => !cucumberOutlines.has(identity))
  ) {
    throw new Error("Cucumber and roadmap parser outline identities disagree");
  }
  const engines = readJsonl(resolve(root, "docs", "behaviors", "engine-families.jsonl"));
  const classifications = readJsonl(resolve(root, "docs", "roadmap", "classification.jsonl"));
  const selection = buildBehaviorCaseSelection({ scenarios, engines, classifications });
  if (!selection.ok) throw new Error(selection.errors.join("; "));
  const scenarioByBehavior = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  const cases = selection.cases.map((selectedCase) => {
    const scenario = scenarioByBehavior.get(selectedCase.behavior);
    if (scenario === undefined) throw new Error(`missing scenario ${selectedCase.behavior}`);
    return {
      id: selectedCase.id,
      behavior: selectedCase.behavior,
      subject: selectedCase.subject,
      cell: selectedCase.cell,
      selector: selectedCase.selector,
      comparisonSubject: selectedCase.comparisonSubject,
      authoredRow: selectedCase.authoredRow,
      sourcePath: relative(root, selectedCase.sourcePath),
      lane: OWNED_BEHAVIORS.has(selectedCase.behavior) ? "public-ts" : null,
      laneResolution: OWNED_BEHAVIORS.has(selectedCase.behavior) ? "assigned" : "unclassified",
      values: selectedCase.arguments,
      title: scenario.title,
      requiredAssertionCount: requiredAssertionCount(scenario.steps),
      steps: scenario.steps.map(({ keyword, text }) => ({
        keyword,
        text: substitute(text, selectedCase.arguments),
      })),
    };
  });
  const classificationPath = resolve(root, "docs", "roadmap", "classification.jsonl");
  const candidateTreeDigest = trackedCandidateDigest(root);
  const plan = {
    schema: "itotori.behavior-selection-plan.v1",
    mode,
    trust: {
      status: "local-candidate",
      externalGate: "fail-closed",
      reasonCode: "external-verifier-app-unavailable",
    },
    candidateTreeDigest,
    classificationDigest: digest(readFileSync(classificationPath)),
    sourceIdentityDigest: sourceIdentityDigest(root),
    roadmapContractDigest: readFileSync(
      resolve(root, "docs", "roadmap", "roadmap-contract.sha256"),
      "utf8",
    ).trim(),
    counts: {
      behaviors: selection.summary.outlines,
      canonicalEngines: selection.summary.canonicalEngines,
      productionEngines: selection.summary.productionEngines,
      authoredCases: selection.summary.authoredCases,
      selectedCases: selection.summary.selectedCases,
      applicableCells: selection.summary.applicableCells,
      nonApplicablePairs: selection.summary.nonApplicablePairs,
    },
    laneFragments: rootLaneFragments(cases),
    cases,
    cells: caseCells(cases, classifications),
    notApplicablePairs: selection.nonApplicablePairs.map(({ behavior, subject }) => ({
      behavior,
      subject,
      status: "not-applicable",
      classificationDigest: digest(readFileSync(classificationPath)),
      reason: "production-only-behavior-on-non-production-subject",
    })),
  };
  return { plan, cucumberCollection: cucumber.plan };
}

export function renderSelectedFeature(plan, { mutationOnly = false } = {}) {
  const selectedCases = mutationOnly
    ? plan.cases.filter(({ behavior }) => OWNED_BEHAVIORS.has(behavior))
    : plan.cases;
  const lines = [
    "Feature: Execute the protected behavior selection plan",
    "  Every generated scenario is bound to one reviewed authored row and subject.",
  ];
  for (const selectedCase of selectedCases) {
    lines.push(
      "",
      `  @behavior-${selectedCase.behavior}`,
      `  Scenario: ${selectedCase.title} [${selectedCase.id}]`,
      `    Given the protected behavior case "${selectedCase.id}" selects "${selectedCase.subject}"`,
      ...selectedCase.steps.map(({ keyword, text }) => `    ${keyword} ${text}`),
    );
  }
  return `${lines.join("\n")}\n`;
}

export function behaviorProofDigest(value) {
  return digest(value);
}
