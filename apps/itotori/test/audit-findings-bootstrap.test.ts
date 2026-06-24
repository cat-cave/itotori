import { describe, expect, it } from "vitest";
import type { AuditFindingRecord, AuthorizationActor, RecordFindingInput } from "@itotori/db";
import { auditFindingStatusValues } from "@itotori/db";
import {
  bootstrapAuditFindingsFromBlobs,
  type AuditBootstrapPort,
} from "../src/audit-findings/bootstrap.js";
import { AuditFindingParseError, parseAuditMarkdown } from "../src/audit-findings/parser.js";

const actor: AuthorizationActor = { userId: "local-user" };

function stubPort(): {
  port: AuditBootstrapPort;
  recorded: Array<{ actor: AuthorizationActor; input: RecordFindingInput }>;
} {
  const recorded: Array<{ actor: AuthorizationActor; input: RecordFindingInput }> = [];
  let counter = 0;
  const port: AuditBootstrapPort = {
    recordFinding: async (a, input) => {
      counter += 1;
      recorded.push({ actor: a, input });
      const record: AuditFindingRecord = {
        auditFindingId: `audit-finding-stub-${counter}`,
        auditReportId: input.auditReportId,
        nodeId: input.nodeId,
        severity: input.severity,
        category: input.category,
        summary: input.summary,
        detail: input.detail ?? null,
        fileRef: input.fileRef ?? null,
        proposedDagNode: input.proposedDagNode ?? null,
        status: auditFindingStatusValues.open,
        supersededByFindingId: null,
        createdAt: new Date("2026-06-24T17:00:00Z"),
        resolvedAt: null,
      };
      return record;
    },
  };
  return { port, recorded };
}

const sampleMarkdown = `# Sample audit doc

Some narrative prose before any structured block. The parser must skip
this and only pick up structured findings.

### Finding: UTSUSHI-200 [P1] load-bearing
**summary:** non-synthetic engine port crate must not depend on author fixtures
The current AC permits a wrapper around the 8-opcode parser, which
would satisfy the AC without actually proving the substrate boundary.
**file_ref:** crates/utsushi-reallive/src/lib.rs:1
**proposed_dag_node:** UTSUSHI-200

More prose between findings. The parser should not treat this as
detail or as a stray field.

### Finding: KAIFUU-188 [P0] honest-prototype
**summary:** 10000-slot envelope must come from a real Seen.txt run, not a fixture
**file_ref:** crates/kaifuu-reallive/src/lib.rs:62

### Finding: ITOTORI-202 [P2] fixture-shaped
**summary:** DB-suite failure discipline missing for the audit-findings table
`;

describe("audit-findings bootstrap", () => {
  it("parses every structured finding block in scan order", () => {
    const parsed = parseAuditMarkdown({
      auditReportId: "docs/audits/synthetic.md",
      markdown: sampleMarkdown,
    });
    expect(parsed).toHaveLength(3);
    expect(parsed.map((row) => row.nodeId)).toEqual(["UTSUSHI-200", "KAIFUU-188", "ITOTORI-202"]);
    expect(parsed[0]!.severity).toBe("P1");
    expect(parsed[0]!.fileRef).toBe("crates/utsushi-reallive/src/lib.rs:1");
    expect(parsed[0]!.proposedDagNode).toBe("UTSUSHI-200");
    expect(parsed[0]!.detail).toContain("substrate boundary");
    expect(parsed[1]!.detail).toBeNull();
    expect(parsed[2]!.fileRef).toBeNull();
  });

  it("inserts each parsed finding through the repository port with the expected shape", async () => {
    const { port, recorded } = stubPort();
    const { summary, records } = await bootstrapAuditFindingsFromBlobs(port, actor, [
      { auditReportId: "docs/audits/synthetic.md", markdown: sampleMarkdown },
    ]);

    expect(summary.reportsScanned).toBe(1);
    expect(summary.reportsWithFindings).toBe(1);
    expect(summary.findingsInserted).toBe(3);
    expect(summary.perReport[0]).toEqual({
      auditReportId: "docs/audits/synthetic.md",
      findingsInserted: 3,
    });
    expect(records).toHaveLength(3);
    expect(recorded.map((row) => row.input.nodeId)).toEqual([
      "UTSUSHI-200",
      "KAIFUU-188",
      "ITOTORI-202",
    ]);
    expect(recorded[0]!.input.severity).toBe("P1");
    expect(recorded[0]!.input.category).toBe("load-bearing");
    expect(recorded[0]!.input.fileRef).toBe("crates/utsushi-reallive/src/lib.rs:1");
  });

  it("reports zero findings honestly for a markdown blob with no structured blocks", async () => {
    const { port } = stubPort();
    const { summary } = await bootstrapAuditFindingsFromBlobs(port, actor, [
      {
        auditReportId: "docs/audits/narrative.md",
        markdown: "# Narrative-only doc\n\nPure prose, no structured findings here.\n",
      },
    ]);
    expect(summary.reportsScanned).toBe(1);
    expect(summary.reportsWithFindings).toBe(0);
    expect(summary.findingsInserted).toBe(0);
  });

  it("throws AuditFindingParseError on an unknown severity tag", () => {
    expect(() =>
      parseAuditMarkdown({
        auditReportId: "docs/audits/bad-severity.md",
        markdown: "### Finding: UTSUSHI-200 [P9] category\n**summary:** garbage\n",
      }),
    ).toThrow(AuditFindingParseError);
  });

  it("throws AuditFindingParseError when the **summary:** field is missing", () => {
    expect(() =>
      parseAuditMarkdown({
        auditReportId: "docs/audits/missing-summary.md",
        markdown: "### Finding: UTSUSHI-200 [P1] category\n**file_ref:** x.rs:1\n",
      }),
    ).toThrow(AuditFindingParseError);
  });
});
