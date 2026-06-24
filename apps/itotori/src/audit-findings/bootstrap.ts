import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type {
  AuditFindingRecord,
  AuthorizationActor,
  ItotoriAuditFindingRepositoryPort,
} from "@itotori/db";
import { parseAuditMarkdown, type ParsedAuditFinding } from "./parser.js";

export type AuditBootstrapSummary = {
  /** Reports scanned (one per `docs/audits/*.md`). */
  reportsScanned: number;
  /** Reports that yielded at least one structured finding. */
  reportsWithFindings: number;
  /** Total findings inserted (one row per structured block). */
  findingsInserted: number;
  /** Per-report inserted finding counts (in scan order). */
  perReport: Array<{ auditReportId: string; findingsInserted: number }>;
};

export type AuditBootstrapPort = {
  recordFinding: ItotoriAuditFindingRepositoryPort["recordFinding"];
};

export type AuditBootstrapInput = {
  actor: AuthorizationActor;
  auditsDirectoryAbsolutePath: string;
  /**
   * Root path used to derive the `auditReportId` from each scanned
   * file (so the id is stable across machines). Typically the repo
   * root. The id is the POSIX-style path relative to this root.
   */
  repoRootAbsolutePath: string;
};

/**
 * Walk `docs/audits/*.md`, parse every structured finding block, and
 * insert each finding through the supplied repository. Returns a
 * summary the CLI can print; never silently swallows errors.
 */
export async function bootstrapAuditFindings(
  port: AuditBootstrapPort,
  input: AuditBootstrapInput,
): Promise<AuditBootstrapSummary> {
  const files = listAuditMarkdownFiles(input.auditsDirectoryAbsolutePath);
  const summary: AuditBootstrapSummary = {
    reportsScanned: 0,
    reportsWithFindings: 0,
    findingsInserted: 0,
    perReport: [],
  };

  for (const absolutePath of files) {
    summary.reportsScanned += 1;
    const auditReportId = toAuditReportId(input.repoRootAbsolutePath, absolutePath);
    const markdown = readFileSync(absolutePath, "utf8");
    const findings = parseAuditMarkdown({ auditReportId, markdown });
    if (findings.length === 0) {
      summary.perReport.push({ auditReportId, findingsInserted: 0 });
      continue;
    }

    summary.reportsWithFindings += 1;
    let inserted = 0;
    for (const finding of findings) {
      await port.recordFinding(input.actor, toRecordInput(finding));
      inserted += 1;
    }
    summary.findingsInserted += inserted;
    summary.perReport.push({ auditReportId, findingsInserted: inserted });
  }

  return summary;
}

/**
 * Synchronous in-memory variant used by the test harness. Returns the
 * parsed-then-recorded findings so a test can assert insert order +
 * shape without standing up a DB.
 */
export async function bootstrapAuditFindingsFromBlobs(
  port: AuditBootstrapPort,
  actor: AuthorizationActor,
  blobs: Array<{ auditReportId: string; markdown: string }>,
): Promise<{ summary: AuditBootstrapSummary; records: AuditFindingRecord[] }> {
  const summary: AuditBootstrapSummary = {
    reportsScanned: 0,
    reportsWithFindings: 0,
    findingsInserted: 0,
    perReport: [],
  };
  const records: AuditFindingRecord[] = [];
  for (const blob of blobs) {
    summary.reportsScanned += 1;
    const findings = parseAuditMarkdown(blob);
    if (findings.length === 0) {
      summary.perReport.push({ auditReportId: blob.auditReportId, findingsInserted: 0 });
      continue;
    }
    summary.reportsWithFindings += 1;
    let inserted = 0;
    for (const finding of findings) {
      const record = await port.recordFinding(actor, toRecordInput(finding));
      records.push(record);
      inserted += 1;
    }
    summary.findingsInserted += inserted;
    summary.perReport.push({ auditReportId: blob.auditReportId, findingsInserted: inserted });
  }
  return { summary, records };
}

function toRecordInput(
  finding: ParsedAuditFinding,
): Parameters<ItotoriAuditFindingRepositoryPort["recordFinding"]>[1] {
  return {
    auditReportId: finding.auditReportId,
    nodeId: finding.nodeId,
    severity: finding.severity,
    category: finding.category,
    summary: finding.summary,
    detail: finding.detail ?? null,
    fileRef: finding.fileRef ?? null,
    proposedDagNode: finding.proposedDagNode ?? null,
  };
}

function listAuditMarkdownFiles(directoryAbsolutePath: string): string[] {
  const stats = statSync(directoryAbsolutePath);
  if (!stats.isDirectory()) {
    throw new Error(`audit findings bootstrap: ${directoryAbsolutePath} is not a directory`);
  }
  const entries = readdirSync(directoryAbsolutePath, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".md")) continue;
    out.push(join(directoryAbsolutePath, entry.name));
  }
  out.sort();
  return out;
}

function toAuditReportId(repoRootAbsolutePath: string, absoluteFilePath: string): string {
  const rel = relative(repoRootAbsolutePath, absoluteFilePath);
  // Force POSIX separators so the id is stable on Windows runners.
  return rel.split(/[\\/]+/u).join("/");
}
