import {
  AssetLocalizationDecisionRepositoryError,
  AuthorizationError,
  assetLocalizationDecisionAssetKindList,
  capabilityLevelValues,
  catalogCandidateMatchStatusValues,
  catalogCompletenessPoolValues,
  catalogConflictStatusValues,
  catalogLanguageStatusValues,
  catalogSourceValues,
  type CapabilityLevel,
  type AssetDecisionRecord,
  type AssetLocalizationDecisionAssetKind,
  type CandidateAssetRecord,
  type CatalogBenchmarkDemandBucket,
  type CatalogBenchmarkLocalOwnership,
  type CatalogBenchmarkSeedFinderFilter,
  type CatalogBenchmarkSeedFinderReadModel,
  type CatalogOpportunityRankingFilter,
  type CatalogOpportunityRankingReadModel,
  permissionValues,
  type CatalogCompletenessBenchmarkPools,
  type CatalogCompletenessPool,
  type CatalogCompletenessPoolFilter,
  type CatalogConflictReviewFilter,
  type CatalogConflictReviewReadModel,
  type CatalogConflictReviewSeverity,
  type CatalogConflictReviewStatus,
  type CatalogLanguageStatus,
  type CatalogSource,
  type DashboardDecisionReadModel,
  type Permission,
  type ProjectCostReport,
  type ProjectDashboardStatus,
  type RuntimeDashboardStatus,
  type TerminologySearchInput,
  type TerminologySearchReadModel,
} from "@itotori/db";
import type { ItotoriAuthorizationPort } from "./auth.js";
import {
  ApiValidationError,
  REDACTED_RUNTIME_FINDING_MESSAGE,
  assertItotoriApiResponse,
  assertRedactedRuntimeDashboardStatus,
  parseDraftBranchRequest,
  parseProjectImportRequest,
  parseRecordBenchmarkRequest,
  parseRecordDecisionRequest,
  parseRecordFindingRequest,
  parseReviewerBatchExecuteRequest,
  parseReviewerBatchPreviewRequest,
  parseReviewerSingleActionRequest,
  parseRuntimeEvidenceRequest,
  parseWorkspaceCorrectionSubmitRequest,
  type ApiDraftBranchResponse,
  type ApiErrorResponse,
  type ApiAssetDecisionsResponse,
  type ApiBenchmarkReportsResponse,
  type ApiCandidateAssetsResponse,
  type ApiProjectImportResponse,
  type ApiProjectsResponse,
  type ApiReviewerBatchExecuteResponse,
  type ApiReviewerBatchPreviewResponse,
  type ApiReviewerSingleActionResponse,
  type ApiReviewerDetailResponse,
  type ApiReviewerQueueDashboardResponse,
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
import {
  deniedContextFixture,
  reviewerDetailDiagnosticCodeValues,
} from "./reviewer/detail-fixtures.js";
import type { ReviewerQueueApiServicePort } from "./reviewer/api-service.js";
import { reviewerBatchPreviewStatusValues } from "./reviewer/batch-preview.js";
import type { ReviewerQueuePermissionView } from "./auth.js";
import type {
  LocalizationWorkspaceApiServicePort,
  LoadWorkspaceSearchInput,
} from "./workspace/api-service.js";
import type { WorkspaceCorrectionServicePort } from "./workspace/correction-service.js";
import { workspaceSearchModeValues } from "./workspace/read-model.js";
import type {
  ApiWorkspaceAssetBrowseResponse,
  ApiWorkspaceComparisonResponse,
  ApiWorkspaceCorrectionPreviewResponse,
  ApiWorkspaceCorrectionSubmitResponse,
  ApiWorkspaceProjectBrowseResponse,
  ApiWorkspaceSceneBrowseResponse,
  ApiWorkspaceSearchResponse,
} from "./api-schema.js";

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
    catalogCompletenessBenchmarkPools(
      filter?: CatalogCompletenessPoolFilter,
    ): Promise<CatalogCompletenessBenchmarkPools>;
    catalogBenchmarkSeedFinder(
      filter?: CatalogBenchmarkSeedFinderFilter,
    ): Promise<CatalogBenchmarkSeedFinderReadModel>;
    catalogOpportunityRanking(
      filter?: CatalogOpportunityRankingFilter,
    ): Promise<CatalogOpportunityRankingReadModel>;
  };
  terminologyRepository: {
    searchTerms(input: TerminologySearchInput): Promise<TerminologySearchReadModel>;
  };
  reviewerQueue: ReviewerQueueApiServicePort;
  workspace: LocalizationWorkspaceApiServicePort;
  workspaceCorrections: WorkspaceCorrectionServicePort;
  assetDecisions: {
    loadActiveDecisions(
      projectId: string,
      localeBranchId: string,
      opts?: { kindFilter?: AssetLocalizationDecisionAssetKind },
    ): Promise<AssetDecisionRecord[]>;
    loadCandidateAssets(
      projectId: string,
      localeBranchId: string,
      opts?: { kindFilter?: AssetLocalizationDecisionAssetKind },
    ): Promise<CandidateAssetRecord[]>;
  };
  projectWorkflow: Pick<
    ItotoriProjectWorkflowPort,
    | "getDashboardStatus"
    | "getDashboardDecisions"
    | "getRuntimeStatus"
    | "getCostReport"
    | "getBenchmarkReports"
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
    const canRead = await resolveProjectReadPermission(services);
    const status = await services.projectWorkflow.getDashboardStatus();
    const view = canRead ? status : redactProjectDashboardStatus(status);
    return ok("projects.list", { projects: [view] });
  }

  if (request.method === "GET" && request.pathname === "/api/projects/status") {
    const canRead = await resolveProjectReadPermission(services);
    const status = await services.projectWorkflow.getDashboardStatus();
    return ok("projects.status", canRead ? status : redactProjectDashboardStatus(status));
  }

  if (request.method === "GET" && request.pathname === "/api/projects/decisions") {
    return ok("projects.decisions", await services.projectWorkflow.getDashboardDecisions());
  }

  if (request.method === "GET" && request.pathname === "/api/projects/cost") {
    const canRead = await resolveProjectReadPermission(services);
    const cost = await services.projectWorkflow.getCostReport();
    return ok("projects.cost", canRead ? cost : redactProjectCostReport(cost));
  }

  if (request.method === "GET" && request.pathname === "/api/projects/benchmarks") {
    return ok("projects.benchmarks", {
      reports: await services.projectWorkflow.getBenchmarkReports(),
    });
  }

  if (
    request.method === "GET" &&
    (request.pathname === "/api/hello/status" || request.pathname === "/api/runtime/v0.2/status")
  ) {
    // gate-runtime-status-reads-and-redact-evidence-previews — the runtime
    // status read requires catalog.read for the DETAILED evidence report.
    // An unprivileged / absent-permission caller instead receives a redacted
    // summary that omits the evidence-text previews, finding free text, and
    // artifact URIs/hashes. Both the /api/runtime/v0.2/status and the legacy
    // /api/hello/status alias share this gate — there is no parallel ungated
    // path to the same data.
    const canRead = await resolveProjectReadPermission(services);
    const status = await services.projectWorkflow.getRuntimeStatus(
      parseRuntimeRunIdQuery(request.search),
    );
    if (canRead) {
      return ok("runtime.status", status);
    }
    const redacted = redactRuntimeDashboardStatus(status);
    // Reject a leakage-shaped redaction before it can be emitted.
    assertRedactedRuntimeDashboardStatus(redacted);
    return ok("runtime.status", redacted);
  }

  if (request.method === "GET" && request.pathname === "/api/catalog/conflicts") {
    return ok(
      "catalog.conflicts",
      await services.catalogRepository.catalogConflictReview(
        parseCatalogConflictReviewFilter(request.search),
      ),
    );
  }

  if (request.method === "GET" && request.pathname === "/api/catalog/completeness") {
    return ok(
      "catalog.completeness",
      await services.catalogRepository.catalogCompletenessBenchmarkPools(
        parseCatalogCompletenessPoolFilter(request.search),
      ),
    );
  }

  if (request.method === "GET" && request.pathname === "/api/catalog/benchmark-seeds") {
    return ok(
      "catalog.benchmarkSeeds",
      await services.catalogRepository.catalogBenchmarkSeedFinder(
        parseCatalogBenchmarkSeedFinderFilter(request.search),
      ),
    );
  }

  if (request.method === "GET" && request.pathname === "/api/catalog/opportunities") {
    return ok(
      "catalog.opportunities",
      await services.catalogRepository.catalogOpportunityRanking(
        parseCatalogOpportunityRankingFilter(request.search),
      ),
    );
  }

  if (request.method === "GET" && request.pathname === "/api/terminology/search") {
    return ok(
      "terminology.search",
      await services.terminologyRepository.searchTerms(parseTerminologySearchInput(request.search)),
    );
  }

  if (request.method === "GET" && request.pathname === "/api/workspace/projects") {
    const permission = await resolveApiReviewerQueuePermissionView(
      services,
      parseActorUserIdQuery(request.search),
    );
    return ok("workspace.projects", await services.workspace.loadProjectBrowse({ permission }));
  }

  if (request.method === "GET" && request.pathname === "/api/workspace/scenes") {
    const permission = await resolveApiReviewerQueuePermissionView(
      services,
      parseActorUserIdQuery(request.search),
    );
    const scope = parseWorkspaceBranchScopeQuery(request.search, "workspace scenes");
    return ok(
      "workspace.scenes",
      await services.workspace.loadSceneBrowse({ ...scope, permission }),
    );
  }

  if (request.method === "GET" && request.pathname === "/api/workspace/assets") {
    const permission = await resolveApiReviewerQueuePermissionView(
      services,
      parseActorUserIdQuery(request.search),
    );
    const scope = parseWorkspaceBranchScopeQuery(request.search, "workspace assets");
    return ok(
      "workspace.assets",
      await services.workspace.loadAssetBrowse({
        projectId: scope.projectId,
        localeBranchId: scope.localeBranchId,
        permission,
      }),
    );
  }

  if (request.method === "GET" && request.pathname === "/api/workspace/comparison") {
    const permission = await resolveApiReviewerQueuePermissionView(
      services,
      parseActorUserIdQuery(request.search),
    );
    const reviewItemId = parseWorkspaceComparisonQuery(request.search);
    return ok(
      "workspace.comparison",
      await services.workspace.loadComparison({ reviewItemId, permission }),
    );
  }

  if (request.method === "GET" && request.pathname === "/api/workspace/search") {
    const permission = await resolveApiReviewerQueuePermissionView(
      services,
      parseActorUserIdQuery(request.search),
    );
    const searchInput = parseWorkspaceSearchQuery(request.search);
    return ok(
      "workspace.search",
      await services.workspace.loadSearch({ ...searchInput, permission }),
    );
  }

  if (request.method === "GET" && request.pathname === "/api/workspace/corrections") {
    const permission = await resolveApiReviewerQueuePermissionView(
      services,
      parseActorUserIdQuery(request.search),
    );
    const previewInput = parseWorkspaceCorrectionPreviewQuery(request.search);
    return ok(
      "workspace.correctionPreview",
      await services.workspaceCorrections.loadPreview({ ...previewInput, permission }),
    );
  }

  if (request.method === "POST" && request.pathname === "/api/workspace/corrections") {
    const body = parseWorkspaceCorrectionSubmitRequest(request.body);
    const permission = await resolveApiReviewerQueuePermissionView(services, body.actorUserId);
    return ok(
      "workspace.correctionSubmit",
      await services.workspaceCorrections.submitCorrections({ ...body, permission }),
    );
  }

  if (
    request.method !== "GET" &&
    (request.pathname === "/api/workspace/projects" ||
      request.pathname === "/api/workspace/scenes" ||
      request.pathname === "/api/workspace/assets" ||
      request.pathname === "/api/workspace/comparison" ||
      request.pathname === "/api/workspace/search")
  ) {
    return methodNotAllowed(["GET"]);
  }

  if (
    request.pathname === "/api/workspace/corrections" &&
    request.method !== "GET" &&
    request.method !== "POST"
  ) {
    return methodNotAllowed(["GET", "POST"]);
  }

  const assetDecisionRoute = parseAssetDecisionApiRoute(request.pathname);
  if (request.method === "GET" && assetDecisionRoute !== null) {
    const filter = parseAssetDecisionReadFilter(request.search);
    if (assetDecisionRoute.resource === "active") {
      return ok("assetDecisions.active", {
        decisions: await services.assetDecisions.loadActiveDecisions(
          assetDecisionRoute.projectId,
          assetDecisionRoute.localeBranchId,
          filter,
        ),
      });
    }
    return ok("assetDecisions.candidates", {
      candidateAssets: await services.assetDecisions.loadCandidateAssets(
        assetDecisionRoute.projectId,
        assetDecisionRoute.localeBranchId,
        filter,
      ),
    });
  }

  if (request.method === "GET" && request.pathname === "/api/reviewer/queue") {
    const permission = await resolveApiReviewerQueuePermissionView(
      services,
      parseActorUserIdQuery(request.search),
    );
    if (!permission.canReadQueue) {
      throw new AuthorizationError({ userId: permission.actorUserId }, permissionValues.queueRead);
    }
    const localeBranchId =
      parseReviewerQueueDashboardQuery(request.search).localeBranchId ??
      (await services.projectWorkflow.getDashboardStatus()).selectedLocaleBranchId;
    if (localeBranchId === null) {
      throw new ApiValidationError(
        "reviewer queue dashboard requires localeBranchId when no dashboard branch is selected",
      );
    }
    return ok(
      "reviewer.queue",
      await services.reviewerQueue.loadDashboard({ localeBranchId, permission }),
    );
  }

  const reviewerDetailRoute = parseReviewerDetailApiRoute(request.pathname);
  if (request.method === "GET" && reviewerDetailRoute !== null) {
    const permission = await resolveApiReviewerQueuePermissionView(
      services,
      parseActorUserIdQuery(request.search),
    );
    if (!permission.canReadQueue) {
      return ok(
        "reviewer.detail",
        deniedReviewerDetailApiResponse(reviewerDetailRoute.reviewItemId, permission),
      );
    }
    return ok(
      "reviewer.detail",
      await services.reviewerQueue.loadDetailContext({
        reviewItemId: reviewerDetailRoute.reviewItemId,
        permission,
      }),
    );
  }

  if (request.method === "POST" && request.pathname === "/api/reviewer/queue/batch-preview") {
    const body = parseReviewerBatchPreviewRequest(request.body);
    const permission = await resolveApiReviewerQueuePermissionView(services, body.actorUserId);
    return ok(
      "reviewer.batchPreview",
      await services.reviewerQueue.previewBatch({ request: body, permission }),
    );
  }

  if (request.method === "POST" && request.pathname === "/api/reviewer/queue/batch-confirm") {
    const body = parseReviewerBatchExecuteRequest(request.body);
    const permission = await resolveApiReviewerQueuePermissionView(services, body.actorUserId);
    return ok(
      "reviewer.batchExecute",
      await services.reviewerQueue.executeBatch({
        actor: { userId: body.actorUserId },
        request: body,
        permission,
      }),
    );
  }

  const reviewerSingleActionRoute = parseReviewerSingleActionApiRoute(request.pathname);
  if (request.method === "POST" && reviewerSingleActionRoute !== null) {
    // ITOTORI-082 — single-item reviewer action. Reuses the batch route's
    // actor-gating (the SAME permission view), validation, and
    // consequence disclosure via `actionSingleItem` (a batch-of-one over
    // ReviewerQueueActionService). No new auth path, service, or
    // migration. A refused outcome (unknown item / invalid transition /
    // already-actioned / stale / permission) becomes a typed HTTP error
    // rather than an in-band 200 or a 500.
    const body = parseReviewerSingleActionRequest(
      request.body,
      reviewerSingleActionRoute.reviewItemId,
    );
    const permission = await resolveApiReviewerQueuePermissionView(services, body.actorUserId);
    const result = await services.reviewerQueue.actionSingleItem({
      actor: { userId: body.actorUserId },
      request: body,
      permission,
    });
    if (result.outcome.kind === "refused") {
      return reviewerSingleActionRefusal(result.outcome.status, result.outcome.message);
    }
    return ok("reviewer.itemAction", result);
  }

  if (
    request.pathname === "/api/projects/status" ||
    request.pathname === "/api/projects/decisions" ||
    request.pathname === "/api/projects/cost" ||
    request.pathname === "/api/projects/benchmarks" ||
    request.pathname === "/api/hello/status" ||
    request.pathname === "/api/catalog/conflicts" ||
    request.pathname === "/api/catalog/completeness" ||
    request.pathname === "/api/catalog/benchmark-seeds" ||
    request.pathname === "/api/catalog/opportunities" ||
    request.pathname === "/api/terminology/search" ||
    assetDecisionRoute !== null ||
    request.pathname === "/api/reviewer/queue" ||
    request.pathname === "/api/reviewer/queue/batch-preview" ||
    request.pathname === "/api/reviewer/queue/batch-confirm" ||
    reviewerSingleActionRoute !== null ||
    reviewerDetailRoute !== null
  ) {
    return request.pathname === "/api/reviewer/queue/batch-preview" ||
      request.pathname === "/api/reviewer/queue/batch-confirm" ||
      reviewerSingleActionRoute !== null
      ? methodNotAllowed(["POST"])
      : methodNotAllowed(["GET"]);
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

async function resolveApiReviewerQueuePermissionView(
  services: ItotoriApiServices,
  actorUserId = "local-user",
): Promise<ReviewerQueuePermissionView> {
  const [canReadQueue, readDenial] = await tryApiPermission(services, permissionValues.queueRead);
  const [canManageQueue, manageDenial] = await tryApiPermission(
    services,
    permissionValues.queueManage,
  );
  const denialReasons: string[] = [];
  if (readDenial !== null) {
    denialReasons.push(readDenial);
  }
  if (manageDenial !== null) {
    denialReasons.push(manageDenial);
  }
  return {
    actorUserId,
    canReadQueue,
    canManageQueue,
    denialReasons,
  };
}

async function tryApiPermission(
  services: ItotoriApiServices,
  permission: Permission,
): Promise<[boolean, string | null]> {
  try {
    await services.authorization.requirePermission(permission);
    return [true, null];
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return [false, error.message];
    }
    throw error;
  }
}

