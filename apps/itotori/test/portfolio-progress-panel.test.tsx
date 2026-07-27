// @vitest-environment jsdom
//
// Portfolio progress surface — paints mp-04 `projects.list` progress for N
// concurrent projects + a clean run-less empty card. Uses the typed fixture
// bodies (no fabricated progress). Covers aggregates, engine family, open-
// project selection, and capability-safe rendering.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { ApiProjectsResponse } from "../src/api-schema.js";
import {
  aggregatePortfolio,
  derivePortfolioRunStatus,
  isRunlessPortfolioProgress,
  PORTFOLIO_DENSE_THRESHOLD,
  PortfolioProgressPanel,
  portfolioUnitStages,
  provenUnitCount,
  sortPortfolioProjects,
  unitStageTotal,
} from "../src/ui/screens/PortfolioProgressPanel.js";
import type { ProjectPortfolioEntry } from "../src/api-schema.js";
import {
  deniedStudioCapabilityView,
  grantedStudioCapabilityView,
  CapsProvider,
} from "../src/ui/caps-context.js";
import { ShellSelectionProvider, useShellSelection } from "../src/ui/shell-selection.js";
import {
  portfolioLiveProjectsFixture,
  portfolioProjectsFixture,
  portfolioRunlessProjectsFixture,
} from "./api-fixtures.js";
import type { ReactNode } from "react";

afterEach(() => {
  cleanup();
});

function ready(data: ApiProjectsResponse) {
  return { state: "ready" as const, data };
}

function withShell(ui: ReactNode, initialProjectId?: string): ReactNode {
  return (
    <ShellSelectionProvider
      {...(initialProjectId !== undefined
        ? { initial: { projectId: initialProjectId, localeBranchId: null } }
        : {})}
    >
      {ui}
    </ShellSelectionProvider>
  );
}

function SelectedProjectProbe(): ReactNode {
  const shell = useShellSelection();
  return <div data-testid="selected-project">{shell?.override.projectId ?? ""}</div>;
}

