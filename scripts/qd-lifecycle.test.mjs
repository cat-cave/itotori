import assert from "node:assert/strict";
import test from "node:test";
import {
  auditLifecycleGateResult,
  disposeAuditRunInSnapshot,
  runningAuditRunsFromNodeShow,
} from "./qd-lifecycle.mjs";

const nodeShowWithRunningAudit = {
  node: { id: "CATALOG-003" },
  runs: [
    {
      id: "7ffce8d8-729b-4b4f-900a-0cea996a1096",
      node_id: "CATALOG-003",
      kind: "audit",
      status: "running",
      started_at: "2026-06-27T00:00:00.000Z",
      finished_at: null,
      summary: null,
    },
  ],
};

test("qd gate rejects a node with a running audit run", async () => {
  const runningAudits = runningAuditRunsFromNodeShow(nodeShowWithRunningAudit);
  const result = auditLifecycleGateResult(
    "CATALOG-003",
    { ok: true, blocking: [] },
    runningAudits,
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, "runningAuditRuns");
  assert.equal(result.blocking_audits[0].id, "7ffce8d8-729b-4b4f-900a-0cea996a1096");
});

test("qd gate succeeds after audit run disposition", async () => {
  const snapshot = {
    runs: [structuredClone(nodeShowWithRunningAudit.runs[0])],
  };

  disposeAuditRunInSnapshot(snapshot, {
    nodeId: "CATALOG-003",
    runId: "7ffce8d8-729b-4b4f-900a-0cea996a1096",
    status: "cancelled",
    rationale: "CATALOG-003 was already merged; stale worker run was abandoned.",
    finishedAt: "2026-06-27T01:00:00.000Z",
  });

  const disposedShow = { node: { id: "CATALOG-003" }, runs: snapshot.runs };
  assert.deepEqual(runningAuditRunsFromNodeShow(disposedShow), []);
  assert.deepEqual(auditLifecycleGateResult("CATALOG-003", { ok: true, blocking: [] }, []), {
    ok: true,
    blocking: [],
  });

  assert.equal(snapshot.runs[0].status, "cancelled");
  assert.equal(snapshot.runs[0].finished_at, "2026-06-27T01:00:00.000Z");
  assert.match(snapshot.runs[0].summary, /stale worker run was abandoned/u);
});