/**
 * gate-project-status-and-cost-reads — the project dashboard / list / cost
 * read paths require this explicit READ permission to return the full
 * detail. An unprivileged / absent-permission caller instead receives a
 * redacted public dashboard summary (aggregate status + counts only). The
 * gate reuses `catalog.read`, the same permission the sibling
 * ledger-count reads (`countZdrEnforcedByPair`, `countCostKindsByPair`)
 * and the cost report repository read enforce, so the HTTP boundary and
 * the repository defense-in-depth check agree on the required permission.
 */
async function resolveProjectReadPermission(services: ItotoriApiServices): Promise<boolean> {
  const [canRead] = await tryApiPermission(services, permissionValues.catalogRead);
  return canRead;
}

/**
 * gate-project-status-and-cost-reads — the redacted PUBLIC cost summary.
 * Keeps only safe aggregates (run/token/USD totals + the translation
 * memory reuse counts). Strips the run-ledger detail (`recentRuns`, which
 * carries provider/model/routing internals) and the translation-memory
 * reuse events (which carry `targetText`). These are privileged-only.
 */
function redactProjectCostReport(cost: ProjectCostReport): ProjectCostReport {
  return {
    ...cost,
    recentRuns: [],
    translationMemoryReuse: {
      ...cost.translationMemoryReuse,
      recentEvents: [],
    },
  };
}

