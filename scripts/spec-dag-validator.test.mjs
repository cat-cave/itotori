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
    "VALID-001 parallelGroup integration node must name exact composed surfaces, artifacts, commands, or adapters: alpha-integration",
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
    "VALID-001 parallelGroup integration node must name exact composed surfaces, artifacts, commands, or adapters: alpha-integration",
  );
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

function errorsFor(...nodes) {
  return validateDag(dagFixture(nodes)).errors;
}

function assertError(errors, expected) {
  assert.ok(
    errors.some((error) => error.includes(expected)),
    `expected error containing ${JSON.stringify(expected)}, got:\n${errors.join("\n")}`,
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
