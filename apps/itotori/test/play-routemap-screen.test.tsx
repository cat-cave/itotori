// @vitest-environment jsdom
// play-routemap-ui — behavior-first test for the Play RouteMap route/choice tree.
//
// Mounts the REAL `PlayRouteMapScreen` over msw-intercepted `play.routeMap`
// and asserts the OBSERVABLE behavior:
//
//   1. the RouteMap paints each route's coverage state from the read-model;
//   2. choice edges render (from → to + label);
//   3. selecting a node stamps col/row/state/coverage/issues on the detail
//      panel;
//   4. loading / empty / error states are handled.
//
// [[feedback_behavior_first_code_agnostic_testing]] — no game is named; only
// the rendered coverage badges + choice edges + states are asserted.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http } from "msw";
import { setupServer } from "msw/node";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { ApiPlayRouteMapResponse, ApiPlaySceneCoverageResponse } from "../src/api-schema.js";
import { PlayRouteMapScreen } from "../src/ui/screens/PlayRouteMapScreen.js";
import { apiJson } from "./msw-handlers.js";

const ROUTE_MAP_PATH = "*/api/projects/:projectId/locale-branches/:localeBranchId/route-map";
const SCENE_COVERAGE_PATH =
  "*/api/projects/:projectId/locale-branches/:localeBranchId/scene-coverage";

function routeMapResponse(
  overrides: Partial<ApiPlayRouteMapResponse> = {},
): ApiPlayRouteMapResponse {
  const nodes: ApiPlayRouteMapResponse["nodes"] = overrides.nodes ?? [
    {
      routeKey: "route-opening",
      routeMapId: "rm-1",
      label: "Opening",
      summary: "The story begins at the school gate.",
      col: 0,
      row: 0,
      state: "fresh",
      coverage: "fresh",
      issues: 0,
    },
    {
      routeKey: "route-branch-a",
      routeMapId: "rm-2",
      label: "Branch A",
      summary: "The heroine path continues.",
      col: 1,
      row: 0,
      state: "stale",
      coverage: "stale",
      issues: 1,
    },
  ];
  const edges: ApiPlayRouteMapResponse["edges"] = overrides.edges ?? [
    {
      fromRouteKey: "route-opening",
      toRouteKey: "route-branch-a",
      choiceKey: "choice-1",
      choiceKind: "RouteBranch",
      label: "Follow her",
    },
  ];
  const counts = overrides.counts ?? {
    fresh: nodes.filter((n) => n.coverage === "fresh").length,
    stale: nodes.filter((n) => n.coverage === "stale").length,
    total: nodes.length,
    choiceCount: edges.length,
  };
  return {
    schemaVersion: "itotori.play.route-map.v0",
    generatedAt: "2026-07-08T00:00:00.000Z",
    projectId: "project-1",
    localeBranchId: "locale-1",
    nodes,
    edges,
    counts,
    ...overrides,
  };
}

function sceneCoverageResponse(
  overrides: Partial<ApiPlaySceneCoverageResponse> = {},
): ApiPlaySceneCoverageResponse {
  const nodes: ApiPlaySceneCoverageResponse["nodes"] = overrides.nodes ?? [
    {
      sceneId: "route-opening",
      label: "Opening",
      coverageState: "validated",
      routeKey: "route-opening",
      routeMapId: "rm-1",
    },
    {
      sceneId: "route-branch-a",
      label: "Branch A",
      coverageState: "needs_check",
      routeKey: "route-branch-a",
      routeMapId: "rm-2",
    },
  ];
  const edges: ApiPlaySceneCoverageResponse["edges"] = overrides.edges ?? [
    {
      fromSceneId: "route-opening",
      toSceneId: "route-branch-a",
      choiceKey: "choice-1",
      label: "Follow her",
    },
  ];
  const counts = overrides.counts ?? {
    validated: nodes.filter((n) => n.coverageState === "validated").length,
    flagged: nodes.filter((n) => n.coverageState === "flagged").length,
    needsCheck: nodes.filter((n) => n.coverageState === "needs_check").length,
    total: nodes.length,
  };
  return {
    schemaVersion: "itotori.play.scene-coverage.v0",
    generatedAt: "2026-07-08T00:00:00.000Z",
    projectId: "project-1",
    localeBranchId: "locale-1",
    nodes,
    edges,
    counts,
    ...overrides,
  };
}

function mockRouteMapAndCoverage(
  routeMap: ApiPlayRouteMapResponse = routeMapResponse(),
  coverage: ApiPlaySceneCoverageResponse = sceneCoverageResponse(),
): void {
  server.use(
    http.get(ROUTE_MAP_PATH, () => apiJson("play.routeMap", routeMap)),
    http.get(SCENE_COVERAGE_PATH, () => apiJson("play.sceneCoverage", coverage)),
  );
}

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

