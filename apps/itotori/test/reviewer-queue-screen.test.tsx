// @vitest-environment jsdom
// fnd-spa-shell — behavior-first test for the categorized reviewer-queue screen.
//
// Mounts the real `App` shell at `/reviewer-queue` over msw-intercepted
// `/api/reviewer/queue` responses and asserts the OBSERVABLE behavior the
// reviewer sees: the queue renders CATEGORIZED items (a category pill per
// `itemKind`, with counts) each carrying a SEVERITY badge (derived from
// `priority`, tone via `statusTone`), the collection is PAGINATED (Next/
// Previous walk the page window), the category filter narrows + resets the
// page, and the empty / error states surface instead of a blank panel.
// [[feedback_behavior_first_code_agnostic_testing]] — no game is named; only
// the rendered categories / severity / rows / pagination interactions are
// asserted, through the typed client, over msw (no ad-hoc fetch).

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import {
  reviewerQueueActionValues,
  reviewerQueueItemKindValues,
  reviewerQueueItemStateValues,
  type ReviewerQueueItemKind,
  type ReviewerQueueItemState,
} from "@itotori/db";
import { App } from "../src/ui/App.js";
import type { ReviewerQueueDashboardReadModel } from "../src/reviewer/index.js";
import type { ReviewerQueueDashboardRow } from "../src/reviewer/index.js";
import { apiJson, authCapabilitiesMswHandler, authIdentityMswHandler } from "./msw-handlers.js";
import { costReportFixture, dashboardStatusFixture } from "./api-fixtures.js";

const LOCALE_BRANCH_ID = "019ed065-0000-7000-8000-000000000110";
const QUEUE_ROUTE = { pathname: "/reviewer-queue", search: `?localeBranchId=${LOCALE_BRANCH_ID}` };

function makeRow(
  index: number,
  overrides: {
    itemKind: ReviewerQueueItemKind;
    priority: number;
    summary: string;
    dashboardState?: ReviewerQueueDashboardRow["dashboardState"];
    state?: ReviewerQueueItemState;
    lastAction?: ReviewerQueueDashboardRow["lastAction"];
  },
): ReviewerQueueDashboardRow {
  const reviewItemId = `review-item-${index}`;
  return {
    reviewItemId,
    projectId: "project-1",
    localeBranchId: LOCALE_BRANCH_ID,
    sourceRevisionId: "source-revision-1",
    itemKind: overrides.itemKind,
    sourceItemRef: `source-ref-${index}`,
    summary: overrides.summary,
    priority: overrides.priority,
    state: overrides.state ?? reviewerQueueItemStateValues.pending,
    dashboardState: overrides.dashboardState ?? "pending",
    lastAction: overrides.lastAction ?? null,
    batchActionId: null,
    findingId: null,
    decisionId: null,
    detailPath: `/reviewer-queue/${reviewItemId}`,
    selectedForBatch: (overrides.dashboardState ?? "pending") === "pending",
    createdAt: new Date("2026-06-26T00:00:00Z"),
    updatedAt: new Date("2026-06-26T00:00:00Z"),
    resolvedAt: null,
  };
}

// Ten rows spanning every category + every severity band (priority 40 →
// blocker, 20 → major, 10 → minor, 0 → info). Ordered so the 8-row page window
// puts the two runtime/feedback rows on page 2.
const QUEUE_ROWS: ReviewerQueueDashboardRow[] = [
  makeRow(0, {
    itemKind: reviewerQueueItemKindValues.qa,
    priority: 40,
    summary: "Blocker QA finding zero",
  }),
  makeRow(1, {
    itemKind: reviewerQueueItemKindValues.qa,
    priority: 20,
    summary: "Major QA finding one",
  }),
  makeRow(2, {
    itemKind: reviewerQueueItemKindValues.qa,
    priority: 10,
    summary: "Minor QA finding two",
  }),
  makeRow(3, {
    itemKind: reviewerQueueItemKindValues.qa,
    priority: 0,
    summary: "Info QA finding three",
  }),
  makeRow(4, {
    itemKind: reviewerQueueItemKindValues.qa,
    priority: 5,
    summary: "Minor QA finding four",
    dashboardState: "resolved",
    state: reviewerQueueItemStateValues.accepted,
    lastAction: reviewerQueueActionValues.approve,
  }),
  makeRow(5, {
    itemKind: reviewerQueueItemKindValues.style,
    priority: 12,
    summary: "Style note five",
  }),
  makeRow(6, {
    itemKind: reviewerQueueItemKindValues.style,
    priority: 3,
    summary: "Style note six",
  }),
  makeRow(7, {
    itemKind: reviewerQueueItemKindValues.glossary,
    priority: 18,
    summary: "Glossary term seven",
  }),
  makeRow(8, {
    itemKind: reviewerQueueItemKindValues.feedback,
    priority: 6,
    summary: "Feedback item eight",
  }),
  makeRow(9, {
    itemKind: reviewerQueueItemKindValues.runtimeEvidence,
    priority: 35,
    summary: "Runtime evidence review nine",
  }),
];

