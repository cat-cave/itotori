// ITOTORI-040 / fnd-spa-shell — workspace SPA route parsing tests.
//
// The HTML-string `renderWorkspaceRoute` dispatcher was deleted (the React
// `WorkspaceScreen` renders these read-models now); routing stays pure. These
// tests pin `parseWorkspaceRoute` + `workspaceRouteApiTarget` — the framework-
// agnostic mapping the shell + the JSON API layer share.

import { describe, expect, it } from "vitest";
import { parseWorkspaceRoute, workspaceRouteApiTarget } from "../src/workspace/index.js";

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
