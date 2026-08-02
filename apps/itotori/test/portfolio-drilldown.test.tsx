// @vitest-environment jsdom
//
// Per-role bars + the project drill-down (units / review / patch / validate),
// and the engine-genericity property: three projects that differ ONLY by engine
// family must render byte-identical markup apart from the engine label itself.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { ApiProjectsResponse, ProjectPortfolioEntry } from "../src/api-schema.js";
import { PortfolioProgressPanel } from "../src/ui/screens/PortfolioProgressPanel.js";
import {
  portfolioRoleCount,
  portfolioRoleRows,
} from "../src/ui/screens/portfolio/portfolio-role-model.js";
import { derivePortfolioDrilldown } from "../src/ui/screens/portfolio/portfolio-drilldown-model.js";
import { ShellSelectionProvider } from "../src/ui/shell-selection.js";
import { portfolioLiveProjectsFixture, portfolioProjectsFixture } from "./api-fixtures.js";
import type { ReactNode } from "react";

afterEach(() => {
  cleanup();
});

function ready(data: ApiProjectsResponse) {
  return { state: "ready" as const, data };
}

function withShell(ui: ReactNode): ReactNode {
  return <ShellSelectionProvider>{ui}</ShellSelectionProvider>;
}

const alpha = portfolioLiveProjectsFixture.projects[0]!;
const beta = portfolioLiveProjectsFixture.projects[1]!;
const gamma = portfolioLiveProjectsFixture.projects[2]!;

describe("per-role portfolio model", () => {
  it("builds one row per role in volume order with real counts", () => {
    const rows = portfolioRoleRows(beta.progress.roleCounts);
    expect(rows.map((row) => row.role)).toEqual(["reviewer", "writer"]);
    const reviewer = rows[0]!;
    expect(reviewer.total).toBe(2);
    expect(reviewer.proven).toBe(0);
    expect(reviewer.counts.QA).toBe(1);
    expect(reviewer.counts.accepted).toBe(1);
    const writer = rows[1]!;
    expect(writer.total).toBe(2);
    expect(writer.counts.decoded).toBe(1);
  });

  it("reports proven percent from the terminal patched stage", () => {
    const rows = portfolioRoleRows(gamma.progress.roleCounts);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe("patcher");
    expect(rows[0]!.provenPercent).toBe(100);
    expect(portfolioRoleCount(gamma.progress.roleCounts)).toBe(1);
  });

  it("drops empty roles instead of drawing a zero bar", () => {
    expect(
      portfolioRoleRows({ ghost: { decoded: 0, drafted: 0, QA: 0, accepted: 0, patched: 0 } }),
    ).toHaveLength(0);
    expect(portfolioRoleCount({})).toBe(0);
  });
});

describe("per-role bars in the portfolio card", () => {
  it("renders a labelled bar per role carrying that role's real counts", () => {
    render(withShell(<PortfolioProgressPanel projects={ready(portfolioLiveProjectsFixture)} />));

    const cardBeta = document.querySelector(
      '[data-portfolio-project="project-2"]',
    ) as HTMLElement | null;
    expect(cardBeta).not.toBeNull();

    const roles = cardBeta!.querySelector("[data-portfolio-roles]");
    expect(roles).toHaveAttribute("data-portfolio-roles", "2");

    const reviewer = cardBeta!.querySelector('[data-portfolio-role="reviewer"]');
    const writer = cardBeta!.querySelector('[data-portfolio-role="writer"]');
    expect(reviewer).toHaveAttribute("data-portfolio-role-total", "2");
    expect(writer).toHaveAttribute("data-portfolio-role-total", "2");
    expect(within(reviewer as HTMLElement).getByText("0/2")).toBeInTheDocument();
    expect(
      within(reviewer as HTMLElement).getByLabelText("reviewer: 0 of 2 unit-roles proven"),
    ).toBeInTheDocument();
    expect(reviewer!.querySelector('[title="reviewer qa: 1"]')).not.toBeNull();
    expect(reviewer!.querySelector('[title="reviewer accepted: 1"]')).not.toBeNull();

    // Gamma is fully patched by a single role.
    const cardGamma = document.querySelector(
      '[data-portfolio-project="project-3"]',
    ) as HTMLElement | null;
    const patcher = cardGamma!.querySelector('[data-portfolio-role="patcher"]');
    expect(patcher).toHaveAttribute("data-portfolio-role-proven", "100");
    expect(within(patcher as HTMLElement).getByText("3/3")).toBeInTheDocument();
  });

  it("omits the role block entirely when the payload carries no role records", () => {
    render(withShell(<PortfolioProgressPanel projects={ready(portfolioProjectsFixture)} />));
    const idle = document.querySelector(
      '[data-portfolio-project="project-4"]',
    ) as HTMLElement | null;
    expect(idle!.querySelector("[data-portfolio-roles]")).toBeNull();
  });
});

describe("portfolio drill-down model", () => {
  it("derives all four sections from the portfolio row alone", () => {
    const sections = derivePortfolioDrilldown(gamma);
    expect(sections.map((section) => section.key)).toEqual([
      "units",
      "review",
      "patch",
      "validate",
    ]);

    const units = sections[0]!;
    expect(units.metrics.find((metric) => metric.key === "tracked")?.value).toBe(3);
    const review = sections[1]!;
    expect(review.metrics.find((metric) => metric.key === "blocked")?.value).toBe(1);
    expect(review.links[0]?.href).toContain("/play/units/portfolio-unit-3");
    const patch = sections[2]!;
    expect(patch.metrics.find((metric) => metric.key === "patched")?.value).toBe(3);
    const validate = sections[3]!;
    expect(validate.metrics.find((metric) => metric.key === "coverage")?.value).toBe("100%");
    expect(validate.links[0]?.href).toContain("/runs/portfolio-run-3");
  });

  it("states why a section has no destination rather than showing an empty list", () => {
    const validate = derivePortfolioDrilldown(beta).find((s) => s.key === "validate")!;
    expect(validate.links).toHaveLength(0);
    expect(validate.emptyLinkNote).toMatch(/run id only for a blocked unit-role/i);
  });
});

