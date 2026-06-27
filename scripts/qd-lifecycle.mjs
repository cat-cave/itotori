const DISPOSED_AUDIT_STATUSES = new Set(["cancelled", "superseded"]);

export function runningAuditRunsFromNodeShow(nodeShow) {
  const runs = Array.isArray(nodeShow?.runs)
    ? nodeShow.runs
    : Array.isArray(nodeShow?.audits)
      ? nodeShow.audits
      : [];

  return runs.filter((run) => {
    return (
      run &&
      run.kind === "audit" &&
      run.status === "running" &&
      (run.finished_at === null || run.finished_at === undefined)
    );
  });
}

export function auditLifecycleGateResult(nodeId, baseGateResult, runningAuditRuns) {
  const auditBlockers = runningAuditRuns.map((run) => ({
    id: run.id,
    node_id: run.node_id,
    kind: run.kind,
    status: run.status,
    started_at: run.started_at,
    finished_at: run.finished_at,
    summary: run.summary,
  }));

  if (auditBlockers.length > 0) {
    return {
      ok: false,
      code: "runningAuditRuns",
      nodeId,
      blocking_audits: auditBlockers,
      blocking: Array.isArray(baseGateResult?.blocking) ? baseGateResult.blocking : [],
    };
  }

  return baseGateResult ?? { ok: true, blocking: [] };
}

export function disposeAuditRunInSnapshot(
  snapshot,
  { nodeId, runId, status = "cancelled", rationale, finishedAt, startedAt, recordMissing = false },
) {
  if (!snapshot || !Array.isArray(snapshot.runs)) {
    throw new Error("qd snapshot must include runs[]");
  }
  if (!DISPOSED_AUDIT_STATUSES.has(status)) {
    throw new Error(`audit dispose status must be one of ${[...DISPOSED_AUDIT_STATUSES].join(", ")}`);
  }
  if (!rationale || !rationale.trim()) {
    throw new Error("audit dispose requires a non-empty rationale");
  }

  const now = finishedAt ?? new Date().toISOString();
  let run = snapshot.runs.find((candidate) => candidate.id === runId);
  let recordedMissing = false;

  if (!run && recordMissing) {
    run = {
      id: runId,
      node_id: nodeId,
      kind: "audit",
      status: "running",
      worktree_path: null,
      agent: null,
      started_at: startedAt ?? now,
      finished_at: null,
      summary: null,
      log_path: null,
    };
    snapshot.runs.push(run);
    recordedMissing = true;
  }

  if (!run) {
    throw new Error(`Audit run not found: ${runId}`);
  }
  if (run.node_id !== nodeId) {
    throw new Error(`Audit run ${runId} belongs to ${run.node_id}, not ${nodeId}`);
  }
  if (run.kind !== "audit") {
    throw new Error(`Run ${runId} is ${run.kind}, not audit`);
  }
  if (
    !recordedMissing &&
    !(run.status === "running" && (run.finished_at === null || run.finished_at === undefined))
  ) {
    throw new Error(`Audit run ${runId} is already closed with status ${run.status}`);
  }

  run.status = status;
  run.finished_at = now;
  run.summary = `Audit run ${status}: ${rationale.trim()}`;
  return { run, recordedMissing };
}
