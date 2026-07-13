// @vitest-environment jsdom
// play-routemap-ui — behavior-first test for the canonical route/choice view.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http } from "msw";
import { setupServer } from "msw/node";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { ApiPlayRouteMapResponse } from "../src/api-schema.js";
import { PlayRouteMapScreen } from "../src/ui/screens/PlayRouteMapScreen.js";
import { apiJson } from "./msw-handlers.js";

const ROUTE_MAP_PATH = "*/api/projects/:projectId/locale-branches/:localeBranchId/route-map";

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
  return {
    schemaVersion: "itotori.play.route-map.v0",
    generatedAt: "2026-07-08T00:00:00.000Z",
    projectId: "project-1",
    localeBranchId: "locale-1",
    nodes,
    edges,
    counts: {
      fresh: nodes.filter((node) => node.coverage === "fresh").length,
      stale: nodes.filter((node) => node.coverage === "stale").length,
      total: nodes.length,
      choiceCount: edges.length,
    },
    ...overrides,
  };
}

function mockRouteMap(model: ApiPlayRouteMapResponse = routeMapResponse()): void {
  server.use(http.get(ROUTE_MAP_PATH, () => apiJson("play.routeMap", model)));
}

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

describe("play-routemap-ui — PlayRouteMapScreen", () => {
  it("renders the canonical route-map freshness and choice graph without manual review controls", async () => {
    mockRouteMap();

    render(<PlayRouteMapScreen route={{ projectId: "project-1", localeBranchId: "locale-1" }} />);

    await waitFor(() => {
      expect(document.querySelector('[data-component="route-map"]')).not.toBeNull();
    });
    const map = document.querySelector('[data-component="route-map"]');
    expect(map?.getAttribute("data-node-count")).toBe("2");
    expect(map?.getAttribute("data-edge-count")).toBe("1");

    const opening = document.querySelector('[data-route-id="route-opening"]');
    expect(opening?.getAttribute("data-coverage")).toBe("fresh");
    const branch = document.querySelector('[data-route-id="route-branch-a"]');
    expect(branch?.getAttribute("data-coverage")).toBe("stale");
    expect(branch?.getAttribute("data-issues")).toBe("1");
    expect(
      document.querySelector('[data-from="route-opening"][data-to="route-branch-a"]'),
    ).not.toBeNull();

    expect(document.querySelector('[data-fresh-count="1"]')).not.toBeNull();
    expect(document.querySelector('[data-stale-count="1"]')).not.toBeNull();
    expect(document.querySelector('[data-choice-count="1"]')).not.toBeNull();
    expect(document.querySelector('[data-strip="mark-coverage"]')).toBeNull();
  });

  it("stamps the selected route's canonical context status", async () => {
    mockRouteMap();

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
    expect(detail?.getAttribute("data-selected-col")).toBe("1");
    expect(detail?.getAttribute("data-selected-row")).toBe("0");
    expect(detail?.getAttribute("data-selected-issues")).toBe("1");
  });

  it("settles into empty when the canonical read-model has no routes", async () => {
    mockRouteMap(
      routeMapResponse({
        nodes: [],
        edges: [],
        counts: { fresh: 0, stale: 0, total: 0, choiceCount: 0 },
      }),
    );

    render(<PlayRouteMapScreen route={{ projectId: "project-1", localeBranchId: "locale-1" }} />);

    expect(await screen.findByText(/No routes on the map/i)).toBeInTheDocument();
    expect(document.querySelector('[data-screen="play-routemap"]')).toHaveAttribute(
      "data-state",
      "empty",
    );
  });

  it("settles into error when the canonical route-map read fails", async () => {
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
    );

    render(<PlayRouteMapScreen route={{ projectId: "project-1", localeBranchId: "locale-1" }} />);

    await waitFor(() => {
      expect(document.querySelector('[data-screen="play-routemap"]')).toHaveAttribute(
        "data-state",
        "error",
      );
    });
  });
});