/**
 * gate-project-status-and-cost-reads — the redacted PUBLIC dashboard
 * summary. Every top-level field is a safe aggregate (project identity,
 * counts, locale-branch rollups); the only sensitive nested payload is the
 * embedded cost report, which is redacted to aggregates.
 */
function redactProjectDashboardStatus(status: ProjectDashboardStatus): ProjectDashboardStatus {
  return {
    ...status,
    cost: redactProjectCostReport(status.cost),
  };
}

/**
 * gate-runtime-status-reads-and-redact-evidence-previews — the redacted
 * PUBLIC runtime status summary for unprivileged callers. Keeps the safe
 * aggregates (final/runtime status, tiers, counts, non-sensitive ids,
 * approximation/limitation/unsupported-capability metadata) and strips the
 * sensitive evidence payloads:
 *   - `traceEvents[].textPreview` — evidence text previews sourced from
 *     observedText / promptText → null.
 *   - `findings[].message` — finding free text → the redaction sentinel
 *     (a non-empty placeholder that keeps the shape valid while carrying no
 *     free text).
 *   - `artifacts[].uri` / `artifacts[].hash` — managed artifact locators
 *     and content hashes → null.
 */
function redactRuntimeDashboardStatus(status: RuntimeDashboardStatus): RuntimeDashboardStatus {
  return {
    ...status,
    traceEvents: status.traceEvents.map((event) => ({
      ...event,
      textPreview: null,
    })),
    findings: status.findings.map((finding) => ({
      ...finding,
      message: REDACTED_RUNTIME_FINDING_MESSAGE,
    })),
    artifacts: status.artifacts.map((artifact) => ({
      ...artifact,
      uri: null,
      hash: null,
    })),
  };
}

