// DB read path for audit findings. The dashboard's primary mode is
// fixture-less DAG rendering from roadmap/spec-dag.json + git
// provenance; this module exists purely to let `--with-audit-findings`
// enrich the rendered nodes with the rows from itotori_audit_findings.
//
// The dashboard package does not pull in drizzle just to read this one
// table — the schema is small and stable, and bringing drizzle in
// would force a deeper dep on a CLI tool that has to stay snappy. We
// use a raw pg.Client query and validate the shape on read.
//
// IMPORTANT: failure surfaces as a typed error to the caller; the
// caller is responsible for turning it into a UI message in the
// rendered HTML so the user never sees a silent missing-findings
// state.

import pg from "pg";
import type { AuditFindingSeverity, AuditFindingStatus } from "@itotori/db";

/** Per-node finding count, broken down by severity. */
export type AuditFindingSeverityCounts = {
  P0: number;
  P1: number;
  P2: number;
  P3: number;
};

/** One open audit finding as the dashboard renders it. */
export type DashboardAuditFinding = {
  auditFindingId: string;
  auditReportId: string;
  severity: AuditFindingSeverity;
  category: string;
  summary: string;
  fileRef: string | null;
  proposedDagNode: string | null;
  status: AuditFindingStatus;
};

/** Per-node finding bundle. */
export type NodeAuditFindings = {
  counts: AuditFindingSeverityCounts;
  openFindings: DashboardAuditFinding[];
};

export type AuditFindingsByNode = Map<string, NodeAuditFindings>;

export class AuditFindingsLoadError extends Error {
  constructor(
    readonly code: "missing_database_url" | "query_failed" | "shape_invalid",
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "AuditFindingsLoadError";
  }
}

/**
 * Connect to the database and return every OPEN audit finding grouped
 * by `node_id`. Counts include only open rows, so a fixed/superseded
 * finding does not keep showing on the node card after follow-up.
 */
export async function loadAuditFindingsByNode(databaseUrl: string): Promise<AuditFindingsByNode> {
  const client = new pg.Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    const result = await client.query<{
      audit_finding_id: string;
      audit_report_id: string;
      node_id: string;
      severity: string;
      category: string;
      summary: string;
      file_ref: string | null;
      proposed_dag_node: string | null;
      status: string;
    }>(
      `select
         audit_finding_id,
         audit_report_id,
         node_id,
         severity,
         category,
         summary,
         file_ref,
         proposed_dag_node,
         status
       from itotori_audit_findings
       where status = 'open'
       order by node_id asc, severity asc, audit_finding_id asc`,
    );
    return rowsToByNode(result.rows);
  } catch (error) {
    if (error instanceof AuditFindingsLoadError) {
      throw error;
    }
    throw new AuditFindingsLoadError(
      "query_failed",
      `failed to query itotori_audit_findings: ${describeError(error)}`,
      { cause: error },
    );
  } finally {
    await client.end().catch(() => {
      // teardown errors must not mask the original query result/error
    });
  }
}

/**
 * Pure helper: bucket raw audit-finding rows by their DAG node id and
 * compute per-severity counts. Exported so tests can drive the merge
 * without hitting a real DB.
 */
export function rowsToByNode(
  rows: Array<{
    audit_finding_id: string;
    audit_report_id: string;
    node_id: string;
    severity: string;
    category: string;
    summary: string;
    file_ref: string | null;
    proposed_dag_node: string | null;
    status: string;
  }>,
): AuditFindingsByNode {
  const out: AuditFindingsByNode = new Map();
  for (const row of rows) {
    if (!isKnownSeverity(row.severity)) {
      throw new AuditFindingsLoadError(
        "shape_invalid",
        `audit finding ${row.audit_finding_id} has unknown severity ${row.severity}`,
      );
    }
    if (!isKnownStatus(row.status)) {
      throw new AuditFindingsLoadError(
        "shape_invalid",
        `audit finding ${row.audit_finding_id} has unknown status ${row.status}`,
      );
    }
    let bundle = out.get(row.node_id);
    if (bundle === undefined) {
      bundle = {
        counts: { P0: 0, P1: 0, P2: 0, P3: 0 },
        openFindings: [],
      };
      out.set(row.node_id, bundle);
    }
    bundle.counts[row.severity] += 1;
    bundle.openFindings.push({
      auditFindingId: row.audit_finding_id,
      auditReportId: row.audit_report_id,
      severity: row.severity,
      category: row.category,
      summary: row.summary,
      fileRef: row.file_ref,
      proposedDagNode: row.proposed_dag_node,
      status: row.status,
    });
  }
  return out;
}

function isKnownSeverity(value: string): value is AuditFindingSeverity {
  return value === "P0" || value === "P1" || value === "P2" || value === "P3";
}

function isKnownStatus(value: string): value is AuditFindingStatus {
  return (
    value === "open" ||
    value === "superseded" ||
    value === "fixed" ||
    value === "wontfix" ||
    value === "duplicate"
  );
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
