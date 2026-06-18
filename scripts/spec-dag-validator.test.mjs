import assert from "node:assert/strict";
import test from "node:test";
import { validateDag } from "./spec-dag.mjs";

test("accepts an implementable node with runnable verification and concrete outputs", () => {
  const errors = errorsFor(
    nodeFixture({
      deliverables: [
        "Roadmap validator semantic rule",
        "Invalid roadmap node fixture set",
        "Regression assertions for semantic validation errors",
      ],
      acceptanceCriteria: [
        "The validator reports the node id, field, and offending value for semantic failures",
        "Invalid roadmap fixtures cover manual-only verification and placeholder acceptance",
      ],
      verification: [{ type: "command", value: "node scripts/spec-dag-validator.test.mjs" }],
    }),
  );

  assert.deepEqual(errors, []);
});

test("rejects manual-only verification when tests or smoke behavior need runnable evidence", () => {
  const errors = errorsFor(
    nodeFixture({
      verification: [
        { type: "manual", value: "Adapter golden tests" },
        { type: "manual", value: "Manual smoke" },
      ],
    }),
  );

  assertError(errors, "VALID-001 verification must include at least one command entry");
  assertError(
    errors,
    "VALID-001 verification[0] manual entry is not runnable evidence for tests or smoke behavior: Adapter golden tests",
  );
  assertError(
    errors,
    "VALID-001 verification[1] manual entry is not runnable evidence for tests or smoke behavior: Manual smoke",
  );
});

test("rejects generic and title-derived deliverable placeholders", () => {
  const errors = errorsFor(
    nodeFixture({
      title: "Placeholder validator",
      deliverables: ["Implementation", "Placeholder validator fixtures", "Tests"],
    }),
  );

  assertError(errors, "VALID-001 deliverables[0] is a placeholder deliverable: Implementation");
  assertError(
    errors,
    "VALID-001 deliverables[1] is a placeholder deliverable: Placeholder validator fixtures",
  );
  assertError(errors, "VALID-001 deliverables[2] is a placeholder deliverable: Tests");
});

test("rejects placeholder acceptance criteria with the offending field and value", () => {
  const errors = errorsFor(
    nodeFixture({
      acceptanceCriteria: [
        "Placeholder validator has concrete executable behavior or schema validation",
      ],
    }),
  );

  assertError(
    errors,
    "VALID-001 acceptanceCriteria[0] is placeholder acceptance: Placeholder validator has concrete executable behavior or schema validation",
  );
});

test("rejects planning-only meta nodes unless they are cancelled", () => {
  const plannedErrors = errorsFor(
    nodeFixture({
      title: "Roadmap follow-up pack",
      summary: "Collect future work into a report-only planning bundle.",
    }),
  );
  assertError(
    plannedErrors,
    "VALID-001 title describes meta or decision-only work: Roadmap follow-up pack",
  );
  assertError(
    plannedErrors,
    "VALID-001 summary describes meta or decision-only work: Collect future work into a report-only planning bundle.",
  );

  const cancelledErrors = errorsFor(
    nodeFixture({
      title: "Roadmap follow-up pack",
      status: "cancelled",
      statusReason: "Replaced by concrete implementation nodes.",
      summary: "Collect future work into a report-only planning bundle.",
    }),
  );
  assert.deepEqual(cancelledErrors, []);
});

test("rejects integration nodes that do not identify exact composed surfaces", () => {
  const errors = errorsFor(
    nodeFixture({
      parallelGroup: "alpha-integration",
      title: "Alpha integration",
      deliverables: ["Integration surface"],
      acceptanceCriteria: [
        "Acceptance is based on executable fixtures, validators, services, or commands",
      ],
    }),
  );

  assertError(
    errors,
    "VALID-001 deliverables[0] is a placeholder deliverable: Integration surface",
  );
  assertError(
    errors,
    "VALID-001 acceptanceCriteria[0] is placeholder acceptance: Acceptance is based on executable fixtures, validators, services, or commands",
  );
  assertError(
    errors,
    "VALID-001 integration/readiness node must name exact composed surfaces, artifacts, commands, or adapters: alpha-integration",
  );
});

test("rejects integration nodes satisfied only by broad project membership", () => {
  const errors = errorsFor(
    nodeFixture({
      projects: ["itotori", "kaifuu", "suite"],
      parallelGroup: "alpha-integration",
      title: "Suite integration readiness",
      summary: "Coordinate project membership across the alpha branch.",
      deliverables: ["Cross-project readiness gate", "Dependency coordination checklist"],
      acceptanceCriteria: [
        "The work states project membership and dependency order without naming composed surfaces",
      ],
      verification: [{ type: "command", value: "node scripts/spec-dag-validator.test.mjs" }],
    }),
  );

  assertError(
    errors,
    "VALID-001 integration/readiness node must name exact composed surfaces, artifacts, commands, or adapters: alpha-integration",
  );
});

