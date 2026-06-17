import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  applyClaim,
  applyClaimRelease,
  applyCompletionPlan,
  createAuditIngestionPlan,
  createCompletionPlan,
  defaultClaimLockPath,
} from "./spec-dag-lifecycle.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("atomic claim locks prevent two agents claiming the same node", () => {
  const dir = mkdtempSync(join(tmpdir(), "spec-dag-claim-"));
  const dagPath = join(dir, "spec-dag.json");
  const lockDir = join(dir, "claims");
  writeFileSync(dagPath, `${JSON.stringify(sampleDag(), null, 2)}\n`);

  const first = applyClaim({
    dagPath,
    lockDir,
    nodeId: "UNIV-009",
    owner: "agent-a",
    branch: "spec/univ-009",
    worktree: "/tmp/itotori-spec-univ-009",
    now: new Date("2026-06-16T12:00:00Z"),
  });

  assert.equal(first.lockAcquired, true);
  assert.throws(
    () =>
      applyClaim({
        dagPath,
        lockDir,
        nodeId: "UNIV-009",
        owner: "agent-b",
        branch: "spec/univ-009-b",
        worktree: "/tmp/itotori-spec-univ-009-b",
        now: new Date("2026-06-16T12:00:01Z"),
      }),
    /claim lock already exists/,
  );

  const updatedDag = JSON.parse(readFileSync(dagPath, "utf8"));
  const node = updatedDag.nodes.find((candidate) => candidate.id === "UNIV-009");
  assert.equal(node.status, "in_progress");
  assert.equal(node.owner, "agent-a");
});

test("force-stale recovers an expired matching claim lock and DAG claim", () => {
  const dir = mkdtempSync(join(tmpdir(), "spec-dag-stale-claim-"));
  const dagPath = join(dir, "spec-dag.json");
  const lockDir = join(dir, "claims");
  writeFileSync(dagPath, `${JSON.stringify(sampleDag(), null, 2)}\n`);

  applyClaim({
    dagPath,
    lockDir,
    nodeId: "UNIV-009",
    owner: "agent-a",
    branch: "spec/univ-009",
    worktree: "/tmp/itotori-spec-univ-009",
    now: new Date("2026-06-16T12:00:00Z"),
    staleAfterHours: 1,
  });

  const recovered = applyClaim({
    dagPath,
    lockDir,
    nodeId: "UNIV-009",
    owner: "agent-b",
    branch: "spec/univ-009-b",
    worktree: "/tmp/itotori-spec-univ-009-b",
    now: new Date("2026-06-16T14:00:00Z"),
    forceStale: true,
    staleAfterHours: 1,
  });

  assert.equal(recovered.lockAcquired, true);
  assert.equal(recovered.recoveredStaleLock, defaultClaimLockPath(lockDir, "UNIV-009"));
  const updatedDag = JSON.parse(readFileSync(dagPath, "utf8"));
  const node = updatedDag.nodes.find((candidate) => candidate.id === "UNIV-009");
  assert.equal(node.status, "in_progress");
  assert.equal(node.owner, "agent-b");
  assert.equal(node.branch, "spec/univ-009-b");
});

test("force-stale refuses fresh locks", () => {
  const dir = mkdtempSync(join(tmpdir(), "spec-dag-fresh-claim-"));
  const dagPath = join(dir, "spec-dag.json");
  const lockDir = join(dir, "claims");
  writeFileSync(dagPath, `${JSON.stringify(sampleDag(), null, 2)}\n`);

  applyClaim({
    dagPath,
    lockDir,
    nodeId: "UNIV-009",
    owner: "agent-a",
    branch: "spec/univ-009",
    worktree: "/tmp/itotori-spec-univ-009",
    now: new Date("2026-06-16T12:00:00Z"),
    staleAfterHours: 1,
  });

  assert.throws(
    () =>
      applyClaim({
        dagPath,
        lockDir,
        nodeId: "UNIV-009",
        owner: "agent-b",
        branch: "spec/univ-009-b",
        worktree: "/tmp/itotori-spec-univ-009-b",
        now: new Date("2026-06-16T12:30:00Z"),
        forceStale: true,
        staleAfterHours: 1,
      }),
    /is not stale/,
  );
});

