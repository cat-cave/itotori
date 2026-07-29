import assert from "node:assert/strict";
import test from "node:test";
import { assertError, errorsFor, nodeFixture } from "./spec-dag-validator-test-fixtures.mjs";

const integrationSurfaceTokenTypeCases = [
  {
    tokenType: "file path",
    pass: {
      deliverables: ["scripts/spec-dag.mjs roadmap validator surface"],
      acceptanceCriteria: ["scripts/spec-dag.mjs validates the composed roadmap graph"],
    },
    fail: {
      deliverables: ["Readiness record"],
      acceptanceCriteria: ["The readiness record is validated after dependency coordination"],
      rejectedValue: "readiness record",
    },
  },
  {
    tokenType: "package name",
    pass: {
      deliverables: ["@itotori/db readiness service test path"],
      acceptanceCriteria: ["The @itotori/db service path is part of the readiness gate"],
    },
    fail: {
      deliverables: ["Readiness service"],
      acceptanceCriteria: ["The readiness service is validated after dependency coordination"],
      rejectedValue: "readiness service",
    },
  },
  {
    tokenType: "command",
    pass: {
      deliverables: ["Provider proof command"],
      acceptanceCriteria: ["The provider proof command emits the alpha fixture artifact"],
      verification: [{ type: "command", value: "pnpm exec vp run alpha:public-fixture" }],
    },
    fail: {
      deliverables: ["Readiness report"],
      acceptanceCriteria: ["The readiness report is produced after dependency coordination"],
      // A generic roadmap verification command is not counted as an exact surface.
      verification: [{ type: "command", value: "node scripts/spec-dag-validator.test.mjs" }],
      rejectedValue: "readiness report",
    },
  },
  {
    tokenType: "artifact token",
    pass: {
      deliverables: ["artifacts/alpha/public-fixture/provider-proof.json readiness artifact"],
      acceptanceCriteria: ["The provider proof artifact is present after the fixture command"],
    },
    fail: {
      deliverables: ["Readiness evidence"],
      acceptanceCriteria: ["The readiness evidence is available after dependency coordination"],
      rejectedValue: "readiness evidence",
    },
  },
];

const integrationSurfaceDiagnosticPrefix =
  "integration/readiness node must name an exact file path, package name, command, or artifact token";

function integrationNode(overrides) {
  return nodeFixture({
    parallelGroup: "alpha-integration",
    title: "Alpha surface integration",
    summary: "Compose the alpha integration surface for the dependent slices.",
    ...overrides,
  });
}

test("accepts an exact token of each integration-surface token type", () => {
  for (const { tokenType, pass } of integrationSurfaceTokenTypeCases) {
    assert.deepEqual(errorsFor(integrationNode(pass)), [], `${tokenType} pass`);
  }
});

test("rejects a generic near-miss of each integration-surface token type", () => {
  for (const { tokenType, fail } of integrationSurfaceTokenTypeCases) {
    const errors = errorsFor(integrationNode(fail));
    const surfaceError = errors.find((error) => error.includes(integrationSurfaceDiagnosticPrefix));
    assert.ok(
      surfaceError,
      `${tokenType} fail: expected the integration-surface diagnostic, got:\n${errors.join("\n")}`,
    );
    // The diagnostic names the offending value and the reason it failed.
    assert.ok(
      surfaceError.includes(`"${fail.rejectedValue}" uses only generic surface terms`),
      `${tokenType} fail: diagnostic must name value ${JSON.stringify(fail.rejectedValue)} and reason, got:\n${surfaceError}`,
    );
    // The diagnostic offers an exact example of every token type as a fix.
    for (const example of [
      "file path (e.g. scripts/spec-dag.mjs)",
      "package name (e.g. @itotori/db)",
      "command (e.g. command: pnpm exec vp run alpha:public-fixture)",
      "artifact token (e.g. artifacts/alpha/public-fixture/provider-proof.json)",
    ]) {
      assert.ok(
        surfaceError.includes(example),
        `${tokenType} fail: diagnostic must offer example ${JSON.stringify(example)}, got:\n${surfaceError}`,
      );
    }
  }
});

