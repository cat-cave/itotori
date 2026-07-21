// @vitest-environment jsdom
//
// Portfolio progress surface — paints mp-04 `projects.list` progress for N
// concurrent projects + a clean run-less empty card. Uses the typed fixture
// bodies (no fabricated progress).

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { ApiProjectsResponse } from "../src/api-schema.js";
import {
  derivePortfolioRunStatus,
  isRunlessPortfolioProgress,
  PortfolioProgressPanel,
  portfolioUnitStages,
  unitStageTotal,
} from "../src/ui/screens/PortfolioProgressPanel.js";
import {
  portfolioLiveProjectsFixture,
  portfolioProjectsFixture,
  portfolioRunlessProjectsFixture,
} from "./api-fixtures.js";

afterEach(() => {
  cleanup();
});

function ready(data: ApiProjectsResponse) {
  return { state: "ready" as const, data };
}

describe("portfolio progress pure helpers", () => {
  it("sums unit stage counts and maps stages for the ds bar", () => {
    const unitCounts = portfolioLiveProjectsFixture.projects[1]!.progress.unitCounts;
    expect(unitStageTotal(unitCounts)).toBe(4);
    const stages = portfolioUnitStages(unitCounts);
    expect(stages.map((s) => s.key)).toEqual(["decoded", "drafted", "qa", "accepted", "proven"]);
    expect(stages.find((s) => s.key === "proven")?.count).toBe(0);
    expect(stages.find((s) => s.key === "accepted")?.count).toBe(2);
  });

  it("derives run status with active-work priority", () => {
    expect(
      derivePortfolioRunStatus(
        {
          queued: 0,
          running: 1,
          paused: 0,
          completed: 1,
          failed: 0,
          cancelled: 0,
        },
        2,
      ),
    ).toBe("running");
    expect(
      derivePortfolioRunStatus(
        {
          queued: 0,
          running: 0,
          paused: 0,
          completed: 0,
          failed: 0,
          cancelled: 0,
        },
        0,
      ),
    ).toBe("pending");
  });

  it("detects run-less progress for the empty card", () => {
    expect(isRunlessPortfolioProgress(portfolioRunlessProjectsFixture.projects[0]!.progress)).toBe(
      true,
    );
    expect(isRunlessPortfolioProgress(portfolioLiveProjectsFixture.projects[0]!.progress)).toBe(
      false,
    );
  });
});

