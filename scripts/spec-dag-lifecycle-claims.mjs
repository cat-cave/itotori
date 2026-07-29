import { createHash } from "node:crypto";
import { closeSync, mkdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

import {
  applyNodePatchInMemory,
  assertActiveClaimMatches,
  assertClaimLockMatches,
  assertLegacyLifecycleWritableDag,
  assertNodeIsReadyToClaim,
  clearMatchingStaleDagClaim,
  createClaimLock,
  readClaimLock,
  readJson,
  removeStaleClaimLock,
  requireNode,
  retireClaimLock,
  writeJsonAtomic,
} from "./spec-dag-lifecycle-internal.mjs";

export function defaultBranchForNode(nodeId) {
  return `spec/${nodeId.toLowerCase()}`;
}

export function defaultWorktreeForNode(nodeId) {
  return `/scratch/worktrees/itotori-spec-${nodeId.toLowerCase()}`;
}

export function defaultClaimLockPath(lockDir, nodeId) {
  return resolve(lockDir, `${nodeId}.json`);
}

export function defaultClaimLockDir(cwd = process.cwd()) {
  const result = spawnSync("git", ["rev-parse", "--git-common-dir"], {
    cwd,
    encoding: "utf8",
  });
  if (result.status === 0 && result.stdout.trim()) {
    const commonDir = resolve(cwd, result.stdout.trim());
    const repoKey = createHash("sha256").update(commonDir).digest("hex").slice(0, 16);
    return resolve(tmpdir(), "itotori-spec-dag-claims", repoKey);
  }
  return resolve(cwd, ".tmp/spec-dag/claims");
}

export function createClaimPlan(dag, nodeId, options = {}) {
  const node = requireNode(dag, nodeId);
  const owner = requiredOption(options.owner, "--owner");
  const branch = options.branch ?? node.branch ?? defaultBranchForNode(nodeId);
  const worktree = options.worktree ?? node.worktree ?? defaultWorktreeForNode(nodeId);
  assertNodeIsReadyToClaim(dag, node);

  return {
    action: "claim",
    mode: options.apply ? "apply" : "dry-run",
    defaultMutating: false,
    nodeId,
    lockPath: defaultClaimLockPath(options.lockDir ?? ".tmp/spec-dag/claims", nodeId),
    lockRecovery: {
      staleAfterHours: options.staleAfterHours ?? 24,
      forceStale: options.forceStale === true,
      release: false,
    },
    nodePatch: {
      status: "in_progress",
      owner,
      branch,
      worktree,
    },
    mergeAuthority: "human_or_orchestrator_after_ci_and_audit_gates",
  };
}

export function createClaimReleasePlan(dag, nodeId, options = {}) {
  const node = requireNode(dag, nodeId);
  const owner = requiredOption(options.owner, "--owner");
  const branch = options.branch ?? node.branch ?? defaultBranchForNode(nodeId);
  const worktree = options.worktree ?? node.worktree ?? defaultWorktreeForNode(nodeId);
  const lockPath = defaultClaimLockPath(options.lockDir ?? ".tmp/spec-dag/claims", nodeId);
  return {
    action: "claim-release",
    mode: options.apply ? "apply" : "dry-run",
    defaultMutating: false,
    nodeId,
    lockPath,
    branch,
    worktree,
    releaseOwner: owner,
    lockRecovery: {
      release: true,
      allowedWhen:
        "the existing lock owner matches --owner; in_progress DAG metadata is cleared only when it also matches --owner/--branch/--worktree",
    },
    nodePatch:
      node.status === "in_progress"
        ? {
            status: "planned",
          }
        : undefined,
    clearsClaimFields:
      node.status === "in_progress"
        ? ["owner", "branch", "worktree", "statusReason", "blockedBy"]
        : [],
  };
}

export function applyClaim({
  dagPath,
  lockDir,
  nodeId,
  owner,
  branch,
  worktree,
  now = new Date(),
  forceStale = false,
  staleAfterHours = 24,
}) {
  const initialDag = readJson(dagPath);
  assertLegacyLifecycleWritableDag(initialDag, "claim");
  mkdirSync(lockDir, { recursive: true });
  const lockPath = defaultClaimLockPath(lockDir, nodeId);
  const staleCandidate = forceStale ? readClaimLock(lockPath) : undefined;
  if (staleCandidate) {
    const node = requireNode(initialDag, nodeId);
    if (node.status === "in_progress") {
      assertActiveClaimMatches(node, {
        owner: staleCandidate.owner,
        branch: staleCandidate.branch,
        worktree: staleCandidate.worktree,
      });
    }
  }
  const staleLock = forceStale
    ? removeStaleClaimLock(lockPath, { nodeId, now, staleAfterHours })
    : undefined;
  const fd = createClaimLock(lockPath, {
    schemaVersion: "0.1.0",
    nodeId,
    owner,
    branch,
    worktree,
    claimedAt: now.toISOString(),
    staleAfterHours,
  });
  let lockCommitted = false;
  try {
    const dag = readJson(dagPath);
    assertLegacyLifecycleWritableDag(dag, "claim");
    if (staleLock) {
      clearMatchingStaleDagClaim(dag, staleLock);
    }
    const plan = createClaimPlan(dag, nodeId, {
      apply: true,
      owner,
      branch,
      worktree,
      lockDir,
      forceStale,
      staleAfterHours,
    });
    applyNodePatchInMemory(dag, nodeId, plan.nodePatch);
    writeJsonAtomic(dagPath, dag);
    lockCommitted = true;
    return { ...plan, lockAcquired: true, recoveredStaleLock: staleLock ? lockPath : undefined };
  } finally {
    closeSync(fd);
    if (!lockCommitted) {
      // Leave no stale lock when the DAG re-read or write fails before the claim is durable.
      try {
        unlinkSync(lockPath);
      } catch {
        // Best effort only; callers still get the original failure.
      }
    }
  }
}

export function applyClaimRelease({ dagPath, lockDir, nodeId, owner, branch, worktree }) {
  const lockPath = defaultClaimLockPath(lockDir, nodeId);
  const dag = readJson(dagPath);
  assertLegacyLifecycleWritableDag(dag, "claim --release");
  const plan = createClaimReleasePlan(dag, nodeId, {
    apply: true,
    owner,
    branch,
    worktree,
    lockDir,
  });
  const lock = readClaimLock(lockPath);
  if (lock) {
    assertClaimLockMatches(lock, { nodeId, owner, branch, worktree });
  }
  const node = requireNode(dag, nodeId);
  let dagReleased = false;
  if (node.status === "in_progress") {
    assertActiveClaimMatches(node, { owner, branch, worktree });
    for (const field of plan.clearsClaimFields) {
      delete node[field];
    }
    Object.assign(node, plan.nodePatch);
    writeJsonAtomic(dagPath, dag);
    dagReleased = true;
  }
  retireClaimLock(lockPath);
  return { ...plan, lockReleased: Boolean(lock), dagReleased };
}

export function createWorktreePlan(dag, nodeId, options = {}) {
  const node = requireNode(dag, nodeId);
  const base = options.base ?? "main";
  const branch = options.branch ?? node.branch ?? defaultBranchForNode(nodeId);
  const worktree = options.worktree ?? node.worktree ?? defaultWorktreeForNode(nodeId);

  return {
    action: "worktree",
    mode: options.apply ? "apply" : "dry-run",
    defaultMutating: false,
    nodeId,
    branch,
    worktree,
    base,
    commands: [
      ["git", "branch", "--list", branch],
      ["git", "worktree", "list", "--porcelain"],
      ["git", "worktree", "add", "-b", branch, worktree, base],
    ],
    requiresClaim:
      node.status === "in_progress"
        ? "node already has in_progress DAG metadata"
        : "run claim --apply first or claim immediately after successful worktree creation",
  };
}

export function applyWorktreePlan(plan, options = {}) {
  if (plan.action !== "worktree") {
    throw new Error("applyWorktreePlan requires a worktree plan");
  }
  const result = spawnSync(
    "git",
    ["worktree", "add", "-b", plan.branch, plan.worktree, plan.base],
    {
      cwd: options.cwd,
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "git worktree add failed").trim());
  }
  return { ...plan, gitStatus: result.status, stdout: result.stdout.trim() };
}

function requiredOption(value, name) {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}