test("rejects generic readiness evidence as an integration surface", () => {
  const errors = errorsFor(
    nodeFixture({
      projects: ["itotori", "kaifuu", "suite"],
      parallelGroup: "alpha-integration",
      title: "Suite integration readiness",
      summary: "Coordinate alpha readiness evidence across the dependent projects.",
      deliverables: ["Readiness evidence"],
      acceptanceCriteria: [
        "Readiness evidence is available after dependency coordination completes",
      ],
      verification: [{ type: "command", value: "node scripts/spec-dag-validator.test.mjs" }],
    }),
  );

  assertError(
    errors,
    "VALID-001 integration/readiness node must name exact composed surfaces, artifacts, commands, or adapters: alpha-integration",
  );
});

test("accepts exact integration and readiness surface tokens", () => {
  const cases = [
    {
      name: "file path",
      overrides: {
        parallelGroup: "alpha-integration",
        title: "Roadmap validator integration",
        deliverables: ["scripts/spec-dag.mjs roadmap validator surface"],
        acceptanceCriteria: ["scripts/spec-dag.mjs validates the composed roadmap graph"],
      },
    },
    {
      name: "package name",
      overrides: {
        parallelGroup: "alpha-integration",
        title: "DB readiness integration",
        deliverables: ["@itotori/db readiness service test path"],
        acceptanceCriteria: ["The @itotori/db service path is part of the readiness gate"],
      },
    },
    {
      name: "artifact token",
      overrides: {
        parallelGroup: "alpha-integration",
        title: "Provider proof readiness",
        deliverables: ["artifacts/alpha/public-fixture/provider-proof.json readiness artifact"],
        acceptanceCriteria: ["The provider proof artifact is present after the fixture command"],
      },
    },
    {
      name: "verification command",
      overrides: {
        parallelGroup: "alpha-integration",
        title: "Provider proof readiness",
        deliverables: ["Provider proof command"],
        acceptanceCriteria: ["The provider proof command emits the alpha fixture artifact"],
        verification: [{ type: "command", value: "pnpm exec vp run alpha:public-fixture" }],
      },
    },
  ];

  for (const { name, overrides } of cases) {
    assert.deepEqual(errorsFor(nodeFixture(overrides)), [], name);
  }
});

test("rejects placeholder implementability surface wording", () => {
  const cases = [
    {
      name: "deliverable",
      overrides: {
        deliverables: ["Owned command, service, schema, or artifact surface"],
      },
      expected:
        "VALID-001 deliverables[0] is a placeholder deliverable: Owned command, service, schema, or artifact surface",
    },
    {
      name: "acceptance criterion",
      overrides: {
        acceptanceCriteria: ["Names an owned command, service, schema, or artifact surface"],
      },
      expected:
        "VALID-001 acceptanceCriteria[0] is placeholder acceptance: Names an owned command, service, schema, or artifact surface",
    },
  ];

  for (const { name, overrides, expected } of cases) {
    assertError(errorsFor(nodeFixture(overrides)), expected, name);
  }
});

test("rejects active report-only decision-only and feasibility nodes", () => {
  const cases = [
    {
      name: "planned report-only",
      overrides: {
        title: "Report-only localization result",
        summary: "Collect implementation output as a report-only bundle.",
      },
      expected:
        "VALID-001 title describes meta or decision-only work: Report-only localization result",
    },
    {
      name: "in-progress decision-only",
      overrides: {
        status: "in_progress",
        owner: "codex",
        branch: "spec/univ-021-fixture",
        title: "Decision-only provider route",
      },
      expected:
        "VALID-001 title describes meta or decision-only work: Decision-only provider route",
    },
    {
      name: "blocked feasibility",
      overrides: {
        status: "blocked",
        statusReason: "Waiting on named input.",
        blockedBy: "UNIV-016",
        title: "Feasibility study",
      },
      expected: "VALID-001 title describes meta or decision-only work: Feasibility study",
    },
  ];

  for (const { name, overrides, expected } of cases) {
    assertError(errorsFor(nodeFixture(overrides)), expected, name);
  }
});

test("rejects integration and readiness nodes without exact implementability surfaces", () => {
  const cases = [
    {
      name: "integration",
      overrides: {
        parallelGroup: "alpha-integration",
        title: "Suite integration gate",
        summary: "Coordinate dependencies across alpha work.",
        deliverables: ["Project dependency checklist"],
        acceptanceCriteria: ["The checklist confirms project membership and dependency order"],
      },
    },
    {
      name: "readiness",
      overrides: {
        title: "Alpha readiness gate",
        summary: "Coordinate readiness across dependent projects.",
        deliverables: ["Readiness evidence bundle"],
        acceptanceCriteria: ["Readiness evidence is available after dependency coordination"],
      },
    },
  ];

  for (const { name, overrides } of cases) {
    assertError(
      errorsFor(nodeFixture(overrides)),
      "VALID-001 integration/readiness node must name exact composed surfaces, artifacts, commands, or adapters",
      name,
    );
  }
});

