// Shared types for the spec-dag dashboard generator and its embedded client.
//
// These describe the *enriched* data shape that the generator serializes into
// the page and the client reads back. The raw DAG (from spec-dag.json via the
// canonical validator) is intentionally typed loosely in dag-loader.ts; only
// the fields the dashboard actually consumes are pinned down here.

export type NodeStatus = "complete" | "in_progress" | "planned" | "blocked" | "cancelled";

export type Priority = "P0" | "P1" | "P2" | "P3";

export interface Verification {
  type: string;
  value: string;
}

/** A raw node as it appears in roadmap/spec-dag.json. */
export interface SpecNode {
  id: string;
  title: string;
  status: NodeStatus;
  priority: Priority;
  target: string;
  parallelGroup: string;
  projects?: string[];
  dependsOn?: string[];
  summary?: string;
  deliverables?: string[];
  acceptanceCriteria?: string[];
  verification?: Verification[];
  auditFocus?: string[];
}

/** A node after derivation of dependents, readiness, blockers and issues. */
export interface EnrichedNode extends SpecNode {
  dependents: string[];
  ready: boolean;
  blockedBy: string[];
  issues: string[];
}

/** Counts keyed by node status. */
export type StatusCounts = Partial<Record<string, number>>;

export interface Provenance {
  headShortSha: string | null;
  generatedAt: string;
  dirty: boolean;
  commitsBehind: number | null;
  originMainKnown: boolean;
}

/** The fully serialized payload embedded as `var DATA` in the page. */
export interface DashboardData {
  generatedAt: string;
  schemaVersion: string | null;
  metadata: Record<string, unknown>;
  counts: StatusCounts;
  edgeCount: number;
  errorCount: number;
  globalIssues: string[];
  nodes: EnrichedNode[];
  provenance: Provenance;
}

export const PRANK: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
export const TRANK: Record<string, number> = { baseline: 0, alpha: 1, continuous: 2 };
