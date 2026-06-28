import type {
  CatalogConfidence,
  CatalogBenchmarkSeedFinderReadModel,
  CatalogCompletenessBenchmarkPools,
  CatalogConflictReviewReadModel,
  CatalogExternalIdKind,
  CatalogLanguageStatus,
  CatalogLanguageStatusScope,
  CatalogOpportunityDecision,
  CatalogOpportunityFactorName,
  CatalogOpportunityMarketPrevalenceSignal,
  CatalogOpportunityRankingReadModel,
  CatalogOpportunityRuntimeEvidenceSignal,
  CatalogRawContentRedactionClass,
  CatalogSource,
  CatalogSourceRecordKind,
  DashboardDecisionReadModel,
  ProjectCostReport,
  ProjectDashboardStatus,
  ReviewerQueueAction,
  ReviewerQueueItemRecord,
  ReviewerQueueTransitionRecord,
  RuntimeDashboardStatus,
  TerminologySearchReadModel,
} from "@itotori/db";
import {
  catalogConfidenceValues,
  catalogExternalIdKindValues,
  catalogLanguageStatusScopeValues,
  catalogLanguageStatusValues,
  catalogRawContentRedactionClassValues,
  catalogSourceRecordKindValues,
  catalogSourceValues,
  reviewerQueueActionList,
  reviewerQueueItemKindList,
  reviewerQueueItemStateList,
} from "@itotori/db";
import {
  assertBenchmarkReportV02,
  assertBridgeBundle,
  assertBridgeBundleV02,
  assertFindingRecordFixtureV02,
  assertPatchExport,
  assertPatchExportV02,
  assertRuntimeReport,
  assertTriageBundleV02,
  BENCHMARK_TOKEN_COUNT_SOURCES,
  BRIDGE_SCHEMA_VERSION_V02,
  TRIAGE_EVENT_KINDS,
  type BenchmarkReportV02,
  type BridgeBundle,
  type BridgeBundleV02,
  type FindingRecordV02,
  type PatchExport,
  type PatchExportV02,
  type RuntimeEvidenceReportV02,
  type RuntimeVerificationReport,
  type TriageEventV02,
} from "@itotori/localization-bridge-schema";
import type {
  BenchmarkRecordResult,
  DecisionRecordResult,
  FindingRecordResult,
  ProjectState,
  RuntimeIngestResult,
} from "./services/project-workflow.js";
import type {
  ReviewerQueueDashboardReadModel,
  ReviewerQueueDashboardRow,
  ReviewerQueueDashboardState,
} from "./reviewer/api-service.js";
import { reviewerQueueDashboardStateValues } from "./reviewer/api-service.js";
import type {
  ReviewerBatchActionRequest,
  ReviewerBatchPreview,
} from "./reviewer/batch-preview.js";
import type { ReviewerDetailContext } from "./reviewer/detail-fixtures.js";

export type ItotoriApiRouteId =
  | "catalog.benchmarkSeeds"
  | "catalog.completeness"
  | "catalog.conflicts"
  | "catalog.opportunities"
  | "reviewer.queue"
  | "reviewer.detail"
  | "reviewer.batchPreview"
  | "terminology.search"
  | "projects.list"
  | "projects.status"
  | "projects.decisions"
  | "projects.cost"
  | "runtime.status"
  | "imports.bridge"
  | "branches.draft"
  | "findings.record"
  | "decisions.record"
  | "benchmarks.record"
  | "runtimeEvidence.ingest";

export type ApiErrorResponse = {
  error: string;
  code: "bad_request" | "forbidden" | "not_found" | "method_not_allowed" | "internal_error";
};

export type ApiProjectsResponse = {
  projects: ProjectDashboardStatus[];
};

export type ApiProjectCostResponse = ProjectCostReport;

export type ApiDashboardDecisionsResponse = DashboardDecisionReadModel;

export type ApiCatalogConflictReviewResponse = CatalogConflictReviewReadModel;

export type ApiCatalogCompletenessResponse = CatalogCompletenessBenchmarkPools;

export type ApiCatalogBenchmarkSeedsResponse = CatalogBenchmarkSeedFinderReadModel;

export type ApiCatalogOpportunitiesResponse = CatalogOpportunityRankingReadModel;

export type ApiTerminologySearchResponse = TerminologySearchReadModel;

export type ApiReviewerQueueDashboardResponse = ReviewerQueueDashboardReadModel;

export type ApiReviewerDetailResponse = ReviewerDetailContext;

export type ApiReviewerBatchPreviewRequest = ReviewerBatchActionRequest;

export type ApiReviewerBatchPreviewResponse = ReviewerBatchPreview;

export type ApiProjectImportRequest = {
  bridge: BridgeBundle | BridgeBundleV02;
};

export type ApiProjectImportResponse = {
  project: ProjectState;
  status: ProjectDashboardStatus;
};

export type ApiDraftBranchRequest = {
  project: ProjectState;
  targetLocale: string;
};

export type ApiDraftBranchResponse = {
  project: ProjectState;
  status: ProjectDashboardStatus;
};

export type ApiRecordFindingRequest = {
  localeBranchId?: string;
  finding: FindingRecordV02;
  status?: "open" | "resolved" | "superseded";
};

export type ApiRecordFindingResponse = FindingRecordResult;

export type ApiRecordDecisionRequest = {
  localeBranchId?: string;
  event: TriageEventV02;
};

export type ApiRecordDecisionResponse = DecisionRecordResult;

export type ApiRecordBenchmarkRequest = {
  localeBranchId?: string;
  benchmarkReport: BenchmarkReportV02;
};

export type ApiRecordBenchmarkResponse = BenchmarkRecordResult;

export type ApiRuntimeEvidenceRequest = {
  project: ProjectState;
  runtimeReport: RuntimeVerificationReport | RuntimeEvidenceReportV02;
};

export type ApiRuntimeEvidenceResponse = RuntimeIngestResult;

export type ItotoriApiResponseBody =
  | ApiCatalogBenchmarkSeedsResponse
  | ApiCatalogCompletenessResponse
  | ApiCatalogConflictReviewResponse
  | ApiCatalogOpportunitiesResponse
  | ApiReviewerQueueDashboardResponse
  | ApiReviewerDetailResponse
  | ApiReviewerBatchPreviewResponse
  | ApiTerminologySearchResponse
  | ApiProjectsResponse
  | ProjectDashboardStatus
  | ApiDashboardDecisionsResponse
  | ApiProjectCostResponse
  | RuntimeDashboardStatus
  | ApiProjectImportResponse
  | ApiDraftBranchResponse
  | ApiRecordFindingResponse
  | ApiRecordDecisionResponse
  | ApiRecordBenchmarkResponse
  | ApiRuntimeEvidenceResponse
  | ApiErrorResponse;

export class ApiValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiValidationError";
  }
}

export function parseProjectImportRequest(body: unknown): ApiProjectImportRequest {
  return parseRequest("ApiProjectImportRequest", () => {
    const request = asRecord(body, "ApiProjectImportRequest");
    assertBridgeInput(request.bridge);
    return { bridge: request.bridge };
  });
}

export function parseDraftBranchRequest(body: unknown): ApiDraftBranchRequest {
  return parseRequest("ApiDraftBranchRequest", () => {
    const request = asRecord(body, "ApiDraftBranchRequest");
    assertProjectState(request.project, "ApiDraftBranchRequest.project");
    assertString(request.targetLocale, "ApiDraftBranchRequest.targetLocale");
    return { project: request.project, targetLocale: request.targetLocale };
  });
}

export function parseRecordFindingRequest(body: unknown): ApiRecordFindingRequest {
  return parseRequest("ApiRecordFindingRequest", () => {
    const request = asRecord(body, "ApiRecordFindingRequest");
    if (request.localeBranchId !== undefined) {
      assertString(request.localeBranchId, "ApiRecordFindingRequest.localeBranchId");
    }
    assertFindingRecordInput(request.finding, "ApiRecordFindingRequest.finding");
    const result: ApiRecordFindingRequest = { finding: request.finding };
    if (request.localeBranchId !== undefined) {
      result.localeBranchId = request.localeBranchId;
    }
    if (request.status !== undefined) {
      assertEnum(
        request.status,
        ["open", "resolved", "superseded"] as const,
        "ApiRecordFindingRequest.status",
      );
      result.status = request.status;
    }
    return result;
  });
}

export function parseRecordDecisionRequest(body: unknown): ApiRecordDecisionRequest {
  return parseRequest("ApiRecordDecisionRequest", () => {
    const request = asRecord(body, "ApiRecordDecisionRequest");
    if (request.localeBranchId !== undefined) {
      assertString(request.localeBranchId, "ApiRecordDecisionRequest.localeBranchId");
    }
    assertDecisionEvent(request.event, "ApiRecordDecisionRequest.event");
    const result: ApiRecordDecisionRequest = { event: request.event };
    if (request.localeBranchId !== undefined) {
      result.localeBranchId = request.localeBranchId;
    }
    return result;
  });
}

export function parseRecordBenchmarkRequest(body: unknown): ApiRecordBenchmarkRequest {
  return parseRequest("ApiRecordBenchmarkRequest", () => {
    const request = asRecord(body, "ApiRecordBenchmarkRequest");
    if (request.localeBranchId !== undefined) {
      assertString(request.localeBranchId, "ApiRecordBenchmarkRequest.localeBranchId");
    }
    assertBenchmarkReportV02(request.benchmarkReport);
    const result: ApiRecordBenchmarkRequest = { benchmarkReport: request.benchmarkReport };
    if (request.localeBranchId !== undefined) {
      result.localeBranchId = request.localeBranchId;
    }
    return result;
  });
}

export function parseRuntimeEvidenceRequest(body: unknown): ApiRuntimeEvidenceRequest {
  return parseRequest("ApiRuntimeEvidenceRequest", () => {
    const request = asRecord(body, "ApiRuntimeEvidenceRequest");
    assertProjectState(request.project, "ApiRuntimeEvidenceRequest.project");
    assertRuntimeReport(request.runtimeReport);
    return { project: request.project, runtimeReport: request.runtimeReport };
  });
}

export function parseReviewerBatchPreviewRequest(body: unknown): ApiReviewerBatchPreviewRequest {
  return parseRequest("ApiReviewerBatchPreviewRequest", () => {
    const request = asStrictRecord(body, "ApiReviewerBatchPreviewRequest", [
      "action",
      "actorUserId",
      "selections",
    ]);
    assertEnum(
      request.action,
      reviewerQueueActionList as readonly ReviewerQueueAction[],
      "ApiReviewerBatchPreviewRequest.action",
    );
    assertString(request.actorUserId, "ApiReviewerBatchPreviewRequest.actorUserId");
    const selections = asArray(
      request.selections,
      "ApiReviewerBatchPreviewRequest.selections",
    ).map((value, index) => {
      const selection = asStrictRecord(
        value,
        `ApiReviewerBatchPreviewRequest.selections[${index}]`,
        ["reviewItemId", "expectedSourceRevisionId"],
      );
      assertString(
        selection.reviewItemId,
        `ApiReviewerBatchPreviewRequest.selections[${index}].reviewItemId`,
      );
      assertString(
        selection.expectedSourceRevisionId,
        `ApiReviewerBatchPreviewRequest.selections[${index}].expectedSourceRevisionId`,
      );
      return {
        reviewItemId: selection.reviewItemId,
        expectedSourceRevisionId: selection.expectedSourceRevisionId,
      };
    });
    return {
      action: request.action,
      actorUserId: request.actorUserId,
      selections,
    };
  });
}

export function assertItotoriApiResponse(
  routeId: ItotoriApiRouteId,
  value: unknown,
): asserts value is ItotoriApiResponseBody {
  switch (routeId) {
    case "catalog.benchmarkSeeds":
      assertCatalogBenchmarkSeedFinderReadModel(value);
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
    case "reviewer.queue":
      assertReviewerQueueDashboardReadModel(value);
      return;
    case "reviewer.detail":
      assertReviewerDetailContext(value);
      return;
    case "reviewer.batchPreview":
      assertReviewerBatchPreview(value);
      return;
    case "terminology.search":
      assertTerminologySearchReadModel(value);
      return;
    case "projects.list":
      assertProjectsResponse(value);
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
    case "runtime.status":
      assertRuntimeDashboardStatus(value);
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
    case "decisions.record":
      assertRecordDecisionResponse(value);
      return;
    case "benchmarks.record":
      assertRecordBenchmarkResponse(value);
      return;
    case "runtimeEvidence.ingest":
      assertRuntimeEvidenceResponse(value);
      return;
  }
}

