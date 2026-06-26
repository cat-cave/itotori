// ITOTORI-038 — Repair-and-rerun orchestration skeleton public surface.
//
// Consolidates the types, affected-work selector, and repair-job
// service behind one import path so the agentic-loop orchestrator and
// downstream dashboards reach a single seam.

export {
  REPAIR_AFFECTED_SCOPES,
  REPAIR_JOB_OUTCOMES,
  REPAIR_JOB_SEVERITIES,
  REPAIR_JOB_TRIGGERS,
  REPAIR_PIPELINE_STAGES,
  type RepairAffectedScope,
  type RepairEvent,
  type RepairJob,
  type RepairJobOutcome,
  type RepairJobSeverity,
  type RepairJobTrigger,
  type RepairPipelineStage,
  type RepairProviderPair,
  type RepairTrigger,
  type RepairTriggerHumanDecision,
  type RepairTriggerProtectedSpanViolation,
  type RepairTriggerQaFinding,
} from "./types.js";

export {
  AffectedWorkSelectorError,
  selectAffectedWork,
  type AffectedWorkSelection,
  type RepairSceneIndex,
} from "./affected-work-selector.js";

export {
  RepairJobService,
  RepairJobServiceError,
  type EnqueueRepairJobInput,
  type RepairJobServiceClock,
  type RepairJobServiceOptions,
} from "./repair-job-service.js";
