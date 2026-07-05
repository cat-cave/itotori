import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BRANCH_COVERAGE_READ_MODEL_SCHEMA_VERSION,
  BRANCH_COVERAGE_SEED_FIXTURE,
  branchCoverageRecordsByStatus,
  deriveCoverageStatus,
  readModelFromFixture,
  seedBranchCoverageReadModel,
  type BranchCoverageFixture,
} from "../src/branch-coverage.js";

// The single committed source of truth for the join inputs. Shared
// byte-for-byte with the Rust integration test. vitest runs from the
// package directory, so the repo-relative path climbs two levels.
function loadCommittedFixture(): BranchCoverageFixture {
  const fixturePath = resolve(
    process.cwd(),
    "../../crates/utsushi-core/tests/fixtures/conformance/branch_coverage/coverage_status.json",
  );
  return JSON.parse(readFileSync(fixturePath, "utf8")) as BranchCoverageFixture;
}

describe("MV/MZ branch coverage read model (dashboard seed)", () => {
  it("keeps the inline dashboard seed in parity with the committed Rust fixture", () => {
    expect(BRANCH_COVERAGE_SEED_FIXTURE).toEqual(loadCommittedFixture());
  });

  it("records branch ids, route-map ids, observed trace ids, reachable text counts, and status", () => {
    const model = seedBranchCoverageReadModel();
    expect(model.schemaVersion).toBe(BRANCH_COVERAGE_READ_MODEL_SCHEMA_VERSION);
    expect(model.adapterId).toBe("utsushi-synthetic");
    for (const record of model.records) {
      expect(typeof record.branchId).toBe("string");
      expect(Array.isArray(record.routeMapIds)).toBe(true);
      expect(Array.isArray(record.observedTraceIds)).toBe(true);
      expect(typeof record.reachableTextCount).toBe("number");
      expect(["visited", "unvisited", "ambiguous", "unreachable"]).toContain(record.coverageStatus);
    }
  });

  it("joins trace->route->coverage-status across all four MV/MZ branch states", () => {
    const model = seedBranchCoverageReadModel();
    const byId = new Map(model.records.map((record) => [record.branchId, record]));

    const visited = byId.get("mvmz.map012.ev003.choice0.opt0");
    expect(visited?.coverageStatus).toBe("visited");
    expect(visited?.routeMapIds).toEqual(["0190a000-0000-7000-8000-0000000000a1"]);
    expect(visited?.observedTraceIds).toEqual(["trace-0001", "trace-0002"]);
    expect(visited?.reachableTextCount).toBe(3);

    const unvisited = byId.get("mvmz.map012.ev003.choice0.opt1");
    expect(unvisited?.coverageStatus).toBe("unvisited");
    expect(unvisited?.routeMapIds).toEqual(["0190a000-0000-7000-8000-0000000000a2"]);
    expect(unvisited?.observedTraceIds).toEqual([]);

    const ambiguous = byId.get("mvmz.map014.ev007.choice1.opt0");
    expect(ambiguous?.coverageStatus).toBe("ambiguous");
    expect(ambiguous?.routeMapIds).toEqual([]);
    expect(ambiguous?.observedTraceIds).toEqual(["trace-0003"]);

    const unreachable = byId.get("mvmz.map020.ev001.choice0.opt2");
    expect(unreachable?.coverageStatus).toBe("unreachable");
    expect(unreachable?.routeMapIds).toEqual([]);
    expect(unreachable?.observedTraceIds).toEqual([]);
  });

  it("separates covered (visited) from uncovered (unvisited) branches", () => {
    const model = seedBranchCoverageReadModel();
    const covered = branchCoverageRecordsByStatus(model, "visited");
    const uncovered = branchCoverageRecordsByStatus(model, "unvisited");
    expect(covered.map((record) => record.branchId)).toEqual(["mvmz.map012.ev003.choice0.opt0"]);
    expect(uncovered.map((record) => record.branchId)).toEqual(["mvmz.map012.ev003.choice0.opt1"]);
    expect(covered.every((record) => record.observedTraceIds.length > 0)).toBe(true);
    expect(uncovered.every((record) => record.observedTraceIds.length === 0)).toBe(true);
  });

  it("summarizes each coverage state and the reachable-text totals", () => {
    const { summary } = seedBranchCoverageReadModel();
    expect(summary).toEqual({
      branchCount: 4,
      visited: 1,
      unvisited: 1,
      ambiguous: 1,
      unreachable: 1,
      totalReachableText: 6,
      coveredReachableText: 3,
    });
  });

  it("is queryable without launching a runtime host (pure + synchronous)", () => {
    // The whole read model is produced from static seed data by a pure,
    // synchronous function: no network request, browser, or screenshot.
    const model = seedBranchCoverageReadModel();
    expect(model).not.toBeInstanceOf(Promise);
    expect(typeof (model as { then?: unknown }).then).toBe("undefined");
    // Deterministic: the seed and an explicit fixture join agree exactly.
    expect(model).toEqual(readModelFromFixture(BRANCH_COVERAGE_SEED_FIXTURE));
  });

  it("derives coverage status deterministically from the join shape", () => {
    expect(deriveCoverageStatus(1, true)).toBe("visited");
    expect(deriveCoverageStatus(1, false)).toBe("unvisited");
    expect(deriveCoverageStatus(0, true)).toBe("ambiguous");
    expect(deriveCoverageStatus(2, true)).toBe("ambiguous");
    expect(deriveCoverageStatus(0, false)).toBe("unreachable");
  });
});
