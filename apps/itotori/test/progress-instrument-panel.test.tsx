// @vitest-environment jsdom
// ovw-progress-instrument-ui — behavior-first test for the Overview localization
// progress instrument.
//
// Mounts the real `ProgressInstrumentPanel` over an msw-intercepted
// `/api/projects/overview` and asserts the OBSERVABLE behavior: the ds
// `LocalizationProgress` instrument renders the STAGE BREAKOUTS (cleared / in-qa
// / pending) + the iteration CYCLE + the remaining-work ("eta" slot) readout,
// all derived from the composed read model (`progress` + `passLedger`) THROUGH
// the typed client (no ad-hoc fetch), and that loading / empty / error surface
// instead of a blank or fabricated panel.
// [[feedback_behavior_first_code_agnostic_testing]] — no game is named; only the
// rendered stages / cycle / remaining / states are asserted, over msw.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { ProjectDashboardStatus } from "@itotori/db";
import { ProgressInstrumentPanel } from "../src/ui/screens/ProgressInstrumentPanel.js";
import type { ProjectOverviewReadModel } from "../src/project-overview-read-model.js";
import { apiJson } from "./msw-handlers.js";
import { dashboardStatusFixture, projectOverviewFixture } from "./api-fixtures.js";

const RICH_BRANCH_ID = "locale-branch-rich";

// A branch with a meaningful funnel: 100 units, 70 drafted, 20 carrying an open
// QA finding -> cleared 50, in-qa 20, pending 30; remaining (in-qa + pending) 50.
function richStatus(overrides?: Partial<ProjectDashboardStatus>): ProjectDashboardStatus {
  return {
    ...dashboardStatusFixture,
    unitCount: 100,
    selectedLocaleBranchId: RICH_BRANCH_ID,
    localeBranches: [
      {
        localeBranchId: RICH_BRANCH_ID,
        targetLocale: "en-US",
        status: "active",
        currentStyleGuidePolicyVersionId: null,
        unitCount: 100,
        translatedUnitCount: 70,
        openFindingCount: 20,
        artifactCount: 4,
      },
    ],
    ...overrides,
  };
}

// Three recorded passes (pass 3 built on pass 2 built on pass 1) -> cycle 3/3,
// two revision passes (those with a prior).
function richOverview(overrides?: Partial<ProjectOverviewReadModel>): ProjectOverviewReadModel {
  const status = overrides?.progress ?? richStatus();
  return {
    ...projectOverviewFixture,
    progress: status,
    passLedger: {
      filter: { projectId: status.projectId, localeBranchId: RICH_BRANCH_ID },
      pagination: {
        total: 3,
        limit: 10,
        offset: 0,
        page: 1,
        pageCount: 1,
        hasMore: false,
        nextOffset: null,
      },
      rows: [1, 2, 3].map((passNumber) => ({
        passLedgerId: `pass-${passNumber}`,
        projectId: status.projectId,
        localeBranchId: RICH_BRANCH_ID,
        sourceRevisionId: status.sourceBundleRevisionId,
        passNumber,
        priorPassNumber: passNumber === 1 ? null : passNumber - 1,
        totalUsageCostUsd: 0.01 * passNumber,
        zdrConfirmed: true,
        recordedAt: "2026-07-07T00:00:00.000Z",
        score: 3 + passNumber * 0.2,
        feedback: passNumber === 1 ? 0 : passNumber * 6,
        note: passNumber === 1 ? "Initial draft." : `Folded in pass ${passNumber - 1} feedback.`,
      })),
    },
    ...overrides,
  };
}

const server = setupServer(
  http.get("*/api/projects/overview", () => apiJson("projects.overview", richOverview())),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

describe("Overview progress instrument", () => {
  it("renders the stage breakouts + cycle + remaining from the composed read model", async () => {
    const { container } = render(<ProgressInstrumentPanel />);

    // Panel + the ds instrument settle to ready.
    expect(
      await screen.findByRole("heading", { name: "Localization progress" }),
    ).toBeInTheDocument();

    // HEADLINE %: cleared 50 / total 100 = 50% proven-headline, with a sourced
    // aria label naming the exact counts.
    expect(await screen.findByText("50%")).toBeInTheDocument();
    expect(screen.getByLabelText("50 of 100 units proven")).toBeInTheDocument();

    // STAGE BREAKOUTS: the disjoint funnel counts render as ds StatReadouts.
    const breakouts = screen.getByLabelText("Progress breakouts");
    expect(breakouts).toHaveTextContent("Total units");
    expect(breakouts).toHaveTextContent("100");
    expect(breakouts).toHaveTextContent("Translated");
    expect(breakouts).toHaveTextContent("70");
    expect(breakouts).toHaveTextContent("In QA");
    expect(breakouts).toHaveTextContent("Cleared");
    expect(breakouts).toHaveTextContent("50");
    expect(breakouts).toHaveTextContent("Pending");
    expect(breakouts).toHaveTextContent("30");
    // The revision DIMENSION (two passes built on a prior).
    expect(breakouts).toHaveTextContent("Revision passes");
    expect(breakouts).toHaveTextContent("2");

    // CYCLE: from the pass ledger (latest pass 3 of 3 recorded).
    const cycle = container.querySelector(".itotori-locprog__cycle");
    expect(cycle).not.toBeNull();
    expect(cycle).toHaveTextContent("cycle 3/3");

    // ETA slot: exact remaining-work units (in-qa 20 + pending 30 = 50), sourced
    // — never an invented completion time.
    const remaining = container.querySelector("[data-progress-remaining]");
    expect(remaining).not.toBeNull();
    expect(remaining).toHaveAttribute("data-progress-remaining", "50");
    expect(remaining).toHaveTextContent("50 units remaining");
  });

  it("shows the loading surface before the read model settles", () => {
    render(<ProgressInstrumentPanel />);
    // The typed resource starts in `loading`; the panel paints the loading
    // surface synchronously on first render, before the fetch resolves.
    expect(screen.getByText("Loading progress…")).toBeInTheDocument();
  });

  it("surfaces the empty state when the project has no locale branch", async () => {
    server.use(
      http.get("*/api/projects/overview", () =>
        apiJson(
          "projects.overview",
          richOverview({
            progress: richStatus({ selectedLocaleBranchId: null, localeBranches: [] }),
          }),
        ),
      ),
    );
    render(<ProgressInstrumentPanel />);
    expect(
      await screen.findByText("No locale branch is available to scope the progress instrument."),
    ).toBeInTheDocument();
  });

  it("surfaces a typed error state instead of a blank panel", async () => {
    server.use(
      http.get("*/api/projects/overview", () =>
        HttpResponse.json(
          { code: "forbidden", error: "not permitted to read overview" },
          { status: 403 },
        ),
      ),
    );
    render(<ProgressInstrumentPanel />);
    expect(await screen.findByText("not permitted to read overview")).toBeInTheDocument();
  });
});