function queueReadModel(
  rows: ReviewerQueueDashboardRow[] = QUEUE_ROWS,
  limit = 100,
  offset = 0,
): ReviewerQueueDashboardReadModel {
  const countState = (state: ReviewerQueueDashboardRow["dashboardState"]): number =>
    rows.filter((row) => row.dashboardState === state).length;
  const pageRows = rows.slice(offset, offset + limit);
  const hasMore = offset + limit < rows.length;
  return {
    schemaVersion: "reviewer.queue_dashboard.v0.1",
    localeBranchId: LOCALE_BRANCH_ID,
    generatedAt: new Date("2026-06-26T00:00:00Z"),
    permission: {
      actorUserId: "local-user",
      canReadQueue: true,
      canManageQueue: true,
      denialReasons: [],
    },
    pagination: {
      total: rows.length,
      limit,
      offset,
      page: Math.floor(offset / limit) + 1,
      pageCount: rows.length === 0 ? 0 : Math.ceil(rows.length / limit),
      hasMore,
      nextOffset: hasMore ? offset + limit : null,
    },
    rows: pageRows,
    aggregate: {
      pending: countState("pending"),
      resolved: countState("resolved"),
      deferred: countState("deferred"),
      escalated: countState("escalated"),
      batch_applied: countState("batch_applied"),
    },
    defaultBatchRequest: {
      action: reviewerQueueActionValues.approve,
      actorUserId: "local-user",
      selections: pageRows
        .filter((row) => row.selectedForBatch)
        .map((row) => ({
          reviewItemId: row.reviewItemId,
          expectedSourceRevisionId: row.sourceRevisionId,
        })),
    },
  };
}

