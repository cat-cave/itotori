import { ProjectDashboardStatus, RuntimeDashboardStatus } from "./dependencies.js";
import { ApiErrorResponse } from "./api-route-types.js";
import {
  ApiAssetDecisionsResponse,
  ApiBenchmarkReportsResponse,
  ApiCandidateAssetsResponse,
  ApiCatalogBenchmarkSeedsResponse,
  ApiCatalogCompletenessResponse,
  ApiCatalogConflictReviewResponse,
  ApiCatalogContextPanelResponse,
  ApiCatalogOpportunitiesResponse,
  ApiDashboardDecisionsResponse,
  ApiDraftBranchResponse,
  ApiJobsRunTableResponse,
  ApiProjectCostDrilldownResponse,
  ApiProjectCostResponse,
  ApiProjectDecodeExtractResponse,
  ApiProjectImportResponse,
  ApiProjectOverviewResponse,
  ApiProjectsResponse,
  ApiQueueHealthResponse,
  ApiRecordBenchmarkResponse,
  ApiRecordFindingResponse,
  ApiRuntimeEvidenceResponse,
  ApiTerminologySearchResponse,
  ApiWikiAddKind,
  ApiWikiApplyResponse,
  ApiWikiEditResponse,
  ApiWikiFeedbackResponse,
  ApiWikiHistoryResponse,
  ApiWikiListResponse,
  ApiWikiShowResponse,
} from "./api-response-types.js";
import {
  ApiAuthBillingSeatUsageResponse,
  ApiAuthCapabilitiesResponse,
  ApiAuthIdentityResponse,
  ApiAuthSessionsListResponse,
  ApiBranchPolicySettingsResponse,
  ApiConfigureAuthSsoSettingsResponse,
  ApiLocalizationRunConfigResponse,
  ApiMemberInvitationResponse,
  ApiMemberResponse,
  ApiMembersListResponse,
  ApiModelRoutingSettingsResponse,
  ApiRevokeAuthSessionResponse,
  ApiTranslationScopeSettingsResponse,
} from "./api-settings-and-membership-types.js";
import {
  ApiLaunchPassResponse,
  ApiLocalizationPassControlResponse,
  ApiPatchIterationDeliveryResponse,
  ApiPermissionSetsListResponse,
  ApiPlayAddressableUnitResponse,
  ApiPlayDeliveryResponse,
  ApiPlayFlagAnnotationResponse,
  ApiPlayRouteMapResponse,
  ApiPlayTargetEditResponse,
  ApiPlayUnitFeedbackResponse,
  ApiPrincipalPermissionSetGrantResponse,
  ApiRemoveMemberResponse,
} from "./api-play-session-types.js";

export type ApiPatchIterationQaCallout = {
  journalFindingId: string;
  bridgeUnitId: string;
  severity: string;
  category: string;
  note: string;
  confidence: string;
  contested: boolean;
  informational: true;
};

export type ApiPatchIterationUnit = {
  bridgeUnitId: string;
  sourceRunId: string;
  journalOutcomeId: string;
  resultRevisionId: string;
  targetBody: string;
  memberOrigin: "run_written_outcome" | "reused_from_base" | "play_tester_edit";
  reusedFromPatchVersionId: string | null;
  unitOrdinal: number;
};

export type ApiPatchIterationPatch = {
  patchVersionId: string;
  runId: string;
  parentPatchVersionId: string | null;
  origin: "run_finalizer" | "play_tester_edit" | "refinement_run";
  status: string;
  playableAt: string | null;
  selectedAt: string | null;
  artifactHashes: Record<string, string>;
  units: ApiPatchIterationUnit[];
  qaCallouts: ApiPatchIterationQaCallout[];
};

export type ApiPatchIterationVersion = {
  patchVersionId: string;
  runId: string;
  parentPatchVersionId: string | null;
  origin: "run_finalizer" | "play_tester_edit" | "refinement_run";
  status: string;
  playableAt: string | null;
  selectedAt: string | null;
  artifactHashes: Record<string, string>;
  basePatchVersionId: string | null;
};

