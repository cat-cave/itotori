import {
  auditFindingSeverityList,
  type AuditFindingSeverity,
  type RecordFindingInput,
} from "@itotori/db";

/**
 * Parser for the alpha-gate-5 structured audit-finding block format.
 *
 * The existing `docs/audits/*.md` files are narrative prose. To bridge
 * them into the DB without forcing every file to be rewritten, the
 * audit bootstrap recognizes a structured block of the form:
 *
 *   ### Finding: NODE-ID [SEVERITY] category
 *   **summary:** one-line summary
 *   optional detail paragraph (multiple lines until next blank line)
 *   **file_ref:** crates/path.rs:42
 *   **proposed_dag_node:** PROPOSED-NODE-ID
 *
 * Fields after the heading must use the `**field:** value` syntax.
 * Heading-line shape is required. Audit reports that pre-date this
 * format keep working as-is — the parser simply finds zero structured
 * blocks in them, which the bootstrap reports honestly.
 *
 * The parser is intentionally strict: anything that doesn't match the
 * heading exactly is ignored (not silently treated as a finding), and
 * any structured block that names an unknown severity raises a typed
 * error so the bootstrap stops at the bad doc instead of inserting
 * garbage.
 */

const FINDING_HEADING_RE = /^###\s+Finding:\s+([A-Z][A-Z0-9]*-\d+)\s+\[([A-Z0-9]+)\]\s+(.+?)\s*$/u;
const FIELD_RE = /^\*\*([a-z_][a-z0-9_]*):\*\*\s+(.+?)\s*$/u;

export class AuditFindingParseError extends Error {
  constructor(
    readonly code: "unknown_severity" | "missing_summary" | "duplicate_field" | "malformed_field",
    readonly auditReportId: string,
    readonly lineNumber: number,
    message: string,
  ) {
    super(`${auditReportId}:${lineNumber}: ${message}`);
    this.name = "AuditFindingParseError";
  }
}

export type ParseAuditMarkdownInput = {
  auditReportId: string;
  markdown: string;
};

export type ParsedAuditFinding = Omit<RecordFindingInput, "createdAt"> & {
  // Line where the finding heading was found; useful for human review.
  sourceLine: number;
};

/**
 * Parse every structured audit-finding block in a single markdown
 * document and return them in heading-order. Throws on any block that
 * names an unknown severity or carries a duplicate/missing required
 * field.
 */
export function parseAuditMarkdown(input: ParseAuditMarkdownInput): ParsedAuditFinding[] {
  const lines = input.markdown.split(/\r?\n/u);
  const findings: ParsedAuditFinding[] = [];

  let cursor = 0;
  while (cursor < lines.length) {
    const line = lines[cursor];
    if (line === undefined) {
      cursor += 1;
      continue;
    }
    const headingMatch = FINDING_HEADING_RE.exec(line);
    if (headingMatch === null) {
      cursor += 1;
      continue;
    }

    const [, nodeId, severityRaw, category] = headingMatch;
    if (nodeId === undefined || severityRaw === undefined || category === undefined) {
      cursor += 1;
      continue;
    }
    if (!isKnownSeverity(severityRaw)) {
      throw new AuditFindingParseError(
        "unknown_severity",
        input.auditReportId,
        cursor + 1,
        `unknown severity ${severityRaw}; expected one of ${auditFindingSeverityList.join(", ")}`,
      );
    }

    const block = consumeBlock(lines, cursor + 1);
    const fields = block.fields;
    const summary = fields.get("summary");
    if (summary === undefined) {
      throw new AuditFindingParseError(
        "missing_summary",
        input.auditReportId,
        cursor + 1,
        `finding for ${nodeId} is missing required **summary:** field`,
      );
    }

    findings.push({
      auditReportId: input.auditReportId,
      nodeId,
      severity: severityRaw,
      category: category.trim(),
      summary: summary.trim(),
      detail: block.detail.length > 0 ? block.detail : null,
      fileRef: fields.get("file_ref")?.trim() ?? null,
      proposedDagNode: fields.get("proposed_dag_node")?.trim() ?? null,
      sourceLine: cursor + 1,
    });

    cursor = block.nextCursor;
  }

  return findings;
}

type BlockResult = {
  fields: Map<string, string>;
  detail: string;
  nextCursor: number;
};

function consumeBlock(lines: string[], start: number): BlockResult {
  const fields = new Map<string, string>();
  const detailLines: string[] = [];
  let cursor = start;
  let sawBlankAfterContent = false;
  while (cursor < lines.length) {
    const raw = lines[cursor];
    if (raw === undefined) {
      cursor += 1;
      continue;
    }
    if (FINDING_HEADING_RE.test(raw)) {
      break;
    }
    if (raw.startsWith("## ") || raw.startsWith("# ")) {
      break;
    }
    const fieldMatch = FIELD_RE.exec(raw);
    if (fieldMatch !== null) {
      const [, name, value] = fieldMatch;
      if (name === undefined || value === undefined) {
        throw new AuditFindingParseError(
          "malformed_field",
          "<doc>",
          cursor + 1,
          `malformed field line: ${raw}`,
        );
      }
      if (fields.has(name)) {
        throw new AuditFindingParseError(
          "duplicate_field",
          "<doc>",
          cursor + 1,
          `field ${name} appears more than once in a single finding block`,
        );
      }
      fields.set(name, value);
      sawBlankAfterContent = false;
      cursor += 1;
      continue;
    }
    if (raw.trim().length === 0) {
      if (fields.size > 0 || detailLines.length > 0) {
        if (sawBlankAfterContent) {
          // Two blank lines in a row after content ends the block.
          break;
        }
        sawBlankAfterContent = true;
      }
      cursor += 1;
      continue;
    }
    // Non-empty, non-field line. If we already had a blank line after
    // content (and no field has appeared since), treat this as the
    // start of a new prose section that terminates the block.
    if (sawBlankAfterContent) {
      break;
    }
    detailLines.push(raw);
    cursor += 1;
  }

  return {
    fields,
    detail: detailLines.join("\n").trim(),
    nextCursor: cursor,
  };
}

function isKnownSeverity(value: string): value is AuditFindingSeverity {
  for (const known of auditFindingSeverityList) {
    if (known === value) {
      return true;
    }
  }
  return false;
}
