// @vitest-environment jsdom
// shell-frame-ui (HI-FI STUDIO EPIC · Shell) — behavior-first test for the
// persistent SPA shell frame.
//
// Mounts the REAL `ShellFrame` (nav + status bar) over msw-intercepted
// `/api/projects/status` + `/api/projects/cost` and asserts the OBSERVABLE
// rendered behavior a viewer sees, per the acceptance:
//
//   1. the frame renders NAV (the surface pills, active from the location) +
//      a persistent STATUS BAR;
//   2. the status bar renders Project+branch context + ZDR posture
//      (zdr=true; data_collection=none) + source->branch + LIVE COST, all
//      from the read-models via the typed client (no ad-hoc fetch);
//   3. the ZDR posture is shown HONESTLY — derived from the REAL captured
//      routing posture (enforced / opted_out / unavailable), never hardcoded;
//   4. loading / empty / error are handled (each cell degrades on its own
//      read, never a blank bar);
//   5. selecting a nav pill navigates to the surface href.
//
// [[feedback_behavior_first_code_agnostic_testing]] — no game is named; only
// the rendered nav + status bar states are asserted, over msw.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { ProjectCostReport, ProjectDashboardStatus } from "@itotori/db";
import { RedactionGovernor } from "../src/ui/redaction-governor.js";
import {
  ShellFrame,
  SHELL_NAV_ITEMS,
  activeShellNavId,
  readZdrPosture,
} from "../src/ui/shell-frame.js";
import type { AppLocation } from "../src/ui/App.js";
import { apiJson } from "./msw-handlers.js";
import { costReportFixture, dashboardStatusFixture } from "./api-fixtures.js";

