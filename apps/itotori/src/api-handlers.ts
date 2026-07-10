import {
  AssetLocalizationDecisionRepositoryError,
  AuthorizationError,
  RuntimeRunNotFoundError,
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
  type CatalogContextPanelCatalogReadModel,
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
  type CostDrilldownFilter,
  type CostDrilldownPage,
  type DashboardDecisionReadModel,
  feedbackContextStatusValues,
  type JobsRunTableReadModel,
  type LoadJobsRunTableOptions,
  type ModelRoutingSettingsRecord,
  type Permission,
  type ProjectCostReport,
  type ProjectDashboardStatus,
  type ProjectTelemetryTimeseries,
  type QueueHealthReadModel,
  type AuthSessionAdminRecord,
  type AuthAccountSeatUsageRecord,
  type LoadQueueHealthOptions,
  type ActorIdentityRecord,
  type MemberInvitationRecord,
  type MemberRecord,
  type PermissionSetRecord,
  type RuntimeDashboardStatus,
  type SaveModelRoutingSettingsInput,
  type TerminologySearchInput,
  type TerminologySearchReadModel,
  type WikiEntriesFilter,
  type WikiEntriesReadModel,
  wikiEntryKindValues,
} from "@itotori/db";
import {
  resolveStudioCapabilityPermissionView,
  type ItotoriAuthorizationPort,
  type ReviewerQueuePermissionView,
} from "./auth.js";
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
  parseSaveBranchPolicySettingsRequest,
  parseSaveModelRoutingSettingsRequest,
  parseConfigureAuthSsoSettingsRequest,
  parseAcceptMemberInvitationRequest,
  parseInviteMemberRequest,
  parseRemoveMemberRequest,
  parsePrincipalPermissionSetGrantRequest,
  parseRevokeAuthSessionRequest,
  parseLaunchPassRequest,
  parsePlaySetSceneCoverageRequest,
  parsePlayFlagAnnotationRequest,
  parseWorkspaceCorrectionSubmitRequest,
  type ApiAuthCapabilitiesResponse,
  type ApiAuthBillingSeatUsageResponse,
  type ApiAuthIdentityResponse,
  type ApiDraftBranchResponse,
  type ApiErrorResponse,
  type ApiLaunchPassResponse,
  type ApiPlayRouteMapResponse,
  type ApiPlayFlagAnnotationResponse,
  type ApiPlaySceneCoverageResponse,
  type ApiPlaySetSceneCoverageResponse,
  type ApiConfigureAuthSsoSettingsRequest,
  type ApiConfigureAuthSsoSettingsResponse,
  type ApiAcceptMemberInvitationRequest,
  type ApiAssetDecisionsResponse,
  type ApiCatalogContextPanelResponse,
  type ApiBenchmarkReportsResponse,
  type ApiCandidateAssetsResponse,
  type ApiInviteMemberRequest,
  type ApiProjectOverviewResponse,
  type ApiProjectImportResponse,
  type ApiProjectsResponse,
  type ApiJobsRunTableResponse,
  type ApiQueueHealthResponse,
  type ApiMemberInvitationResponse,
  type ApiMemberRecord,
  type ApiMemberResponse,
  type ApiMembersListResponse,
  type ApiPermissionSetRecord,
  type ApiPermissionSetsListResponse,
  type ApiPrincipalPermissionSetGrantRequest,
  type ApiPrincipalPermissionSetGrantResponse,
  type ApiRemoveMemberRequest,
  type ApiRemoveMemberResponse,
  type ApiAuthSessionRecord,
  type ApiAuthSessionsListResponse,
  type ApiRevokeAuthSessionRequest,
  type ApiRevokeAuthSessionResponse,
  type ApiModelRoutingSettingsResponse,
  type ApiBranchPolicySettingsResponse,
  type ApiSaveBranchPolicySettingsRequest,
  type ApiReviewerBatchExecuteResponse,
  type ApiReviewerBatchPreviewResponse,
  type ApiReviewerSingleActionResponse,
  type ApiReviewerDetailResponse,
  type ApiReviewerQueueDashboardResponse,
  type ItotoriApiResponseBody,
  type ItotoriApiRouteId,
} from "./api-schema.js";
import {
  SceneCoverageServiceError,
  type SceneCoverageServicePort,
} from "./play/scene-coverage-service.js";
import type { RouteMapReadModelPort } from "./play/route-map-read-model.js";
import { buildPlayFlagFeedbackInput, type PlayFlagSeverity } from "./play/flag-annotation.js";
import type { ManualFeedbackImportPort } from "./manual-feedback.js";
import {
  redactProjectOverviewReadModel,
  type ProjectOverviewReadModelOptions,
} from "./project-overview-read-model.js";
import type {
  BenchmarkRecordResult,
  DecisionRecordResult,
  FindingRecordResult,
  ItotoriProjectWorkflowPort,
  LaunchLocalizationPassResult,
  RuntimeIngestResult,
} from "./services/project-workflow.js";
import {
  ProjectMutationScopeError,
  requireOwnedBranchScope,
  resolveProjectMutationScope,
} from "./services/project-mutation-scope.js";
import { reviewerDetailDiagnosticCodeValues } from "./reviewer/detail-fixtures.js";
import { emptyReviewerDetailEvidence } from "./reviewer/detail-route.js";
import type { ReviewerQueueApiServicePort } from "./reviewer/api-service.js";
import { reviewerBatchPreviewStatusValues } from "./reviewer/batch-preview.js";
import type {
  LocalizationWorkspaceApiServicePort,
  LoadWorkspaceSearchInput,
} from "./workspace/api-service.js";
import type { WorkspaceCorrectionServicePort } from "./workspace/correction-service.js";
import { workspaceSearchModeValues } from "./workspace/read-model.js";
import type { BmkCockpitReadModel, BmkCockpitRunHistoryPage } from "./bmk-cockpit-read-model.js";
import type { CatalogContextPanelReadModel } from "./catalog-context-panel.js";
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
  // ovw-launch-pass-action — the `canSteer` steer permission is `draft.write`:
  // launching the next pass drives the drafting of pass N+1, the same authority
  // that protects the draft workflow + the pass ledger.
  launchPass: apiMutationGate("launch pass", "draftWrite"),
  ssoSettingsConfigure: apiMutationGate("SSO settings configure", "authSsoManage"),
  modelRoutingRead: apiMutationGate("model routing read", "catalogRead"),
  modelRoutingSave: apiMutationGate("model routing save", "draftWrite"),
  branchPolicyRead: apiMutationGate("branch policy read", "catalogRead"),
  branchPolicySave: apiMutationGate("branch policy save", "draftWrite"),
  membersList: apiMutationGate("members list", "authMembersManage"),
  billingSeatUsage: apiMutationGate("billing seat usage", "authMembersManage"),
  membersInvite: apiMutationGate("members invite", "authMembersManage"),
  membersAccept: apiMutationGate("members accept", "authMembersManage"),
  membersRemove: apiMutationGate("members remove", "authMembersManage"),
  permissionSetsList: apiMutationGate("permission sets list", "authPermissionsManage"),
  permissionSetsGrant: apiMutationGate("permission set grant", "authPermissionsManage"),
  permissionSetsRevoke: apiMutationGate("permission set revoke", "authPermissionsManage"),
  sessionsList: apiMutationGate("sessions list", "authSessionsManage"),
  sessionsRevoke: apiMutationGate("sessions revoke", "authSessionsManage"),
  setSceneCoverage: apiMutationGate("set scene coverage", "queueManage"),
  // play-flag-composer — canFlag is feedback.import (playtester flags into
  // the reviewer queue via ManualFeedbackImport).
  flagAnnotation: apiMutationGate("play flag annotation", "feedbackImport"),
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

/**
 * ITOTORI-043 — the read/query dependencies exposed to the READ-ONLY (query)
 * API handlers. This is a least-privilege surface: it deliberately picks ONLY
 * the read methods of each shared service, so a query handler that receives an
 * {@link ItotoriReadOnlyApiServices} is *structurally* (type-level) unable to
 * reach a mutation — `reviewerQueue.executeBatch`,
 * `workspaceCorrections.submitCorrections`, `projectWorkflow.draftProject`,
 * etc. are not on the type. The default read-only factory
 * (`readOnlyApiServices` / `withDatabaseReadOnlyApiServices` in
 * `services/database-services.ts`) additionally narrows at RUNTIME (the
 * produced object carries no mutation methods), reusing the same shared
 * service instances rather than re-wiring repositories.
 */
export type ItotoriReadOnlyApiServices = {
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
    catalogContextPanelForWork(input: {
      workId: string;
      targetLanguage: string;
    }): Promise<CatalogContextPanelCatalogReadModel | null>;
    catalogOpportunityRanking(
      filter?: CatalogOpportunityRankingFilter,
    ): Promise<CatalogOpportunityRankingReadModel>;
  };
  terminologyRepository: {
    searchTerms(input: TerminologySearchInput): Promise<TerminologySearchReadModel>;
  };
  wikiRepository: {
    loadEntries(input: WikiEntriesFilter): Promise<WikiEntriesReadModel>;
  };
  reviewerQueue: Pick<ReviewerQueueApiServicePort, "loadDashboard" | "loadDetailContext">;
  workspace: LocalizationWorkspaceApiServicePort;
  workspaceCorrections: Pick<WorkspaceCorrectionServicePort, "loadPreview">;
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
    | "listLocaleBranchIdentities"
    | "getDashboardStatus"
    | "getDashboardDecisions"
    | "getProjectOverview"
    | "getRuntimeStatus"
    | "getCostReport"
    | "getCostDrilldown"
    | "getBenchmarkReports"
  >;
  /**
   * ITOTORI-047 — the queue-health read-model loader powering the
   * `queue.health` route (operator inspection of outbox/job lag, retries,
   * dead-letter). Read-only; gated on `queue.read` inside the repository.
   */
  queueHealth: {
    loadQueueHealth(options?: LoadQueueHealthOptions): Promise<QueueHealthReadModel>;
  };
  jobs: {
    loadRunTable(options?: LoadJobsRunTableOptions): Promise<JobsRunTableReadModel>;
  };
  benchmarkCockpit: {
    loadCockpit(input: {
      projectId: string;
      runId?: string;
      localeBranchId?: string | null;
    }): Promise<BmkCockpitReadModel>;
    loadHistory(input: {
      projectId: string;
      localeBranchId?: string | null;
      limit?: number;
      offset?: number;
    }): Promise<BmkCockpitRunHistoryPage>;
  };
  authMembers: {
    listMembers(accountId: string): Promise<readonly MemberRecord[]>;
  };
  modelRouting: {
    loadSettings(projectId: string): Promise<ModelRoutingSettingsRecord>;
  };
  branchPolicy: {
    loadSettings(input: {
      projectId: string;
      localeBranchId: string;
    }): Promise<ApiBranchPolicySettingsResponse>;
  };
  authBilling: {
    loadSeatUsage(accountId: string): Promise<AuthAccountSeatUsageRecord>;
  };
  authPermissions: {
    listPermissionSets(accountId: string): Promise<readonly PermissionSetRecord[]>;
  };
  authIdentity: {
    loadIdentity(): Promise<ActorIdentityRecord>;
  };
  /**
   * play-routemap-ui — Play RouteMap route/choice tree read-model composed
   * from routeMaps / routeChoices (coverage from map status).
   */
  playRouteMap: RouteMapReadModelPort;
  sceneCoverage: Pick<SceneCoverageServicePort, "loadRouteMapCoverage">;
};

