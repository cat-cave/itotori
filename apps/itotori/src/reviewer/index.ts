// ITOTORI-081 / ITOTORI-082 — public surface of the reviewer API.

export {
  ReviewerQueueActionService,
  ReviewerQueueActionServiceInputError,
  isRuntimeEvidenceItem,
} from "./action-service.js";
export type {
  ApproveActionInput,
  ImportRuntimeFeedbackActionInput,
  RejectActionInput,
  RequestRepairActionInput,
  ReviewerQueueActionCommonInput,
  ReviewerQueueActionServiceDeps,
  ReviewerQueueActionServicePort,
  UpdateGlossaryActionInput,
  UpdateStyleActionInput,
} from "./action-service.js";

export {
  buildReviewerTriggeredRerunJobInputs,
  ReviewerRepairRerunScheduler,
  reviewerTriggeredRerunJobNameValues,
  reviewerTriggeredRerunPayloadSchemaVersion,
  reviewerTriggeredRerunReasonCodeValues,
  reviewerTriggeredRerunStageValues,
} from "./repair-rerun-scheduler.js";
export type {
  ReviewerRepairRerunSchedulerOptions,
  ReviewerRepairRerunSchedulerPort,
  ReviewerTriggeredRerunJobName,
  ReviewerTriggeredRerunPayload,
  ReviewerTriggeredRerunPolicyVersions,
  ReviewerTriggeredRerunQueuePort,
  ReviewerTriggeredRerunReasonCode,
  ReviewerTriggeredRerunScheduleResult,
  ReviewerTriggeredRerunStage,
} from "./repair-rerun-scheduler.js";
export {
  fixtureBatchRepairRerun,
  fixturePolicyInvalidationRerun,
  fixtureRuntimeFeedbackRerun,
  fixtureSingleItemRepairRerun,
  itotori084FixtureLocaleBranchId,
  itotori084FixturePolicyVersions,
  itotori084FixtureProjectId,
  itotori084FixtureSourceRevisionId,
} from "./repair-rerun-fixtures.js";

// ITOTORI-082 — reviewer detail view + route loader.
export {
  parseReviewerDetailRoute,
  renderReviewerDetailView,
  reviewerDetailRoutePathRegex,
  reviewerDetailViewInternals,
} from "./detail-view.js";
export type { ReviewerDetailRouteParams } from "./detail-view.js";
export { loadReviewerDetailContext, renderReviewerDetailRoute } from "./detail-route.js";
export type {
  ReviewerDetailEvidenceLoaderPort,
  ReviewerDetailEvidencePayload,
  ReviewerDetailRouteDeps,
} from "./detail-route.js";
export {
  deniedContextFixture,
  draftFixture,
  glossaryFixture,
  policyFixture,
  qaFindingFixture,
  rationaleFixture,
  readyContextFixture,
  repositoryTransitionFixture,
  reviewerDetailDiagnosticCodeValues,
  runtimeBenchmarkFixture,
  runtimeEvidenceItemFixture,
  runtimeProviderProofFixture,
  runtimeScreenshotFixture,
  runtimeTextTraceFixture,
  sourceUnitFixture,
  staleContextFixture,
  transitionFixture,
} from "./detail-fixtures.js";
export type {
  ReviewerDetailContext,
  ReviewerDetailDiagnostic,
  ReviewerDetailDiagnosticCode,
  ReviewerDetailDraft,
  ReviewerDetailGlossaryEntry,
  ReviewerDetailPermissionView,
  ReviewerDetailPolicy,
  ReviewerDetailQaFinding,
  ReviewerDetailRationaleRef,
  ReviewerDetailRuntimeEvidence,
  ReviewerDetailSourceUnit,
  ReviewerDetailTransition,
} from "./detail-fixtures.js";

// ITOTORI-082 — re-export the permission-view resolver from `auth.ts`
// so reviewer consumers can import everything they need from
// `@itotori/app`'s reviewer surface, while the actual
// `requirePermission` call stays in `auth.ts` per the API mutation
// permission matrix audit.
export { resolveReviewerQueuePermissionView, type ReviewerQueuePermissionView } from "../auth.js";

// ITOTORI-083 — batch action preview + atomic batch executor.
export {
  ReviewerBatchPreviewService,
  ReviewerBatchPreviewServiceInputError,
  reviewerBatchPreviewStatusValues,
} from "./batch-preview.js";
export type {
  BatchPreviewItem,
  ReviewerBatchActionRequest,
  ReviewerBatchConsequence,
  ReviewerBatchConsequenceResolverPort,
  ReviewerBatchPermissionView,
  ReviewerBatchPreview,
  ReviewerBatchPreviewServicePort,
  ReviewerBatchPreviewStatus,
  ReviewerBatchSelection,
} from "./batch-preview.js";

export {
  ReviewerBatchActionService,
  ReviewerBatchActionServiceInputError,
} from "./batch-execute.js";
export type {
  BatchActionPayload,
  BatchActionPayloadResolver,
  BatchExecuteOutcome,
  ReviewerBatchActionServiceDeps,
  ReviewerBatchActionServicePort,
  ReviewerBatchExecuteResult,
} from "./batch-execute.js";

export {
  parseReviewerBatchRoute,
  reviewerBatchRoutePathRegex,
  renderReviewerBatchPreviewView,
} from "./batch-view.js";

export {
  loadReviewerBatchPreview,
  renderReviewerBatchRoute,
  confirmReviewerBatch,
} from "./batch-route.js";
export type { ReviewerBatchConfirmDeps, ReviewerBatchRouteDeps } from "./batch-route.js";

export {
  fixtureAcceptedItem,
  fixtureAllAllowedPreview,
  fixtureAllowedGlossaryRow,
  fixtureAllowedRow,
  fixtureAllowedRuntimeRow,
  fixtureBatchPermissionView,
  fixtureBenchmarkConsequence,
  fixtureConflictingActionRequest,
  fixtureDeniedPreview,
  fixtureDraftStateChangeConsequence,
  fixtureDuplicateRow,
  fixtureEmptyPreview,
  fixtureEmptyRequest,
  fixtureExportConsequence,
  fixtureGlossaryWriteConsequence,
  fixtureInvalidInputRow,
  fixtureInvalidTransitionRow,
  fixtureMixedKindRequest,
  fixtureMixedPreview,
  fixtureNotFoundRow,
  fixturePendingGlossaryItem,
  fixturePendingQaItem,
  fixturePendingRuntimeEvidenceItem,
  fixturePolicyWriteConsequence,
  fixtureRerunJobConsequence,
  fixtureStaleRow,
  itotori083FixtureLocaleBranchId,
  itotori083FixtureProjectId,
  itotori083FixtureSourceRevisionId,
} from "./batch-fixtures.js";
