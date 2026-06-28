import assert from "node:assert/strict";
import test from "node:test";
import { validateDag } from "./spec-dag.mjs";

test("rejects qd export CI reuse evidence that cites local qd log paths", () => {
  const dag = qdExportFixture();
  dag.runs.push(
    qdCiReuseRunFixture({
      summary:
        "Covered by integrated qd-full-ci wave on main.\nEvidence: log_path=.qd/logs/ci-ITOTORI-300-2026-06-28T09-00-25-766Z.log",
      log_path: ".qd/logs/ci-ITOTORI-300-2026-06-28T09-00-25-766Z.log",
    }),
    qdCiReuseRunFixture({
      node_id: "UNIV-000",
      summary:
        "Covered by integrated qd-full-ci wave on main.\nEvidence: log_path=/home/trevor/projects/itotori/.qd/logs/ci-UNIV-000-2026-06-28T09-00-25-766Z.log",
      log_path: "/home/trevor/projects/itotori/.qd/logs/ci-UNIV-000-2026-06-28T09-00-25-766Z.log",
    }),
  );

  const errors = validateDag(dag).errors;

  assertError(
    errors,
    "runs[0] ITOTORI-300 ci reuse evidence log_path must not point at local-only .qd state",
  );
  assertError(
    errors,
    "runs[0] ITOTORI-300 ci reuse evidence summary must not cite local-only .qd/logs paths",
  );
  assertError(
    errors,
    "runs[1] UNIV-000 ci reuse evidence log_path must be repo-relative, not absolute",
  );
  assertError(
    errors,
    "runs[1] UNIV-000 ci reuse evidence summary must not cite local-only .qd/logs paths",
  );
});

test("accepts qd export CI reuse evidence recorded as an external id", () => {
  const dag = qdExportFixture();
  dag.runs.push(
    qdCiReuseRunFixture({
      summary:
        "Covered by integrated qd-full-ci wave on main.\nEvidence: external_id=local-qdfullci:ITOTORI-300:2026-06-28T09-00-25Z",
      log_path: null,
    }),
  );

  assert.deepEqual(validateDag(dag).errors, []);
});

function assertError(errors, expected) {
  assert.ok(
    errors.some((error) => error.includes(expected)),
    `expected error containing ${JSON.stringify(expected)}, got:\n${errors.join("\n")}`,
  );
}

function qdExportFixture() {
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
      },
    ],
    edges: [{ from_node: "UNIV-000", to_node: "ITOTORI-300", type: "requires" }],
    findings: [],
    runs: [],
    node_notes: [],
  };
}

function qdCiReuseRunFixture(overrides = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    node_id: "ITOTORI-300",
    kind: "ci",
    status: "passed",
    worktree_path: null,
    agent: null,
    started_at: "2026-06-28T09:00:25.766Z",
    finished_at: "2026-06-28T09:00:25.766Z",
    summary:
      "Covered by integrated qd-full-ci wave on main.\nEvidence: external_id=local-qdfullci:ITOTORI-300:2026-06-28T09-00-25Z",
    log_path: null,
    ...overrides,
  };
}