test("force-stale refuses to remove a stale lock when DAG ownership differs", () => {
  const dir = mkdtempSync(join(tmpdir(), "spec-dag-stale-mismatch-"));
  const dagPath = join(dir, "spec-dag.json");
  const lockDir = join(dir, "claims");
  writeFileSync(dagPath, `${JSON.stringify(sampleDag(), null, 2)}\n`);

  applyClaim({
    dagPath,
    lockDir,
    nodeId: "UNIV-009",
    owner: "agent-a",
    branch: "spec/univ-009",
    worktree: "/tmp/itotori-spec-univ-009",
    now: new Date("2026-06-16T12:00:00Z"),
    staleAfterHours: 1,
  });
  const dag = JSON.parse(readFileSync(dagPath, "utf8"));
  dag.nodes.find((candidate) => candidate.id === "UNIV-009").owner = "agent-c";
  writeFileSync(dagPath, `${JSON.stringify(dag, null, 2)}\n`);

  assert.throws(
    () =>
      applyClaim({
        dagPath,
        lockDir,
        nodeId: "UNIV-009",
        owner: "agent-b",
        branch: "spec/univ-009-b",
        worktree: "/tmp/itotori-spec-univ-009-b",
        now: new Date("2026-06-16T14:00:00Z"),
        forceStale: true,
        staleAfterHours: 1,
      }),
    /active DAG owner agent-c does not match agent-a/,
  );
  assert.equal(existsSync(defaultClaimLockPath(lockDir, "UNIV-009")), true);
});

test("claim release removes a matching lock and clears active DAG claim fields", () => {
  const dir = mkdtempSync(join(tmpdir(), "spec-dag-release-claim-"));
  const dagPath = join(dir, "spec-dag.json");
  const lockDir = join(dir, "claims");
  writeFileSync(dagPath, `${JSON.stringify(sampleDag(), null, 2)}\n`);

  applyClaim({
    dagPath,
    lockDir,
    nodeId: "UNIV-009",
    owner: "agent-a",
    branch: "spec/univ-009",
    worktree: "/tmp/itotori-spec-univ-009",
    now: new Date("2026-06-16T12:00:00Z"),
  });

  const release = applyClaimRelease({
    dagPath,
    lockDir,
    nodeId: "UNIV-009",
    owner: "agent-a",
    branch: "spec/univ-009",
    worktree: "/tmp/itotori-spec-univ-009",
  });

  assert.equal(release.lockReleased, true);
  assert.equal(release.dagReleased, true);
  assert.equal(existsSync(defaultClaimLockPath(lockDir, "UNIV-009")), false);
  const updatedDag = JSON.parse(readFileSync(dagPath, "utf8"));
  const node = updatedDag.nodes.find((candidate) => candidate.id === "UNIV-009");
  assert.equal(node.status, "planned");
  assert.equal("owner" in node, false);
  assert.equal("branch" in node, false);
  assert.equal("worktree" in node, false);
});

test("completion removes the completed node claim lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "spec-dag-complete-claim-"));
  const dagPath = join(dir, "spec-dag.json");
  const lockDir = join(dir, "claims");
  writeFileSync(dagPath, `${JSON.stringify(sampleDag(), null, 2)}\n`);

  applyClaim({
    dagPath,
    lockDir,
    nodeId: "UNIV-009",
    owner: "agent-a",
    branch: "spec/univ-009",
    worktree: "/tmp/itotori-spec-univ-009",
    now: new Date("2026-06-16T12:00:00Z"),
  });
  const dag = JSON.parse(readFileSync(dagPath, "utf8"));
  const plan = createCompletionPlan(dag, "UNIV-009", {
    apply: true,
    lockDir,
    report: sampleAuditReport(),
  });

  applyCompletionPlan({ dagPath, plan });

  assert.equal(existsSync(defaultClaimLockPath(lockDir, "UNIV-009")), false);
  const updatedDag = JSON.parse(readFileSync(dagPath, "utf8"));
  const node = updatedDag.nodes.find((candidate) => candidate.id === "UNIV-009");
  assert.equal(node.status, "complete");
  assert.equal("owner" in node, false);
});

