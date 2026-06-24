import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const priorityRank = { P0: 0, P1: 1, P2: 2, P3: 3 };
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
  mkdirSync(lockDir, { recursive: true });
  const lockPath = defaultClaimLockPath(lockDir, nodeId);
  const staleCandidate = forceStale ? readClaimLock(lockPath) : undefined;
  if (staleCandidate) {
    const dag = readJson(dagPath);
    const node = requireNode(dag, nodeId);
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

export function createAuditIngestionPlan(dag, report, options = {}) {
  const node = requireNode(dag, report.spec.id);
  const blockingFindings = report.findings.filter((finding) =>
    isBlockingSeverity(finding.severity),
  );
  const followUpFindings = report.findings.filter(
    (finding) => !isBlockingSeverity(finding.severity),
  );
  const assignedIds = new Set((dag.nodes ?? []).map((candidate) => candidate.id));
  const draftNodes = [];
  const existingNodeUpdates = [];

  for (const finding of followUpFindings) {
    if (finding.orchestration.nextAction === "draft_new_dag_node") {
      const nodeDraft = nodeFromProposedDagNode(finding.orchestration.proposedDagNode, assignedIds);
      draftNodes.push({ findingId: finding.id, severity: finding.severity, node: nodeDraft });
      assignedIds.add(nodeDraft.id);
    } else if (finding.orchestration.nextAction === "append_to_existing_dag_node") {
      existingNodeUpdates.push({
        findingId: finding.id,
        severity: finding.severity,
        ...finding.orchestration.existingDagNodeUpdate,
      });
    }
  }

  const nodePatch =
    blockingFindings.length > 0
      ? {
          status: "blocked",
          statusReason: `Audit ${report.reportId} found blocking findings: ${blockingFindings.map((finding) => finding.id).join(", ")}`,
          blockedBy: `audit:${report.reportId}`,
          ...(node.owner ? { owner: node.owner } : {}),
          branch: node.branch ?? report.spec.branch,
          worktree: node.worktree ?? report.spec.worktree,
        }
      : undefined;

  return {
    action: "ingest-audit",
    mode: options.apply ? "apply" : "dry-run",
    defaultMutating: false,
    reportId: report.reportId,
    specId: report.spec.id,
    completionDecision: report.orchestration.completionDecision,
    blockingFindingIds: blockingFindings.map((finding) => finding.id),
    followUpFindingIds: followUpFindings.map((finding) => finding.id),
    nodePatch,
    repairState: blockingFindings.length > 0 ? "blocked_for_audit_repair" : "none",
    followUps: {
      draftNodes,
      existingNodeUpdates,
    },
    mergeAuthority: "human_or_orchestrator_after_ci_and_audit_gates",
  };
}

export function applyAuditIngestionPlan({ dagPath, plan, applyFollowUps = false }) {
  const dag = readJson(dagPath);
  if (plan.nodePatch) {
    applyNodePatchInMemory(dag, plan.specId, plan.nodePatch);
  }
  if (applyFollowUps) {
    for (const { node } of plan.followUps.draftNodes) {
      dag.nodes.push(node);
    }
    for (const update of plan.followUps.existingNodeUpdates) {
      appendExistingNodeUpdate(dag, update);
    }
  }
  writeJsonAtomic(dagPath, dag);
  return { ...plan, followUpsApplied: applyFollowUps };
}

export function createCompletionPlan(dag, nodeId, options = {}) {
  const node = requireNode(dag, nodeId);
  const report = options.report;
  if (report && report.spec.id !== nodeId) {
    throw new Error(`audit report spec.id ${report.spec.id} does not match ${nodeId}`);
  }
  const blockingFindingIds = report?.orchestration.blockingFindingIds ?? [];
  if (blockingFindingIds.length > 0) {
    throw new Error(
      `refusing completion while P0/P1 findings are open: ${blockingFindingIds.join(", ")}`,
    );
  }
  const followUpFindingIds = report?.orchestration.followUpFindingIds ?? [];
  const refusalReasons = completionSafetyErrors(dag, nodeId);
  if (followUpFindingIds.length > 0 && options.followUpsRecorded !== true) {
    refusalReasons.push(
      `follow-up findings must be recorded in the DAG or a durable artifact first: ${followUpFindingIds.join(", ")}`,
    );
  }
  const canApply = refusalReasons.length === 0;
  const lockPath = options.lockDir
    ? defaultClaimLockPath(options.lockDir, nodeId)
    : options.lockPath;
  return {
    action: "complete",
    mode: options.apply ? "apply" : "dry-run",
    defaultMutating: false,
    nodeId,
    canApply,
    refusalReason: canApply
      ? undefined
      : `${nodeId} cannot be completed: ${refusalReasons.join("; ")}`,
    nodePatch: {
      status: "complete",
    },
    lockPath,
    lockRecovery: lockPath
      ? {
          release: true,
          allowedWhen: "completion --apply succeeds for this node",
        }
      : undefined,
    clearsClaimFields: ["owner", "branch", "worktree", "statusReason", "blockedBy"],
    gitMergeAttempted: false,
    mergeAuthority: "human_or_orchestrator_after_ci_and_audit_gates",
    previousStatus: node.status,
  };
}

export function applyCompletionPlan({ dagPath, plan, validateDag }) {
  if (!plan.canApply) {
    throw new Error(plan.refusalReason);
  }
  const dag = readJson(dagPath);
  assertNodeIsSafelyCompletable(dag, plan.nodeId);
  const node = requireNode(dag, plan.nodeId);
  if (plan.lockPath) {
    const lock = readClaimLock(plan.lockPath);
    if (!lock) {
      throw new Error(`claim lock is required to complete ${plan.nodeId}: ${plan.lockPath}`);
    }
    assertClaimLockMatches(lock, {
      nodeId: plan.nodeId,
      owner: node.owner,
      branch: node.branch,
      worktree: node.worktree,
    });
  }
  const updatedDag = cloneJson(dag);
  const updatedNode = requireNode(updatedDag, plan.nodeId);
  for (const field of plan.clearsClaimFields) {
    delete updatedNode[field];
  }
  Object.assign(updatedNode, plan.nodePatch);
  validateHypotheticalCompletion(updatedDag, plan.nodeId, validateDag);
  writeJsonAtomic(dagPath, updatedDag);
  if (plan.lockPath) {
    retireClaimLock(plan.lockPath);
  }
  return plan;
}

function appendExistingNodeUpdate(dag, update) {
  const node = requireNode(dag, update.targetNodeId);
  node.acceptanceCriteria = uniqueStrings([
    ...node.acceptanceCriteria,
    ...update.acceptanceCriteria,
  ]);
  if (Array.isArray(update.verification) && update.verification.length > 0) {
    node.verification = uniqueVerification([...node.verification, ...update.verification]);
  }
  if (Array.isArray(update.auditFocus) && update.auditFocus.length > 0) {
    node.auditFocus = uniqueStrings([...node.auditFocus, ...update.auditFocus]);
  }
}

function nodeFromProposedDagNode(proposedNode, assignedIds) {
  const { idPrefix, ...nodeFields } = proposedNode;
  return {
    id: nextDagNodeId(idPrefix, assignedIds),
    status: "planned",
    ...nodeFields,
  };
}

function nextDagNodeId(prefix, assignedIds) {
  let max = 0;
  for (const id of assignedIds) {
    const match = id.match(new RegExp(`^${escapeRegExp(prefix)}-([0-9]{3})$`));
    if (match) {
      max = Math.max(max, Number(match[1]));
    }
  }
  for (let index = max + 1; index <= 999; index += 1) {
    const candidate = `${prefix}-${String(index).padStart(3, "0")}`;
    if (!assignedIds.has(candidate)) {
      return candidate;
    }
  }
  throw new Error(`no available DAG node id for prefix ${prefix}`);
}

function assertNodeIsReadyToClaim(dag, node) {
  if (node.status !== "planned") {
    throw new Error(`${node.id} is ${node.status}, not planned`);
  }
  const ids = new Map(dag.nodes.map((candidate) => [candidate.id, candidate]));
  const incompleteDependencies = node.dependsOn.filter(
    (dependency) => ids.get(dependency)?.status !== "complete",
  );
  if (incompleteDependencies.length > 0) {
    throw new Error(
      `${node.id} cannot be claimed until dependencies are complete: ${incompleteDependencies.join(", ")}`,
    );
  }
}

function assertNodeIsSafelyCompletable(dag, nodeId) {
  const errors = completionSafetyErrors(dag, nodeId);
  if (errors.length > 0) {
    throw new Error(`${nodeId} cannot be completed: ${errors.join("; ")}`);
  }
}

function completionSafetyErrors(dag, nodeId) {
  const node = requireNode(dag, nodeId);
  const errors = [];
  if (node.status !== "in_progress") {
    errors.push(`node is ${node.status}, not in_progress`);
  }
  if (!node.owner) {
    errors.push("node has no owner claim metadata");
  }
  if (!node.branch && !node.worktree) {
    errors.push("node has no branch or worktree claim metadata");
  }
  const ids = new Map((dag.nodes ?? []).map((candidate) => [candidate.id, candidate]));
  const incompleteDependencies = (node.dependsOn ?? []).filter(
    (dependency) => ids.get(dependency)?.status !== "complete",
  );
  if (incompleteDependencies.length > 0) {
    errors.push(`dependencies are incomplete: ${incompleteDependencies.join(", ")}`);
  }
  return errors;
}

function validateHypotheticalCompletion(dag, nodeId, validateDag) {
  const errors = [];
  if (validateDag) {
    const result = validateDag(dag);
    errors.push(...(result.errors ?? []));
  } else {
    errors.push(...validateCompletionDagInvariants(dag));
  }
  if (errors.length > 0) {
    throw new Error(
      `${nodeId} completion would violate spec-dag validate invariants: ${errors.join("; ")}`,
    );
  }
}

function validateCompletionDagInvariants(dag) {
  const errors = [];
  const ids = new Map();
  for (const node of dag.nodes ?? []) {
    if (ids.has(node.id)) {
      errors.push(`duplicate node id ${node.id}`);
    }
    ids.set(node.id, node);
  }
  for (const node of dag.nodes ?? []) {
    for (const dependency of node.dependsOn ?? []) {
      const dependencyNode = ids.get(dependency);
      if (!dependencyNode) {
        errors.push(`${node.id} depends on unknown node ${dependency}`);
        continue;
      }
      if (node.status === "complete" && dependencyNode.status !== "complete") {
        errors.push(`${node.id} is complete but depends on incomplete ${dependency}`);
      }
    }
  }
  return errors;
}

function createClaimLock(lockPath, payload) {
  mkdirSync(dirname(lockPath), { recursive: true });
  let fd;
  try {
    fd = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(`claim lock already exists for ${payload.nodeId}: ${lockPath}`);
    }
    throw error;
  }
  writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`);
  return fd;
}

function readClaimLock(lockPath) {
  try {
    return JSON.parse(readFileSync(lockPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw new Error(`claim lock ${lockPath} is not readable JSON: ${error.message}`);
  }
}

function removeStaleClaimLock(lockPath, { nodeId, now, staleAfterHours }) {
  const lock = readClaimLock(lockPath);
  if (!lock) {
    return undefined;
  }
  if (lock.nodeId !== nodeId) {
    throw new Error(`claim lock ${lockPath} belongs to ${lock.nodeId}, not ${nodeId}`);
  }
  const claimedAt = parseClaimedAt(lock, lockPath);
  const ttlHours = Number(lock.staleAfterHours ?? staleAfterHours);
  if (!Number.isFinite(ttlHours) || ttlHours <= 0) {
    throw new Error(`claim lock ${lockPath} has invalid staleAfterHours`);
  }
  const ageMs = now.getTime() - claimedAt.getTime();
  const staleMs = ttlHours * 60 * 60 * 1000;
  if (ageMs < staleMs) {
    throw new Error(
      `claim lock for ${nodeId} is not stale; age ${formatHours(ageMs)}h is below ${ttlHours}h`,
    );
  }
  retireClaimLock(lockPath);
  return lock;
}

function parseClaimedAt(lock, lockPath) {
  if (!lock.claimedAt) {
    const stats = statSync(lockPath);
    return stats.mtime;
  }
  const claimedAt = new Date(lock.claimedAt);
  if (Number.isNaN(claimedAt.getTime())) {
    throw new Error(`claim lock ${lockPath} has invalid claimedAt`);
  }
  return claimedAt;
}

function clearMatchingStaleDagClaim(dag, lock) {
  const node = requireNode(dag, lock.nodeId);
  if (node.status !== "in_progress") {
    return;
  }
  assertActiveClaimMatches(node, {
    owner: lock.owner,
    branch: lock.branch,
    worktree: lock.worktree,
  });
  for (const field of ["owner", "branch", "worktree", "statusReason", "blockedBy"]) {
    delete node[field];
  }
  node.status = "planned";
}

function assertClaimLockMatches(lock, expected) {
  if (lock.nodeId !== expected.nodeId) {
    throw new Error(`claim lock belongs to ${lock.nodeId}, not ${expected.nodeId}`);
  }
  if (lock.owner !== expected.owner) {
    throw new Error(
      `claim lock owner ${lock.owner ?? "<missing>"} does not match ${expected.owner}`,
    );
  }
  if (expected.branch && lock.branch && lock.branch !== expected.branch) {
    throw new Error(`claim lock branch ${lock.branch} does not match ${expected.branch}`);
  }
  if (expected.worktree && lock.worktree && lock.worktree !== expected.worktree) {
    throw new Error(`claim lock worktree ${lock.worktree} does not match ${expected.worktree}`);
  }
}

function assertActiveClaimMatches(node, expected) {
  if (node.owner !== expected.owner) {
    throw new Error(
      `active DAG owner ${node.owner ?? "<missing>"} does not match ${expected.owner}`,
    );
  }
  if (expected.branch && node.branch && node.branch !== expected.branch) {
    throw new Error(`active DAG branch ${node.branch} does not match ${expected.branch}`);
  }
  if (expected.worktree && node.worktree && node.worktree !== expected.worktree) {
    throw new Error(`active DAG worktree ${node.worktree} does not match ${expected.worktree}`);
  }
}

function retireClaimLock(lockPath) {
  if (!existsSync(lockPath)) {
    return;
  }
  unlinkSync(lockPath);
}

function formatHours(ms) {
  return (ms / (60 * 60 * 1000)).toFixed(2);
}

function applyNodePatchInMemory(dag, nodeId, patch) {
  const node = requireNode(dag, nodeId);
  for (const field of ["statusReason", "blockedBy"]) {
    if (!(field in patch)) {
      delete node[field];
    }
  }
  Object.assign(node, patch);
}

function requireNode(dag, nodeId) {
  const node = (dag.nodes ?? []).find((candidate) => candidate.id === nodeId);
  if (!node) {
    throw new Error(`unknown node ${nodeId}`);
  }
  return node;
}

function requiredOption(value, name) {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function isBlockingSeverity(severity) {
  return priorityRank[severity] <= priorityRank.P1;
}

function uniqueStrings(values) {
  return [...new Set(values)];
}

function uniqueVerification(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const key = `${value.type}:${value.value}`;
    if (!seen.has(key)) {
      result.push(value);
      seen.add(key);
    }
  }
  return result;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function writeJsonAtomic(path, value) {
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmpPath, path);
  maybeCanonicalizeSpecDag(path);
}

function maybeCanonicalizeSpecDag(path) {
  if (process.env.ITOTORI_SKIP_DAG_CANONICALIZE === "1") return;
  if (!/(^|\/)roadmap\/spec-dag\.json$/.test(path)) return;
  const result = spawnSync("pnpm", ["exec", "vp", "check", "--fix", "--no-lint", path], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  if (result.error && result.error.code !== "ENOENT") {
    throw result.error;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