const server = setupServer(
  authCapabilitiesMswHandler,
  authIdentityMswHandler,
  http.get("*/api/reviewer/queue", ({ request }) => {
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit") ?? "100");
    const offset = Number(url.searchParams.get("offset") ?? "0");
    return apiJson("reviewer.queue", queueReadModel(QUEUE_ROWS, limit, offset));
  }),
  http.get("*/api/projects/status", () => apiJson("projects.status", dashboardStatusFixture)),
  http.get("*/api/projects", () =>
    apiJson("projects.list", { projects: [dashboardStatusFixture] }),
  ),
  http.get("*/api/projects/cost", () => apiJson("projects.cost", costReportFixture)),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

describe("SPA shell — categorized reviewer queue", () => {
  it("renders categorized items with severity from reviewer.queue", async () => {
    render(<App location={QUEUE_ROUTE} />);

    // Screen mounts + consumes the typed reviewer.queue read model.
    expect(await screen.findByRole("heading", { name: "Reviewer queue" })).toBeInTheDocument();
    const main = screen.getByRole("main");
    expect(main).toHaveAttribute("data-screen", "reviewer-queue");
    expect(main).toHaveAttribute("data-state", "ready");

    // CATEGORIES: a pill per present itemKind, with counts (5 QA, 2 Style, …).
    expect(await screen.findByRole("tab", { name: /All/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /QA/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Style/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Glossary/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Feedback/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Runtime evidence/ })).toBeInTheDocument();

    // SEVERITY: the priority-40 QA row renders a critical-tone `blocker` badge.
    const list = screen.getByLabelText("Reviewer queue virtualized rows");
    expect(list).toHaveAttribute("data-virtualized", "true");
    const blocker = within(list).getAllByText("blocker")[0]!;
    expect(blocker).toHaveAttribute("data-status", "blocker");
    expect(blocker).toHaveAttribute("data-tone", "critical");
    // …and a lower-priority row renders a neutral-tone `minor` badge.
    expect(within(list).getAllByText("minor")[0]).toHaveAttribute("data-tone", "neutral");

    // Rows render their summary as a link into the detail route.
    const rowLink = within(list).getByRole("link", { name: "Blocker QA finding zero" });
    expect(rowLink).toHaveAttribute("href", "/reviewer-queue/review-item-0");
  });

  it("paginates through server pages and virtualizes the visible page", async () => {
    const rows = Array.from({ length: 130 }, (_, index) =>
      makeRow(index, {
        itemKind: reviewerQueueItemKindValues.qa,
        priority: index === 105 ? 35 : 5,
        summary: index === 105 ? "Server page two blocker" : `Paged QA item ${index}`,
      }),
    );
    server.use(
      http.get("*/api/reviewer/queue", ({ request }) => {
        const url = new URL(request.url);
        const limit = Number(url.searchParams.get("limit") ?? "100");
        const offset = Number(url.searchParams.get("offset") ?? "0");
        return apiJson("reviewer.queue", queueReadModel(rows, limit, offset));
      }),
    );
    render(<App location={QUEUE_ROUTE} />);

    const body = await screen.findByLabelText("Reviewer queue");
    expect(body).toHaveAttribute("data-page", "1");
    expect(body).toHaveAttribute("data-page-count", "2");
    const list = await screen.findByLabelText("Reviewer queue virtualized rows");
    expect(list).toHaveAttribute("data-total-items", "100");
    expect(Number(list.getAttribute("data-rendered-items"))).toBeLessThan(100);

    expect(screen.getByText("Paged QA item 0")).toBeInTheDocument();
    expect(screen.queryByText("Server page two blocker")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));

    expect(await screen.findByText("Server page two blocker")).toBeInTheDocument();
    expect(screen.queryByText("Paged QA item 0")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Reviewer queue")).toHaveAttribute("data-page", "2");

    fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    expect(await screen.findByText("Paged QA item 0")).toBeInTheDocument();
    expect(screen.getByLabelText("Reviewer queue")).toHaveAttribute("data-page", "1");
  });

  it("filters by category within the current server page", async () => {
    render(<App location={QUEUE_ROUTE} />);

    fireEvent.click(await screen.findByRole("tab", { name: /Style/ }));

    const body = screen.getByLabelText("Reviewer queue");
    expect(body).toHaveAttribute("data-active-category", reviewerQueueItemKindValues.style);
    expect(body).toHaveAttribute("data-page", "1");

    const list = screen.getByLabelText("Reviewer queue virtualized rows");
    expect(within(list).getByText("Style note five")).toBeInTheDocument();
    // A QA-only row is filtered out.
    expect(within(list).queryByText("Blocker QA finding zero")).not.toBeInTheDocument();
  });

  it("scopes to the project's selected locale branch when no query is given", async () => {
    render(<App location={{ pathname: "/reviewer-queue", search: "" }} />);
    // projects.status supplies the branch; the queue then loads for it.
    expect(await screen.findByText("Blocker QA finding zero")).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveAttribute(
      "data-locale-branch-id",
      dashboardStatusFixture.selectedLocaleBranchId as string,
    );
  });

  it("surfaces the empty state when the queue returns no rows", async () => {
    server.use(
      http.get("*/api/reviewer/queue", () => apiJson("reviewer.queue", queueReadModel([]))),
    );
    render(<App location={QUEUE_ROUTE} />);
    expect(
      await screen.findByText("No reviewer queue items were returned by the API."),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Reviewer queue virtualized rows")).not.toBeInTheDocument();
  });

  it("surfaces a typed error state instead of a blank panel", async () => {
    server.use(
      http.get("*/api/reviewer/queue", () =>
        HttpResponse.json(
          { code: "forbidden", error: "not permitted to read queue" },
          { status: 403 },
        ),
      ),
    );
    render(<App location={QUEUE_ROUTE} />);
    expect(await screen.findByText("not permitted to read queue")).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveAttribute("data-state", "error");
  });
});
