// Pure enrichment of the raw DAG: validator-error attribution, dependents,
// readiness/blockers, per-status counts, edge count and canonical sort order.
//
// Ported faithfully from spec-dag-dashboard.reference.mjs (lines ~30-87). No
// I/O, no git, no validation here — callers pass the already-loaded DAG and the
// already-computed validator errors.

import type {
  AuditFindingsStatus,
  DashboardData,
  EnrichedNode,
  SpecNode,
  StatusCounts,
} from "./types.js";
import { PRANK, TRANK } from "./types.js";
import type { AuditFindingsByNode } from "./db-audit-findings.js";

const ID_RE = /\b[A-Z][A-Z0-9]*-\d+\b/g;
const PATH_RE = /\/nodes\/(\d+)/;

export interface EnrichResult {
  nodes: EnrichedNode[];
  counts: StatusCounts;
  edgeCount: number;
  globalIssues: string[];
}

function asNodes(dag: unknown): SpecNode[] {
  const nodes = (dag as { nodes?: unknown }).nodes;
  return Array.isArray(nodes) ? (nodes as SpecNode[]) : [];
}

/**
 * Attribute each validator error string to the owning node(s):
 * - `/nodes/N` path token -> nodes[N].id
 * - bare `AREA-001` id token(s) that match an existing node -> that node
 * - multiple ids in one error -> all of them
 * - none of the above -> globalIssues
 */
function attributeIssues(
  errors: string[],
  nodes: SpecNode[],
  byId: Map<string, SpecNode>,
): { issuesByNode: Map<string, string[]>; globalIssues: string[] } {
  const issuesByNode = new Map<string, string[]>();
  const globalIssues: string[] = [];
  for (const err of errors) {
    const owners = new Set<string>();
    const m = err.match(PATH_RE);
    if (m && m[1] != null) {
      const node = nodes[Number(m[1])];
      if (node) owners.add(node.id);
    }
    for (const id of err.match(ID_RE) ?? []) {
      if (byId.has(id)) owners.add(id);
    }
    if (owners.size) {
      for (const id of owners) {
        const existing = issuesByNode.get(id);
        if (existing) existing.push(err);
        else issuesByNode.set(id, [err]);
      }
    } else {
      globalIssues.push(err);
    }
  }
  return { issuesByNode, globalIssues };
}

export function enrich(dag: unknown, errors: string[]): EnrichResult {
  const nodes = asNodes(dag);
  const byId = new Map<string, SpecNode>(nodes.map((n) => [n.id, n]));

  const { issuesByNode, globalIssues } = attributeIssues(errors, nodes, byId);

  // dependents
  const dependents = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const n of nodes) {
    for (const d of n.dependsOn ?? []) {
      const list = dependents.get(d);
      if (list) list.push(n.id);
    }
  }

  const isComplete = (id: string): boolean => byId.get(id)?.status === "complete";

  const enriched: EnrichedNode[] = nodes.map((n) => {
    const deps = n.dependsOn ?? [];
    const blockedBy = deps.filter((d) => !isComplete(d));
    const ready = n.status === "planned" && blockedBy.length === 0;
    return {
      ...n,
      dependents: dependents.get(n.id) ?? [],
      ready,
      blockedBy,
      issues: issuesByNode.get(n.id) ?? [],
      findings: emptyFindings(),
    };
  });

  enriched.sort(
    (a, b) =>
      (PRANK[a.priority] ?? 9) - (PRANK[b.priority] ?? 9) ||
      (TRANK[a.target] ?? 9) - (TRANK[b.target] ?? 9) ||
      String(a.parallelGroup).localeCompare(String(b.parallelGroup)) ||
      a.id.localeCompare(b.id),
  );

  const counts: StatusCounts = {};
  for (const n of enriched) counts[n.status] = (counts[n.status] ?? 0) + 1;

  const edgeCount = nodes.reduce((acc, n) => acc + (n.dependsOn?.length ?? 0), 0);

  return { nodes: enriched, counts, edgeCount, globalIssues };
}

/** Assemble the serializable dashboard payload from enriched parts. */
export function buildDashboardData(
  dag: unknown,
  errors: string[],
  enriched: EnrichResult,
  provenance: DashboardData["provenance"],
  auditFindingsStatus: AuditFindingsStatus = {
    kind: "disabled",
    reason: "flag_not_set",
  },
): DashboardData {
  const doc = dag as { schemaVersion?: unknown; metadata?: unknown };
  return {
    generatedAt: provenance.generatedAt,
    schemaVersion: typeof doc.schemaVersion === "string" ? doc.schemaVersion : null,
    metadata: (doc.metadata as Record<string, unknown>) ?? {},
    counts: enriched.counts,
    edgeCount: enriched.edgeCount,
    errorCount: errors.length,
    globalIssues: enriched.globalIssues,
    nodes: enriched.nodes,
    provenance,
    auditFindingsStatus,
  };
}

/**
 * Merge an audit-findings rollup (keyed by DAG node id) into a list of
 * already-enriched nodes. Pure: returns a new node list; the input
 * stays untouched. Nodes with no findings keep `findings = empty`.
 */
export function mergeAuditFindings(
  nodes: EnrichedNode[],
  byNode: AuditFindingsByNode,
): EnrichedNode[] {
  return nodes.map((node) => {
    const bundle = byNode.get(node.id);
    if (bundle === undefined) {
      return node;
    }
    return {
      ...node,
      findings: {
        counts: { ...bundle.counts },
        openFindings: bundle.openFindings.map((finding) => ({
          auditFindingId: finding.auditFindingId,
          auditReportId: finding.auditReportId,
          severity: finding.severity,
          category: finding.category,
          summary: finding.summary,
          fileRef: finding.fileRef,
          proposedDagNode: finding.proposedDagNode,
        })),
      },
    };
  });
}

function emptyFindings(): EnrichedNode["findings"] {
  return {
    counts: { P0: 0, P1: 0, P2: 0, P3: 0 },
    openFindings: [],
  };
}
