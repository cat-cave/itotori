import assert from "node:assert/strict";
import test from "node:test";

import {
  OWNED_CELLS,
  assertValidCellReport,
  buildCellReport,
  canonicalDigest,
  formatCellReportSummary,
  renderCellJunit,
} from "./build-cell-report.mjs";
import { expectedFragmentFileNames, fragmentArtifactPaths } from "./behavior-proof-fragments.mjs";

const digest = (character) => character.repeat(64);
const artifactCell = "cell::platform.artifacts-are-immutable-and-retained-by-policy::all";
const baselineGreenCells = new Set(OWNED_CELLS.filter((cell) => cell !== artifactCell));
const subjects = Array.from(
  { length: 47 },
  (_, index) => `decode.engine.subject-${String(index).padStart(2, "0")}`,
);
const sharedBehaviors = [
  "platform.artifacts-are-immutable-and-retained-by-policy",
  "quality.evidence-is-traceable-and-portable",
  "quality.failures-stay-explicit",
  ...Array.from({ length: 28 }, (_, index) => `proof.shared-${String(index).padStart(2, "0")}`),
];
const canonicalBehaviors = Array.from(
  { length: 4 },
  (_, index) => `proof.canonical-${String(index).padStart(2, "0")}`,
);
const productionBehaviors = Array.from(
  { length: 12 },
  (_, index) => `proof.production-${String(index).padStart(2, "0")}`,
);

function selectedCells() {
  const cells = sharedBehaviors.map((behavior) => ({ behavior, subject: "all" }));
  for (const behavior of canonicalBehaviors) {
    for (const subject of subjects) cells.push({ behavior, subject });
  }
  for (const behavior of productionBehaviors) {
    for (const subject of subjects.slice(0, 39)) cells.push({ behavior, subject });
  }
  return cells.map(({ behavior, subject }) => ({
    cell: `cell::${behavior}::${subject}`,
    behavior,
    subject,
    requiredCaseIds: [],
    requiredLanes: ["public-ts"],
    requiredProfiles: [],
    laneResolution: "assigned",
    profileResolution: "not-required",
    profileRegistrationRequired: false,
  }));
}

function selectionPlan() {
  const cells = selectedCells();
  assert.equal(cells.length, 687);
  const cases = Array.from({ length: 3_400 }, (_, index) => {
    const cell = cells[index % cells.length];
    const id = `case::${cell.behavior}::${String(index).padStart(4, "0")}::${cell.subject}`;
    cell.requiredCaseIds.push(id);
    return {
      id,
      behavior: cell.behavior,
      subject: cell.subject,
      cell: cell.cell,
      lane: "public-ts",
      laneResolution: "assigned",
      requiredAssertionCount: 1,
    };
  });
  const notApplicablePairs = productionBehaviors.flatMap((behavior) =>
    subjects.slice(39).map((subject) => ({ behavior, subject })),
  );
  const caseIds = cases.map(({ id }) => id).toSorted();
  return {
    schema: "itotori.behavior-selection-plan.v1",
    candidateTreeDigest: digest("a"),
    classificationDigest: digest("b"),
    counts: {
      behaviors: 47,
      canonicalEngines: 47,
      authoredCases: 570,
      selectedCases: 3_400,
      applicableCells: 687,
      nonApplicablePairs: 96,
    },
    laneFragments: [{ lane: "public-ts", shard: 1, shardCount: 1, caseIds }],
    cases: cases.toReversed(),
    cells: cells.toReversed(),
    notApplicablePairs: notApplicablePairs.toReversed(),
  };
}

function passingInput() {
  const plan = selectionPlan();
  return {
    selectionPlan: plan,
    selectionPlanDigest: canonicalDigest(plan),
    candidateBuildDigest: digest("c"),
    laneFragments: [
      {
        lane: "public-ts",
        shard: 1,
        shardCount: 1,
        messagePath: "behavior-proof/cucumber/public-ts-1of1.ndjson",
        messageDigest: digest("d"),
        junitPath: "behavior-proof/cucumber/public-ts-1of1.xml",
        junitDigest: digest("e"),
      },
    ],
    caseResults: plan.cases.map(({ id, behavior, subject, cell }) => {
      const owned = OWNED_CELLS.includes(cell);
      const green = baselineGreenCells.has(cell);
      return {
        caseId: id,
        behavior,
        subject,
        cell,
        status: green ? "pass" : "fail",
        assertionCount: owned ? 1 : 0,
        observationCount: owned ? 1 : 0,
        reasonCodes: green ? [] : owned ? ["artifact-substrate-gap"] : ["missing-execution"],
      };
    }),
    mutationResults: OWNED_CELLS.map((cell) => ({
      mutationId: `kill::${cell.slice("cell::".length)}`,
      cell,
      outcome: cell === artifactCell ? "invalid" : "killed",
      baselineStatus: cell === artifactCell ? "fail" : "pass",
      mutantStatus: "fail",
      reasonCodes: cell === artifactCell ? ["baseline-failed"] : [],
    })),
    verifiedReceiptDigests: Object.fromEntries(
      [...baselineGreenCells].map((cell, index) => [cell, digest(index === 0 ? "f" : "1")]),
    ),
  };
}