describe("play-routemap-ui — PlayRouteMapScreen", () => {
  it("renders RouteMap nodes with coverage from the route-choice read-model", async () => {
    mockRouteMapAndCoverage();

    render(<PlayRouteMapScreen route={{ projectId: "project-1", localeBranchId: "locale-1" }} />);

    await waitFor(() => {
      expect(document.querySelector('[data-component="route-map"]')).not.toBeNull();
    });
    const map = document.querySelector('[data-component="route-map"]');
    expect(map?.getAttribute("data-node-count")).toBe("2");
    expect(map?.getAttribute("data-edge-count")).toBe("1");

    const opening = document.querySelector('[data-route-id="route-opening"]');
    expect(opening?.getAttribute("data-coverage")).toBe("fresh");
    expect(opening?.textContent).toMatch(/Opening/);
    expect(opening?.textContent).toMatch(/fresh/i);

    const branch = document.querySelector('[data-route-id="route-branch-a"]');
    expect(branch?.getAttribute("data-coverage")).toBe("stale");
    expect(branch?.getAttribute("data-issues")).toBe("1");
    expect(branch?.textContent).toMatch(/Branch A/);
    expect(branch?.textContent).toMatch(/stale/i);
    expect(branch?.textContent).toMatch(/1 issue/);

    // Choice edge from the route-choice read-model.
    const edge = document.querySelector('[data-from="route-opening"][data-to="route-branch-a"]');
    expect(edge).not.toBeNull();
    expect(edge?.textContent).toMatch(/Follow her/);

    // Counts panel reflects coverage tallies.
    expect(document.querySelector('[data-fresh-count="1"]')).not.toBeNull();
    expect(document.querySelector('[data-stale-count="1"]')).not.toBeNull();
    expect(document.querySelector('[data-choice-count="1"]')).not.toBeNull();
    expect(document.querySelector('[data-validated-count="1"]')).not.toBeNull();
    expect(document.querySelector('[data-needs-check-count="1"]')).not.toBeNull();
    expect(document.querySelector('[data-strip="mark-coverage"]')).not.toBeNull();
  });

  it("selecting a node stamps col/row/state/coverage/issues on the detail panel", async () => {
    mockRouteMapAndCoverage();

    render(<PlayRouteMapScreen route={{ projectId: "project-1", localeBranchId: "locale-1" }} />);

    await waitFor(() => {
      expect(document.querySelector('[data-route-id="route-branch-a"]')).not.toBeNull();
    });
    fireEvent.click(document.querySelector('[data-route-id="route-branch-a"]')!);

    await waitFor(() => {
      expect(document.querySelector('[data-selected-route-key="route-branch-a"]')).not.toBeNull();
    });
    const detail = document.querySelector('[data-selected-route-key="route-branch-a"]');
    expect(detail?.getAttribute("data-selected-coverage")).toBe("stale");
    expect(detail?.getAttribute("data-selected-scene-coverage")).toBe("needs_check");
    expect(detail?.getAttribute("data-selected-col")).toBe("1");
    expect(detail?.getAttribute("data-selected-row")).toBe("0");
    expect(detail?.getAttribute("data-selected-issues")).toBe("1");
    expect(detail?.textContent).toMatch(/heroine path/i);
  });

  it("settles into empty when the read-model has no nodes", async () => {
    mockRouteMapAndCoverage(
      routeMapResponse({
        nodes: [],
        edges: [],
        counts: { fresh: 0, stale: 0, total: 0, choiceCount: 0 },
      }),
      sceneCoverageResponse({
        nodes: [],
        edges: [],
        counts: { validated: 0, flagged: 0, needsCheck: 0, total: 0 },
      }),
    );

    render(<PlayRouteMapScreen route={{ projectId: "project-1", localeBranchId: "locale-1" }} />);

    expect(await screen.findByText(/No routes on the map/i)).toBeInTheDocument();
    expect(
      document.querySelector('[data-screen="play-routemap"]')?.getAttribute("data-state"),
    ).toBe("empty");
  });

  it("settles into error when the route-map read fails", async () => {
    server.use(
      http.get(
        ROUTE_MAP_PATH,
        () =>
          new Response(
            JSON.stringify({ code: "internal_error", error: "route map backend down" }),
            {
              status: 500,
              headers: { "content-type": "application/json" },
            },
          ),
      ),
      http.get(SCENE_COVERAGE_PATH, () => apiJson("play.sceneCoverage", sceneCoverageResponse())),
    );

    render(<PlayRouteMapScreen route={{ projectId: "project-1", localeBranchId: "locale-1" }} />);

    await waitFor(() => {
      expect(
        document.querySelector('[data-screen="play-routemap"]')?.getAttribute("data-state"),
      ).toBe("error");
    });
  });
});
