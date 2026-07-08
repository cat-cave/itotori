import { HttpResponse, http } from "msw";
import {
  ApiValidationError,
  assertItotoriApiResponse,
  assertItotoriApiErrorResponse,
  parseProjectImportRequest,
  parseRecordBenchmarkRequest,
  parseRecordDecisionRequest,
  parseRecordFindingRequest,
  parseRuntimeEvidenceRequest,
  type ApiErrorResponse,
  type ItotoriApiResponseBody,
  type ItotoriApiRouteId,
} from "../src/api-schema.js";
import {
  apiMutationBadRequestResponseFixture,
  apiMutationForbiddenResponseFixture,
  benchmarkReportsFixture,
  bridgeImportRequestFixture,
  bridgeImportResponseFixture,
  costDrilldownFixture,
  costReportFixture,
  dashboardDecisionsFixture,
  dashboardStatusFixture,
  jobsRunTableFixture,
  projectOverviewFixture,
  recordBenchmarkRequestFixture,
  recordBenchmarkResponseFixture,
  recordDecisionRequestFixture,
  recordDecisionResponseFixture,
  recordFindingRequestFixture,
  recordFindingResponseFixture,
  runtimeEvidenceIngestRequestFixture,
  runtimeEvidenceIngestResponseFixture,
  runtimeStatusFixture,
} from "./api-fixtures.js";
import { reviewQueueDashboardFixtures } from "../src/reviewer/index.js";
import type { ReviewerQueueDashboardReadModel } from "../src/reviewer/index.js";

/**
 * ITOTORI-051 — the SUCCESS handlers for the five project mutation routes.
 * Defined before {@link itotoriApiMswHandlers} so the dashboard MSW server
 * can spread them in without a temporal-dead-zone reference. Exported on its
 * own so a contract test can register JUST the mutation surface (or swap in
 * failure / denial variants via {@link
 * itotoriProjectMutationValidationFailureMswHandlers} / {@link
 * itotoriProjectMutationPermissionDeniedMswHandlers}).
 *
 * Each handler validates the incoming request body via the SAME api-schema
 * parser the real `handleItotoriApiRequest` uses, and returns a response
 * body checked via `apiJson(...)` so a request OR response shape change
 * fails a contract test (`msw-mutation-handlers.test.ts`) instead of
 * silently diverging.
 */
export const itotoriProjectMutationMswHandlers = [
  http.post("http://itotori.test/api/imports/bridge", async ({ request }) => {
    const body = await readJsonBody(request);
    parseProjectImportRequest(body);
    return apiJson("imports.bridge", bridgeImportResponseFixture);
  }),
  http.post("http://itotori.test/api/projects/project-1/findings", async ({ request }) => {
    const body = await readJsonBody(request);
    parseRecordFindingRequest(body);
    return apiJson("findings.record", recordFindingResponseFixture);
  }),
  http.post("http://itotori.test/api/projects/project-1/decisions", async ({ request }) => {
    const body = await readJsonBody(request);
    parseRecordDecisionRequest(body);
    return apiJson("decisions.record", recordDecisionResponseFixture);
  }),
  http.post("http://itotori.test/api/projects/project-1/benchmarks", async ({ request }) => {
    const body = await readJsonBody(request);
    parseRecordBenchmarkRequest(body);
    return apiJson("benchmarks.record", recordBenchmarkResponseFixture);
  }),
  http.post("http://itotori.test/api/projects/project-1/runtime-evidence", async ({ request }) => {
    const body = await readJsonBody(request);
    parseRuntimeEvidenceRequest(body);
    return apiJson("runtimeEvidence.ingest", runtimeEvidenceIngestResponseFixture);
  }),
];

/**
 * ITOTORI-051 — typed VALIDATION FAILURE handlers for the five project
 * mutation routes. Each one feeds the SUCCESS request fixture to the parser
 * (proving the fixture parses cleanly) and then returns the shared
 * `bad_request` error response shape every mutation emits when the parser
 * rejects a malformed body. Used by the contract-drift tests to assert a
 * request-shape drift surfaces as a typed 400 rather than a silent 200.
 */
