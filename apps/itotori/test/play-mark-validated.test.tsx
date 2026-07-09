// @vitest-environment jsdom
// play-mark-validated — behavior-first test for per-scene coverage + RouteMap.
//
// Mounts the REAL `PlayRouteMapScreen` over msw-intercepted `play.routeMap`,
// `play.sceneCoverage`, and `play.setSceneCoverage` and asserts the OBSERVABLE
// behavior:
//
//   1. the RouteMap paints each scene's coverage state from the read-model;
//   2. clicking "Mark validated" POSTs setSceneCoverage and the RouteMap
//      reflects the persisted `validated` state after reload;
//   3. loading / empty / error states are handled;
//   4. a write error surfaces as a visible alert (never a silent success).
//
// [[feedback_behavior_first_code_agnostic_testing]] — no game is named; only
// the rendered coverage badges + the API POST + outcome surfaces are asserted.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { http } from "msw";
import { setupServer } from "msw/node";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type {
  ApiPlayRouteMapResponse,
  ApiPlaySceneCoverageResponse,
  ApiPlaySetSceneCoverageResponse,
} from "../src/api-schema.js";
import { PlayRouteMapScreen } from "../src/ui/screens/PlayRouteMapScreen.js";
import { apiJson } from "./msw-handlers.js";

const ROUTE_MAP_PATH = "*/api/projects/:projectId/locale-branches/:localeBranchId/route-map";
const COVERAGE_PATH = "*/api/projects/:projectId/locale-branches/:localeBranchId/scene-coverage";

function routeMapResponse(
  nodes: ApiPlaySceneCoverageResponse["nodes"],
): ApiPlayRouteMapResponse {
  const routeNodes = nodes.map((node, index) => ({
    routeKey: node.routeKey,
    routeMapId: node.routeMapId,
    label: node.label,
    summary: `${node.label} summary`,
    col: index,
    row: 0,
    state: "fresh" as const,
    coverage: "fresh" as const,
    issues: 0,
  }));
  return {
    schemaVersion: "itotori.play.route-map.v0",
    generatedAt: "2026-07-08T00:00:00.000Z",
    projectId: "project-1",
    localeBranchId: "locale-1",
    nodes: routeNodes,
    edges:
      routeNodes.length >= 2
        ? [
            {
              fromRouteKey: routeNodes[0]!.routeKey,
              toRouteKey: routeNodes[1]!.routeKey,
              choiceKey: "choice-1",
              choiceKind: "RouteBranch",
              label: "Go further",
            },
          ]
        : [],
    counts: {
      fresh: routeNodes.length,
      stale: 0,
      total: routeNodes.length,
      choiceCount: routeNodes.length >= 2 ? 1 : 0,
    },
  };
}

function coverageResponse(
  nodes: ApiPlaySceneCoverageResponse["nodes"],
): ApiPlaySceneCoverageResponse {
  const counts = {
    needsCheck: nodes.filter((n) => n.coverageState === "needs_check").length,
    flagged: nodes.filter((n) => n.coverageState === "flagged").length,
    validated: nodes.filter((n) => n.coverageState === "validated").length,
    total: nodes.length,
  };
  return {
    schemaVersion: "itotori.play.scene-coverage.v0",
    generatedAt: "2026-07-08T00:00:00.000Z",
    projectId: "project-1",
    localeBranchId: "locale-1",
    nodes,
    edges: [
      {
        fromSceneId: "scene-a",
        toSceneId: "scene-b",
        choiceKey: "choice-1",
        label: "Go further",
      },
    ],
    counts,
  };
}

const initialNodes: ApiPlaySceneCoverageResponse["nodes"] = [
  {
    sceneId: "scene-a",
    label: "Opening",
    coverageState: "needs_check",
    routeKey: "scene-a",
    routeMapId: "rm-1",
  },
  {
    sceneId: "scene-b",
    label: "Continuation",
    coverageState: "flagged",
    routeKey: "scene-b",
    routeMapId: "rm-2",
  },
];

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