test("completion refuses in_progress nodes with incomplete dependencies", () => {
  const dir = mkdtempSync(join(tmpdir(), "spec-dag-incomplete-complete-"));
  const dagPath = join(dir, "spec-dag.json");
  const lockDir = join(dir, "claims");
  const dag = sampleDag();
  const node = dag.nodes.find((candidate) => candidate.id === "UNIV-010");
  Object.assign(node, {
    status: "in_progress",
    owner: "agent-a",
    branch: "spec/univ-010",
    worktree: "/tmp/itotori-spec-univ-010",
  });
  writeFileSync(dagPath, `${JSON.stringify(dag, null, 2)}\n`);
  writeClaimLock(lockDir, node);

  const plan = createCompletionPlan(dag, "UNIV-010", {
    apply: true,
    lockDir,
    report: sampleAuditReportForNode(node),
  });

  assert.equal(plan.canApply, false);
  assert.match(plan.refusalReason, /dependencies are incomplete: UNIV-009/);
  assert.throws(() => applyCompletionPlan({ dagPath, plan }), /dependencies are incomplete/);
  assert.equal(existsSync(defaultClaimLockPath(lockDir, "UNIV-010")), true);
  assert.equal(readFileSync(dagPath, "utf8"), `${JSON.stringify(dag, null, 2)}\n`);
});

test("completion refuses planned unclaimed nodes", () => {
  const dir = mkdtempSync(join(tmpdir(), "spec-dag-planned-complete-"));
  const dagPath = join(dir, "spec-dag.json");
  const lockDir = join(dir, "claims");
  const dag = sampleDag();
  writeFileSync(dagPath, `${JSON.stringify(dag, null, 2)}\n`);

  const plan = createCompletionPlan(dag, "UNIV-009", {
    apply: true,
    lockDir,
    report: sampleAuditReport(),
  });

  assert.equal(plan.canApply, false);
  assert.match(plan.refusalReason, /node is planned, not in_progress/);
  assert.match(plan.refusalReason, /node has no owner claim metadata/);
  assert.throws(() => applyCompletionPlan({ dagPath, plan }), /not in_progress/);
  assert.equal(readFileSync(dagPath, "utf8"), `${JSON.stringify(dag, null, 2)}\n`);
});

test("completion validates the hypothetical DAG before writing or retiring the lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "spec-dag-invalid-complete-"));
  const dagPath = join(dir, "spec-dag.json");
  const lockDir = join(dir, "claims");
  const dag = sampleDag({
    status: "in_progress",
    owner: "agent-a",
    branch: "spec/univ-009",
    worktree: "/tmp/itotori-spec-univ-009",
  });
  writeFileSync(dagPath, `${JSON.stringify(dag, null, 2)}\n`);
  writeClaimLock(
    lockDir,
    dag.nodes.find((candidate) => candidate.id === "UNIV-009"),
  );
  const plan = createCompletionPlan(dag, "UNIV-009", {
    apply: true,
    lockDir,
    report: sampleAuditReport(),
  });

  assert.equal(plan.canApply, true);
  assert.throws(
    () =>
      applyCompletionPlan({
        dagPath,
        plan,
        validateDag: () => ({ errors: ["synthetic validation failure"] }),
      }),
    /completion would violate spec-dag validate invariants: synthetic validation failure/,
  );
  assert.equal(existsSync(defaultClaimLockPath(lockDir, "UNIV-009")), true);
  assert.equal(readFileSync(dagPath, "utf8"), `${JSON.stringify(dag, null, 2)}\n`);
});

test("CLI lifecycle defaults are dry-run and do not create lock, worktree, or follow-up files", () => {
  const dagPath = resolve(repoRoot, "roadmap/spec-dag.json");
  const before = readFileSync(dagPath, "utf8");
  const dag = JSON.parse(before);
  const node = firstReadyPlannedNode(dag);
  const dir = mkdtempSync(join(tmpdir(), "spec-dag-cli-dry-run-"));
  const lockDir = join(dir, "claims");
  const worktree = join(dir, "worktree");
  const reportPath = join(dir, "audit-report.json");
  const followUpsPath = join(dir, "follow-ups.json");
  writeFileSync(reportPath, `${JSON.stringify(sampleAuditReportForNode(node), null, 2)}\n`);

  runSpecDag(["claim", node.id, "--owner", "dry-run-test", "--lock-dir", lockDir]);
  assert.equal(existsSync(defaultClaimLockPath(lockDir, node.id)), false);

  runSpecDag(["worktree", node.id, "--worktree", worktree]);
  assert.equal(existsSync(worktree), false);

  runSpecDag(["ingest-audit", reportPath]);
  assert.equal(existsSync(followUpsPath), false);

  runSpecDag(["complete", node.id, "--audit", reportPath, "--lock-dir", lockDir]);
  assert.equal(existsSync(defaultClaimLockPath(lockDir, node.id)), false);
  assert.equal(readFileSync(dagPath, "utf8"), before);
});

