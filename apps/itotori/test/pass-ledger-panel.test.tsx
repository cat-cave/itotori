// @vitest-environment jsdom
// Behavior coverage for the dashboard slot now backed exclusively by the
// durable execution journal. The DOM asserts a real run identity plus
// physical-call/QA/context provenance facts from the composed read model.

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

function richOverview(overrides?: Partial<ProjectOverviewReadModel>): ProjectOverviewReadModel {
  return {
    ...projectOverviewFixture,
    journal: {
      filter: {
        projectId: dashboardStatusFixture.projectId,
        localeBranchId: dashboardStatusFixture.selectedLocaleBranchId,
      },
      pagination: {
        total: 2,
        limit: 10,
        offset: 0,
        page: 1,
        pageCount: 1,
        hasMore: false,
        nextOffset: null,
      },
      rows: [
        {
          journalRunId: "journal-run-provenance-001",
          projectId: dashboardStatusFixture.projectId,
          localeBranchId: dashboardStatusFixture.selectedLocaleBranchId ?? "locale-branch-1",
          sourceRevisionId: dashboardStatusFixture.sourceBundleRevisionId,
          targetLocale: "en-US",
          createdAt: "2026-07-07T01:00:00.000Z",
          physicalCallCount: 4,
          failedPhysicalCallCount: 1,
          writtenOutcomeCount: 2,
          candidateCount: 3,
          qaFindingCount: 2,
          contextRefCount: 3,
          speakerLabelCount: 1,
        },
        {
          journalRunId: "journal-run-provenance-002",
          projectId: dashboardStatusFixture.projectId,
          localeBranchId: dashboardStatusFixture.selectedLocaleBranchId ?? "locale-branch-1",
          sourceRevisionId: dashboardStatusFixture.sourceBundleRevisionId,
          targetLocale: "en-US",
          createdAt: "2026-07-07T02:00:00.000Z",
          physicalCallCount: 2,
          failedPhysicalCallCount: 0,
          writtenOutcomeCount: 1,
          candidateCount: 2,
          qaFindingCount: 1,
          contextRefCount: 1,
          speakerLabelCount: 0,
        },
      ],
      latestRow: {
        journalRunId: "journal-run-provenance-002",
        projectId: dashboardStatusFixture.projectId,
        localeBranchId: dashboardStatusFixture.selectedLocaleBranchId ?? "locale-branch-1",
        sourceRevisionId: dashboardStatusFixture.sourceBundleRevisionId,
        targetLocale: "en-US",
        createdAt: "2026-07-07T02:00:00.000Z",
        physicalCallCount: 2,
        failedPhysicalCallCount: 0,
        writtenOutcomeCount: 1,
        candidateCount: 2,
        qaFindingCount: 1,
        contextRefCount: 1,
        speakerLabelCount: 0,
      },
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

describe("Overview execution journal panel", () => {
  it("renders journal run identity and persisted physical-call, QA, and context provenance", async () => {
    renderWithToasts(<PassLedgerPanel />);

    expect(
      await screen.findByRole("heading", { name: /Execution journal — 2 runs recorded/i }),
    ).toBeInTheDocument();
    const aggregate = screen.getByLabelText("Execution journal aggregate");
    expect(aggregate).toHaveTextContent("Runs");
    expect(aggregate).toHaveTextContent("2");
    expect(aggregate).toHaveTextContent("Physical calls");
    expect(aggregate).toHaveTextContent("6");
    expect(aggregate).toHaveTextContent("Candidates");
    expect(aggregate).toHaveTextContent("5");
    expect(aggregate).toHaveTextContent("QA findings");
    expect(aggregate).toHaveTextContent("3");

    const table = screen.getByRole("table", { name: "Execution journal" });
    expect(within(table).getByRole("columnheader", { name: "Physical calls" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "QA" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Context refs" })).toBeInTheDocument();
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);
    const firstRun = rows[1]!;
    expect(within(firstRun).getByText("journal-run-provenance-001")).toBeInTheDocument();
    expect(firstRun).toHaveTextContent("4 (1 failed)");
    expect(firstRun).toHaveTextContent("3"); // candidates and context refs
    expect(firstRun).toHaveTextContent("2"); // written outcomes and QA findings
  });

  it("shows the loading surface before the read model settles", () => {
    renderWithToasts(<PassLedgerPanel />);
    expect(screen.getByText("Loading execution journal…")).toBeInTheDocument();
  });

  it("surfaces the empty state when no durable journal run exists", async () => {
    server.use(
      http.get("*/api/projects/overview", () =>
        apiJson(
          "projects.overview",
          richOverview({
            journal: {
              ...richOverview().journal,
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
              latestRow: null,
            },
          }),
        ),
      ),
    );
    renderWithToasts(<PassLedgerPanel />);
    expect(
      await screen.findByText(
        "No durable localization runs have been recorded for this project yet.",
      ),
    ).toBeInTheDocument();
  });

  it("surfaces a typed error state instead of a blank panel", async () => {
    server.use(
      http.get("*/api/projects/overview", () =>
        HttpResponse.json(
          { code: "forbidden", error: "not permitted to read execution journal" },
          { status: 403 },
        ),
      ),
    );
    renderWithToasts(<PassLedgerPanel />);
    expect(await screen.findByText("not permitted to read execution journal")).toBeInTheDocument();
  });
});
