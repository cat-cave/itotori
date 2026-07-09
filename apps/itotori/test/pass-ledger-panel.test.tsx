// @vitest-environment jsdom
// ovw-pass-ledger-ui — behavior-first test for the Overview pass-ledger panel.
//
// Mounts the real `PassLedgerPanel` over an msw-intercepted
// `/api/projects/overview` and asserts the OBSERVABLE behavior: per-pass
// SCORE / FEEDBACK / NOTE rows render from the composed `passLedger.rows`
// piece of the read model, sourced THROUGH the typed client (no ad-hoc
// fetch); loading / empty / error surface instead of a blank or fabricated
// panel. The same panel hook the dashboard wires into its DashboardScreen
// overview grid; this test covers its standalone contract.
// [[feedback_behavior_first_code_agnostic_testing]] — no game is named; only
// the rendered pass rows + their sourced score / feedback / note values are
// asserted, over msw.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { cleanup, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { ProjectOverviewReadModel } from "../src/project-overview-read-model.js";
import { PassLedgerPanel } from "../src/ui/screens/PassLedgerPanel.js";
import { ToastProvider } from "../src/ui/toast-host.js";
import { apiJson } from "./msw-handlers.js";
import { dashboardStatusFixture, projectOverviewFixture } from "./api-fixtures.js";