/**
 * The full dependency surface for the API handler entrypoint. It is the
 * read-only surface {@link ItotoriReadOnlyApiServices} INTERSECTED with the
 * mutation methods the write (POST) handlers need. The intersection keeps the
 * read picks and adds the mutation picks, so `reviewerQueue` /
 * `workspaceCorrections` resolve to their full ports and `projectWorkflow`
 * gains the record/draft/ingest writes.
 */
export type ItotoriApiServices = ItotoriReadOnlyApiServices & {
  reviewerQueue: ReviewerQueueApiServicePort;
  workspaceCorrections: WorkspaceCorrectionServicePort;
  projectWorkflow: Pick<
    ItotoriProjectWorkflowPort,
    | "listLocaleBranchIdentities"
    | "getDashboardStatus"
    | "getDashboardDecisions"
    | "getRuntimeStatus"
    | "getCostReport"
    | "getCostDrilldown"
    | "getBenchmarkReports"
    | "importBridge"
    | "draftProject"
    | "recordFinding"
    | "recordDecision"
    | "recordBenchmarkReport"
    | "ingestRuntimeReport"
    | "launchNextLocalizationPass"
  >;
  authSsoSettings: {
    configureSettings(input: ApiConfigureAuthSsoSettingsRequest): Promise<{
      accountId: string;
      provider: ApiConfigureAuthSsoSettingsRequest["provider"];
      security: ApiConfigureAuthSsoSettingsRequest["security"];
      sessionPolicy: ApiConfigureAuthSsoSettingsRequest["sessionPolicy"];
      updatedAt: Date;
    }>;
  };
  modelRouting: {
    loadSettings(projectId: string): Promise<ModelRoutingSettingsRecord>;
    saveRoute(input: SaveModelRoutingSettingsInput): Promise<ModelRoutingSettingsRecord>;
  };
  branchPolicy: {
    loadSettings(input: {
      projectId: string;
      localeBranchId: string;
    }): Promise<ApiBranchPolicySettingsResponse>;
    saveSettings(
      input: ApiSaveBranchPolicySettingsRequest,
    ): Promise<ApiBranchPolicySettingsResponse>;
  };
  authMembers: {
    listMembers(accountId: string): Promise<readonly MemberRecord[]>;
    inviteMember(input: ApiInviteMemberRequest): Promise<MemberInvitationRecord>;
    acceptInvitation(
      invitationId: string,
      input: ApiAcceptMemberInvitationRequest,
    ): Promise<MemberRecord>;
    removeMember(membershipId: string, input: ApiRemoveMemberRequest): Promise<MemberRecord>;
  };
  authBilling: {
    loadSeatUsage(accountId: string): Promise<AuthAccountSeatUsageRecord>;
  };
  authPermissions: {
    listPermissionSets(accountId: string): Promise<readonly PermissionSetRecord[]>;
    grantPermissionSet(input: {
      principalId: string;
      permissionSetId: string;
      request: ApiPrincipalPermissionSetGrantRequest;
    }): Promise<MemberRecord>;
    revokePermissionSet(input: {
      principalId: string;
      permissionSetId: string;
      request: ApiPrincipalPermissionSetGrantRequest;
    }): Promise<MemberRecord>;
  };
  authSessions: {
    listPrincipalSessions(principalId: string): Promise<readonly AuthSessionAdminRecord[]>;
    revokePrincipalSession(
      principalId: string,
      sessionId: string,
      input: ApiRevokeAuthSessionRequest,
    ): Promise<AuthSessionAdminRecord>;
  };
  sceneCoverage: SceneCoverageServicePort;
  /** play-flag-composer — ManualFeedbackImport creates the reviewer queue item. */
  manualFeedback: ManualFeedbackImportPort;
};

/**
 * ITOTORI-043 — project the full API service surface down to the read-only
 * surface, copying ONLY the read methods. The result reuses the same
 * underlying shared service instances (each method delegates to
 * `services.*`); it never re-wires a repository. Because the returned object
 * literally has no mutation methods, a read handler holding it is unable to
 * reach a mutation at runtime as well as at the type level.
 */
export function readOnlyApiServices(services: ItotoriApiServices): ItotoriReadOnlyApiServices {
  return {
    // The authorization port already exposes only `requirePermission` on the
    // API surface (no mutation methods to strip), so it is reused as-is.
    authorization: services.authorization,
    catalogRepository: {
      catalogConflictReview: (filter) => services.catalogRepository.catalogConflictReview(filter),
      catalogCompletenessBenchmarkPools: (filter) =>
        services.catalogRepository.catalogCompletenessBenchmarkPools(filter),
      catalogBenchmarkSeedFinder: (filter) =>
        services.catalogRepository.catalogBenchmarkSeedFinder(filter),
      catalogContextPanelForWork: (input) =>
        services.catalogRepository.catalogContextPanelForWork(input),
      catalogOpportunityRanking: (filter) =>
        services.catalogRepository.catalogOpportunityRanking(filter),
    },
    terminologyRepository: {
      searchTerms: (input) => services.terminologyRepository.searchTerms(input),
    },
    wikiRepository: {
      loadEntries: (input) => services.wikiRepository.loadEntries(input),
    },
    reviewerQueue: {
      loadDashboard: (input) => services.reviewerQueue.loadDashboard(input),
      loadDetailContext: (input) => services.reviewerQueue.loadDetailContext(input),
    },
    workspace: services.workspace,
    workspaceCorrections: {
      loadPreview: (input) => services.workspaceCorrections.loadPreview(input),
    },
    assetDecisions: {
      loadActiveDecisions: (projectId, localeBranchId, opts) =>
        services.assetDecisions.loadActiveDecisions(projectId, localeBranchId, opts),
      loadCandidateAssets: (projectId, localeBranchId, opts) =>
        services.assetDecisions.loadCandidateAssets(projectId, localeBranchId, opts),
    },
    projectWorkflow: {
      listLocaleBranchIdentities: (projectId) =>
        services.projectWorkflow.listLocaleBranchIdentities(projectId),
      getDashboardStatus: () => services.projectWorkflow.getDashboardStatus(),
      getProjectOverview: (options) => services.projectWorkflow.getProjectOverview(options),
      getDashboardDecisions: (projectId) =>
        services.projectWorkflow.getDashboardDecisions(projectId),
      getRuntimeStatus: (runtimeRunId) => services.projectWorkflow.getRuntimeStatus(runtimeRunId),
      getCostReport: (projectId) => services.projectWorkflow.getCostReport(projectId),
      getCostDrilldown: (filter) => services.projectWorkflow.getCostDrilldown(filter),
      getBenchmarkReports: (projectId) => services.projectWorkflow.getBenchmarkReports(projectId),
    },
    queueHealth: {
      loadQueueHealth: (options) => services.queueHealth.loadQueueHealth(options),
    },
    jobs: {
      loadRunTable: (options) => services.jobs.loadRunTable(options),
    },
    benchmarkCockpit: {
      loadCockpit: (input) => services.benchmarkCockpit.loadCockpit(input),
      loadHistory: (input) => services.benchmarkCockpit.loadHistory(input),
    },
    authMembers: {
      listMembers: (accountId) => services.authMembers.listMembers(accountId),
    },
    modelRouting: {
      loadSettings: (projectId) => services.modelRouting.loadSettings(projectId),
    },
    branchPolicy: {
      loadSettings: (input) => services.branchPolicy.loadSettings(input),
    },
    authBilling: {
      loadSeatUsage: (accountId) => services.authBilling.loadSeatUsage(accountId),
    },
    authPermissions: {
      listPermissionSets: (accountId) => services.authPermissions.listPermissionSets(accountId),
    },
    authIdentity: {
      loadIdentity: () => services.authIdentity.loadIdentity(),
    },
    playRouteMap: {
      loadRouteMap: (input) => services.playRouteMap.loadRouteMap(input),
    },
    sceneCoverage: {
      loadRouteMapCoverage: (input) => services.sceneCoverage.loadRouteMapCoverage(input),
    },
  };
}

/**
 * ITOTORI-043 — the dependency shared by every permission helper: only the
 * authorization port is needed to gate a route, so both the read-only and the
 * full service surfaces satisfy it.
 */
