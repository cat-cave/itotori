import {
  AuthorizationError,
  catalogCandidateMatchStatusValues,
  catalogConflictStatusValues,
  catalogSourceValues,
  permissionValues,
  type CatalogConflictReviewFilter,
  type CatalogConflictReviewReadModel,
  type CatalogConflictReviewSeverity,
  type CatalogConflictReviewStatus,
  type CatalogSource,
  type DashboardDecisionReadModel,
  type Permission,
  type ProjectCostReport,
  type ProjectDashboardStatus,
  type RuntimeDashboardStatus,
} from "@itotori/db";
import type { ItotoriAuthorizationPort } from "./auth.js";
import {
  ApiValidationError,
  assertItotoriApiResponse,
  parseDraftBranchRequest,
  parseProjectImportRequest,
  parseRecordBenchmarkRequest,
  parseRecordDecisionRequest,
  parseRecordFindingRequest,
  parseRuntimeEvidenceRequest,
  type ApiDraftBranchResponse,
  type ApiErrorResponse,
  type ApiProjectImportResponse,
  type ApiProjectsResponse,
  type ItotoriApiResponseBody,
  type ItotoriApiRouteId,
} from "./api-schema.js";
import type {
  BenchmarkRecordResult,
  DecisionRecordResult,
  FindingRecordResult,
  ItotoriProjectWorkflowPort,
  RuntimeIngestResult,
} from "./services/project-workflow.js";

export type ApiMutationPermissionGate = {
  mutation: string;
  permissionKey: keyof typeof permissionValues;
  permission: Permission;
};

export const apiMutationPermissionGates = {
  bridgeImport: apiMutationGate("bridge import", "projectImport"),
  branchDraft: apiMutationGate("branch draft", "draftWrite"),
  findingRecord: apiMutationGate("finding record", "runtimeIngest"),
  decisionRecord: apiMutationGate("decision record", "runtimeIngest"),
  benchmarkRecord: apiMutationGate("benchmark record", "runtimeIngest"),
  runtimeEvidenceIngest: apiMutationGate("runtime evidence ingest", "runtimeIngest"),
} as const;

export type ApiJsonResponse = {
  statusCode: number;
  body: ItotoriApiResponseBody;
};

export type ItotoriApiRequest = {
  method: string;
  pathname: string;
  search?: string;
  body?: unknown;
};

export type ItotoriApiServices = {
  authorization: Pick<ItotoriAuthorizationPort, "requirePermission">;
  catalogRepository: {
    catalogConflictReview(
      filter?: CatalogConflictReviewFilter,
    ): Promise<CatalogConflictReviewReadModel>;
  };
  projectWorkflow: Pick<
    ItotoriProjectWorkflowPort,
    | "getDashboardStatus"
    | "getDashboardDecisions"
    | "getRuntimeStatus"
    | "getCostReport"
    | "importBridge"
    | "draftProject"
    | "recordFinding"
    | "recordDecision"
    | "recordBenchmarkReport"
    | "ingestRuntimeReport"
  >;
};

export function isItotoriApiPath(pathname: string): boolean {
  return pathname.startsWith("/api/");
}

export async function handleItotoriApiRequest(
  request: ItotoriApiRequest,
  services: ItotoriApiServices,
): Promise<ApiJsonResponse> {
  try {
    return await routeItotoriApiRequest(request, services);
  } catch (error) {
    return errorResponse(error);
  }
}

