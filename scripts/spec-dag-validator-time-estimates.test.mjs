import assert from "node:assert/strict";
import test from "node:test";
import { assertError, errorsFor, nodeFixture } from "./spec-dag-validator-test-fixtures.mjs";

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
      "VALID-001 integration/readiness node must name an exact file path, package name, command, or artifact token",
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
    {
      name: "prose command",
      overrides: {
        priority: "P1",
        target: "alpha",
        verification: [{ type: "command", value: "Readiness review" }],
      },
      expected: "VALID-001 alpha P1 node must include concrete command verification",
    },
    {
      name: "allowlisted executable prose command",
      overrides: {
        priority: "P1",
        target: "alpha",
        verification: [{ type: "command", value: "node Readiness review" }],
      },
      expected: "VALID-001 alpha P1 node must include concrete command verification",
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

test("rejects sprint scheduling language inside allowed text fields", () => {
  const errors = errorsFor(
    nodeFixture({
      summary: "Validate roadmap semantic guardrails in sprint 12.",
      acceptanceCriteria: [
        "The validator is scheduled for next sprint.",
        "The validator is planned for sprint 12.",
        "The validator runs next sprint.",
      ],
    }),
  );

  assertError(
    errors,
    "VALID-001 summary contains time-estimate wording; roadmap nodes must use dependencies and verification instead of time estimates: Validate roadmap semantic guardrails in sprint 12.",
  );
  assertError(
    errors,
    "VALID-001 acceptanceCriteria[0] contains time-estimate wording; roadmap nodes must use dependencies and verification instead of time estimates: The validator is scheduled for next sprint.",
  );
  assertError(
    errors,
    "VALID-001 acceptanceCriteria[1] contains time-estimate wording; roadmap nodes must use dependencies and verification instead of time estimates: The validator is planned for sprint 12.",
  );
  assertError(
    errors,
    "VALID-001 acceptanceCriteria[2] contains time-estimate wording; roadmap nodes must use dependencies and verification instead of time estimates: The validator runs next sprint.",
  );
});
