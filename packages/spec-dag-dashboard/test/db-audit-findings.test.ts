import { afterEach, describe, expect, it, vi } from "vitest";

const databaseClient = {
  connect: vi.fn(),
  query: vi.fn(),
  end: vi.fn(),
};

function MockDatabaseClient(): typeof databaseClient {
  return databaseClient;
}

vi.mock("pg", () => ({
  default: {
    Client: MockDatabaseClient,
  },
}));

import {
  AuditFindingsLoadError,
  loadAuditFindingsByNode,
  rowsToByNode,
  type AuditFindingsByNode,
} from "../src/db-audit-findings.js";
import { buildDashboardData, enrich, mergeAuditFindings } from "../src/enrich.js";
import { renderHtml } from "../src/render.js";
import type { DashboardData, EnrichedNode, Provenance, SpecNode } from "../src/types.js";

function node(partial: Partial<SpecNode> & { id: string }): SpecNode {
  return {
    title: partial.id + " title",
    status: "planned",
    priority: "P2",
    target: "alpha",
    parallelGroup: "g",
    ...partial,
  } as SpecNode;
}

const provenance: Provenance = {
  headShortSha: "abc1234",
  generatedAt: "2026-06-24T17:00:00.000Z",
  dirty: false,
  commitsBehind: 0,
  originMainKnown: true,
};

afterEach(() => {
  databaseClient.connect.mockReset();
  databaseClient.query.mockReset();
  databaseClient.end.mockReset();
});

describe("loadAuditFindingsByNode", () => {
  it("surfaces a database shutdown failure after a successful query", async () => {
    databaseClient.connect.mockResolvedValue(undefined);
    databaseClient.query.mockResolvedValue({ rows: [] });
    databaseClient.end.mockRejectedValue(new Error("forced shutdown failure"));

    await expect(loadAuditFindingsByNode("postgres://audit-test")).rejects.toMatchObject({
      code: "shutdown_failed",
      message: "failed to close itotori_audit_findings database client: forced shutdown failure",
    });
    expect(databaseClient.end).toHaveBeenCalledTimes(1);
  });

  it("retains the query failure when shutdown also fails", async () => {
    databaseClient.connect.mockRejectedValue(new Error("forced connection failure"));
    databaseClient.end.mockRejectedValue(new Error("forced shutdown failure"));

    await expect(loadAuditFindingsByNode("postgres://audit-test")).rejects.toMatchObject({
      code: "query_failed",
      message:
        "failed to query itotori_audit_findings: forced connection failure; database client shutdown also failed: forced shutdown failure",
      shutdownError: new Error("forced shutdown failure"),
    });
  });
});

describe("rowsToByNode", () => {
  it("buckets rows by node_id and counts open findings per severity", () => {
    const byNode = rowsToByNode([
      {
        audit_finding_id: "audit-finding-1",
        audit_report_id: "docs/audits/x.md",
        node_id: "TEST-NODE-1",
        severity: "P0",
        category: "load-bearing",
        summary: "wrapper-shaped AC",
        file_ref: "crates/utsushi-reallive/src/lib.rs:1",
        proposed_dag_node: "TEST-NODE-3",
        status: "open",
      },
      {
        audit_finding_id: "audit-finding-2",
        audit_report_id: "docs/audits/x.md",
        node_id: "TEST-NODE-1",
        severity: "P1",
        category: "honest-prototype",
        summary: "fixture round-trip is tautological",
        file_ref: null,
        proposed_dag_node: null,
        status: "open",
      },
      {
        audit_finding_id: "audit-finding-3",
        audit_report_id: "docs/audits/y.md",
        node_id: "TEST-NODE-2",
        severity: "P0",
        category: "load-bearing",
        summary: "10000-slot envelope must come from real Seen.txt",
        file_ref: null,
        proposed_dag_node: null,
        status: "open",
      },
    ]);

    expect(byNode.get("TEST-NODE-1")?.counts).toEqual({ P0: 1, P1: 1, P2: 0, P3: 0 });
    expect(byNode.get("TEST-NODE-1")?.openFindings).toHaveLength(2);
    expect(byNode.get("TEST-NODE-2")?.counts).toEqual({ P0: 1, P1: 0, P2: 0, P3: 0 });
    expect(byNode.get("TEST-NODE-2")?.openFindings).toHaveLength(1);
  });

  it("throws AuditFindingsLoadError on an unknown severity", () => {
    expect(() =>
      rowsToByNode([
        {
          audit_finding_id: "audit-finding-bad",
          audit_report_id: "docs/audits/x.md",
          node_id: "TEST-NODE-1",
          severity: "P9",
          category: "x",
          summary: "x",
          file_ref: null,
          proposed_dag_node: null,
          status: "open",
        },
      ]),
    ).toThrow(AuditFindingsLoadError);
  });
});