function deniedReviewerDetailApiResponse(
  reviewItemId: string,
  permission: ReviewerQueuePermissionView,
): ApiReviewerDetailResponse {
  const denialReason =
    permission.denialReasons.find((reason) => reason.includes(permissionValues.queueRead)) ??
    permission.denialReasons[0] ??
    `user ${permission.actorUserId} is missing permission queue.read`;
  return {
    ...deniedContextFixture(permission.actorUserId),
    reviewItemId,
    permission: {
      ...permission,
      denialReasons:
        permission.denialReasons.length === 0 ? [denialReason] : permission.denialReasons,
    },
    diagnostics: [
      {
        code: reviewerDetailDiagnosticCodeValues.permissionDenied,
        message: denialReason,
      },
    ],
  };
}

function parseActorUserIdQuery(search = ""): string | undefined {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const actorUserId = params.get("actorUserId");
  if (actorUserId === null) {
    return undefined;
  }
  if (actorUserId.trim().length === 0) {
    throw new ApiValidationError("actorUserId must be non-empty");
  }
  return actorUserId;
}

function parseReviewerQueueDashboardQuery(search = ""): { localeBranchId: string | null } {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  assertKnownQueryParams(params, ["localeBranchId", "actorUserId"], "reviewer queue dashboard");
  const localeBranchId = params.get("localeBranchId");
  if (localeBranchId !== null && localeBranchId.trim().length === 0) {
    throw new ApiValidationError("localeBranchId must be non-empty");
  }
  return { localeBranchId };
}