export function assertReviewerQueueDashboardReadModel(
  value: unknown,
  label = "ReviewerQueueDashboardReadModel",
): asserts value is ReviewerQueueDashboardReadModel {
  const model = asStrictRecord(value, label, [
    "schemaVersion",
    "localeBranchId",
    "generatedAt",
    "permission",
    "rows",
    "aggregate",
    "defaultBatchRequest",
  ]);
  assertLiteral(model.schemaVersion, "reviewer.queue_dashboard.v0.1", `${label}.schemaVersion`);
  assertString(model.localeBranchId, `${label}.localeBranchId`);
  assertDateLike(model.generatedAt, `${label}.generatedAt`);
  assertReviewerQueuePermissionView(model.permission, `${label}.permission`);
  const rows = asArray(model.rows, `${label}.rows`);
  for (const [index, row] of rows.entries()) {
    assertReviewerQueueDashboardRow(row, `${label}.rows[${index}]`);
  }
  assertReviewerQueueDashboardAggregate(model.aggregate, `${label}.aggregate`);
  assertReviewerBatchActionRequest(model.defaultBatchRequest, `${label}.defaultBatchRequest`);
}

function assertReviewerQueueDashboardRow(
  value: unknown,
  label: string,
): asserts value is ReviewerQueueDashboardRow {
  const row = asStrictRecord(value, label, [
    "reviewItemId",
    "projectId",
    "localeBranchId",
    "sourceRevisionId",
    "itemKind",
    "sourceItemRef",
    "summary",
    "priority",
    "state",
    "dashboardState",
    "lastAction",
    "batchActionId",
    "findingId",
    "decisionId",
    "detailPath",
    "selectedForBatch",
    "createdAt",
    "updatedAt",
    "resolvedAt",
  ]);
  assertString(row.reviewItemId, `${label}.reviewItemId`);
  assertString(row.projectId, `${label}.projectId`);
  assertString(row.localeBranchId, `${label}.localeBranchId`);
  assertString(row.sourceRevisionId, `${label}.sourceRevisionId`);
  assertEnum(row.itemKind, reviewerQueueItemKindList, `${label}.itemKind`);
  assertString(row.sourceItemRef, `${label}.sourceItemRef`);
  assertString(row.summary, `${label}.summary`);
  assertNonNegativeInteger(row.priority, `${label}.priority`);
  assertEnum(row.state, reviewerQueueItemStateList, `${label}.state`);
  assertEnum(
    row.dashboardState,
    Object.values(reviewerQueueDashboardStateValues) as ReviewerQueueDashboardState[],
    `${label}.dashboardState`,
  );
  assertNullableReviewerQueueAction(row.lastAction, `${label}.lastAction`);
  assertNullableString(row.batchActionId, `${label}.batchActionId`);
  assertNullableString(row.findingId, `${label}.findingId`);
  assertNullableString(row.decisionId, `${label}.decisionId`);
  assertString(row.detailPath, `${label}.detailPath`);
  assertBoolean(row.selectedForBatch, `${label}.selectedForBatch`);
  assertDateLike(row.createdAt, `${label}.createdAt`);
  assertDateLike(row.updatedAt, `${label}.updatedAt`);
  assertNullableDateLike(row.resolvedAt, `${label}.resolvedAt`);
}

function assertReviewerQueueDashboardAggregate(value: unknown, label: string): void {
  const aggregate = asStrictRecord(value, label, [
    "pending",
    "resolved",
    "deferred",
    "escalated",
    "batch_applied",
  ]);
  for (const state of Object.values(reviewerQueueDashboardStateValues)) {
    assertNonNegativeInteger(aggregate[state], `${label}.${state}`);
  }
}

function assertReviewerQueuePermissionView(value: unknown, label: string): void {
  const permission = asStrictRecord(value, label, [
    "actorUserId",
    "canReadQueue",
    "canManageQueue",
    "denialReasons",
  ]);
  assertString(permission.actorUserId, `${label}.actorUserId`);
  assertBoolean(permission.canReadQueue, `${label}.canReadQueue`);
  assertBoolean(permission.canManageQueue, `${label}.canManageQueue`);
  assertStringArray(permission.denialReasons, `${label}.denialReasons`);
}

function assertReviewerBatchActionRequest(value: unknown, label: string): void {
  const request = asStrictRecord(value, label, ["action", "actorUserId", "selections"]);
  assertEnum(
    request.action,
    reviewerQueueActionList as readonly ReviewerQueueAction[],
    `${label}.action`,
  );
  assertString(request.actorUserId, `${label}.actorUserId`);
  const selections = asArray(request.selections, `${label}.selections`);
  for (const [index, selectionValue] of selections.entries()) {
    const selection = asStrictRecord(selectionValue, `${label}.selections[${index}]`, [
      "reviewItemId",
      "expectedSourceRevisionId",
    ]);
    assertString(selection.reviewItemId, `${label}.selections[${index}].reviewItemId`);
    assertString(
      selection.expectedSourceRevisionId,
      `${label}.selections[${index}].expectedSourceRevisionId`,
    );
  }
}

function assertReviewerDetailContext(
  value: unknown,
  label = "ReviewerDetailContext",
): asserts value is ReviewerDetailContext {
  const context = asStrictRecord(value, label, [
    "reviewItemId",
    "permission",
    "item",
    "source",
    "draft",
    "policy",
    "glossary",
    "qaFindings",
    "runtimeEvidence",
    "rationaleRefs",
    "transitions",
    "diagnostics",
  ]);
  assertString(context.reviewItemId, `${label}.reviewItemId`);
  assertReviewerQueuePermissionView(context.permission, `${label}.permission`);
  if (context.item !== null) {
    assertReviewerQueueItemRecord(context.item, `${label}.item`);
  }
  asArray(context.glossary, `${label}.glossary`);
  asArray(context.qaFindings, `${label}.qaFindings`);
  asArray(context.runtimeEvidence, `${label}.runtimeEvidence`);
  asArray(context.rationaleRefs, `${label}.rationaleRefs`);
  asArray(context.transitions, `${label}.transitions`);
  asArray(context.diagnostics, `${label}.diagnostics`);
}

function assertReviewerBatchPreview(
  value: unknown,
  label = "ReviewerBatchPreview",
): asserts value is ReviewerBatchPreview {
  const preview = asStrictRecord(value, label, [
    "request",
    "permission",
    "items",
    "aggregate",
    "allAllowed",
    "permissionDenied",
  ]);
  assertReviewerBatchActionRequest(preview.request, `${label}.request`);
  assertReviewerQueuePermissionView(preview.permission, `${label}.permission`);
  asArray(preview.items, `${label}.items`);
  const aggregate = asStrictRecord(preview.aggregate, `${label}.aggregate`, [
    "total",
    "allowed",
    "denied",
    "stale",
    "notFound",
    "duplicate",
    "runtimeEvidenceInvariant",
    "invalidInput",
    "invalidTransition",
    "permissionDeniedManage",
  ]);
  for (const key of Object.keys(aggregate)) {
    assertNonNegativeInteger(aggregate[key], `${label}.aggregate.${key}`);
  }
  assertBoolean(preview.allAllowed, `${label}.allAllowed`);
  assertBoolean(preview.permissionDenied, `${label}.permissionDenied`);
}

function assertReviewerQueueItemRecord(value: unknown, label: string): void {
  const item = asStrictRecord(value, label, [
    "reviewItemId",
    "projectId",
    "localeBranchId",
    "sourceRevisionId",
    "itemKind",
    "sourceItemRef",
    "state",
    "priority",
    "summary",
    "affectedArtifactIds",
    "evidenceTier",
    "observationEventIds",
    "artifactHashes",
    "payload",
    "metadata",
    "createdByUserId",
    "assignedToUserId",
    "createdAt",
    "updatedAt",
    "resolvedAt",
  ]);
  assertString(item.reviewItemId, `${label}.reviewItemId`);
  assertString(item.projectId, `${label}.projectId`);
  assertString(item.localeBranchId, `${label}.localeBranchId`);
  assertString(item.sourceRevisionId, `${label}.sourceRevisionId`);
  assertEnum(item.itemKind, reviewerQueueItemKindList, `${label}.itemKind`);
  assertString(item.sourceItemRef, `${label}.sourceItemRef`);
  assertEnum(item.state, reviewerQueueItemStateList, `${label}.state`);
  assertNonNegativeInteger(item.priority, `${label}.priority`);
  assertString(item.summary, `${label}.summary`);
  assertStringArray(item.affectedArtifactIds, `${label}.affectedArtifactIds`);
  assertNullableString(item.evidenceTier, `${label}.evidenceTier`);
  if (item.observationEventIds !== null) {
    assertStringArray(item.observationEventIds, `${label}.observationEventIds`);
  }
  if (item.artifactHashes !== null) {
    assertStringArray(item.artifactHashes, `${label}.artifactHashes`);
  }
  asRecord(item.payload, `${label}.payload`);
  asRecord(item.metadata, `${label}.metadata`);
  assertNullableString(item.createdByUserId, `${label}.createdByUserId`);
  assertNullableString(item.assignedToUserId, `${label}.assignedToUserId`);
  assertDateLike(item.createdAt, `${label}.createdAt`);
  assertDateLike(item.updatedAt, `${label}.updatedAt`);
  assertNullableDateLike(item.resolvedAt, `${label}.resolvedAt`);
}

function assertNullableReviewerQueueAction(value: unknown, label: string): void {
  if (value !== null) {
    assertEnum(value, reviewerQueueActionList as readonly ReviewerQueueAction[], label);
  }
}

export function assertCatalogOpportunityRankingReadModel(
  value: unknown,
  label = "CatalogOpportunityRankingReadModel",
): asserts value is CatalogOpportunityRankingReadModel {
  const model = asStrictRecord(value, label, [
    "schemaVersion",
    "targetLanguage",
    "generatedAt",
    "weightsVersion",
    "rows",
  ]);
  assertLiteral(model.schemaVersion, "catalog.opportunity_ranking.v0.1", `${label}.schemaVersion`);
  assertPublicOpportunityString(model.targetLanguage, `${label}.targetLanguage`);
  assertDateLike(model.generatedAt, `${label}.generatedAt`);
  assertPublicOpportunityString(model.weightsVersion, `${label}.weightsVersion`);
  const rows = asArray(model.rows, `${label}.rows`);
  for (const [index, rowValue] of rows.entries()) {
    assertCatalogOpportunityRow(rowValue, `${label}.rows[${index}]`);
  }
}

function assertCatalogOpportunityRow(value: unknown, label: string): void {
  const row = asStrictRecord(value, label, [
    "rank",
    "workId",
    "canonicalTitle",
    "originalLanguage",
    "sourceIds",
    "engineName",
    "adapterId",
    "readiness",
    "runtimeEvidenceReadiness",
    "completenessPool",
    "translationStatuses",
    "demandFacts",
    "localOwnership",
    "localEvidenceCount",
    "marketPrevalence",
    "decision",
    "score",
    "factorBreakdown",
    "explanationCodes",
    "provenance",
    "demotions",
  ]);
  assertNonNegativeInteger(row.rank, `${label}.rank`);
  assertPublicOpportunityString(row.workId, `${label}.workId`);
  assertPublicOpportunityString(row.canonicalTitle, `${label}.canonicalTitle`);
  assertNullablePublicOpportunityString(row.originalLanguage, `${label}.originalLanguage`);
  assertCatalogBenchmarkSeedSourceIds(row.sourceIds, `${label}.sourceIds`);
  assertNullablePublicOpportunityString(row.engineName, `${label}.engineName`);
  assertNullablePublicOpportunityString(row.adapterId, `${label}.adapterId`);
  assertCatalogBenchmarkSeedReadiness(row.readiness, `${label}.readiness`);
  assertCatalogOpportunityRuntimeEvidenceReadiness(
    row.runtimeEvidenceReadiness,
    `${label}.runtimeEvidenceReadiness`,
  );
  assertEnum(
    row.completenessPool,
    ["mtl_only", "fan_partial", "no_english", "unknown", "conflict"] as const,
    `${label}.completenessPool`,
  );
  assertCatalogBenchmarkSeedTranslationStatuses(
    row.translationStatuses,
    `${label}.translationStatuses`,
  );
  assertCatalogOpportunityDemandFacts(row.demandFacts, `${label}.demandFacts`);
  assertEnum(
    row.localOwnership,
    ["owned", "not_owned", "unknown"] as const,
    `${label}.localOwnership`,
  );
  assertNonNegativeNumber(row.localEvidenceCount, `${label}.localEvidenceCount`);
  assertEnum(
    row.marketPrevalence,
    [
      "public_and_local_aggregate",
      "public_only",
      "local_aggregate_only",
      "unknown",
    ] as CatalogOpportunityMarketPrevalenceSignal[],
    `${label}.marketPrevalence`,
  );
  assertEnum(
    row.decision,
    ["candidate", "demoted", "excluded"] as CatalogOpportunityDecision[],
    `${label}.decision`,
  );
  assertFiniteNumber(row.score, `${label}.score`);
  assertCatalogOpportunityFactors(row.factorBreakdown, `${label}.factorBreakdown`);
  assertPublicOpportunityStringArray(row.explanationCodes, `${label}.explanationCodes`);
  assertCatalogBenchmarkSeedProvenance(row.provenance, `${label}.provenance`);
  assertCatalogOpportunityDemotions(row.demotions, `${label}.demotions`);
}

