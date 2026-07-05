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

// ITOTORI-120 — metadata-aware community/human feedback triage (enrichment +
// catalog-keyed routing). Distinct from the QA/root-cause router above: it
// decides whether a raw feedback REPORT enters the queue at all, using catalog
// metadata (edition identity, language completeness, demand, readiness,
// existing-translation, style-dispute).
export {
  type CatalogEditionMetadata,
  type CatalogFeedbackMetadataProvider,
  type CatalogWorkMetadataSnapshot,
  catalogWorkMetadataFromReadModel,
  deriveFeedbackReadinessLevel,
  enrichCommunityFeedback,
  type EnrichedFeedbackEdition,
  type EnrichedFeedbackItem,
  existingTranslationFromLanguageStatus,
  feedbackEditionMatchValues,
  type FeedbackEditionMatch,
  type FeedbackQueueLane,
  feedbackQueueLaneValues,
  feedbackReadinessLevelValues,
  type FeedbackReadinessLevel,
  type FeedbackTriageDecision,
  type FeedbackTriageDisposition,
  feedbackTriageDispositionValues,
  type FeedbackTriageSignals,
  InMemoryCatalogFeedbackMetadataProvider,
  isLowFeedbackReadiness,
  type RawCommunityFeedbackItem,
  type RequestedEditionRef,
  routeEnrichedFeedback,
  STYLE_DISPUTE_FEEDBACK_TYPES,
} from "./community/index.js";
