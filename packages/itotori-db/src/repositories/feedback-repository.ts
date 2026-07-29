export { ItotoriFeedbackRepository } from "./feedback-repository-core.js";
export { deriveFeedbackDedupeKey } from "./feedback-repository-normalization.js";
export { parseManualFeedbackImportInput } from "./feedback-repository-parsing.js";
export {
  feedbackContextStatusValues,
  feedbackReportStatusValues,
  feedbackSourceKindValues,
  feedbackTriageLabelValues,
  feedbackTypeValues,
} from "./feedback-repository-types.js";
export type {
  FeedbackContextStatus,
  FeedbackReportStatus,
  FeedbackReporter,
  FeedbackSourceKind,
  FeedbackTriageLabel,
  FeedbackType,
  ItotoriFeedbackRepositoryPort,
  ManualFeedbackAttachment,
  ManualFeedbackContextAttachment,
  ManualFeedbackCorrectionContext,
  ManualFeedbackImportInput,
  ManualFeedbackImportResult,
  ManualFeedbackLineReference,
  ManualFeedbackRuntimeArtifactAttachment,
  ManualFeedbackSaveContextAttachment,
  ManualFeedbackScreenshotAttachment,
  ManualFeedbackSourceInput,
  UnitBoundFeedbackNote,
} from "./feedback-repository-types.js";