function assertCatalogOpportunityRuntimeEvidenceReadiness(value: unknown, label: string): void {
  const readiness = asStrictRecord(value, label, [
    "status",
    "publicFixtureEvidenceCount",
    "privateLocalAggregateEvidenceCount",
  ]);
  assertEnum(
    readiness.status,
    [
      "public_and_aggregate",
      "public_fixture",
      "private_local_aggregate",
      "partial_public_and_aggregate",
      "partial_public_fixture",
      "partial_private_local_aggregate",
      "unknown",
    ] as CatalogOpportunityRuntimeEvidenceSignal[],
    `${label}.status`,
  );
  assertNonNegativeNumber(
    readiness.publicFixtureEvidenceCount,
    `${label}.publicFixtureEvidenceCount`,
  );
  assertNonNegativeNumber(
    readiness.privateLocalAggregateEvidenceCount,
    `${label}.privateLocalAggregateEvidenceCount`,
  );
}

function assertCatalogOpportunityDemandFacts(value: unknown, label: string): void {
  const facts = asStrictRecord(value, label, [
    "demandBucket",
    "dlCount",
    "ratingAverage",
    "ratingCount",
    "wishlistCount",
    "bestRank",
    "workType",
  ]);
  assertEnum(
    facts.demandBucket,
    ["none", "low", "medium", "high", "very_high"] as const,
    `${label}.demandBucket`,
  );
  assertNullableNonNegativeInteger(facts.dlCount, `${label}.dlCount`);
  assertNullableNonNegativeNumber(facts.ratingAverage, `${label}.ratingAverage`);
  assertNullableNonNegativeInteger(facts.ratingCount, `${label}.ratingCount`);
  assertNullableNonNegativeInteger(facts.wishlistCount, `${label}.wishlistCount`);
  assertNullableNonNegativeInteger(facts.bestRank, `${label}.bestRank`);
  assertNullablePublicOpportunityString(facts.workType, `${label}.workType`);
}

function assertCatalogOpportunityFactors(value: unknown, label: string): void {
  const factors = asArray(value, label);
  for (const [index, factorValue] of factors.entries()) {
    const factorLabel = `${label}[${index}]`;
    const factor = asStrictRecord(factorValue, factorLabel, [
      "factor",
      "weight",
      "rawValue",
      "weightedScore",
      "evidenceRefs",
      "explanationCode",
    ]);
    assertEnum(
      factor.factor,
      [
        "translation_completeness",
        "local_ownership",
        "dlsite_demand",
        "platform_language_conflict",
        "market_prevalence",
        "adapter_readiness",
        "runtime_evidence_readiness",
        "dlsite_work_type",
        "existing_translation_status",
        "benchmark_usefulness",
        "unknown_evidence",
      ] as CatalogOpportunityFactorName[],
      `${factorLabel}.factor`,
    );
    assertFiniteNumber(factor.weight, `${factorLabel}.weight`);
    assertCatalogOpportunityRawValue(factor.rawValue, `${factorLabel}.rawValue`);
    assertFiniteNumber(factor.weightedScore, `${factorLabel}.weightedScore`);
    assertPublicOpportunityStringArray(factor.evidenceRefs, `${factorLabel}.evidenceRefs`);
    assertPublicOpportunityString(factor.explanationCode, `${factorLabel}.explanationCode`);
  }
}

function assertCatalogOpportunityRawValue(value: unknown, label: string): void {
  if (value === null || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    assertFiniteNumber(value, label);
    return;
  }
  assertPublicOpportunityString(value, label);
}

function assertCatalogOpportunityDemotions(value: unknown, label: string): void {
  const demotions = asArray(value, label);
  for (const [index, demotionValue] of demotions.entries()) {
    const demotionLabel = `${label}[${index}]`;
    const demotion = asStrictRecord(demotionValue, demotionLabel, [
      "reasonCode",
      "conflictId",
      "severity",
      "sourceIds",
    ]);
    assertPublicOpportunityString(demotion.reasonCode, `${demotionLabel}.reasonCode`);
    assertNullablePublicOpportunityString(demotion.conflictId, `${demotionLabel}.conflictId`);
    assertEnum(
      demotion.severity,
      ["error", "warning", "info"] as const,
      `${demotionLabel}.severity`,
    );
    assertCatalogOpportunityDemotionSourceIds(demotion.sourceIds, `${demotionLabel}.sourceIds`);
  }
}

function assertCatalogOpportunityDemotionSourceIds(value: unknown, label: string): void {
  const sourceIds = asArray(value, label);
  for (const [index, sourceIdValue] of sourceIds.entries()) {
    const sourceId = asStrictRecord(sourceIdValue, `${label}[${index}]`, [
      "catalogSource",
      "sourceId",
    ]);
    assertEnum(
      sourceId.catalogSource,
      Object.values(catalogSourceValues) as CatalogSource[],
      `${label}[${index}].catalogSource`,
    );
    if (sourceId.catalogSource === catalogSourceValues.localCorpus) {
      throw new Error(`${label}[${index}].catalogSource must not expose local corpus sources`);
    }
    assertPublicOpportunityString(sourceId.sourceId, `${label}[${index}].sourceId`);
  }
}

export function assertCatalogBenchmarkSeedFinderReadModel(
  value: unknown,
  label = "CatalogBenchmarkSeedFinderReadModel",
): asserts value is CatalogBenchmarkSeedFinderReadModel {
  const model = asStrictRecord(value, label, [
    "schemaVersion",
    "targetLanguage",
    "generatedAt",
    "rows",
  ]);
  assertLiteral(
    model.schemaVersion,
    "catalog.benchmark_seed_finder.v0.1",
    `${label}.schemaVersion`,
  );
  assertString(model.targetLanguage, `${label}.targetLanguage`);
  assertDateLike(model.generatedAt, `${label}.generatedAt`);
  const rows = asArray(model.rows, `${label}.rows`);
  for (const [index, rowValue] of rows.entries()) {
    const rowLabel = `${label}.rows[${index}]`;
    const row = asStrictRecord(rowValue, rowLabel, [
      "workId",
      "canonicalTitle",
      "originalLanguage",
      "sourceIds",
      "completenessPool",
      "translationStatuses",
      "localOwnership",
      "localEvidenceCount",
      "demandBucket",
      "readiness",
      "runtimeEvidenceReadiness",
      "provenance",
      "decision",
      "rank",
      "seedRank",
      "explanationCodes",
    ]);
    assertPublicBenchmarkSeedString(row.workId, `${rowLabel}.workId`);
    assertPublicBenchmarkSeedString(row.canonicalTitle, `${rowLabel}.canonicalTitle`);
    assertNullablePublicBenchmarkSeedString(row.originalLanguage, `${rowLabel}.originalLanguage`);
    assertCatalogBenchmarkSeedSourceIds(row.sourceIds, `${rowLabel}.sourceIds`);
    assertEnum(
      row.completenessPool,
      ["mtl_only", "fan_partial", "no_english", "unknown", "conflict"] as const,
      `${rowLabel}.completenessPool`,
    );
    assertCatalogBenchmarkSeedTranslationStatuses(
      row.translationStatuses,
      `${rowLabel}.translationStatuses`,
    );
    assertEnum(
      row.localOwnership,
      ["owned", "not_owned", "unknown"] as const,
      `${rowLabel}.localOwnership`,
    );
    assertNonNegativeNumber(row.localEvidenceCount, `${rowLabel}.localEvidenceCount`);
    assertEnum(
      row.demandBucket,
      ["none", "low", "medium", "high", "very_high"] as const,
      `${rowLabel}.demandBucket`,
    );
    assertCatalogBenchmarkSeedReadiness(row.readiness, `${rowLabel}.readiness`);
    if (row.runtimeEvidenceReadiness !== undefined) {
      assertCatalogBenchmarkSeedRuntimeEvidenceReadiness(
        row.runtimeEvidenceReadiness,
        `${rowLabel}.runtimeEvidenceReadiness`,
      );
    }
    assertCatalogBenchmarkSeedProvenance(row.provenance, `${rowLabel}.provenance`);
    assertEnum(
      row.decision,
      ["seed", "candidate", "demoted", "excluded"] as const,
      `${rowLabel}.decision`,
    );
    assertNonNegativeInteger(row.rank, `${rowLabel}.rank`);
    if (row.seedRank !== null) {
      assertNonNegativeInteger(row.seedRank, `${rowLabel}.seedRank`);
    }
    assertPublicBenchmarkSeedStringArray(row.explanationCodes, `${rowLabel}.explanationCodes`);
  }
}

function assertCatalogBenchmarkSeedSourceIds(value: unknown, label: string): void {
  const sourceIds = asArray(value, label);
  for (const [index, sourceIdValue] of sourceIds.entries()) {
    const sourceId = asStrictRecord(sourceIdValue, `${label}[${index}]`, [
      "catalogSource",
      "sourceId",
      "externalIdKind",
    ]);
    assertEnum(
      sourceId.catalogSource,
      Object.values(catalogSourceValues) as CatalogSource[],
      `${label}[${index}].catalogSource`,
    );
    if (sourceId.catalogSource === catalogSourceValues.localCorpus) {
      throw new Error(`${label}[${index}].catalogSource must not expose local corpus sources`);
    }
    assertPublicBenchmarkSeedString(sourceId.sourceId, `${label}[${index}].sourceId`);
    assertEnum(
      sourceId.externalIdKind,
      Object.values(catalogExternalIdKindValues) as CatalogExternalIdKind[],
      `${label}[${index}].externalIdKind`,
    );
  }
}

function assertCatalogBenchmarkSeedTranslationStatuses(value: unknown, label: string): void {
  const statuses = asArray(value, label);
  for (const [index, statusValue] of statuses.entries()) {
    const status = asStrictRecord(statusValue, `${label}[${index}]`, [
      "language",
      "status",
      "confidence",
      "statusScope",
      "platform",
    ]);
    assertPublicBenchmarkSeedString(status.language, `${label}[${index}].language`);
    assertEnum(
      status.status,
      Object.values(catalogLanguageStatusValues) as CatalogLanguageStatus[],
      `${label}[${index}].status`,
    );
    assertEnum(
      status.confidence,
      Object.values(catalogConfidenceValues) as CatalogConfidence[],
      `${label}[${index}].confidence`,
    );
    assertEnum(
      status.statusScope,
      Object.values(catalogLanguageStatusScopeValues) as CatalogLanguageStatusScope[],
      `${label}[${index}].statusScope`,
    );
    assertNullablePublicBenchmarkSeedString(status.platform, `${label}[${index}].platform`);
  }
}

function assertCatalogBenchmarkSeedReadiness(value: unknown, label: string): void {
  const readiness = asStrictRecord(value, label, [
    "adapterId",
    "identify",
    "inventory",
    "extract",
    "patch",
    "helper",
    "runtime",
  ]);
  assertNullablePublicBenchmarkSeedString(readiness.adapterId, `${label}.adapterId`);
  for (const level of ["identify", "inventory", "extract", "patch", "helper", "runtime"] as const) {
    assertEnum(
      readiness[level],
      ["supported", "partial", "unsupported", "unknown"] as const,
      `${label}.${level}`,
    );
  }
}

