// @vitest-environment jsdom
// ITOTORI-040 — workspace SPA route loader tests.
//
// Proves the route loader reads THROUGH the JSON API: it issues a GET to
// `/api/workspace/...`, validates the body with the shared
// `assertItotoriApiResponse` contract, and renders the typed read-model.
// `fetchJson` is injected so the test drives it deterministically without
// a live server, and asserts the exact API path that was requested.

import { describe, expect, it, vi } from "vitest";
import {
  parseWorkspaceRoute,
  renderWorkspaceRoute,
  workspaceComparisonFixture,
  workspaceProjectBrowseFixture,
  workspaceRouteApiTarget,
  workspaceSearchFixture,
} from "../src/workspace/index.js";

describe("parseWorkspaceRoute", () => {
  it("parses the bare workspace route as the project browse", () => {
    expect(parseWorkspaceRoute("/workspace")).toEqual({ kind: "projects" });
    expect(parseWorkspaceRoute("/workspace/projects")).toEqual({ kind: "projects" });
  });

  it("requires project + locale branch scope for scene and asset routes", () => {
    expect(parseWorkspaceRoute("/workspace/scenes")).toBeNull();
    expect(parseWorkspaceRoute("/workspace/scenes", "?projectId=p1&localeBranchId=b1")).toEqual({
      kind: "scenes",
      projectId: "p1",
      localeBranchId: "b1",
    });
  });

  it("parses comparison + search routes", () => {
    expect(parseWorkspaceRoute("/workspace/comparison", "?reviewItemId=r1")).toEqual({
      kind: "comparison",
      reviewItemId: "r1",
    });
    expect(
      parseWorkspaceRoute(
        "/workspace/search",
        "?projectId=p1&localeBranchId=b1&query=x&mode=exact",
      ),
    ).toEqual({ kind: "search", projectId: "p1", localeBranchId: "b1", query: "x", mode: "exact" });
  });

  it("returns null for non-workspace paths", () => {
    expect(parseWorkspaceRoute("/reviewer-queue/abc")).toBeNull();
  });
});

describe("workspaceRouteApiTarget", () => {
  it("maps each route to its API path + typed route id", () => {
    expect(workspaceRouteApiTarget({ kind: "projects" })).toEqual({
      apiPath: "/api/workspace/projects",
      routeId: "workspace.projects",
    });
    expect(workspaceRouteApiTarget({ kind: "comparison", reviewItemId: "r 1" }).apiPath).toBe(
      "/api/workspace/comparison?reviewItemId=r%201",
    );
  });
});

describe("renderWorkspaceRoute", () => {
  it("fetches the project browse API path and renders the read-model", async () => {
    const root = document.createElement("div");
    const fetchJson = vi.fn(async (_apiPath: string) =>
      JSON.parse(JSON.stringify(workspaceProjectBrowseFixture())),
    );
    await renderWorkspaceRoute(root, { kind: "projects" }, { fetchJson });
    expect(fetchJson).toHaveBeenCalledWith("/api/workspace/projects");
    expect(root.innerHTML).toContain('data-view="project-browse"');
    expect(root.innerHTML).toContain("English (informal)");
  });

  it("fetches the comparison API path with the review item id", async () => {
    const root = document.createElement("div");
    const fetchJson = vi.fn(async (_apiPath: string) =>
      JSON.parse(JSON.stringify(workspaceComparisonFixture())),
    );
    await renderWorkspaceRoute(
      root,
      { kind: "comparison", reviewItemId: "reviewer-queue-itotori-040" },
      { fetchJson },
    );
    expect(fetchJson).toHaveBeenCalledWith(
      "/api/workspace/comparison?reviewItemId=reviewer-queue-itotori-040",
    );
    expect(root.innerHTML).toContain('data-side="final"');
  });

  it("rejects a malformed API body via assertItotoriApiResponse and renders the error pane", async () => {
    const root = document.createElement("div");
    const fetchJson = vi.fn(async () => ({ schemaVersion: "wrong" }));
    await renderWorkspaceRoute(
      root,
      { kind: "search", projectId: "p1", localeBranchId: "b1", query: "x", mode: null },
      { fetchJson },
    );
    expect(root.innerHTML).toContain('data-state="error"');
  });

  it("renders a search read-model fetched through the API", async () => {
    const root = document.createElement("div");
    const fetchJson = vi.fn(async () => JSON.parse(JSON.stringify(workspaceSearchFixture())));
    await renderWorkspaceRoute(
      root,
      {
        kind: "search",
        projectId: "project-itotori-040",
        localeBranchId: "locale-branch-itotori-040",
        query: "世界",
        mode: null,
      },
      { fetchJson },
    );
    expect(fetchJson.mock.calls[0]![0]).toContain("/api/workspace/search?");
    expect(root.innerHTML).toContain('data-source-artifact-id="bridge-unit-itotori-040-1"');
  });
});
