// ITOTORI-120 — public surface of the metadata-aware community/human feedback
// triage. Enrichment resolves catalog metadata onto a raw feedback item; routing
// turns the enriched signals into a deterministic queue decision so the triage
// queue does NOT blindly accept every report.

export {
  type CatalogEditionMetadata,
  type CatalogFeedbackMetadataProvider,
  type CatalogWorkMetadataSnapshot,
  catalogWorkMetadataFromReadModel,
  deriveFeedbackReadinessLevel,
  existingTranslationFromLanguageStatus,
  feedbackReadinessLevelValues,
  type FeedbackReadinessLevel,
  InMemoryCatalogFeedbackMetadataProvider,
  isLowFeedbackReadiness,
} from "./catalog-metadata.js";

export {
  enrichCommunityFeedback,
  type EnrichedFeedbackEdition,
  type EnrichedFeedbackItem,
  feedbackEditionMatchValues,
  type FeedbackEditionMatch,
  type RawCommunityFeedbackItem,
  type RequestedEditionRef,
  STYLE_DISPUTE_FEEDBACK_TYPES,
} from "./enrichment.js";

export {
  type FeedbackQueueLane,
  feedbackQueueLaneValues,
  type FeedbackTriageDecision,
  type FeedbackTriageDisposition,
  feedbackTriageDispositionValues,
  type FeedbackTriageSignals,
  routeEnrichedFeedback,
} from "./routing.js";
