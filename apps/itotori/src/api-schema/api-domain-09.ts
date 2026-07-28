import {
  AssetDecisionRecord,
  AssetLocalizationDecisionAssetKind,
  CandidateAssetRecord,
  assetLocalizationDecisionAssetKindList,
  assetLocalizationDecisionPolicyList,
} from "./dependencies.js";
import { ItotoriApiRouteId } from "./api-domain-01.js";
import { STRICT_API_BODY_KEYS } from "./api-domain-02.js";
import { ApiAssetDecisionsResponse, ApiCandidateAssetsResponse } from "./api-domain-03.js";
import { ItotoriApiResponseBody } from "./api-domain-06.js";
import {
  assertWikiApplyResponse,
  assertWikiObjectHistoryResponse,
  assertWikiObjectListResponse,
  assertWikiObjectShowResponse,
  assertWikiObjectWriteResponse,
} from "./api-domain-10.js";
import { assertCatalogOpportunityRankingReadModel } from "./api-domain-11.js";
import { assertCatalogContextPanelReadModel } from "./api-domain-12.js";
import { assertCatalogBenchmarkSeedFinderReadModel } from "./api-domain-13.js";
import { assertTerminologySearchReadModel } from "./api-domain-14.js";
import { assertCatalogCompletenessBenchmarkPools } from "./api-domain-15.js";
import {
  assertApiBenchmarkReportsResponse,
  assertCatalogConflictReviewReadModel,
  assertProjectDashboardStatus,
  assertQueueHealthReadModel,
} from "./api-domain-16.js";
import { assertProjectCostReport } from "./api-domain-18.js";
import {
  assertJobsRunTableReadModel,
  assertProjectCostDrilldownResponse,
  assertProjectOverviewReadModel,
} from "./api-domain-19.js";
import { assertDashboardDecisionReadModel, assertRuntimeDashboardStatus } from "./api-domain-20.js";
import {
  assertDraftBranchResponse,
  assertProjectDecodeExtractResponse,
  assertProjectImportResponse,
  assertProjectsResponse,
  assertRecordBenchmarkResponse,
  assertRecordFindingResponse,
  assertRuntimeEvidenceResponse,
} from "./api-domain-21.js";
import {
  assertBranchPolicySettingsResponse,
  assertConfigureAuthSsoSettingsResponse,
  assertLocalizationRunConfigResponse,
  assertModelRoutingSettingsResponse,
  assertTranslationScopeSettingsResponse,
} from "./api-domain-22.js";
import {
  assertAuthBillingSeatUsageResponse,
  assertAuthCapabilitiesResponse,
  assertAuthIdentityResponse,
  assertAuthSessionsListResponse,
  assertMemberInvitationResponse,
  assertMemberResponse,
  assertMembersListResponse,
  assertPermissionSetsListResponse,
  assertPrincipalPermissionSetGrantResponse,
  assertRemoveMemberResponse,
  assertRevokeAuthSessionResponse,
} from "./api-domain-23.js";
import { assertLaunchPassResponse } from "./api-domain-24.js";
import { assertPlayRouteMapResponse } from "./api-domain-25.js";
import {
  assertPatchIterationDeliveryResponse,
  assertPlayAddressableUnitResponse,
  assertPlayDeliveryResponse,
  assertPlayFlagAnnotationResponse,
  assertPlayTargetEditResponse,
  assertPlayUnitFeedbackResponse,
} from "./api-domain-26.js";
import {
  assertPatchIterationFeedbackBatchResponse,
  assertPatchIterationFeedbackResponse,
  assertPatchIterationPlayResponse,
  assertPatchIterationRefineResponse,
  assertPatchIterationSurfaceResponse,
  assertPatchIterationVersionsResponse,
} from "./api-domain-27.js";
import { asRecord } from "./api-domain-28.js";
import {
  asArray,
  asStrictRecord,
  assertDateLike,
  assertEnum,
  assertNullableDateLike,
  assertNullableString,
  assertString,
} from "./api-domain-29.js";