export type ApiPatchIterationFeedbackEvent = {
  feedbackEventId: string;
  feedbackBatchId: string;
  observedPatchVersionId: string;
  playSessionId: string | null;
  actorUserId: string;
  eventKind: "result_edit" | "comment" | "added_context" | "wiki_edit";
  body: string | null;
  metadata: Record<string, unknown>;
  resultRevisionId: string | null;
  contextArtifactId: string | null;
  contextEntryVersionId: string | null;
  affectedBridgeUnitIds: string[];
  createdAt: string;
};

export type ApiPatchIterationFeedbackBatch = {
  feedbackBatchId: string;
  observedPatchVersionId: string;
  actorUserId: string;
  selectionKind: "individual" | "batch";
  label: string | null;
  createdAt: string;
  updatedAt: string;
  events: ApiPatchIterationFeedbackEvent[];
};

export type ApiPatchIterationFeedbackInbox = {
  observedPatchVersionId: string;
  batches: ApiPatchIterationFeedbackBatch[];
};

export type ApiPatchIterationSession = {
  playSessionId: string;
  observedPatchVersionId: string;
  actorUserId: string;
  status: "active" | "completed" | "abandoned";
  startedAt: string;
  endedAt: string | null;
  qaCallouts: ApiPatchIterationQaCallout[];
};

export type ApiPatchIterationRefinementMember = {
  bridgeUnitId: string;
  strategy: "reuse" | "redraft" | "new_scope";
  basePatchVersionId: string | null;
  baseSourceRunId: string | null;
  baseJournalOutcomeId: string | null;
  baseResultRevisionId: string | null;
};

export type ApiPatchIterationRefinement = {
  runId: string;
  basePatchVersionId: string;
  feedbackBatchIds: string[];
  wikiHeads: Array<{ contextArtifactId: string; contextEntryVersionId: string }>;
  members: ApiPatchIterationRefinementMember[];
};

export type ApiPatchIterationVersionsResponse = {
  schemaVersion: "itotori.patch-iteration.versions.v0";
  versions: ApiPatchIterationVersion[];
};

export type ApiPatchIterationSurfaceResponse = {
  schemaVersion: "itotori.patch-iteration.surface.v0";
  patch: ApiPatchIterationPatch;
  versions: ApiPatchIterationVersion[];
  feedback: ApiPatchIterationFeedbackInbox;
};

export type ApiPatchIterationPlayRequest = {
  adapterId: string;
  operation: string;
  artifactRoot?: string;
  output?: string;
  launchDescriptor: Record<string, unknown>;
};

/**
 * The kept patch-play mutation's response: the runtime launch receipt from the
 * composition `runPlaySession` path (Utsushi real replay). It deliberately no
 * longer embeds a journal play session — that is the legacy
 * `PatchIterationService.play` reservation/finalizer surface.
 */
export type ApiPatchIterationPlayResponse = {
  schemaVersion: "itotori.patch-iteration.play.v0";
  receipt: ApiPatchIterationPlayReceipt;
};

/** Adapter-discriminated receipt payload; add another member when registering another adapter. */
export type ApiPatchIterationPlayReceipt = {
  adapterId: "reallive";
  operation: "replay-validate";
  adapterReceipt: {
    replay: "observed";
    scene: number;
    observedTextLineCount: number;
  };
};

export type ApiPatchIterationFeedbackBatchRequest = {
  feedbackBatchId?: string;
  label?: string;
};

export type ApiPatchIterationFeedbackBatchResponse = {
  schemaVersion: "itotori.patch-iteration.feedback-batch.v0";
  batch: ApiPatchIterationFeedbackBatch;
};

/**
 * A first-class context correction performed through the existing WikiBrain
 * boundary. The observed patch supplies project/branch/source identity; this
 * payload intentionally contains only the human correction itself.
 */
export type ApiPatchIterationContextFeedback =
  | {
      operation: "add";
      kind: ApiWikiAddKind;
      title: string;
      body: string;
      reason: string;
      affectedBridgeUnitIds: string[];
    }
  | {
      operation: "edit";
      contextArtifactId: string;
      body: string;
      reason: string;
      title?: string;
      affectedBridgeUnitIds?: string[];
    };

