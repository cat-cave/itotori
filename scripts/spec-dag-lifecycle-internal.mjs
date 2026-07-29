import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";

const priorityRank = { P0: 0, P1: 1, P2: 2, P3: 3 };
const qdExportLifecycleRefusal =
  "legacy spec-dag lifecycle --apply is disabled for qd export state; use qd claim/complete/gate/check/ci/merge and re-export roadmap/spec-dag.json";

export function assertLegacyLifecycleWritableDag(dag, action) {
  if (isQdExportDag(dag)) {
    throw new Error(`${action} refused: ${qdExportLifecycleRefusal}`);
  }
}

export function assertNodeIsReadyToClaim(dag, node) {
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

export function assertNodeIsSafelyCompletable(dag, nodeId) {
  const errors = completionSafetyErrors(dag, nodeId);
  if (errors.length > 0) {
    throw new Error(`${nodeId} cannot be completed: ${errors.join("; ")}`);
  }
}

export function completionSafetyErrors(dag, nodeId) {
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

export function validateHypotheticalCompletion(dag, nodeId, validateDag) {
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

export function createClaimLock(lockPath, payload) {
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

export function readClaimLock(lockPath) {
  try {
    return JSON.parse(readFileSync(lockPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw new Error(`claim lock ${lockPath} is not readable JSON: ${error.message}`);
  }
}

export function removeStaleClaimLock(lockPath, { nodeId, now, staleAfterHours }) {
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

export function clearMatchingStaleDagClaim(dag, lock) {
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

export function assertClaimLockMatches(lock, expected) {
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

export function assertActiveClaimMatches(node, expected) {
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

export function retireClaimLock(lockPath) {
  if (!existsSync(lockPath)) {
    return;
  }
  unlinkSync(lockPath);
}

export function applyNodePatchInMemory(dag, nodeId, patch) {
  const node = requireNode(dag, nodeId);
  for (const field of ["statusReason", "blockedBy"]) {
    if (!(field in patch)) {
      delete node[field];
    }
  }
  Object.assign(node, patch);
}

export function requireNode(dag, nodeId) {
  const node = (dag.nodes ?? []).find((candidate) => candidate.id === nodeId);
  if (!node) {
    throw new Error(`unknown node ${nodeId}`);
  }
  return node;
}

export function isBlockingSeverity(severity) {
  return priorityRank[severity] <= priorityRank.P1;
}

export function uniqueStrings(values) {
  return [...new Set(values)];
}

export function uniqueVerification(values) {
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

export function nodeFromProposedDagNode(proposedNode, assignedIds) {
  const { idPrefix, ...nodeFields } = proposedNode;
  return {
    id: nextDagNodeId(idPrefix, assignedIds),
    status: "planned",
    ...nodeFields,
  };
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export function writeJsonAtomic(path, value) {
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmpPath, path);
  maybeCanonicalizeSpecDag(path);
}

function isQdExportDag(value) {
  return isRecord(value) && "schema_version" in value;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

function formatHours(ms) {
  return (ms / (60 * 60 * 1000)).toFixed(2);
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

function maybeCanonicalizeSpecDag(path) {
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