async function routeItotoriApiRequest(
  request: ItotoriApiRequest,
  services: ItotoriApiServices,
): Promise<ApiJsonResponse> {
  if (request.method === "GET" && request.pathname === "/api/projects") {
    const status = await services.projectWorkflow.getDashboardStatus();
    return ok("projects.list", { projects: [status] });
  }

  if (request.method === "GET" && request.pathname === "/api/projects/status") {
    return ok("projects.status", await services.projectWorkflow.getDashboardStatus());
  }

  if (request.method === "GET" && request.pathname === "/api/projects/decisions") {
    return ok("projects.decisions", await services.projectWorkflow.getDashboardDecisions());
  }

  if (request.method === "GET" && request.pathname === "/api/projects/cost") {
    return ok("projects.cost", await services.projectWorkflow.getCostReport());
  }

  if (
    request.method === "GET" &&
    (request.pathname === "/api/hello/status" || request.pathname === "/api/runtime/v0.2/status")
  ) {
    return ok("runtime.status", await services.projectWorkflow.getRuntimeStatus());
  }

  if (request.method === "GET" && request.pathname === "/api/catalog/conflicts") {
    return ok(
      "catalog.conflicts",
      await services.catalogRepository.catalogConflictReview(
        parseCatalogConflictReviewFilter(request.search),
      ),
    );
  }

  if (
    request.pathname === "/api/projects/status" ||
    request.pathname === "/api/projects/decisions" ||
    request.pathname === "/api/projects/cost" ||
    request.pathname === "/api/hello/status" ||
    request.pathname === "/api/catalog/conflicts"
  ) {
    return methodNotAllowed(["GET"]);
  }

  if (request.method === "POST" && request.pathname === "/api/imports/bridge") {
    const body = parseProjectImportRequest(request.body);
    await requireApiPermission(services, apiMutationPermissionGates.bridgeImport);
    const project = await services.projectWorkflow.importBridge(body.bridge);
    const status = await services.projectWorkflow.getDashboardStatus();
    return ok("imports.bridge", { project, status });
  }

  const projectRoute = parseProjectRoute(request.pathname);
  if (!projectRoute) {
    return notFound(request.pathname);
  }

  if (request.method !== "POST") {
    return methodNotAllowed(["POST"]);
  }

  switch (projectRoute.resource) {
    case "branches": {
      const body = parseDraftBranchRequest(request.body);
      assertPathProject(projectRoute.projectId, body.project.projectId);
      await requireApiPermission(services, apiMutationPermissionGates.branchDraft);
      const project = await services.projectWorkflow.draftProject(body.project, body.targetLocale);
      const status = await services.projectWorkflow.getDashboardStatus();
      return ok("branches.draft", { project, status });
    }
    case "findings": {
      const body = parseRecordFindingRequest(request.body);
      await requireApiPermission(services, apiMutationPermissionGates.findingRecord);
      const result = await services.projectWorkflow.recordFinding(projectRoute.projectId, body);
      return ok("findings.record", result);
    }
    case "decisions": {
      const body = parseRecordDecisionRequest(request.body);
      await requireApiPermission(services, apiMutationPermissionGates.decisionRecord);
      const result = await services.projectWorkflow.recordDecision(projectRoute.projectId, body);
      return ok("decisions.record", result);
    }
    case "benchmarks": {
      const body = parseRecordBenchmarkRequest(request.body);
      await requireApiPermission(services, apiMutationPermissionGates.benchmarkRecord);
      const result = await services.projectWorkflow.recordBenchmarkReport(
        projectRoute.projectId,
        body,
      );
      return ok("benchmarks.record", result);
    }
    case "runtime-evidence": {
      const body = parseRuntimeEvidenceRequest(request.body);
      assertPathProject(projectRoute.projectId, body.project.projectId);
      await requireApiPermission(services, apiMutationPermissionGates.runtimeEvidenceIngest);
      const result = await services.projectWorkflow.ingestRuntimeReport(
        body.project,
        body.runtimeReport,
      );
      return ok("runtimeEvidence.ingest", result.result);
    }
  }
}

async function requireApiPermission(
  services: ItotoriApiServices,
  gate: ApiMutationPermissionGate,
): Promise<void> {
  await services.authorization.requirePermission(gate.permission);
}

function parseCatalogConflictReviewFilter(search = ""): CatalogConflictReviewFilter {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const filter: CatalogConflictReviewFilter = {};
  const source = params.get("source");
  if (source !== null) {
    filter.source = enumParam(
      source,
      Object.values(catalogSourceValues) as CatalogSource[],
      "source",
    );
  }
  const severity = params.get("severity");
  if (severity !== null) {
    filter.severity = enumParam(
      severity,
      ["error", "warning", "info"] as CatalogConflictReviewSeverity[],
      "severity",
    );
  }
  const status = params.get("status");
  if (status !== null) {
    filter.status = enumParam(
      status,
      [
        ...Object.values(catalogConflictStatusValues),
        ...Object.values(catalogCandidateMatchStatusValues),
      ] as CatalogConflictReviewStatus[],
      "status",
    );
  }
  const catalogRecordId = params.get("catalogRecordId");
  if (catalogRecordId !== null) {
    if (catalogRecordId.trim().length === 0) {
      throw new ApiValidationError("catalogRecordId must be non-empty");
    }
    filter.catalogRecordId = catalogRecordId;
  }
  return filter;
}

