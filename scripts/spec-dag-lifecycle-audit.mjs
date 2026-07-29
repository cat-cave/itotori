import { defaultClaimLockPath } from "./spec-dag-lifecycle-claims.mjs";
import {
  applyNodePatchInMemory,
  assertClaimLockMatches,
  assertLegacyLifecycleWritableDag,
  assertNodeIsSafelyCompletable,
  cloneJson,
  completionSafetyErrors,
  isBlockingSeverity,
  nodeFromProposedDagNode,
  readClaimLock,
  readJson,
  requireNode,
  retireClaimLock,
  uniqueStrings,
  uniqueVerification,
  validateHypotheticalCompletion,
  writeJsonAtomic,
} from "./spec-dag-lifecycle-internal.mjs";

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
  assertLegacyLifecycleWritableDag(dag, "ingest-audit");
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
  assertLegacyLifecycleWritableDag(dag, "complete");
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
