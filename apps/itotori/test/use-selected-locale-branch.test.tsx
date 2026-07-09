// @vitest-environment jsdom
// use-selected-locale-branch-helper — behavior-first coverage for the shared
// branch-scope hook used by branch-scoped SPA surfaces.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http } from "msw";
import { setupServer } from "msw/node";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { useSelectedLocaleBranch } from "../src/ui/use-selected-locale-branch.js";
import { apiJson } from "./msw-handlers.js";
import { dashboardStatusFixture } from "./api-fixtures.js";

const server = setupServer(
  http.get("*/api/projects/status", () => apiJson("projects.status", dashboardStatusFixture)),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

describe("useSelectedLocaleBranch", () => {
  it("uses an explicit route locale branch without waiting on project status", () => {
    const { result } = renderHook(() =>
      useSelectedLocaleBranch({
        explicitProjectId: "project-from-route",
        explicitLocaleBranchId: "branch-from-route",
      }),
    );

    expect(result.current).toEqual({
      state: "ready",
      data: {
        projectId: "project-from-route",
        localeBranchId: "branch-from-route",
      },
    });
  });

  it("falls back to projects.status.selectedLocaleBranchId when no explicit branch is supplied", async () => {
    const { result } = renderHook(() => useSelectedLocaleBranch());

    await waitFor(() => expect(result.current.state).toBe("ready"));
    expect(result.current).toEqual({
      state: "ready",
      data: {
        projectId: dashboardStatusFixture.projectId,
        localeBranchId: dashboardStatusFixture.selectedLocaleBranchId,
      },
    });
  });

  it("returns empty when the selected project status has no selected locale branch", () => {
    const { result } = renderHook(() =>
      useSelectedLocaleBranch({
        status: {
          state: "ready",
          data: { ...dashboardStatusFixture, selectedLocaleBranchId: null },
        },
      }),
    );

    expect(result.current).toEqual({ state: "empty" });
  });
});
