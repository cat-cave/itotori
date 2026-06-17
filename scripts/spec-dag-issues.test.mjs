import assert from "node:assert/strict";
import test from "node:test";
import {
  createIssueSyncPlan,
  issueLabelsForNode,
  renderIssueBody,
  renderIssueSyncDryRun,
} from "./spec-dag-issues.mjs";

const sampleNode = {
  id: "UNIV-002",
  title: "GitHub issue sync for DAG nodes",
  status: "planned",
  priority: "P1",
  target: "alpha",
  projects: ["universal"],
  parallelGroup: "roadmap-infra",
  dependsOn: ["UNIV-001"],
  summary: "Add a deterministic command that creates or updates GitHub issues from DAG nodes.",
  deliverables: ["Issue sync CLI", "Dry-run mode", "Issue body template", "Label taxonomy"],
  acceptanceCriteria: [
    "Dry-run output is stable",
    "Existing issues are updated rather than duplicated",
    "Every synced issue links back to its DAG node id",
  ],
  verification: [
    { type: "command", value: "node scripts/spec-dag.mjs sync-issues --dry-run" },
    { type: "manual", value: "Unit tests for issue body rendering" },
  ],
  auditFocus: ["Idempotency", "No accidental destructive GitHub mutations"],
};

test("renders a deterministic issue body with DAG metadata and acceptance criteria", () => {
  assert.equal(
    renderIssueBody(sampleNode),
    `<!-- spec-dag-node: UNIV-002 -->
<!-- spec-dag-sync-version: 1 -->

# UNIV-002: GitHub issue sync for DAG nodes

Add a deterministic command that creates or updates GitHub issues from DAG nodes.

## DAG Metadata
- Node: \`UNIV-002\`
- Status: \`planned\`
- Priority: \`P1\`
- Target: \`alpha\`
- Projects: \`universal\`
- Parallel group: \`roadmap-infra\`
- DAG source: \`roadmap/spec-dag.json\`

## Dependencies
- UNIV-001

## Deliverables
- Issue sync CLI
- Dry-run mode
- Issue body template
- Label taxonomy

## Acceptance Criteria
- [ ] Dry-run output is stable
- [ ] Existing issues are updated rather than duplicated
- [ ] Every synced issue links back to its DAG node id

## Verification
- command: \`node scripts/spec-dag.mjs sync-issues --dry-run\`
- manual: Unit tests for issue body rendering

## Audit Focus
- Idempotency
- No accidental destructive GitHub mutations
`,
  );
});

test("renders complete nodes with checked acceptance criteria", () => {
  const body = renderIssueBody({ ...sampleNode, status: "complete" });

  assert.match(body, /- \[x\] Dry-run output is stable/);
  assert.match(body, /- Status: `complete`/);
});

test("uses the managed label taxonomy in a stable order", () => {
  assert.deepEqual(issueLabelsForNode(sampleNode), [
    "spec-dag",
    "dag/priority:P1",
    "dag/status:planned",
    "dag/target:alpha",
    "dag/project:universal",
    "dag/group:roadmap-infra",
  ]);
});

test("plans updates when an existing issue contains the DAG node marker", () => {
  const plan = createIssueSyncPlan(
    { nodes: [sampleNode] },
    {
      existingIssues: [
        {
          number: 42,
          title: "[UNIV-002] Old title",
          body: "<!-- spec-dag-node: UNIV-002 -->",
        },
      ],
    },
  );

  assert.equal(plan.length, 1);
  assert.equal(plan[0].action, "update");
  assert.equal(plan[0].issue, "#42");
});

test("renders a stable non-mutating dry-run summary", () => {
  const plan = createIssueSyncPlan({ nodes: [sampleNode] });

  assert.equal(
    renderIssueSyncDryRun(plan),
    `spec DAG issue sync dry-run
nodes: 1
writes: 0
defaultMutating: false

CREATE UNIV-002
issue: none
title: [UNIV-002] GitHub issue sync for DAG nodes
labels: spec-dag, dag/priority:P1, dag/status:planned, dag/target:alpha, dag/project:universal, dag/group:roadmap-infra
dependencies: UNIV-001
status: planned
acceptanceCriteria:
- Dry-run output is stable
- Existing issues are updated rather than duplicated
- Every synced issue links back to its DAG node id
bodySha256: ${plan[0].bodySha256}
`,
  );
});
