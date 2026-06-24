// Orchestrates a single dashboard generation:
//   load -> validate -> enrich -> collect git provenance -> bundle client ->
//   render -> write .tmp/dag-dashboard.html
//
// Pure pieces (enrich, render) are imported from their own modules; the only
// I/O here is reading the DAG (via the canonical loader), spawning git for
// provenance, and writing the output file.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { bundleClient } from "./bundle-client.js";
import { loadDag, validateDag } from "./dag-loader.js";
import { AuditFindingsLoadError, loadAuditFindingsByNode } from "./db-audit-findings.js";
import { buildDashboardData, enrich, mergeAuditFindings } from "./enrich.js";
import { collectGitProvenance } from "./provenance.js";
import { renderHtml } from "./render.js";
import type { AuditFindingsStatus } from "./types.js";

export interface GenerateOptions {
  /**
   * When true, query DATABASE_URL for itotori_audit_findings and
   * render per-node finding badges. Default false; the dashboard
   * stays fully fixture-less when this is off.
   */
  withAuditFindings?: boolean;
}

export interface GenerateResult {
  outPath: string;
  nodeCount: number;
  edgeCount: number;
  errorCount: number;
  auditFindingsStatus: AuditFindingsStatus;
}

/** Repo root resolved from the compiled file location (dist/generate.js). */
export function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // packages/spec-dag-dashboard/dist -> repo root
  return resolve(here, "../../..");
}

export async function generateDashboard(options: GenerateOptions = {}): Promise<GenerateResult> {
  const root = repoRoot();
  const outPath = resolve(root, ".tmp/dag-dashboard.html");

  const dag = await loadDag();
  const validation = await validateDag(dag);
  const errors = validation.errors ?? [];

  const enriched = enrich(dag, errors);
  const provenance = collectGitProvenance(root);

  const auditFindingsResult = await loadAuditFindingsIfRequested(
    options.withAuditFindings ?? false,
  );
  const mergedNodes = mergeAuditFindings(enriched.nodes, auditFindingsResult.byNode);
  const data = buildDashboardData(
    dag,
    errors,
    { ...enriched, nodes: mergedNodes },
    provenance,
    auditFindingsResult.status,
  );

  const clientJs = await bundleClient();
  const html = renderHtml(data, clientJs);

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html);

  return {
    outPath,
    nodeCount: data.nodes.length,
    edgeCount: data.edgeCount,
    errorCount: data.errorCount,
    auditFindingsStatus: data.auditFindingsStatus,
  };
}

/** Reproduce the reference's stdout summary. */
export function printSummary(result: GenerateResult): void {
  const issueWord = result.errorCount === 1 ? "issue" : "issues";
  process.stdout.write(
    `dag dashboard -> ${result.outPath}\n` +
      `${result.nodeCount} nodes, ${result.edgeCount} edges, ${result.errorCount} validation ${issueWord}\n`,
  );
  const status = result.auditFindingsStatus;
  if (status.kind === "loaded") {
    process.stdout.write(
      `audit findings: ${status.totalOpenFindings} open across ${status.nodesWithFindings} nodes\n`,
    );
  } else if (status.kind === "error") {
    process.stderr.write(`audit findings: ${status.reason}\n`);
  } else if (status.kind === "disabled" && status.reason === "database_url_not_set") {
    process.stderr.write("audit findings: DATABASE_URL not set; audit findings not rendered\n");
  }
}

async function loadAuditFindingsIfRequested(withAuditFindings: boolean): Promise<{
  status: AuditFindingsStatus;
  byNode: Awaited<ReturnType<typeof loadAuditFindingsByNode>>;
}> {
  const emptyByNode = new Map();
  if (!withAuditFindings) {
    return {
      status: { kind: "disabled", reason: "flag_not_set" },
      byNode: emptyByNode,
    };
  }
  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    return {
      status: { kind: "disabled", reason: "database_url_not_set" },
      byNode: emptyByNode,
    };
  }
  try {
    const byNode = await loadAuditFindingsByNode(databaseUrl);
    let nodesWithFindings = 0;
    let totalOpenFindings = 0;
    for (const bundle of byNode.values()) {
      nodesWithFindings += 1;
      totalOpenFindings += bundle.openFindings.length;
    }
    return {
      status: { kind: "loaded", nodesWithFindings, totalOpenFindings },
      byNode,
    };
  } catch (error) {
    const reason =
      error instanceof AuditFindingsLoadError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    return {
      status: { kind: "error", reason },
      byNode: emptyByNode,
    };
  }
}
