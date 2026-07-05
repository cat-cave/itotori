// MSW fixtures for the MV/MZ branch explorer API (UTSUSHI-067).
//
// SYNTHETIC ONLY. A single committed join fixture spanning all four coverage
// states (visited / unvisited / ambiguous / unreachable), joined through the
// UTSUSHI-009 read model, plus MSW handlers that front the branch explorer
// page builder. No live runtime, browser playback, or screenshot capture.

import { http, HttpResponse } from "msw";
import {
  readModelFromFixture,
  type BranchCoverageFixture,
  type BranchCoverageReadModel,
  type BranchTraceObservation,
  type RouteMapEntry,
} from "../src/branch-coverage.js";
import {
  buildBranchCoveragePage,
  parseBranchExplorerQuery,
  type BranchExplorerError,
} from "../src/branch-explorer.js";

// The MSW endpoints the branch explorer tests hit.
export const BRANCH_EXPLORER_TEST_ENDPOINT = "http://itotori.test/api/utsushi/v0.1/branch-coverage";
export const BRANCH_EXPLORER_ERROR_ENDPOINT =
  "http://itotori.test/api/utsushi/v0.1/branch-coverage-error";
// A LARGE route map (many branches across all four states) so the dashboard
// view's filter + pagination are exercised against a route map that cannot fit
// on one page — proving the view stays navigable at scale (UTSUSHI-068).
export const BRANCH_EXPLORER_LARGE_ENDPOINT =
  "http://itotori.test/api/utsushi/v0.1/branch-coverage-large";

// A synthetic fixture with multiple branches per coverage state so pagination
// and per-state filtering are exercised with real page boundaries. The join
// derives the coverage status from the (route-map-id count, observed) shape
// exactly as the UTSUSHI-009 read model does.
export const SYNTHETIC_BRANCH_COVERAGE_FIXTURE: BranchCoverageFixture = {
  adapterId: "utsushi-synthetic",
  observations: [
    // visited: one route-map id + observed.
    {
      branchId: "mvmz.explorer.visited.1",
      routeKey: "route_visited_a",
      observedTraceIds: ["trace-v1a"],
      reachableTextCount: 2,
    },
    {
      branchId: "mvmz.explorer.visited.2",
      routeKey: "route_visited_b",
      observedTraceIds: ["trace-v2a", "trace-v2b"],
      reachableTextCount: 3,
    },
    {
      branchId: "mvmz.explorer.visited.3",
      routeKey: "route_visited_c",
      observedTraceIds: ["trace-v3a"],
      reachableTextCount: 1,
    },
    // unvisited: one route-map id + never observed.
    {
      branchId: "mvmz.explorer.unvisited.1",
      routeKey: "route_unvisited_a",
      observedTraceIds: [],
      reachableTextCount: 2,
    },
    {
      branchId: "mvmz.explorer.unvisited.2",
      routeKey: "route_unvisited_b",
      observedTraceIds: [],
      reachableTextCount: 1,
    },
    // ambiguous: >1 route-map ids (multi-route target).
    {
      branchId: "mvmz.explorer.ambiguous.1",
      routeKey: "route_ambiguous_multi",
      observedTraceIds: ["trace-a1a"],
      reachableTextCount: 2,
    },
    // ambiguous: 0 route-map ids but observed (dangling target).
    {
      branchId: "mvmz.explorer.ambiguous.2",
      routeKey: "route_dangling",
      observedTraceIds: ["trace-a2a"],
      reachableTextCount: 1,
    },
    // unreachable: 0 route-map ids + never observed (unlinked branch).
    {
      branchId: "mvmz.explorer.unreachable.1",
      observedTraceIds: [],
      reachableTextCount: 0,
    },
    // unreachable: route key with no matching route map + never observed.
    {
      branchId: "mvmz.explorer.unreachable.2",
      routeKey: "route_missing",
      observedTraceIds: [],
      reachableTextCount: 0,
    },
  ],
  routeMap: [
    { routeMapId: "0190a067-0000-7000-8000-0000000000a1", routeKey: "route_visited_a" },
    { routeMapId: "0190a067-0000-7000-8000-0000000000a2", routeKey: "route_visited_b" },
    { routeMapId: "0190a067-0000-7000-8000-0000000000a3", routeKey: "route_visited_c" },
    { routeMapId: "0190a067-0000-7000-8000-0000000000b1", routeKey: "route_unvisited_a" },
    { routeMapId: "0190a067-0000-7000-8000-0000000000b2", routeKey: "route_unvisited_b" },
    // Two route maps share this key -> ambiguous.
    { routeMapId: "0190a067-0000-7000-8000-0000000000c1", routeKey: "route_ambiguous_multi" },
    { routeMapId: "0190a067-0000-7000-8000-0000000000c2", routeKey: "route_ambiguous_multi" },
  ],
};