export type ApiPatchIterationFeedbackRequest = {
  feedbackBatchId?: string;
  playSessionId?: string;
  eventKind: ApiPatchIterationFeedbackEvent["eventKind"];
  body?: string;
  metadata?: Record<string, unknown>;
  targetBody?: string;
  resultRevisionId?: string;
  contextArtifactId?: string;
  contextEntryVersionId?: string;
  contextFeedback?: ApiPatchIterationContextFeedback;
  affectedBridgeUnitIds?: string[];
};

export type ApiPatchIterationFeedbackResponse = {
  schemaVersion: "itotori.patch-iteration.feedback.v0";
  feedback: ApiPatchIterationFeedbackEvent;
};

export type ApiPatchIterationRefineRequest = {
  feedbackBatchIds?: string[];
  feedbackEventIds?: string[];
  scopeUnitIds?: string[];
  targetBodiesByUnit?: Record<string, string>;
  wikiHeads?: Array<{ contextArtifactId: string; contextEntryVersionId: string }>;
};

export type ApiPatchIterationRefineResponse = {
  schemaVersion: "itotori.patch-iteration.refine.v0";
  refinement: ApiPatchIterationRefinement;
  patch: ApiPatchIterationPatch;
};

export type ItotoriApiResponseBody =
  | ApiAssetDecisionsResponse
  | ApiCandidateAssetsResponse
  | ApiCatalogBenchmarkSeedsResponse
  | ApiCatalogContextPanelResponse
  | ApiCatalogCompletenessResponse
  | ApiCatalogConflictReviewResponse
  | ApiCatalogOpportunitiesResponse
  | ApiTerminologySearchResponse
  | ApiWikiListResponse
  | ApiWikiShowResponse
  | ApiWikiHistoryResponse
  | ApiWikiEditResponse
  | ApiWikiFeedbackResponse
  | ApiWikiApplyResponse
  | ApiProjectsResponse
  | ApiProjectOverviewResponse
  | ProjectDashboardStatus
  | ApiDashboardDecisionsResponse
  | ApiProjectCostResponse
  | ApiProjectCostDrilldownResponse
  | ApiBenchmarkReportsResponse
  | ApiJobsRunTableResponse
  | ApiQueueHealthResponse
  | RuntimeDashboardStatus
  | ApiProjectDecodeExtractResponse
  | ApiProjectImportResponse
  | ApiDraftBranchResponse
  | ApiRecordFindingResponse
  | ApiRecordBenchmarkResponse
  | ApiRuntimeEvidenceResponse
  | ApiModelRoutingSettingsResponse
  | ApiBranchPolicySettingsResponse
  | ApiTranslationScopeSettingsResponse
  | ApiLocalizationRunConfigResponse
  | ApiConfigureAuthSsoSettingsResponse
  | ApiMemberInvitationResponse
  | ApiMemberResponse
  | ApiMembersListResponse
  | ApiAuthBillingSeatUsageResponse
  | ApiRemoveMemberResponse
  | ApiPermissionSetsListResponse
  | ApiPrincipalPermissionSetGrantResponse
  | ApiAuthSessionsListResponse
  | ApiRevokeAuthSessionResponse
  | ApiAuthIdentityResponse
  | ApiAuthCapabilitiesResponse
  | ApiLaunchPassResponse
  | ApiLocalizationPassControlResponse
  | ApiPlayRouteMapResponse
  | ApiPlayFlagAnnotationResponse
  | ApiPlayUnitFeedbackResponse
  | ApiPlayAddressableUnitResponse
  | ApiPlayTargetEditResponse
  | ApiPlayDeliveryResponse
  | ApiPatchIterationVersionsResponse
  | ApiPatchIterationSurfaceResponse
  | ApiPatchIterationDeliveryResponse
  | ApiPatchIterationPlayResponse
  | ApiPatchIterationFeedbackBatchResponse
  | ApiPatchIterationFeedbackResponse
  | ApiPatchIterationRefineResponse
  | ApiErrorResponse;
