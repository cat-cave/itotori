import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyAuditIngestionPlan,
  applyClaim,
  applyClaimRelease,
  applyCompletionPlan,
  createAuditIngestionPlan,
  createCompletionPlan,
  defaultClaimLockPath,
} from "./spec-dag-lifecycle.mjs";
import { assertNoQdExportLifecycleApply } from "./spec-dag.mjs";

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
    worktree: "/scratch/worktrees/itotori-spec-univ-009",
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
        worktree: "/scratch/worktrees/itotori-spec-univ-009-b",
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
    worktree: "/scratch/worktrees/itotori-spec-univ-009",
    now: new Date("2026-06-16T12:00:00Z"),
    staleAfterHours: 1,
  });

  const recovered = applyClaim({
    dagPath,
    lockDir,
    nodeId: "UNIV-009",
    owner: "agent-b",
    branch: "spec/univ-009-b",
    worktree: "/scratch/worktrees/itotori-spec-univ-009-b",
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
    worktree: "/scratch/worktrees/itotori-spec-univ-009",
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
        worktree: "/scratch/worktrees/itotori-spec-univ-009-b",
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
    worktree: "/scratch/worktrees/itotori-spec-univ-009",
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
        worktree: "/scratch/worktrees/itotori-spec-univ-009-b",
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
    worktree: "/scratch/worktrees/itotori-spec-univ-009",
    now: new Date("2026-06-16T12:00:00Z"),
  });

  const release = applyClaimRelease({
    dagPath,
    lockDir,
    nodeId: "UNIV-009",
    owner: "agent-a",
    branch: "spec/univ-009",
    worktree: "/scratch/worktrees/itotori-spec-univ-009",
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
    worktree: "/scratch/worktrees/itotori-spec-univ-009",
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
    worktree: "/scratch/worktrees/itotori-spec-univ-010",
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
    worktree: "/scratch/worktrees/itotori-spec-univ-009",
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

test("legacy lifecycle apply helpers refuse qd export state without side effects", () => {
  const dir = mkdtempSync(join(tmpdir(), "spec-dag-qd-refusal-"));
  const dagPath = join(dir, "spec-dag.json");
  const lockDir = join(dir, "claims");
  const qdDag = sampleQdExportDag();
  const before = `${JSON.stringify(qdDag, null, 2)}\n`;
  writeFileSync(dagPath, before);

  assert.throws(
    () =>
      applyClaim({
        dagPath,
        lockDir,
        nodeId: "UNIV-009",
        owner: "agent-a",
        branch: "spec/univ-009",
        worktree: "/scratch/worktrees/itotori-spec-univ-009",
      }),
    /legacy spec-dag lifecycle --apply is disabled for qd export state/,
  );
  assert.equal(existsSync(defaultClaimLockPath(lockDir, "UNIV-009")), false);

  mkdirSync(lockDir, { recursive: true });
  writeFileSync(
    defaultClaimLockPath(lockDir, "UNIV-009"),
    `${JSON.stringify(
      {
        nodeId: "UNIV-009",
        owner: "agent-a",
        branch: "spec/univ-009",
        worktree: "/scratch/worktrees/itotori-spec-univ-009",
        claimedAt: "2026-06-16T12:00:00.000Z",
      },
      null,
      2,
    )}\n`,
  );
  assert.throws(
    () =>
      applyClaimRelease({
        dagPath,
        lockDir,
        nodeId: "UNIV-009",
        owner: "agent-a",
        branch: "spec/univ-009",
        worktree: "/scratch/worktrees/itotori-spec-univ-009",
      }),
    /claim --release refused: legacy spec-dag lifecycle --apply is disabled/,
  );
  assert.equal(existsSync(defaultClaimLockPath(lockDir, "UNIV-009")), true);

  assert.throws(
    () =>
      applyAuditIngestionPlan({
        dagPath,
        plan: {
          specId: "UNIV-009",
          nodePatch: {
            status: "blocked",
            statusReason: "Legacy blocked state must not enter qd export.",
            blockedBy: "audit:fixture",
          },
          followUps: { draftNodes: [], existingNodeUpdates: [] },
        },
      }),
    /ingest-audit refused: legacy spec-dag lifecycle --apply is disabled/,
  );

  assert.throws(
    () =>
      applyCompletionPlan({
        dagPath,
        plan: {
          canApply: true,
          nodeId: "UNIV-009",
          nodePatch: { status: "complete" },
          clearsClaimFields: ["owner", "branch", "worktree", "statusReason", "blockedBy"],
        },
      }),
    /complete refused: legacy spec-dag lifecycle --apply is disabled/,
  );
  assert.equal(readFileSync(dagPath, "utf8"), before);
});

test("CLI lifecycle guard refuses qd export legacy apply flags", () => {
  const qdDag = sampleQdExportDag();
  const cases = [
    ["claim", ["UNIV-009", "--owner", "cli-qd-refusal", "--apply"]],
    ["worktree", ["UNIV-009", "--apply"]],
    ["ingest-audit", ["missing-audit-report.json", "--apply"]],
    ["ingest-audit", ["missing-audit-report.json", "--apply-follow-ups"]],
    ["complete", ["UNIV-009", "--audit", "missing-audit-report.json", "--apply"]],
  ];

  for (const [command, args] of cases) {
    assert.throws(
      () => assertNoQdExportLifecycleApply(command, args, qdDag),
      /legacy spec-dag lifecycle --apply is disabled for qd export state/,
    );
  }
  assert.doesNotThrow(() => assertNoQdExportLifecycleApply("worktree", ["UNIV-009"], qdDag));
});

test("P0 and P1 audit findings keep the node in blocked repair state", () => {
  const dag = sampleDag({
    status: "in_progress",
    owner: "agent-a",
    branch: "spec/univ-009",
    worktree: "/scratch/worktrees/itotori-spec-univ-009",
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
  assert.equal(plan.nodePatch.worktree, "/scratch/worktrees/itotori-spec-univ-009");
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
    worktree: "/scratch/worktrees/itotori-spec-univ-009",
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
    metadata: {
      generatedFrom: "spec-dag-lifecycle.test.mjs",
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
    nodes: [
      {
        id: "ALPHA-005",
        title: "Alpha readiness milestone fixture",
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
      },
      {
        id: "RGT-005",
        title: "Real-game-testing-ready milestone fixture",
        status: "complete",
        priority: "P1",
        target: "real-game-testing-ready",
        projects: ["suite"],
        parallelGroup: "milestone",
        dependsOn: [],
        summary: "Fixture real-game-testing-ready milestone.",
        deliverables: ["RGT readiness fixture"],
        acceptanceCriteria: [
          "The fixture milestone exists for real-game-testing-ready path validation",
        ],
        verification: [{ type: "command", value: "node scripts/spec-dag.mjs validate" }],
        auditFocus: ["Fixture validity"],
      },
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
        target: "continuous",
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
        target: "continuous",
        projects: ["universal"],
        parallelGroup: "roadmap-infra",
        dependsOn: ["UNIV-009"],
        summary: "Node used to prove completion cannot skip dependencies.",
        deliverables: ["Dependency guard"],
        acceptanceCriteria: ["Completion refuses incomplete dependencies"],
        verification: [{ type: "command", value: "node scripts/spec-dag-lifecycle.test.mjs" }],
        auditFocus: ["Completion dependency safety"],
      },
      {
        id: "UNIV-011",
        title: "Existing lifecycle task",
        status: "planned",
        priority: "P3",
        target: "continuous",
        projects: ["universal"],
        parallelGroup: "roadmap-infra",
        dependsOn: ["UNIV-009"],
        summary: "Existing lifecycle task used for append-only audit finding tests.",
        deliverables: ["Lifecycle docs"],
        acceptanceCriteria: ["Existing criterion"],
        verification: [{ type: "manual", value: "Reviewed" }],
        auditFocus: ["Follow-up handling"],
      },
    ],
  };
}

function sampleQdExportDag() {
  return {
    schema_version: 1,
    registries: {
      milestones: [{ name: "continuous" }],
      groups: [{ name: "roadmap-infra" }],
      projects: [{ name: "universal" }],
    },
    nodes: [
      {
        id: "UNIV-009",
        title: "Orchestrator lifecycle CLI",
        status: "ready",
        priority: "P1",
        milestone: "continuous",
        projects: ["universal"],
        group_name: "roadmap-infra",
        spec: "Implement orchestration lifecycle tooling.\n\nDeliverables:\n- Claim\n- Audit ingestion",
        acceptance: "- Two agents cannot claim the same node",
        verification: [{ type: "command", value: "node scripts/spec-dag-lifecycle.test.mjs" }],
        audit_focus: ["Race conditions in claims"],
      },
    ],
    edges: [],
    findings: [],
    runs: [],
    node_notes: [],
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

function sampleAuditReportForNode(node) {
  return {
    ...sampleAuditReport(),
    reportId: `AUDIT-${node.id}-20260616T120000Z`,
    spec: {
      id: node.id,
      title: node.title,
      branch: `spec/${node.id.toLowerCase()}`,
      worktree: `/scratch/worktrees/itotori-spec-${node.id.toLowerCase()}`,
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
      worktree: "/scratch/worktrees/itotori-spec-univ-009",
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