test("a real-scale report passes only the baseline-green owned cells", () => {
  const report = buildCellReport(passingInput());
  assert.equal(report.schema, "itotori.behavior-cell-report.v1");
  assert.equal(report.cells.length, 687);
  assert.equal(report.notApplicablePairs.length, 96);
  assert.deepEqual(report.summary, {
    applicableCellCount: 687,
    passingCellCount: 2,
    failingCellCount: 685,
    notApplicablePairCount: 96,
    passBasisPoints: 29,
    displayPercent: "0.29",
  });
  const passing = report.cells.filter(({ status }) => status === "pass");
  assert.deepEqual(
    passing.map(({ cell }) => cell),
    [...baselineGreenCells].sort(),
  );
  assert.ok(passing.every(({ verifiedReceiptDigest }) => verifiedReceiptDigest !== null));
  const missing = report.cells.filter(({ cell }) => !OWNED_CELLS.includes(cell));
  assert.ok(missing.every(({ reasonCodes }) => reasonCodes.join() === "missing-execution"));
  assert.ok(missing.every(({ verifiedReceiptDigest }) => verifiedReceiptDigest === null));
  const artifact = report.cells.find(({ cell }) => cell === artifactCell);
  assert.equal(artifact?.status, "fail");
  assert.ok(artifact?.reasonCodes.includes("artifact-substrate-gap"));
  assert.ok(artifact?.reasonCodes.includes("invalid-mutation"));
  assert.equal(
    formatCellReportSummary(report),
    "2/687 cells pass (0.29%); 685 fail; 96 pairs not applicable",
  );
});

test("cell JUnit has exactly 687 testcases, 685 failures, and no skipped testcase", () => {
  const xml = renderCellJunit(buildCellReport(passingInput()));
  assert.equal((xml.match(/<testcase /gu) ?? []).length, 687);
  assert.equal((xml.match(/<failure /gu) ?? []).length, 685);
  assert.equal((xml.match(/<system-out>/gu) ?? []).length, 687);
  assert.doesNotMatch(xml, /<skipped/u);
  assert.match(xml, /tests="687" failures="685" skipped="0"/u);
});

test("a signed plan can enumerate multiple shards for one logical lane", () => {
  const input = passingInput();
  const caseIds = input.selectionPlan.cases.map(({ id }) => id).toSorted();
  input.selectionPlan.laneFragments = [
    { lane: "public-ts", shard: 1, shardCount: 2, caseIds: caseIds.slice(0, 1_700) },
    { lane: "public-ts", shard: 2, shardCount: 2, caseIds: caseIds.slice(1_700) },
  ];
  input.selectionPlanDigest = canonicalDigest(input.selectionPlan);
  input.laneFragments = [
    {
      lane: "public-ts",
      shard: 1,
      shardCount: 2,
      messagePath: "behavior-proof/cucumber/public-ts-1of2.ndjson",
      messageDigest: digest("2"),
      junitPath: "behavior-proof/cucumber/public-ts-1of2.xml",
      junitDigest: digest("3"),
    },
    {
      lane: "public-ts",
      shard: 2,
      shardCount: 2,
      messagePath: "behavior-proof/cucumber/public-ts-2of2.ndjson",
      messageDigest: digest("4"),
      junitPath: "behavior-proof/cucumber/public-ts-2of2.xml",
      junitDigest: digest("5"),
    },
  ];
  const report = buildCellReport(input);
  assert.equal(report.summary.passingCellCount, 2);
  assert.deepEqual(expectedFragmentFileNames(input.selectionPlan), [
    "public-ts-1of2.ndjson",
    "public-ts-1of2.xml",
    "public-ts-2of2.ndjson",
    "public-ts-2of2.xml",
  ]);
  assert.deepEqual(
    fragmentArtifactPaths(input.selectionPlan.laneFragments[1], "proof", "mutation"),
    {
      key: "public-ts-2of2",
      messagePath: "proof/mutation/fixed-success-public-ts-2of2.ndjson",
      junitPath: "proof/mutation/fixed-success-public-ts-2of2.xml",
    },
  );
  assert.ok(
    report.cells
      .filter(({ status }) => status === "pass")
      .every(({ messageFragmentDigests }) => messageFragmentDigests.length === 2),
  );
});

test("fixed-success mutations turn the baseline-green owned cells red", () => {
  const input = passingInput();
  input.mutationResults = input.mutationResults.map((mutation) => ({
    ...mutation,
    ...(baselineGreenCells.has(mutation.cell)
      ? { outcome: "escaped", mutantStatus: "pass", reasonCodes: ["fixed-success"] }
      : {}),
  }));
  const report = buildCellReport(input);
  assert.equal(report.summary.passingCellCount, 0);
  for (const cell of report.cells.filter(({ cell }) => baselineGreenCells.has(cell))) {
    assert.equal(cell.status, "fail");
    assert.deepEqual(cell.reasonCodes, ["mutation-escaped"]);
    assert.equal(cell.verifiedReceiptDigest, null);
  }
});

