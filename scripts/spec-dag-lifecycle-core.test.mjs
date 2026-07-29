import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyClaim,
  applyClaimRelease,
  applyCompletionPlan,
  createCompletionPlan,
  defaultClaimLockPath,
} from "./spec-dag-lifecycle.mjs";
import {
  sampleAuditReport,
  sampleAuditReportForNode,
  sampleDag,
  writeClaimLock,
} from "./spec-dag-lifecycle-fixtures.mjs";

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
