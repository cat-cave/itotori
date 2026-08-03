import type {
  ApiAssetDecisionsResponse,
  ApiAuthBillingSeatUsageResponse,
  ApiAuthCapabilitiesResponse,
  ApiAuthIdentityResponse,
  ApiAuthSessionsListResponse,
  ApiAcceptMemberInvitationRequest,
  ApiBenchmarkReportsResponse,
  ApiBranchPolicySettingsResponse,
  ApiCandidateAssetsResponse,
  ApiCatalogBenchmarkSeedsResponse,
  ApiCatalogCompletenessResponse,
  ApiCatalogConflictReviewResponse,
  ApiCatalogContextPanelResponse,
  ApiCatalogOpportunitiesResponse,
  ApiConfigureAuthSsoSettingsRequest,
  ApiConfigureAuthSsoSettingsResponse,
  ApiDashboardDecisionsResponse,
  ApiDraftBranchRequest,
  ApiDraftBranchResponse,
  ApiErrorResponse,
  ApiInviteMemberRequest,
  ApiJobsRunTableResponse,
  ApiLaunchPassRequest,
  ApiLaunchPassResponse,
  ApiLocalizationPassControlRequest,
  ApiLocalizationPassControlResponse,
  ApiLocalizationRunConfigResponse,
  ApiMemberInvitationResponse,
  ApiMemberResponse,
  ApiMembersListResponse,
  ApiModelRoutingSettingsResponse,
  ApiPatchIterationDeliveryResponse,
  ApiPatchIterationFeedbackBatchRequest,
  ApiPatchIterationFeedbackBatchResponse,
  ApiPatchIterationFeedbackRequest,
  ApiPatchIterationFeedbackResponse,
  ApiPatchIterationPlayRequest,
  ApiPatchIterationPlayResponse,
  ApiPatchIterationRefineRequest,
  ApiPatchIterationRefineResponse,
  ApiPatchIterationSurfaceResponse,
  ApiPatchIterationVersionsResponse,
  ApiPermissionSetsListResponse,
  ApiPlayAddressableUnitResponse,
  ApiPlayDeliveryResponse,
  ApiPlayFlagAnnotationRequest,
  ApiPlayFlagAnnotationResponse,
  ApiPlayRouteMapResponse,
  ApiPlayTargetEditRequest,
  ApiPlayTargetEditResponse,
  ApiPlayUnitFeedbackResponse,
  ApiPrincipalPermissionSetGrantRequest,
  ApiPrincipalPermissionSetGrantResponse,
  ApiProjectCostDrilldownResponse,
  ApiProjectCostResponse,
  ApiProjectDecodeExtractRequest,
  ApiProjectDecodeExtractResponse,
  ApiProjectImportRequest,
  ApiProjectImportResponse,
  ApiProjectOverviewResponse,
  ApiProjectsResponse,
  ApiQueueHealthResponse,
  ApiRecordBenchmarkRequest,
  ApiRecordBenchmarkResponse,
  ApiRecordFindingRequest,
  ApiRecordFindingResponse,
  ApiRemoveMemberRequest,
  ApiRemoveMemberResponse,
  ApiRevokeAuthSessionRequest,
  ApiRevokeAuthSessionResponse,
  ApiRuntimeEvidenceRequest,
  ApiRuntimeEvidenceResponse,
  ApiSaveBranchPolicySettingsRequest,
  ApiSaveLocalizationRunConfigRequest,
  ApiSaveModelRoutingSettingsRequest,
  ApiSaveTranslationScopeSettingsRequest,
  ApiTerminologySearchResponse,
  ApiTranslationScopeSettingsResponse,
  ApiWikiApplyRequest,
  ApiWikiApplyResponse,
  ApiWikiEditResponse,
  ApiWikiFeedbackResponse,
  ApiWikiHistoryResponse,
  ApiWikiListResponse,
  ApiWikiShowResponse,
  ApiWikiWriteRequest,
  ItotoriApiRouteId,
} from "./api-schema.js";
import type { ProjectDashboardStatus, RuntimeDashboardStatus } from "@itotori/db";

