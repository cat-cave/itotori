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
  ReviewerQueueActionServicePort,
  UpdateGlossaryActionInput,
  UpdateStyleActionInput,
} from "./action-service.js";

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
