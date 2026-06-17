import { createHash } from "node:crypto";

const priorityRank = { P0: 0, P1: 1, P2: 2, P3: 3 };
const targetRank = { baseline: 0, mvp: 1, post_mvp: 2 };

export const issueSyncLabelTaxonomy = Object.freeze({
  root: "spec-dag",
  statusPrefix: "dag/status:",
  priorityPrefix: "dag/priority:",
  targetPrefix: "dag/target:",
  projectPrefix: "dag/project:",
  groupPrefix: "dag/group:",
});

export const issueSyncManagedLabelPrefixes = Object.freeze([
  issueSyncLabelTaxonomy.statusPrefix,
  issueSyncLabelTaxonomy.priorityPrefix,
  issueSyncLabelTaxonomy.targetPrefix,
  issueSyncLabelTaxonomy.projectPrefix,
  issueSyncLabelTaxonomy.groupPrefix,
]);

export function createIssueSyncPlan(dagValue, options = {}) {
  const existingIssues = normalizeExistingIssues(options.existingIssues ?? []);
  const nodes = sortDagNodesForIssueSync(dagValue.nodes ?? []);
  return nodes.map((node) => {
    const existingIssue = existingIssueForNode(node, existingIssues.byNodeId);
    const body = renderIssueBody(node);
    return {
      action: existingIssue ? "update" : "create",
      nodeId: node.id,
      issue: existingIssue?.ref ?? null,
      issueSource: existingIssue?.source ?? null,
      title: issueTitleForNode(node),
      labels: issueLabelsForNode(node),
      dependencies: [...node.dependsOn],
      status: node.status,
      priority: node.priority,
      target: node.target,
      projects: [...node.projects],
      acceptanceCriteria: [...node.acceptanceCriteria],
      bodySha256: sha256(body),
      body,
    };
  });
}

