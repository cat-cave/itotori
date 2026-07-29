import type { AuthorizationActor } from "../authorization.js";

export const feedbackSourceKindValues = {
  manualPlaytest: "manual_playtest",
  manualReview: "manual_review",
  importedFile: "imported_file",
  runtimeReview: "runtime_review",
  internalNote: "internal_note",
  communityChannel: "community_channel",
} as const;

export type FeedbackSourceKind =
  (typeof feedbackSourceKindValues)[keyof typeof feedbackSourceKindValues];

export const feedbackTypeValues = {
  objectiveDefect: "objective_defect",
  stylePreference: "style_preference",
  glossaryCanonIssue: "glossary_canon_issue",
  unclearContext: "unclear_context",
  runtimeIssue: "runtime_issue",
  assetIssue: "asset_issue",
} as const;

export type FeedbackType = (typeof feedbackTypeValues)[keyof typeof feedbackTypeValues];

export const feedbackTriageLabelValues = {
  objectiveDefectCandidate: "objective_defect_candidate",
  styleDisputeCandidate: "style_dispute_candidate",
  glossaryCanonCandidate: "glossary_canon_candidate",
  runtimeIssueCandidate: "runtime_issue_candidate",
  assetIssueCandidate: "asset_issue_candidate",
  contextCorrectionCandidate: "context_correction_candidate",
} as const;

export type FeedbackTriageLabel =
  (typeof feedbackTriageLabelValues)[keyof typeof feedbackTriageLabelValues];

export const feedbackContextStatusValues = {
  contextualized: "contextualized",
} as const;

export type FeedbackContextStatus =
  (typeof feedbackContextStatusValues)[keyof typeof feedbackContextStatusValues];

export const feedbackReportStatusValues = {
  open: "open",
} as const;

export type FeedbackReportStatus =
  (typeof feedbackReportStatusValues)[keyof typeof feedbackReportStatusValues];

export type FeedbackReporter = {
  role: string;
  reporterId?: string;
  displayName?: string;
  contact?: string;
};

export type ManualFeedbackLineReference = {
  /** Every feedback import is scoped to a concrete bridge unit. */
  bridgeUnitId: string;
  sourceUnitKey?: string;
  sourceHash?: string;
  assetId?: string;
  path?: string;
  line?: number;
  column?: number;
  sourceLocation?: Record<string, unknown>;
  quotedText?: string;
};

type ManualFeedbackAttachmentBase = {
  attachmentId?: string;
  artifactId?: string;
  uri?: string;
  hash?: string;
  metadata?: Record<string, unknown>;
};

export type ManualFeedbackScreenshotAttachment = ManualFeedbackAttachmentBase & {
  attachmentKind: "screenshot";
  caption?: string;
  capturePosition?: string;
  evidenceTier?: string;
};

export type ManualFeedbackSaveContextAttachment = ManualFeedbackAttachmentBase & {
  attachmentKind: "save_context";
  contextToken?: string;
  routeRef?: string;
  sceneRef?: string;
  createdAt?: string;
};

export type ManualFeedbackContextAttachment = ManualFeedbackAttachmentBase & {
  attachmentKind: "context";
  contextKind: string;
  contextId?: string;
  routeRef?: string;
  sceneRef?: string;
  speakerRef?: string;
  visibleText?: string;
};

export type ManualFeedbackRuntimeArtifactAttachment = ManualFeedbackAttachmentBase & {
  attachmentKind: "runtime_artifact";
  runtimeArtifactId: string;
  evidenceTier?: string;
};

export type ManualFeedbackAttachment =
  | ManualFeedbackScreenshotAttachment
  | ManualFeedbackSaveContextAttachment
  | ManualFeedbackContextAttachment
  | ManualFeedbackRuntimeArtifactAttachment;

export type ManualFeedbackSourceInput = {
  feedbackSourceId?: string;
  sourceKind?: FeedbackSourceKind;
  label?: string;
  sourceChannel?: string;
  privacyReviewState?: string;
  metadata?: Record<string, unknown>;
};

export type ManualFeedbackImportInput = {
  feedbackReportId?: string;
  feedbackEvidenceId?: string;
  feedbackSourceId?: string;
  feedbackSource?: ManualFeedbackSourceInput;
  projectId: string;
  /** The canonical branch that owns the concrete bridge-unit target. */
  localeBranchId: string;
  sourceBundleId?: string;
  feedbackType: FeedbackType;
  reporter: FeedbackReporter;
  reporterNote: string;
  /** A feedback import never creates a deferred, targetless report. */
  lineReference: ManualFeedbackLineReference;
  attachments?: ManualFeedbackAttachment[];
  privacyClassification?: string;
  redactionState?: string;
  reportedAt?: string;
  dedupeKey?: string;
  suggestedEdit?: string;
  metadata?: Record<string, unknown>;
};

export type ManualFeedbackImportResult = {
  feedbackReportId: string;
  feedbackEvidenceId: string;
  feedbackSourceId: string;
  dedupeKey: string;
  triageLabel: FeedbackTriageLabel;
  reportStatus: FeedbackReportStatus;
  contextStatus: FeedbackContextStatus;
  reportCount: number;
  duplicate: boolean;
};

/**
 * Persisted context needed to turn a feedback report into a canonical context
 * correction. This deliberately does not describe a separate decision item:
 * feedback intake is allowed to feed the shared correction path directly.
 */
export type ManualFeedbackCorrectionContext = {
  feedbackReportId: string;
  feedbackEvidenceId: string;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  feedbackType: FeedbackType;
  triageLabel: FeedbackTriageLabel;
  contextStatus: FeedbackContextStatus;
  /** The report/evidence text as durably persisted by feedback intake. */
  reporterNote: string;
  suggestedEdit: string | null;
  /** Stable, persisted target units; never inferred from a caller's raw input. */
  affectedUnitIds: string[];
};

/** One durable unit-bound note projected from feedback_reports + evidence. */
export type UnitBoundFeedbackNote = {
  feedbackReportId: string;
  feedbackEvidenceId: string;
  projectId: string;
  localeBranchId: string;
  bridgeUnitId: string;
  sceneId: string | null;
  note: string;
  severity: string;
  category: string;
  triageLabel: FeedbackTriageLabel;
  contextStatus: FeedbackContextStatus;
  reportedAt: string;
  duplicate: boolean;
};

export interface ItotoriFeedbackRepositoryPort {
  importManualFeedback(
    actor: AuthorizationActor,
    input: ManualFeedbackImportInput,
  ): Promise<ManualFeedbackImportResult>;
  loadManualFeedbackCorrectionContext(
    actor: AuthorizationActor,
    feedbackReportId: string,
    feedbackEvidenceId: string,
  ): Promise<ManualFeedbackCorrectionContext | null>;
  /**
   * List every durable feedback note bound to one bridge unit on a branch.
   * Ordered oldest → newest so the review surface can replay arrival order.
   */
  listUnitBoundFeedback(
    actor: AuthorizationActor,
    query: { projectId: string; localeBranchId: string; bridgeUnitId: string },
  ): Promise<UnitBoundFeedbackNote[]>;
}