export const itotoriProjectMutationValidationFailureMswHandlers = [
  http.post("http://itotori.test/api/imports/bridge", async () => {
    parseProjectImportRequest(bridgeImportRequestFixture);
    return apiErrorJson(apiMutationBadRequestResponseFixture, 400);
  }),
  http.post("http://itotori.test/api/projects/project-1/findings", async () => {
    parseRecordFindingRequest(recordFindingRequestFixture);
    return apiErrorJson(apiMutationBadRequestResponseFixture, 400);
  }),
  http.post("http://itotori.test/api/projects/project-1/decisions", async () => {
    parseRecordDecisionRequest(recordDecisionRequestFixture);
    return apiErrorJson(apiMutationBadRequestResponseFixture, 400);
  }),
  http.post("http://itotori.test/api/projects/project-1/benchmarks", async () => {
    parseRecordBenchmarkRequest(recordBenchmarkRequestFixture);
    return apiErrorJson(apiMutationBadRequestResponseFixture, 400);
  }),
  http.post("http://itotori.test/api/projects/project-1/runtime-evidence", async () => {
    parseRuntimeEvidenceRequest(runtimeEvidenceIngestRequestFixture);
    return apiErrorJson(apiMutationBadRequestResponseFixture, 400);
  }),
];

/**
 * ITOTORI-050 / ITOTORI-051 — typed PERMISSION / SCOPING DENIAL handlers for
 * the five project mutation routes. Each returns the shared `forbidden` error
 * response shape every mutation emits when either the permission gate
 * (`AuthorizationError`) or the server-side project/branch ownership scope
 * check (`ProjectMutationScopeError`) refuses the write. Used by the
 * contract-drift tests to assert a denied mutation surfaces as a typed 403
 * rather than a silent 200.
 */
export const itotoriProjectMutationPermissionDeniedMswHandlers = [
  http.post("http://itotori.test/api/imports/bridge", async () =>
    apiErrorJson(apiMutationForbiddenResponseFixture, 403),
  ),
  http.post("http://itotori.test/api/projects/project-1/findings", async () =>
    apiErrorJson(apiMutationForbiddenResponseFixture, 403),
  ),
  http.post("http://itotori.test/api/projects/project-1/decisions", async () =>
    apiErrorJson(apiMutationForbiddenResponseFixture, 403),
  ),
  http.post("http://itotori.test/api/projects/project-1/benchmarks", async () =>
    apiErrorJson(apiMutationForbiddenResponseFixture, 403),
  ),
  http.post("http://itotori.test/api/projects/project-1/runtime-evidence", async () =>
    apiErrorJson(apiMutationForbiddenResponseFixture, 403),
  ),
];

export const itotoriApiMswHandlers = [
  http.get("http://itotori.test/api/projects/status", () =>
    apiJson("projects.status", dashboardStatusFixture),
  ),
  http.get("http://itotori.test/api/projects/overview", () =>
    apiJson("projects.overview", projectOverviewFixture),
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
  http.get("http://itotori.test/api/projects/cost/drilldown", () =>
    apiJson("projects.costDrilldown", costDrilldownFixture),
  ),
  http.get("http://itotori.test/api/projects/benchmarks", () =>
    apiJson("projects.benchmarks", { reports: benchmarkReportsFixture }),
  ),
  http.get("http://itotori.test/api/jobs/run-table", () =>
    apiJson("jobs.runTable", jobsRunTableFixture),
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
  // ITOTORI-051 — project MUTATION routes. The dashboard / SPA mutation
  // layer POSTs to these endpoints (form submits + fetch wrappers). Read
  // handlers above stay UNCHANGED; the mutation surface is appended so the
  // dashboard MSW server picks up the contract handlers automatically.
  ...itotoriProjectMutationMswHandlers,
];

export function apiJson(routeId: ItotoriApiRouteId, body: ItotoriApiResponseBody): HttpResponse {
  assertItotoriApiResponse(routeId, body);
  return HttpResponse.json(body);
}

/**
 * ITOTORI-051 — wrap a typed {@link ApiErrorResponse} in an HTTP response at
 * the given status. The body shape is asserted via
 * {@link assertItotoriApiErrorResponse} so a typed error-shape change (a
 * renamed `code` enum value, a missing `error` string, an extra leaked
 * field) fails the contract test instead of silently diverging.
 */
export function apiErrorJson(body: ApiErrorResponse, status: number): HttpResponse {
  assertItotoriApiErrorResponse(body);
  return HttpResponse.json(body, { status });
}

async function readJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length === 0) {
    throw new ApiValidationError("request body must not be empty");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ApiValidationError(`request body must be valid JSON: ${message}`);
  }
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
