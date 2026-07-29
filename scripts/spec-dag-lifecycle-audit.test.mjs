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
import {
  appendFinding,
  blockingFinding,
  draftFinding,
  sampleAuditReport,
  sampleDag,
  sampleQdExportDag,
} from "./spec-dag-lifecycle-fixtures.mjs";

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
