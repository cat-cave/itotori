import assert from "node:assert/strict";
import { validateDag } from "./spec-dag.mjs";

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
        id: "capability_itotori_300",
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
    edges: [{ from_node: "UNIV-000", to_node: "capability_itotori_300", type: "requires" }],
    findings: [],
    runs: [],
    node_notes: [],
  };
}

function qdPromotedAuditFixExport(overrides = {}) {
  const dag = qdExportFixture();
  const id = "report-id-is-a-constant-per-kind-index-pair-not-per-run";
  dag.nodes[1] = {
    id,
    title: "Report id is a constant per kind/index pair, not per run",
    kind: "audit-fix",
    milestone: null,
    status: "ready",
    priority: "P3",
    owner: null,
    branch: null,
    spec: "apps/itotori/src/benchmark-report.ts: report ids are derived from kind/index only, so multiple runs can collide.",
    acceptance: "Finding is addressed and verified.",
    group_name: null,
    status_reason: null,
    check_command: null,
    ci_command: null,
    projects: [],
    verification: [],
    audit_focus: [],
    ...overrides,
  };
  dag.edges = [{ from_node: "UNIV-000", to_node: id, type: "requires" }];
  return dag;
}

function qdCiReuseRunFixture(overrides = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    node_id: "capability_itotori_300",
    kind: "ci",
    status: "passed",
    worktree_path: null,
    agent: null,
    started_at: "2026-06-28T09:00:25.766Z",
    finished_at: "2026-06-28T09:00:25.766Z",
    summary:
      "Covered by integrated qd-full-ci wave on main.\nEvidence: external_id=local-qdfullci:capability_itotori_300:2026-06-28T09-00-25Z",
    log_path: null,
    ...overrides,
  };
}

export {
  alphaNodeFixture,
  assertError,
  dagFixture,
  errorsFor,
  nodeFixture,
  qdCiReuseRunFixture,
  qdExportFixture,
  qdPromotedAuditFixExport,
  rgtNodeFixture,
};