function enumParam<T extends string>(value: string, allowed: readonly T[], label: string): T {
  if (!allowed.includes(value as T)) {
    throw new ApiValidationError(`${label} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function apiMutationGate(
  mutation: string,
  permissionKey: keyof typeof permissionValues,
): ApiMutationPermissionGate {
  return {
    mutation,
    permissionKey,
    permission: permissionValues[permissionKey],
  };
}

function ok(routeId: "projects.list", body: ApiProjectsResponse): ApiJsonResponse;
function ok(routeId: "catalog.conflicts", body: CatalogConflictReviewReadModel): ApiJsonResponse;
function ok(routeId: "projects.status", body: ProjectDashboardStatus): ApiJsonResponse;
function ok(routeId: "projects.decisions", body: DashboardDecisionReadModel): ApiJsonResponse;
function ok(routeId: "projects.cost", body: ProjectCostReport): ApiJsonResponse;
function ok(routeId: "runtime.status", body: RuntimeDashboardStatus): ApiJsonResponse;
function ok(routeId: "imports.bridge", body: ApiProjectImportResponse): ApiJsonResponse;
function ok(routeId: "branches.draft", body: ApiDraftBranchResponse): ApiJsonResponse;
function ok(routeId: "findings.record", body: FindingRecordResult): ApiJsonResponse;
function ok(routeId: "decisions.record", body: DecisionRecordResult): ApiJsonResponse;
function ok(routeId: "benchmarks.record", body: BenchmarkRecordResult): ApiJsonResponse;
function ok(routeId: "runtimeEvidence.ingest", body: RuntimeIngestResult): ApiJsonResponse;
function ok(routeId: ItotoriApiRouteId, body: ItotoriApiResponseBody): ApiJsonResponse {
  assertItotoriApiResponse(routeId, body);
  return { statusCode: 200, body };
}

function notFound(pathname: string): ApiJsonResponse {
  return errorBody(404, "not_found", `unknown API route: ${pathname}`);
}

function methodNotAllowed(allowedMethods: string[]): ApiJsonResponse {
  return errorBody(405, "method_not_allowed", `method must be ${allowedMethods.join(" or ")}`);
}

function errorResponse(error: unknown): ApiJsonResponse {
  if (error instanceof ApiValidationError || error instanceof SyntaxError) {
    return errorBody(400, "bad_request", error.message);
  }
  if (error instanceof AuthorizationError) {
    return errorBody(403, "forbidden", error.message);
  }
  return errorBody(500, "internal_error", error instanceof Error ? error.message : String(error));
}

function errorBody(
  statusCode: number,
  code: ApiErrorResponse["code"],
  error: string,
): ApiJsonResponse {
  return { statusCode, body: { error, code } };
}

function parseProjectRoute(pathname: string): {
  projectId: string;
  resource: "branches" | "findings" | "decisions" | "benchmarks" | "runtime-evidence";
} | null {
  const match = /^\/api\/projects\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (!match) {
    return null;
  }
  const projectId = match[1];
  const resource = match[2];
  if (projectId === undefined || resource === undefined) {
    return null;
  }
  if (
    resource !== "branches" &&
    resource !== "findings" &&
    resource !== "decisions" &&
    resource !== "benchmarks" &&
    resource !== "runtime-evidence"
  ) {
    return null;
  }
  return { projectId: decodeURIComponent(projectId), resource };
}

function assertPathProject(pathProjectId: string, bodyProjectId: string): void {
  if (pathProjectId !== bodyProjectId) {
    throw new ApiValidationError(
      `path project ${pathProjectId} does not match body project ${bodyProjectId}`,
    );
  }
}