function parseWorkspaceBranchScopeQuery(
  search = "",
  context: string,
): { projectId: string; localeBranchId: string; sceneId?: string; sourceRevisionId?: string } {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  assertKnownQueryParams(
    params,
    ["projectId", "localeBranchId", "sceneId", "sourceRevisionId", "actorUserId"],
    context,
  );
  const projectId = requiredNonEmptyParam(params, "projectId");
  const localeBranchId = requiredNonEmptyParam(params, "localeBranchId");
  const scope: {
    projectId: string;
    localeBranchId: string;
    sceneId?: string;
    sourceRevisionId?: string;
  } = { projectId, localeBranchId };
  const sceneId = params.get("sceneId");
  if (sceneId !== null) {
    if (sceneId.trim().length === 0) {
      throw new ApiValidationError("sceneId must be non-empty");
    }
    scope.sceneId = sceneId;
  }
  const sourceRevisionId = params.get("sourceRevisionId");
  if (sourceRevisionId !== null) {
    if (sourceRevisionId.trim().length === 0) {
      throw new ApiValidationError("sourceRevisionId must be non-empty");
    }
    scope.sourceRevisionId = sourceRevisionId;
  }
  return scope;
}

function parseWorkspaceCorrectionPreviewQuery(search = ""): {
  localeBranchId: string;
  reviewItemIds: string[];
} {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  assertKnownQueryParams(
    params,
    ["localeBranchId", "reviewItemIds", "actorUserId"],
    "workspace corrections preview",
  );
  const localeBranchId = requiredNonEmptyParam(params, "localeBranchId");
  const reviewItemIdsRaw = params.get("reviewItemIds");
  const reviewItemIds =
    reviewItemIdsRaw === null
      ? []
      : reviewItemIdsRaw
          .split(",")
          .map((value) => value.trim())
          .filter((value) => value.length > 0);
  return { localeBranchId, reviewItemIds };
}

function parseWorkspaceComparisonQuery(search = ""): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  assertKnownQueryParams(params, ["reviewItemId", "actorUserId"], "workspace comparison");
  return requiredNonEmptyParam(params, "reviewItemId");
}

function parseWorkspaceSearchQuery(search = ""): Omit<LoadWorkspaceSearchInput, "permission"> {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  assertKnownQueryParams(
    params,
    ["projectId", "localeBranchId", "query", "mode", "limit", "actorUserId"],
    "workspace search",
  );
  const input: Omit<LoadWorkspaceSearchInput, "permission"> = {
    projectId: requiredNonEmptyParam(params, "projectId"),
    localeBranchId: requiredNonEmptyParam(params, "localeBranchId"),
    query: requiredQueryParam(params, "query"),
  };
  const mode = params.get("mode");
  if (mode !== null) {
    input.mode = enumParam(
      mode,
      [
        workspaceSearchModeValues.all,
        workspaceSearchModeValues.exact,
        workspaceSearchModeValues.terminology,
      ] as const,
      "mode",
    );
  }
  const limit = params.get("limit");
  if (limit !== null) {
    const parsedLimit = Number(limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
      throw new ApiValidationError("limit must be an integer from 1 through 100");
    }
    input.limit = parsedLimit;
  }
  return input;
}