test("CLI claim --apply creates a lock and in_progress DAG claim", () => {
  withRepoDagRestored(() => {
    const dagPath = resolve(repoRoot, "roadmap/spec-dag.json");
    const dag = JSON.parse(readFileSync(dagPath, "utf8"));
    const node = firstReadyPlannedNode(dag);
    const dir = mkdtempSync(join(tmpdir(), "spec-dag-cli-claim-apply-"));
    const lockDir = join(dir, "claims");

    runSpecDag(["claim", node.id, "--owner", "cli-claim-test", "--lock-dir", lockDir, "--apply"]);

    assert.equal(existsSync(defaultClaimLockPath(lockDir, node.id)), true);
    const updatedDag = JSON.parse(readFileSync(dagPath, "utf8"));
    const updatedNode = updatedDag.nodes.find((candidate) => candidate.id === node.id);
    assert.equal(updatedNode.status, "in_progress");
    assert.equal(updatedNode.owner, "cli-claim-test");
  });
});

test("CLI claim --release --apply removes the lock and clears DAG claim metadata", () => {
  withRepoDagRestored(() => {
    const dagPath = resolve(repoRoot, "roadmap/spec-dag.json");
    const dag = JSON.parse(readFileSync(dagPath, "utf8"));
    const node = firstReadyPlannedNode(dag);
    const dir = mkdtempSync(join(tmpdir(), "spec-dag-cli-claim-release-"));
    const lockDir = join(dir, "claims");

    runSpecDag(["claim", node.id, "--owner", "cli-release-test", "--lock-dir", lockDir, "--apply"]);
    runSpecDag([
      "claim",
      node.id,
      "--owner",
      "cli-release-test",
      "--lock-dir",
      lockDir,
      "--release",
      "--apply",
    ]);

    assert.equal(existsSync(defaultClaimLockPath(lockDir, node.id)), false);
    const updatedDag = JSON.parse(readFileSync(dagPath, "utf8"));
    const updatedNode = updatedDag.nodes.find((candidate) => candidate.id === node.id);
    assert.equal(updatedNode.status, "planned");
    assert.equal("owner" in updatedNode, false);
    assert.equal("branch" in updatedNode, false);
    assert.equal("worktree" in updatedNode, false);
  });
});

test("CLI claim --force-stale --apply recovers an expired matching lock", () => {
  withRepoDagRestored(() => {
    const dagPath = resolve(repoRoot, "roadmap/spec-dag.json");
    const dag = JSON.parse(readFileSync(dagPath, "utf8"));
    const node = firstReadyPlannedNode(dag);
    const dir = mkdtempSync(join(tmpdir(), "spec-dag-cli-force-stale-"));
    const lockDir = join(dir, "claims");

    runSpecDag([
      "claim",
      node.id,
      "--owner",
      "cli-stale-a",
      "--lock-dir",
      lockDir,
      "--stale-after-hours",
      "1",
      "--apply",
    ]);
    const lockPath = defaultClaimLockPath(lockDir, node.id);
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    writeFileSync(
      lockPath,
      `${JSON.stringify({ ...lock, claimedAt: "2000-01-01T00:00:00.000Z" }, null, 2)}\n`,
    );
    runSpecDag([
      "claim",
      node.id,
      "--owner",
      "cli-stale-b",
      "--lock-dir",
      lockDir,
      "--force-stale",
      "--stale-after-hours",
      "1",
      "--apply",
    ]);

    const updatedDag = JSON.parse(readFileSync(dagPath, "utf8"));
    const updatedNode = updatedDag.nodes.find((candidate) => candidate.id === node.id);
    assert.equal(updatedNode.status, "in_progress");
    assert.equal(updatedNode.owner, "cli-stale-b");
    const updatedLock = JSON.parse(readFileSync(lockPath, "utf8"));
    assert.equal(updatedLock.owner, "cli-stale-b");
  });
});