export function assertItotoriApiResponse(
  routeId: ItotoriApiRouteId,
  value: unknown,
): asserts value is ItotoriApiResponseBody {
  switch (routeId) {
    case "assetDecisions.active":
      assertApiAssetDecisionsResponse(value);
      return;
    case "assetDecisions.candidates":
      assertApiCandidateAssetsResponse(value);
      return;
    case "catalog.benchmarkSeeds":
      assertCatalogBenchmarkSeedFinderReadModel(value);
      return;
    case "catalog.contextPanel":
      assertCatalogContextPanelReadModel(value);
      return;
    case "catalog.completeness":
      assertCatalogCompletenessBenchmarkPools(value);
      return;
    case "catalog.conflicts":
      assertCatalogConflictReviewReadModel(value);
      return;
    case "catalog.opportunities":
      assertCatalogOpportunityRankingReadModel(value);
      return;
    case "terminology.search":
      assertTerminologySearchReadModel(value);
      return;
    case "wiki.list":
      assertWikiObjectListResponse(value);
      return;
    case "wiki.show":
      assertWikiObjectShowResponse(value);
      return;
    case "wiki.history":
      assertWikiObjectHistoryResponse(value);
      return;
    case "wiki.edit":
      assertWikiObjectWriteResponse(value);
      return;
    case "wiki.feedback":
      assertWikiObjectWriteResponse(value);
      return;
    case "wiki.apply":
      assertWikiApplyResponse(value);
      return;
    case "projects.list":
      assertProjectsResponse(value);
      return;
    case "projects.overview":
      assertProjectOverviewReadModel(value);
      return;
    case "projects.status":
      assertProjectDashboardStatus(value);
      return;
    case "projects.decisions":
      assertDashboardDecisionReadModel(value);
      return;
    case "projects.cost":
      assertProjectCostReport(value);
      return;
    case "projects.costDrilldown":
      assertProjectCostDrilldownResponse(value);
      return;
    case "projects.benchmarks":
      assertApiBenchmarkReportsResponse(value);
      return;
    case "jobs.runTable":
      assertJobsRunTableReadModel(value);
      return;
    case "queue.health":
      assertQueueHealthReadModel(value);
      return;
    case "runtime.status":
      assertRuntimeDashboardStatus(value);
      return;
    case "projects.decodeExtract":
      assertProjectDecodeExtractResponse(value);
      return;
    case "imports.bridge":
      assertProjectImportResponse(value);
      return;
    case "branches.draft":
      assertDraftBranchResponse(value);
      return;
    case "findings.record":
      assertRecordFindingResponse(value);
      return;
    case "benchmarks.record":
      assertRecordBenchmarkResponse(value);
      return;
    case "runtimeEvidence.ingest":
      assertRuntimeEvidenceResponse(value);
      return;
    case "settings.modelRouting.get":
    case "settings.modelRouting.save":
      assertModelRoutingSettingsResponse(value);
      return;
    case "settings.branchPolicy.get":
    case "settings.branchPolicy.save":
      assertBranchPolicySettingsResponse(value);
      return;
    case "settings.translationScope.get":
    case "settings.translationScope.save":
      assertTranslationScopeSettingsResponse(value);
      return;
    case "settings.localizationRunConfig.save":
      assertLocalizationRunConfigResponse(value);
      return;
    case "auth.ssoSettings.configure":
      assertConfigureAuthSsoSettingsResponse(value);
      return;
    case "auth.billing.seatUsage":
      assertAuthBillingSeatUsageResponse(value);
      return;
    case "auth.members.list":
      assertMembersListResponse(value);
      return;
    case "auth.members.invite":
      assertMemberInvitationResponse(value);
      return;
    case "auth.members.accept":
      assertMemberResponse(value);
      return;
    case "auth.members.remove":
      assertRemoveMemberResponse(value);
      return;
    case "auth.permissionSets.list":
      assertPermissionSetsListResponse(value);
      return;
    case "auth.permissionSets.grant":
    case "auth.permissionSets.revoke":
      assertPrincipalPermissionSetGrantResponse(value);
      return;
    case "auth.sessions.list":
      assertAuthSessionsListResponse(value);
      return;
    case "auth.sessions.revoke":
      assertRevokeAuthSessionResponse(value);
      return;
    case "auth.identity":
      assertAuthIdentityResponse(value);
      return;
    case "auth.capabilities":
      assertAuthCapabilitiesResponse(value);
      return;
    case "projects.launchPass":
      assertLaunchPassResponse(value);
      return;
    case "play.routeMap":
      assertPlayRouteMapResponse(value);
      return;
    case "play.flagAnnotation":
      assertPlayFlagAnnotationResponse(value);
      return;
    case "play.unitFeedback":
      assertPlayUnitFeedbackResponse(value);
      return;
    case "play.addressableUnit":
      assertPlayAddressableUnitResponse(value);
      return;
    case "play.targetEdit":
      assertPlayTargetEditResponse(value);
      return;
    case "play.delivery":
      assertPlayDeliveryResponse(value);
      return;
    case "patchIteration.versions":
      assertPatchIterationVersionsResponse(value);
      return;
    case "patchIteration.surface":
      assertPatchIterationSurfaceResponse(value);
      return;
    case "patchIteration.delivery":
      assertPatchIterationDeliveryResponse(value);
      return;
    case "patchIteration.play":
      assertPatchIterationPlayResponse(value);
      return;
    case "patchIteration.feedbackBatch":
      assertPatchIterationFeedbackBatchResponse(value);
      return;
    case "patchIteration.feedback":
      assertPatchIterationFeedbackResponse(value);
      return;
    case "patchIteration.refine":
      assertPatchIterationRefineResponse(value);
      return;
  }
}

