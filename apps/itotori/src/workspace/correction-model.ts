// ITOTORI-118 — read-models for the workspace manual-correction mutation layer.
//
// Two surfaces sit on top of the read-only ITOTORI-040 workspace:
//
//   - PREVIEW (`workspace.correction_preview`): a GET read-model that, for a
//     batch of review items the reviewer is about to correct, carries the
//     source / draft / final text, runtime + screenshot evidence links, and the
//     active style-guide policy + glossary context — everything the reviewer
//     must see BEFORE submitting (acceptance #3). It is gated on `queue.read`,
//     so it composes the same read seam as browsing.
//
//   - SUBMIT (`workspace.correction_submit`): REMOVED as a target-edit path
//     (p0-core-result-revision-hitl). A target-line edit is a first-class
//     play-tester result revision + child delivered patch revision
//     (`PlayTesterResultRevisionService`), not a reviewer-queue action and not
//     a request_repair detour. The POST still exists as a structured refusal
//     so callers get a typed diagnostic instead of a silent no-op.
//
// Locale-branch identity (ITOTORI-059) is load-bearing: a single submit is
// scoped to one `localeBranchId`, and preview units whose own branch disagrees
// with the requested branch are dropped with a `branch_conflation_guard`
// diagnostic — corrections are never conflated across branches.

import type { WorkspacePermissionView, WorkspaceRuntimeEvidenceLink } from "./read-model.js";

export type WorkspaceCorrectionPermissionView = WorkspacePermissionView;

export const workspaceCorrectionDiagnosticCodeValues = {
  readPermissionDenied: "workspace_correction_read_permission_denied",
  mutationPermissionDenied: "workspace_correction_mutation_permission_denied",
  branchConflationGuard: "workspace_correction_branch_conflation_guard",
  previewContextUnavailable: "workspace_correction_preview_context_unavailable",
  emptyBatch: "workspace_correction_empty_batch",
  invalidCorrection: "workspace_correction_invalid_correction",
  needsContext: "workspace_correction_needs_context",
  duplicate: "workspace_correction_duplicate",
  /**
   * p0-core-result-revision-hitl — target edits no longer route through the
   * reviewer queue / request_repair correction path. Use the play-tester
   * result-revision service instead.
   */
  legacyQueueCorrectionRemoved: "workspace_correction_legacy_queue_path_removed",
} as const;

export type WorkspaceCorrectionDiagnosticCode =
  (typeof workspaceCorrectionDiagnosticCodeValues)[keyof typeof workspaceCorrectionDiagnosticCodeValues];

export type WorkspaceCorrectionDiagnostic = {
  code: WorkspaceCorrectionDiagnosticCode;
  message: string;
};

export const workspaceCorrectionDispositionValues = {
  repairCandidate: "repair_candidate",
  decisionQueue: "decision_queue",
  needsContext: "needs_context",
} as const;

export type WorkspaceCorrectionDisposition =
  (typeof workspaceCorrectionDispositionValues)[keyof typeof workspaceCorrectionDispositionValues];

// ---------------------------------------------------------------------------
// Preview (before submission)
// ---------------------------------------------------------------------------

export type WorkspaceCorrectionGlossaryRef = {
  termId: string;
  sourceTerm: string;
  preferredTranslation: string;
  status: string;
};

/**
 * One unit the reviewer is about to correct, with all the context required
 * before submission: source / draft / final text, style + glossary context,
 * and runtime / screenshot evidence links.
 */
export type WorkspaceCorrectionPreviewUnit = {
  reviewItemId: string;
  localeBranchId: string | null;
  sourceRevisionId: string | null;
  bridgeUnitId: string | null;
  sourceUnitKey: string | null;
  sourceLocale: string | null;
  sourceText: string | null;
  targetLocale: string | null;
  draftText: string | null;
  finalText: string | null;
  styleGuidePolicyVersionId: string | null;
  styleGuidePolicyStatus: string | null;
  glossary: WorkspaceCorrectionGlossaryRef[];
  runtimeEvidenceLinks: WorkspaceRuntimeEvidenceLink[];
  screenshotArtifactHashes: string[];
  diagnostics: WorkspaceCorrectionDiagnostic[];
};

export type WorkspaceCorrectionPreviewReadModel = {
  schemaVersion: "workspace.correction_preview.v0.1";
  generatedAt: Date;
  permission: WorkspaceCorrectionPermissionView;
  projectId: string | null;
  localeBranchId: string;
  sourceBundleId: string | null;
  targetLocale: string | null;
  units: WorkspaceCorrectionPreviewUnit[];
  diagnostics: WorkspaceCorrectionDiagnostic[];
};

// ---------------------------------------------------------------------------
// Submit result (durable edit history + routing)
// ---------------------------------------------------------------------------

export type WorkspaceCorrectionEditView = {
  correctionEditId: string;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  bridgeUnitId: string;
  actorUserId: string;
  reason: string;
  beforeText: string | null;
  afterText: string;
  disposition: WorkspaceCorrectionDisposition;
  triageLabel: string;
  feedbackReportId: string;
  feedbackEvidenceId: string;
  reviewItemId: string | null;
  duplicate: boolean;
};

/** Direct shared-brain result for one play-tester context correction. */
export type WorkspaceCorrectionWritebackView = {
  bridgeUnitId: string;
  /** Canonical ContextEntry whose immutable head was advanced. */
  contextArtifactId: string;
  /** Newly appended canonical ContextEntryVersion identity. */
  contextEntryVersionId: string;
  /** Context artifacts invalidated before the new head was appended. */
  invalidatedArtifactIds: string[];
  /** Exact unit scope sent to the registered redraft worker. */
  affectedBridgeUnitIds: string[];
  /** The registered context-correction redraft job. */
  scheduledJobIds: string[];
};

export type WorkspaceCorrectionSubmitReadModel = {
  schemaVersion: "workspace.correction_submit.v0.1";
  generatedAt: Date;
  permission: WorkspaceCorrectionPermissionView;
  localeBranchId: string;
  batchId: string;
  batchLabel: string | null;
  submittedCount: number;
  edits: WorkspaceCorrectionEditView[];
  /** Retained feedback-audit classification; it never enters a reviewer queue. */
  repairCandidateReportIds: string[];
  /** Retained feedback-audit classification; it never routes a reviewer queue item. */
  decisionQueueReportIds: string[];
  /** Feedback reports tagged as needing more context, retained for audit only. */
  needsContextReportIds: string[];
  /** Union of every bridge unit corrected in the batch — the rerun scope. */
  affectedBridgeUnitIds: string[];
  /**
   * Per-correction canonical context version + registered redraft schedule.
   */
  writebacks: WorkspaceCorrectionWritebackView[];
  /** Union of registered context-correction redraft jobs scheduled by the batch. */
  scheduledRerunJobIds: string[];
  diagnostics: WorkspaceCorrectionDiagnostic[];
};
