// ITOTORI-022 — public surface of the triage / root-cause router.
//
// Consolidates the taxonomy, router, human-finding shape, and suggested
// action helpers behind one import path so callers don't have to reach
// across files.

export {
  ROOT_CAUSE_CLASSES,
  ROOT_CAUSE_CONFIDENCES,
  type RootCause,
  type RootCauseClass,
  type RootCauseConfidence,
} from "./root-cause.js";

export {
  HUMAN_FINDING_ATTRIBUTIONS,
  HUMAN_FINDING_SEVERITIES,
  type HumanFinding,
  type HumanFindingAttribution,
  type HumanFindingSeverity,
} from "./human-finding.js";

export {
  buildSuggestedAction,
  defaultAffectedComponent,
  type SuggestedActionContext,
} from "./suggested-action.js";

export {
  FindingTriageRouter,
  type FindingTriageInput,
  type FindingTriageResult,
  type FindingTriageRouting,
  type FindingTriageSummary,
  type TriageContext,
} from "./router.js";