describe("play-mark-validated — PlayRouteMapScreen", () => {
  it("renders RouteMap nodes with coverage from the read-model", async () => {
    server.use(
      http.get(ROUTE_MAP_PATH, () => apiJson("play.routeMap", routeMapResponse(initialNodes))),
      http.get(COVERAGE_PATH, () => apiJson("play.sceneCoverage", coverageResponse(initialNodes))),
    );

    render(<PlayRouteMapScreen route={{ projectId: "project-1", localeBranchId: "locale-1" }} />);

    await waitFor(() => {
      expect(document.querySelector('[data-component="route-map"]')).not.toBeNull();
    });
    const map = document.querySelector('[data-component="route-map"]');
    expect(map?.getAttribute("data-node-count")).toBe("2");
    const nodeA = document.querySelector('[data-scene-id="scene-a"]');
    expect(nodeA?.getAttribute("data-scene-coverage")).toBe("needs_check");
    expect(nodeA?.textContent).toMatch(/Opening/);
    const nodeB = document.querySelector('[data-scene-id="scene-b"]');
    expect(nodeB?.getAttribute("data-scene-coverage")).toBe("flagged");
    expect(nodeB?.textContent).toMatch(/Continuation/);
  });

  it("Mark validated POSTs setSceneCoverage and RouteMap reflects validated", async () => {
    let store = coverageResponse(initialNodes);
    const posts: unknown[] = [];

    server.use(
      http.get(ROUTE_MAP_PATH, () => apiJson("play.routeMap", routeMapResponse(initialNodes))),
      http.get(COVERAGE_PATH, () => apiJson("play.sceneCoverage", store)),
      http.post(COVERAGE_PATH, async ({ request }) => {
        const body = (await request.json()) as {
          sceneId: string;
          coverageState: "needs_check" | "flagged" | "validated";
        };
        posts.push(body);
        store = coverageResponse(
          store.nodes.map((node) =>
            node.sceneId === body.sceneId ? { ...node, coverageState: body.coverageState } : node,
          ),
        );
        const setBody: ApiPlaySetSceneCoverageResponse = {
          schemaVersion: "itotori.play.set-scene-coverage.v0",
          projectId: "project-1",
          localeBranchId: "locale-1",
          sceneId: body.sceneId,
          coverageState: body.coverageState,
          updatedAt: "2026-07-08T12:00:00.000Z",
          updatedByUserId: "local-user",
        };
        return apiJson("play.setSceneCoverage", setBody);
      }),
    );

    render(<PlayRouteMapScreen route={{ projectId: "project-1", localeBranchId: "locale-1" }} />);

    await waitFor(() => {
      expect(document.querySelector('[data-scene-id="scene-a"]')).not.toBeNull();
    });
    // Select scene-a (already first) and mark validated.
    fireEvent.click(screen.getByRole("button", { name: /Mark validated/i }));

    await waitFor(() => {
      expect(posts).toHaveLength(1);
    });
    expect(posts[0]).toEqual({ sceneId: "scene-a", coverageState: "validated" });

    // Acceptance: coverage PERSISTS and the RouteMap reflects `validated`
    // after the write + reload (the mark strip remounts on reload, so the
    // ephemeral status line is not the durable signal).
    await waitFor(() => {
      const nodeA = document.querySelector('[data-scene-id="scene-a"]');
      expect(nodeA?.getAttribute("data-scene-coverage")).toBe("validated");
    });
    // Counts panel also reflects the validated total.
    await waitFor(() => {
      expect(document.querySelector('[data-validated-count="1"]')).not.toBeNull();
    });
  });

  it("surfaces a write error as a visible alert (never silent success)", async () => {
    server.use(
      http.get(ROUTE_MAP_PATH, () => apiJson("play.routeMap", routeMapResponse(initialNodes))),
      http.get(COVERAGE_PATH, () => apiJson("play.sceneCoverage", coverageResponse(initialNodes))),
      http.post(
        COVERAGE_PATH,
        () =>
          new Response(JSON.stringify({ code: "forbidden", error: "missing queue.manage" }), {
            status: 403,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    render(<PlayRouteMapScreen route={{ projectId: "project-1", localeBranchId: "locale-1" }} />);
    await waitFor(() => {
      expect(document.querySelector('[data-action="mark-validated"]')).not.toBeNull();
    });
    fireEvent.click(screen.getByRole("button", { name: /Mark validated/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/forbidden|queue\.manage/i);
    expect(screen.queryByText(/Scene marked validated/i)).not.toBeInTheDocument();
  });

  it("settles into empty when the coverage read-model has no nodes", async () => {
    server.use(
      http.get(ROUTE_MAP_PATH, () => apiJson("play.routeMap", routeMapResponse([]))),
      http.get(COVERAGE_PATH, () => apiJson("play.sceneCoverage", coverageResponse([]))),
    );

    render(<PlayRouteMapScreen route={{ projectId: "project-1", localeBranchId: "locale-1" }} />);

    expect(await screen.findByText(/No routes on the map/i)).toBeInTheDocument();
    expect(
      document.querySelector('[data-screen="play-routemap"]')?.getAttribute("data-state"),
    ).toBe("empty");
  });

  it("settles into error when the coverage read fails", async () => {
    server.use(
      http.get(ROUTE_MAP_PATH, () => apiJson("play.routeMap", routeMapResponse(initialNodes))),
      http.get(
        COVERAGE_PATH,
        () =>
          new Response(JSON.stringify({ code: "internal_error", error: "coverage backend down" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    render(<PlayRouteMapScreen route={{ projectId: "project-1", localeBranchId: "locale-1" }} />);

    await waitFor(() => {
      expect(
        document.querySelector('[data-screen="play-routemap"]')?.getAttribute("data-state"),
      ).toBe("error");
    });
  });
});