describe("mergeAuditFindings", () => {
  it("attaches findings to the matching node and leaves other nodes empty", () => {
    const dag = {
      schemaVersion: "0.1.0",
      nodes: [node({ id: "TEST-NODE-1" }), node({ id: "TEST-NODE-2" }), node({ id: "X-001" })],
    };
    const enriched = enrich(dag, []);
    const byNode: AuditFindingsByNode = rowsToByNode([
      {
        audit_finding_id: "audit-finding-1",
        audit_report_id: "docs/audits/x.md",
        node_id: "TEST-NODE-1",
        severity: "P0",
        category: "load-bearing",
        summary: "summary one",
        file_ref: null,
        proposed_dag_node: null,
        status: "open",
      },
    ]);
    const merged = mergeAuditFindings(enriched.nodes, byNode);
    const utsu = merged.find((n) => n.id === "TEST-NODE-1");
    const x = merged.find((n) => n.id === "X-001");
    expect(utsu?.findings.counts).toEqual({ P0: 1, P1: 0, P2: 0, P3: 0 });
    expect(utsu?.findings.openFindings).toHaveLength(1);
    expect(x?.findings.counts).toEqual({ P0: 0, P1: 0, P2: 0, P3: 0 });
    expect(x?.findings.openFindings).toHaveLength(0);
  });
});

describe("renderHtml audit-findings integration", () => {
  function dataWithFindings(
    nodes: EnrichedNode[],
    status: DashboardData["auditFindingsStatus"],
  ): DashboardData {
    const dag = { schemaVersion: "0.1.0", nodes };
    const enriched = { nodes, counts: {}, edgeCount: 0, globalIssues: [] };
    return buildDashboardData(dag, [], enriched, provenance, status);
  }

  function nodeWithFindings(
    id: string,
    findings: EnrichedNode["findings"]["openFindings"],
  ): EnrichedNode {
    const counts = { P0: 0, P1: 0, P2: 0, P3: 0 };
    for (const f of findings) {
      counts[f.severity] += 1;
    }
    return {
      id,
      title: id + " title",
      status: "planned",
      priority: "P2",
      target: "alpha",
      parallelGroup: "g",
      dependents: [],
      ready: true,
      blockedBy: [],
      issues: [],
      findings: { counts, openFindings: findings },
    };
  }

  it("renders the loaded banner and per-node finding badges into the static HTML", () => {
    const nodes = [
      nodeWithFindings("TEST-NODE-1", [
        {
          auditFindingId: "audit-finding-1",
          auditReportId: "docs/audits/alpha-scope-honesty.md",
          severity: "P0",
          category: "load-bearing",
          summary: "wrapper-shaped AC",
          fileRef: "crates/utsushi-reallive/src/lib.rs:1",
          proposedDagNode: "TEST-NODE-3",
        },
      ]),
    ];
    const data = dataWithFindings(nodes, {
      kind: "loaded",
      nodesWithFindings: 1,
      totalOpenFindings: 1,
    });
    const html = renderHtml(data, "/*c*/");
    expect(html).toContain("audit findings: 1 open / 1 nodes");
    expect(html).toContain('class="auditbanner ok"');
    expect(html).toContain('data-node-id="TEST-NODE-1"');
    expect(html).toContain('data-finding-id="audit-finding-1"');
    expect(html).toContain("wrapper-shaped AC");
    expect(html).toContain('class="fb P0"');
  });

  it("renders the missing-DATABASE_URL warning when the flag is set but the URL is unset", () => {
    const data = dataWithFindings([], {
      kind: "disabled",
      reason: "database_url_not_set",
    });
    const html = renderHtml(data, "/*c*/");
    expect(html).toContain("DATABASE_URL not set; audit findings not rendered");
    expect(html).toContain('class="auditbanner warn"');
  });

  it("renders the typed error message when the DB query fails", () => {
    const data = dataWithFindings([], {
      kind: "error",
      reason: "failed to query itotori_audit_findings: connection refused",
    });
    const html = renderHtml(data, "/*c*/");
    expect(html).toContain("audit findings could not be loaded");
    expect(html).toContain("connection refused");
    expect(html).toContain('class="auditbanner warn"');
  });

  it("renders the disabled-by-default banner when --with-audit-findings is not set", () => {
    const data = dataWithFindings([], { kind: "disabled", reason: "flag_not_set" });
    const html = renderHtml(data, "/*c*/");
    expect(html).toContain("audit findings: disabled");
    expect(html).toContain('class="auditbanner disabled"');
  });

  it("emits an empty server-fallback when no node has findings", () => {
    const nodes = [nodeWithFindings("TEST-NODE-1", [])];
    const data = dataWithFindings(nodes, {
      kind: "loaded",
      nodesWithFindings: 0,
      totalOpenFindings: 0,
    });
    const html = renderHtml(data, "/*c*/");
    expect(html).toContain('id="audit-findings-server-fallback" data-empty="true"');
  });

  it("escapes node ids and finding summaries to prevent HTML injection", () => {
    const nodes = [
      nodeWithFindings("EVIL-<script>", [
        {
          auditFindingId: "audit-finding-evil",
          auditReportId: "docs/audits/x.md",
          severity: "P0",
          category: "<bad>",
          summary: "<img src=x onerror=alert(1)>",
          fileRef: null,
          proposedDagNode: null,
        },
      ]),
    ];
    const data = dataWithFindings(nodes, {
      kind: "loaded",
      nodesWithFindings: 1,
      totalOpenFindings: 1,
    });
    const html = renderHtml(data, "/*c*/");
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("EVIL-&lt;script&gt;");
  });
});