test("one assertion cannot stand in for every Gherkin outcome", () => {
  const input = passingInput();
  const selected = input.selectionPlan.cases.find(({ cell }) => baselineGreenCells.has(cell));
  selected.requiredAssertionCount = 2;
  input.selectionPlanDigest = canonicalDigest(input.selectionPlan);
  assert.throws(
    () => buildCellReport(input),
    /assertion count disagrees with its Gherkin outcomes/u,
  );
});

test("no execution produces the honest 0/687 baseline", () => {
  const input = passingInput();
  input.caseResults = input.caseResults.map((result) => ({
    ...result,
    status: "fail",
    assertionCount: 0,
    observationCount: 0,
    reasonCodes: ["missing-execution"],
  }));
  input.laneFragments = [];
  input.mutationResults = [];
  input.verifiedReceiptDigests = {};
  const report = buildCellReport(input);
  assert.equal(report.summary.passingCellCount, 0);
  assert.equal(report.summary.failingCellCount, 687);
  assert.equal(report.summary.passBasisPoints, 0);
  assert.equal(report.summary.displayPercent, "0.00");
});

test("missing execution or receipt keeps the affected owned cell red", async (context) => {
  await context.test("one missing selected case is red", () => {
    const input = passingInput();
    const removed = input.caseResults.find(({ cell }) => baselineGreenCells.has(cell));
    Object.assign(removed, {
      status: "fail",
      assertionCount: 0,
      observationCount: 0,
      reasonCodes: ["missing-execution"],
    });
    const report = buildCellReport(input);
    const cell = report.cells.find(({ cell }) => cell === removed.cell);
    assert.equal(cell.status, "fail");
    assert.ok(cell.reasonCodes.includes("missing-execution"));
  });
  await context.test("one missing receipt is red and never emitted", () => {
    const input = passingInput();
    const greenCell = [...baselineGreenCells][0];
    delete input.verifiedReceiptDigests[greenCell];
    const report = buildCellReport(input);
    const cell = report.cells.find(({ cell }) => cell === greenCell);
    assert.equal(cell.status, "fail");
    assert.ok(cell.reasonCodes.includes("missing-verified-receipt"));
    assert.equal(cell.verifiedReceiptDigest, null);
  });
});

test("duplicates, skips, and identity mismatches fail closed", async (context) => {
  await context.test("duplicate selected case", () => {
    const input = passingInput();
    input.selectionPlan.cases[1] = { ...input.selectionPlan.cases[0] };
    input.selectionPlanDigest = canonicalDigest(input.selectionPlan);
    assert.throws(() => buildCellReport(input), /duplicate selected case/u);
  });
  await context.test("duplicate case result", () => {
    const input = passingInput();
    input.caseResults[1] = { ...input.caseResults[0] };
    assert.throws(() => buildCellReport(input), /duplicate case result/u);
  });
  await context.test("skipped selected case", () => {
    const input = passingInput();
    input.caseResults[0].status = "skipped";
    assert.throws(() => buildCellReport(input), /forbidden skipped status/u);
  });
  await context.test("mismatched subject", () => {
    const input = passingInput();
    input.caseResults[0].subject = "all-wrong";
    assert.throws(() => buildCellReport(input), /mismatched subject/u);
  });
  await context.test("duplicate lane fragment", () => {
    const input = passingInput();
    input.laneFragments.push({ ...input.laneFragments[0], messagePath: "other.ndjson" });
    assert.throws(() => buildCellReport(input), /duplicate lane fragment/u);
  });
  await context.test("duplicate mutation result", () => {
    const input = passingInput();
    input.mutationResults.push({ ...input.mutationResults[0] });
    assert.throws(() => buildCellReport(input), /duplicate mutation result/u);
  });
  await context.test("attempted non-owned result", () => {
    const input = passingInput();
    const result = input.caseResults.find(({ cell }) => !OWNED_CELLS.includes(cell));
    Object.assign(result, {
      status: "pass",
      assertionCount: 1,
      observationCount: 1,
      reasonCodes: [],
    });
    assert.throws(() => buildCellReport(input), /must be an explicit missing-execution failure/u);
  });
});

test("digest bindings and AJV-backed summary validation reject tampering", () => {
  const input = passingInput();
  input.selectionPlanDigest = digest("9");
  assert.throws(() => buildCellReport(input), /selectionPlanDigest does not match/u);
  const report = buildCellReport(passingInput());
  report.summary.passingCellCount = 3;
  assert.throws(() => assertValidCellReport(report), /summary arithmetic mismatch/u);
  const fresh = buildCellReport(passingInput());
  fresh.extra = true;
  assert.throws(() => assertValidCellReport(fresh), /schema validation failed/u);
});
