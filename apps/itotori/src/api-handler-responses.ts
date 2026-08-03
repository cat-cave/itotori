import * as contracts from "./api-handler-contracts.js";
import * as deps from "./api-handler-dependencies.js";
import { translationScopeValues } from "./api-enum-values.js";
import { ContextScopeValueSchema, RunModeValueSchema } from "./contracts/index.js";
import { explicitFailureApiResponse } from "./explicit-failure/api-response.js";
import { LocalizationPassControlError } from "./services/localization-pass-control.js";

export function ok(
  routeId: "projects.list",
  body: deps.ApiProjectsResponse,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "assetDecisions.active",
  body: deps.ApiAssetDecisionsResponse,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "assetDecisions.candidates",
  body: deps.ApiCandidateAssetsResponse,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "catalog.conflicts",
  body: deps.CatalogConflictReviewReadModel,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "catalog.completeness",
  body: deps.CatalogCompletenessBenchmarkPools,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "catalog.benchmarkSeeds",
  body: deps.CatalogBenchmarkSeedFinderReadModel,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "catalog.contextPanel",
  body: deps.ApiCatalogContextPanelResponse,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "catalog.opportunities",
  body: deps.CatalogOpportunityRankingReadModel,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "terminology.search",
  body: deps.TerminologySearchReadModel,
): contracts.ApiJsonResponse;
export function ok(routeId: "wiki.list", body: deps.ApiWikiListResponse): contracts.ApiJsonResponse;
export function ok(routeId: "wiki.show", body: deps.ApiWikiShowResponse): contracts.ApiJsonResponse;
export function ok(
  routeId: "wiki.history",
  body: deps.ApiWikiHistoryResponse,
): contracts.ApiJsonResponse;
export function ok(routeId: "wiki.edit", body: deps.ApiWikiEditResponse): contracts.ApiJsonResponse;
export function ok(
  routeId: "wiki.feedback",
  body: deps.ApiWikiFeedbackResponse,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "wiki.apply",
  body: deps.ApiWikiApplyResponse,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "projects.status",
  body: deps.ProjectDashboardStatus,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "projects.overview",
  body: deps.ApiProjectOverviewResponse,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "projects.decisions",
  body: deps.DashboardDecisionReadModel,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "projects.cost",
  body: deps.ProjectCostReport,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "projects.costDrilldown",
  body: deps.CostDrilldownPage,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "projects.benchmarks",
  body: deps.ApiBenchmarkReportsResponse,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "jobs.runTable",
  body: deps.ApiJobsRunTableResponse,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "queue.health",
  body: deps.ApiQueueHealthResponse,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "runtime.status",
  body: deps.RuntimeDashboardStatus,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "projects.decodeExtract",
  body: deps.ApiProjectDecodeExtractResponse,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "imports.bridge",
  body: deps.ApiProjectImportResponse,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "branches.draft",
  body: deps.ApiDraftBranchResponse,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "findings.record",
  body: deps.FindingRecordResult,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "benchmarks.record",
  body: deps.BenchmarkRecordResult,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "runtimeEvidence.ingest",
  body: deps.RuntimeIngestResult,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "settings.modelRouting.get",
  body: deps.ApiModelRoutingSettingsResponse,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "settings.modelRouting.save",
  body: deps.ApiModelRoutingSettingsResponse,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "settings.branchPolicy.get",
  body: deps.ApiBranchPolicySettingsResponse,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "settings.branchPolicy.save",
  body: deps.ApiBranchPolicySettingsResponse,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "settings.translationScope.get",
  body: deps.ApiTranslationScopeSettingsResponse,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "settings.translationScope.save",
  body: deps.ApiTranslationScopeSettingsResponse,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "settings.localizationRunConfig.save",
  body: deps.ApiLocalizationRunConfigResponse,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "auth.ssoSettings.configure",
  body: deps.ApiConfigureAuthSsoSettingsResponse,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "auth.members.list",
  body: deps.ApiMembersListResponse,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "auth.billing.seatUsage",
  body: deps.ApiAuthBillingSeatUsageResponse,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "auth.members.invite",
  body: deps.ApiMemberInvitationResponse,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "auth.members.accept",
  body: deps.ApiMemberResponse,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "auth.members.remove",
  body: deps.ApiRemoveMemberResponse,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "auth.permissionSets.list",
  body: deps.ApiPermissionSetsListResponse,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "auth.permissionSets.grant",
  body: deps.ApiPrincipalPermissionSetGrantResponse,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "auth.permissionSets.revoke",
  body: deps.ApiPrincipalPermissionSetGrantResponse,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "auth.sessions.list",
  body: deps.ApiAuthSessionsListResponse,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "auth.sessions.revoke",
  body: deps.ApiRevokeAuthSessionResponse,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "auth.identity",
  body: deps.ApiAuthIdentityResponse,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "auth.capabilities",
  body: deps.ApiAuthCapabilitiesResponse,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "projects.launchPass",
  body: deps.ApiLaunchPassResponse,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "projects.pausePass" | "projects.resumePass",
  body: deps.ApiLocalizationPassControlResponse,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "play.routeMap",
  body: deps.ApiPlayRouteMapResponse,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "play.flagAnnotation",
  body: deps.ApiPlayFlagAnnotationResponse,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "play.unitFeedback",
  body: deps.ApiPlayUnitFeedbackResponse,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "play.addressableUnit",
  body: deps.ApiPlayAddressableUnitResponse,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "play.targetEdit",
  body: deps.ApiPlayTargetEditResponse,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "play.delivery",
  body: deps.ApiPlayDeliveryResponse,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "patchIteration.versions",
  body: deps.ApiPatchIterationVersionsResponse,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "patchIteration.surface",
  body: deps.ApiPatchIterationSurfaceResponse,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "patchIteration.delivery",
  body: deps.ApiPatchIterationDeliveryResponse,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "patchIteration.play",
  body: deps.ApiPatchIterationPlayResponse,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "patchIteration.feedbackBatch",
  body: deps.ApiPatchIterationFeedbackBatchResponse,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "patchIteration.feedback",
  body: deps.ApiPatchIterationFeedbackResponse,
): contracts.ApiJsonResponse;
export function ok(
  routeId: "patchIteration.refine",
  body: deps.ApiPatchIterationRefineResponse,
): contracts.ApiJsonResponse;
export function ok(
  routeId: deps.ItotoriApiRouteId,
  body: deps.ItotoriApiResponseBody,
): contracts.ApiJsonResponse {
  deps.assertItotoriApiResponse(routeId, body);
  return { statusCode: 200, body };
}

