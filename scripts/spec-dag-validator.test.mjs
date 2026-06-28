import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDag, validateDag } from "./spec-dag.mjs";

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
      "VALID-001 integration/readiness node must name exact composed surfaces, artifacts, commands, or adapters: alpha-integration",
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

test("accepts qd export shape as the canonical roadmap file shape", () => {
  const errors = validateDag(qdExportFixture()).errors;

  assert.deepEqual(errors, []);

  const normalized = normalizeDag(qdExportFixture());
  assert.equal(normalized.schemaVersion, "0.1.0");
  assert.deepEqual(normalized.nodes[1], {
    id: "ITOTORI-300",
    title: "Validate qd export roadmap gate",
    status: "planned",
    priority: "P0",
    target: "continuous",
    projects: ["itotori"],
    parallelGroup: "roadmap-infra",
    dependsOn: ["UNIV-000"],
    summary: "Make qd export the canonical roadmap/spec-dag.json shape.",
    deliverables: ["scripts/spec-dag.mjs qd export validator"],
    acceptanceCriteria: ["just roadmap-validate passes on qd export JSON"],
    verification: [{ type: "command", value: "just roadmap-validate" }],
    auditFocus: ["qd check/CI gate drift"],
  });
});

test("rejects qd export placeholder spec, acceptance, and audit-focus text", () => {
  const dag = qdExportFixture({
    spec: "test spec",
    acceptance: "test acc",
    audit_focus: ["test focus"],
  });

  const errors = validateDag(dag).errors;

  assertError(errors, "ITOTORI-300 spec is placeholder text: test spec");
  assertError(errors, "ITOTORI-300 acceptance is placeholder text: test acc");
  assertError(errors, "ITOTORI-300 audit_focus[0] is placeholder text: test focus");
});

test("rejects active qd audit-fix nodes with generic acceptance and empty evidence", () => {
  const errors = validateDag(
    qdExportFixture({
      kind: "audit-fix",
      acceptance: "Finding is addressed and verified.",
      verification: [],
      audit_focus: [],
    }),
  ).errors;

  assertError(
    errors,
    "ITOTORI-300 audit-fix acceptance is generic: Finding is addressed and verified.",
  );
  assertError(errors, "ITOTORI-300 audit-fix verification must have at least one entry");
  assertError(errors, "ITOTORI-300 audit-fix audit_focus must have at least one entry");
});

test("rejects claimed qd audit-fix nodes with empty audit focus", () => {
  const errors = validateDag(
    qdExportFixture({
      kind: "audit-fix",
      status: "claimed",
      acceptance:
        "- The regression fixture fails before the parser repair and passes after the repair",
      audit_focus: [],
    }),
  ).errors;

  assertError(errors, "ITOTORI-300 audit-fix audit_focus must have at least one entry");
});

test("rejects qd export alpha command verification that names missing recipes and tasks", () => {
  const errors = validateDag(
    qdExportFixture({
      milestone: "alpha",
      priority: "P1",
      verification: [
        { type: "command", value: "just missing-alpha-recipe --dry-run" },
        { type: "command", value: "pnpm exec vp run alpha:missing-task" },
      ],
    }),
  ).errors;

  assertError(
    errors,
    "ITOTORI-300 verification[0] references missing just recipe missing-alpha-recipe",
  );
  assertError(errors, "ITOTORI-300 verification[1] references missing vp task alpha:missing-task");
});

test("rejects qd export alpha P0/P1 app test passthrough commands", () => {
  const errors = validateDag(
    qdExportFixture({
      milestone: "alpha",
      priority: "P1",
      verification: [
        {
          type: "command",
          value: "pnpm --filter @itotori/app test -- test/openrouter-live.test.ts",
        },
        {
          type: "command",
          value: "pnpm --filter @itotori/app test -- apps/itotori/test/openrouter-live.test.ts",
        },
        {
          type: "command",
          value:
            "pnpm --filter @itotori/app exec vitest run apps/itotori/test/openrouter-live.test.ts",
        },
      ],
    }),
  ).errors;

  assertError(
    errors,
    'ITOTORI-300 verification[0] must use "pnpm --filter @itotori/app exec vitest run" instead of package "test --" passthrough',
  );
  assertError(
    errors,
    'ITOTORI-300 verification[1] must use "pnpm --filter @itotori/app exec vitest run" instead of package "test --" passthrough',
  );
  assertError(
    errors,
    "ITOTORI-300 verification[1] @itotori/app test path must be package-relative, not root-relative apps/itotori/test/openrouter-live.test.ts",
  );
  assertError(
    errors,
    "ITOTORI-300 verification[2] @itotori/app test path must be package-relative, not root-relative apps/itotori/test/openrouter-live.test.ts",
  );
});