test("rejects alpha P0/P1 nodes without concrete command verification", () => {
  const cases = [
    {
      name: "manual only",
      overrides: {
        priority: "P1",
        target: "alpha",
        verification: [{ type: "manual", value: "Readiness review" }],
      },
      expected: "VALID-001 alpha P1 node must include concrete command verification",
    },
    {
      name: "placeholder command",
      overrides: {
        priority: "P0",
        target: "alpha",
        verification: [
          { type: "command", value: "owned command, service, schema, or artifact surface" },
        ],
      },
      expected: "VALID-001 alpha P0 node must include concrete command verification",
    },
  ];

  for (const { name, overrides, expected } of cases) {
    assertError(errorsFor(nodeFixture(overrides)), expected, name);
  }
});

test("rejects roadmap time estimate fields", () => {
  const errors = errorsFor(nodeFixture({ estimatedDays: "2" }));

  assertError(errors, "VALID-001 has unknown field estimatedDays");
  assertError(
    errors,
    "VALID-001 estimatedDays is a time estimate field; roadmap nodes must use dependencies and verification instead of time estimates",
  );
});

test("rejects time estimate wording inside allowed text fields", () => {
  const errors = errorsFor(
    nodeFixture({
      summary: "Validate roadmap semantic guardrails in two days.",
      acceptanceCriteria: ["The validator does not hide planning effort as 3 points"],
      verification: [
        { type: "command", value: "node scripts/spec-dag-validator.test.mjs" },
        { type: "manual", value: "Complete smoke review in 4 hours" },
      ],
    }),
  );

  assertError(
    errors,
    "VALID-001 summary contains time-estimate wording; roadmap nodes must use dependencies and verification instead of time estimates: Validate roadmap semantic guardrails in two days.",
  );
  assertError(
    errors,
    "VALID-001 acceptanceCriteria[0] contains time-estimate wording; roadmap nodes must use dependencies and verification instead of time estimates: The validator does not hide planning effort as 3 points",
  );
  assertError(
    errors,
    "VALID-001 verification[1].value contains time-estimate wording; roadmap nodes must use dependencies and verification instead of time estimates: Complete smoke review in 4 hours",
  );
});

test("rejects qualitative and compact time estimate wording inside allowed text fields", () => {
  const errors = errorsFor(
    nodeFixture({
      summary: "Estimated effort is medium.",
      acceptanceCriteria: ["Estimated effort: 2d."],
      auditFocus: ["Sized as S for planning."],
    }),
  );

  assertError(
    errors,
    "VALID-001 summary contains time-estimate wording; roadmap nodes must use dependencies and verification instead of time estimates: Estimated effort is medium.",
  );
  assertError(
    errors,
    "VALID-001 acceptanceCriteria[0] contains time-estimate wording; roadmap nodes must use dependencies and verification instead of time estimates: Estimated effort: 2d.",
  );
  assertError(
    errors,
    "VALID-001 auditFocus[0] contains time-estimate wording; roadmap nodes must use dependencies and verification instead of time estimates: Sized as S for planning.",
  );
});

function errorsFor(...nodes) {
  return validateDag(dagFixture(nodes)).errors;
}

function assertError(errors, expected, message = expected) {
  assert.ok(
    errors.some((error) => error.includes(expected)),
    `${message}: expected error containing ${JSON.stringify(expected)}, got:\n${errors.join("\n")}`,
  );
}

function dagFixture(nodes) {
  return {
    schemaVersion: "0.1.0",
    metadata: {
      generatedFrom: "spec-dag-validator.test.mjs",
      currentBaseline: "fixture",
      priorityDefinitions: {
        P0: "blocks current merge",
        P1: "blocks alpha readiness",
        P2: "important follow-up",
        P3: "batched follow-up",
      },
      statusDefinitions: {
        complete: "verified and merged",
        planned: "ready when dependencies complete",
        in_progress: "claimed by a worker",
        blocked: "waiting on named input",
        cancelled: "replaced or intentionally dropped",
      },
    },
    nodes: [alphaNodeFixture(), ...nodes],
  };
}

function alphaNodeFixture() {
  return {
    id: "ALPHA-005",
    title: "Alpha readiness fixture",
    status: "complete",
    priority: "P1",
    target: "alpha",
    projects: ["suite"],
    parallelGroup: "milestone",
    dependsOn: [],
    summary: "Fixture alpha readiness milestone.",
    deliverables: ["Alpha readiness fixture"],
    acceptanceCriteria: ["The fixture milestone exists for alpha path validation"],
    verification: [{ type: "command", value: "node scripts/spec-dag.mjs validate" }],
    auditFocus: ["Fixture validity"],
  };
}

function nodeFixture(overrides = {}) {
  return {
    id: "VALID-001",
    title: "Roadmap validator semantics",
    status: "planned",
    priority: "P2",
    target: "continuous",
    projects: ["universal"],
    parallelGroup: "roadmap-infra",
    dependsOn: [],
    summary: "Validate roadmap semantic guardrails for future planned work.",
    deliverables: ["Roadmap semantic validator", "Invalid node fixture set"],
    acceptanceCriteria: ["Invalid node fixtures emit actionable validator errors"],
    verification: [{ type: "command", value: "node scripts/spec-dag-validator.test.mjs" }],
    auditFocus: ["Validator false positives", "Validator false negatives"],
    ...overrides,
  };
}