export function notFound(pathname: string): contracts.ApiJsonResponse {
  return errorBody(404, "not_found", `unknown API route: ${pathname}`);
}

export function methodNotAllowed(allowedMethods: string[]): contracts.ApiJsonResponse {
  return errorBody(405, "method_not_allowed", `method must be ${allowedMethods.join(" or ")}`);
}

/**
 * Parse the new-pipeline localize fields off a draft request body. The legacy
 * ProjectState + targetLocale pair still drives ownership scoping; the new
 * pipeline additionally needs a runMode + the decoded narrative-structure JSON.
 * Returns null when those fields are absent (caller refuses in-band).
 */
export function parseNewPipelineDraftFields(body: unknown): {
  runMode: deps.RunModeValue;
  structure: unknown;
  bridge: deps.BridgeBundleV02;
  contextScope?: deps.ContextScopeValue;
  outputScope?: deps.OutputScope;
} | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  if (typeof record.runMode !== "string" || record.runMode.length === 0) return null;
  if (record.structure === undefined) return null;
  if (record.bridge === undefined) return null;
  try {
    deps.assertBridgeBundleV02(record.bridge);
  } catch {
    return null;
  }
  const runMode = RunModeValueSchema.safeParse(record.runMode);
  if (!runMode.success) return null;
  const contextScope = parseOptionalContextScope(record.contextScope);
  const outputScope = parseOptionalOutputScope(record.outputScope);
  return {
    runMode: runMode.data,
    structure: record.structure,
    bridge: record.bridge,
    ...(contextScope === undefined ? {} : { contextScope }),
    ...(outputScope === undefined ? {} : { outputScope }),
  };
}

function parseOptionalContextScope(value: unknown): deps.ContextScopeValue | undefined {
  if (value === undefined) return undefined;
  const parsed = ContextScopeValueSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new deps.ApiValidationError("contextScope must be a valid context scope");
}

function parseOptionalOutputScope(value: unknown): deps.OutputScope | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new deps.ApiValidationError("outputScope must be a translation scope");
  }
  const scope = Object.values(translationScopeValues).find((candidate) => candidate === value);
  if (scope === undefined) {
    throw new deps.ApiValidationError("outputScope must be a translation scope");
  }
  return scope;
}

/**
 * The live draft provider is deferred until the first invocation, so these
 * configuration failures can surface from either the workflow's missing-port
 * guard, the real provider constructor, or the root paid-invocation boundary.
 * They are all actionable domain refusals for `branches.draft`, not malformed
 * requests or server faults. After the API repoint, the primary refusal is the
 * in-band localizationSubstrate-missing path; these remain for any residual
 * substrate that still constructs a provider.
 */