test("rejects qd export alpha include-ignored cargo commands without exact test target and filter", () => {
  const errors = validateDag(
    qdExportFixture({
      milestone: "alpha",
      priority: "P1",
      verification: [
        {
          type: "command",
          value:
            "cargo test -p utsushi-core composite_asset_package_real_bytes -- --include-ignored",
        },
      ],
    }),
  ).errors;

  assertError(
    errors,
    "ITOTORI-300 verification[0] include-ignored command must name an exact cargo integration test target and test filter",
  );
});

test("accepts qd export alpha commands that name existing recipes, tasks, and exact ignored tests", () => {
  const errors = validateDag(
    qdExportFixture({
      milestone: "alpha",
      priority: "P1",
      verification: [
        { type: "command", value: "just localize-project --dry-run --project sweetie-hd-alpha-1" },
        {
          type: "command",
          value:
            "pnpm exec vp run itotori:agentic-loop-smoke --bridge apps/itotori/test/fixtures/agentic-loop-smoke-bridge.json --unit-index 0 --pair-policy apps/itotori/test/fixtures/agentic-loop-smoke-pair-policy.json",
        },
        {
          type: "command",
          value: "pnpm --filter @itotori/app exec vitest run test/localize-project-stage.test.ts",
        },
        {
          type: "command",
          value:
            "ITOTORI_REAL_GAME_ROOT=/scratch/itotori-research/sweetie-hd/extracted direnv exec . cargo test -p utsushi-core --test engine_port_sinks_bridge_real_bytes engine_port_sinks_bridge_real_bytes_pushes_text_and_frame_for_ten_ticks -- --include-ignored",
        },
      ],
    }),
  ).errors;

  assert.deepEqual(errors, []);
});

test("rejects qd export edges that reference missing nodes", () => {
  const dag = qdExportFixture();
  dag.edges.push({ from_node: "MISSING-001", to_node: "ITOTORI-300", type: "requires" });

  const errors = validateDag(dag).errors;

  assertError(errors, "edge MISSING-001 -> ITOTORI-300 references unknown from_node MISSING-001");
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
    nodes: [alphaNodeFixture(), rgtNodeFixture(), ...nodes],
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

function rgtNodeFixture() {
  return {
    id: "RGT-005",
    title: "Real-game-testing-ready milestone fixture",
    status: "complete",
    priority: "P1",
    target: "real-game-testing-ready",
    projects: ["suite"],
    parallelGroup: "milestone",
    dependsOn: [],
    summary: "Fixture real-game-testing-ready readiness milestone.",
    deliverables: ["RGT readiness fixture"],
    acceptanceCriteria: [
      "The fixture milestone exists for real-game-testing-ready path validation",
    ],
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

function qdExportFixture(overrides = {}) {
  return {
    schema_version: 1,
    exported_at: "2026-06-27T00:00:00.000Z",
    registries: {
      groups: [{ name: "baseline" }, { name: "roadmap-infra" }],
      projects: [{ name: "universal" }, { name: "itotori" }],
      milestones: [
        { name: "baseline", rank: 0 },
        { name: "continuous", rank: 4 },
      ],
    },
    nodes: [
      {
        id: "UNIV-000",
        title: "Baseline",
        kind: "feature",
        milestone: "baseline",
        status: "done",
        priority: "P0",
        owner: null,
        branch: null,
        spec: "Committed baseline.\n\nDeliverables:\n- Baseline gate",
        acceptance: "- Baseline verification passes",
        group_name: "baseline",
        status_reason: null,
        check_command: null,
        ci_command: null,
        projects: ["universal"],
        verification: [{ type: "command", value: "just check" }],
        audit_focus: ["Baseline drift"],
      },
      {
        id: "ITOTORI-300",
        title: "Validate qd export roadmap gate",
        kind: "feature",
        milestone: "continuous",
        status: "ready",
        priority: "P0",
        owner: null,
        branch: null,
        spec: "Make qd export the canonical roadmap/spec-dag.json shape.\n\nDeliverables:\n- scripts/spec-dag.mjs qd export validator",
        acceptance: "- just roadmap-validate passes on qd export JSON",
        group_name: "roadmap-infra",
        status_reason: null,
        check_command: null,
        ci_command: null,
        projects: ["itotori"],
        verification: [{ type: "command", value: "just roadmap-validate" }],
        audit_focus: ["qd check/CI gate drift"],
        ...overrides,
      },
    ],
    edges: [{ from_node: "UNIV-000", to_node: "ITOTORI-300", type: "requires" }],
    findings: [],
    runs: [],
    node_notes: [],
  };
}
