import { describe, expect, it } from "vitest";

import { renderHtml } from "../src/render.js";
import type { DashboardData } from "../src/types.js";

function dataWith(provenance: DashboardData["provenance"]): DashboardData {
  return {
    generatedAt: provenance.generatedAt,
    schemaVersion: "0.1.0",
    metadata: {},
    counts: { planned: 1 },
    edgeCount: 0,
    errorCount: 0,
    globalIssues: [],
    nodes: [
      {
        id: "A-001",
        title: "Node <one>",
        status: "planned",
        priority: "P0",
        target: "alpha",
        parallelGroup: "g",
        dependents: [],
        ready: true,
        blockedBy: [],
        issues: [],
      },
    ],
    provenance,
  };
}

const clean: DashboardData["provenance"] = {
  headShortSha: "abc1234",
  generatedAt: "2026-06-19T00:00:00.000Z",
  dirty: false,
  commitsBehind: 0,
  originMainKnown: true,
};

describe("renderHtml", () => {
  it("produces a complete document", () => {
    const html = renderHtml(dataWith(clean), "/*c*/");
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("var DATA =");
    expect(html).toContain("/*c*/");
    expect(html).toContain("provbanner");
  });

  it("escapes < inside the embedded JSON so the script can't close early", () => {
    const html = renderHtml(dataWith(clean), "/*c*/");
    // The node title contains "<one>" which must be escaped in the DATA blob.
    expect(html).toContain("\\u003cone>");
    // And there must be no raw "<one>" leaking into the DATA assignment.
    const dataLine = html.split("var DATA = ")[1]!.split("\n")[0]!;
    expect(dataLine.includes("<one>")).toBe(false);
  });

  it("embeds the head sha", () => {
    const html = renderHtml(dataWith(clean), "/*c*/");
    expect(html).toContain("abc1234");
  });

  it("carries behind/dirty provenance through into the DATA payload", () => {
    const stale: DashboardData["provenance"] = {
      headShortSha: "deadbee",
      generatedAt: "2026-06-19T00:00:00.000Z",
      dirty: true,
      commitsBehind: 5,
      originMainKnown: true,
    };
    const html = renderHtml(dataWith(stale), "/*c*/");
    expect(html).toContain("deadbee");
    expect(html).toContain('"commitsBehind":5');
    expect(html).toContain('"dirty":true');
  });
});