function assertCatalogBenchmarkSeedRuntimeEvidenceReadiness(value: unknown, label: string): void {
  assertEnum(
    value,
    [
      "public_and_aggregate",
      "public_fixture",
      "private_local_aggregate",
      "partial_public_and_aggregate",
      "partial_public_fixture",
      "partial_private_local_aggregate",
      "none",
      "unknown",
    ] as const,
    label,
  );
}

function assertCatalogBenchmarkSeedProvenance(value: unknown, label: string): void {
  const provenance = asArray(value, label);
  for (const [index, provenanceValue] of provenance.entries()) {
    const entry = asStrictRecord(provenanceValue, `${label}[${index}]`, [
      "catalogSource",
      "sourceId",
      "sourceRecordKind",
      "sourceVersion",
      "fixtureId",
      "redactionClass",
    ]);
    assertEnum(
      entry.catalogSource,
      Object.values(catalogSourceValues) as CatalogSource[],
      `${label}[${index}].catalogSource`,
    );
    if (entry.catalogSource === catalogSourceValues.localCorpus) {
      throw new Error(`${label}[${index}].catalogSource must not expose local corpus sources`);
    }
    assertPublicBenchmarkSeedString(entry.sourceId, `${label}[${index}].sourceId`);
    assertEnum(
      entry.sourceRecordKind,
      [
        catalogSourceRecordKindValues.recordedFixture,
        catalogSourceRecordKindValues.importerRequest,
      ] as CatalogSourceRecordKind[],
      `${label}[${index}].sourceRecordKind`,
    );
    assertNullablePublicBenchmarkSeedString(
      entry.sourceVersion,
      `${label}[${index}].sourceVersion`,
    );
    assertNullablePublicBenchmarkSeedString(entry.fixtureId, `${label}[${index}].fixtureId`);
    assertEnum(
      entry.redactionClass,
      Object.values(catalogRawContentRedactionClassValues) as CatalogRawContentRedactionClass[],
      `${label}[${index}].redactionClass`,
    );
    if (entry.redactionClass === catalogRawContentRedactionClassValues.privateCorpus) {
      throw new Error(`${label}[${index}].redactionClass must not expose private corpus data`);
    }
  }
}

function assertPublicBenchmarkSeedString(value: unknown, label: string): asserts value is string {
  assertString(value, label);
  assertNoBenchmarkSeedPrivateLeakage(value, label);
}

function assertNullablePublicBenchmarkSeedString(
  value: unknown,
  label: string,
): asserts value is string | null {
  assertNullableString(value, label);
  if (value !== null) {
    assertNoBenchmarkSeedPrivateLeakage(value, label);
  }
}

function assertPublicBenchmarkSeedStringArray(value: unknown, label: string): void {
  const entries = asArray(value, label);
  for (const [index, entry] of entries.entries()) {
    assertPublicBenchmarkSeedString(entry, `${label}[${index}]`);
  }
}