describe("portfolio drill-down surface", () => {
  it("opens units / review / patch / validate for the project the user clicked", () => {
    render(withShell(<PortfolioProgressPanel projects={ready(portfolioLiveProjectsFixture)} />));
    expect(document.querySelector("[data-portfolio-drilldown]")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open project project-gamma" }));

    const drilldown = document.querySelector("[data-portfolio-drilldown]") as HTMLElement | null;
    expect(drilldown).toHaveAttribute("data-portfolio-drilldown", "project-3");
    expect(drilldown).toHaveAttribute("data-portfolio-drilldown-sections", "4");
    for (const key of ["units", "review", "patch", "validate"]) {
      expect(
        drilldown!.querySelector(`[data-portfolio-drilldown-section="${key}"]`),
      ).not.toBeNull();
    }

    // Real numbers, sourced from the same polled row behind the board.
    const units = drilldown!.querySelector('[data-portfolio-drilldown-section="units"]')!;
    expect(
      within(units as HTMLElement).getByText("Tracked units").nextElementSibling,
    ).toHaveTextContent("3");
    // The drill-down carries the per-role detail too.
    expect(units.querySelector('[data-portfolio-role="patcher"]')).not.toBeNull();

    // Working deep-link into the blocked unit.
    const review = drilldown!.querySelector('[data-portfolio-drilldown-section="review"]')!;
    const unitLink = review.querySelector("a[data-portfolio-drilldown-link]");
    expect(gamma.selectedLocaleBranchId).not.toBeNull();
    expect(unitLink).toHaveAttribute(
      "href",
      `/play/units/portfolio-unit-3?projectId=project-3&localeBranchId=${gamma.selectedLocaleBranchId}`,
    );

    // The card reports itself expanded, and the board is still on screen.
    expect(document.querySelector('[data-portfolio-project="project-3"]')).toHaveAttribute(
      "data-portfolio-expanded",
      "true",
    );
    expect(document.querySelectorAll("[data-portfolio-project]")).toHaveLength(3);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(document.querySelector("[data-portfolio-drilldown]")).toBeNull();
  });

  it("switches the drill-down to whichever project is opened next", () => {
    render(withShell(<PortfolioProgressPanel projects={ready(portfolioLiveProjectsFixture)} />));
    fireEvent.click(screen.getByRole("button", { name: "Open project project-alpha" }));
    expect(document.querySelector("[data-portfolio-drilldown]")).toHaveAttribute(
      "data-portfolio-drilldown",
      "project-1",
    );
    fireEvent.click(screen.getByRole("button", { name: "Open project project-beta" }));
    expect(document.querySelectorAll("[data-portfolio-drilldown]")).toHaveLength(1);
    expect(document.querySelector("[data-portfolio-drilldown]")).toHaveAttribute(
      "data-portfolio-drilldown",
      "project-2",
    );
  });
});

describe("engine genericity", () => {
  // Three projects identical in every field EXCEPT engineFamily. If any part of
  // the portfolio UI branched on the engine, these would not render alike.
  function engineTwin(engineFamily: string, index: number): ProjectPortfolioEntry {
    return {
      ...alpha,
      projectId: `engine-${String(index)}`,
      projectKey: `engine-${String(index)}`,
      name: `engine-${String(index)}`,
      engineFamily,
      progress: { ...alpha.progress, projectId: `engine-${String(index)}` },
    };
  }

  it("renders three projects on three engines through the identical markup path", () => {
    const engines = ["reallive", "siglus", "kiri_kiri_xp3"];
    const projects = engines.map((engine, index) => engineTwin(engine, index + 1));
    render(withShell(<PortfolioProgressPanel projects={ready({ projects })} />));

    const normalized = projects.map((project, index) => {
      const card = document.querySelector(
        `[data-portfolio-project="engine-${String(index + 1)}"]`,
      ) as HTMLElement | null;
      expect(card).not.toBeNull();
      return card!.outerHTML
        .replaceAll(`engine-${String(index + 1)}`, "PROJECT")
        .replaceAll(engines[index]!, "ENGINE");
    });

    expect(normalized[1]).toBe(normalized[0]);
    expect(normalized[2]).toBe(normalized[0]);
    expect(document.querySelector("[data-portfolio-rollup]")).toHaveAttribute(
      "data-portfolio-engines",
      "3",
    );
  });

  it("renders the drill-down identically across those three engines", () => {
    const engines = ["reallive", "siglus", "kiri_kiri_xp3"];
    const projects = engines.map((engine, index) => engineTwin(engine, index + 1));
    const shapes = engines.map((engine, index) => {
      cleanup();
      render(withShell(<PortfolioProgressPanel projects={ready({ projects })} />));
      fireEvent.click(
        screen.getByRole("button", { name: `Open project engine-${String(index + 1)}` }),
      );
      const drilldown = document.querySelector("[data-portfolio-drilldown]") as HTMLElement;
      return drilldown.outerHTML
        .replaceAll(`engine-${String(index + 1)}`, "PROJECT")
        .replaceAll(engine, "ENGINE");
    });
    expect(shapes[1]).toBe(shapes[0]);
    expect(shapes[2]).toBe(shapes[0]);
  });
});
