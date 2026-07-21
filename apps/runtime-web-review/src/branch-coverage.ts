// MV/MZ branch coverage read model — dashboard API seed.
//
// DATA-ONLY mirror of the Rust `utsushi_core::conformance::branch_coverage`
// read model. It JOINS MV/MZ runtime trace observations (branch id +
// route key + observed trace ids + reachable text count) with the Itotori
// route maps (route key -> route-map id) into a per-branch coverage view,
// then exposes a static SEED the dashboard can query WITHOUT launching a
// runtime host: no fetch, no browser playback, no screenshot capture.
//
// The seed fixture below is byte-parity checked against the committed Rust
// fixture `crates/utsushi-core/tests/fixtures/conformance/branch_coverage/
// coverage_status.json` so the two languages share one source of truth.

export const BRANCH_COVERAGE_READ_MODEL_SCHEMA_VERSION = "utsushi.branch_coverage.v0.1";

// The four MV/MZ branch states. DERIVED from the join, never observed
// directly.
export type CoverageStatus = "visited" | "unvisited" | "ambiguous" | "unreachable";

// Join INPUT A: one MV/MZ runtime-trace branch observation.
export type BranchTraceObservation = {
  branchId: string;
  // The route key the branch's choice option leads to
  // (`LinkedChoiceOption.route_key`). Absent when unlinked.
  routeKey?: string;
  // Observed runtime trace event ids (`ObservedTextEvent.event_id`).
  // Empty = never observed at runtime.
  observedTraceIds: string[];
  // Reachable runtime-visible text events on this branch.
  reachableTextCount: number;
};

// Join INPUT B: one Itotori route-map entry (`RouteMap`). `routeKey` is
// the join column.
export type RouteMapEntry = {
  routeMapId: string;
  routeKey: string;
};

// A committed fixture: the raw join inputs.
export type BranchCoverageFixture = {
  adapterId?: string;
  observations: BranchTraceObservation[];
  routeMap: RouteMapEntry[];
};

// One joined branch-coverage record.
export type BranchCoverageRecord = {
  branchId: string;
  routeKey?: string;
  routeMapIds: string[];
  observedTraceIds: string[];
  reachableTextCount: number;
  coverageStatus: CoverageStatus;
};

export type BranchCoverageSummary = {
  branchCount: number;
  visited: number;
  unvisited: number;
  ambiguous: number;
  unreachable: number;
  totalReachableText: number;
  coveredReachableText: number;
};

export type BranchCoverageReadModel = {
  schemaVersion: string;
  adapterId: string;
  records: BranchCoverageRecord[];
  summary: BranchCoverageSummary;
};

const FIXTURE_ADAPTER_ID = "utsushi-synthetic";

// Derive the per-branch coverage status from the join result. Mirrors the
// Rust `derive_coverage_status` table exactly:
//   1 route-map id + observed        -> visited
//   1 route-map id + not observed    -> unvisited
//   0 route-map ids + not observed   -> unreachable
//   0 route-map ids + observed, OR   -> ambiguous  (dangling target)
//   >1 route-map ids                 -> ambiguous  (multiple routes)
export function deriveCoverageStatus(routeMapIdCount: number, observed: boolean): CoverageStatus {
  if (routeMapIdCount === 1) {
    return observed ? "visited" : "unvisited";
  }
  if (routeMapIdCount === 0 && !observed) {
    return "unreachable";
  }
  return "ambiguous";
}

function isValidToken(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !/\s/u.test(value);
}