test("CLI complete --apply completes only an active claimed node and retires its lock", () => {
  withRepoDagRestored(() => {
    const dagPath = resolve(repoRoot, "roadmap/spec-dag.json");
    const dag = JSON.parse(readFileSync(dagPath, "utf8"));
    const node = firstReadyPlannedNode(dag);
    const dir = mkdtempSync(join(tmpdir(), "spec-dag-cli-complete-"));
    const lockDir = join(dir, "claims");
    const reportPath = join(dir, "audit-report.json");

    runSpecDag([
      "claim",
      node.id,
      "--owner",
      "cli-complete-test",
      "--lock-dir",
      lockDir,
      "--apply",
    ]);
    const claimedDag = JSON.parse(readFileSync(dagPath, "utf8"));
    const claimedNode = claimedDag.nodes.find((candidate) => candidate.id === node.id);
    writeFileSync(
      reportPath,
      `${JSON.stringify(sampleAuditReportForNode(claimedNode), null, 2)}\n`,
    );

    runSpecDag(["complete", node.id, "--audit", reportPath, "--lock-dir", lockDir, "--apply"]);

    assert.equal(existsSync(defaultClaimLockPath(lockDir, node.id)), false);
    const updatedDag = JSON.parse(readFileSync(dagPath, "utf8"));
    const updatedNode = updatedDag.nodes.find((candidate) => candidate.id === node.id);
    assert.equal(updatedNode.status, "complete");
    assert.equal("owner" in updatedNode, false);
  });
});

test("P0 and P1 audit findings keep the node in blocked repair state", () => {
  const dag = sampleDag({
    status: "in_progress",
    owner: "agent-a",
    branch: "spec/univ-009",
    worktree: "/tmp/itotori-spec-univ-009",
  });
  const report = sampleAuditReport({
    findings: [blockingFinding("UNIV-009-F001", "P1")],
    completionDecision: "blocked",
    blockingFindingIds: ["UNIV-009-F001"],
  });

  const plan = createAuditIngestionPlan(dag, report);

  assert.equal(plan.repairState, "blocked_for_audit_repair");
  assert.deepEqual(plan.blockingFindingIds, ["UNIV-009-F001"]);
  assert.equal(plan.nodePatch.status, "blocked");
  assert.equal(plan.nodePatch.blockedBy, "audit:AUDIT-UNIV-009-20260616T120000Z");
  assert.match(plan.nodePatch.statusReason, /UNIV-009-F001/);
  assert.equal(plan.nodePatch.branch, "spec/univ-009");
  assert.equal(plan.nodePatch.worktree, "/tmp/itotori-spec-univ-009");
});

test("P2 and P3 audit findings generate draft follow-up payloads without hand-copying", () => {
  const dag = sampleDag();
  const report = sampleAuditReport({
    findings: [draftFinding("UNIV-009-F002", "P2"), appendFinding("UNIV-009-F003", "P3")],
    completionDecision: "complete_allowed",
    followUpFindingIds: ["UNIV-009-F002", "UNIV-009-F003"],
  });

  const plan = createAuditIngestionPlan(dag, report);

  assert.equal(plan.repairState, "none");
  assert.deepEqual(plan.followUpFindingIds, ["UNIV-009-F002", "UNIV-009-F003"]);
  assert.equal(plan.followUps.draftNodes.length, 1);
  assert.equal(plan.followUps.draftNodes[0].findingId, "UNIV-009-F002");
  assert.equal(plan.followUps.draftNodes[0].node.id, "UNIV-012");
  assert.equal(plan.followUps.draftNodes[0].node.status, "planned");
  assert.deepEqual(plan.followUps.draftNodes[0].node.acceptanceCriteria, [
    "Generated follow-up keeps the audit finding actionable.",
  ]);
  assert.deepEqual(plan.followUps.existingNodeUpdates, [
    {
      findingId: "UNIV-009-F003",
      severity: "P3",
      targetNodeId: "UNIV-011",
      acceptanceCriteria: ["Existing node receives the follow-up criterion."],
      auditFocus: ["Follow-up acceptance criteria are not lost"],
      notes: "Append-only follow-up update.",
    },
  ]);
});

