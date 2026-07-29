import assert from "node:assert/strict";
import test from "node:test";
import { validateDag, validateFindingDagAction } from "./spec-dag.mjs";
import {
  assertError,
  dagFixture,
  errorsFor,
  nodeFixture,
  qdExportFixture,
} from "./spec-dag-validator-test-fixtures.mjs";

test("rejects qd export edges that reference missing nodes", () => {
  const dag = qdExportFixture();
  dag.edges.push({ from_node: "MISSING-001", to_node: "capability_itotori_300", type: "requires" });

  const errors = validateDag(dag).errors;

  assertError(
    errors,
    "edge MISSING-001 -> capability_itotori_300 references unknown from_node MISSING-001",
  );
});

test("flags a non-complete P1 real-game-testing-ready node that is not an ancestor of RGT-005", () => {
  const errors = errorsFor(
    nodeFixture({
      id: "RGT-ORPHAN-001",
      target: "real-game-testing-ready",
      priority: "P1",
      status: "planned",
      dependsOn: [],
    }),
  );

  assertError(
    errors,
    "RGT-ORPHAN-001 is P1 real-game-testing-ready work but is not an ancestor of RGT-005",
  );
});

test("accepts a non-complete P1 real-game-testing-ready node wired as an ancestor of RGT-005", () => {
  const dag = dagFixture([
    nodeFixture({
      id: "RGT-CHILD-001",
      target: "real-game-testing-ready",
      priority: "P1",
      status: "planned",
      dependsOn: [],
    }),
  ]);
  // Wire the hub -> child so the child becomes an ancestor of RGT-005.
  dag.nodes.find((node) => node.id === "RGT-005").dependsOn = ["RGT-CHILD-001"];

  const errors = validateDag(dag).errors;

  assert.ok(
    !errors.some((error) => error.includes("RGT-CHILD-001 is P1 real-game-testing-ready work")),
    `expected no RGT-005 ancestor error, got:\n${errors.join("\n")}`,
  );
});

test("flags a non-complete P1 alpha node that is not an ancestor of ALPHA-005", () => {
  const errors = errorsFor(
    nodeFixture({
      id: "ALPHA-ORPHAN-001",
      target: "alpha",
      priority: "P1",
      status: "planned",
      dependsOn: [],
    }),
  );

  assertError(
    errors,
    "ALPHA-ORPHAN-001 is P1 alpha-readiness work but is not an ancestor of ALPHA-005",
  );
});

test("a complete P1 real-game-testing-ready node need not be an ancestor of RGT-005", () => {
  const errors = errorsFor(
    nodeFixture({
      id: "RGT-DONE-001",
      target: "real-game-testing-ready",
      priority: "P1",
      status: "complete",
      dependsOn: [],
    }),
  );

  assert.ok(
    !errors.some((error) => error.includes("RGT-DONE-001 is P1 real-game-testing-ready work")),
    `expected no RGT-005 ancestor error for a complete node, got:\n${errors.join("\n")}`,
  );
});

test("append-to-node target may be non-planned for the illustrative example but not for real reports", () => {
  const targetNodeId = "TARGET-001";
  const specId = "SPEC-001";
  const finding = {
    id: `${specId}-F001`,
    severity: "P2",
    orchestration: {
      nextAction: "append_to_existing_dag_node",
      existingDagNodeUpdate: { targetNodeId },
    },
  };
  const report = { spec: { id: specId } };

  for (const status of ["in_progress", "done", "complete", "blocked", "cancelled"]) {
    const nodeById = new Map([[targetNodeId, { id: targetNodeId, status }]]);

    const exampleErrors = validateFindingDagAction(
      report,
      finding,
      "roadmap/examples/x.json",
      nodeById,
      {
        isExampleFixture: true,
      },
    );
    assert.deepEqual(
      exampleErrors,
      [],
      `illustrative example must accept a non-planned (${status}) append target, got:\n${exampleErrors.join("\n")}`,
    );

    const realErrors = validateFindingDagAction(report, finding, "report.json", nodeById, {
      isExampleFixture: false,
    });
    assertError(
      realErrors,
      `existingDagNodeUpdate.targetNodeId ${targetNodeId} must be planned, not ${status}`,
      `real submitted report must still reject a non-planned (${status}) append target`,
    );
  }
});

test("append-to-node target still requires existence and non-self-reference for the example", () => {
  const specId = "SPEC-001";
  const finding = {
    id: `${specId}-F001`,
    severity: "P2",
    orchestration: {
      nextAction: "append_to_existing_dag_node",
      existingDagNodeUpdate: { targetNodeId: "MISSING-001" },
    },
  };
  const report = { spec: { id: specId } };

  const missingErrors = validateFindingDagAction(
    report,
    finding,
    "roadmap/examples/x.json",
    new Map(),
    {
      isExampleFixture: true,
    },
  );
  assertError(
    missingErrors,
    "existingDagNodeUpdate.targetNodeId MISSING-001 does not exist",
    "the example still requires the append target to exist",
  );

  const selfRefFinding = {
    id: `${specId}-F001`,
    severity: "P2",
    orchestration: {
      nextAction: "append_to_existing_dag_node",
      existingDagNodeUpdate: { targetNodeId: specId },
    },
  };
  const nodeById = new Map([[specId, { id: specId, status: "in_progress" }]]);
  const selfRefErrors = validateFindingDagAction(
    report,
    selfRefFinding,
    "roadmap/examples/x.json",
    nodeById,
    { isExampleFixture: true },
  );
  assertError(
    selfRefErrors,
    `finding ${specId}-F001 must not append follow-up work to the audited spec ${specId}`,
    "the example still rejects appending follow-up to the audited spec",
  );
});