const benchmarkSeedPrivateLeakagePatterns = [
  /(?:^|[ "'=])file:/iu,
  /(?:^|[ "'=])\/(?:home|tmp|var|scratch|private)(?:\/|$)/iu,
  /[A-Z]:\\/u,
  /\.(?:zip|7z|rar|tar|gz|ks)(?:$|[\\/!?#:])/iu,
  /private[-_ ](?:title|path|corpus)/iu,
  /(?:rawPayloadSecret|local-scan-entry-secret|private-story-title|private_path_hash|path_hash)/iu,
] as const;

function assertNoBenchmarkSeedPrivateLeakage(value: string, label: string): void {
  if (benchmarkSeedPrivateLeakagePatterns.some((pattern) => pattern.test(value))) {
    throw new Error(`${label} must not expose private response data`);
  }
}

function assertPublicOpportunityString(value: unknown, label: string): asserts value is string {
  assertString(value, label);
  assertNoOpportunityPrivateLeakage(value, label);
}

function assertNullablePublicOpportunityString(
  value: unknown,
  label: string,
): asserts value is string | null {
  assertNullableString(value, label);
  if (value !== null) {
    assertNoOpportunityPrivateLeakage(value, label);
  }
}

function assertPublicOpportunityStringArray(value: unknown, label: string): void {
  const entries = asArray(value, label);
  for (const [index, entry] of entries.entries()) {
    assertPublicOpportunityString(entry, `${label}[${index}]`);
  }
}

const opportunityPrivateLeakagePatterns = [
  ...benchmarkSeedPrivateLeakagePatterns,
  /(?:localScanEntryId|local_scan_entry_id|pathHash|path_hash|rawText|raw_text)/iu,
  /(?:SECRET_KEY|helper log|rawPayloadSecret|screenshot)/iu,
  /\.(?:xp3|wolf|rvdata2|rpgmvp|rpgmvm|rpgmvo|unity3d|assetbundle)(?:$|[\\/!?#:])/iu,
] as const;

function assertNoOpportunityPrivateLeakage(value: string, label: string): void {
  if (opportunityPrivateLeakagePatterns.some((pattern) => pattern.test(value))) {
    throw new Error(`${label} must not expose private response data`);
  }
}

export function assertTerminologySearchReadModel(
  value: unknown,
  label = "TerminologySearchReadModel",
): asserts value is TerminologySearchReadModel {
  const model = asRecord(value, label);
  assertString(model.query, `${label}.query`);
  assertString(model.normalizedQuery, `${label}.normalizedQuery`);
  assertString(model.localeBranchId, `${label}.localeBranchId`);
  const results = asArray(model.results, `${label}.results`);
  for (const [index, resultValue] of results.entries()) {
    const result = asRecord(resultValue, `${label}.results[${index}]`);
    assertNonNegativeInteger(result.score, `${label}.results[${index}].score`);
    const matchKinds = asArray(result.matchKinds, `${label}.results[${index}].matchKinds`);
    for (const [matchIndex, matchKind] of matchKinds.entries()) {
      assertEnum(
        matchKind,
        ["exact_source", "exact_translation", "alias", "lexical_hook"] as const,
        `${label}.results[${index}].matchKinds[${matchIndex}]`,
      );
    }
    const term = asRecord(result.term, `${label}.results[${index}].term`);
    assertString(term.termId, `${label}.results[${index}].term.termId`);
    assertString(term.projectId, `${label}.results[${index}].term.projectId`);
    assertString(term.localeBranchId, `${label}.results[${index}].term.localeBranchId`);
    assertString(term.sourceTerm, `${label}.results[${index}].term.sourceTerm`);
    assertString(term.normalizedSourceTerm, `${label}.results[${index}].term.normalizedSourceTerm`);
    assertString(term.sourceLocale, `${label}.results[${index}].term.sourceLocale`);
    assertString(term.targetLocale, `${label}.results[${index}].term.targetLocale`);
    assertString(term.preferredTranslation, `${label}.results[${index}].term.preferredTranslation`);
    assertString(
      term.normalizedPreferredTranslation,
      `${label}.results[${index}].term.normalizedPreferredTranslation`,
    );
    assertString(term.termKind, `${label}.results[${index}].term.termKind`);
    assertNullableString(term.partOfSpeech, `${label}.results[${index}].term.partOfSpeech`);
    assertString(term.status, `${label}.results[${index}].term.status`);
    assertBoolean(term.caseSensitive, `${label}.results[${index}].term.caseSensitive`);
    assertNullableString(term.notes, `${label}.results[${index}].term.notes`);
    asRecord(term.metadata, `${label}.results[${index}].term.metadata`);
    assertNullableString(term.createdByUserId, `${label}.results[${index}].term.createdByUserId`);
    assertDateLike(term.createdAt, `${label}.results[${index}].term.createdAt`);
    assertDateLike(term.updatedAt, `${label}.results[${index}].term.updatedAt`);
    assertTerminologyAliases(term.aliases, `${label}.results[${index}].term.aliases`);
    assertTerminologySourceReferences(
      term.sourceReferences,
      `${label}.results[${index}].term.sourceReferences`,
    );
    if (term.semanticIndex !== null) {
      assertTerminologySemanticIndex(
        term.semanticIndex,
        `${label}.results[${index}].term.semanticIndex`,
      );
    }
  }
}

function assertTerminologyAliases(value: unknown, label: string): void {
  const aliases = asArray(value, label);
  for (const [index, aliasValue] of aliases.entries()) {
    const alias = asRecord(aliasValue, `${label}[${index}]`);
    assertString(alias.aliasId, `${label}[${index}].aliasId`);
    assertString(alias.termId, `${label}[${index}].termId`);
    assertString(alias.aliasText, `${label}[${index}].aliasText`);
    assertString(alias.normalizedAliasText, `${label}[${index}].normalizedAliasText`);
    assertString(alias.aliasKind, `${label}[${index}].aliasKind`);
    assertNullableString(alias.locale, `${label}[${index}].locale`);
    asRecord(alias.metadata, `${label}[${index}].metadata`);
    assertDateLike(alias.createdAt, `${label}[${index}].createdAt`);
  }
}

function assertTerminologySourceReferences(value: unknown, label: string): void {
  const references = asArray(value, label);
  for (const [index, referenceValue] of references.entries()) {
    const reference = asRecord(referenceValue, `${label}[${index}]`);
    assertString(reference.sourceRefId, `${label}[${index}].sourceRefId`);
    assertString(reference.termId, `${label}[${index}].termId`);
    assertNullableString(reference.sourceRevisionId, `${label}[${index}].sourceRevisionId`);
    assertNullableString(reference.bridgeUnitId, `${label}[${index}].bridgeUnitId`);
    assertNullableString(reference.sourceProvenanceId, `${label}[${index}].sourceProvenanceId`);
    assertString(reference.referenceKind, `${label}[${index}].referenceKind`);
    assertString(reference.citation, `${label}[${index}].citation`);
    assertNullableString(reference.context, `${label}[${index}].context`);
    asRecord(reference.metadata, `${label}[${index}].metadata`);
    assertDateLike(reference.createdAt, `${label}[${index}].createdAt`);
  }
}

function assertTerminologySemanticIndex(value: unknown, label: string): void {
  const semantic = asRecord(value, label);
  assertString(semantic.semanticIndexId, `${label}.semanticIndexId`);
  assertString(semantic.termId, `${label}.termId`);
  assertString(semantic.searchDocument, `${label}.searchDocument`);
  assertStringArray(semantic.searchTokens, `${label}.searchTokens`);
  assertString(semantic.embeddingProvider, `${label}.embeddingProvider`);
  assertString(semantic.embeddingModel, `${label}.embeddingModel`);
  assertNonNegativeInteger(semantic.embeddingDimension, `${label}.embeddingDimension`);
  if (semantic.embeddingVector !== null) {
    const vector = asArray(semantic.embeddingVector, `${label}.embeddingVector`);
    for (const [index, component] of vector.entries()) {
      if (typeof component !== "number") {
        throw new Error(`${label}.embeddingVector[${index}] must be a number`);
      }
    }
  }
  assertString(semantic.contentHash, `${label}.contentHash`);
  assertString(semantic.status, `${label}.status`);
  asRecord(semantic.metadata, `${label}.metadata`);
  if (semantic.refreshedAt !== null) {
    assertDateLike(semantic.refreshedAt, `${label}.refreshedAt`);
  }
  assertDateLike(semantic.createdAt, `${label}.createdAt`);
  assertDateLike(semantic.updatedAt, `${label}.updatedAt`);
}

export function assertCatalogCompletenessBenchmarkPools(
  value: unknown,
  label = "CatalogCompletenessBenchmarkPools",
): asserts value is CatalogCompletenessBenchmarkPools {
  const model = asStrictRecord(value, label, ["targetLanguage", "pools", "publicReport"]);
  assertString(model.targetLanguage, `${label}.targetLanguage`);
  const pools = asStrictRecord(model.pools, `${label}.pools`, [
    "mtl_only",
    "fan_partial",
    "no_english",
    "unknown",
    "conflict",
  ]);
  for (const poolName of [
    "mtl_only",
    "fan_partial",
    "no_english",
    "unknown",
    "conflict",
  ] as const) {
    const works = asArray(pools[poolName], `${label}.pools.${poolName}`);
    for (const [index, workValue] of works.entries()) {
      const work = asStrictRecord(workValue, `${label}.pools.${poolName}[${index}]`, [
        "workId",
        "canonicalTitle",
        "originalLanguage",
        "sourceIds",
        "privateSourceCount",
        "statuses",
        "conflicts",
      ]);
      assertString(work.workId, `${label}.pools.${poolName}[${index}].workId`);
      assertString(work.canonicalTitle, `${label}.pools.${poolName}[${index}].canonicalTitle`);
      assertNullableString(
        work.originalLanguage,
        `${label}.pools.${poolName}[${index}].originalLanguage`,
      );
      assertConflictReviewSourceIds(
        work.sourceIds,
        `${label}.pools.${poolName}[${index}].sourceIds`,
      );
      assertNonNegativeInteger(
        work.privateSourceCount,
        `${label}.pools.${poolName}[${index}].privateSourceCount`,
      );
      const statuses = asArray(work.statuses, `${label}.pools.${poolName}[${index}].statuses`);
      for (const [statusIndex, statusValue] of statuses.entries()) {
        const statusLabel = `${label}.pools.${poolName}[${index}].statuses[${statusIndex}]`;
        const status = asStrictRecord(statusValue, statusLabel, [
          "languageStatusId",
          "language",
          "status",
          "statusScope",
          "platform",
          "releaseId",
          "sourceProvenanceId",
          "source",
          "privateSourceCount",
          "confidence",
          "observedAt",
          "importedAt",
          "parserVersion",
          "rawContentRedactionClass",
        ]);
        assertString(
          status.languageStatusId,
          `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].languageStatusId`,
        );
        assertString(
          status.language,
          `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].language`,
        );
        assertString(
          status.status,
          `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].status`,
        );
        assertString(
          status.statusScope,
          `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].statusScope`,
        );
        assertNullableString(
          status.platform,
          `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].platform`,
        );
        assertNullableString(
          status.releaseId,
          `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].releaseId`,
        );
        assertNullableString(
          status.sourceProvenanceId,
          `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].sourceProvenanceId`,
        );
        assertString(
          status.confidence,
          `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].confidence`,
        );
        assertDateLike(
          status.observedAt,
          `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].observedAt`,
        );
        assertDateLike(
          status.importedAt,
          `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].importedAt`,
        );
        assertString(
          status.parserVersion,
          `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].parserVersion`,
        );
        assertString(
          status.rawContentRedactionClass,
          `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].rawContentRedactionClass`,
        );
        assertPublicCatalogRedactionClass(
          status.rawContentRedactionClass,
          `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].rawContentRedactionClass`,
        );
        if (status.source !== null) {
          const sourceLabel = `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].source`;
          const source = asStrictRecord(status.source, sourceLabel, [
            "sourceProvenanceId",
            "catalogSource",
            "sourceRecordKind",
            "sourceId",
            "sourceVersion",
            "fetchedAt",
            "rawContentRedactionClass",
          ]);
          assertString(
            source.sourceProvenanceId,
            `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].source.sourceProvenanceId`,
          );
          assertString(
            source.catalogSource,
            `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].source.catalogSource`,
          );
          assertPublicCatalogSource(
            source.catalogSource,
            `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].source.catalogSource`,
          );
          assertString(
            source.sourceRecordKind,
            `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].source.sourceRecordKind`,
          );
          assertPublicCatalogSourceRecordKind(
            source.sourceRecordKind,
            `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].source.sourceRecordKind`,
          );
          assertString(
            source.sourceId,
            `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].source.sourceId`,
          );
          assertNoCatalogPrivateLeakage(
            source.sourceId,
            `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].source.sourceId`,
          );
          assertNullableString(
            source.sourceVersion,
            `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].source.sourceVersion`,
          );
          assertDateLike(
            source.fetchedAt,
            `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].source.fetchedAt`,
          );
          assertString(
            source.rawContentRedactionClass,
            `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].source.rawContentRedactionClass`,
          );
          assertPublicCatalogRedactionClass(
            source.rawContentRedactionClass,
            `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].source.rawContentRedactionClass`,
          );
        }
        assertNonNegativeInteger(
          status.privateSourceCount,
          `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].privateSourceCount`,
        );
      }
      const conflicts = asArray(work.conflicts, `${label}.pools.${poolName}[${index}].conflicts`);
      for (const [conflictIndex, conflictValue] of conflicts.entries()) {
        const conflict = asStrictRecord(
          conflictValue,
          `${label}.pools.${poolName}[${index}].conflicts[${conflictIndex}]`,
          ["conflictId", "status", "reasonCode", "sourceIds", "privateSourceCount"],
        );
        assertString(
          conflict.conflictId,
          `${label}.pools.${poolName}[${index}].conflicts[${conflictIndex}].conflictId`,
        );
        assertString(
          conflict.status,
          `${label}.pools.${poolName}[${index}].conflicts[${conflictIndex}].status`,
        );
        assertString(
          conflict.reasonCode,
          `${label}.pools.${poolName}[${index}].conflicts[${conflictIndex}].reasonCode`,
        );
        assertConflictReviewSourceIds(
          conflict.sourceIds,
          `${label}.pools.${poolName}[${index}].conflicts[${conflictIndex}].sourceIds`,
        );
        assertNonNegativeInteger(
          conflict.privateSourceCount,
          `${label}.pools.${poolName}[${index}].conflicts[${conflictIndex}].privateSourceCount`,
        );
      }
    }
  }
  const publicReport = asStrictRecord(model.publicReport, `${label}.publicReport`, [
    "schemaVersion",
    "targetLanguage",
    "generatedAt",
    "totalWorkCount",
    "conflictCount",
    "pools",
    "statuses",
  ]);
  assertString(publicReport.schemaVersion, `${label}.publicReport.schemaVersion`);
  assertString(publicReport.targetLanguage, `${label}.publicReport.targetLanguage`);
  assertDateLike(publicReport.generatedAt, `${label}.publicReport.generatedAt`);
  assertNonNegativeInteger(publicReport.totalWorkCount, `${label}.publicReport.totalWorkCount`);
  assertNonNegativeInteger(publicReport.conflictCount, `${label}.publicReport.conflictCount`);
  const reportPools = asArray(publicReport.pools, `${label}.publicReport.pools`);
  for (const [index, poolValue] of reportPools.entries()) {
    const pool = asStrictRecord(poolValue, `${label}.publicReport.pools[${index}]`, [
      "pool",
      "workCount",
      "sourceIds",
    ]);
    assertString(pool.pool, `${label}.publicReport.pools[${index}].pool`);
    assertNonNegativeInteger(pool.workCount, `${label}.publicReport.pools[${index}].workCount`);
    assertConflictReviewSourceIds(
      pool.sourceIds,
      `${label}.publicReport.pools[${index}].sourceIds`,
    );
  }
  const reportStatuses = asArray(publicReport.statuses, `${label}.publicReport.statuses`);
  for (const [index, statusValue] of reportStatuses.entries()) {
    const status = asStrictRecord(statusValue, `${label}.publicReport.statuses[${index}]`, [
      "status",
      "factCount",
      "sourceIds",
    ]);
    assertString(status.status, `${label}.publicReport.statuses[${index}].status`);
    assertNonNegativeInteger(
      status.factCount,
      `${label}.publicReport.statuses[${index}].factCount`,
    );
    assertConflictReviewSourceIds(
      status.sourceIds,
      `${label}.publicReport.statuses[${index}].sourceIds`,
    );
  }
}

export function assertCatalogConflictReviewReadModel(
  value: unknown,
  label = "CatalogConflictReviewReadModel",
): asserts value is CatalogConflictReviewReadModel {
  const model = asStrictRecord(value, label, ["rows"]);
  const rows = asArray(model.rows, `${label}.rows`);
  for (const [index, rowValue] of rows.entries()) {
    const row = asStrictRecord(rowValue, `${label}.rows[${index}]`, [
      "reviewId",
      "catalogRecordId",
      "conflictId",
      "candidateIds",
      "candidateCatalogIds",
      "exactLinkRefs",
      "fuzzyScores",
      "sourceIds",
      "provenance",
      "privateSourceCount",
      "severity",
      "status",
      "reasonCode",
      "reasonDetail",
      "conflictKind",
      "detectedAt",
      "resolution",
    ]);
    assertString(row.reviewId, `${label}.rows[${index}].reviewId`);
    assertString(row.catalogRecordId, `${label}.rows[${index}].catalogRecordId`);
    assertNullableString(row.conflictId, `${label}.rows[${index}].conflictId`);
    assertStringArray(row.candidateIds, `${label}.rows[${index}].candidateIds`);
    assertStringArray(row.candidateCatalogIds, `${label}.rows[${index}].candidateCatalogIds`);
    assertConflictReviewExactLinkRefs(row.exactLinkRefs, `${label}.rows[${index}].exactLinkRefs`);
    assertConflictReviewFuzzyScores(row.fuzzyScores, `${label}.rows[${index}].fuzzyScores`);
    assertConflictReviewSourceIds(row.sourceIds, `${label}.rows[${index}].sourceIds`);
    assertConflictReviewProvenance(row.provenance, `${label}.rows[${index}].provenance`);
    assertNonNegativeInteger(row.privateSourceCount, `${label}.rows[${index}].privateSourceCount`);
    assertEnum(
      row.severity,
      ["error", "warning", "info"] as const,
      `${label}.rows[${index}].severity`,
    );
    assertString(row.status, `${label}.rows[${index}].status`);
    assertString(row.reasonCode, `${label}.rows[${index}].reasonCode`);
    assertString(row.reasonDetail, `${label}.rows[${index}].reasonDetail`);
    assertNullableString(row.conflictKind, `${label}.rows[${index}].conflictKind`);
    assertDateLike(row.detectedAt, `${label}.rows[${index}].detectedAt`);
    if (row.resolution !== null) {
      const resolution = asStrictRecord(row.resolution, `${label}.rows[${index}].resolution`, [
        "reviewerId",
        "action",
        "resolvedAt",
        "priorCandidateIds",
      ]);
      assertString(resolution.reviewerId, `${label}.rows[${index}].resolution.reviewerId`);
      assertString(resolution.action, `${label}.rows[${index}].resolution.action`);
      assertDateLike(resolution.resolvedAt, `${label}.rows[${index}].resolution.resolvedAt`);
      assertStringArray(
        resolution.priorCandidateIds,
        `${label}.rows[${index}].resolution.priorCandidateIds`,
      );
    }
  }
}

export function assertProjectDashboardStatus(
  value: unknown,
  label = "ProjectDashboardStatus",
): asserts value is ProjectDashboardStatus {
  const status = asRecord(value, label);
  assertString(status.projectId, `${label}.projectId`);
  assertString(status.projectKey, `${label}.projectKey`);
  assertString(status.name, `${label}.name`);
  assertString(status.status, `${label}.status`);
  assertString(status.sourceLocale, `${label}.sourceLocale`);
  assertString(status.sourceBundleId, `${label}.sourceBundleId`);
  assertString(status.sourceBundleHash, `${label}.sourceBundleHash`);
  assertString(status.sourceBundleRevisionId, `${label}.sourceBundleRevisionId`);
  assertNonNegativeInteger(status.branchCount, `${label}.branchCount`);
  assertNonNegativeInteger(status.unitCount, `${label}.unitCount`);
  assertNonNegativeInteger(status.findingCount, `${label}.findingCount`);
  assertNonNegativeInteger(status.artifactCount, `${label}.artifactCount`);
  assertNullableString(status.latestEventKind, `${label}.latestEventKind`);
  assertNullableString(status.latestEventAt, `${label}.latestEventAt`);
  assertNullableString(status.selectedLocaleBranchId, `${label}.selectedLocaleBranchId`);
  assertNullableString(
    status.currentStyleGuidePolicyVersionId,
    `${label}.currentStyleGuidePolicyVersionId`,
  );
  assertBridgeImportStatus(status.importStatus, `${label}.importStatus`);
  assertProjectCostReport(status.cost, `${label}.cost`);
  const branches = asArray(status.localeBranches, `${label}.localeBranches`);
  for (const [index, branchValue] of branches.entries()) {
    const branch = asRecord(branchValue, `${label}.localeBranches[${index}]`);
    assertString(branch.localeBranchId, `${label}.localeBranches[${index}].localeBranchId`);
    assertString(branch.targetLocale, `${label}.localeBranches[${index}].targetLocale`);
    assertString(branch.status, `${label}.localeBranches[${index}].status`);
    assertNullableString(
      branch.currentStyleGuidePolicyVersionId,
      `${label}.localeBranches[${index}].currentStyleGuidePolicyVersionId`,
    );
    assertNonNegativeInteger(branch.unitCount, `${label}.localeBranches[${index}].unitCount`);
    assertNonNegativeInteger(
      branch.translatedUnitCount,
      `${label}.localeBranches[${index}].translatedUnitCount`,
    );
    assertNonNegativeInteger(
      branch.openFindingCount,
      `${label}.localeBranches[${index}].openFindingCount`,
    );
    assertNonNegativeInteger(
      branch.artifactCount,
      `${label}.localeBranches[${index}].artifactCount`,
    );
  }
}

function assertBridgeImportStatus(value: unknown, label: string): void {
  const status = asRecord(value, label);
  assertString(status.bridgeImportId, `${label}.bridgeImportId`);
  assertString(status.projectId, `${label}.projectId`);
  assertString(status.bridgeId, `${label}.bridgeId`);
  assertString(status.sourceBundleId, `${label}.sourceBundleId`);
  assertString(status.sourceBundleHash, `${label}.sourceBundleHash`);
  assertString(status.sourceBundleRevisionId, `${label}.sourceBundleRevisionId`);
  assertString(status.schemaVersion, `${label}.schemaVersion`);
  assertString(status.sourceLocale, `${label}.sourceLocale`);
  assertString(status.importedAt, `${label}.importedAt`);
  assertNonNegativeInteger(status.unitCount, `${label}.unitCount`);
  assertNonNegativeInteger(status.assetCount, `${label}.assetCount`);
  assertNonNegativeInteger(status.sourceRevisionCount, `${label}.sourceRevisionCount`);
  assertNonNegativeInteger(status.validationFailureCount, `${label}.validationFailureCount`);
  assertDiffCounts(status.units, `${label}.units`);
  assertDiffCounts(status.assets, `${label}.assets`);
  const sourceRevisions = asRecord(status.sourceRevisions, `${label}.sourceRevisions`);
  assertNonNegativeInteger(sourceRevisions.added, `${label}.sourceRevisions.added`);
  assertNonNegativeInteger(sourceRevisions.existing, `${label}.sourceRevisions.existing`);
  assertCountTotal(status.units, status.unitCount, `${label}.units`, `${label}.unitCount`);
  assertCountTotal(status.assets, status.assetCount, `${label}.assets`, `${label}.assetCount`);
  const sourceRevisionTotal = Number(sourceRevisions.added) + Number(sourceRevisions.existing);
  if (sourceRevisionTotal !== Number(status.sourceRevisionCount)) {
    throw new Error(`${label}.sourceRevisions must add up to ${label}.sourceRevisionCount`);
  }
  const futureReferences = asRecord(status.futureReferences, `${label}.futureReferences`);
  assertNullableString(futureReferences.catalogWorkId, `${label}.futureReferences.catalogWorkId`);
  assertNullableString(
    futureReferences.localCorpusEntryId,
    `${label}.futureReferences.localCorpusEntryId`,
  );
  assertNullableString(
    futureReferences.readinessProfileId,
    `${label}.futureReferences.readinessProfileId`,
  );
  assertNullableString(
    futureReferences.completenessStatusId,
    `${label}.futureReferences.completenessStatusId`,
  );
}

function assertDiffCounts(value: unknown, label: string): void {
  const counts = asRecord(value, label);
  assertNonNegativeInteger(counts.added, `${label}.added`);
  assertNonNegativeInteger(counts.updated, `${label}.updated`);
  assertNonNegativeInteger(counts.removed, `${label}.removed`);
  assertNonNegativeInteger(counts.unchanged, `${label}.unchanged`);
}

function assertCountTotal(value: unknown, total: unknown, label: string, totalLabel: string): void {
  const counts = asRecord(value, label);
  const countTotal = Number(counts.added) + Number(counts.updated) + Number(counts.unchanged);
  if (countTotal !== Number(total)) {
    throw new Error(`${label} current counts must add up to ${totalLabel}`);
  }
}

function assertDecisionCount(value: unknown, expected: number, label: string): void {
  if (Number(value) !== expected) {
    throw new Error(`${label} must match pendingDecisions`);
  }
}

export function assertProjectCostReport(
  value: unknown,
  label = "ProjectCostReport",
): asserts value is ProjectCostReport {
  const report = asRecord(value, label);
  assertString(report.projectId, `${label}.projectId`);
  assertEnum(report.currency, ["USD"] as const, `${label}.currency`);
  assertNonNegativeInteger(report.runCount, `${label}.runCount`);
  assertNonNegativeInteger(report.billedMicrosUsd, `${label}.billedMicrosUsd`);
  assertNonNegativeInteger(report.zeroRunCount, `${label}.zeroRunCount`);
  const totals = asArray(report.totalsByCostKind, `${label}.totalsByCostKind`);
  for (const [index, totalValue] of totals.entries()) {
    const total = asRecord(totalValue, `${label}.totalsByCostKind[${index}]`);
    assertEnum(
      total.costKind,
      ["billed", "zero"] as const,
      `${label}.totalsByCostKind[${index}].costKind`,
    );
    assertNonNegativeInteger(total.runCount, `${label}.totalsByCostKind[${index}].runCount`);
    assertNonNegativeInteger(
      total.amountMicrosUsd,
      `${label}.totalsByCostKind[${index}].amountMicrosUsd`,
    );
    assertNonNegativeInteger(
      total.promptTokens,
      `${label}.totalsByCostKind[${index}].promptTokens`,
    );
    assertNonNegativeInteger(
      total.completionTokens,
      `${label}.totalsByCostKind[${index}].completionTokens`,
    );
    assertNonNegativeInteger(total.totalTokens, `${label}.totalsByCostKind[${index}].totalTokens`);
  }
  const recentRuns = asArray(report.recentRuns, `${label}.recentRuns`);
  for (const [index, runValue] of recentRuns.entries()) {
    const run = asRecord(runValue, `${label}.recentRuns[${index}]`);
    assertString(run.providerRunId, `${label}.recentRuns[${index}].providerRunId`);
    assertString(run.taskKind, `${label}.recentRuns[${index}].taskKind`);
    assertString(run.status, `${label}.recentRuns[${index}].status`);
    assertString(run.startedAt, `${label}.recentRuns[${index}].startedAt`);
    assertString(run.structuredOutputMode, `${label}.recentRuns[${index}].structuredOutputMode`);
    assertNonNegativeInteger(run.retryCount, `${label}.recentRuns[${index}].retryCount`);
    const errorClasses = asArray(run.errorClasses, `${label}.recentRuns[${index}].errorClasses`);
    for (const [errorIndex, errorClass] of errorClasses.entries()) {
      assertString(errorClass, `${label}.recentRuns[${index}].errorClasses[${errorIndex}]`);
    }
    assertString(run.providerFamily, `${label}.recentRuns[${index}].providerFamily`);
    assertString(run.endpointFamily, `${label}.recentRuns[${index}].endpointFamily`);
    assertString(run.providerName, `${label}.recentRuns[${index}].providerName`);
    assertString(run.requestedModelId, `${label}.recentRuns[${index}].requestedModelId`);
    assertString(run.actualModelId, `${label}.recentRuns[${index}].actualModelId`);
    assertNullableString(run.upstreamProvider, `${label}.recentRuns[${index}].upstreamProvider`);
    assertNullableString(run.routeSettingsHash, `${label}.recentRuns[${index}].routeSettingsHash`);
    assertString(run.promptPresetId, `${label}.recentRuns[${index}].promptPresetId`);
    assertString(run.promptTemplateVersion, `${label}.recentRuns[${index}].promptTemplateVersion`);
    assertString(run.promptHash, `${label}.recentRuns[${index}].promptHash`);
    assertBoolean(run.fallbackUsed, `${label}.recentRuns[${index}].fallbackUsed`);
    const fallbackPlan = asArray(run.fallbackPlan, `${label}.recentRuns[${index}].fallbackPlan`);
    for (const [fallbackIndex, fallbackModel] of fallbackPlan.entries()) {
      assertString(fallbackModel, `${label}.recentRuns[${index}].fallbackPlan[${fallbackIndex}]`);
    }
    assertEnum(run.costKind, ["billed", "zero"] as const, `${label}.recentRuns[${index}].costKind`);
    if (run.amountMicrosUsd !== null) {
      assertNonNegativeInteger(
        run.amountMicrosUsd,
        `${label}.recentRuns[${index}].amountMicrosUsd`,
      );
    }
    assertEnum(
      run.tokenCountSource,
      BENCHMARK_TOKEN_COUNT_SOURCES,
      `${label}.recentRuns[${index}].tokenCountSource`,
    );
    const tokenTotalLabel = `${label}.recentRuns[${index}].totalTokens`;
    for (const tokenField of [
      "promptTokens",
      "completionTokens",
      "reasoningTokens",
      "cachedInputTokens",
    ] as const) {
      if (run[tokenField] !== null) {
        assertNonNegativeInteger(run[tokenField], `${label}.recentRuns[${index}].${tokenField}`);
      }
    }
    if (run.totalTokens !== null) {
      assertNonNegativeInteger(run.totalTokens, tokenTotalLabel);
    }
    if (run.tokenCountSource === "unknown" && run.totalTokens !== null) {
      throw new Error(
        `${label}.recentRuns[${index}] unknown token source must not include totalTokens`,
      );
    }
    const tokenSubtotal =
      (run.promptTokens === null ? 0 : Number(run.promptTokens)) +
      (run.completionTokens === null ? 0 : Number(run.completionTokens)) +
      (run.reasoningTokens === null ? 0 : Number(run.reasoningTokens));
    if (run.totalTokens !== null && run.totalTokens < tokenSubtotal) {
      throw new Error(
        `${tokenTotalLabel} must cover promptTokens, completionTokens, and reasoningTokens`,
      );
    }
    // ITOTORI-230 — every run row carries the captured OR routing
    // posture (the `provider: { only, allow_fallbacks, data_collection,
    // zdr, require_parameters }` block that hit the wire) on
    // `routing_posture`. Pre-migration rows carry the sentinel
    // `{_pre_itotori_230: true}`. We validate the field is present and
    // an object; the typed shape is enforced at the application layer
    // (OpenRouterRoutingPosture).
    asRecord(run.routingPosture, `${label}.recentRuns[${index}].routingPosture`);
  }
  const reuse = asRecord(report.translationMemoryReuse, `${label}.translationMemoryReuse`);
  assertNonNegativeInteger(
    reuse.reuseEventCount,
    `${label}.translationMemoryReuse.reuseEventCount`,
  );
  assertNonNegativeInteger(reuse.appliedCount, `${label}.translationMemoryReuse.appliedCount`);
  assertNonNegativeInteger(reuse.suggestedCount, `${label}.translationMemoryReuse.suggestedCount`);
  assertNonNegativeInteger(
    reuse.providerCallAvoidedCount,
    `${label}.translationMemoryReuse.providerCallAvoidedCount`,
  );
  assertNonNegativeInteger(
    reuse.estimatedPromptTokensSaved,
    `${label}.translationMemoryReuse.estimatedPromptTokensSaved`,
  );
  assertNonNegativeInteger(
    reuse.estimatedCompletionTokensSaved,
    `${label}.translationMemoryReuse.estimatedCompletionTokensSaved`,
  );
  assertNonNegativeInteger(
    reuse.estimatedTotalTokensSaved,
    `${label}.translationMemoryReuse.estimatedTotalTokensSaved`,
  );
  if (reuse.estimatedCostUsdSaved !== null) {
    assertNonNegativeNumber(
      reuse.estimatedCostUsdSaved,
      `${label}.translationMemoryReuse.estimatedCostUsdSaved`,
    );
  }
  const recentEvents = asArray(reuse.recentEvents, `${label}.translationMemoryReuse.recentEvents`);
  for (const [index, eventValue] of recentEvents.entries()) {
    const event = asRecord(eventValue, `${label}.translationMemoryReuse.recentEvents[${index}]`);
    assertString(
      event.reuseEventId,
      `${label}.translationMemoryReuse.recentEvents[${index}].reuseEventId`,
    );
    assertString(
      event.localeBranchId,
      `${label}.translationMemoryReuse.recentEvents[${index}].localeBranchId`,
    );
    assertString(
      event.targetBridgeUnitId,
      `${label}.translationMemoryReuse.recentEvents[${index}].targetBridgeUnitId`,
    );
    assertString(
      event.memorySegmentId,
      `${label}.translationMemoryReuse.recentEvents[${index}].memorySegmentId`,
    );
    assertString(
      event.matchKind,
      `${label}.translationMemoryReuse.recentEvents[${index}].matchKind`,
    );
    assertNonNegativeInteger(
      event.matchScore,
      `${label}.translationMemoryReuse.recentEvents[${index}].matchScore`,
    );
    assertString(
      event.reuseStatus,
      `${label}.translationMemoryReuse.recentEvents[${index}].reuseStatus`,
    );
    assertString(
      event.sourceHash,
      `${label}.translationMemoryReuse.recentEvents[${index}].sourceHash`,
    );
    assertString(
      event.candidateSourceHash,
      `${label}.translationMemoryReuse.recentEvents[${index}].candidateSourceHash`,
    );
    assertString(
      event.targetText,
      `${label}.translationMemoryReuse.recentEvents[${index}].targetText`,
    );
    assertBoolean(
      event.providerCallAvoided,
      `${label}.translationMemoryReuse.recentEvents[${index}].providerCallAvoided`,
    );
    assertNonNegativeInteger(
      event.estimatedPromptTokensSaved,
      `${label}.translationMemoryReuse.recentEvents[${index}].estimatedPromptTokensSaved`,
    );
    assertNonNegativeInteger(
      event.estimatedCompletionTokensSaved,
      `${label}.translationMemoryReuse.recentEvents[${index}].estimatedCompletionTokensSaved`,
    );
    assertNonNegativeInteger(
      event.estimatedTotalTokensSaved,
      `${label}.translationMemoryReuse.recentEvents[${index}].estimatedTotalTokensSaved`,
    );
    if (event.estimatedCostUsdSaved !== null) {
      assertNonNegativeNumber(
        event.estimatedCostUsdSaved,
        `${label}.translationMemoryReuse.recentEvents[${index}].estimatedCostUsdSaved`,
      );
    }
    assertString(
      event.calculation,
      `${label}.translationMemoryReuse.recentEvents[${index}].calculation`,
    );
    asRecord(event.provenance, `${label}.translationMemoryReuse.recentEvents[${index}].provenance`);
    assertString(
      event.createdAt,
      `${label}.translationMemoryReuse.recentEvents[${index}].createdAt`,
    );
  }
}

export function assertDashboardDecisionReadModel(
  value: unknown,
  label = "DashboardDecisionReadModel",
): asserts value is DashboardDecisionReadModel {
  const model = asRecord(value, label);
  assertString(model.projectId, `${label}.projectId`);
  const counts = asRecord(model.counts, `${label}.counts`);
  assertNonNegativeInteger(counts.pendingDecisionCount, `${label}.counts.pendingDecisionCount`);
  assertNonNegativeInteger(
    counts.projectFindingDecisionCount,
    `${label}.counts.projectFindingDecisionCount`,
  );
  assertNonNegativeInteger(
    counts.localeBranchFindingDecisionCount,
    `${label}.counts.localeBranchFindingDecisionCount`,
  );
  assertNonNegativeInteger(
    counts.runtimeValidationDecisionCount,
    `${label}.counts.runtimeValidationDecisionCount`,
  );
  const pendingDecisions = asArray(model.pendingDecisions, `${label}.pendingDecisions`);
  for (const [index, decisionValue] of pendingDecisions.entries()) {
    const decision = asRecord(decisionValue, `${label}.pendingDecisions[${index}]`);
    assertString(decision.decisionId, `${label}.pendingDecisions[${index}].decisionId`);
    assertEnum(
      decision.decisionKind,
      ["project_finding", "locale_branch_finding", "runtime_validation"] as const,
      `${label}.pendingDecisions[${index}].decisionKind`,
    );
    assertString(decision.projectId, `${label}.pendingDecisions[${index}].projectId`);
    assertString(decision.findingId, `${label}.pendingDecisions[${index}].findingId`);
    assertString(decision.findingKind, `${label}.pendingDecisions[${index}].findingKind`);
    assertString(decision.severity, `${label}.pendingDecisions[${index}].severity`);
    assertNullableString(
      decision.qualityCategory,
      `${label}.pendingDecisions[${index}].qualityCategory`,
    );
    assertString(decision.title, `${label}.pendingDecisions[${index}].title`);
    assertNullableString(
      decision.localeBranchId,
      `${label}.pendingDecisions[${index}].localeBranchId`,
    );
    assertNullableString(decision.targetLocale, `${label}.pendingDecisions[${index}].targetLocale`);
    assertNullableString(decision.branchStatus, `${label}.pendingDecisions[${index}].branchStatus`);
    assertNullableString(decision.runtimeRunId, `${label}.pendingDecisions[${index}].runtimeRunId`);
    assertNullableString(
      decision.runtimeStatus,
      `${label}.pendingDecisions[${index}].runtimeStatus`,
    );
    assertString(decision.createdAt, `${label}.pendingDecisions[${index}].createdAt`);
  }
  assertDecisionCount(
    counts.pendingDecisionCount,
    pendingDecisions.length,
    `${label}.counts.pendingDecisionCount`,
  );
  assertDecisionCount(
    counts.projectFindingDecisionCount,
    pendingDecisions.filter((decision) => {
      const record = asRecord(decision, `${label}.pendingDecisions[]`);
      return record.decisionKind === "project_finding";
    }).length,
    `${label}.counts.projectFindingDecisionCount`,
  );
  assertDecisionCount(
    counts.localeBranchFindingDecisionCount,
    pendingDecisions.filter((decision) => {
      const record = asRecord(decision, `${label}.pendingDecisions[]`);
      return record.decisionKind === "locale_branch_finding";
    }).length,
    `${label}.counts.localeBranchFindingDecisionCount`,
  );
  assertDecisionCount(
    counts.runtimeValidationDecisionCount,
    pendingDecisions.filter((decision) => {
      const record = asRecord(decision, `${label}.pendingDecisions[]`);
      return record.decisionKind === "runtime_validation";
    }).length,
    `${label}.counts.runtimeValidationDecisionCount`,
  );
}

export function assertRuntimeDashboardStatus(
  value: unknown,
  label = "RuntimeDashboardStatus",
): asserts value is RuntimeDashboardStatus {
  const status = asRecord(value, label);
  assertString(status.finalStatus, `${label}.finalStatus`);
  assertNullableString(status.runtimeRunId, `${label}.runtimeRunId`);
  assertNullableString(status.runtimeReportId, `${label}.runtimeReportId`);
  assertNullableString(status.runtimeStatus, `${label}.runtimeStatus`);
  assertNullableString(status.fidelityTier, `${label}.fidelityTier`);
  assertNullableString(status.evidenceTier, `${label}.evidenceTier`);
  assertNonNegativeInteger(status.textEventCount, `${label}.textEventCount`);
  assertNonNegativeInteger(status.frameCaptureCount, `${label}.frameCaptureCount`);
  assertNonNegativeInteger(status.screenshotArtifactCount, `${label}.screenshotArtifactCount`);
  assertNonNegativeInteger(status.recordingArtifactCount, `${label}.recordingArtifactCount`);
  assertNonNegativeInteger(status.validationFindingCount, `${label}.validationFindingCount`);
  assertRuntimeDashboardTraceEvents(status.traceEvents, `${label}.traceEvents`);
  assertRuntimeDashboardFindings(status.findings, `${label}.findings`);
  assertRuntimeDashboardArtifacts(status.artifacts, `${label}.artifacts`);
  assertRuntimeDashboardApproximations(status.approximations, `${label}.approximations`);
  assertRuntimeDashboardUnsupportedCapabilities(
    status.unsupportedCapabilities,
    `${label}.unsupportedCapabilities`,
  );
  assertStringArray(status.limitations, `${label}.limitations`);
}

function assertRuntimeDashboardTraceEvents(value: unknown, label: string): void {
  const rows = asArray(value, label);
  for (const [index, rowValue] of rows.entries()) {
    const row = asRecord(rowValue, `${label}[${index}]`);
    assertString(row.runtimeEventId, `${label}[${index}].runtimeEventId`);
    assertString(row.eventKind, `${label}[${index}].eventKind`);
    assertNullableString(row.bridgeUnitId, `${label}[${index}].bridgeUnitId`);
    assertNullableString(row.sourceUnitKey, `${label}[${index}].sourceUnitKey`);
    assertNullableString(row.draftId, `${label}[${index}].draftId`);
    assertNullableString(row.runtimeTargetId, `${label}[${index}].runtimeTargetId`);
    assertNullableString(row.evidenceTier, `${label}[${index}].evidenceTier`);
    assertNullableNonNegativeInteger(row.frame, `${label}[${index}].frame`);
    assertNullableString(row.textPreview, `${label}[${index}].textPreview`);
    assertStringArray(row.artifactIds, `${label}[${index}].artifactIds`);
  }
}

function assertRuntimeDashboardFindings(value: unknown, label: string): void {
  const rows = asArray(value, label);
  for (const [index, rowValue] of rows.entries()) {
    const row = asRecord(rowValue, `${label}[${index}]`);
    assertString(row.findingId, `${label}[${index}].findingId`);
    assertString(row.findingKind, `${label}[${index}].findingKind`);
    assertString(row.severity, `${label}[${index}].severity`);
    assertString(row.message, `${label}[${index}].message`);
    assertString(row.evidenceTier, `${label}[${index}].evidenceTier`);
    assertNullableString(row.bridgeUnitId, `${label}[${index}].bridgeUnitId`);
    assertNullableString(row.sourceUnitKey, `${label}[${index}].sourceUnitKey`);
    assertNullableString(row.artifactId, `${label}[${index}].artifactId`);
  }
}

function assertRuntimeDashboardArtifacts(value: unknown, label: string): void {
  const rows = asArray(value, label);
  for (const [index, rowValue] of rows.entries()) {
    const row = asRecord(rowValue, `${label}[${index}]`);
    assertString(row.artifactId, `${label}[${index}].artifactId`);
    assertString(row.artifactKind, `${label}[${index}].artifactKind`);
    assertNullableString(row.uri, `${label}[${index}].uri`);
    assertNullableString(row.hash, `${label}[${index}].hash`);
    assertNullableString(row.mediaType, `${label}[${index}].mediaType`);
    assertNullableNonNegativeInteger(row.byteSize, `${label}[${index}].byteSize`);
    assertNullableString(row.bridgeUnitId, `${label}[${index}].bridgeUnitId`);
    assertNullableString(row.sourceUnitKey, `${label}[${index}].sourceUnitKey`);
    assertNullableString(row.diagnostic, `${label}[${index}].diagnostic`);
  }
}

function assertRuntimeDashboardApproximations(value: unknown, label: string): void {
  const rows = asArray(value, label);
  for (const [index, rowValue] of rows.entries()) {
    const row = asRecord(rowValue, `${label}[${index}]`);
    assertString(row.approximationId, `${label}[${index}].approximationId`);
    assertString(row.approximationTier, `${label}[${index}].approximationTier`);
    assertString(row.scope, `${label}[${index}].scope`);
    assertString(row.description, `${label}[${index}].description`);
    assertString(row.evidenceTierCeiling, `${label}[${index}].evidenceTierCeiling`);
    assertStringArray(row.bridgeUnitIds, `${label}[${index}].bridgeUnitIds`);
  }
}

function assertRuntimeDashboardUnsupportedCapabilities(value: unknown, label: string): void {
  const rows = asArray(value, label);
  for (const [index, rowValue] of rows.entries()) {
    const row = asRecord(rowValue, `${label}[${index}]`);
    assertString(row.feature, `${label}[${index}].feature`);
    assertString(row.status, `${label}[${index}].status`);
    assertNullableString(row.fidelityTierCeiling, `${label}[${index}].fidelityTierCeiling`);
    assertNullableString(row.evidenceTierCeiling, `${label}[${index}].evidenceTierCeiling`);
    assertStringArray(row.limitations, `${label}[${index}].limitations`);
  }
}

export function assertProjectState(
  value: unknown,
  label = "ProjectState",
): asserts value is ProjectState {
  const project = asRecord(value, label);
  assertString(project.projectId, `${label}.projectId`);
  assertString(project.localeBranchId, `${label}.localeBranchId`);
  assertString(project.targetLocale, `${label}.targetLocale`);
  assertBridgeInput(project.bridge);
  const drafts = asRecord(project.drafts, `${label}.drafts`);
  for (const [draftKey, draftValue] of Object.entries(drafts)) {
    assertString(draftValue, `${label}.drafts.${draftKey}`);
  }
  if (project.importStatus !== undefined) {
    assertBridgeImportStatus(project.importStatus, `${label}.importStatus`);
  }
  if (project.patchExport !== undefined) {
    assertPatchExportInput(project.patchExport, `${label}.patchExport`);
  }
  if (project.runtimeReport !== undefined) {
    assertRuntimeReport(project.runtimeReport);
  }
}

function assertProjectsResponse(value: unknown): asserts value is ApiProjectsResponse {
  const response = asRecord(value, "ApiProjectsResponse");
  const projects = asArray(response.projects, "ApiProjectsResponse.projects");
  for (const [index, project] of projects.entries()) {
    assertProjectDashboardStatus(project, `ApiProjectsResponse.projects[${index}]`);
  }
}

function assertProjectImportResponse(value: unknown): asserts value is ApiProjectImportResponse {
  const response = asRecord(value, "ApiProjectImportResponse");
  assertProjectState(response.project, "ApiProjectImportResponse.project");
  assertProjectDashboardStatus(response.status, "ApiProjectImportResponse.status");
}

function assertDraftBranchResponse(value: unknown): asserts value is ApiDraftBranchResponse {
  const response = asRecord(value, "ApiDraftBranchResponse");
  assertProjectState(response.project, "ApiDraftBranchResponse.project");
  assertProjectDashboardStatus(response.status, "ApiDraftBranchResponse.status");
}

function assertRecordFindingResponse(value: unknown): asserts value is ApiRecordFindingResponse {
  const response = asRecord(value, "ApiRecordFindingResponse");
  assertString(response.findingId, "ApiRecordFindingResponse.findingId");
  assertEnum(
    response.status,
    ["open", "resolved", "superseded"] as const,
    "ApiRecordFindingResponse.status",
  );
}

function assertRecordDecisionResponse(value: unknown): asserts value is ApiRecordDecisionResponse {
  const response = asRecord(value, "ApiRecordDecisionResponse");
  assertString(response.decisionId, "ApiRecordDecisionResponse.decisionId");
  assertEnum(response.eventKind, TRIAGE_EVENT_KINDS, "ApiRecordDecisionResponse.eventKind");
  assertBoolean(response.recorded, "ApiRecordDecisionResponse.recorded");
}

function assertRecordBenchmarkResponse(
  value: unknown,
): asserts value is ApiRecordBenchmarkResponse {
  const response = asRecord(value, "ApiRecordBenchmarkResponse");
  assertString(response.benchmarkRunId, "ApiRecordBenchmarkResponse.benchmarkRunId");
  assertString(response.artifactId, "ApiRecordBenchmarkResponse.artifactId");
  assertEnum(
    response.status,
    ["passed", "failed", "partial"] as const,
    "ApiRecordBenchmarkResponse.status",
  );
  assertNonNegativeInteger(response.systemCount, "ApiRecordBenchmarkResponse.systemCount");
  assertNonNegativeInteger(response.findingCount, "ApiRecordBenchmarkResponse.findingCount");
}

function assertRuntimeEvidenceResponse(
  value: unknown,
): asserts value is ApiRuntimeEvidenceResponse {
  const response = asRecord(value, "ApiRuntimeEvidenceResponse");
  assertEnum(
    response.status,
    ["hello_world_passed", "hello_world_failed"] as const,
    "ApiRuntimeEvidenceResponse.status",
  );
  assertString(response.bridgeId, "ApiRuntimeEvidenceResponse.bridgeId");
  assertString(response.localeBranchId, "ApiRuntimeEvidenceResponse.localeBranchId");
  assertString(response.patchResultId, "ApiRuntimeEvidenceResponse.patchResultId");
  assertString(response.runtimeReportId, "ApiRuntimeEvidenceResponse.runtimeReportId");
  if (response.patchExportId !== undefined) {
    assertString(response.patchExportId, "ApiRuntimeEvidenceResponse.patchExportId");
  }
  assertProjectDashboardStatus(response.dashboard, "ApiRuntimeEvidenceResponse.dashboard");
}

export function assertBridgeInput(value: unknown): asserts value is BridgeBundle | BridgeBundleV02 {
  const bridge = asRecord(value, "BridgeInput");
  if (bridge.schemaVersion === BRIDGE_SCHEMA_VERSION_V02) {
    assertBridgeBundleV02(value);
    return;
  }
  assertBridgeBundle(value);
}

function assertPatchExportInput(
  value: unknown,
  label: string,
): asserts value is PatchExport | PatchExportV02 {
  const patch = asRecord(value, label);
  if (patch.schemaVersion === BRIDGE_SCHEMA_VERSION_V02) {
    assertPatchExportV02(value);
    return;
  }
  assertPatchExport(value);
}

function assertFindingRecordInput(
  value: unknown,
  label: string,
): asserts value is FindingRecordV02 {
  assertFindingRecordFixtureV02({
    schemaVersion: BRIDGE_SCHEMA_VERSION_V02,
    findingFixtureId: "019ed004-0000-7000-8000-000000000004",
    finding: value,
    compatibilityNotes: [],
  });
  const finding = asRecord(value, label);
  if (finding.findingId === undefined) {
    throw new Error(`${label}.findingId is required`);
  }
}

function assertDecisionEvent(value: unknown, label: string): asserts value is TriageEventV02 {
  assertTriageBundleV02({
    schemaVersion: BRIDGE_SCHEMA_VERSION_V02,
    triageBundleId: "019ed004-0000-7000-8000-000000000005",
    events: [value],
    tasks: [],
    findings: [],
  });
  const event = asRecord(value, label);
  if (event.eventKind !== "triage_decision_recorded") {
    throw new Error(`${label}.eventKind must be triage_decision_recorded`);
  }
}

function parseRequest<T>(label: string, parser: () => T): T {
  try {
    return parser();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ApiValidationError(`${label}: ${message}`);
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asStrictRecord(
  value: unknown,
  label: string,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  const record = asRecord(value, label);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.includes(key)) {
      throw new Error(`${label}.${key} is not part of the public API response`);
    }
  }
  return record;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function assertLiteral<T extends string>(
  value: unknown,
  expected: T,
  label: string,
): asserts value is T {
  if (value !== expected) {
    throw new Error(`${label} must be ${expected}`);
  }
}

function assertNullableString(value: unknown, label: string): asserts value is string | null {
  if (value !== null && typeof value !== "string") {
    throw new Error(`${label} must be a string or null`);
  }
}

function assertStringArray(value: unknown, label: string): void {
  const entries = asArray(value, label);
  for (const [index, entry] of entries.entries()) {
    assertString(entry, `${label}[${index}]`);
  }
}

function assertConflictReviewSourceIds(value: unknown, label: string): void {
  const rows = asArray(value, label);
  for (const [index, rowValue] of rows.entries()) {
    const row = asStrictRecord(rowValue, `${label}[${index}]`, ["catalogSource", "sourceId"]);
    assertString(row.catalogSource, `${label}[${index}].catalogSource`);
    assertPublicCatalogSource(row.catalogSource, `${label}[${index}].catalogSource`);
    assertString(row.sourceId, `${label}[${index}].sourceId`);
    assertNoCatalogPrivateLeakage(row.sourceId, `${label}[${index}].sourceId`);
  }
}

function assertConflictReviewExactLinkRefs(value: unknown, label: string): void {
  const rows = asArray(value, label);
  for (const [index, rowValue] of rows.entries()) {
    const row = asStrictRecord(rowValue, `${label}[${index}]`, [
      "externalIdId",
      "catalogSource",
      "sourceId",
      "externalIdKind",
      "workId",
      "sourceProvenanceId",
    ]);
    assertString(row.externalIdId, `${label}[${index}].externalIdId`);
    assertString(row.catalogSource, `${label}[${index}].catalogSource`);
    assertPublicCatalogSource(row.catalogSource, `${label}[${index}].catalogSource`);
    assertString(row.sourceId, `${label}[${index}].sourceId`);
    assertNoCatalogPrivateLeakage(row.sourceId, `${label}[${index}].sourceId`);
    assertString(row.externalIdKind, `${label}[${index}].externalIdKind`);
    assertString(row.workId, `${label}[${index}].workId`);
    assertNullableString(row.sourceProvenanceId, `${label}[${index}].sourceProvenanceId`);
  }
}

function assertConflictReviewFuzzyScores(value: unknown, label: string): void {
  const rows = asArray(value, label);
  for (const [index, rowValue] of rows.entries()) {
    const row = asStrictRecord(rowValue, `${label}[${index}]`, [
      "candidateId",
      "score",
      "diagnosticCode",
      "generatorVersion",
    ]);
    assertString(row.candidateId, `${label}[${index}].candidateId`);
    assertNonNegativeInteger(row.score, `${label}[${index}].score`);
    assertString(row.diagnosticCode, `${label}[${index}].diagnosticCode`);
    assertString(row.generatorVersion, `${label}[${index}].generatorVersion`);
  }
}

function assertConflictReviewProvenance(value: unknown, label: string): void {
  const rows = asArray(value, label);
  for (const [index, rowValue] of rows.entries()) {
    const row = asStrictRecord(rowValue, `${label}[${index}]`, [
      "sourceProvenanceId",
      "catalogSource",
      "sourceId",
      "sourceRecordKind",
      "payloadHash",
      "fetchedAt",
    ]);
    assertString(row.sourceProvenanceId, `${label}[${index}].sourceProvenanceId`);
    assertString(row.catalogSource, `${label}[${index}].catalogSource`);
    assertPublicCatalogSource(row.catalogSource, `${label}[${index}].catalogSource`);
    assertString(row.sourceId, `${label}[${index}].sourceId`);
    assertNoCatalogPrivateLeakage(row.sourceId, `${label}[${index}].sourceId`);
    assertString(row.sourceRecordKind, `${label}[${index}].sourceRecordKind`);
    assertPublicCatalogSourceRecordKind(
      row.sourceRecordKind,
      `${label}[${index}].sourceRecordKind`,
    );
    assertNullableString(row.payloadHash, `${label}[${index}].payloadHash`);
    assertDateLike(row.fetchedAt, `${label}[${index}].fetchedAt`);
  }
}

function assertPublicCatalogSource(value: string, label: string): void {
  assertEnum(value, Object.values(catalogSourceValues) as CatalogSource[], label);
  if (value === catalogSourceValues.localCorpus) {
    throw new Error(`${label} must not expose local corpus sources`);
  }
}

function assertPublicCatalogSourceRecordKind(value: string, label: string): void {
  assertEnum(
    value,
    Object.values(catalogSourceRecordKindValues) as CatalogSourceRecordKind[],
    label,
  );
  if (value === catalogSourceRecordKindValues.localScan) {
    throw new Error(`${label} must not expose local scan sources`);
  }
}

function assertPublicCatalogRedactionClass(value: string, label: string): void {
  assertEnum(
    value,
    Object.values(catalogRawContentRedactionClassValues) as CatalogRawContentRedactionClass[],
    label,
  );
  if (value === catalogRawContentRedactionClassValues.privateCorpus) {
    throw new Error(`${label} must not expose private corpus data`);
  }
}

function assertNoCatalogPrivateLeakage(value: string, label: string): void {
  if (benchmarkSeedPrivateLeakagePatterns.some((pattern) => pattern.test(value))) {
    throw new Error(`${label} must not expose private response data`);
  }
}

function assertDateLike(value: unknown, label: string): void {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (date === null || Number.isNaN(date.getTime())) {
    throw new Error(`${label} must be a date`);
  }
}

function assertNullableDateLike(value: unknown, label: string): void {
  if (value !== null) {
    assertDateLike(value, label);
  }
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
}

function assertNonNegativeNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
}

function assertFiniteNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
}

function assertNullableNonNegativeInteger(
  value: unknown,
  label: string,
): asserts value is number | null {
  if (value !== null) {
    assertNonNegativeInteger(value, label);
  }
}

function assertNullableNonNegativeNumber(
  value: unknown,
  label: string,
): asserts value is number | null {
  if (value !== null) {
    assertNonNegativeNumber(value, label);
  }
}

function assertBoolean(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
}

function assertEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): asserts value is T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${label} must be one of ${allowed.join(", ")}`);
  }
}