function requiredNonEmptyParam(params: URLSearchParams, name: string): string {
  const value = params.get(name);
  if (value === null || value.trim().length === 0) {
    throw new ApiValidationError(`${name} is required and must be non-empty`);
  }
  return value;
}

function requiredQueryParam(params: URLSearchParams, name: string): string {
  const value = params.get(name);
  if (value === null) {
    throw new ApiValidationError(`${name} is required`);
  }
  return value;
}

function parseReviewerDetailApiRoute(pathname: string): { reviewItemId: string } | null {
  const match = /^\/api\/reviewer\/queue\/([^/]+)\/detail$/u.exec(pathname);
  if (match === null || match[1] === undefined || match[1].length === 0) {
    return null;
  }
  return { reviewItemId: decodeURIComponent(match[1]) };
}

function parseReviewerSingleActionApiRoute(pathname: string): { reviewItemId: string } | null {
  const match = /^\/api\/reviewer\/queue\/([^/]+)\/action$/u.exec(pathname);
  if (match === null || match[1] === undefined || match[1].length === 0) {
    return null;
  }
  return { reviewItemId: decodeURIComponent(match[1]) };
}

/**
 * Map a single-item action refusal (the same closed status taxonomy the
 * batch preview/execute uses) to a typed HTTP error — never a 500. A
 * missing item is a 404; a permission denial is a 403; every remaining
 * refusal (invalid transition, already-actioned, stale revision,
 * concurrent modification, runtime-evidence invariant, invalid input,
 * duplicate) is a 400 bad_request carrying the refusal message.
 */
function reviewerSingleActionRefusal(status: string, message: string): ApiJsonResponse {
  switch (status) {
    case reviewerBatchPreviewStatusValues.notFound:
      return errorBody(404, "not_found", message);
    case reviewerBatchPreviewStatusValues.permissionDeniedRead:
    case reviewerBatchPreviewStatusValues.permissionDeniedManage:
      return errorBody(403, "forbidden", message);
    default:
      return errorBody(400, "bad_request", message);
  }
}

function parseAssetDecisionApiRoute(pathname: string): {
  projectId: string;
  localeBranchId: string;
  resource: "active" | "candidates";
} | null {
  const match =
    /^\/api\/projects\/([^/]+)\/locale-branches\/([^/]+)\/asset-decisions(?:\/(candidates))?$/u.exec(
      pathname,
    );
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return null;
  }
  return {
    projectId: decodeApiPathSegment(match[1], "projectId"),
    localeBranchId: decodeApiPathSegment(match[2], "localeBranchId"),
    resource: match[3] === "candidates" ? "candidates" : "active",
  };
}

function decodeApiPathSegment(raw: string, label: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new ApiValidationError(`${label} must be URL-encoded`);
  }
  if (decoded.trim().length === 0 || decoded.includes("/")) {
    throw new ApiValidationError(`${label} path segment must be non-empty and contain no slash`);
  }
  return decoded;
}

function parseAssetDecisionReadFilter(search = ""): {
  kindFilter?: AssetLocalizationDecisionAssetKind;
} {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  assertKnownQueryParams(params, ["assetKind"], "asset decisions");
  const assetKind = params.get("assetKind");
  if (assetKind === null) {
    return {};
  }
  return {
    kindFilter: enumParam(assetKind, assetLocalizationDecisionAssetKindList, "assetKind"),
  };
}

function parseCatalogOpportunityRankingFilter(search = ""): CatalogOpportunityRankingFilter {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  assertKnownQueryParams(
    params,
    [
      "targetLanguage",
      "includeDemoted",
      "limit",
      "engine",
      "pool",
      "minCapabilityLevel",
      "localOwnership",
      "demandBucket",
    ],
    "catalog opportunity",
  );
  const filter: CatalogOpportunityRankingFilter = {};
  const targetLanguage = params.get("targetLanguage");
  if (targetLanguage !== null) {
    if (targetLanguage.trim().length === 0) {
      throw new ApiValidationError("targetLanguage must be non-empty");
    }
    filter.targetLanguage = targetLanguage;
  }
  const includeDemoted = params.get("includeDemoted");
  if (includeDemoted !== null) {
    filter.includeDemoted = booleanParam(includeDemoted, "includeDemoted");
  }
  const limit = params.get("limit");
  if (limit !== null) {
    const parsedLimit = Number(limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 500) {
      throw new ApiValidationError("limit must be an integer from 1 through 500");
    }
    filter.limit = parsedLimit;
  }
  const engine = params.get("engine");
  if (engine !== null) {
    if (engine.trim().length === 0) {
      throw new ApiValidationError("engine must be non-empty");
    }
    filter.engine = engine;
  }
  const pool = params.get("pool");
  if (pool !== null) {
    filter.pool = enumParam(
      pool,
      Object.values(catalogCompletenessPoolValues) as CatalogCompletenessPool[],
      "pool",
    );
  }
  const minCapabilityLevel = params.get("minCapabilityLevel");
  if (minCapabilityLevel !== null) {
    filter.minCapabilityLevel = enumParam(
      minCapabilityLevel,
      Object.values(capabilityLevelValues) as CapabilityLevel[],
      "minCapabilityLevel",
    );
  }
  const localOwnership = params.get("localOwnership");
  if (localOwnership !== null) {
    filter.localOwnership = enumParam(
      localOwnership,
      catalogBenchmarkLocalOwnershipValues,
      "localOwnership",
    );
  }
  const demandBucket = params.get("demandBucket");
  if (demandBucket !== null) {
    filter.demandBucket = enumParam(demandBucket, catalogBenchmarkDemandBuckets, "demandBucket");
  }
  return filter;
}

