// ALPHA-002 — Playable draft feedback loop: public surface.
//
// One import path for the batched feedback intake, the scoped repair
// plan, and the before/after dashboard evidence. Each piece COMPOSES an
// existing seam (manual-feedback import, reviewer-triggered rerun
// scheduler) rather than reimplementing it.

export {
  DraftFeedbackBatchError,
  DraftFeedbackBatchService,
  type DraftFeedbackBatchPort,
  dispositionFor,
} from "./batch-service.js";
export { buildDraftFeedbackRepairPlan } from "./repair-plan.js";
export {
  buildDraftFeedbackLoopEvidence,
  type BuildDraftFeedbackLoopEvidenceArgs,
} from "./loop-evidence.js";
export {
  DRAFT_FEEDBACK_DISPOSITIONS,
  type DraftFeedbackBatchInput,
  type DraftFeedbackBatchItem,
  type DraftFeedbackBatchResult,
  type DraftFeedbackCorrection,
  type DraftFeedbackDisposition,
  type DraftFeedbackLoopEvidence,
  type DraftFeedbackRepairPlan,
  type DraftFeedbackRepairPlanItem,
} from "./types.js";
