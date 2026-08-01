import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { parseFeature } from "./audit-behavior-catalog-gherkin.mjs";
import { formatRoadmapResult, validateRoadmap } from "./audit-behavior-roadmap.mjs";
import { buildBehaviorCaseSelection } from "./behavior-case-selection.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const temporaryRoots = [];
const validatorFiles = [
  "audit-behavior-roadmap-cases.mjs",
  "audit-behavior-roadmap-contract.mjs",
  "audit-behavior-roadmap.mjs",
  "audit-behavior-roadmap-graph.mjs",
  "audit-behavior-roadmap.test.mjs",
  "behavior-case-selection.mjs",
];

after(() => {
  for (const root of temporaryRoots) rmSync(root, { force: true, recursive: true });
});

function copyFile(root, relativePath) {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(repoRoot, relativePath), target);
}

function citationPath(citation) {
  return /^(.*):[1-9]\d*$/u.exec(citation)?.[1];
}

function copyInputs() {
  const root = mkdtempSync(join(tmpdir(), "behavior-roadmap-"));
  temporaryRoots.push(root);
  mkdirSync(join(root, "docs"), { recursive: true });
  cpSync(join(repoRoot, "docs", "roadmap"), join(root, "docs", "roadmap"), {
    recursive: true,
  });
  for (const path of ["docs/behaviors/catalog.jsonl", "docs/behaviors/engine-families.jsonl"]) {
    copyFile(root, path);
  }
  cpSync(
    join(repoRoot, "docs", "behaviors", "features"),
    join(root, "docs", "behaviors", "features"),
    { recursive: true },
  );
  cpSync(
    join(repoRoot, "docs", "behaviors", "capability-map"),
    join(root, "docs", "behaviors", "capability-map"),
    { recursive: true },
  );
  const classifications = readRows(join(repoRoot, "docs", "roadmap", "classification.jsonl"));
  for (const row of classifications) {
    for (const citation of [row.gherkin, row.capabilityMap, ...row.implementation]) {
      const path = citationPath(citation);
      if (path) copyFile(root, path);
    }
  }
  for (const file of validatorFiles) copyFile(root, join("scripts", file));
  return root;
}

