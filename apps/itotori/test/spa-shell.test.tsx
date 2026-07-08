// @vitest-environment jsdom
// fnd-spa-shell — behavior-first test for the served React SPA.
//
// Mounts the real `App` shell (the one `src/main.tsx` mounts + `server.ts`
// serves) against msw-intercepted `/api/*` responses and asserts the
// OBSERVABLE rendered behavior — that the shell CONSUMES the typed API and
// renders the ported parity views:
//   - the Workbench dashboard's Projects / Status / Model-cost /
//     Reviewer-queue / Pending-decisions panels,
//   - the reviewer-detail screen,
//   - the localization workspace project-browse screen.
//
// Playwright-against-a-live-server would prove the same served behavior, but
// the repo's browser-driven e2e harness (runtime-web-review) is a separate
// track; this jsdom + msw mount is the established app-test seam (the api-
// client + ds tests use it) and asserts the same real behavior: a route ->
// a screen that reads `/api/*` through the typed client and paints the DOM.
// [[feedback_behavior_first_code_agnostic_testing]] — no game is named; only
// the states + panels the shell consumers see are asserted.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { cleanup, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { App } from "../src/ui/App.js";
import { readyContextFixture } from "../src/reviewer/index.js";
import { workspaceProjectBrowseFixture } from "../src/workspace/index.js";
import {
  costDrilldownFixture,
  costReportFixture,
  dashboardDecisionsFixture,
  dashboardStatusFixture,
  projectOverviewFixture,
} from "./api-fixtures.js";
import { apiJson, reviewerQueueDashboardApiFixture } from "./msw-handlers.js";

const reviewerDetailContext = readyContextFixture();

// Host-agnostic handlers: the shell's client issues RELATIVE `/api/*` calls,
// which jsdom resolves against the test origin; `*/…` matches that origin.
const server = setupServer(
  http.get("*/api/projects", () =>
    apiJson("projects.list", { projects: [dashboardStatusFixture] }),
  ),
  http.get("*/api/projects/status", () => apiJson("projects.status", dashboardStatusFixture)),
  http.get("*/api/projects/decisions", () =>
    apiJson("projects.decisions", dashboardDecisionsFixture),
  ),
  http.get("*/api/projects/cost", () => apiJson("projects.cost", costReportFixture)),
  http.get("*/api/projects/cost/drilldown", () =>
    apiJson("projects.costDrilldown", costDrilldownFixture),
  ),
  http.get("*/api/projects/overview", () => apiJson("projects.overview", projectOverviewFixture)),
  http.get("*/api/reviewer/queue", () =>
    apiJson("reviewer.queue", reviewerQueueDashboardApiFixture()),
  ),
  http.get("*/api/reviewer/queue/:reviewItemId/detail", () =>
    apiJson("reviewer.detail", reviewerDetailContext),
  ),
  http.get("*/api/workspace/projects", () =>
    apiJson("workspace.projects", workspaceProjectBrowseFixture()),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

describe("SPA shell — Workbench dashboard", () => {
  it("consumes /api/* and renders the projects / status / cost / reviewer-queue / decisions panels", async () => {
    render(<App location={{ pathname: "/", search: "" }} />);

    // Status strip (projects.status) — the project shell context.
    const strip = await screen.findByLabelText("Project summary");
    expect(within(strip).getByText("project-1")).toBeInTheDocument();

    // Projects panel (projects.list) rendered as a ds DataTable.
    expect(await screen.findByRole("heading", { name: "Projects" })).toBeInTheDocument();
    expect(await screen.findByRole("columnheader", { name: "Findings" })).toBeInTheDocument();

    // Reviewer queue panel (reviewer.queue) — aggregate + a detail link.
    expect(await screen.findByRole("heading", { name: "Reviewer queue" })).toBeInTheDocument();
    expect(await screen.findByText("Preview batch actions")).toBeInTheDocument();

    // Model cost panel (projects.cost) — the empirical $25 target.
    expect(await screen.findByRole("heading", { name: "Model cost" })).toBeInTheDocument();
    const billed = costReportFixture.billedMicrosUsd / 1_000_000;
    expect((await screen.findAllByText(`$${billed.toFixed(6)}`)).length).toBeGreaterThan(0);

    // Pending decisions band (projects.decisions).
    expect(await screen.findByRole("heading", { name: /pending decision/i })).toBeInTheDocument();
  });

  it("surfaces a typed API error state instead of a blank panel", async () => {
    server.use(
      http.get("*/api/projects/cost", () =>
        HttpResponse.json(
          { code: "forbidden", error: "not permitted to read cost" },
          { status: 403 },
        ),
      ),
    );
    render(<App location={{ pathname: "/", search: "" }} />);
    // The cost panel error surfaces the typed code (not a fabricated empty).
    expect(await screen.findByText("not permitted to read cost")).toBeInTheDocument();
  });
});

describe("SPA shell — reviewer detail", () => {
  it("renders the reviewer-detail screen from /api/reviewer/queue/:id/detail", async () => {
    render(
      <App
        location={{ pathname: `/reviewer-queue/${reviewerDetailContext.reviewItemId}`, search: "" }}
      />,
    );
    // Wait for a ready-only panel first (the <main> also exists while loading).
    expect(await screen.findByRole("heading", { name: "Source unit" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Comparison" })).toBeInTheDocument();
    const main = screen.getByRole("main");
    expect(main).toHaveAttribute("data-screen", "reviewer-detail");
    expect(main).toHaveAttribute("data-state", "ready");
  });
});

describe("SPA shell — localization workspace", () => {
  it("renders the workspace project-browse screen from /api/workspace/projects", async () => {
    render(<App location={{ pathname: "/workspace", search: "" }} />);
    // A project name + branch link only render after workspace.projects loads.
    expect(await screen.findByRole("heading", { name: "Oshioki Sweetie HD" })).toBeInTheDocument();
    expect(await screen.findByText("English (informal)")).toBeInTheDocument();
    const main = screen.getByRole("main");
    expect(main).toHaveAttribute("data-screen", "workspace");
    expect(main).toHaveAttribute("data-view", "projects");
  });
});