test("completion bookkeeping refuses unrecorded P2/P3 follow-ups", () => {
  const dag = sampleDag({
    status: "in_progress",
    owner: "agent-a",
    branch: "spec/univ-009",
    worktree: "/tmp/itotori-spec-univ-009",
  });
  const report = sampleAuditReport({
    findings: [draftFinding("UNIV-009-F002", "P2")],
    completionDecision: "complete_allowed",
    followUpFindingIds: ["UNIV-009-F002"],
  });

  const plan = createCompletionPlan(dag, "UNIV-009", { report });

  assert.equal(plan.canApply, false);
  assert.match(plan.refusalReason, /UNIV-009-F002/);
  assert.equal(plan.gitMergeAttempted, false);
  assert.equal(plan.mergeAuthority, "human_or_orchestrator_after_ci_and_audit_gates");
});

function sampleDag(nodeOverrides = {}) {
  return {
    schemaVersion: "0.1.0",
    nodes: [
      {
        id: "UNIV-002",
        title: "Dependency",
        status: "complete",
        priority: "P1",
        target: "alpha",
        projects: ["universal"],
        parallelGroup: "roadmap-infra",
        dependsOn: [],
        summary: "Complete dependency.",
        deliverables: ["Dependency"],
        acceptanceCriteria: ["Dependency is complete"],
        verification: [{ type: "manual", value: "Reviewed" }],
        auditFocus: ["Dependency state"],
      },
      {
        id: "UNIV-009",
        title: "Orchestrator lifecycle CLI",
        status: "planned",
        priority: "P1",
        target: "alpha",
        projects: ["universal"],
        parallelGroup: "roadmap-infra",
        dependsOn: ["UNIV-002"],
        summary: "Implement orchestration lifecycle tooling.",
        deliverables: ["Claim", "Audit ingestion"],
        acceptanceCriteria: ["Two agents cannot claim the same node"],
        verification: [{ type: "command", value: "node scripts/spec-dag.mjs validate" }],
        auditFocus: ["Race conditions in claims"],
        ...nodeOverrides,
      },
      {
        id: "UNIV-010",
        title: "Incomplete dependency example",
        status: "planned",
        priority: "P1",
        target: "alpha",
        projects: ["universal"],
        parallelGroup: "roadmap-infra",
        dependsOn: ["UNIV-009"],
        summary: "Node used to prove completion cannot skip dependencies.",
        deliverables: ["Dependency guard"],
        acceptanceCriteria: ["Completion refuses incomplete dependencies"],
        verification: [{ type: "manual", value: "Reviewed" }],
        auditFocus: ["Completion dependency safety"],
      },
      {
        id: "UNIV-011",
        title: "Existing planned follow-up",
        status: "planned",
        priority: "P3",
        target: "continuous",
        projects: ["universal"],
        parallelGroup: "roadmap-infra",
        dependsOn: ["UNIV-009"],
        summary: "Existing follow-up node.",
        deliverables: ["Docs"],
        acceptanceCriteria: ["Existing criterion"],
        verification: [{ type: "manual", value: "Reviewed" }],
        auditFocus: ["Follow-up handling"],
      },
    ],
  };
}

function writeClaimLock(lockDir, node) {
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(
    defaultClaimLockPath(lockDir, node.id),
    `${JSON.stringify(
      {
        schemaVersion: "0.1.0",
        nodeId: node.id,
        owner: node.owner,
        branch: node.branch,
        worktree: node.worktree,
        claimedAt: "2026-06-16T12:00:00.000Z",
        staleAfterHours: 24,
      },
      null,
      2,
    )}\n`,
  );
}

function firstReadyPlannedNode(dag) {
  const ids = new Map(dag.nodes.map((node) => [node.id, node]));
  const node = dag.nodes.find(
    (candidate) =>
      candidate.status === "planned" &&
      candidate.dependsOn.every((dependency) => ids.get(dependency)?.status === "complete"),
  );
  if (!node) {
    throw new Error("test fixture requires at least one ready planned DAG node");
  }
  return node;
}

function withRepoDagRestored(fn) {
  const dagPath = resolve(repoRoot, "roadmap/spec-dag.json");
  const before = readFileSync(dagPath, "utf8");
  try {
    fn();
  } finally {
    writeFileSync(dagPath, before);
  }
}