// Join MV/MZ trace observations against the Itotori route map into the
// branch-coverage read model. Pure data reshape: no runtime host.
export function joinBranchCoverage(
  adapterId: string,
  observations: BranchTraceObservation[],
  routeMap: RouteMapEntry[],
): BranchCoverageReadModel {
  // route key -> sorted, de-duplicated route-map ids.
  const routeIndex = new Map<string, Set<string>>();
  for (const entry of routeMap) {
    if (!isValidToken(entry.routeKey)) {
      throw new Error(`route key ${JSON.stringify(entry.routeKey)} is malformed`);
    }
    if (!isValidToken(entry.routeMapId)) {
      throw new Error(`route map id ${JSON.stringify(entry.routeMapId)} is malformed`);
    }
    const ids = routeIndex.get(entry.routeKey) ?? new Set<string>();
    ids.add(entry.routeMapId);
    routeIndex.set(entry.routeKey, ids);
  }

  const seenBranches = new Set<string>();
  const summary: BranchCoverageSummary = {
    branchCount: 0,
    visited: 0,
    unvisited: 0,
    ambiguous: 0,
    unreachable: 0,
    totalReachableText: 0,
    coveredReachableText: 0,
  };
  const records: BranchCoverageRecord[] = [];

  for (const observation of observations) {
    if (!isValidToken(observation.branchId)) {
      throw new Error(`branch id ${JSON.stringify(observation.branchId)} is malformed`);
    }
    if (seenBranches.has(observation.branchId)) {
      throw new Error(`duplicate branch id ${JSON.stringify(observation.branchId)}`);
    }
    seenBranches.add(observation.branchId);

    const routeMapIds =
      observation.routeKey === undefined
        ? []
        : [...(routeIndex.get(observation.routeKey) ?? new Set<string>())].sort();

    // De-duplicate observed trace ids, preserving first-seen order.
    const observedTraceIds: string[] = [];
    const traceSeen = new Set<string>();
    for (const traceId of observation.observedTraceIds) {
      if (!isValidToken(traceId)) {
        throw new Error(
          `observed trace id ${JSON.stringify(traceId)} on branch ${JSON.stringify(observation.branchId)} is malformed`,
        );
      }
      if (!traceSeen.has(traceId)) {
        traceSeen.add(traceId);
        observedTraceIds.push(traceId);
      }
    }

    const observed = observedTraceIds.length > 0;
    const coverageStatus = deriveCoverageStatus(routeMapIds.length, observed);

    summary.branchCount += 1;
    summary.totalReachableText += observation.reachableTextCount;
    switch (coverageStatus) {
      case "visited":
        summary.visited += 1;
        summary.coveredReachableText += observation.reachableTextCount;
        break;
      case "unvisited":
        summary.unvisited += 1;
        break;
      case "ambiguous":
        summary.ambiguous += 1;
        break;
      case "unreachable":
        summary.unreachable += 1;
        break;
    }

    records.push({
      branchId: observation.branchId,
      ...(observation.routeKey === undefined ? {} : { routeKey: observation.routeKey }),
      routeMapIds,
      observedTraceIds,
      reachableTextCount: observation.reachableTextCount,
      coverageStatus,
    });
  }

  records.sort((a, b) => (a.branchId < b.branchId ? -1 : a.branchId > b.branchId ? 1 : 0));

  return {
    schemaVersion: BRANCH_COVERAGE_READ_MODEL_SCHEMA_VERSION,
    adapterId,
    records,
    summary,
  };
}

// Build a read model from a committed fixture (the join inputs).
export function readModelFromFixture(fixture: BranchCoverageFixture): BranchCoverageReadModel {
  return joinBranchCoverage(
    fixture.adapterId ?? FIXTURE_ADAPTER_ID,
    fixture.observations,
    fixture.routeMap,
  );
}

// Static seed fixture — byte-parity with the committed Rust fixture
// `crates/utsushi-core/tests/fixtures/conformance/branch_coverage/
// coverage_status.json`. Kept inline so the dashboard seed is queryable
// with no filesystem or runtime host.
export const BRANCH_COVERAGE_SEED_FIXTURE: BranchCoverageFixture = {
  adapterId: "utsushi-synthetic",
  observations: [
    {
      branchId: "mvmz.map012.ev003.choice0.opt0",
      routeKey: "route_true_end",
      observedTraceIds: ["trace-0001", "trace-0002"],
      reachableTextCount: 3,
    },
    {
      branchId: "mvmz.map012.ev003.choice0.opt1",
      routeKey: "route_bad_end",
      observedTraceIds: [],
      reachableTextCount: 2,
    },
    {
      branchId: "mvmz.map014.ev007.choice1.opt0",
      routeKey: "route_orphaned_end",
      observedTraceIds: ["trace-0003"],
      reachableTextCount: 1,
    },
    {
      branchId: "mvmz.map020.ev001.choice0.opt2",
      observedTraceIds: [],
      reachableTextCount: 0,
    },
  ],
  routeMap: [
    { routeMapId: "0190a000-0000-7000-8000-0000000000a1", routeKey: "route_true_end" },
    { routeMapId: "0190a000-0000-7000-8000-0000000000a2", routeKey: "route_bad_end" },
  ],
};

// The dashboard-consumable seed: the fully joined read model. Pure —
// queryable without launching a runtime host.
export function seedBranchCoverageReadModel(): BranchCoverageReadModel {
  return readModelFromFixture(BRANCH_COVERAGE_SEED_FIXTURE);
}

// Convenience query: records in a given coverage state.
export function branchCoverageRecordsByStatus(
  model: BranchCoverageReadModel,
  status: CoverageStatus,
): BranchCoverageRecord[] {
  return model.records.filter((record) => record.coverageStatus === status);
}