export function assertApiAssetDecisionsResponse(
  value: unknown,
  label = "ApiAssetDecisionsResponse",
): asserts value is ApiAssetDecisionsResponse {
  const response = asStrictRecord(
    value,
    label,
    STRICT_API_BODY_KEYS.ApiAssetDecisionsResponse,
  );
  const decisions = asArray(response.decisions, `${label}.decisions`);
  for (const [index, decision] of decisions.entries()) {
    assertAssetDecisionRecord(decision, `${label}.decisions[${index}]`);
  }
}

export function assertApiCandidateAssetsResponse(
  value: unknown,
  label = "ApiCandidateAssetsResponse",
): asserts value is ApiCandidateAssetsResponse {
  const response = asStrictRecord(
    value,
    label,
    STRICT_API_BODY_KEYS.ApiCandidateAssetsResponse,
  );
  const candidateAssets = asArray(response.candidateAssets, `${label}.candidateAssets`);
  for (const [index, candidate] of candidateAssets.entries()) {
    assertCandidateAssetRecord(candidate, `${label}.candidateAssets[${index}]`);
  }
}

export function assertAssetDecisionRecord(
  value: unknown,
  label: string,
): asserts value is AssetDecisionRecord {
  const record = asStrictRecord(value, label, [
    "decisionId",
    "projectId",
    "localeBranchId",
    "assetRef",
    "assetKind",
    "decisionPolicy",
    "decisionRationale",
    "decidedByUserId",
    "decidedAt",
    "supersededAt",
    "supersededByDecisionId",
    "createdAt",
  ]);
  assertString(record.decisionId, `${label}.decisionId`);
  assertString(record.projectId, `${label}.projectId`);
  assertString(record.localeBranchId, `${label}.localeBranchId`);
  assertAssetRef(record.assetRef, `${label}.assetRef`);
  assertAssetDecisionKind(record.assetKind, `${label}.assetKind`);
  assertEnum(record.decisionPolicy, assetLocalizationDecisionPolicyList, `${label}.decisionPolicy`);
  assertNullableString(record.decisionRationale, `${label}.decisionRationale`);
  assertNullableString(record.decidedByUserId, `${label}.decidedByUserId`);
  assertDateLike(record.decidedAt, `${label}.decidedAt`);
  assertNullableDateLike(record.supersededAt, `${label}.supersededAt`);
  assertNullableString(record.supersededByDecisionId, `${label}.supersededByDecisionId`);
  assertDateLike(record.createdAt, `${label}.createdAt`);
}

export function assertCandidateAssetRecord(
  value: unknown,
  label: string,
): asserts value is CandidateAssetRecord {
  const record = asStrictRecord(value, label, ["assetRef", "assetKind", "displayLabel"]);
  assertAssetRef(record.assetRef, `${label}.assetRef`);
  assertAssetDecisionKind(record.assetKind, `${label}.assetKind`);
  if (record.displayLabel !== undefined) {
    assertString(record.displayLabel, `${label}.displayLabel`);
  }
}

export function assertAssetRef(value: unknown, label: string): void {
  const assetRef = asRecord(value, label);
  assertString(assetRef.kind, `${label}.kind`);
  assertString(assetRef.ref, `${label}.ref`);
}

export function assertAssetDecisionKind(
  value: unknown,
  label: string,
): asserts value is AssetLocalizationDecisionAssetKind {
  assertEnum(value, assetLocalizationDecisionAssetKindList, label);
}