export function renderIssueSyncDryRun(plan, options = {}) {
  const lines = [
    "spec DAG issue sync dry-run",
    `nodes: ${plan.length}`,
    "writes: 0",
    "defaultMutating: false",
    "",
  ];

  for (const entry of plan) {
    lines.push(`${entry.action.toUpperCase()} ${entry.nodeId}`);
    lines.push(`issue: ${entry.issue ?? "none"}`);
    lines.push(`title: ${entry.title}`);
    lines.push(`labels: ${entry.labels.join(", ")}`);
    lines.push(
      `dependencies: ${entry.dependencies.length === 0 ? "none" : entry.dependencies.join(", ")}`,
    );
    lines.push(`status: ${entry.status}`);
    lines.push("acceptanceCriteria:");
    for (const criterion of entry.acceptanceCriteria) {
      lines.push(`- ${oneLine(criterion)}`);
    }
    lines.push(`bodySha256: ${entry.bodySha256}`);
    if (options.includeBody) {
      lines.push("body: |");
      for (const line of entry.body.trimEnd().split("\n")) {
        lines.push(`  ${line}`);
      }
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderIssueBody(node) {
  const acceptanceMark = node.status === "complete" ? "x" : " ";
  const lines = [
    `<!-- spec-dag-node: ${node.id} -->`,
    "<!-- spec-dag-sync-version: 1 -->",
    "",
    `# ${node.id}: ${node.title}`,
    "",
    oneLine(node.summary),
    "",
    "## DAG Metadata",
    `- Node: \`${node.id}\``,
    `- Status: \`${node.status}\``,
    `- Priority: \`${node.priority}\``,
    `- Target: \`${node.target}\``,
    `- Projects: ${node.projects.map((project) => `\`${project}\``).join(", ")}`,
    `- Parallel group: \`${node.parallelGroup}\``,
    `- DAG source: \`roadmap/spec-dag.json\``,
    "",
    "## Dependencies",
    ...renderBulletList(node.dependsOn, "None"),
    "",
    "## Deliverables",
    ...renderBulletList(node.deliverables),
    "",
    "## Acceptance Criteria",
    ...node.acceptanceCriteria.map((criterion) => `- [${acceptanceMark}] ${oneLine(criterion)}`),
    "",
    "## Verification",
    ...node.verification.map(
      (entry) =>
        `- ${entry.type}: ${entry.type === "command" ? inlineCode(entry.value) : oneLine(entry.value)}`,
    ),
    "",
    "## Audit Focus",
    ...renderBulletList(node.auditFocus),
  ];

  if (node.statusReason) {
    lines.push("", "## Status Reason", oneLine(node.statusReason));
  }
  if (node.blockedBy) {
    lines.push("", "## Blocked By", oneLine(node.blockedBy));
  }
  if (node.owner || node.branch || node.worktree) {
    lines.push("", "## Current Claim");
    if (node.owner) {
      lines.push(`- Owner: ${oneLine(node.owner)}`);
    }
    if (node.branch) {
      lines.push(`- Branch: ${inlineCode(node.branch)}`);
    }
    if (node.worktree) {
      lines.push(`- Worktree: ${inlineCode(node.worktree)}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export function issueTitleForNode(node) {
  return `[${node.id}] ${node.title}`;
}

export function issueLabelsForNode(node) {
  return [
    issueSyncLabelTaxonomy.root,
    `${issueSyncLabelTaxonomy.priorityPrefix}${node.priority}`,
    `${issueSyncLabelTaxonomy.statusPrefix}${node.status}`,
    `${issueSyncLabelTaxonomy.targetPrefix}${node.target}`,
    ...[...node.projects]
      .sort((left, right) => left.localeCompare(right))
      .map((project) => `${issueSyncLabelTaxonomy.projectPrefix}${project}`),
    `${issueSyncLabelTaxonomy.groupPrefix}${node.parallelGroup}`,
  ];
}

export function sortDagNodesForIssueSync(nodes) {
  return [...nodes].sort((left, right) => {
    const byPriority = priorityRank[left.priority] - priorityRank[right.priority];
    if (byPriority !== 0) {
      return byPriority;
    }
    const byTarget = targetRank[left.target] - targetRank[right.target];
    if (byTarget !== 0) {
      return byTarget;
    }
    const byGroup = left.parallelGroup.localeCompare(right.parallelGroup);
    if (byGroup !== 0) {
      return byGroup;
    }
    return left.id.localeCompare(right.id);
  });
}

export function normalizeExistingIssues(rawIssues) {
  const issues = [];
  const byNodeId = new Map();
  const duplicateNodeIds = new Set();

  for (const rawIssue of rawIssues) {
    if (!isRecord(rawIssue)) {
      continue;
    }
    const nodeId = dagNodeIdFromIssue(rawIssue);
    if (!nodeId) {
      continue;
    }
    const issue = {
      nodeId,
      ref: issueRef(rawIssue),
      title: typeof rawIssue.title === "string" ? rawIssue.title : "",
      body: typeof rawIssue.body === "string" ? rawIssue.body : "",
    };
    issues.push(issue);
    if (byNodeId.has(nodeId)) {
      duplicateNodeIds.add(nodeId);
      continue;
    }
    byNodeId.set(nodeId, issue);
  }

  return { issues, byNodeId, duplicateNodeIds: [...duplicateNodeIds].sort() };
}

export function issuesFromPayload(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (isRecord(payload) && Array.isArray(payload.issues)) {
    return payload.issues;
  }
  return [];
}

function existingIssueForNode(node, byNodeId) {
  if (typeof node.issue === "string" && node.issue.length > 0) {
    return { ref: node.issue, source: "dag" };
  }
  const issue = byNodeId.get(node.id);
  if (issue) {
    return { ref: issue.ref, source: "existing-issues" };
  }
  return undefined;
}

function dagNodeIdFromIssue(issue) {
  const body = typeof issue.body === "string" ? issue.body : "";
  const bodyMatch = body.match(/<!--\s*spec-dag-node:\s*([A-Z]+-[0-9]{3})\s*-->/);
  if (bodyMatch) {
    return bodyMatch[1];
  }
  const title = typeof issue.title === "string" ? issue.title : "";
  const titleMatch = title.match(/^\[([A-Z]+-[0-9]{3})\]/);
  return titleMatch?.[1];
}

function issueRef(issue) {
  for (const field of ["html_url", "url"]) {
    if (typeof issue[field] === "string" && issue[field].length > 0) {
      return issue[field];
    }
  }
  if (typeof issue.number === "number") {
    return `#${issue.number}`;
  }
  if (typeof issue.number === "string" && issue.number.length > 0) {
    return `#${issue.number}`;
  }
  return "existing issue";
}

function renderBulletList(items, emptyText) {
  if (items.length === 0) {
    return [`- ${emptyText ?? "None"}`];
  }
  return items.map((item) => `- ${oneLine(item)}`);
}

function inlineCode(value) {
  return `\`${oneLine(value).replaceAll("`", "\\`")}\``;
}

function oneLine(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