const server = setupServer(
  http.get("*/api/projects/status", () => apiJson("projects.status", dashboardStatusFixture)),
  http.get("*/api/projects/cost", () => apiJson("projects.cost", costReportFixture)),
  // shell-project-branch-switcher — the switcher mounted in the toolbar +
  // the status bar's effective-selection resolution read the project hierarchy
  // through `projects.list` (each project carries its locale branches).
  http.get("*/api/projects", () =>
    apiJson("projects.list", { projects: [dashboardStatusFixture] }),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

function mountFrame(
  location: AppLocation = { pathname: "/", search: "" },
  navigate: (path: string) => void = vi.fn(),
): { navigate: (path: string) => void } {
  render(
    <RedactionGovernor>
      <ShellFrame location={location} navigate={navigate}>
        <div data-screen-stub />
      </ShellFrame>
    </RedactionGovernor>,
  );
  return { navigate };
}

/** The ZDR posture cell — found via its stat label, scoped to the cell. */
function zdrCell(): HTMLElement {
  const label = screen.getByText("ZDR posture");
  const cell = label.closest('[data-shell-stat="zdr"]');
  if (cell === null) {
    throw new Error("ZDR posture cell was not rendered");
  }
  return cell as HTMLElement;
}

/** A fresh cost report with the latest run carrying the given routing posture. */
function costWithPosture(posture: Record<string, unknown>): ProjectCostReport {
  const seed = costReportFixture.recentRuns[0]!;
  return {
    ...costReportFixture,
    recentRuns: [{ ...seed, routingPosture: posture }],
  };
}

const OPTED_OUT_POSTURE = {
  order: ["public-provider"],
  allow_fallbacks: true,
  data_collection: "allow",
  zdr: false,
  require_parameters: true,
};

describe("Shell frame — nav", () => {
  it("renders the surface pills and marks the active pill from the location", () => {
    mountFrame({ pathname: "/", search: "" });
    const nav = screen.getByRole("navigation", { name: "Surfaces" });
    const pills = within(nav).getAllByRole("tab");
    expect(pills.map((pill) => pill.textContent)).toEqual(
      SHELL_NAV_ITEMS.map((item) => item.label),
    );
    // Workbench is active at "/".
    expect(within(nav).getByRole("tab", { name: "Workbench" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(within(nav).getByRole("tab", { name: "Review" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  it("marks Review active on /reviewer-queue and Workspace active on /workspace", () => {
    mountFrame({ pathname: "/reviewer-queue", search: "" });
    expect(screen.getByRole("tab", { name: "Review" })).toHaveAttribute("aria-selected", "true");
    cleanup();
    mountFrame({ pathname: "/workspace/scenes", search: "" });
    expect(screen.getByRole("tab", { name: "Workspace" })).toHaveAttribute("aria-selected", "true");
  });

  it("navigates to the surface href when a pill is selected", () => {
    const navigate = vi.fn();
    mountFrame({ pathname: "/", search: "" }, navigate);
    fireEvent.click(screen.getByRole("tab", { name: "Review" }));
    expect(navigate).toHaveBeenCalledWith("/reviewer-queue");
  });
});

describe("Shell frame — status bar (read-models via the client)", () => {
  it("renders project+branch, source->branch, ZDR posture, and live cost from the mock", async () => {
    mountFrame();

    // Project (projects.status.name) + selected branch targetLocale
    // (selectedLocaleBranchId → fr-FR locale branch).
    expect(await screen.findByText("project-1")).toBeInTheDocument();
    expect(screen.getByText("fr-FR")).toBeInTheDocument();

    // Source -> selected branch (sourceLocale → targetLocale).
    expect(screen.getByText("ja-JP → fr-FR")).toBeInTheDocument();

    // ZDR posture — enforced (zdr=true; data_collection=none), from the
    // latest run's captured routing posture.
    expect(screen.getByText("zdr=true")).toBeInTheDocument();
    expect(screen.getByText("data_collection=none")).toBeInTheDocument();
    expect(zdrCell()).toHaveAttribute("data-zdr-phase", "enforced");

    // Live cost (projects.cost.billedMicrosUsd) — real recorded micros-USD.
    expect(screen.getByText("$0.002180")).toBeInTheDocument();

    // The status bar settled to ready.
    expect(screen.getByRole("status", { name: "Shell status bar" })).toHaveAttribute(
      "data-shell-status",
      "ready",
    );
  });

  it("renders the children (the routed screen) inside the frame", () => {
    mountFrame();
    expect(screen.getByText("ZDR posture")).toBeInTheDocument();
    expect(document.querySelector("[data-screen-stub]")).not.toBeNull();
  });
});

describe("Shell frame — ZDR posture honesty", () => {
  it("shows an opted-out posture truthfully (zdr=false; data_collection=allow)", async () => {
    server.use(
      http.get("*/api/projects/cost", () =>
        apiJson("projects.cost", costWithPosture(OPTED_OUT_POSTURE)),
      ),
    );
    mountFrame();
    expect(await screen.findByText("zdr=false")).toBeInTheDocument();
    expect(screen.getByText("data_collection=allow")).toBeInTheDocument();
    expect(zdrCell()).toHaveAttribute("data-zdr-phase", "opted_out");
  });

  it("shows unavailable when no provider run was recorded (no posture to read)", async () => {
    server.use(
      http.get("*/api/projects/cost", () =>
        apiJson("projects.cost", { ...costReportFixture, recentRuns: [] }),
      ),
    );
    mountFrame();
    expect(await screen.findByText("no recorded posture")).toBeInTheDocument();
    expect(zdrCell()).toHaveAttribute("data-zdr-phase", "unavailable");
  });

  it("shows unavailable when the captured posture is malformed / the pre-ITOTORI-230 sentinel", async () => {
    server.use(
      http.get("*/api/projects/cost", () =>
        apiJson("projects.cost", costWithPosture({ _pre_itotori_230: true })),
      ),
    );
    mountFrame();
    expect(await screen.findByText("no recorded posture")).toBeInTheDocument();
    expect(zdrCell()).toHaveAttribute("data-zdr-phase", "unavailable");
  });
});

describe("Shell frame — loading / empty / error handling", () => {
  it("shows loading placeholders while the reads are in flight", () => {
    server.use(
      http.get("*/api/projects/status", () => new Promise(() => {})),
      http.get("*/api/projects/cost", () => new Promise(() => {})),
    );
    mountFrame();
    const bar = screen.getByRole("status", { name: "Shell status bar" });
    expect(bar).toHaveAttribute("data-shell-status", "loading");
    // Each cell renders its own loading marker (not a blank).
    expect(screen.getAllByText("loading…").length).toBeGreaterThan(0);
  });

  it("degrades the cost + ZDR cells to unavailable on a cost error (project/branch still render)", async () => {
    server.use(
      http.get("*/api/projects/cost", () =>
        HttpResponse.json(
          { code: "forbidden", error: "not permitted to read cost" },
          { status: 403 },
        ),
      ),
    );
    mountFrame();
    // Project + branch still render from the successful status read.
    expect(await screen.findByText("project-1")).toBeInTheDocument();
    expect(screen.getByText("fr-FR")).toBeInTheDocument();

    // The live-cost cell degrades (no fabricated value).
    const costCell = screen.getByText("Live cost").closest('[data-shell-stat="cost"]');
    expect(costCell).not.toBeNull();
    expect(costCell).toHaveTextContent("unavailable");

    // The ZDR posture cell degrades to the error phase (no posture to read).
    expect(zdrCell()).toHaveAttribute("data-zdr-phase", "error");
    expect(zdrCell()).toHaveTextContent("unavailable");

    expect(screen.getByRole("status", { name: "Shell status bar" })).toHaveAttribute(
      "data-shell-status",
      "error",
    );
  });

  it("degrades the project/branch/source cells on a status error", async () => {
    server.use(
      http.get("*/api/projects/status", () =>
        HttpResponse.json({ code: "internal_error", error: "status read failed" }, { status: 500 }),
      ),
    );
    mountFrame();
    // Project / branch / source cells degrade; live cost still renders from
    // the successful cost read.
    expect(await screen.findByText("$0.002180")).toBeInTheDocument();
    const bar = screen.getByRole("status", { name: "Shell status bar" });
    expect(bar).toHaveAttribute("data-shell-status", "error");
    // Three status-driven cells (project / branch / source) read unavailable.
    expect(screen.getAllByText("unavailable").length).toBeGreaterThanOrEqual(3);
  });

  it("renders 'none selected' + 'source → —' when no locale branch is selected", async () => {
    server.use(
      http.get("*/api/projects/status", () =>
        apiJson("projects.status", {
          ...dashboardStatusFixture,
          selectedLocaleBranchId: null,
        } satisfies ProjectDashboardStatus),
      ),
    );
    mountFrame();
    expect(await screen.findByText("none selected")).toBeInTheDocument();
    expect(screen.getByText("ja-JP → —")).toBeInTheDocument();
  });
});

describe("Shell frame — pure helpers", () => {
  it("activeShellNavId maps each surface path to its pill id", () => {
    expect(activeShellNavId("/")).toBe("workbench");
    expect(activeShellNavId("/reviewer-queue")).toBe("review");
    expect(activeShellNavId("/reviewer-queue/some-item")).toBe("review");
    expect(activeShellNavId("/workspace")).toBe("workspace");
    expect(activeShellNavId("/workspace/scenes")).toBe("workspace");
    // A legacy / unknown route matches no pill.
    expect(activeShellNavId("/asset-decisions")).toBe("");
  });

  it("readZdrPosture classifies enforced / opted_out / unavailable from the real posture", () => {
    const enforced = readZdrPosture(costReportFixture);
    expect(enforced.kind).toBe("enforced");

    const optedOut = readZdrPosture(costWithPosture(OPTED_OUT_POSTURE));
    expect(optedOut.kind).toBe("opted_out");
    if (optedOut.kind !== "opted_out") throw new Error("unreachable");
    expect(optedOut.posture.zdr).toBe(false);
    expect(optedOut.posture.dataCollection).toBe("allow");

    const noRuns = readZdrPosture({ ...costReportFixture, recentRuns: [] });
    expect(noRuns.kind).toBe("unavailable");

    const sentinel = readZdrPosture(costWithPosture({ _pre_itotori_230: true }));
    expect(sentinel.kind).toBe("unavailable");
  });
});