type ApiAuthorizationDependency = {
  authorization: Pick<ItotoriAuthorizationPort, "requirePermission">;
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

/**
 * itotori-043-followup-transport-level-readonly-routing — the
 * transport-level READ-ONLY entrypoint for GET requests. It receives ONLY
 * the {@link ItotoriReadOnlyApiServices} surface, so a GET served through
 * this entrypoint is STRUCTURALLY unable to reach a mutation service
 * (`draftProject`, `executeBatch`, `submitCorrections`, …): the dependency
 * object literally has no mutation methods. The server transport
 * (`server.ts`) constructs GET requests through the read-only DB factory
 * (`withDatabaseReadOnlyApiServices`) and dispatches them here, so the
 * least-privilege guarantee holds at the transport boundary, not just
 * handler-internally.
 *
 * Behavior preserves {@link handleItotoriApiRequest} for GET requests: a
 * GET read route resolves identically, a GET on a mutation path still
 * returns the same `405 method_not_allowed`, and an unknown GET still
 * returns `404`.
 */
export async function handleReadOnlyItotoriApiRequest(
  request: ItotoriApiRequest,
  services: ItotoriReadOnlyApiServices,
): Promise<ApiJsonResponse> {
  try {
    const readOnlyResponse = await routeReadOnlyItotoriApiRequest(request, services);
    if (readOnlyResponse !== null) {
      return readOnlyResponse;
    }
    return readOnlyMutationPathResponse(request);
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * itotori-043-followup-transport-level-readonly-routing — the
 * method-not-allowed / not-found response for a GET that did not match a
 * read route. It mirrors the wrong-method gating the mutation router
 * ({@link routeItotoriApiRequest}) applies, so a GET on a mutation path
 * keeps returning `405 method_not_allowed` (not `404`) now that GET
 * requests are dispatched through the read-only entrypoint. The checks are
 * pure path/method — no service method is invoked — so the read-only
 * surface is sufficient.
 */
function readOnlyMutationPathResponse(request: ItotoriApiRequest): ApiJsonResponse {
  if (
    request.pathname === "/api/reviewer/queue/batch-preview" ||
    request.pathname === "/api/reviewer/queue/batch-confirm" ||
    parseReviewerSingleActionApiRoute(request.pathname) !== null
  ) {
    return methodNotAllowed(["POST"]);
  }
  if (request.pathname === "/api/settings/security/sso") {
    return methodNotAllowed(["POST"]);
  }
  if (request.pathname === "/api/settings/model-routing") {
    return methodNotAllowed(["GET", "POST"]);
  }
  if (parseBranchPolicySettingsApiRoute(request.pathname) !== null) {
    return methodNotAllowed(["GET", "POST"]);
  }
  if (
    request.pathname === "/api/auth/members/invitations" ||
    parseAuthMemberAcceptRoute(request.pathname) !== null ||
    parseAuthMemberRemoveRoute(request.pathname) !== null
  ) {
    return methodNotAllowed(["POST"]);
  }
  if (
    parseAuthPermissionSetGrantRoute(request.pathname) !== null ||
    parseAuthPermissionSetRevokeRoute(request.pathname) !== null
  ) {
    return methodNotAllowed(["POST"]);
  }
  if (parseSceneCoverageApiRoute(request.pathname) !== null) {
    return methodNotAllowed(["GET", "POST"]);
  }
  if (parsePlayFlagApiRoute(request.pathname) !== null) {
    return methodNotAllowed(["POST"]);
  }
  if (parseCatalogContextPanelApiRoute(request.pathname) !== null) {
    return methodNotAllowed(["GET"]);
  }
  if (parseProjectRoute(request.pathname) !== null) {
    return methodNotAllowed(["POST"]);
  }
  return notFound(request.pathname);
}

async function routeItotoriApiRequest(
  request: ItotoriApiRequest,
  services: ItotoriApiServices,
): Promise<ApiJsonResponse> {
  // ITOTORI-043 — read (query) routes are served by a handler that receives
  // ONLY the read-only dependency surface, so it is structurally unable to
  // reach a mutation service. It returns null when the request is not a read
  // route it owns, deferring to the mutation routing below.
  const readOnlyResponse = await routeReadOnlyItotoriApiRequest(
    request,
    readOnlyApiServices(services),
  );
  if (readOnlyResponse !== null) {
    return readOnlyResponse;
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

  if (request.method === "POST" && request.pathname === "/api/workspace/corrections") {
    const body = parseWorkspaceCorrectionSubmitRequest(request.body);
    const permission = await resolveApiReviewerQueuePermissionView(services, body.actorUserId);
    return ok(
      "workspace.correctionSubmit",
      await services.workspaceCorrections.submitCorrections({ ...body, permission }),
    );
  }

  const setSceneCoverageRoute = parseSceneCoverageApiRoute(request.pathname);
  if (request.method === "POST" && setSceneCoverageRoute !== null) {
    const body = parsePlaySetSceneCoverageRequest(request.body);
    await requireApiPermission(services, apiMutationPermissionGates.setSceneCoverage);
    const scope = await requireOwnedBranchScope(services.projectWorkflow, {
      projectId: setSceneCoverageRoute.projectId,
      localeBranchId: setSceneCoverageRoute.localeBranchId,
    });
    const actorUserId = "local-user";
    const result = await services.sceneCoverage.setSceneCoverage({
      actor: { userId: actorUserId },
      projectId: scope.projectId,
      localeBranchId: scope.localeBranchId,
      sceneId: body.sceneId,
      coverageState: body.coverageState,
      updatedByUserId: actorUserId,
    });
    return ok("play.setSceneCoverage", result);
  }

  const flagRoute = parsePlayFlagApiRoute(request.pathname);
  if (request.method === "POST" && flagRoute !== null) {
    const body = parsePlayFlagAnnotationRequest(request.body);
    await requireApiPermission(services, apiMutationPermissionGates.flagAnnotation);
    const scope = await requireOwnedBranchScope(services.projectWorkflow, {
      projectId: flagRoute.projectId,
      localeBranchId: flagRoute.localeBranchId,
    });
    const actorUserId = body.actorUserId ?? "local-user";
    const importInput = buildPlayFlagFeedbackInput({
      projectId: scope.projectId,
      localeBranchId: scope.localeBranchId,
      targetLocale: body.targetLocale,
      note: body.note,
      severity: body.severity as PlayFlagSeverity,
      actorUserId,
      ...(body.category === undefined ? {} : { category: body.category }),
      ...(body.bridgeUnitId === undefined ? {} : { bridgeUnitId: body.bridgeUnitId }),
      ...(body.sourceUnitKey === undefined ? {} : { sourceUnitKey: body.sourceUnitKey }),
      ...(body.sourceBundleId === undefined ? {} : { sourceBundleId: body.sourceBundleId }),
      ...(body.sourceRevisionId === undefined ? {} : { sourceRevisionId: body.sourceRevisionId }),
      ...(body.sceneId === undefined ? {} : { sceneId: body.sceneId }),
      ...(body.suggestedEdit === undefined ? {} : { suggestedEdit: body.suggestedEdit }),
      ...(body.actorDisplayName === undefined ? {} : { actorDisplayName: body.actorDisplayName }),
    });
    const result = await services.manualFeedback.importManualFeedback(importInput);
    const response: ApiPlayFlagAnnotationResponse = {
      schemaVersion: "itotori.play.flag-annotation.v0",
      projectId: scope.projectId,
      localeBranchId: scope.localeBranchId,
      feedbackReportId: result.feedbackReportId,
      feedbackEvidenceId: result.feedbackEvidenceId,
      severity: body.severity,
      category: (body.category ?? "").trim(),
      note: body.note.trim(),
      triageLabel: result.triageLabel,
      contextStatus: result.contextStatus,
      queueEnqueued:
        !result.duplicate && result.contextStatus === feedbackContextStatusValues.contextualized,
      duplicate: result.duplicate,
    };
    return ok("play.flagAnnotation", response);
  }

  if (
    request.pathname === "/api/workspace/corrections" &&
    request.method !== "GET" &&
    request.method !== "POST"
  ) {
    return methodNotAllowed(["GET", "POST"]);
  }

  if (
    request.pathname === "/api/reviewer/queue/batch-preview" ||
    request.pathname === "/api/reviewer/queue/batch-confirm" ||
    reviewerSingleActionRoute !== null
  ) {
    return methodNotAllowed(["POST"]);
  }

  if (request.method === "POST" && request.pathname === "/api/imports/bridge") {
    const body = parseProjectImportRequest(request.body);
    await requireApiPermission(services, apiMutationPermissionGates.bridgeImport);
    const project = await services.projectWorkflow.importBridge(body.bridge);
    const status = await services.projectWorkflow.getDashboardStatus();
    // gate-mutation-route-status-echo — the success body echoes the full
    // dashboard status, which embeds cost.recentRuns (provider/model/routing
    // internals) + translation-memory reuse events. REDACT that echo to the
    // public summary UNLESS the caller holds catalog.read, the same gate the
    // sibling read routes (/api/projects, /status, /cost) enforce — so the
    // HTTP boundary agrees regardless of which route carries the status.
    const canReadStatus = await resolveProjectReadPermission(services);
    return ok("imports.bridge", {
      project,
      status: canReadStatus ? status : redactProjectDashboardStatus(status),
    });
  }

  if (request.method === "POST" && request.pathname === "/api/settings/security/sso") {
    const body = parseConfigureAuthSsoSettingsRequest(request.body);
    await requireApiPermission(services, apiMutationPermissionGates.ssoSettingsConfigure);
    const result = await services.authSsoSettings.configureSettings(body);
    return ok("auth.ssoSettings.configure", authSsoSettingsResponseBody(result));
  }

  if (request.method === "POST" && request.pathname === "/api/settings/model-routing") {
    const body = parseSaveModelRoutingSettingsRequest(request.body);
    await requireApiPermission(services, apiMutationPermissionGates.modelRoutingSave);
    return ok(
      "settings.modelRouting.save",
      modelRoutingSettingsResponseBody(await services.modelRouting.saveRoute(body)),
    );
  }

  const branchPolicyRoute = parseBranchPolicySettingsApiRoute(request.pathname);
  if (request.method === "POST" && branchPolicyRoute !== null) {
    const body = parseSaveBranchPolicySettingsRequest(request.body);
    if (
      body.projectId !== branchPolicyRoute.projectId ||
      body.localeBranchId !== branchPolicyRoute.localeBranchId
    ) {
      throw new ApiValidationError("branch policy path and body scope must match");
    }
    await requireApiPermission(services, apiMutationPermissionGates.branchPolicySave);
    const scope = await requireOwnedBranchScope(services.projectWorkflow, {
      projectId: branchPolicyRoute.projectId,
      localeBranchId: branchPolicyRoute.localeBranchId,
    });
    return ok(
      "settings.branchPolicy.save",
      await services.branchPolicy.saveSettings({
        ...body,
        projectId: scope.projectId,
        localeBranchId: scope.localeBranchId,
      }),
    );
  }

  if (request.pathname === "/api/settings/security/sso") {
    return methodNotAllowed(["POST"]);
  }
  if (request.pathname === "/api/settings/model-routing") {
    return methodNotAllowed(["GET", "POST"]);
  }
  if (branchPolicyRoute !== null) {
    return methodNotAllowed(["GET", "POST"]);
  }

  if (request.method === "POST" && request.pathname === "/api/auth/members/invitations") {
    const body = parseInviteMemberRequest(request.body);
    await requireApiPermission(services, apiMutationPermissionGates.membersInvite);
    return ok(
      "auth.members.invite",
      memberInvitationResponseBody(await services.authMembers.inviteMember(body)),
    );
  }

  const memberAcceptRoute = parseAuthMemberAcceptRoute(request.pathname);
  if (request.method === "POST" && memberAcceptRoute !== null) {
    const body = parseAcceptMemberInvitationRequest(request.body);
    await requireApiPermission(services, apiMutationPermissionGates.membersAccept);
    return ok(
      "auth.members.accept",
      memberResponseBody(
        memberRecordBody(
          await services.authMembers.acceptInvitation(memberAcceptRoute.invitationId, body),
        ),
      ),
    );
  }

  const memberRemoveRoute = parseAuthMemberRemoveRoute(request.pathname);
  if (request.method === "POST" && memberRemoveRoute !== null) {
    const body = parseRemoveMemberRequest(request.body);
    await requireApiPermission(services, apiMutationPermissionGates.membersRemove);
    return ok(
      "auth.members.remove",
      removeMemberResponseBody(
        memberRecordBody(
          await services.authMembers.removeMember(memberRemoveRoute.membershipId, body),
        ),
      ),
    );
  }

  const permissionSetGrantRoute = parseAuthPermissionSetGrantRoute(request.pathname);
  if (request.method === "POST" && permissionSetGrantRoute !== null) {
    const body = parsePrincipalPermissionSetGrantRequest(request.body);
    await requireApiPermission(services, apiMutationPermissionGates.permissionSetsGrant);
    const updatedMember = await services.authPermissions.grantPermissionSet({
      principalId: permissionSetGrantRoute.principalId,
      permissionSetId: permissionSetGrantRoute.permissionSetId,
      request: body,
    });
    return ok(
      "auth.permissionSets.grant",
      principalPermissionSetGrantResponseBody({
        principalId: permissionSetGrantRoute.principalId,
        permissionSetId: permissionSetGrantRoute.permissionSetId,
        action: "granted",
        updatedMember: memberRecordBody(updatedMember),
      }),
    );
  }

  const permissionSetRevokeRoute = parseAuthPermissionSetRevokeRoute(request.pathname);
  if (request.method === "POST" && permissionSetRevokeRoute !== null) {
    const body = parsePrincipalPermissionSetGrantRequest(request.body);
    await requireApiPermission(services, apiMutationPermissionGates.permissionSetsRevoke);
    const updatedMember = await services.authPermissions.revokePermissionSet({
      principalId: permissionSetRevokeRoute.principalId,
      permissionSetId: permissionSetRevokeRoute.permissionSetId,
      request: body,
    });
    return ok(
      "auth.permissionSets.revoke",
      principalPermissionSetGrantResponseBody({
        principalId: permissionSetRevokeRoute.principalId,
        permissionSetId: permissionSetRevokeRoute.permissionSetId,
        action: "revoked",
        updatedMember: memberRecordBody(updatedMember),
      }),
    );
  }

  if (
    request.pathname === "/api/auth/members/invitations" ||
    memberAcceptRoute !== null ||
    memberRemoveRoute !== null ||
    permissionSetGrantRoute !== null ||
    permissionSetRevokeRoute !== null
  ) {
    return methodNotAllowed(["POST"]);
  }

  const authSessionsRoute = parseAuthSessionsRoute(request.pathname);
  if (request.method === "GET" && authSessionsRoute !== null) {
    await requireApiPermission(services, apiMutationPermissionGates.sessionsList);
    return ok("auth.sessions.list", {
      schemaVersion: "itotori.auth.sessions.v0",
      principalId: authSessionsRoute.principalId,
      sessions: (
        await services.authSessions.listPrincipalSessions(authSessionsRoute.principalId)
      ).map(authSessionRecordBody),
    });
  }

  const authSessionRevokeRoute = parseAuthSessionRevokeRoute(request.pathname);
  if (request.method === "POST" && authSessionRevokeRoute !== null) {
    const body = parseRevokeAuthSessionRequest(request.body);
    await requireApiPermission(services, apiMutationPermissionGates.sessionsRevoke);
    return ok("auth.sessions.revoke", {
      schemaVersion: "itotori.auth.session-revoked.v0",
      revokedSession: authSessionRecordBody(
        await services.authSessions.revokePrincipalSession(
          authSessionRevokeRoute.principalId,
          authSessionRevokeRoute.sessionId,
          body,
        ),
      ),
    });
  }

  if (authSessionsRoute !== null || authSessionRevokeRoute !== null) {
    return methodNotAllowed(authSessionRevokeRoute !== null ? ["POST"] : ["GET"]);
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
      // ITOTORI-050 — derive the branch scope from the SERVER-SIDE ownership
      // lookup and write with the authoritative branch id; a client-supplied
      // ProjectState carrying a foreign/forged localeBranchId is refused here
      // before draftProject touches the repository.
      const scope = await requireOwnedBranchScope(services.projectWorkflow, {
        projectId: projectRoute.projectId,
        localeBranchId: body.project.localeBranchId,
      });
      const scopedProject = { ...body.project, localeBranchId: scope.localeBranchId };
      const project = await services.projectWorkflow.draftProject(scopedProject, body.targetLocale);
      const status = await services.projectWorkflow.getDashboardStatus();
      // gate-mutation-route-status-echo — see POST /api/imports/bridge: the
      // success body echoes the full dashboard status, so the same
      // catalog.read gate + redaction applies (recentRuns / recentEvents
      // stripped for a non-holder).
      const canReadStatus = await resolveProjectReadPermission(services);
      return ok("branches.draft", {
        project,
        status: canReadStatus ? status : redactProjectDashboardStatus(status),
      });
    }
    case "findings": {
      const body = parseRecordFindingRequest(request.body);
      await requireApiPermission(services, apiMutationPermissionGates.findingRecord);
      // ITOTORI-050 — verify the project (and, when supplied, the branch)
      // server-side before recording; a foreign/forged branch id is refused.
      const scope = await resolveProjectMutationScope(services.projectWorkflow, {
        projectId: projectRoute.projectId,
        ...(body.localeBranchId === undefined ? {} : { clientLocaleBranchId: body.localeBranchId }),
      });
      const scopedBody = scopeRecordBranch(body, scope.localeBranchId);
      const result = await services.projectWorkflow.recordFinding(scope.projectId, scopedBody);
      return ok("findings.record", result);
    }
    case "decisions": {
      const body = parseRecordDecisionRequest(request.body);
      await requireApiPermission(services, apiMutationPermissionGates.decisionRecord);
      // ITOTORI-050 — verify the project (and, when supplied, the branch)
      // server-side before recording; a foreign/forged branch id is refused.
      const scope = await resolveProjectMutationScope(services.projectWorkflow, {
        projectId: projectRoute.projectId,
        ...(body.localeBranchId === undefined ? {} : { clientLocaleBranchId: body.localeBranchId }),
      });
      const scopedBody = scopeRecordBranch(body, scope.localeBranchId);
      const result = await services.projectWorkflow.recordDecision(scope.projectId, scopedBody);
      return ok("decisions.record", result);
    }
    case "benchmarks": {
      const body = parseRecordBenchmarkRequest(request.body);
      await requireApiPermission(services, apiMutationPermissionGates.benchmarkRecord);
      // ITOTORI-050 — the benchmark self-identifies its branch (the parser
      // already rejects a report without one); verify that branch is
      // server-side owned by the project before recording.
      const benchmarkLocaleBranchId = body.benchmarkReport.localeBranchId;
      if (benchmarkLocaleBranchId === undefined) {
        throw new ApiValidationError(
          "ApiRecordBenchmarkRequest.benchmarkReport.localeBranchId is required",
        );
      }
      const scope = await requireOwnedBranchScope(services.projectWorkflow, {
        projectId: projectRoute.projectId,
        localeBranchId: benchmarkLocaleBranchId,
      });
      const result = await services.projectWorkflow.recordBenchmarkReport(scope.projectId, body);
      return ok("benchmarks.record", result);
    }
    case "runtime-evidence": {
      const body = parseRuntimeEvidenceRequest(request.body);
      assertPathProject(projectRoute.projectId, body.project.projectId);
      await requireApiPermission(services, apiMutationPermissionGates.runtimeEvidenceIngest);
      // ITOTORI-050 — verify the client-supplied ProjectState's branch is
      // server-side owned by the project; write with the authoritative branch
      // id so a forged ProjectState cannot ingest evidence into a foreign
      // branch.
      const scope = await requireOwnedBranchScope(services.projectWorkflow, {
        projectId: projectRoute.projectId,
        localeBranchId: body.project.localeBranchId,
      });
      const scopedProject = { ...body.project, localeBranchId: scope.localeBranchId };
      const result = await services.projectWorkflow.ingestRuntimeReport(
        scopedProject,
        body.runtimeReport,
      );
      return ok("runtimeEvidence.ingest", result.result);
    }
    case "launch-pass": {
      // ovw-launch-pass-action — fold queued corrections + drive the next pass
      // via the driver. `canSteer`-gated (draft.write). The locale branch is
      // VERIFIED server-side against the project's ownership set (a forged
      // branch is refused before the driver runs — ITOTORI-050), then the
      // authoritative branch id is handed to the driver.
      const body = parseLaunchPassRequest(request.body);
      await requireApiPermission(services, apiMutationPermissionGates.launchPass);
      const scope = await requireOwnedBranchScope(services.projectWorkflow, {
        projectId: projectRoute.projectId,
        localeBranchId: body.localeBranchId,
      });
      const outcome = await services.projectWorkflow.launchNextLocalizationPass({
        projectId: scope.projectId,
        localeBranchId: scope.localeBranchId,
      });
      return ok("projects.launchPass", launchPassResponseBody(outcome));
    }
  }
}

/**
 * ovw-launch-pass-action — map the driver outcome to the typed wire envelope.
 * A `refused` outcome is surfaced in-band (null pass/timestamp + the reason) so
 * the Overview strip renders it like any driver response, never a silent 200.
 */
function launchPassResponseBody(outcome: LaunchLocalizationPassResult): ApiLaunchPassResponse {
  if (outcome.outcome === "started") {
    return {
      schemaVersion: "itotori.projects.launch-pass.v0",
      outcome: "started",
      passNumber: outcome.passNumber,
      startedAt: outcome.startedAt.toISOString(),
      refusalMessage: null,
    };
  }
  return {
    schemaVersion: "itotori.projects.launch-pass.v0",
    outcome: "refused",
    passNumber: null,
    startedAt: null,
    refusalMessage: outcome.refusalMessage,
  };
}

function authSsoSettingsResponseBody(input: {
  accountId: string;
  provider: ApiConfigureAuthSsoSettingsRequest["provider"];
  security: ApiConfigureAuthSsoSettingsRequest["security"];
  sessionPolicy: ApiConfigureAuthSsoSettingsRequest["sessionPolicy"];
  updatedAt: Date;
}): ApiConfigureAuthSsoSettingsResponse {
  return {
    schemaVersion: "itotori.auth.sso-settings.v0",
    accountId: input.accountId,
    provider: input.provider,
    security: input.security,
    sessionPolicy: input.sessionPolicy,
    updatedAt: input.updatedAt.toISOString(),
  };
}

function memberInvitationResponseBody(input: {
  invitationId: string;
  accountId: string;
  email: string;
  initialPermissionSetIds: readonly string[];
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}): ApiMemberInvitationResponse {
  return {
    schemaVersion: "itotori.auth.member-invitation.v0",
    invitationId: input.invitationId,
    accountId: input.accountId,
    email: input.email,
    initialPermissionSetIds: [...input.initialPermissionSetIds],
    expiresAt: input.expiresAt.toISOString(),
    acceptedAt: input.acceptedAt?.toISOString() ?? null,
    revokedAt: input.revokedAt?.toISOString() ?? null,
    createdAt: input.createdAt.toISOString(),
  };
}

function memberRecordBody(input: {
  membershipId: string;
  accountId: string;
  userId: string;
  principalId: string;
  email: string | null;
  displayName: string;
  permissionSetIds: readonly string[];
  createdAt: Date | string;
}): ApiMemberRecord {
  return {
    membershipId: input.membershipId,
    accountId: input.accountId,
    userId: input.userId,
    principalId: input.principalId,
    email: input.email,
    displayName: input.displayName,
    permissionSetIds: [...input.permissionSetIds],
    createdAt: input.createdAt instanceof Date ? input.createdAt.toISOString() : input.createdAt,
  };
}

function authSessionRecordBody(input: AuthSessionAdminRecord): ApiAuthSessionRecord {
  return {
    sessionId: input.sessionId,
    principalId: input.principalId,
    createdAt: input.createdAt.toISOString(),
    expiresAt: input.expiresAt.toISOString(),
    revokedAt: input.revokedAt?.toISOString() ?? null,
    isActive: input.isActive,
    deviceLabel: input.deviceLabel,
    userAgent: input.userAgent,
    ipAddress: input.ipAddress,
  };
}

function memberResponseBody(input: ApiMemberRecord): ApiMemberResponse {
  return { schemaVersion: "itotori.auth.member.v0", member: input };
}

function authBillingSeatUsageResponseBody(
  input: AuthAccountSeatUsageRecord,
): ApiAuthBillingSeatUsageResponse {
  return {
    schemaVersion: "itotori.auth.billing-seat-usage.v0",
    accountId: input.accountId,
    planId: input.planId,
    planName: input.planName,
    billingPeriod: input.billingPeriod,
    seatLimit: input.seatLimit,
    includedSeats: input.includedSeats,
    usedSeats: input.usedSeats,
    pendingInvitations: input.pendingInvitations,
    availableSeats: input.availableSeats,
    overSeatLimit: input.overSeatLimit,
    updatedAt: input.updatedAt.toISOString(),
  };
}

function modelRoutingSettingsResponseBody(
  input: ModelRoutingSettingsRecord,
): ApiModelRoutingSettingsResponse {
  return {
    schemaVersion: "itotori.settings.model-routing.v0",
    projectId: input.projectId,
    generatedAt: input.generatedAt.toISOString(),
    providers: input.providers.map((provider) => ({ ...provider })),
    models: input.models.map((model) => ({ ...model })),
    promptPresets: input.promptPresets.map((preset) => ({ ...preset })),
    routes: input.routes.map((route) => ({
      projectId: route.projectId,
      taskKind: route.taskKind,
      providerId: route.providerId,
      modelId: route.modelId,
      modelRegistryId: route.modelRegistryId,
      fallbackModelIds: [...route.fallbackModelIds],
      promptPresetId: route.promptPresetId,
      promptTemplateVersion: route.promptTemplateVersion,
      updatedAt: route.updatedAt.toISOString(),
    })),
  };
}

function removeMemberResponseBody(input: ApiMemberRecord): ApiRemoveMemberResponse {
  return { schemaVersion: "itotori.auth.member-removed.v0", removedMember: input };
}

function permissionSetRecordBody(input: PermissionSetRecord): ApiPermissionSetRecord {
  return {
    permissionSetId: input.permissionSetId,
    accountId: input.accountId,
    name: input.name,
    permissions: [...input.permissions],
  };
}

function permissionSetsListResponseBody(input: {
  accountId: string;
  permissionSets: readonly PermissionSetRecord[];
}): ApiPermissionSetsListResponse {
  return {
    schemaVersion: "itotori.auth.permission-sets.v0",
    accountId: input.accountId,
    permissionSets: input.permissionSets.map(permissionSetRecordBody),
  };
}

function principalPermissionSetGrantResponseBody(input: {
  principalId: string;
  permissionSetId: string;
  action: "granted" | "revoked";
  updatedMember: ApiMemberRecord;
}): ApiPrincipalPermissionSetGrantResponse {
  return {
    schemaVersion: "itotori.auth.permission-set-grant.v0",
    principalId: input.principalId,
    permissionSetId: input.permissionSetId,
    action: input.action,
    updatedMember: input.updatedMember,
  };
}

/**
 * ITOTORI-043 — the READ-ONLY (query) route handler. It receives ONLY the
 * read-only dependency surface, so it is structurally unable to reach a
 * mutation service. It returns an {@link ApiJsonResponse} for every read route
 * it owns (including the `method not allowed` responses for the pure-GET read
 * paths), and `null` when the request should be handled by the mutation
 * routing in {@link routeItotoriApiRequest}.
 */
async function routeReadOnlyItotoriApiRequest(
  request: ItotoriApiRequest,
  services: ItotoriReadOnlyApiServices,
): Promise<ApiJsonResponse | null> {
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

  if (request.method === "GET" && request.pathname === "/api/projects/overview") {
    const canRead = await resolveProjectReadPermission(services);
    // gate — the composed overview is only as strong as its parts. The pass
    // ledger is a `draft.write`-protected read (see the pass-ledger
    // repository), so it must NOT ride the weaker `catalog.read` gate the rest
    // of the overview uses. Resolve the caller's pass-ledger permission and
    // pass it INTO the composition so the ledger is never even read for an
    // unpermitted caller (read within the permission boundary), rather than
    // reading it and stripping it afterward.
    const canReadPassLedger = await resolvePassLedgerReadPermission(services);
    const overview = await services.projectWorkflow.getProjectOverview({
      ...parseProjectOverviewFilter(request.search),
      includePassLedger: canReadPassLedger,
      // ovw-launch-pass-action — surface the caller's steer capability
      // (draft.write, the SAME permission that protects the pass ledger) so the
      // Overview launch-pass action gates itself off the composed payload.
      canSteer: canReadPassLedger,
    });
    return ok(
      "projects.overview",
      canRead
        ? overview
        : redactProjectOverviewReadModel(overview, {
            progress: redactProjectDashboardStatus(overview.progress),
            cost: redactProjectCostReport(overview.cost),
            telemetry: redactProjectTelemetryTimeseries(overview.telemetry),
            costDrilldown: redactCostDrilldownPage(overview.costDrilldown),
          }),
    );
  }

  if (request.method === "GET" && request.pathname === "/api/projects/decisions") {
    return ok("projects.decisions", await services.projectWorkflow.getDashboardDecisions());
  }

  if (request.method === "GET" && request.pathname === "/api/projects/cost") {
    const canRead = await resolveProjectReadPermission(services);
    const cost = await services.projectWorkflow.getCostReport();
    return ok("projects.cost", canRead ? cost : redactProjectCostReport(cost));
  }

  if (request.method === "GET" && request.pathname === "/api/projects/cost/drilldown") {
    // gate-project-status-and-cost-reads — the drilldown rows carry the run
    // ledger + provider/adapter metadata, so an unprivileged caller receives a
    // rows-stripped view (pagination aggregates only), mirroring the cost
    // report's `recentRuns` redaction.
    const canRead = await resolveProjectReadPermission(services);
    const page = await services.projectWorkflow.getCostDrilldown(
      parseCostDrilldownFilter(request.search),
    );
    return ok("projects.costDrilldown", canRead ? page : redactCostDrilldownPage(page));
  }

  if (request.method === "GET" && request.pathname === "/api/projects/benchmarks") {
    return ok("projects.benchmarks", {
      reports: await services.projectWorkflow.getBenchmarkReports(),
    });
  }

  const bmkCockpitRoute = parseBmkCockpitRoute(request.pathname);
  if (request.method === "GET" && bmkCockpitRoute !== null) {
    if (bmkCockpitRoute.resource === "cockpit") {
      return ok(
        "projects.bmkCockpit",
        await services.benchmarkCockpit.loadCockpit({
          projectId: bmkCockpitRoute.projectId,
          ...parseBmkCockpitQuery(request.search),
        }),
      );
    }
    return ok(
      "projects.bmkCockpitHistory",
      await services.benchmarkCockpit.loadHistory({
        projectId: bmkCockpitRoute.projectId,
        ...parseBmkCockpitHistoryQuery(request.search),
      }),
    );
  }

  if (request.method === "GET" && request.pathname === "/api/jobs/run-table") {
    const canRead = await resolveProjectReadPermission(services);
    const page = await services.jobs.loadRunTable(parseJobsRunTableQuery(request.search));
    return ok("jobs.runTable", canRead ? page : redactJobsRunTable(page));
  }

  if (request.method === "GET" && request.pathname === "/api/settings/model-routing") {
    const projectId = parseModelRoutingSettingsQuery(request.search);
    await requireApiPermission(services, apiMutationPermissionGates.modelRoutingRead);
    return ok(
      "settings.modelRouting.get",
      modelRoutingSettingsResponseBody(await services.modelRouting.loadSettings(projectId)),
    );
  }

  const branchPolicyRoute = parseBranchPolicySettingsApiRoute(request.pathname);
  if (request.method === "GET" && branchPolicyRoute !== null) {
    await requireApiPermission(services, apiMutationPermissionGates.branchPolicyRead);
    const scope = await requireOwnedBranchScope(services.projectWorkflow, {
      projectId: branchPolicyRoute.projectId,
      localeBranchId: branchPolicyRoute.localeBranchId,
    });
    return ok(
      "settings.branchPolicy.get",
      await services.branchPolicy.loadSettings({
        projectId: scope.projectId,
        localeBranchId: scope.localeBranchId,
      }),
    );
  }

  if (request.method === "GET" && request.pathname === "/api/auth/members") {
    const accountId = parseAuthMembersListQuery(request.search);
    await requireApiPermission(services, apiMutationPermissionGates.membersList);
    return ok("auth.members.list", {
      schemaVersion: "itotori.auth.members.v0",
      accountId,
      members: (await services.authMembers.listMembers(accountId)).map(memberRecordBody),
    });
  }

  if (request.method === "GET" && request.pathname === "/api/auth/billing/seat-usage") {
    const accountId = parseAuthBillingSeatUsageQuery(request.search);
    await requireApiPermission(services, apiMutationPermissionGates.billingSeatUsage);
    return ok(
      "auth.billing.seatUsage",
      authBillingSeatUsageResponseBody(await services.authBilling.loadSeatUsage(accountId)),
    );
  }

  if (request.method === "GET" && request.pathname === "/api/auth/permission-sets") {
    const accountId = parseAuthPermissionSetsListQuery(request.search);
    await requireApiPermission(services, apiMutationPermissionGates.permissionSetsList);
    return ok(
      "auth.permissionSets.list",
      permissionSetsListResponseBody({
        accountId,
        permissionSets: await services.authPermissions.listPermissionSets(accountId),
      }),
    );
  }

  if (request.method === "GET" && request.pathname === "/api/auth/identity") {
    return ok(
      "auth.identity",
      authIdentityResponseBody(await services.authIdentity.loadIdentity()),
    );
  }

  // fnd-caps-context — the actor's Studio capability permission VIEW
  // (canFlag / canDecide / canSteer / canReveal). Resolved from exact
  // permission grants through the auth-002 effective-permission resolver;
  // never branches on a role name. No permission is required to *read* the
  // view itself (a missing grant simply yields canX=false + a denial reason).
  if (request.method === "GET" && request.pathname === "/api/auth/capabilities") {
    const actorUserId = parseAuthCapabilitiesActorQuery(request.search);
    const view = await resolveStudioCapabilityPermissionView(services.authorization, actorUserId);
    return ok("auth.capabilities", authCapabilitiesResponseBody(view));
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

  if (request.method === "GET" && request.pathname === "/api/wiki/entries") {
    return ok(
      "wiki.entries",
      await services.wikiRepository.loadEntries(parseWikiEntriesQuery(request.search)),
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
    const canReadCatalog = await resolveProjectReadPermission(services);
    const searchInput = parseWorkspaceSearchQuery(request.search);
    return ok(
      "workspace.search",
      await services.workspace.loadSearch({ ...searchInput, permission, canReadCatalog }),
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

  const playRouteMapRoute = parsePlayRouteMapApiRoute(request.pathname);
  if (request.method === "GET" && playRouteMapRoute !== null) {
    const scope = await requireOwnedBranchScope(services.projectWorkflow, {
      projectId: playRouteMapRoute.projectId,
      localeBranchId: playRouteMapRoute.localeBranchId,
    });
    const model = await services.playRouteMap.loadRouteMap({
      actor: { userId: "local-user" },
      projectId: scope.projectId,
      localeBranchId: scope.localeBranchId,
    });
    return ok("play.routeMap", model);
  }

  const catalogContextRoute = parseCatalogContextPanelApiRoute(request.pathname);
  if (request.method === "GET" && catalogContextRoute !== null) {
    const scope = await requireOwnedBranchScope(services.projectWorkflow, {
      projectId: catalogContextRoute.projectId,
      localeBranchId: catalogContextRoute.localeBranchId,
    });
    const dashboard = await services.projectWorkflow.getDashboardStatus();
    if (dashboard.projectId !== scope.projectId) {
      return errorBody(
        404,
        "not_found",
        `project dashboard status for ${scope.projectId} is not loaded`,
      );
    }
    const localeBranch =
      dashboard.localeBranches.find((branch) => branch.localeBranchId === scope.localeBranchId) ??
      null;
    if (localeBranch === null) {
      return errorBody(
        404,
        "not_found",
        `locale branch ${scope.localeBranchId} is not present in project dashboard status`,
      );
    }
    const catalog = await services.catalogRepository.catalogContextPanelForWork({
      workId: catalogContextRoute.workId,
      targetLanguage: localeBranch.targetLocale,
    });
    if (catalog === null) {
      return errorBody(
        404,
        "not_found",
        `catalog context for work ${catalogContextRoute.workId} was not found`,
      );
    }
    return ok(
      "catalog.contextPanel",
      catalogContextPanelResponse({
        projectId: scope.projectId,
        localeBranchId: scope.localeBranchId,
        workId: catalogContextRoute.workId,
        localeBranch,
        catalog,
      }),
    );
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

  const sceneCoverageRoute = parseSceneCoverageApiRoute(request.pathname);
  if (request.method === "GET" && sceneCoverageRoute !== null) {
    const scope = await requireOwnedBranchScope(services.projectWorkflow, {
      projectId: sceneCoverageRoute.projectId,
      localeBranchId: sceneCoverageRoute.localeBranchId,
    });
    const model = await services.sceneCoverage.loadRouteMapCoverage({
      actor: { userId: "local-user" },
      projectId: scope.projectId,
      localeBranchId: scope.localeBranchId,
    });
    return ok("play.sceneCoverage", model);
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

  if (request.method === "GET" && request.pathname === "/api/queue/health") {
    return ok("queue.health", await services.queueHealth.loadQueueHealth());
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

  // The pure-GET read paths reject a non-GET request with 405 here (the POST
  // routes that share the `/api/reviewer/queue/...` prefix are dispatched by
  // the mutation router, which owns their own method-not-allowed handling).
  if (
    request.pathname === "/api/projects/status" ||
    request.pathname === "/api/projects/decisions" ||
    request.pathname === "/api/projects/cost" ||
    request.pathname === "/api/projects/cost/drilldown" ||
    request.pathname === "/api/projects/benchmarks" ||
    bmkCockpitRoute !== null ||
    request.pathname === "/api/jobs/run-table" ||
    request.pathname === "/api/auth/members" ||
    request.pathname === "/api/auth/permission-sets" ||
    request.pathname === "/api/auth/identity" ||
    request.pathname === "/api/auth/capabilities" ||
    request.pathname === "/api/hello/status" ||
    request.pathname === "/api/catalog/conflicts" ||
    request.pathname === "/api/catalog/completeness" ||
    request.pathname === "/api/catalog/benchmark-seeds" ||
    request.pathname === "/api/catalog/opportunities" ||
    request.pathname === "/api/terminology/search" ||
    request.pathname === "/api/wiki/entries" ||
    request.pathname === "/api/queue/health" ||
    playRouteMapRoute !== null ||
    catalogContextRoute !== null ||
    assetDecisionRoute !== null ||
    request.pathname === "/api/reviewer/queue" ||
    reviewerDetailRoute !== null
  ) {
    return methodNotAllowed(["GET"]);
  }

  // Not a read route this handler owns — defer to the mutation router.
  return null;
}

async function requireApiPermission(
  services: ApiAuthorizationDependency,
  gate: ApiMutationPermissionGate,
): Promise<void> {
  await services.authorization.requirePermission(gate.permission);
}

async function resolveApiReviewerQueuePermissionView(
  services: ApiAuthorizationDependency,
  actorUserId = "local-user",
): Promise<ReviewerQueuePermissionView> {
  // fnd-caps-context — project the queue subset from the full studio
  // capability view so the queue + SPA caps share one resolver path.
  // Queue denial reasons stay queue-scoped.
  const studio = await resolveStudioCapabilityPermissionView(services.authorization, actorUserId);
  const denialReasons: string[] = [];
  if (studio.denials.queueRead !== null) {
    denialReasons.push(studio.denials.queueRead);
  }
  if (studio.denials.queueManage !== null) {
    denialReasons.push(studio.denials.queueManage);
  }
  return {
    actorUserId: studio.actorUserId,
    canReadQueue: studio.canReadQueue,
    canManageQueue: studio.canManageQueue,
    denialReasons,
  };
}

/**
 * fnd-caps-context — optional `?actorUserId=` for the capabilities read.
 * Defaults to the local-user actor (the SPA's default authorization actor).
 */
function parseAuthCapabilitiesActorQuery(search: string | undefined): string {
  if (search === undefined || search === "" || search === "?") {
    return "local-user";
  }
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const actorUserId = params.get("actorUserId");
  if (actorUserId === null || actorUserId.trim() === "") {
    return "local-user";
  }
  return actorUserId;
}

function authCapabilitiesResponseBody(
  view: Awaited<ReturnType<typeof resolveStudioCapabilityPermissionView>>,
): ApiAuthCapabilitiesResponse {
  return {
    schemaVersion: "itotori.auth.capabilities.v0",
    actorUserId: view.actorUserId,
    canReadQueue: view.canReadQueue,
    canManageQueue: view.canManageQueue,
    canFlag: view.canFlag,
    canDecide: view.canDecide,
    canSteer: view.canSteer,
    canReveal: view.canReveal,
    denials: view.denials,
    denialReasons: view.denialReasons,
  };
}

function authIdentityResponseBody(identity: ActorIdentityRecord): ApiAuthIdentityResponse {
  return {
    schemaVersion: "itotori.auth.identity.v0",
    actorUserId: identity.actorUserId,
    userId: identity.userId,
    principalId: identity.principalId,
    email: identity.email,
    displayName: identity.displayName,
    accounts: identity.accounts.map((account) => ({
      membershipId: account.membershipId,
      accountId: account.accountId,
      accountSlug: account.accountSlug,
      accountName: account.accountName,
      permissionSetIds: account.permissionSetIds,
      createdAt: account.createdAt.toISOString(),
    })),
  };
}

async function tryApiPermission(
  services: ApiAuthorizationDependency,
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
async function resolveProjectReadPermission(
  services: ApiAuthorizationDependency,
): Promise<boolean> {
  const [canRead] = await tryApiPermission(services, permissionValues.catalogRead);
  return canRead;
}

/**
 * SECURITY — the localization pass ledger is a `draft.write`-protected read
 * (the pass-ledger repository requires `draft.write` for every load). The
 * composed `projects.overview` embeds the ledger, so it must honor that SAME
 * permission — a `catalog.read`-only caller must NOT receive pass-ledger rows
 * through the overview. Threaded into `getProjectOverview` as
 * `includePassLedger` so the ledger is only READ when the caller may see it.
 */
async function resolvePassLedgerReadPermission(
  services: ApiAuthorizationDependency,
): Promise<boolean> {
  const [canRead] = await tryApiPermission(services, permissionValues.draftWrite);
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

function redactProjectTelemetryTimeseries(
  telemetry: ProjectTelemetryTimeseries,
): ProjectTelemetryTimeseries {
  return {
    ...telemetry,
    rows: [],
    throughputSeries: [],
    costPerRunSeries: [],
  };
}

/**
 * gate-project-status-and-cost-reads — the redacted PUBLIC cost-drilldown
 * view. The rows carry the run ledger + provider/adapter metadata (privileged
 * detail), so they are stripped for unprivileged callers; the filter echo and
 * pagination aggregates are safe to keep. `hasMore`/`nextOffset` still reflect
 * the true total so a paging client behaves consistently.
 */
function redactCostDrilldownPage(page: CostDrilldownPage): CostDrilldownPage {
  return {
    ...page,
    rows: [],
  };
}

function redactJobsRunTable(page: JobsRunTableReadModel): JobsRunTableReadModel {
  return {
    ...page,
    rows: [],
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

function catalogContextPanelResponse(input: {
  projectId: string;
  localeBranchId: string;
  workId: string;
  localeBranch: ProjectDashboardStatus["localeBranches"][number];
  catalog: CatalogContextPanelCatalogReadModel;
}): CatalogContextPanelReadModel {
  return {
    schemaVersion: "catalog.context_panel_route.v0.1",
    generatedAt: input.catalog.generatedAt,
    params: {
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      workId: input.workId,
    },
    row: input.catalog.row,
    releases: input.catalog.releases,
    projectState: {
      targetLanguage: input.localeBranch.targetLocale,
      localeBranch: input.localeBranch,
    },
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
    ...emptyReviewerDetailEvidence(),
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

function parseCostDrilldownFilter(search = ""): CostDrilldownFilter {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  assertKnownQueryParams(
    params,
    ["projectId", "systemId", "from", "to", "limit", "offset"],
    "cost drilldown",
  );
  return parseCostDrilldownParams(params);
}

function parseJobsRunTableQuery(search = ""): LoadJobsRunTableOptions {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  assertKnownQueryParams(params, ["projectId", "limit", "offset"], "jobs run table");
  const options: LoadJobsRunTableOptions = {};
  // SECURITY (jobs-run-table cross-project leak, P1) — the run table is a
  // PROJECT-SCOPED read. `projectId` is REQUIRED: an omitted projectId must
  // NOT fall through to an all-projects read. We fail closed at the route
  // boundary with a 400 before the service is ever consulted; the read model
  // itself also refuses a missing/empty scope (defense in depth).
  const projectId = params.get("projectId");
  if (projectId === null) {
    throw new ApiValidationError("projectId is required");
  }
  options.projectId = nonEmptyParam(projectId, "projectId");
  const limit = parseNonNegativeIntParam(params.get("limit"), "limit");
  if (limit !== undefined) {
    if (limit < 1) {
      throw new ApiValidationError("limit must be a positive integer");
    }
    options.limit = limit;
  }
  const offset = parseNonNegativeIntParam(params.get("offset"), "offset");
  if (offset !== undefined) {
    options.offset = offset;
  }
  return options;
}

function parseBmkCockpitQuery(search = ""): {
  runId?: string;
  localeBranchId?: string | null;
} {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  assertKnownQueryParams(params, ["runId", "localeBranchId"], "benchmark cockpit");
  const input: { runId?: string; localeBranchId?: string | null } = {};
  const runId = params.get("runId");
  if (runId !== null) {
    input.runId = nonEmptyParam(runId, "runId");
  }
  const localeBranchId = params.get("localeBranchId");
  if (localeBranchId !== null) {
    input.localeBranchId =
      localeBranchId === "null" ? null : nonEmptyParam(localeBranchId, "localeBranchId");
  }
  return input;
}

function parseBmkCockpitHistoryQuery(search = ""): {
  localeBranchId?: string | null;
  limit?: number;
  offset?: number;
} {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  assertKnownQueryParams(
    params,
    ["localeBranchId", "limit", "offset"],
    "benchmark cockpit history",
  );
  const input: { localeBranchId?: string | null; limit?: number; offset?: number } = {};
  const localeBranchId = params.get("localeBranchId");
  if (localeBranchId !== null) {
    input.localeBranchId =
      localeBranchId === "null" ? null : nonEmptyParam(localeBranchId, "localeBranchId");
  }
  const limit = parseNonNegativeIntParam(params.get("limit"), "limit");
  if (limit !== undefined) {
    if (limit < 1) {
      throw new ApiValidationError("limit must be a positive integer");
    }
    input.limit = limit;
  }
  const offset = parseNonNegativeIntParam(params.get("offset"), "offset");
  if (offset !== undefined) {
    input.offset = offset;
  }
  return input;
}

function parseAuthMembersListQuery(search = ""): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  assertKnownQueryParams(params, ["accountId"], "auth members list");
  const accountId = params.get("accountId");
  if (accountId === null || accountId.length === 0) {
    throw new ApiValidationError("accountId is required");
  }
  return accountId;
}

function parseModelRoutingSettingsQuery(search = ""): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  assertKnownQueryParams(params, ["projectId"], "model routing settings");
  const projectId = params.get("projectId");
  if (projectId === null || projectId.length === 0) {
    throw new ApiValidationError("projectId is required");
  }
  return projectId;
}

function parseAuthBillingSeatUsageQuery(search = ""): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  assertKnownQueryParams(params, ["accountId"], "auth billing seat usage");
  const accountId = params.get("accountId");
  if (accountId === null || accountId.length === 0) {
    throw new ApiValidationError("accountId is required");
  }
  return accountId;
}

function parseAuthPermissionSetsListQuery(search = ""): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  assertKnownQueryParams(params, ["accountId"], "auth permission sets list");
  const accountId = params.get("accountId");
  if (accountId === null || accountId.length === 0) {
    throw new ApiValidationError("accountId is required");
  }
  return accountId;
}

function parseProjectOverviewFilter(search = ""): ProjectOverviewReadModelOptions {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  assertKnownQueryParams(
    params,
    [
      "systemId",
      "from",
      "to",
      "limit",
      "offset",
      "passLedgerLocaleBranchId",
      "passLedgerLimit",
      "passLedgerOffset",
    ],
    "project overview",
  );
  const costDrilldown = parseCostDrilldownParams(params);
  const passLedgerLocaleBranchId = params.get("passLedgerLocaleBranchId");
  const passLedgerLimit = parseNonNegativeIntParam(
    params.get("passLedgerLimit"),
    "passLedgerLimit",
  );
  if (passLedgerLimit !== undefined && passLedgerLimit < 1) {
    throw new ApiValidationError("passLedgerLimit must be a positive integer");
  }
  const passLedgerOffset = parseNonNegativeIntParam(
    params.get("passLedgerOffset"),
    "passLedgerOffset",
  );
  return {
    costDrilldown,
    passLedger: {
      ...(passLedgerLocaleBranchId !== null
        ? { localeBranchId: nonEmptyParam(passLedgerLocaleBranchId, "passLedgerLocaleBranchId") }
        : {}),
      ...(passLedgerLimit !== undefined ? { limit: passLedgerLimit } : {}),
      ...(passLedgerOffset !== undefined ? { offset: passLedgerOffset } : {}),
    },
  };
}

function parseCostDrilldownParams(params: URLSearchParams): CostDrilldownFilter {
  const filter: CostDrilldownFilter = {};
  const projectId = params.get("projectId");
  if (projectId !== null) {
    if (projectId.trim().length === 0) {
      throw new ApiValidationError("projectId must be non-empty");
    }
    filter.projectId = projectId;
  }
  const systemId = params.get("systemId");
  if (systemId !== null) {
    if (systemId.trim().length === 0) {
      throw new ApiValidationError("systemId must be non-empty");
    }
    filter.systemId = systemId;
  }
  const from = parseIsoDateParam(params.get("from"), "from");
  if (from !== undefined) {
    filter.from = from;
  }
  const to = parseIsoDateParam(params.get("to"), "to");
  if (to !== undefined) {
    filter.to = to;
  }
  if (filter.from && filter.to && filter.from.getTime() > filter.to.getTime()) {
    throw new ApiValidationError("from must not be after to");
  }
  const limit = parseNonNegativeIntParam(params.get("limit"), "limit");
  if (limit !== undefined) {
    if (limit < 1) {
      throw new ApiValidationError("limit must be a positive integer");
    }
    filter.limit = limit;
  }
  const offset = parseNonNegativeIntParam(params.get("offset"), "offset");
  if (offset !== undefined) {
    filter.offset = offset;
  }
  return filter;
}

function nonEmptyParam(value: string, label: string): string {
  if (value.trim().length === 0) {
    throw new ApiValidationError(`${label} must be non-empty`);
  }
  return value;
}

function parseIsoDateParam(raw: string | null, label: string): Date | undefined {
  if (raw === null) {
    return undefined;
  }
  const millis = Date.parse(raw);
  if (Number.isNaN(millis)) {
    throw new ApiValidationError(`${label} must be an ISO-8601 date-time`);
  }
  return new Date(millis);
}

function parseNonNegativeIntParam(raw: string | null, label: string): number | undefined {
  if (raw === null) {
    return undefined;
  }
  if (!/^\d+$/u.test(raw.trim())) {
    throw new ApiValidationError(`${label} must be a non-negative integer`);
  }
  return Number.parseInt(raw.trim(), 10);
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

function parseWorkspaceSearchQuery(
  search = "",
): Omit<LoadWorkspaceSearchInput, "canReadCatalog" | "permission"> {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  assertKnownQueryParams(
    params,
    ["projectId", "localeBranchId", "query", "mode", "limit", "offset", "actorUserId"],
    "workspace search",
  );
  const input: Omit<LoadWorkspaceSearchInput, "canReadCatalog" | "permission"> = {
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
  const offset = params.get("offset");
  if (offset !== null) {
    const parsedOffset = Number(offset);
    if (!Number.isInteger(parsedOffset) || parsedOffset < 0) {
      throw new ApiValidationError("offset must be a non-negative integer");
    }
    input.offset = parsedOffset;
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

function parseAuthMemberAcceptRoute(pathname: string): { invitationId: string } | null {
  const match = /^\/api\/auth\/members\/invitations\/([^/]+)\/accept$/u.exec(pathname);
  if (match === null || match[1] === undefined || match[1].length === 0) {
    return null;
  }
  return { invitationId: decodeURIComponent(match[1]) };
}

function parseAuthMemberRemoveRoute(pathname: string): { membershipId: string } | null {
  const match = /^\/api\/auth\/members\/([^/]+)\/remove$/u.exec(pathname);
  if (match === null || match[1] === undefined || match[1].length === 0) {
    return null;
  }
  return { membershipId: decodeURIComponent(match[1]) };
}

function parseAuthSessionsRoute(pathname: string): { principalId: string } | null {
  const match = /^\/api\/auth\/principals\/([^/]+)\/sessions$/u.exec(pathname);
  if (match === null || match[1] === undefined || match[1].length === 0) {
    return null;
  }
  return { principalId: decodeURIComponent(match[1]) };
}

function parseAuthSessionRevokeRoute(
  pathname: string,
): { principalId: string; sessionId: string } | null {
  const match = /^\/api\/auth\/principals\/([^/]+)\/sessions\/([^/]+)\/revoke$/u.exec(pathname);
  if (
    match === null ||
    match[1] === undefined ||
    match[1].length === 0 ||
    match[2] === undefined ||
    match[2].length === 0
  ) {
    return null;
  }
  return { principalId: decodeURIComponent(match[1]), sessionId: decodeURIComponent(match[2]) };
}

function parseAuthPermissionSetGrantRoute(
  pathname: string,
): { principalId: string; permissionSetId: string } | null {
  const match = /^\/api\/auth\/principals\/([^/]+)\/permission-sets\/([^/]+)\/grant$/u.exec(
    pathname,
  );
  if (
    match === null ||
    match[1] === undefined ||
    match[1].length === 0 ||
    match[2] === undefined ||
    match[2].length === 0
  ) {
    return null;
  }
  return {
    principalId: decodeURIComponent(match[1]),
    permissionSetId: decodeURIComponent(match[2]),
  };
}

function parseAuthPermissionSetRevokeRoute(
  pathname: string,
): { principalId: string; permissionSetId: string } | null {
  const match = /^\/api\/auth\/principals\/([^/]+)\/permission-sets\/([^/]+)\/revoke$/u.exec(
    pathname,
  );
  if (
    match === null ||
    match[1] === undefined ||
    match[1].length === 0 ||
    match[2] === undefined ||
    match[2].length === 0
  ) {
    return null;
  }
  return {
    principalId: decodeURIComponent(match[1]),
    permissionSetId: decodeURIComponent(match[2]),
  };
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

function parseCatalogContextPanelApiRoute(
  pathname: string,
): { projectId: string; localeBranchId: string; workId: string } | null {
  const match =
    /^\/api\/projects\/([^/]+)\/locale-branches\/([^/]+)\/catalog-context\/([^/]+)$/u.exec(
      pathname,
    );
  if (
    match === null ||
    match[1] === undefined ||
    match[2] === undefined ||
    match[3] === undefined
  ) {
    return null;
  }
  return {
    projectId: decodeApiPathSegment(match[1], "projectId"),
    localeBranchId: decodeApiPathSegment(match[2], "localeBranchId"),
    workId: decodeApiPathSegment(match[3], "workId"),
  };
}

function parsePlayRouteMapApiRoute(
  pathname: string,
): { projectId: string; localeBranchId: string } | null {
  const match = /^\/api\/projects\/([^/]+)\/locale-branches\/([^/]+)\/route-map\/?$/u.exec(
    pathname,
  );
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return null;
  }
  return {
    projectId: decodeApiPathSegment(match[1], "projectId"),
    localeBranchId: decodeApiPathSegment(match[2], "localeBranchId"),
  };
}

function parseSceneCoverageApiRoute(pathname: string): {
  projectId: string;
  localeBranchId: string;
} | null {
  const match = /^\/api\/projects\/([^/]+)\/locale-branches\/([^/]+)\/scene-coverage$/u.exec(
    pathname,
  );
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return null;
  }
  return {
    projectId: decodeApiPathSegment(match[1], "projectId"),
    localeBranchId: decodeApiPathSegment(match[2], "localeBranchId"),
  };
}

function parsePlayFlagApiRoute(pathname: string): {
  projectId: string;
  localeBranchId: string;
} | null {
  const match = /^\/api\/projects\/([^/]+)\/locale-branches\/([^/]+)\/flags$/u.exec(pathname);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return null;
  }
  return {
    projectId: decodeApiPathSegment(match[1], "projectId"),
    localeBranchId: decodeApiPathSegment(match[2], "localeBranchId"),
  };
}

function parseBranchPolicySettingsApiRoute(pathname: string): {
  projectId: string;
  localeBranchId: string;
} | null {
  const match =
    /^\/api\/projects\/([^/]+)\/locale-branches\/([^/]+)\/settings\/branch-policy\/?$/u.exec(
      pathname,
    );
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return null;
  }
  return {
    projectId: decodeApiPathSegment(match[1], "projectId"),
    localeBranchId: decodeApiPathSegment(match[2], "localeBranchId"),
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
  assertKnownQueryParams(params, ["targetLanguage", "pool"], "catalog completeness");
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
      "requiredCapabilities",
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
  const requiredCapabilities = listParam(params, "requiredCapabilities");
  if (requiredCapabilities.length > 0) {
    filter.requiredCapabilities = requiredCapabilities.map((capability) =>
      enumParam(
        capability,
        Object.values(capabilityLevelValues) as CapabilityLevel[],
        "requiredCapabilities",
      ),
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
  assertKnownQueryParams(
    params,
    ["source", "severity", "status", "catalogRecordId"],
    "catalog conflict",
  );
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

function parseWikiEntriesQuery(search = ""): WikiEntriesFilter {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  assertKnownQueryParams(
    params,
    ["projectId", "localeBranchId", "sourceRevisionId", "kind", "limit", "offset"],
    "wiki entries",
  );
  const input: WikiEntriesFilter = {
    projectId: requiredNonEmptyParam(params, "projectId"),
    localeBranchId: requiredNonEmptyParam(params, "localeBranchId"),
  };
  const sourceRevisionId = params.get("sourceRevisionId");
  if (sourceRevisionId !== null) {
    input.sourceRevisionId = nonEmptyParam(sourceRevisionId, "sourceRevisionId");
  }
  const kind = params.get("kind");
  if (kind !== null) {
    input.kind = enumParam(kind, Object.values(wikiEntryKindValues), "kind");
  }
  const limit = params.get("limit");
  if (limit !== null) {
    const parsedLimit = Number(limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
      throw new ApiValidationError("limit must be an integer from 1 through 100");
    }
    input.limit = parsedLimit;
  }
  const offset = params.get("offset");
  if (offset !== null) {
    const parsedOffset = Number(offset);
    if (!Number.isInteger(parsedOffset) || parsedOffset < 0) {
      throw new ApiValidationError("offset must be a non-negative integer");
    }
    input.offset = parsedOffset;
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
function ok(routeId: "catalog.contextPanel", body: ApiCatalogContextPanelResponse): ApiJsonResponse;
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
function ok(routeId: "wiki.entries", body: WikiEntriesReadModel): ApiJsonResponse;
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
function ok(routeId: "projects.overview", body: ApiProjectOverviewResponse): ApiJsonResponse;
function ok(routeId: "projects.decisions", body: DashboardDecisionReadModel): ApiJsonResponse;
function ok(routeId: "projects.cost", body: ProjectCostReport): ApiJsonResponse;
function ok(routeId: "projects.costDrilldown", body: CostDrilldownPage): ApiJsonResponse;
function ok(routeId: "projects.benchmarks", body: ApiBenchmarkReportsResponse): ApiJsonResponse;
function ok(routeId: "projects.bmkCockpit", body: BmkCockpitReadModel): ApiJsonResponse;
function ok(routeId: "projects.bmkCockpitHistory", body: BmkCockpitRunHistoryPage): ApiJsonResponse;
function ok(routeId: "jobs.runTable", body: ApiJobsRunTableResponse): ApiJsonResponse;
function ok(routeId: "queue.health", body: ApiQueueHealthResponse): ApiJsonResponse;
function ok(routeId: "runtime.status", body: RuntimeDashboardStatus): ApiJsonResponse;
function ok(routeId: "imports.bridge", body: ApiProjectImportResponse): ApiJsonResponse;
function ok(routeId: "branches.draft", body: ApiDraftBranchResponse): ApiJsonResponse;
function ok(routeId: "findings.record", body: FindingRecordResult): ApiJsonResponse;
function ok(routeId: "decisions.record", body: DecisionRecordResult): ApiJsonResponse;
function ok(routeId: "benchmarks.record", body: BenchmarkRecordResult): ApiJsonResponse;
function ok(routeId: "runtimeEvidence.ingest", body: RuntimeIngestResult): ApiJsonResponse;
function ok(
  routeId: "settings.modelRouting.get",
  body: ApiModelRoutingSettingsResponse,
): ApiJsonResponse;
function ok(
  routeId: "settings.modelRouting.save",
  body: ApiModelRoutingSettingsResponse,
): ApiJsonResponse;
function ok(
  routeId: "settings.branchPolicy.get",
  body: ApiBranchPolicySettingsResponse,
): ApiJsonResponse;
function ok(
  routeId: "settings.branchPolicy.save",
  body: ApiBranchPolicySettingsResponse,
): ApiJsonResponse;
function ok(
  routeId: "auth.ssoSettings.configure",
  body: ApiConfigureAuthSsoSettingsResponse,
): ApiJsonResponse;
function ok(routeId: "auth.members.list", body: ApiMembersListResponse): ApiJsonResponse;
function ok(
  routeId: "auth.billing.seatUsage",
  body: ApiAuthBillingSeatUsageResponse,
): ApiJsonResponse;
function ok(routeId: "auth.members.invite", body: ApiMemberInvitationResponse): ApiJsonResponse;
function ok(routeId: "auth.members.accept", body: ApiMemberResponse): ApiJsonResponse;
function ok(routeId: "auth.members.remove", body: ApiRemoveMemberResponse): ApiJsonResponse;
function ok(
  routeId: "auth.permissionSets.list",
  body: ApiPermissionSetsListResponse,
): ApiJsonResponse;
function ok(
  routeId: "auth.permissionSets.grant",
  body: ApiPrincipalPermissionSetGrantResponse,
): ApiJsonResponse;
function ok(
  routeId: "auth.permissionSets.revoke",
  body: ApiPrincipalPermissionSetGrantResponse,
): ApiJsonResponse;
function ok(routeId: "auth.sessions.list", body: ApiAuthSessionsListResponse): ApiJsonResponse;
function ok(routeId: "auth.sessions.revoke", body: ApiRevokeAuthSessionResponse): ApiJsonResponse;
function ok(routeId: "auth.identity", body: ApiAuthIdentityResponse): ApiJsonResponse;
function ok(routeId: "auth.capabilities", body: ApiAuthCapabilitiesResponse): ApiJsonResponse;
function ok(routeId: "projects.launchPass", body: ApiLaunchPassResponse): ApiJsonResponse;
function ok(routeId: "play.routeMap", body: ApiPlayRouteMapResponse): ApiJsonResponse;
function ok(routeId: "play.sceneCoverage", body: ApiPlaySceneCoverageResponse): ApiJsonResponse;
function ok(
  routeId: "play.setSceneCoverage",
  body: ApiPlaySetSceneCoverageResponse,
): ApiJsonResponse;
function ok(routeId: "play.flagAnnotation", body: ApiPlayFlagAnnotationResponse): ApiJsonResponse;
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
  // ITOTORI-050 — a mutation targeting a project/branch outside the server-side
  // ownership scope is refused as forbidden (broken object-level authorization),
  // distinct from a bad request or a missing-permission denial.
  if (error instanceof ProjectMutationScopeError) {
    return errorBody(403, "forbidden", error.message);
  }
  if (
    error instanceof AssetLocalizationDecisionRepositoryError &&
    error.code === "asset_decision_not_found"
  ) {
    return errorBody(404, "not_found", error.message);
  }
  if (error instanceof RuntimeRunNotFoundError) {
    return errorBody(404, "not_found", error.message);
  }
  if (error instanceof SceneCoverageServiceError && error.code === "unknown_scene") {
    return errorBody(400, "bad_request", error.message);
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
  resource:
    | "branches"
    | "findings"
    | "decisions"
    | "benchmarks"
    | "runtime-evidence"
    | "launch-pass";
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
    resource !== "runtime-evidence" &&
    resource !== "launch-pass"
  ) {
    return null;
  }
  return { projectId: decodeURIComponent(projectId), resource };
}

function parseBmkCockpitRoute(pathname: string): {
  projectId: string;
  resource: "cockpit" | "history";
} | null {
  const match = /^\/api\/projects\/([^/]+)\/bmk-cockpit(?:\/(history))?$/.exec(pathname);
  if (!match) {
    return null;
  }
  const projectId = match[1];
  if (projectId === undefined) {
    return null;
  }
  return {
    projectId: decodeURIComponent(projectId),
    resource: match[2] === "history" ? "history" : "cockpit",
  };
}

function assertPathProject(pathProjectId: string, bodyProjectId: string): void {
  if (pathProjectId !== bodyProjectId) {
    throw new ApiValidationError(
      `path project ${pathProjectId} does not match body project ${bodyProjectId}`,
    );
  }
}

/**
 * ITOTORI-050 — rewrite a record request's client-supplied `localeBranchId`
 * to the server-side authoritative value once ownership is verified. When the
 * client supplied no branch (`serverLocaleBranchId === null`, a project-scoped
 * record) the body is returned unchanged.
 */
function scopeRecordBranch<T extends { localeBranchId?: string }>(
  body: T,
  serverLocaleBranchId: string | null,
): T {
  if (serverLocaleBranchId === null) {
    return body;
  }
  return { ...body, localeBranchId: serverLocaleBranchId };
}
