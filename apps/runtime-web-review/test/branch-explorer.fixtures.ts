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

// The branch explorer page handler: parse the query, run the page builder over
// the synthetic read model, and serve JSON. A malformed query (e.g. an unknown
// coverage status or a non-positive page) becomes a 400 error response so the
// UI can surface it.
export const branchCoverageHandler = http.get(BRANCH_EXPLORER_TEST_ENDPOINT, ({ request }) => {
  const model = syntheticBranchCoverageModel();
  let query;
  try {
    query = parseBranchExplorerQuery(new URL(request.url));
  } catch (error) {
    return errorResponse(400, "invalid_query", messageOf(error));
  }
  try {
    return HttpResponse.json(buildBranchCoveragePage(model, query));
  } catch (error) {
    return errorResponse(400, "invalid_query", messageOf(error));
  }
});

// The error-state fixture: an unconditional 500 so the client's error path is
// exercised.
export const branchCoverageErrorHandler = http.get(BRANCH_EXPLORER_ERROR_ENDPOINT, () =>
  errorResponse(500, "branch_coverage_unavailable", "branch coverage read model is unavailable"),
);

export const branchExplorerHandlers = [branchCoverageHandler, branchCoverageErrorHandler];

function errorResponse(status: number, code: string, message: string): HttpResponse {
  const body: BranchExplorerError = { error: { code, message } };
  return HttpResponse.json(body, { status });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