function readRows(path) {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

function readSelectionInputs() {
  const errors = [];
  const featureDirectory = join(repoRoot, "docs", "behaviors", "features");
  const scenarios = readdirSync(featureDirectory)
    .filter((name) => name.endsWith(".feature"))
    .toSorted()
    .flatMap((name) => parseFeature(join(featureDirectory, name), errors));
  assert.deepEqual(errors, []);
  return {
    scenarios,
    engines: readRows(join(repoRoot, "docs", "behaviors", "engine-families.jsonl")),
    classifications: readRows(join(repoRoot, "docs", "roadmap", "classification.jsonl")),
  };
}

function findScenario(inputs, behavior) {
  const scenario = inputs.scenarios.find(({ id }) => id === behavior);
  assert.ok(scenario, `missing scenario ${behavior}`);
  return scenario;
}

function writeRows(path, rows) {
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function mutateRows(root, filename, mutate) {
  const path = join(root, "docs", "roadmap", filename);
  const rows = readRows(path);
  mutate(rows);
  writeRows(path, rows);
}

function rewrite(path, transform) {
  const before = readFileSync(path, "utf8");
  const after = transform(before);
  assert.notEqual(after, before, `test mutation did not change ${path}`);
  writeFileSync(path, after);
}

function output(root) {
  return formatRoadmapResult(validateRoadmap(root));
}

test("committed roadmap has the exact reduced classification and expansion", () => {
  const result = validateRoadmap(repoRoot);
  assert.equal(result.ok, true, formatRoadmapResult(result));
  const { relationships, maxOutgoingLinks, maxIncomingLinks, ...fixed } = result.summary;
  assert.deepEqual(fixed, {
    behaviors: 47,
    engines: 47,
    engineInvariant: 31,
    engineVarying: 11,
    profileVarying: 5,
    cells: 687,
    bundleDefinitions: 26,
    specs: 241,
    graphRoots: 1,
    reachableSpecs: 241,
    graphAcyclic: true,
    gherkinOutlines: 47,
    gherkinRows: 570,
    selectedCases: 3400,
    partialSelectedCases: 2940,
    evidenceEntries: 32,
  });
  assert.equal(relationships, 381);
  assert.equal(maxOutgoingLinks, 47);
  assert.equal(maxIncomingLinks, 2);
});

test("the shared selector enumerates every authored row, case, cell, and N/A pair", () => {
  const result = buildBehaviorCaseSelection(readSelectionInputs());
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.deepEqual(result.summary, {
    outlines: 47,
    authoredCases: 570,
    selectedCases: 3400,
    partialCases: 2940,
    partialOutlines: 14,
    canonicalEngines: 47,
    productionEngines: 39,
    nativeEngines: 35,
    webEngines: 5,
    plainEngines: 9,
    applicableCells: 687,
    nonApplicablePairs: 96,
  });
  assert.equal(new Set(result.cases.map(({ id }) => id)).size, 3400);
  assert.equal(new Set(result.cases.map(({ cell }) => cell)).size, 687);
  assert.deepEqual(result.applicableCells, result.applicableCells.toSorted());
  assert.deepEqual(
    result.nonApplicablePairs,
    result.nonApplicablePairs.toSorted((left, right) =>
      `${left.behavior}\0${left.subject}`.localeCompare(`${right.behavior}\0${right.subject}`),
    ),
  );

  const distribution = new Map();
  for (const selectedCase of result.cases) {
    const selector = selectedCase.selector.startsWith("canonical:")
      ? selectedCase.partial
        ? "literal"
        : "canonical"
      : selectedCase.selector;
    distribution.set(selector, (distribution.get(selector) ?? 0) + 1);
  }
  assert.deepEqual(Object.fromEntries([...distribution].toSorted()), {
    canonical: 188,
    literal: 11,
    production: 2301,
    "production-trait:mixed": 39,
    "production-trait:native": 525,
    "production-trait:plain": 9,
    "production-trait:web": 40,
    shared: 287,
  });
});

test("mixed-family comparison peers never replace the selected cell subject", () => {
  const inputs = readSelectionInputs();
  const result = buildBehaviorCaseSelection(inputs);
  assert.equal(result.ok, true, result.errors.join("\n"));
  const production = inputs.engines
    .filter(({ supportRole }) => supportRole === "production-target")
    .map(({ sourceCapability }) => sourceCapability)
    .toSorted();
  const mixed = result.cases.filter(({ selector }) => selector === "production-trait:mixed");
  assert.equal(mixed.length, 39);
  for (const [index, selectedCase] of mixed.entries()) {
    assert.equal(selectedCase.subject, production[index]);
    assert.equal(selectedCase.comparisonSubject, production[(index + 1) % production.length]);
    assert.equal(selectedCase.cell, `cell::${selectedCase.behavior}::${selectedCase.subject}`);
    assert.notEqual(selectedCase.subject, selectedCase.comparisonSubject);
  }

  const changed = structuredClone(inputs);
  findScenario(
    changed,
    "quality.same-inputs-reproduce-equivalent-results",
  ).exampleRows[0].comparison_source = "Fixture/reference";
  const changedResult = buildBehaviorCaseSelection(changed);
  assert.equal(changedResult.ok, true, changedResult.errors.join("\n"));
  const ids = (selection) =>
    selection.cases
      .filter(({ behavior }) => behavior === "quality.same-inputs-reproduce-equivalent-results")
      .map(({ id }) => id);
  assert.deepEqual(ids(changedResult), ids(result));
});

test("an unknown or non-production literal cannot select a production cell", () => {
  const unknown = readSelectionInputs();
  findScenario(unknown, "play.control-reproducible-session").exampleRows[7].engine_family =
    "Unknown family";
  const unknownResult = buildBehaviorCaseSelection(unknown);
  assert.equal(unknownResult.ok, false);
  assert.match(unknownResult.errors.join("\n"), /unknown literal engine family "Unknown family"/u);

  const wrongRole = readSelectionInputs();
  findScenario(wrongRole, "play.control-reproducible-session").exampleRows[7].engine_family =
    "Fixture/reference";
  const wrongRoleResult = buildBehaviorCaseSelection(wrongRole);
  assert.equal(wrongRoleResult.ok, false);
  assert.match(
    wrongRoleResult.errors.join("\n"),
    /literal Fixture\/reference is not a production target/u,
  );
});

test("a generic selector change fails the reviewed positional rule", () => {
  const inputs = readSelectionInputs();
  findScenario(inputs, "source.prepare-owned-content").exampleRows[0].engine_family =
    "registered web family";
  const result = buildBehaviorCaseSelection(inputs);
  assert.equal(result.ok, false);
  assert.match(
    result.errors.join("\n"),
    /selector is production-trait:web; expected production-trait:native/u,
  );
});

test("trait-role drift and duplicate canonical identities fail selection", () => {
  const traitDrift = readSelectionInputs();
  const renpy = traitDrift.engines.find(
    ({ sourceCapability }) => sourceCapability === "decode.engine.renpy",
  );
  assert.ok(renpy);
  renpy.supportRole = "research-only";
  const traitResult = buildBehaviorCaseSelection(traitDrift);
  assert.equal(traitResult.ok, false);
  assert.match(
    traitResult.errors.join("\n"),
    /web trait member decode\.engine\.renpy is not a production registry row/u,
  );

  const duplicate = readSelectionInputs();
  duplicate.engines[1].sourceCapability = duplicate.engines[2].sourceCapability;
  const duplicateResult = buildBehaviorCaseSelection(duplicate);
  assert.equal(duplicateResult.ok, false);
  assert.match(duplicateResult.errors.join("\n"), /duplicate sourceCapability/u);
});

test("a missing classification file is reported instead of throwing", () => {
  const root = copyInputs();
  rmSync(join(root, "docs", "roadmap", "classification.jsonl"));
  assert.match(output(root), /classification\.jsonl: missing required JSONL file/u);
});

test("changing variation and applicability destroys honest cell coverage", () => {
  const root = copyInputs();
  mutateRows(root, "classification.jsonl", (rows) => {
    const row = rows.find(({ variation }) => variation === "engine-invariant");
    assert.ok(row);
    row.variation = "engine-varying";
    row.applicability = "canonical-engines";
  });
  const result = output(root);
  assert.match(result, /classification expands to 733\/687 cells/u);
  assert.match(result, /missing ownership for 47 expected cells/u);
});

test("a stale committed instance cell fails exact generated equality", () => {
  const root = copyInputs();
  mutateRows(root, "spec-instances.jsonl", (rows) => {
    const row = rows.find(({ cells }) => cells.length > 0);
    assert.ok(row);
    row.cells.pop();
  });
  assert.match(output(root), /cells differs from generated expansion/u);
});

test("a bundle below the change-surface floor is rejected", () => {
  const root = copyInputs();
  mutateRows(root, "spec-bundles.jsonl", (rows) => {
    rows[0].estimateLines = 499;
  });
  assert.match(output(root), /estimateLines must be an integer from 500 through 1000/u);
});

test("a bundle with its cell transitions gutted is rejected", () => {
  const root = copyInputs();
  mutateRows(root, "spec-bundles.jsonl", (rows) => {
    rows[0].behaviors = [];
  });
  assert.match(output(root), /spec flips no behavior cell/u);
});

test("an acceptance observation with its owning cell gutted is rejected", () => {
  const root = copyInputs();
  const path = join(root, "docs", "roadmap", "unverified.md");
  rewrite(path, (contents) => contents.replace(/— owner/u, "— custodian"));
  assert.match(output(root), /acceptance register has|missing explicit owner/u);
});

test("an out-of-range evidence citation is rejected", () => {
  const root = copyInputs();
  mutateRows(root, "classification.jsonl", (rows) => {
    rows[0].gherkin = rows[0].gherkin.replace(/:[1-9]\d*$/u, ":999999");
  });
  assert.match(output(root), /cited line 999999 exceeds/u);
});

test("a self dependency creates a rejected expanded cycle", () => {
  const root = copyInputs();
  mutateRows(root, "spec-bundles.jsonl", (rows) => {
    const row = rows.find(({ dependsOn }) => dependsOn.length > 0);
    assert.ok(row);
    row.dependsOn.push(row.name);
  });
  assert.match(output(root), /expanded dependency graph contains a cycle/u);
});

test("a direct edge already provided by a two-edge path is rejected", () => {
  const root = copyInputs();
  mutateRows(root, "spec-bundles.jsonl", (rows) => {
    const byName = new Map(rows.map((row) => [row.name, row]));
    let mutation;
    for (const row of rows) {
      for (const dependencyName of row.dependsOn) {
        const dependency = byName.get(dependencyName);
        const ancestor = dependency?.dependsOn.find((name) => {
          const target = byName.get(name);
          return (
            !row.dependsOn.includes(name) &&
            target &&
            (target.scope === "shared" || target.scope === row.scope)
          );
        });
        if (ancestor) mutation = [row, ancestor];
      }
    }
    assert.ok(mutation, "roadmap must contain a dependency path of length two");
    mutation[0].dependsOn.push(mutation[1]);
  });
  assert.match(output(root), /expanded dependency graph has \d+ redundant edges/u);
});

test("an old numbered roadmap token in prose is rejected", () => {
  const root = copyInputs();
  const path = join(root, "docs", "roadmap", "README.md");
  const numberedToken = String.fromCharCode(80, 57, 57);
  rewrite(path, (contents) => `${contents}\nLegacy ${numberedToken} marker.\n`);
  assert.match(output(root), /contains a forbidden numbered roadmap token/u);
});

test("losing one Gherkin Examples row fails the source identity", () => {
  const root = copyInputs();
  const path = join(root, "docs", "behaviors", "features", "review-and-evaluation.feature");
  rewrite(path, (contents) => {
    const lines = contents.split("\n");
    let sawExamples = false;
    let sawHeader = false;
    const index = lines.findIndex((line) => {
      if (/^\s*Examples:/u.test(line)) sawExamples = true;
      else if (sawExamples && /^\s*\|/u.test(line) && !sawHeader) sawHeader = true;
      else if (sawExamples && sawHeader && /^\s*\|/u.test(line)) return true;
      return false;
    });
    assert.notEqual(index, -1);
    lines.splice(index, 1);
    return lines.join("\n");
  });
  assert.match(output(root), /47\/47 outlines and 569\/570 Examples rows/u);
});

test("unreviewed roadmap prose fails the committed contract hash", () => {
  const root = copyInputs();
  const path = join(root, "docs", "roadmap", "README.md");
  rewrite(path, (contents) => `${contents}\nUnreviewed contract prose.\n`);
  assert.match(output(root), /roadmap contract hash changed/u);
});

test("a stale but well-formed committed hash is rejected", () => {
  const root = copyInputs();
  const path = join(root, "docs", "roadmap", "roadmap-contract.sha256");
  rewrite(path, (contents) => {
    const replacement = contents.startsWith("0") ? "1" : "0";
    return `${replacement}${contents.slice(1)}`;
  });
  assert.match(output(root), /roadmap contract hash changed/u);
});

test("progress ledger remains CI-derived and fail-closed", () => {
  const ledger = readFileSync(join(repoRoot, "docs", "roadmap", "progress-ledger.md"), "utf8");
  const required = [
    ["CI-only authority", /Only the\s+designated verifier App, running protected CI/u],
    ["no committed progress", /No report or status snapshot is committed to any Git ref/u],
    ["complete accepted report", /The Check Run contains the report, not merely a link or digest/u],
    ["canonical chunks", /`chunk-NNNN-of-TTTT`/u],
    ["candidate report", /named `behavior-proof \/ candidate-report`/u],
    ["main baseline", /`B`, the unique valid accepted evidence\s+bound to `M`/u],
    ["atomic layer tuple", /one immutable tuple `T`/u],
    ["exact base", /base ref: exactly `main` for a normal\/bottom pull request/u],
    ["evaluation target", /required-check evaluation SHA\/tree `E`/u],
    ["layer transition", /layerGreen = pass\(HP\) - pass\(L\)/u],
    [
      "integration regression",
      /integrationRegression = \(pass\(B\) union pass\(L\)\) - pass\(HE\)/u,
    ],
    [
      "unproved claim failure",
      /references a spec but makes none of its owned accepted-main-red to\s+layer-green transitions/u,
    ],
    ["accepted-main-red claim", /claimGreen = layerGreen intersection \(all cells - pass\(B\)\)/u],
    ["global ownership", /globalOwners\(cell\) = managed specs in the protected contract/u],
    ["governed classifier", /unknown paths and errors\s+default to governed/u],
    ["dependency satisfaction", /Every transitive blocker\s+is report-complete/u],
    ["same-SHA activation", /\*\*UNVERIFIED same-SHA admission:\*\*/u],
    ["resolution envelope", /accepted-resolution[\s\S]*frontierDigest/u],
    ["self-contained resolution", /embeds their canonical bytes\/manifests/u],
    ["three query paths", /## Three query paths/u],
    ["exhaustive check query", /`filter=all`/u],
    ["report-derived work", /never consults live issue open\/closed state/u],
    ["generated view", /## Generated human view/u],
    ["live stale protection", /Before exposing\s+any cached metric/u],
    ["report-derived issue close", /if and only if every owned cell passes/u],
    ["separate issue writer", /separate protected issue-reconciler App first byte-compares/u],
    [
      "issue snapshot",
      /one immutable\s+`\{main SHA, evidence digest, body\/graph digest\}` snapshot/u,
    ],
    ["failure dominance", /Candidate binding has conflicting states, including a flake/u],
    ["new SHA after flake", /Correction requires\s+a new candidate head SHA/u],
    ["merge-group equation", /pass\(G\) - pass\(Bq\) = union/u],
    ["queue membership activation", /\*\*UNVERIFIED queue exactness:\*\*/u],
    [
      "per-layer stack gate",
      /A green tip can never substitute for\s+a red or absent middle layer/u,
    ],
  ];
  for (const [name, pattern] of required) assert.match(ledger, pattern, name);
});