// Four recorded passes (each built on the prior) so the panel renders the
// full iteration lineage + a mix of score / feedback / note shapes.
function richOverview(overrides?: Partial<ProjectOverviewReadModel>): ProjectOverviewReadModel {
  return {
    ...projectOverviewFixture,
    passLedger: {
      filter: {
        projectId: dashboardStatusFixture.projectId,
        localeBranchId: dashboardStatusFixture.selectedLocaleBranchId,
      },
      pagination: {
        total: 4,
        limit: 10,
        offset: 0,
        page: 1,
        pageCount: 1,
        hasMore: false,
        nextOffset: null,
      },
      rows: [
        {
          passLedgerId: "localization-pass-1",
          projectId: dashboardStatusFixture.projectId,
          localeBranchId: dashboardStatusFixture.selectedLocaleBranchId ?? "locale-branch-1",
          sourceRevisionId: dashboardStatusFixture.sourceBundleRevisionId,
          passNumber: 1,
          priorPassNumber: null,
          totalUsageCostUsd: 0.051,
          zdrConfirmed: true,
          recordedAt: "2026-07-07T01:00:00.000Z",
          score: 3.4,
          feedback: 0,
          note: "First full draft.",
        },
        {
          passLedgerId: "localization-pass-2",
          projectId: dashboardStatusFixture.projectId,
          localeBranchId: dashboardStatusFixture.selectedLocaleBranchId ?? "locale-branch-1",
          sourceRevisionId: dashboardStatusFixture.sourceBundleRevisionId,
          passNumber: 2,
          priorPassNumber: 1,
          totalUsageCostUsd: 0.0612,
          zdrConfirmed: true,
          recordedAt: "2026-07-07T02:00:00.000Z",
          score: 3.9,
          feedback: 18,
          note: "Folded in 18 corrections.",
        },
        {
          passLedgerId: "localization-pass-3",
          projectId: dashboardStatusFixture.projectId,
          localeBranchId: dashboardStatusFixture.selectedLocaleBranchId ?? "locale-branch-1",
          sourceRevisionId: dashboardStatusFixture.sourceBundleRevisionId,
          passNumber: 3,
          priorPassNumber: 2,
          totalUsageCostUsd: 0.0735,
          zdrConfirmed: true,
          recordedAt: "2026-07-07T03:00:00.000Z",
          score: 4.2,
          feedback: 11,
          note: "Tone + honorific consistency pass.",
        },
        {
          passLedgerId: "localization-pass-4",
          projectId: dashboardStatusFixture.projectId,
          localeBranchId: dashboardStatusFixture.selectedLocaleBranchId ?? "locale-branch-1",
          sourceRevisionId: dashboardStatusFixture.sourceBundleRevisionId,
          passNumber: 4,
          priorPassNumber: 3,
          totalUsageCostUsd: 0.0488,
          zdrConfirmed: true,
          recordedAt: "2026-07-07T04:00:00.000Z",
          score: null,
          feedback: 6,
          note: "",
        },
      ],
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

function renderWithToasts(ui: ReactNode): void {
  render(<ToastProvider>{ui}</ToastProvider>);
}

describe("Overview pass ledger panel", () => {
  it("renders per-pass score / feedback / note rows from the composed read model", async () => {
    renderWithToasts(<PassLedgerPanel />);

    // Panel settles to the sourced row count headline.
    expect(
      await screen.findByRole("heading", { name: /Pass ledger — 4 passes recorded/i }),
    ).toBeInTheDocument();

    // AGGREGATE: the sourced counts render as ds StatReadouts.
    const aggregate = screen.getByLabelText("Pass ledger aggregate");
    expect(aggregate).toHaveTextContent("Passes");
    expect(aggregate).toHaveTextContent("4");
    expect(aggregate).toHaveTextContent("Feedback notes");
    expect(aggregate).toHaveTextContent("35");
    expect(aggregate).toHaveTextContent("Avg score");
    expect(aggregate).toHaveTextContent("3.8");
    expect(aggregate).toHaveTextContent("Latest pass");
    expect(aggregate).toHaveTextContent("pass 4");

    // PER-PASS: SCORE / FEEDBACK / NOTE rows. The ds DataTable renders each
    // column per pass, sourced verbatim from the read model.
    const table = screen.getByRole("table", { name: "Pass ledger" });
    expect(within(table).getByRole("columnheader", { name: "Pass" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Iteration" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Score" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Feedback" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Note" })).toBeInTheDocument();

    // The pass-ledger table renders one row per pass with sourced columns. The
    // "Pass" column shows `pass N`, the "Iteration" column shows `pass M`
    // (the prior pass this one built on); row 1's iteration is "—" (no prior).
    // We assert each row's sourced cells rather than chasing shared "pass 1"
    // substrings (which appear in multiple rows via the iteration lineage).
    const allRows = within(table).getAllByRole("row");
    // Header row + 4 data rows.
    expect(allRows).toHaveLength(5);

    // Row 1: first pass, no prior (iteration "—"), score 3.4, feedback 0,
    // note "First full draft.".
    const row1 = allRows[1];
    if (row1 === undefined) {
      throw new Error("row 1 not found");
    }
    expect(within(row1).getByText("pass 1")).toBeInTheDocument();
    expect(row1).toHaveTextContent("—");
    expect(row1).toHaveTextContent("3.4");
    expect(row1).toHaveTextContent("First full draft.");

    // Row 2: built on pass 1, score 3.9, feedback 18, correction note.
    const row2 = allRows[2];
    if (row2 === undefined) {
      throw new Error("row 2 not found");
    }
    expect(within(row2).getByText("pass 2")).toBeInTheDocument();
    expect(row2).toHaveTextContent("pass 1"); // iteration
    expect(row2).toHaveTextContent("3.9");
    expect(row2).toHaveTextContent("18");
    expect(row2).toHaveTextContent("Folded in 18 corrections.");

    // Row 3: built on pass 2, score 4.2, feedback 11, tone note.
    const row3 = allRows[3];
    if (row3 === undefined) {
      throw new Error("row 3 not found");
    }
    expect(within(row3).getByText("pass 3")).toBeInTheDocument();
    expect(row3).toHaveTextContent("pass 2"); // iteration
    expect(row3).toHaveTextContent("4.2");
    expect(row3).toHaveTextContent("11");
    expect(row3).toHaveTextContent("Tone + honorific consistency pass.");

    // Row 4 (the latest pass): score is NULL → renders as "—" (honest null,
    // not a fabricated zero); feedback 6; note empty → "—" placeholder.
    const row4 = allRows[4];
    if (row4 === undefined) {
      throw new Error("row 4 not found");
    }
    expect(within(row4).getByText("pass 4")).toBeInTheDocument();
    expect(row4).toHaveTextContent("pass 3"); // built on pass 3
    expect(row4).toHaveTextContent("6"); // feedback count
    // Two "—" in row 4: the null score AND the empty note.
    const dashesInRow4 = within(row4).getAllByText("—");
    expect(dashesInRow4.length).toBe(2);
  });

  it("shows the loading surface before the read model settles", () => {
    renderWithToasts(<PassLedgerPanel />);
    expect(screen.getByText("Loading pass ledger…")).toBeInTheDocument();
  });

  it("surfaces the empty state when the project has no recorded passes", async () => {
    server.use(
      http.get("*/api/projects/overview", () =>
        apiJson(
          "projects.overview",
          richOverview({
            passLedger: {
              ...richOverview().passLedger,
              rows: [],
              pagination: {
                total: 0,
                limit: 10,
                offset: 0,
                page: 1,
                pageCount: 0,
                hasMore: false,
                nextOffset: null,
              },
            },
          }),
        ),
      ),
    );
    renderWithToasts(<PassLedgerPanel />);
    expect(
      await screen.findByText("No localization passes have been recorded for this project yet."),
    ).toBeInTheDocument();
  });

  it("surfaces a typed error state instead of a blank panel", async () => {
    server.use(
      http.get("*/api/projects/overview", () =>
        HttpResponse.json(
          { code: "forbidden", error: "not permitted to read pass ledger" },
          { status: 403 },
        ),
      ),
    );
    renderWithToasts(<PassLedgerPanel />);
    expect(await screen.findByText("not permitted to read pass ledger")).toBeInTheDocument();
  });
});
