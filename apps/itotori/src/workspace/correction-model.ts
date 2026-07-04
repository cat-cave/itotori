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
//   - SUBMIT (`workspace.correction_submit`): the result of a POST that records
//     durable edit-history events and routes each correction through the SAME
//     feedback + decision + targeted-rerun loop as QA / runtime findings
//     (acceptance #1 + #2). It is gated on `queue.manage`; a reviewer without
//     it gets a denial read-model and NO mutation occurs (acceptance #4).
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
  needsContext: "workspace_correction_needs_context",
  duplicate: "workspace_correction_duplicate",
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
  localeBranchId: string;
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

/**
 * The feedback loop's RETURN path for one correction: what was written back to
 * the translation-memory / glossary stores and which units the correction
 * scheduled an affected rerun for. Empty for corrections parked for context.
 */
export type WorkspaceCorrectionWritebackView = {
  bridgeUnitId: string;
  /** The reusable translation-memory segment the corrected target was written to. */
  memorySegmentId: string | null;
  /** The glossary term written, when the correction was term-scoped. */
  termId: string | null;
  /** Every bridge unit sharing the corrected source — the rerun scope. */
  affectedBridgeUnitIds: string[];
  /** The reviewer-rerun jobs scheduled to re-draft the affected units. */
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
  /** Feedback reports eligible for a scoped repair rerun (objective defects). */
  repairCandidateReportIds: string[];
  /** Feedback reports routed to the decision queue (style disputes). */
  decisionQueueReportIds: string[];
  /** Feedback reports parked for lack of context. */
  needsContextReportIds: string[];
  /** Union of every bridge unit corrected in the batch — the rerun scope. */
  affectedBridgeUnitIds: string[];
  /**
   * Per-correction feedback-loop return path: the glossary/TM writeback + the
   * affected rerun scheduled for each repair-candidate correction. Empty when no
   * feedback loop is wired or every correction was parked for context.
   */
  writebacks: WorkspaceCorrectionWritebackView[];
  /** Union of every reviewer-rerun job scheduled by the batch's writebacks. */
  scheduledRerunJobIds: string[];
  diagnostics: WorkspaceCorrectionDiagnostic[];
};
