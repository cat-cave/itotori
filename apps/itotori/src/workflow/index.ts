// The fixed artifact-driven localization workflow — the deterministic control
// flow that drives the whole localization pipeline end to end by composing the
// already-built pieces (run policy, source/localized wiki readiness, the P/Q
// roles, the deterministic gates, patchback, and the CAS/attempt substrate). The
// driver sequences, gates, routes, and finalizes; the roles produce the content.

export {
  runLocalizationWorkflow,
  runLocalizationWorkflowForPolicy,
  DEFAULT_PROVIDER_CONCURRENCY,
  DEFAULT_SCENE_CONCURRENCY,
  type SceneOutcome,
  type WorkflowOptions,
  type WorkflowRunReport,
} from "./driver.js";
export { BoundedConcurrency } from "./bounded-concurrency.js";
export {
  createWorkflowMemoIdentity,
  createWorkflowMemoRoleRoutes,
  workflowMemoKeyFor,
  PURE_MTL_WORKFLOW_MEMO_PREFIX,
  WORKFLOW_MEMO_IDENTITY_SCHEMA_VERSION,
  WORKFLOW_MEMO_KEY_SCHEMA_VERSION,
  WORKFLOW_MEMO_ROLE_IDS,
  type CreateWorkflowMemoIdentityInput,
  type WorkflowMemoIdentity,
  type WorkflowMemoKeyInput,
  type WorkflowMemoRenderPlan,
  type WorkflowMemoRole,
  type WorkflowMemoRoleRoute,
  type WorkflowMemoRoleRoutes,
  type WorkflowMemoStep,
} from "./memo-identity.js";
export {
  WorkflowReadinessError,
  WorkflowSequenceError,
  REVIEW_LANE_VALUES,
  type DraftMode,
  type DraftedScene,
  type DraftedUnit,
  type LaneVerdict,
  type ReviewLane,
  type UnitStage,
  type WorkflowScene,
  type WorkflowUnit,
} from "./types.js";
export {
  TransientStepError,
  type AdjudicatePort,
  type AdjudicationDisposition,
  type AttemptContext,
  type AttemptLineageEntry,
  type BibleReadinessPort,
  type CorrectionOutcome,
  type DraftPort,
  type FinalizedUnit,
  type GateEvaluationPort,
  type GateReport,
  type MemoStepResult,
  type PatchbackPort,
  type ReviewPort,
  type RepairPort,
  type UnitArtifactRef,
  type UnitReadiness,
  type WorkflowArtifactStore,
  type WorkflowPorts,
} from "./ports.js";
export { resolveWorkflowPolicy, releaseUnit, mayShip, type UnitRelease } from "./policy.js";
export { resolveSceneReadiness, type SceneReadiness } from "./readiness.js";
export { projectOutputScope, type OutputScopeProjection } from "./output-scope.js";
export {
  classifyStratum,
  cleanUnitSampled,
  planStratifiedReview,
  CLEAN_SAMPLE_EVERY_NTH,
  PRE_DRAFT_LANES,
  type ReviewPlan,
  type RiskStratum,
  type UnitReviewSelection,
} from "./risk-routing.js";
export { joinFindings } from "./finding-join.js";
export { implicatedRerun, type RerunScope } from "./rerun-scope.js";
export { coherenceSchedule, missingStageUnits, type CoherenceSchedule } from "./durability.js";
export { applyCorrections, type CorrectionRecord, type CorrectionSummary } from "./correction.js";
export {
  FinalizeBatchError,
  finalizeUnit,
  finalizeUnits,
  type FinalizeBatchResult,
} from "./finalize.js";
