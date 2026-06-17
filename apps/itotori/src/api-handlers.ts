import {
  AuthorizationError,
  permissionValues,
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

export type ApiJsonResponse = {
  statusCode: number;
  body: ItotoriApiResponseBody;
};

export type ItotoriApiRequest = {
  method: string;
  pathname: string;
  body?: unknown;
};

export type ItotoriApiServices = {
  authorization: Pick<ItotoriAuthorizationPort, "requirePermission">;
  projectWorkflow: Pick<
    ItotoriProjectWorkflowPort,
    | "getDashboardStatus"
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

  if (request.method === "GET" && request.pathname === "/api/projects/cost") {
    return ok("projects.cost", await services.projectWorkflow.getCostReport());
  }

  if (
    request.method === "GET" &&
    (request.pathname === "/api/hello/status" || request.pathname === "/api/runtime/v0.2/status")
  ) {
    return ok("runtime.status", await services.projectWorkflow.getRuntimeStatus());
  }

  if (
    request.pathname === "/api/projects/status" ||
    request.pathname === "/api/projects/cost" ||
    request.pathname === "/api/hello/status"
  ) {
    return methodNotAllowed(["GET"]);
  }

  if (request.method === "POST" && request.pathname === "/api/imports/bridge") {
    const body = parseProjectImportRequest(request.body);
    await requireApiPermission(services, permissionValues.projectImport);
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
      await requireApiPermission(services, permissionValues.draftWrite);
      const project = await services.projectWorkflow.draftProject(body.project, body.targetLocale);
      const status = await services.projectWorkflow.getDashboardStatus();
      return ok("branches.draft", { project, status });
    }
    case "findings": {
      const body = parseRecordFindingRequest(request.body);
      await requireApiPermission(services, permissionValues.runtimeIngest);
      const result = await services.projectWorkflow.recordFinding(projectRoute.projectId, body);
      return ok("findings.record", result);
    }
    case "decisions": {
      const body = parseRecordDecisionRequest(request.body);
      await requireApiPermission(services, permissionValues.runtimeIngest);
      const result = await services.projectWorkflow.recordDecision(projectRoute.projectId, body);
      return ok("decisions.record", result);
    }
    case "benchmarks": {
      const body = parseRecordBenchmarkRequest(request.body);
      await requireApiPermission(services, permissionValues.runtimeIngest);
      const result = await services.projectWorkflow.recordBenchmarkReport(
        projectRoute.projectId,
        body,
      );
      return ok("benchmarks.record", result);
    }
    case "runtime-evidence": {
      const body = parseRuntimeEvidenceRequest(request.body);
      assertPathProject(projectRoute.projectId, body.project.projectId);
      await requireApiPermission(services, permissionValues.runtimeIngest);
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
  permission: Permission,
): Promise<void> {
  await services.authorization.requirePermission(permission);
}

function ok(routeId: "projects.list", body: ApiProjectsResponse): ApiJsonResponse;
function ok(routeId: "projects.status", body: ProjectDashboardStatus): ApiJsonResponse;
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