describe("PortfolioProgressPanel", () => {
  it("renders three concurrent projects with independent stage, cost, coverage, and blockers", () => {
    render(<PortfolioProgressPanel projects={ready(portfolioLiveProjectsFixture)} />);

    const grid = screen.getByLabelText("Concurrent project progress");
    expect(grid).toHaveAttribute("data-portfolio-count", "3");

    const cardAlpha = document.querySelector(
      '[data-portfolio-project="project-1"]',
    ) as HTMLElement | null;
    const cardBeta = document.querySelector(
      '[data-portfolio-project="project-2"]',
    ) as HTMLElement | null;
    const cardGamma = document.querySelector(
      '[data-portfolio-project="project-3"]',
    ) as HTMLElement | null;
    expect(cardAlpha).not.toBeNull();
    expect(cardBeta).not.toBeNull();
    expect(cardGamma).not.toBeNull();

    expect(cardAlpha).toHaveAttribute("data-runless", "false");
    expect(within(cardAlpha!).getByRole("heading", { name: "project-alpha" })).toBeInTheDocument();
    expect(within(cardAlpha!).getByText("review-needed")).toBeInTheDocument();
    expect(within(cardAlpha!).getByText("75% avg coverage")).toBeInTheDocument();
    expect(within(cardAlpha!).getByText("$0.000013")).toBeInTheDocument();
    expect(within(cardAlpha!).getByTitle("drafted: 1")).toBeInTheDocument();

    expect(within(cardBeta!).getByRole("heading", { name: "project-beta" })).toBeInTheDocument();
    expect(within(cardBeta!).getByText("running")).toBeInTheDocument();
    expect(within(cardBeta!).getByText("55% avg coverage")).toBeInTheDocument();
    expect(cardBeta).toHaveAttribute("data-blocker-count", "0");

    expect(within(cardGamma!).getByRole("heading", { name: "project-gamma" })).toBeInTheDocument();
    expect(within(cardGamma!).getByText("awaiting-check")).toBeInTheDocument();
    expect(within(cardGamma!).getByText("100% avg coverage")).toBeInTheDocument();
    expect(within(cardGamma!).getByTitle("patched: 3")).toBeInTheDocument();
  });

  it("renders a clean empty state for a run-less project", () => {
    render(<PortfolioProgressPanel projects={ready(portfolioRunlessProjectsFixture)} />);

    const card = document.querySelector('[data-portfolio-project="project-4"]');
    expect(card).not.toBeNull();
    expect(card).toHaveAttribute("data-runless", "true");
    expect(card).toHaveAttribute("data-run-count", "0");
    expect(within(card as HTMLElement).getByText(/No runs recorded yet/i)).toBeInTheDocument();
    expect(within(card as HTMLElement).queryByRole("img")).not.toBeInTheDocument();
  });

  it("renders the full portfolio fixture (3 live + 1 run-less) side by side", () => {
    render(<PortfolioProgressPanel projects={ready(portfolioProjectsFixture)} />);

    const grid = screen.getByLabelText("Concurrent project progress");
    expect(grid).toHaveAttribute("data-portfolio-count", "4");
    expect(document.querySelectorAll("[data-portfolio-project]")).toHaveLength(4);
    expect(document.querySelectorAll('[data-runless="true"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-runless="false"]')).toHaveLength(3);
  });

  it("settles loading / error / empty independently", () => {
    const { rerender } = render(<PortfolioProgressPanel projects={{ state: "loading" }} />);
    expect(screen.getByText(/Loading portfolio progress/i)).toBeInTheDocument();

    rerender(
      <PortfolioProgressPanel
        projects={{
          state: "error",
          error: {
            routeId: "projects.list",
            status: 500,
            code: null,
            message: null,
          },
        }}
      />,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();

    rerender(<PortfolioProgressPanel projects={{ state: "empty" }} />);
    expect(screen.getByText(/No projects were returned/i)).toBeInTheDocument();
  });
});

describe("Dashboard portfolio integration (polled projects.list)", () => {
  it("surfaces the portfolio panel from the dashboard with the multi-project fixture", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL): Promise<Response> => {
      const rawUrl = input instanceof Request ? input.url : input.toString();
      const url = new URL(rawUrl, "http://itotori.test");
      if (url.pathname === "/api/projects") {
        return new Response(JSON.stringify(portfolioProjectsFixture), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // Minimal stubs so unrelated dashboard panels settle without crashing.
      return new Response(JSON.stringify({ error: "not fixtureed", code: "not_found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    });

    const { DashboardScreen } = await import("../src/ui/screens/DashboardScreen.js");
    render(<DashboardScreen />);

    await waitFor(() => {
      expect(document.querySelector('[data-panel="portfolio-progress"]')).toHaveAttribute(
        "data-panel-state",
        "ready",
      );
    });

    expect(screen.getByLabelText("Concurrent project progress")).toHaveAttribute(
      "data-portfolio-count",
      "4",
    );
    expect(screen.getByRole("heading", { name: "project-alpha" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "project-beta" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "project-gamma" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "project-idle" })).toBeInTheDocument();
    expect(screen.getByText(/No runs recorded yet/i)).toBeInTheDocument();
    expect(document.querySelectorAll("[data-portfolio-project]")).toHaveLength(4);
    expect(document.querySelectorAll('[data-runless="true"]')).toHaveLength(1);

    vi.unstubAllGlobals();
  });
});