function parseCatalogCompletenessPoolFilter(search = ""): CatalogCompletenessPoolFilter {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const filter: CatalogCompletenessPoolFilter = {};
  const targetLanguage = params.get("targetLanguage");
  if (targetLanguage !== null) {
    if (targetLanguage.trim().length === 0) {
      throw new ApiValidationError("targetLanguage must be non-empty");
    }
    filter.targetLanguage = targetLanguage;
  }
  const pool = params.get("pool");
  if (pool !== null) {
    filter.pool = enumParam(
      pool,
      Object.values(catalogCompletenessPoolValues) as CatalogCompletenessPool[],
      "pool",
    );
  }
  return filter;
}

const catalogBenchmarkDemandBuckets: CatalogBenchmarkDemandBucket[] = [
  "none",
  "low",
  "medium",
  "high",
  "very_high",
];

const catalogBenchmarkLocalOwnershipValues: CatalogBenchmarkLocalOwnership[] = [
  "owned",
  "not_owned",
  "unknown",
];

function parseCatalogBenchmarkSeedFinderFilter(search = ""): CatalogBenchmarkSeedFinderFilter {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  assertKnownQueryParams(
    params,
    [
      "targetLanguage",
      "pools",
      "adapterIds",
      "minCapabilityLevel",
      "demandBucket",
      "translationCompleteness",
      "provenanceRequired",
      "localOwnership",
      "includeDemoted",
      "limit",
    ],
    "catalog benchmark seed",
  );
  const filter: CatalogBenchmarkSeedFinderFilter = {};
  const targetLanguage = params.get("targetLanguage");
  if (targetLanguage !== null) {
    if (targetLanguage.trim().length === 0) {
      throw new ApiValidationError("targetLanguage must be non-empty");
    }
    filter.targetLanguage = targetLanguage;
  }
  const pools = listParam(params, "pools");
  if (pools.length > 0) {
    filter.pools = pools.map((pool) =>
      enumParam(
        pool,
        Object.values(catalogCompletenessPoolValues) as CatalogCompletenessPool[],
        "pools",
      ),
    );
  }
  const adapterIds = listParam(params, "adapterIds");
  if (adapterIds.length > 0) {
    filter.adapterIds = adapterIds;
  }
  const minCapabilityLevel = params.get("minCapabilityLevel");
  if (minCapabilityLevel !== null) {
    filter.minCapabilityLevel = enumParam(
      minCapabilityLevel,
      Object.values(capabilityLevelValues) as CapabilityLevel[],
      "minCapabilityLevel",
    );
  }
  const demandBucket = params.get("demandBucket");
  if (demandBucket !== null) {
    filter.demandBucket = enumParam(demandBucket, catalogBenchmarkDemandBuckets, "demandBucket");
  }
  const translationCompleteness = listParam(params, "translationCompleteness");
  if (translationCompleteness.length > 0) {
    filter.translationCompleteness = translationCompleteness.map((status) =>
      enumParam(
        status,
        Object.values(catalogLanguageStatusValues) as CatalogLanguageStatus[],
        "translationCompleteness",
      ),
    );
  }
  const provenanceRequired = params.get("provenanceRequired");
  if (provenanceRequired !== null) {
    filter.provenanceRequired = booleanParam(provenanceRequired, "provenanceRequired");
  }
  const localOwnership = params.get("localOwnership");
  if (localOwnership !== null) {
    filter.localOwnership = enumParam(
      localOwnership,
      catalogBenchmarkLocalOwnershipValues,
      "localOwnership",
    );
  }
  const includeDemoted = params.get("includeDemoted");
  if (includeDemoted !== null) {
    filter.includeDemoted = booleanParam(includeDemoted, "includeDemoted");
  }
  const limit = params.get("limit");
  if (limit !== null) {
    const parsedLimit = Number(limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 500) {
      throw new ApiValidationError("limit must be an integer from 1 through 500");
    }
    filter.limit = parsedLimit;
  }
  return filter;
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

function parseRuntimeRunIdQuery(search = ""): string | undefined {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const runtimeRunId = params.get("runtimeRunId");
  if (runtimeRunId === null) {
    return undefined;
  }
  if (runtimeRunId.trim().length === 0) {
    throw new ApiValidationError("runtimeRunId must be non-empty");
  }
  return runtimeRunId;
}

function parseTerminologySearchInput(search = ""): TerminologySearchInput {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const localeBranchId = params.get("localeBranchId");
  const query = params.get("q");
  if (localeBranchId === null || localeBranchId.trim().length === 0) {
    throw new ApiValidationError("localeBranchId must be non-empty");
  }
  if (query === null || query.trim().length === 0) {
    throw new ApiValidationError("q must be non-empty");
  }
  const input: TerminologySearchInput = {
    localeBranchId,
    query,
  };
  const projectId = params.get("projectId");
  if (projectId !== null) {
    if (projectId.trim().length === 0) {
      throw new ApiValidationError("projectId must be non-empty");
    }
    input.projectId = projectId;
  }
  const limit = params.get("limit");
  if (limit !== null) {
    const parsedLimit = Number(limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
      throw new ApiValidationError("limit must be an integer from 1 through 100");
    }
    input.limit = parsedLimit;
  }
  const includeDeprecated = params.get("includeDeprecated");
  if (includeDeprecated !== null) {
    if (includeDeprecated !== "true" && includeDeprecated !== "false") {
      throw new ApiValidationError("includeDeprecated must be true or false");
    }
    input.includeDeprecated = includeDeprecated === "true";
  }
  return input;
}

function enumParam<T extends string>(value: string, allowed: readonly T[], label: string): T {
  if (!allowed.includes(value as T)) {
    throw new ApiValidationError(`${label} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function booleanParam(value: string, label: string): boolean {
  if (value !== "true" && value !== "false") {
    throw new ApiValidationError(`${label} must be true or false`);
  }
  return value === "true";
}

function listParam(params: URLSearchParams, key: string): string[] {
  return params
    .getAll(key)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function assertKnownQueryParams(
  params: URLSearchParams,
  allowedKeys: readonly string[],
  label: string,
): void {
  const allowed = new Set(allowedKeys);
  for (const key of params.keys()) {
    if (!allowed.has(key)) {
      throw new ApiValidationError(`unknown ${label} query parameter: ${key}`);
    }
  }
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
function ok(routeId: "assetDecisions.active", body: ApiAssetDecisionsResponse): ApiJsonResponse;
function ok(
  routeId: "assetDecisions.candidates",
  body: ApiCandidateAssetsResponse,
): ApiJsonResponse;
function ok(routeId: "catalog.conflicts", body: CatalogConflictReviewReadModel): ApiJsonResponse;
function ok(
  routeId: "catalog.completeness",
  body: CatalogCompletenessBenchmarkPools,
): ApiJsonResponse;
function ok(
  routeId: "catalog.benchmarkSeeds",
  body: CatalogBenchmarkSeedFinderReadModel,
): ApiJsonResponse;
function ok(
  routeId: "catalog.opportunities",
  body: CatalogOpportunityRankingReadModel,
): ApiJsonResponse;
function ok(routeId: "reviewer.queue", body: ApiReviewerQueueDashboardResponse): ApiJsonResponse;
function ok(routeId: "reviewer.detail", body: ApiReviewerDetailResponse): ApiJsonResponse;
function ok(
  routeId: "reviewer.batchPreview",
  body: ApiReviewerBatchPreviewResponse,
): ApiJsonResponse;
function ok(
  routeId: "reviewer.batchExecute",
  body: ApiReviewerBatchExecuteResponse,
): ApiJsonResponse;
function ok(routeId: "reviewer.itemAction", body: ApiReviewerSingleActionResponse): ApiJsonResponse;
function ok(routeId: "terminology.search", body: TerminologySearchReadModel): ApiJsonResponse;
function ok(
  routeId: "workspace.projects",
  body: ApiWorkspaceProjectBrowseResponse,
): ApiJsonResponse;
function ok(routeId: "workspace.scenes", body: ApiWorkspaceSceneBrowseResponse): ApiJsonResponse;
function ok(routeId: "workspace.assets", body: ApiWorkspaceAssetBrowseResponse): ApiJsonResponse;
function ok(routeId: "workspace.comparison", body: ApiWorkspaceComparisonResponse): ApiJsonResponse;
function ok(routeId: "workspace.search", body: ApiWorkspaceSearchResponse): ApiJsonResponse;
function ok(
  routeId: "workspace.correctionPreview",
  body: ApiWorkspaceCorrectionPreviewResponse,
): ApiJsonResponse;
function ok(
  routeId: "workspace.correctionSubmit",
  body: ApiWorkspaceCorrectionSubmitResponse,
): ApiJsonResponse;
function ok(routeId: "projects.status", body: ProjectDashboardStatus): ApiJsonResponse;
function ok(routeId: "projects.decisions", body: DashboardDecisionReadModel): ApiJsonResponse;
function ok(routeId: "projects.cost", body: ProjectCostReport): ApiJsonResponse;
function ok(routeId: "projects.benchmarks", body: ApiBenchmarkReportsResponse): ApiJsonResponse;
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
  if (
    error instanceof AssetLocalizationDecisionRepositoryError &&
    error.code === "asset_decision_not_found"
  ) {
    return errorBody(404, "not_found", error.message);
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