describe("portfolio progress pure helpers", () => {
  it("sums unit stage counts and maps stages for the ds bar", () => {
    const unitCounts = portfolioLiveProjectsFixture.projects[1]!.progress.unitCounts;
    expect(unitStageTotal(unitCounts)).toBe(4);
    expect(provenUnitCount(unitCounts)).toBe(0);
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

  it("aggregates portfolio rollups from real list rows", () => {
    const rollup = aggregatePortfolio(portfolioProjectsFixture.projects);
    expect(rollup.projectCount).toBe(4);
    expect(rollup.activeRunCount).toBe(2); // queued on alpha + running on beta
    expect(rollup.totalRunCount).toBe(4);
    expect(rollup.totalCostMicrosUsd).toBe(13 + 42_000 + 17);
    expect(rollup.totalBlockers).toBe(2);
    expect(rollup.totalFindings).toBe(3 + 0 + 1 + 0); // alpha inherits fixture findings
    expect(rollup.engineCount).toBe(3); // idle is unbound
  });

  it("sorts active work and attention ahead of idle rows", () => {
    const ordered = sortPortfolioProjects(portfolioProjectsFixture.projects);
    expect(ordered.map((p) => p.projectKey)).toEqual([
      "project-beta", // running
      "project-alpha", // queued + blockers + findings
      "project-gamma", // blockers + findings, no active run
      "project-idle",
    ]);
  });
});

describe("PortfolioProgressPanel", () => {
  it("renders concurrent projects with engine, stage, cost, coverage, and blockers", () => {
    render(withShell(<PortfolioProgressPanel projects={ready(portfolioLiveProjectsFixture)} />));

    expect(screen.getByLabelText("Concurrent project progress")).toBeInTheDocument();
    expect(document.querySelector("[data-portfolio-count]")).toHaveAttribute(
      "data-portfolio-count",
      "3",
    );

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
    expect(cardAlpha).toHaveAttribute("data-engine-family", "reallive");
    expect(within(cardAlpha!).getByRole("heading", { name: "project-alpha" })).toBeInTheDocument();
    expect(within(cardAlpha!).getByText("reallive")).toBeInTheDocument();
    expect(within(cardAlpha!).getByText("review-needed")).toBeInTheDocument();
    expect(within(cardAlpha!).getByText("75% avg coverage")).toBeInTheDocument();
    expect(within(cardAlpha!).getByText("$0.000013")).toBeInTheDocument();
    expect(within(cardAlpha!).getByTitle("drafted: 1")).toBeInTheDocument();
    // Proven bar is separate from stage mix; alpha is 0% proven with drafted units.
    expect(within(cardAlpha!).getByText("Stage mix")).toBeInTheDocument();
    expect(cardAlpha!.querySelector("[data-portfolio-proven]")).toHaveAttribute(
      "data-portfolio-proven",
      "0",
    );
    // Coverage stated once (progress head); metrics block no longer repeats it.
    expect(cardAlpha!.querySelectorAll("[data-portfolio-coverage]")).toHaveLength(1);
    // Identity: name once; engine + locale on the meta line (no duplicate key).
    expect(within(cardAlpha!).getByText("reallive")).toBeInTheDocument();
    expect(within(cardAlpha!).queryAllByText("project-alpha")).toHaveLength(1);

    expect(within(cardBeta!).getByRole("heading", { name: "project-beta" })).toBeInTheDocument();
    expect(cardBeta).toHaveAttribute("data-engine-family", "siglus");
    expect(within(cardBeta!).getByText("running")).toBeInTheDocument();
    expect(within(cardBeta!).getByText("55% avg coverage")).toBeInTheDocument();
    expect(cardBeta).toHaveAttribute("data-blocker-count", "0");
    expect(cardBeta!.querySelector("[data-portfolio-proven]")).toHaveAttribute(
      "data-portfolio-proven",
      "0",
    );

    expect(within(cardGamma!).getByRole("heading", { name: "project-gamma" })).toBeInTheDocument();
    expect(cardGamma).toHaveAttribute("data-engine-family", "kiri_kiri_xp3");
    expect(within(cardGamma!).getByText("awaiting-check")).toBeInTheDocument();
    expect(within(cardGamma!).getByText("100% avg coverage")).toBeInTheDocument();
    expect(within(cardGamma!).getByTitle("patched: 3")).toBeInTheDocument();
    expect(cardGamma!.querySelector("[data-portfolio-proven]")).toHaveAttribute(
      "data-portfolio-proven",
      "100",
    );

    // Aggregate strip from the same real payload.
    const rollup = document.querySelector("[data-portfolio-rollup]");
    expect(rollup).toHaveAttribute("data-portfolio-project-count", "3");
    expect(rollup).toHaveAttribute("data-portfolio-active-runs", "2");
    expect(rollup).toHaveAttribute("data-portfolio-engines", "3");
  });

  it("renders a clean empty state for a run-less project", () => {
    render(withShell(<PortfolioProgressPanel projects={ready(portfolioRunlessProjectsFixture)} />));

    const card = document.querySelector('[data-portfolio-project="project-4"]');
    expect(card).not.toBeNull();
    expect(card).toHaveAttribute("data-runless", "true");
    expect(card).toHaveAttribute("data-run-count", "0");
    expect(card).toHaveAttribute("data-engine-family", "");
    expect(within(card as HTMLElement).getByText(/No runs recorded yet/i)).toBeInTheDocument();
    expect(within(card as HTMLElement).getByText(/engine unbound/i)).toBeInTheDocument();
    expect(within(card as HTMLElement).queryByRole("img")).not.toBeInTheDocument();
  });

  it("renders the full portfolio fixture (3 live + 1 run-less) side by side", () => {
    render(withShell(<PortfolioProgressPanel projects={ready(portfolioProjectsFixture)} />));

    expect(document.querySelector("[data-portfolio-count]")).toHaveAttribute(
      "data-portfolio-count",
      "4",
    );
    expect(document.querySelectorAll("[data-portfolio-project]")).toHaveLength(4);
    expect(document.querySelectorAll('[data-runless="true"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-runless="false"]')).toHaveLength(3);
  });

  it("opens a project into the shell selection (way into the project)", () => {
    render(
      withShell(
        <>
          <PortfolioProgressPanel projects={ready(portfolioLiveProjectsFixture)} />
          <SelectedProjectProbe />
        </>,
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Open project project-beta" }));
    expect(screen.getByTestId("selected-project")).toHaveTextContent("project-2");
    expect(document.querySelector('[data-portfolio-project="project-2"]')).toHaveAttribute(
      "data-portfolio-selected",
      "true",
    );
  });

  it("settles loading / error / empty independently", () => {
    const { rerender } = render(
      withShell(<PortfolioProgressPanel projects={{ state: "loading" }} />),
    );
    expect(screen.getByText(/Loading portfolio progress/i)).toBeInTheDocument();

    rerender(
      withShell(
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
      ),
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();

    rerender(withShell(<PortfolioProgressPanel projects={{ state: "empty" }} />));
    expect(screen.getByText(/No projects were returned/i)).toBeInTheDocument();
  });

  it("still paints the full portfolio under denied studio capabilities (read surface)", () => {
    // Portfolio is a catalog.read surface; studio caps (flag/steer/reveal) must
    // not blank the board. Denied caps keep the same real list visible.
    render(
      withShell(
        <CapsProvider value={deniedStudioCapabilityView("local-user", "denied for test")}>
          <PortfolioProgressPanel projects={ready(portfolioProjectsFixture)} />
        </CapsProvider>,
      ),
    );

    expect(document.querySelectorAll("[data-portfolio-project]")).toHaveLength(4);
    expect(screen.getByRole("heading", { name: "project-alpha" })).toBeInTheDocument();
    expect(document.querySelector("[data-portfolio-rollup]")).toHaveAttribute(
      "data-portfolio-project-count",
      "4",
    );
  });

  it("renders redacted portfolio rows without inventing blockers", () => {
    const redacted: ApiProjectsResponse = {
      projects: portfolioLiveProjectsFixture.projects.map((project) => ({
        ...project,
        progress: { ...project.progress, blockers: [] },
      })),
    };
    render(
      withShell(
        <CapsProvider value={grantedStudioCapabilityView()}>
          <PortfolioProgressPanel projects={ready(redacted)} />
        </CapsProvider>,
      ),
    );

    expect(document.querySelectorAll('[data-blocker-count="0"]')).toHaveLength(3);
    expect(screen.queryByText("review-needed")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "project-alpha" })).toBeInTheDocument();
  });

  it("switches to compact dense table above the density threshold", () => {
    const templates = portfolioProjectsFixture.projects;
    const projects: ProjectPortfolioEntry[] = [];
    for (let i = 0; i < PORTFOLIO_DENSE_THRESHOLD + 1; i += 1) {
      const base = templates[i % templates.length]!;
      projects.push({
        ...base,
        projectId: `dense-test-${i + 1}`,
        projectKey: `project-dense-test-${String(i + 1).padStart(2, "0")}`,
        name: `project-dense-test-${String(i + 1).padStart(2, "0")}`,
        progress: {
          ...base.progress,
          projectId: `dense-test-${i + 1}`,
        },
      });
    }
    render(
      withShell(
        <>
          <PortfolioProgressPanel projects={ready({ projects })} />
          <SelectedProjectProbe />
        </>,
      ),
    );

    expect(document.querySelector("[data-portfolio-density]")).toHaveAttribute(
      "data-portfolio-density",
      "dense",
    );
    expect(document.querySelector('[data-portfolio-layout="dense"]')).not.toBeNull();
    expect(document.querySelector('[data-portfolio-layout="grid"]')).toBeNull();
    // Dense rows drop the per-card stage-mix legend; proven signal remains.
    expect(document.querySelectorAll("[data-portfolio-stage-mix]")).toHaveLength(0);
    const denseRows = document.querySelectorAll("[data-portfolio-project]");
    expect(denseRows.length).toBeGreaterThan(0);
    // Compact open control still selects into the shell.
    const firstOpen = document.querySelector("[data-portfolio-open]") as HTMLButtonElement | null;
    expect(firstOpen).not.toBeNull();
    const openedId = firstOpen!.getAttribute("data-portfolio-open");
    fireEvent.click(firstOpen!);
    expect(screen.getByTestId("selected-project")).toHaveTextContent(openedId ?? "");
    expect(document.querySelector(`[data-portfolio-project="${openedId}"]`)).toHaveAttribute(
      "data-portfolio-selected",
      "true",
    );
  });

  it("keeps the card grid at or below the density threshold", () => {
    render(withShell(<PortfolioProgressPanel projects={ready(portfolioProjectsFixture)} />));
    expect(document.querySelector("[data-portfolio-density]")).toHaveAttribute(
      "data-portfolio-density",
      "standard",
    );
    expect(document.querySelector('[data-portfolio-layout="grid"]')).not.toBeNull();
    expect(document.querySelectorAll("[data-portfolio-stage-mix]").length).toBeGreaterThan(0);
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
    render(withShell(<DashboardScreen />));

    await waitFor(() => {
      expect(document.querySelector('[data-panel="portfolio-progress"]')).toHaveAttribute(
        "data-panel-state",
        "ready",
      );
    });

    expect(document.querySelector("[data-portfolio-count]")).toHaveAttribute(
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
    expect(document.querySelector("[data-portfolio-rollup]")).toHaveAttribute(
      "data-portfolio-engines",
      "3",
    );

    vi.unstubAllGlobals();
  });
});
