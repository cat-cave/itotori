import assert from "node:assert/strict";
import test from "node:test";
import { assertError, errorsFor, nodeFixture } from "./spec-dag-validator-test-fixtures.mjs";

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
    "VALID-001 integration/readiness node must name an exact file path, package name, command, or artifact token (parallelGroup alpha-integration)",
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
    "VALID-001 integration/readiness node must name an exact file path, package name, command, or artifact token (parallelGroup alpha-integration)",
  );
});

test("rejects generic readiness evidence as an integration surface", () => {
  const cases = [
    {
      name: "readiness evidence",
      deliverables: ["Readiness evidence"],
      acceptanceCriteria: [
        "Readiness evidence is available after dependency coordination completes",
      ],
    },
    {
      name: "readiness record",
      deliverables: ["Readiness record"],
      acceptanceCriteria: ["The readiness record exists after dependency coordination completes"],
    },
  ];

  for (const { name, deliverables, acceptanceCriteria } of cases) {
    const errors = errorsFor(
      nodeFixture({
        projects: ["itotori", "kaifuu", "suite"],
        parallelGroup: "alpha-integration",
        title: "Suite integration readiness",
        summary: "Coordinate alpha readiness evidence across the dependent projects.",
        deliverables,
        acceptanceCriteria,
        verification: [{ type: "command", value: "node scripts/spec-dag-validator.test.mjs" }],
      }),
    );

    assertError(
      errors,
      "VALID-001 integration/readiness node must name an exact file path, package name, command, or artifact token (parallelGroup alpha-integration)",
      name,
    );
  }
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

// UNIV-019: define + test how integration-surface validation treats each exact
// token TYPE. For every token type there is an explicit PASS case (an exact token
// of that type is accepted) and an explicit FAIL case (a generic near-miss of the
// same type is rejected), and the fail diagnostic must name the token type, the
// offending value, and the reason it failed.
