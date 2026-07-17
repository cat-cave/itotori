// @vitest-environment jsdom
//
// The shell nav and onboarding both land on bare `/play`. This pins that
// route to the hub (not the dashboard) while the hub reads only the existing
// typed patch-version and route-map surfaces.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type {
  ApiPatchIterationVersionsResponse,
  ApiPlayRouteMapResponse,
} from "../src/api-schema.js";
import { App } from "../src/ui/App.js";
import { grantedStudioCapabilityView } from "../src/ui/caps-context.js";
import { parsePlayHubRoute } from "../src/ui/screens/PlayHubScreen.js";
import { authIdentityFixture, costReportFixture, dashboardStatusFixture } from "./api-fixtures.js";

const PROJECT_ID = dashboardStatusFixture.projectId;
const LOCALE_BRANCH_ID = dashboardStatusFixture.selectedLocaleBranchId;

if (LOCALE_BRANCH_ID === null) {
  throw new Error("The dashboard status fixture requires a selected locale branch.");
}

const versionsFixture: ApiPatchIterationVersionsResponse = {
  schemaVersion: "itotori.patch-iteration.versions.v0",
  versions: [
    {
      patchVersionId: "patch-version-2",
      runId: "run-2",
      parentPatchVersionId: "patch-version-1",
      origin: "refinement_run",
      status: "ready",
      playableAt: "2026-07-17T00:00:00.000Z",
      selectedAt: "2026-07-17T00:01:00.000Z",
      artifactHashes: { patch: "sha256:patch-2" },
      basePatchVersionId: "patch-version-1",
    },
  ],
};

const routeMapFixture: ApiPlayRouteMapResponse = {
  schemaVersion: "itotori.play.route-map.v0",
  generatedAt: "2026-07-17T00:00:00.000Z",
  projectId: PROJECT_ID,
  localeBranchId: LOCALE_BRANCH_ID,
  nodes: [
    {
      routeKey: "route-1",
      routeMapId: "route-map-1",
      label: "Opening route",
      summary: "The opening route has current context.",
      col: 0,
      row: 0,
      state: "fresh",
      coverage: "fresh",
      issues: 0,
    },
  ],
  edges: [],
  counts: { fresh: 1, stale: 0, total: 1, choiceCount: 0 },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function installApiFixtureFetch(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL): Promise<Response> => {
    const rawUrl = input instanceof Request ? input.url : input.toString();
    const url = new URL(rawUrl, "http://itotori.test");
    const body = responseForPath(url.pathname);
    return new Response(JSON.stringify(body), {
      status: body === null ? 404 : 200,
      headers: { "content-type": "application/json" },
    });
  });
}

function responseForPath(pathname: string): unknown {
  if (pathname === "/api/auth/identity") {
    return authIdentityFixture;
  }
  if (pathname === "/api/projects/status") {
    return dashboardStatusFixture;
  }
  if (pathname === "/api/projects/cost") {
    return costReportFixture;
  }
  if (pathname === "/api/projects") {
    return { projects: [dashboardStatusFixture] };
  }
  if (pathname === `/api/play/locale-branches/${LOCALE_BRANCH_ID}/patch-versions`) {
    return versionsFixture;
  }
  if (pathname === `/api/projects/${PROJECT_ID}/locale-branches/${LOCALE_BRANCH_ID}/route-map`) {
    return routeMapFixture;
  }
  return null;
}

describe("Play hub routing", () => {
  it("routes bare /play to the Play hub instead of the dashboard", async () => {
    installApiFixtureFetch();
    render(
      <App
        location={{
          pathname: "/play",
          search: `?projectId=${PROJECT_ID}&localeBranchId=${LOCALE_BRANCH_ID}`,
        }}
        caps={grantedStudioCapabilityView()}
        navigate={() => {}}
      />,
    );

    expect(screen.getByRole("main")).toHaveAttribute("data-screen", "play-hub");
    expect(screen.queryByText("Itotori dashboard")).not.toBeInTheDocument();
    expect(await screen.findByText("patch-version-2")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open route map" })).toHaveAttribute(
      "href",
      `/play/routemap?projectId=${PROJECT_ID}&localeBranchId=${LOCALE_BRANCH_ID}`,
    );
    expect(screen.getByRole("link", { name: "Flag a correction" })).toHaveAttribute(
      "href",
      `/play/flag?projectId=${PROJECT_ID}&localeBranchId=${LOCALE_BRANCH_ID}`,
    );
  });

  it("accepts the onboarding locale-branch query on the bare Play route", () => {
    expect(parsePlayHubRoute("/play", `?localeBranchId=${LOCALE_BRANCH_ID}`)).toEqual({
      projectId: null,
      localeBranchId: LOCALE_BRANCH_ID,
    });
    expect(parsePlayHubRoute("/play/routemap", "")).toBeNull();
  });
});