// Route → TypeScript type map. A typed view of the api-schema.ts body types:
// each entry associates a route id with its response, request, path params,
// and collection key. Validation remains with assertItotoriApiResponse.
interface ItotoriApiRouteTypeMap {
  "assetDecisions.active": {
    response: ApiAssetDecisionsResponse;
    pathParams: { projectId: string; localeBranchId: string };
    collectionKey: "decisions";
  };
  "assetDecisions.candidates": {
    response: ApiCandidateAssetsResponse;
    pathParams: { projectId: string; localeBranchId: string };
    collectionKey: "candidateAssets";
  };
  "catalog.benchmarkSeeds": { response: ApiCatalogBenchmarkSeedsResponse; collectionKey: "rows" };
  "catalog.contextPanel": {
    response: ApiCatalogContextPanelResponse;
    pathParams: { projectId: string; localeBranchId: string; workId: string };
  };
  "catalog.completeness": { response: ApiCatalogCompletenessResponse };
  "catalog.conflicts": { response: ApiCatalogConflictReviewResponse; collectionKey: "rows" };
  "catalog.opportunities": { response: ApiCatalogOpportunitiesResponse; collectionKey: "rows" };
  "terminology.search": { response: ApiTerminologySearchResponse; collectionKey: "results" };
  "wiki.list": { response: ApiWikiListResponse; collectionKey: "sourceObjects" };
  "wiki.show": {
    response: ApiWikiShowResponse;
    pathParams: { wikiKind: string; objectId: string };
  };
  "wiki.history": {
    response: ApiWikiHistoryResponse;
    pathParams: { wikiKind: string; objectId: string };
  };
  "wiki.edit": {
    response: ApiWikiEditResponse;
    pathParams: { wikiKind: string; objectId: string };
    request: ApiWikiWriteRequest;
  };
  "wiki.feedback": {
    response: ApiWikiFeedbackResponse;
    pathParams: { wikiKind: string; objectId: string };
    request: ApiWikiWriteRequest;
  };
  "wiki.apply": {
    response: ApiWikiApplyResponse;
    pathParams: { wikiKind: string; objectId: string };
    request: ApiWikiApplyRequest;
  };
  "projects.list": { response: ApiProjectsResponse; collectionKey: "projects" };
  "projects.status": { response: ProjectDashboardStatus };
  "projects.overview": { response: ApiProjectOverviewResponse };
  "projects.decisions": {
    response: ApiDashboardDecisionsResponse;
    collectionKey: "pendingDecisions";
  };
  "projects.cost": { response: ApiProjectCostResponse };
  "projects.costDrilldown": { response: ApiProjectCostDrilldownResponse; collectionKey: "rows" };
  "projects.benchmarks": { response: ApiBenchmarkReportsResponse; collectionKey: "reports" };
  "jobs.runTable": { response: ApiJobsRunTableResponse; collectionKey: "rows" };
  "runtime.status": { response: RuntimeDashboardStatus };
  "queue.health": { response: ApiQueueHealthResponse };
  "projects.decodeExtract": {
    response: ApiProjectDecodeExtractResponse;
    request: ApiProjectDecodeExtractRequest;
  };
  "imports.bridge": { response: ApiProjectImportResponse; request: ApiProjectImportRequest };
  "branches.draft": {
    response: ApiDraftBranchResponse;
    pathParams: { projectId: string };
    request: ApiDraftBranchRequest;
  };
  "findings.record": {
    response: ApiRecordFindingResponse;
    pathParams: { projectId: string };
    request: ApiRecordFindingRequest;
  };
  "benchmarks.record": {
    response: ApiRecordBenchmarkResponse;
    pathParams: { projectId: string };
    request: ApiRecordBenchmarkRequest;
  };
  "runtimeEvidence.ingest": {
    response: ApiRuntimeEvidenceResponse;
    pathParams: { projectId: string };
    request: ApiRuntimeEvidenceRequest;
  };
  "settings.modelRouting.get": { response: ApiModelRoutingSettingsResponse };
  "settings.modelRouting.save": {
    response: ApiModelRoutingSettingsResponse;
    request: ApiSaveModelRoutingSettingsRequest;
  };
  "settings.branchPolicy.get": {
    response: ApiBranchPolicySettingsResponse;
    pathParams: { projectId: string; localeBranchId: string };
  };
  "settings.branchPolicy.save": {
    response: ApiBranchPolicySettingsResponse;
    pathParams: { projectId: string; localeBranchId: string };
    request: ApiSaveBranchPolicySettingsRequest;
  };
  "settings.translationScope.get": {
    response: ApiTranslationScopeSettingsResponse;
    pathParams: { projectId: string; localeBranchId: string };
  };
  "settings.translationScope.save": {
    response: ApiTranslationScopeSettingsResponse;
    pathParams: { projectId: string; localeBranchId: string };
    request: ApiSaveTranslationScopeSettingsRequest;
  };
  "settings.localizationRunConfig.save": {
    response: ApiLocalizationRunConfigResponse;
    pathParams: { projectId: string; localeBranchId: string };
    request: ApiSaveLocalizationRunConfigRequest;
  };
  "auth.ssoSettings.configure": {
    response: ApiConfigureAuthSsoSettingsResponse;
    request: ApiConfigureAuthSsoSettingsRequest;
  };
  "auth.members.list": { response: ApiMembersListResponse; collectionKey: "members" };
  "auth.billing.seatUsage": { response: ApiAuthBillingSeatUsageResponse };
  "auth.identity": { response: ApiAuthIdentityResponse };
  "auth.capabilities": { response: ApiAuthCapabilitiesResponse };
  "auth.members.invite": { response: ApiMemberInvitationResponse; request: ApiInviteMemberRequest };
  "auth.members.accept": {
    response: ApiMemberResponse;
    pathParams: { invitationId: string };
    request: ApiAcceptMemberInvitationRequest;
  };
  "auth.members.remove": {
    response: ApiRemoveMemberResponse;
    pathParams: { membershipId: string };
    request: ApiRemoveMemberRequest;
  };
  "auth.permissionSets.list": {
    response: ApiPermissionSetsListResponse;
    collectionKey: "permissionSets";
  };
  "auth.permissionSets.grant": {
    response: ApiPrincipalPermissionSetGrantResponse;
    pathParams: { principalId: string; permissionSetId: string };
    request: ApiPrincipalPermissionSetGrantRequest;
  };
  "auth.permissionSets.revoke": {
    response: ApiPrincipalPermissionSetGrantResponse;
    pathParams: { principalId: string; permissionSetId: string };
    request: ApiPrincipalPermissionSetGrantRequest;
  };
  "auth.sessions.list": {
    response: ApiAuthSessionsListResponse;
    pathParams: { principalId: string };
    collectionKey: "sessions";
  };
  "auth.sessions.revoke": {
    response: ApiRevokeAuthSessionResponse;
    pathParams: { principalId: string; sessionId: string };
    request: ApiRevokeAuthSessionRequest;
  };
  "projects.launchPass": {
    response: ApiLaunchPassResponse;
    pathParams: { projectId: string };
    request: ApiLaunchPassRequest;
  };
  "projects.pausePass": {
    response: ApiLocalizationPassControlResponse;
    pathParams: { projectId: string; runId: string };
    request: ApiLocalizationPassControlRequest;
  };
  "projects.resumePass": {
    response: ApiLocalizationPassControlResponse;
    pathParams: { projectId: string; runId: string };
    request: ApiLocalizationPassControlRequest;
  };
  "play.routeMap": {
    response: ApiPlayRouteMapResponse;
    pathParams: { projectId: string; localeBranchId: string };
    collectionKey: "nodes";
  };
  "play.flagAnnotation": {
    response: ApiPlayFlagAnnotationResponse;
    pathParams: { projectId: string; localeBranchId: string };
    request: ApiPlayFlagAnnotationRequest;
  };
  "play.unitFeedback": {
    response: ApiPlayUnitFeedbackResponse;
    pathParams: { projectId: string; localeBranchId: string };
  };
  "play.addressableUnit": {
    response: ApiPlayAddressableUnitResponse;
    pathParams: { projectId: string; localeBranchId: string; bridgeUnitId: string };
  };
  "play.targetEdit": {
    response: ApiPlayTargetEditResponse;
    pathParams: { parentPatchVersionId: string };
    request: ApiPlayTargetEditRequest;
  };
  "play.delivery": {
    response: ApiPlayDeliveryResponse;
    pathParams: { runId: string };
    collectionKey: "units";
  };
  "patchIteration.versions": {
    response: ApiPatchIterationVersionsResponse;
    pathParams: { localeBranchId: string };
    collectionKey: "versions";
  };
  "patchIteration.surface": {
    response: ApiPatchIterationSurfaceResponse;
    pathParams: { patchVersionId: string };
  };
  "patchIteration.delivery": {
    response: ApiPatchIterationDeliveryResponse;
    pathParams: { patchVersionId: string };
    collectionKey: "units";
  };
  "patchIteration.play": {
    response: ApiPatchIterationPlayResponse;
    pathParams: { patchVersionId: string };
    request: ApiPatchIterationPlayRequest;
  };
  "patchIteration.feedbackBatch": {
    response: ApiPatchIterationFeedbackBatchResponse;
    pathParams: { patchVersionId: string };
    request: ApiPatchIterationFeedbackBatchRequest;
  };
  "patchIteration.feedback": {
    response: ApiPatchIterationFeedbackResponse;
    pathParams: { patchVersionId: string };
    request: ApiPatchIterationFeedbackRequest;
  };
  "patchIteration.refine": {
    response: ApiPatchIterationRefineResponse;
    pathParams: { patchVersionId: string };
    request: ApiPatchIterationRefineRequest;
  };
}

