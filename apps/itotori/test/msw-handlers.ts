import { HttpResponse, http } from "msw";
import {
  ApiValidationError,
  assertItotoriApiResponse,
  assertItotoriApiErrorResponse,
  parseDraftBranchRequest,
  parseProjectImportRequest,
  parseRecordBenchmarkRequest,
  parseRecordFindingRequest,
  parseRuntimeEvidenceRequest,
  type ApiErrorResponse,
  type ItotoriApiResponseBody,
  type ItotoriApiRouteId,
} from "../src/api-schema.js";
import {
  apiMutationBadRequestResponseFixture,
  apiMutationForbiddenResponseFixture,
  authIdentityFixture,
  benchmarkReportsFixture,
  bridgeImportRequestFixture,
  bridgeImportResponseFixture,
  catalogOpportunitiesFixture,
  costDrilldownFixture,
  costReportFixture,
  dashboardDecisionsFixture,
  dashboardStatusFixture,
  jobsRunTableFixture,
  portfolioProjectsFixture,
  projectOverviewFixture,
  draftBranchRequestFixture,
  draftBranchResponseFixture,
  recordBenchmarkRequestFixture,
  recordBenchmarkResponseFixture,
  recordFindingRequestFixture,
  recordFindingResponseFixture,
  runtimeEvidenceIngestRequestFixture,
  runtimeEvidenceIngestResponseFixture,
  runtimeStatusFixture,
} from "./api-fixtures.js";

/**
 * ITOTORI-051 — the SUCCESS handlers for the project mutation routes.
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
  http.post("http://itotori.test/api/projects/project-1/branches", async ({ request }) => {
    const body = await readJsonBody(request);
    parseDraftBranchRequest(body);
    return apiJson("branches.draft", draftBranchResponseFixture);
  }),
  http.post("http://itotori.test/api/projects/project-1/findings", async ({ request }) => {
    const body = await readJsonBody(request);
    parseRecordFindingRequest(body);
    return apiJson("findings.record", recordFindingResponseFixture);
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
 * ITOTORI-051 — typed VALIDATION FAILURE handlers for the project
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
  http.post("http://itotori.test/api/projects/project-1/branches", async () => {
    parseDraftBranchRequest(draftBranchRequestFixture);
    return apiErrorJson(apiMutationBadRequestResponseFixture, 400);
  }),
  http.post("http://itotori.test/api/projects/project-1/findings", async () => {
    parseRecordFindingRequest(recordFindingRequestFixture);
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
 * the project mutation routes. Each returns the shared `forbidden` error
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
  http.post("http://itotori.test/api/projects/project-1/branches", async () =>
    apiErrorJson(apiMutationForbiddenResponseFixture, 403),
  ),
  http.post("http://itotori.test/api/projects/project-1/findings", async () =>
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
  http.get("http://itotori.test/api/auth/identity", () =>
    apiJson("auth.identity", authIdentityFixture),
  ),
  http.get("http://itotori.test/api/projects/status", () =>
    apiJson("projects.status", dashboardStatusFixture),
  ),
  http.get("http://itotori.test/api/projects/overview", () =>
    apiJson("projects.overview", projectOverviewFixture),
  ),
  http.get("http://itotori.test/api/projects/decisions", () =>
    apiJson("projects.decisions", dashboardDecisionsFixture),
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
  http.get("http://itotori.test/api/catalog/opportunities", () =>
    apiJson("catalog.opportunities", catalogOpportunitiesFixture),
  ),
  http.get("http://itotori.test/api/jobs/run-table", () =>
    apiJson("jobs.runTable", jobsRunTableFixture),
  ),
  http.get("http://itotori.test/api/projects", () =>
    apiJson("projects.list", portfolioProjectsFixture),
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

/**
 * fnd-caps-context — fully-granted local-user Studio capability view. Used by
 * SPA shell tests so the CapsProvider's GET `/api/auth/capabilities` settles
 * without a real auth backend.
 */
export const authCapabilitiesGrantedFixture = {
  schemaVersion: "itotori.auth.capabilities.v0" as const,
  actorUserId: "local-user",
  canFlag: true,
  canSteer: true,
  canReveal: true,
  denials: {
    flag: null,
    steer: null,
    reveal: null,
  },
  denialReasons: [] as string[],
};

/** MSW handler for GET `/api/auth/capabilities` (host-agnostic). */
export const authCapabilitiesMswHandler = http.get("*/api/auth/capabilities", () =>
  apiJson("auth.capabilities", authCapabilitiesGrantedFixture),
);

/** MSW handler for GET `/api/auth/identity` (host-agnostic). */
export const authIdentityMswHandler = http.get("*/api/auth/identity", () =>
  apiJson("auth.identity", authIdentityFixture),
);

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
