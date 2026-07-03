import { HttpResponse, http } from "msw";
import {
  assertItotoriApiResponse,
  type ItotoriApiResponseBody,
  type ItotoriApiRouteId,
} from "../src/api-schema.js";
import {
  benchmarkReportsFixture,
  costReportFixture,
  dashboardDecisionsFixture,
  dashboardStatusFixture,
  runtimeStatusFixture,
} from "./api-fixtures.js";
import { reviewQueueDashboardFixtures } from "../src/reviewer/index.js";
import type { ReviewerQueueDashboardReadModel } from "../src/reviewer/index.js";

export const itotoriApiMswHandlers = [
  http.get("http://itotori.test/api/projects/status", () =>
    apiJson("projects.status", dashboardStatusFixture),
  ),
  http.get("http://itotori.test/api/projects/decisions", () =>
    apiJson("projects.decisions", dashboardDecisionsFixture),
  ),
  http.get("http://itotori.test/api/reviewer/queue", () =>
    apiJson("reviewer.queue", reviewerQueueDashboardApiFixture()),
  ),
  http.get("http://itotori.test/api/projects/cost", () =>
    apiJson("projects.cost", costReportFixture),
  ),
  http.get("http://itotori.test/api/projects/benchmarks", () =>
    apiJson("projects.benchmarks", { reports: benchmarkReportsFixture }),
  ),
  http.get("http://itotori.test/api/projects", () =>
    apiJson("projects.list", { projects: [dashboardStatusFixture] }),
  ),
  http.get("http://itotori.test/api/hello/status", () =>
    apiJson("runtime.status", runtimeStatusFixture),
  ),
  http.get("http://itotori.test/api/runtime/v0.2/status", () =>
    apiJson("runtime.status", runtimeStatusFixture),
  ),
];

export function apiJson(routeId: ItotoriApiRouteId, body: ItotoriApiResponseBody): HttpResponse {
  assertItotoriApiResponse(routeId, body);
  return HttpResponse.json(body);
}

export function reviewerQueueDashboardApiFixture(): ReviewerQueueDashboardReadModel {
  const fixtures = reviewQueueDashboardFixtures();
  const rows = fixtures.decisions.map((decision) => ({
    reviewItemId: decision.item.reviewItemId,
    projectId: decision.item.projectId,
    localeBranchId: decision.item.localeBranchId,
    sourceRevisionId: decision.item.sourceRevisionId,
    itemKind: decision.item.itemKind,
    sourceItemRef: decision.item.sourceItemRef,
    summary: decision.item.summary,
    priority: decision.item.priority,
    state: decision.item.state,
    dashboardState: decision.dashboardState,
    lastAction: decision.lastAction,
    batchActionId: decision.batchActionId,
    findingId: decision.findingId,
    decisionId: decision.decisionId,
    detailPath: `/reviewer-queue/${encodeURIComponent(decision.item.reviewItemId)}`,
    selectedForBatch: decision.dashboardState === "pending",
    createdAt: decision.item.createdAt,
    updatedAt: decision.item.updatedAt,
    resolvedAt: decision.item.resolvedAt,
  }));
  return {
    schemaVersion: "reviewer.queue_dashboard.v0.1",
    localeBranchId: "019ed065-0000-7000-8000-000000000110",
    generatedAt: new Date("2026-06-26T00:00:00Z"),
    permission: {
      actorUserId: "local-user",
      canReadQueue: true,
      canManageQueue: true,
      denialReasons: [],
    },
    rows,
    aggregate: {
      pending: rows.filter((row) => row.dashboardState === "pending").length,
      resolved: rows.filter((row) => row.dashboardState === "resolved").length,
      deferred: rows.filter((row) => row.dashboardState === "deferred").length,
      escalated: rows.filter((row) => row.dashboardState === "escalated").length,
      batch_applied: rows.filter((row) => row.dashboardState === "batch_applied").length,
    },
    defaultBatchRequest: {
      ...fixtures.batchAppliedPreview.request,
      action: "approve",
      selections: rows
        .filter((row) => row.selectedForBatch)
        .map((row) => ({
          reviewItemId: row.reviewItemId,
          expectedSourceRevisionId: row.sourceRevisionId,
        })),
    },
  };
}
