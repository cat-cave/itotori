import { mkdirSync, writeFileSync } from "node:fs";

import { defaultClaimLockPath } from "./spec-dag-lifecycle.mjs";

export function sampleDag(nodeOverrides = {}) {
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

export function sampleQdExportDag() {
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

export function writeClaimLock(lockDir, node) {
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

export function sampleAuditReportForNode(node) {
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

export function sampleAuditReport(overrides = {}) {
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

export function blockingFinding(id, severity) {
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

export function draftFinding(id, severity) {
  return {
    id,
    severity,
    title: "Generated follow-up",
    category: "orchestration",
    locations: [{ path: "docs/dev/audit-playbook.md" }],
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

export function appendFinding(id, severity) {
  return {
    id,
    severity,
    title: "Append follow-up",
    category: "documentation",
    locations: [{ path: "docs/dev/spec-dag.md" }],
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