export function syntheticBranchCoverageModel(): BranchCoverageReadModel {
  return readModelFromFixture(SYNTHETIC_BRANCH_COVERAGE_FIXTURE);
}

// How many branches per coverage state the large fixture generates. 70 per
// state -> 280 branches over a 280-entry route map (each ambiguous branch adds
// a second route map row). At the default page size of 20 that is 14 pages —
// far beyond one screen, so the view MUST rely on filter + pagination.
export const LARGE_BRANCHES_PER_STATUS = 70;

function pad(index: number): string {
  return String(index).padStart(4, "0");
}

// Deterministic route-map id shaped like the seed's UUID route-map ids.
function routeMapId(kind: string, index: number): string {
  return `0190a068-0000-7000-8000-${kind}${pad(index)}0000`;
}

// A LARGE synthetic join fixture: `perStatus` branches in each of the four
// coverage states, joined exactly as the UTSUSHI-009 read model does.
//   visited     -> 1 route map + observed
//   unvisited   -> 1 route map + never observed
//   ambiguous   -> 2 route maps sharing the branch's route key
//   unreachable -> 0 route maps + never observed
export function largeBranchCoverageFixture(
  perStatus: number = LARGE_BRANCHES_PER_STATUS,
): BranchCoverageFixture {
  const observations: BranchTraceObservation[] = [];
  const routeMap: RouteMapEntry[] = [];

  for (let i = 0; i < perStatus; i += 1) {
    const visitedKey = `route_large_visited_${pad(i)}`;
    routeMap.push({ routeMapId: routeMapId("aa", i), routeKey: visitedKey });
    observations.push({
      branchId: `mvmz.large.visited.${pad(i)}`,
      routeKey: visitedKey,
      observedTraceIds: [`trace-large-v-${pad(i)}`],
      reachableTextCount: 2,
    });

    const unvisitedKey = `route_large_unvisited_${pad(i)}`;
    routeMap.push({ routeMapId: routeMapId("bb", i), routeKey: unvisitedKey });
    observations.push({
      branchId: `mvmz.large.unvisited.${pad(i)}`,
      routeKey: unvisitedKey,
      observedTraceIds: [],
      reachableTextCount: 1,
    });

    const ambiguousKey = `route_large_ambiguous_${pad(i)}`;
    routeMap.push({ routeMapId: routeMapId("cc", i), routeKey: ambiguousKey });
    routeMap.push({ routeMapId: routeMapId("dd", i), routeKey: ambiguousKey });
    observations.push({
      branchId: `mvmz.large.ambiguous.${pad(i)}`,
      routeKey: ambiguousKey,
      observedTraceIds: [`trace-large-a-${pad(i)}`],
      reachableTextCount: 1,
    });

    observations.push({
      branchId: `mvmz.large.unreachable.${pad(i)}`,
      observedTraceIds: [],
      reachableTextCount: 0,
    });
  }

  return { adapterId: "utsushi-large", observations, routeMap };
}

export function largeBranchCoverageModel(): BranchCoverageReadModel {
  return readModelFromFixture(largeBranchCoverageFixture());
}

// Build a branch explorer page handler for a given endpoint + read-model
// factory: parse the query, run the page builder, and serve JSON. A malformed
// query (e.g. an unknown coverage status or a non-positive page) becomes a 400
// error response so the UI can surface it.
function coveragePageHandler(endpoint: string, model: () => BranchCoverageReadModel) {
  return http.get(endpoint, ({ request }) => {
    let query;
    try {
      query = parseBranchExplorerQuery(new URL(request.url));
    } catch (error) {
      return errorResponse(400, "invalid_query", messageOf(error));
    }
    try {
      return HttpResponse.json(buildBranchCoveragePage(model(), query));
    } catch (error) {
      return errorResponse(400, "invalid_query", messageOf(error));
    }
  });
}

// The synthetic (4-state) page handler.
export const branchCoverageHandler = coveragePageHandler(
  BRANCH_EXPLORER_TEST_ENDPOINT,
  syntheticBranchCoverageModel,
);

// The large-route-map page handler (many branches; forces filter + pagination).
export const branchCoverageLargeHandler = coveragePageHandler(
  BRANCH_EXPLORER_LARGE_ENDPOINT,
  largeBranchCoverageModel,
);

// The error-state fixture: an unconditional 500 so the client's error path is
// exercised.
export const branchCoverageErrorHandler = http.get(BRANCH_EXPLORER_ERROR_ENDPOINT, () =>
  errorResponse(500, "branch_coverage_unavailable", "branch coverage read model is unavailable"),
);

export const branchExplorerHandlers = [
  branchCoverageHandler,
  branchCoverageLargeHandler,
  branchCoverageErrorHandler,
];

function errorResponse(status: number, code: string, message: string): HttpResponse {
  const body: BranchExplorerError = { error: { code, message } };
  return HttpResponse.json(body, { status });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