function runSpecDag(args) {
  const result = spawnSync(process.execPath, ["scripts/spec-dag.mjs", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    0,
    `spec-dag ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

function sampleAuditReportForNode(node) {
  return {
    ...sampleAuditReport(),
    reportId: `AUDIT-${node.id}-20260616T120000Z`,
    spec: {
      id: node.id,
      title: node.title,
      branch: `spec/${node.id.toLowerCase()}`,
      worktree: `/tmp/itotori-spec-${node.id.toLowerCase()}`,
    },
  };
}

function sampleAuditReport(overrides = {}) {
  const findings = overrides.findings ?? [];
  return {
    schemaVersion: "0.1.0",
    reportId: "AUDIT-UNIV-009-20260616T120000Z",
    generatedAt: "2026-06-16T12:00:00Z",
    spec: {
      id: "UNIV-009",
      title: "Orchestrator lifecycle CLI",
      branch: "spec/univ-009",
      worktree: "/tmp/itotori-spec-univ-009",
    },
    auditor: {
      name: "unit-test-audit",
      kind: "orchestration",
    },
    humanSummary: {
      outcome: findings.some((finding) => ["P0", "P1"].includes(finding.severity))
        ? "blocked"
        : findings.length > 0
          ? "follow_up_only"
          : "pass",
      text: "Unit test report.",
      counts: {
        P0: findings.filter((finding) => finding.severity === "P0").length,
        P1: findings.filter((finding) => finding.severity === "P1").length,
        P2: findings.filter((finding) => finding.severity === "P2").length,
        P3: findings.filter((finding) => finding.severity === "P3").length,
      },
    },
    orchestration: {
      completionDecision: overrides.completionDecision ?? "complete_allowed",
      blockingFindingIds: overrides.blockingFindingIds ?? [],
      followUpFindingIds: overrides.followUpFindingIds ?? [],
    },
    findings,
  };
}

function blockingFinding(id, severity) {
  return {
    id,
    severity,
    title: "Blocking lifecycle issue",
    category: "orchestration",
    locations: [{ path: "scripts/spec-dag.mjs" }],
    description: "The node must be repaired before completion.",
    evidence: [{ kind: "manual", detail: "Unit test evidence." }],
    impact: "Completion would lose a blocking finding.",
    actionableAcceptanceCriteria: ["Repair the blocking lifecycle issue."],
    orchestration: {
      blocksCompletion: true,
      nextAction: "repair_before_completion",
    },
  };
}

function draftFinding(id, severity) {
  return {
    id,
    severity,
    title: "Generated follow-up",
    category: "orchestration",
    locations: [{ path: "docs/audit-playbook.md" }],
    description: "The finding should become a planned DAG node.",
    evidence: [{ kind: "manual", detail: "Unit test evidence." }],
    impact: "Manual hand-copying would risk losing the finding.",
    actionableAcceptanceCriteria: ["Generated follow-up keeps the audit finding actionable."],
    orchestration: {
      blocksCompletion: false,
      nextAction: "draft_new_dag_node",
      proposedDagNode: {
        idPrefix: "UNIV",
        title: "Generated follow-up",
        priority: severity,
        target: "continuous",
        projects: ["universal"],
        parallelGroup: "roadmap-infra",
        dependsOn: ["UNIV-009"],
        summary: "Generated from a P2/P3 audit finding.",
        deliverables: ["Follow-up payload"],
        acceptanceCriteria: ["Generated follow-up keeps the audit finding actionable."],
        verification: [{ type: "manual", value: "Review generated follow-up payload" }],
        auditFocus: ["Generated follow-up preserves audit evidence"],
      },
    },
  };
}

function appendFinding(id, severity) {
  return {
    id,
    severity,
    title: "Append follow-up",
    category: "documentation",
    locations: [{ path: "docs/spec-dag.md" }],
    description: "The finding should append to an existing planned node.",
    evidence: [{ kind: "manual", detail: "Unit test evidence." }],
    impact: "Manual hand-copying would risk losing the finding.",
    actionableAcceptanceCriteria: ["Existing node receives the follow-up criterion."],
    orchestration: {
      blocksCompletion: false,
      nextAction: "append_to_existing_dag_node",
      existingDagNodeUpdate: {
        targetNodeId: "UNIV-011",
        acceptanceCriteria: ["Existing node receives the follow-up criterion."],
        auditFocus: ["Follow-up acceptance criteria are not lost"],
        notes: "Append-only follow-up update.",
      },
    },
  };
}
