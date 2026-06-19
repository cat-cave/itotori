import { describe, expect, it } from "vitest";

import { buildDashboardData, enrich } from "../src/enrich.js";
import type { Provenance, SpecNode } from "../src/types.js";

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

function dagOf(nodes: SpecNode[]): { schemaVersion: string; nodes: SpecNode[] } {
  return { schemaVersion: "0.1.0", nodes };
}

describe("enrich", () => {
  it("derives dependents from dependsOn", () => {
    const nodes = [
      node({ id: "A-001", status: "complete", dependsOn: [] }),
      node({ id: "B-001", dependsOn: ["A-001"] }),
      node({ id: "C-001", dependsOn: ["A-001"] }),
    ];
    const { nodes: out } = enrich(dagOf(nodes), []);
    const a = out.find((n) => n.id === "A-001")!;
    expect(a.dependents.sort()).toEqual(["B-001", "C-001"]);
    expect(out.find((n) => n.id === "B-001")!.dependents).toEqual([]);
  });

  it("marks ready when planned and all deps complete", () => {
    const nodes = [
      node({ id: "A-001", status: "complete" }),
      node({ id: "B-001", status: "planned", dependsOn: ["A-001"] }),
    ];
    const { nodes: out } = enrich(dagOf(nodes), []);
    const b = out.find((n) => n.id === "B-001")!;
    expect(b.ready).toBe(true);
    expect(b.blockedBy).toEqual([]);
  });

  it("is not ready when a dep is incomplete and reports it in blockedBy", () => {
    const nodes = [
      node({ id: "A-001", status: "in_progress" }),
      node({ id: "B-001", status: "planned", dependsOn: ["A-001"] }),
    ];
    const { nodes: out } = enrich(dagOf(nodes), []);
    const b = out.find((n) => n.id === "B-001")!;
    expect(b.ready).toBe(false);
    expect(b.blockedBy).toEqual(["A-001"]);
  });

  it("never marks a non-planned node ready even with all deps complete", () => {
    const nodes = [
      node({ id: "A-001", status: "complete" }),
      node({ id: "B-001", status: "in_progress", dependsOn: ["A-001"] }),
      node({ id: "C-001", status: "complete", dependsOn: ["A-001"] }),
    ];
    const { nodes: out } = enrich(dagOf(nodes), []);
    expect(out.find((n) => n.id === "B-001")!.ready).toBe(false);
    expect(out.find((n) => n.id === "C-001")!.ready).toBe(false);
  });

  it("attributes /nodes/N path errors to the node at that index", () => {
    const nodes = [node({ id: "A-001" }), node({ id: "B-001" })];
    const err = "schema /nodes/1/title must be string";
    const { nodes: out, globalIssues } = enrich(dagOf(nodes), [err]);
    expect(out.find((n) => n.id === "B-001")!.issues).toEqual([err]);
    expect(out.find((n) => n.id === "A-001")!.issues).toEqual([]);
    expect(globalIssues).toEqual([]);
  });

  it("attributes bare id tokens to the matching node", () => {
    const nodes = [node({ id: "A-001" }), node({ id: "B-001" })];
    const err = "A-001 has a cycle";
    const { nodes: out } = enrich(dagOf(nodes), [err]);
    expect(out.find((n) => n.id === "A-001")!.issues).toEqual([err]);
    expect(out.find((n) => n.id === "B-001")!.issues).toEqual([]);
  });

  it("routes errors with no recognizable owner to globalIssues", () => {
    const nodes = [node({ id: "A-001" })];
    const err = "schemaVersion must be 0.1.0";
    const { nodes: out, globalIssues } = enrich(dagOf(nodes), [err]);
    expect(globalIssues).toEqual([err]);
    expect(out.find((n) => n.id === "A-001")!.issues).toEqual([]);
  });

  it("attributes a multi-id error to every referenced node", () => {
    const nodes = [node({ id: "A-001" }), node({ id: "B-001" }), node({ id: "C-001" })];
    const err = "edge A-001 -> B-001 is invalid";
    const { nodes: out } = enrich(dagOf(nodes), [err]);
    expect(out.find((n) => n.id === "A-001")!.issues).toEqual([err]);
    expect(out.find((n) => n.id === "B-001")!.issues).toEqual([err]);
    expect(out.find((n) => n.id === "C-001")!.issues).toEqual([]);
  });

  it("computes per-status counts and edge count", () => {
    const nodes = [
      node({ id: "A-001", status: "complete" }),
      node({ id: "B-001", status: "planned", dependsOn: ["A-001"] }),
      node({ id: "C-001", status: "planned", dependsOn: ["A-001", "B-001"] }),
    ];
    const { counts, edgeCount } = enrich(dagOf(nodes), []);
    expect(counts["complete"]).toBe(1);
    expect(counts["planned"]).toBe(2);
    expect(edgeCount).toBe(3);
  });

  it("sorts by priority -> target -> parallelGroup -> id", () => {
    const nodes = [
      node({ id: "Z-001", priority: "P0", target: "alpha", parallelGroup: "b" }),
      node({ id: "A-001", priority: "P0", target: "alpha", parallelGroup: "a" }),
      node({ id: "M-001", priority: "P0", target: "baseline", parallelGroup: "z" }),
      node({ id: "N-001", priority: "P1", target: "baseline", parallelGroup: "a" }),
    ];
    const { nodes: out } = enrich(dagOf(nodes), []);
    expect(out.map((n) => n.id)).toEqual(["M-001", "A-001", "Z-001", "N-001"]);
  });
});

describe("buildDashboardData", () => {
  it("assembles the serializable payload", () => {
    const nodes = [node({ id: "A-001", status: "complete" })];
    const errors = ["schemaVersion must be 0.1.0"];
    const enriched = enrich(dagOf(nodes), errors);
    const provenance: Provenance = {
      headShortSha: "abc1234",
      generatedAt: "2026-06-19T00:00:00.000Z",
      dirty: false,
      commitsBehind: 0,
      originMainKnown: true,
    };
    const data = buildDashboardData(dagOf(nodes), errors, enriched, provenance);
    expect(data.schemaVersion).toBe("0.1.0");
    expect(data.errorCount).toBe(1);
    expect(data.globalIssues).toEqual(errors);
    expect(data.nodes).toHaveLength(1);
    expect(data.provenance).toBe(provenance);
    expect(data.generatedAt).toBe("2026-06-19T00:00:00.000Z");
  });
});