export type ApiRouteResponse<R extends ItotoriApiRouteId> = ItotoriApiRouteTypeMap[R]["response"];
export type ApiRouteRequestBody<R extends ItotoriApiRouteId> = ItotoriApiRouteTypeMap[R] extends {
  request: infer B;
}
  ? B
  : void;
export type ApiRoutePathParams<R extends ItotoriApiRouteId> = ItotoriApiRouteTypeMap[R] extends {
  pathParams: infer P;
}
  ? P
  : void;

type ApiRequestOptionsBase<R extends ItotoriApiRouteId> = {
  query?: Readonly<Record<string, string | number | boolean | null>>;
  isEmpty?: (data: ApiRouteResponse<R>) => boolean;
};

export type ApiRequestOptionsFor<R extends ItotoriApiRouteId> = ApiRequestOptionsBase<R> &
  (ItotoriApiRouteTypeMap[R] extends { pathParams: infer P }
    ? { pathParams: P }
    : { pathParams?: never }) &
  (ItotoriApiRouteTypeMap[R] extends { request: infer B } ? { body: B } : { body?: never });

export type ApiClientError = {
  routeId: ItotoriApiRouteId;
  status: number;
  code: ApiErrorResponse["code"] | null;
  message: string | null;
};

export type ApiCallSettledState<T> =
  | { state: "ready"; data: T }
  | { state: "empty" }
  | { state: "error"; error: ApiClientError };

export type ApiCallState<T> = { state: "loading" } | ApiCallSettledState<T>;
export type { ItotoriApiRouteId };
