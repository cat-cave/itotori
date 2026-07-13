// @vitest-environment jsdom

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { cleanup, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { ProjectOverviewReadModel } from "../src/project-overview-read-model.js";
import {
  deriveLoopSpine,
  latestLoopSpineJournalRow,
  LoopSpinePanel,
  type LoopSpineStage,
} from "../src/ui/screens/LoopSpinePanel.js";
import {
  bmkCockpitFixture,
  dashboardStatusFixture,
  projectOverviewFixture,
} from "./api-fixtures.js";
import { apiJson } from "./msw-handlers.js";

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
          journalRunId: "journal-run-spine-1",
          projectId: dashboardStatusFixture.projectId,
          localeBranchId: dashboardStatusFixture.selectedLocaleBranchId ?? "locale-branch-1",
          sourceRevisionId: dashboardStatusFixture.sourceBundleRevisionId,
          targetLocale: "en-US",
          createdAt: "2026-07-07T01:00:00.000Z",
          physicalCallCount: 3,
          failedPhysicalCallCount: 0,
          writtenOutcomeCount: 1,
          candidateCount: 1,
          qaFindingCount: 1,
          contextRefCount: 1,
          speakerLabelCount: 0,
        },
        {
          journalRunId: "journal-run-spine-2",
          projectId: dashboardStatusFixture.projectId,
          localeBranchId: dashboardStatusFixture.selectedLocaleBranchId ?? "locale-branch-1",
          sourceRevisionId: dashboardStatusFixture.sourceBundleRevisionId,
          targetLocale: "en-US",
          createdAt: "2026-07-07T02:00:00.000Z",
          physicalCallCount: 4,
          failedPhysicalCallCount: 1,
          writtenOutcomeCount: 2,
          candidateCount: 3,
          qaFindingCount: 2,
          contextRefCount: 2,
          speakerLabelCount: 1,
        },
      ],
      latestRow: {
        journalRunId: "journal-run-spine-2",
        projectId: dashboardStatusFixture.projectId,
        localeBranchId: dashboardStatusFixture.selectedLocaleBranchId ?? "locale-branch-1",
        sourceRevisionId: dashboardStatusFixture.sourceBundleRevisionId,
        targetLocale: "en-US",
        createdAt: "2026-07-07T02:00:00.000Z",
        physicalCallCount: 4,
        failedPhysicalCallCount: 1,
        writtenOutcomeCount: 2,
        candidateCount: 3,
        qaFindingCount: 2,
        contextRefCount: 2,
        speakerLabelCount: 1,
      },
    },
    ...overrides,
  };
}

const projectId = projectOverviewFixture.projectId;
const server = setupServer(
  http.get("*/api/projects/overview", () => apiJson("projects.overview", richOverview())),
  http.get(`*/api/projects/${projectId}/bmk-cockpit`, () =>
    apiJson("projects.bmkCockpit", bmkCockpitFixture),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

describe("Iterative-loop spine panel", () => {
  it("derives correction and launch stages from durable journal runs", async () => {
    render(<LoopSpinePanel />);
    expect(await screen.findByRole("heading", { name: /Iterative loop/i })).toBeInTheDocument();
    const spine = screen.getByLabelText("Iterative loop stages");
    expect(within(spine).getAllByRole("listitem")).toHaveLength(6);
    const correct = spine.querySelector('[data-stage="correct"]') as HTMLElement;
    const iterate = spine.querySelector('[data-stage="iterate"]') as HTMLElement;
    const launch = spine.querySelector('[data-stage="launch"]') as HTMLElement;
    const rescore = spine.querySelector('[data-stage="rescore"]') as HTMLElement;
    expect(within(correct).getByRole("link", { name: /^Correct/u })).toHaveAttribute(
      "href",
      "/wiki",
    );
    expect(correct).toHaveTextContent(
      "Wiki corrections update canonical context for the next run.",
    );
    expect(correct).toHaveTextContent("3 open");
    expect(iterate).toHaveTextContent("Patch feedback creates the result revision for run 3.");
    expect(launch).toHaveTextContent("run 3");
    expect(launch).toHaveTextContent("Director drives the next localization run");
    expect(rescore).toHaveTextContent("—");
  });

  it("shows the loading surface before the read model settles", () => {
    render(<LoopSpinePanel />);
    expect(screen.getByText("Loading the iterative loop…")).toBeInTheDocument();
  });

  it("surfaces a typed error state instead of a blank panel", async () => {
    server.use(
      http.get("*/api/projects/overview", () =>
        HttpResponse.json(
          { code: "forbidden", error: "not permitted to read the project overview" },
          { status: 403 },
        ),
      ),
    );
    render(<LoopSpinePanel />);
    expect(
      await screen.findByText("not permitted to read the project overview"),
    ).toBeInTheDocument();
  });
});

describe("deriveLoopSpine", () => {
  it("uses journal count for the next run and leaves absent signals honest", () => {
    const stages = deriveLoopSpine(richOverview(), null);
    const byId = (id: string): LoopSpineStage => {
      const stage = stages.find((entry) => entry.id === id);
      if (stage === undefined) throw new Error(`stage ${id} not found`);
      return stage;
    };
    expect(byId("flag").signal).toBe("3 open");
    expect(byId("flag").href).toBe("/wiki");
    expect(byId("correct").signal).toBe("3 open");
    expect(byId("correct").href).toBe("/wiki");
    expect(byId("iterate").signal).toBe("—");
    expect(byId("launch").signal).toBe("run 3");
    expect(byId("rescore").signal).toBe("—");
  });

  it("uses latestRow when the visible journal page is not the final page", () => {
    const latest = {
      ...richOverview().journal.rows[1]!,
      journalRunId: "journal-run-spine-12",
      createdAt: "2026-07-07T12:00:00.000Z",
    };
    const overview = richOverview({
      journal: {
        ...richOverview().journal,
        pagination: {
          total: 12,
          limit: 10,
          offset: 0,
          page: 1,
          pageCount: 2,
          hasMore: true,
          nextOffset: 10,
        },
        latestRow: latest,
      },
    });
    expect(deriveLoopSpine(overview, null).find((stage) => stage.id === "launch")?.signal).toBe(
      "run 13",
    );
  });

  it("selects the last chronological journal row", () => {
    const rows = richOverview().journal.rows;
    expect(latestLoopSpineJournalRow(rows)?.journalRunId).toBe("journal-run-spine-2");
    expect(latestLoopSpineJournalRow([])).toBeNull();
  });
});
