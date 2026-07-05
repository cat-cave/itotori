import assert from "node:assert/strict";
import test from "node:test";

import {
  HUB_ID,
  RGT_MILESTONE,
  SUBSTRATE_SURFACES,
  ancestorsOf,
  indexDag,
  runChecklist,
} from "./rgt-readiness-checklist.mjs";

const ALL_SURFACE_NODES = SUBSTRATE_SURFACES.flatMap((s) => s.nodes);

function node(id, overrides = {}) {
  return {
    id,
    title: `Fixture ${id}`,
    milestone: RGT_MILESTONE,
    priority: "P1",
    status: "done",
    ...overrides,
  };
}

/**
 * Build a qd-export-shaped fixture DAG where RGT-005 depends (via edges) on every
 * declared substrate surface node, so a baseline fixture is green.
 */
function dagFixture({ extraNodes = [], extraEdges = [], hub = {} } = {}) {
  const substrateNodes = ALL_SURFACE_NODES.map((id) => node(id));
  const edges = ALL_SURFACE_NODES.map((id) => ({ from_node: id, to_node: HUB_ID }));
  return {
    schema_version: 1,
    nodes: [node(HUB_ID, { status: "ready", ...hub }), ...substrateNodes, ...extraNodes],
    edges: [...edges, ...extraEdges],
  };
}

const blockingOf = (findings) => findings.filter((f) => f.severity === "blocking");
const warningsOf = (findings) => findings.filter((f) => f.severity === "warning");

test("a fully-wired substrate DAG passes with no blocking findings", () => {
  const { ok, findings } = runChecklist(dagFixture());
  assert.equal(
    ok,
    true,
    blockingOf(findings)
      .map((f) => f.message)
      .join("\n"),
  );
  assert.equal(blockingOf(findings).length, 0);
  assert.equal(warningsOf(findings).length, 0);
  // Every named surface node is reported.
  for (const id of ALL_SURFACE_NODES) {
    assert.ok(
      findings.some((f) => f.check === "substrate" && f.message.includes(id)),
      `expected a substrate finding for ${id}`,
    );
  }
});

test("a missing hub node fails the gate", () => {
  const dag = dagFixture();
  dag.nodes = dag.nodes.filter((n) => n.id !== HUB_ID);
  const { ok, findings } = runChecklist(dag);
  assert.equal(ok, false);
  assert.ok(blockingOf(findings).some((f) => f.check === "hub" && f.message.includes(HUB_ID)));
});

test("a hub on the wrong milestone fails the gate", () => {
  const { ok, findings } = runChecklist(dagFixture({ hub: { milestone: "alpha" } }));
  assert.equal(ok, false);
  assert.ok(blockingOf(findings).some((f) => f.check === "hub" && f.message.includes("alpha")));
});

test("a substrate surface node dropped from the hub ancestry fails the gate", () => {
  const dropped = ALL_SURFACE_NODES[0];
  const dag = dagFixture();
  // Remove the edge wiring `dropped` under the hub — node still exists, just unwired.
  dag.edges = dag.edges.filter((e) => e.from_node !== dropped);
  const { ok, findings } = runChecklist(dag);
  assert.equal(ok, false);
  assert.ok(
    blockingOf(findings).some(
      (f) =>
        f.check === "substrate" && f.message.includes(dropped) && f.message.includes("ancestor"),
    ),
  );
});

test("a substrate surface node missing from the DAG fails the gate", () => {
  const dropped = ALL_SURFACE_NODES[1];
  const dag = dagFixture();
  dag.nodes = dag.nodes.filter((n) => n.id !== dropped);
  const { ok, findings } = runChecklist(dag);
  assert.equal(ok, false);
  assert.ok(
    blockingOf(findings).some(
      (f) =>
        f.check === "substrate" && f.message.includes(dropped) && f.message.includes("resolve"),
    ),
  );
});

test("a dangling non-complete P1 rgt node warns but does not fail the gate", () => {
  const dag = dagFixture({
    extraNodes: [node("RGT-DANGLING", { status: "ready" })],
  });
  const { ok, findings } = runChecklist(dag);
  assert.equal(ok, true);
  const warns = warningsOf(findings);
  assert.equal(warns.length, 1);
  assert.ok(warns[0].check === "coverage" && warns[0].message.includes("RGT-DANGLING"));
});

test("a wired non-complete P1 rgt node does not warn", () => {
  const dag = dagFixture({
    extraNodes: [node("RGT-WIRED", { status: "ready" })],
    extraEdges: [{ from_node: "RGT-WIRED", to_node: HUB_ID }],
  });
  const { findings } = runChecklist(dag);
  assert.equal(warningsOf(findings).length, 0);
});

test("a cancelled P1 rgt node is excluded from the coverage invariant", () => {
  const dag = dagFixture({
    extraNodes: [node("RGT-CANCELLED", { status: "cancelled" })],
  });
  const { ok, findings } = runChecklist(dag);
  assert.equal(ok, true);
  assert.equal(warningsOf(findings).length, 0);
});

test("a transitively-wired substrate node counts as an ancestor", () => {
  // Wire the first surface node through an intermediate rather than directly.
  const first = ALL_SURFACE_NODES[0];
  const dag = dagFixture();
  dag.edges = dag.edges.filter((e) => e.from_node !== first);
  dag.nodes.push(node("INTERMEDIATE", { status: "done" }));
  dag.edges.push({ from_node: first, to_node: "INTERMEDIATE" });
  dag.edges.push({ from_node: "INTERMEDIATE", to_node: HUB_ID });
  const { ok } = runChecklist(dag);
  assert.equal(ok, true);
});

test("ancestorsOf follows the dependsOn map transitively", () => {
  const dag = {
    schema_version: 1,
    nodes: [node("A"), node("B"), node("C")],
    edges: [
      { from_node: "A", to_node: "B" },
      { from_node: "B", to_node: "C" },
    ],
  };
  const { dependsOn } = indexDag(dag);
  const anc = ancestorsOf("C", dependsOn);
  assert.ok(anc.has("A") && anc.has("B"));
});