export function draftProviderConfigurationResponse(
  request: contracts.ItotoriApiRequest,
  error: unknown,
): contracts.ApiJsonResponse | null {
  if (request.method !== "POST" || parseProjectRoute(request.pathname)?.resource !== "branches") {
    return null;
  }
  const refusalMessage = draftProviderConfigurationRefusal(error);
  if (refusalMessage === null) {
    return null;
  }
  return ok("branches.draft", {
    outcome: "refused",
    project: null,
    status: null,
    refusalMessage,
  });
}

export function draftProviderConfigurationRefusal(error: unknown): string | null {
  // Substrate-missing refusals that surface as thrown errors (e.g. from a
  // partial inject) stay in-band for the draft route.
  if (
    error instanceof Error &&
    (error.message.includes("localizationSubstrate port missing") ||
      error.message.includes("WorkflowPortDeps assemblers are not installed"))
  ) {
    return error.message;
  }
  return null;
}

export function errorResponse(error: unknown): contracts.ApiJsonResponse {
  if (error instanceof LocalizationPassControlError) {
    return errorBody(409, "run_transition_rejected", error.message);
  }
  if (deps.hasExplicitFailureEvidence(error)) {
    return applicationFailureBody(error);
  }
  if (error instanceof deps.ApiValidationError) {
    return errorBody(400, "bad_request", error.message);
  }
  // policy — a mutation targeting a project/branch outside the server-side
  // ownership scope is refused as forbidden (broken object-level authorization),
  // distinct from a bad request or a missing-permission denial.
  if (error instanceof deps.ProjectMutationScopeError) {
    return errorBody(403, "forbidden", error.message);
  }
  if (
    error instanceof deps.AssetLocalizationDecisionRepositoryError &&
    error.code === "asset_decision_not_found"
  ) {
    return errorBody(404, "not_found", error.message);
  }
  if (error instanceof deps.RuntimeRunNotFoundError) {
    return errorBody(404, "not_found", error.message);
  }
  // A `?projectId=` naming a project that does not exist is a not-found SCOPE.
  // It must never degrade into "answer from the workspace's latest project",
  // so the repositories throw and the boundary reports it as 404.
  if (error instanceof deps.ProjectScopeNotFoundError) {
    return errorBody(404, "not_found", error.message);
  }
  if (hasPostgresErrorCode(error, "42P01") || hasPostgresErrorCode(error, "42703")) {
    return errorBody(
      500,
      "database_migrations_required",
      "Database migrations are not applied. Run itotori db-migrate, then refresh.",
    );
  }
  const databaseMessage = deps.databaseUnreachableMessage(error);
  if (databaseMessage !== null) {
    return errorBody(503, "database_unreachable", databaseMessage);
  }
  return applicationFailureBody(error);
}

function applicationFailureBody(error: unknown): contracts.ApiJsonResponse {
  return explicitFailureApiResponse(error);
}

export function hasPostgresErrorCode(error: unknown, expectedCode: string): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if ("code" in current && typeof current.code === "string" && current.code === expectedCode) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

export function errorBody(
  statusCode: number,
  code: deps.ApiErrorResponse["code"],
  error: string,
  details: Pick<deps.ApiErrorResponse, "remainingAllowanceMicrosUsd" | "incidentReference"> = {},
): contracts.ApiJsonResponse {
  return { statusCode, body: { error, code, ...details } };
}

export function parseProjectRoute(pathname: string): {
  projectId: string;
  resource: "branches" | "findings" | "benchmarks" | "runtime-evidence" | "launch-pass";
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
    resource !== "benchmarks" &&
    resource !== "runtime-evidence" &&
    resource !== "launch-pass"
  ) {
    return null;
  }
  return { projectId: decodeURIComponent(projectId), resource };
}

export function assertPathProject(pathProjectId: string, bodyProjectId: string): void {
  if (pathProjectId !== bodyProjectId) {
    throw new deps.ApiValidationError(
      `path project ${pathProjectId} does not match body project ${bodyProjectId}`,
    );
  }
}

/**
 * policy — rewrite a record request's client-supplied `localeBranchId`
 * to the server-side authoritative value once ownership is verified. When the
 * client supplied no branch (`serverLocaleBranchId === null`, a project-scoped
 * record) the body is returned unchanged.
 */
export function scopeRecordBranch<T extends { localeBranchId?: string }>(
  body: T,
  serverLocaleBranchId: string | null,
): T {
  if (serverLocaleBranchId === null) {
    return body;
  }
  return { ...body, localeBranchId: serverLocaleBranchId };
}