test("path-only and package-only integration examples pass or fail on the exact token", () => {
  // Path-only PASS/FAIL.
  assert.deepEqual(
    errorsFor(
      integrationNode({
        deliverables: ["scripts/spec-dag.mjs roadmap validator surface"],
        acceptanceCriteria: ["scripts/spec-dag.mjs validates the composed roadmap graph"],
      }),
    ),
    [],
    "path-only pass",
  );
  assertError(
    errorsFor(
      integrationNode({
        deliverables: ["Readiness record"],
        acceptanceCriteria: ["The readiness record is validated after dependency coordination"],
      }),
    ),
    integrationSurfaceDiagnosticPrefix,
    "path-only fail",
  );

  // Package-only PASS/FAIL.
  assert.deepEqual(
    errorsFor(
      integrationNode({
        deliverables: ["@itotori/db readiness service test path"],
        acceptanceCriteria: ["The @itotori/db service path is part of the readiness gate"],
      }),
    ),
    [],
    "package-only pass",
  );
  assertError(
    errorsFor(
      integrationNode({
        deliverables: ["Readiness service"],
        acceptanceCriteria: ["The readiness service is validated after dependency coordination"],
      }),
    ),
    integrationSurfaceDiagnosticPrefix,
    "package-only fail",
  );
});

test("names no rejected candidate when the node text has no surface-shaped token", () => {
  const errors = errorsFor(
    integrationNode({
      deliverables: ["Coordinate the dependent slices"],
      acceptanceCriteria: ["The work confirms project membership and dependency order"],
    }),
  );
  const surfaceError = errors.find((error) => error.includes(integrationSurfaceDiagnosticPrefix));
  assert.ok(
    surfaceError,
    `expected the integration-surface diagnostic, got:\n${errors.join("\n")}`,
  );
  assert.ok(
    surfaceError.includes(
      "No path, package, command, or artifact-shaped token was found in the node text",
    ),
    `expected the no-token-found reason, got:\n${surfaceError}`,
  );
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
    {
      name: "slash-delimited deliverable",
      overrides: {
        deliverables: ["Owned command/service/schema/artifact surface"],
      },
      expected:
        "VALID-001 deliverables[0] is a placeholder deliverable: Owned command/service/schema/artifact surface",
    },
    {
      name: "comma-free acceptance criterion",
      overrides: {
        acceptanceCriteria: ["Names an owned command service schema or artifact surface"],
      },
      expected:
        "VALID-001 acceptanceCriteria[0] is placeholder acceptance: Names an owned command service schema or artifact surface",
    },
    {
      name: "and-delimited plural deliverable",
      overrides: {
        deliverables: ["Owned command, service, schema, and artifact surfaces"],
      },
      expected:
        "VALID-001 deliverables[0] is a placeholder deliverable: Owned command, service, schema, and artifact surfaces",
    },
    {
      name: "and-delimited acceptance criterion",
      overrides: {
        acceptanceCriteria: ["Names an owned command, service, schema, and artifact surface"],
      },
      expected:
        "VALID-001 acceptanceCriteria[0] is placeholder acceptance: Names an owned command, service, schema, and artifact surface",
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
    {
      name: "acceptance criteria feasibility",
      overrides: {
        acceptanceCriteria: ["The node produces a feasibility report for later implementation."],
      },
      expected:
        "VALID-001 acceptanceCriteria[0] describes meta or decision-only work: The node produces a feasibility report for later implementation.",
    },
    {
      name: "acceptance criteria feasibility assessment",
      overrides: {
        acceptanceCriteria: [
          "The node produces a feasibility assessment for later implementation.",
        ],
      },
      expected:
        "VALID-001 acceptanceCriteria[0] describes meta or decision-only work: The node produces a feasibility assessment for later implementation.",
    },
  ];

  for (const { name, overrides, expected } of cases) {
    assertError(errorsFor(nodeFixture(overrides)), expected, name);
  }
});
