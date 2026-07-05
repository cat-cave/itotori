// ITOTORI-118 — workspace manual-correction service (the mutation layer).
//
// This is the ONLY mutation seam the localization workspace adds on top of the
// read-only ITOTORI-040 surface. It composes — never reimplements — three
// existing seams:
//
//   1. feedback intake → `ManualFeedbackImportPort.importManualFeedback` is
//      driven once per correction. Each correction becomes a feedback report
//      carrying the reviewer's note (reason) + `suggestedEdit` (the corrected
//      text) + a `lineReference.bridgeUnitId`. The feedback repository assigns
//      the triage label and enqueues the reviewer-queue item with the affected
//      bridge unit on its metadata, so the correction enters the SAME decision
//      queue + targeted-rerun loop as QA / runtime findings (acceptance #2). No
//      parallel path.
//
//   2. durable edit history → `WorkspaceCorrectionEditPersistPort` records the
//      append-only audit row tied to (project, locale branch, source revision,
//      bridge unit, actor, reason) and links it back to the feedback report /
//      evidence it produced (acceptance #1).
//
//   3. before/after context → `WorkspaceCorrectionComparisonPort` reuses the
//      reviewer detail read-model (source / draft / final / runtime / style /
//      glossary) so the preview shows everything a reviewer must see before
//      submitting (acceptance #3).
//
// Permission: the preview is gated on `queue.read` (read-only browsing is never
// blocked); the submit is gated on `queue.manage` and short-circuits to a
// denial read-model with NO mutation when the actor lacks it (acceptance #4).
// A single submit is scoped to one locale branch (ITOTORI-059).

import { createHash } from "node:crypto";
import {
  type FeedbackType,
  type ManualFeedbackAttachment,
  type ManualFeedbackImportInput,
  type WorkspaceCorrectionEditInput,
  type WorkspaceCorrectionEditRecord,
  feedbackTypeValues,
} from "@itotori/db";
import { dispositionFor } from "../draft-feedback/batch-service.js";
import type { ReviewerDetailContext } from "../reviewer/detail-fixtures.js";
import type { ManualFeedbackImportPort } from "../manual-feedback.js";
import {
  workspaceCorrectionDiagnosticCodeValues,
  workspaceCorrectionDispositionValues,
  type WorkspaceCorrectionDiagnostic,
  type WorkspaceCorrectionEditView,
  type WorkspaceCorrectionGlossaryRef,
  type WorkspaceCorrectionPermissionView,
  type WorkspaceCorrectionPreviewReadModel,
  type WorkspaceCorrectionPreviewUnit,
  type WorkspaceCorrectionSubmitReadModel,
  type WorkspaceCorrectionWritebackView,
} from "./correction-model.js";
import type { WorkspaceCorrectionFeedbackLoopPort } from "./correction-feedback-loop.js";
import type { WorkspaceRuntimeEvidenceLink } from "./read-model.js";

/** Actor-bound persistence port (the DB wiring binds the authorization actor). */
export interface WorkspaceCorrectionEditPersistPort {
  recordCorrectionEdit(input: WorkspaceCorrectionEditInput): Promise<WorkspaceCorrectionEditRecord>;
  loadCorrectionEditsByBranch(localeBranchId: string): Promise<WorkspaceCorrectionEditRecord[]>;
}

/** Reuses the reviewer detail read-model as the before/after context source. */
export interface WorkspaceCorrectionComparisonPort {
  loadComparisonContext(input: {
    reviewItemId: string;
    permission: WorkspaceCorrectionPermissionView;
  }): Promise<ReviewerDetailContext>;
}

export type WorkspaceCorrectionServiceDeps = {
  importPort: ManualFeedbackImportPort;
  editRepository: WorkspaceCorrectionEditPersistPort;
  comparisonPort: WorkspaceCorrectionComparisonPort;
  /**
   * The feedback loop's RETURN path. When wired, every repair-candidate
   * correction writes its corrected target back into the translation-memory /
   * glossary stores AND schedules an affected rerun so the next draft for every
   * unit sharing that source reflects the correction. Optional so the read-only
   * and no-DB composition tests need not stand up the writeback stores; the live
   * DB wiring always provides it.
   */
  feedbackLoop?: WorkspaceCorrectionFeedbackLoopPort;
  now?: () => Date;
};

export type WorkspaceCorrectionSubmission = {
  bridgeUnitId: string;
  sourceUnitKey?: string;
  sourceRevisionId: string;
  reason: string;
  correctedText: string;
  draftText?: string;
  /**
   * When the correction fixes a glossary term, the source term to write back
   * (sourceTerm → correctedText) so the glossary carries the corrected
   * preferred translation. Absent for a plain segment-level correction.
   */
  sourceTerm?: string;
  feedbackType?: FeedbackType;
  attachments?: ManualFeedbackAttachment[];
  metadata?: Record<string, unknown>;
};

export type SubmitWorkspaceCorrectionsInput = {
  projectId: string;
  localeBranchId: string;
  sourceBundleId: string;
  targetLocale: string;
  actorUserId: string;
  actorDisplayName?: string;
  batchLabel?: string;
  corrections: WorkspaceCorrectionSubmission[];
  permission: WorkspaceCorrectionPermissionView;
};

export type LoadWorkspaceCorrectionPreviewInput = {
  localeBranchId: string;
  reviewItemIds: string[];
  permission: WorkspaceCorrectionPermissionView;
};

export interface WorkspaceCorrectionServicePort {
  loadPreview(
    input: LoadWorkspaceCorrectionPreviewInput,
  ): Promise<WorkspaceCorrectionPreviewReadModel>;
  submitCorrections(
    input: SubmitWorkspaceCorrectionsInput,
  ): Promise<WorkspaceCorrectionSubmitReadModel>;
}

export class WorkspaceCorrectionService implements WorkspaceCorrectionServicePort {
  private readonly now: () => Date;

  constructor(private readonly deps: WorkspaceCorrectionServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async loadPreview(
    input: LoadWorkspaceCorrectionPreviewInput,
  ): Promise<WorkspaceCorrectionPreviewReadModel> {
    const base = {
      schemaVersion: "workspace.correction_preview.v0.1" as const,
      generatedAt: this.now(),
      permission: input.permission,
      localeBranchId: input.localeBranchId,
    };
    if (!input.permission.canReadQueue) {
      return {
        ...base,
        units: [],
        diagnostics: [
          {
            code: workspaceCorrectionDiagnosticCodeValues.readPermissionDenied,
            message: permissionDenialReason(input.permission, "queue.read"),
          },
        ],
      };
    }
    const diagnostics: WorkspaceCorrectionDiagnostic[] = [];
    const units: WorkspaceCorrectionPreviewUnit[] = [];
    for (const reviewItemId of input.reviewItemIds) {
      const context = await this.deps.comparisonPort.loadComparisonContext({
        reviewItemId,
        permission: input.permission,
      });
      const itemBranchId = context.item?.localeBranchId ?? null;
      if (itemBranchId !== null && itemBranchId !== input.localeBranchId) {
        diagnostics.push({
          code: workspaceCorrectionDiagnosticCodeValues.branchConflationGuard,
          message: `Dropped review item ${reviewItemId} on locale branch ${itemBranchId} while assembling corrections for locale branch ${input.localeBranchId}; corrections are never conflated across branches.`,
        });
        continue;
      }
      units.push(previewUnitFromContext(reviewItemId, input.localeBranchId, context));
    }
    return { ...base, units, diagnostics };
  }

  async submitCorrections(
    input: SubmitWorkspaceCorrectionsInput,
  ): Promise<WorkspaceCorrectionSubmitReadModel> {
    const batchLabel = input.batchLabel ?? null;
    const base = {
      schemaVersion: "workspace.correction_submit.v0.1" as const,
      generatedAt: this.now(),
      permission: input.permission,
      localeBranchId: input.localeBranchId,
      batchLabel,
    };
    if (!input.permission.canManageQueue) {
      // Mutation refused — read-only browsing is preserved, but no edit-history
      // row, feedback report, or queue item is created (acceptance #4).
      return {
        ...base,
        batchId: emptyBatchId(input),
        submittedCount: 0,
        edits: [],
        repairCandidateReportIds: [],
        decisionQueueReportIds: [],
        needsContextReportIds: [],
        affectedBridgeUnitIds: [],
        writebacks: [],
        scheduledRerunJobIds: [],
        diagnostics: [
          {
            code: workspaceCorrectionDiagnosticCodeValues.mutationPermissionDenied,
            message: permissionDenialReason(input.permission, "queue.manage"),
          },
        ],
      };
    }

    const batchId = batchIdFor(input);
    const diagnostics: WorkspaceCorrectionDiagnostic[] = [];
    if (input.corrections.length === 0) {
      diagnostics.push({
        code: workspaceCorrectionDiagnosticCodeValues.emptyBatch,
        message: "Correction batch refused: a batch must contain at least one correction.",
      });
      return {
        ...base,
        batchId,
        submittedCount: 0,
        edits: [],
        repairCandidateReportIds: [],
        decisionQueueReportIds: [],
        needsContextReportIds: [],
        affectedBridgeUnitIds: [],
        writebacks: [],
        scheduledRerunJobIds: [],
        diagnostics,
      };
    }

    // Validate EVERY correction (and the batch-level identity fields) at the
    // service boundary BEFORE any `importManualFeedback` call. The downstream
    // edit repository (`normalizeCorrectionEdit`) rejects the same fields, but
    // it only runs AFTER a feedback row is already created — so a mid-batch
    // invalid correction would leave feedback rows written for the earlier
    // items (a fail-open partial mutation). Failing the whole batch up front,
    // before the first side effect, guarantees no partial mutation. The checks
    // below mirror the repository's `normalizeCorrectionEdit` checks exactly
    // (same required fields, same trimmed-vs-length constraints).
    const validationDiagnostics = validateCorrectionBatch(input);
    if (validationDiagnostics.length > 0) {
      return {
        ...base,
        batchId,
        submittedCount: 0,
        edits: [],
        repairCandidateReportIds: [],
        decisionQueueReportIds: [],
        needsContextReportIds: [],
        affectedBridgeUnitIds: [],
        writebacks: [],
        scheduledRerunJobIds: [],
        diagnostics: validationDiagnostics,
      };
    }

    const edits: WorkspaceCorrectionEditView[] = [];
    const writebacks: WorkspaceCorrectionWritebackView[] = [];
    const scheduledRerunJobIds = new Set<string>();
    const repairCandidateReportIds: string[] = [];
    const decisionQueueReportIds: string[] = [];
    const needsContextReportIds: string[] = [];
    const affected = new Set<string>();

    for (const correction of input.corrections) {
      const feedbackType = correction.feedbackType ?? feedbackTypeValues.objectiveDefect;
      const importInput = buildFeedbackImportInput(input, correction, feedbackType, batchId);
      const result = await this.deps.importPort.importManualFeedback(importInput);
      const disposition = dispositionFor(result.triageLabel);

      const record = await this.deps.editRepository.recordCorrectionEdit({
        projectId: input.projectId,
        localeBranchId: input.localeBranchId,
        sourceRevisionId: correction.sourceRevisionId,
        bridgeUnitId: correction.bridgeUnitId,
        actorUserId: input.actorUserId,
        reason: correction.reason,
        beforeText: correction.draftText ?? null,
        afterText: correction.correctedText,
        disposition,
        triageLabel: result.triageLabel,
        feedbackReportId: result.feedbackReportId,
        feedbackEvidenceId: result.feedbackEvidenceId,
        reviewItemId: null,
        batchId,
        ...(input.actorDisplayName === undefined
          ? {}
          : { actorDisplayName: input.actorDisplayName }),
        metadata: {
          feedbackType,
          sourceUnitKey: correction.sourceUnitKey ?? null,
          ...correction.metadata,
        },
      });

      affected.add(correction.bridgeUnitId);
      if (disposition === workspaceCorrectionDispositionValues.repairCandidate) {
        repairCandidateReportIds.push(result.feedbackReportId);
        // Feedback loop RETURN path: persist the corrected target into the
        // translation-memory (+ glossary when term-scoped) stores and schedule
        // an affected rerun, so the next draft for every unit sharing this
        // source reflects the correction. Only repair-candidate corrections
        // (objective defects) auto-return; style disputes and needs-context
        // corrections stay in the human decision queue.
        if (this.deps.feedbackLoop !== undefined && !record.duplicate) {
          const writeback = await this.deps.feedbackLoop.applyCorrectionWriteback({
            projectId: input.projectId,
            localeBranchId: input.localeBranchId,
            sourceRevisionId: correction.sourceRevisionId,
            bridgeUnitId: correction.bridgeUnitId,
            correctedText: correction.correctedText,
            feedbackReportId: result.feedbackReportId,
            batchId,
            reason: correction.reason,
            ...(correction.sourceTerm === undefined ? {} : { sourceTerm: correction.sourceTerm }),
          });
          if (writeback.writtenBack) {
            for (const unitId of writeback.affectedBridgeUnitIds) {
              affected.add(unitId);
            }
            for (const jobId of writeback.scheduledJobIds) {
              scheduledRerunJobIds.add(jobId);
            }
            writebacks.push({
              bridgeUnitId: correction.bridgeUnitId,
              memorySegmentId: writeback.memorySegmentId,
              termId: writeback.termId,
              affectedBridgeUnitIds: writeback.affectedBridgeUnitIds,
              scheduledJobIds: writeback.scheduledJobIds,
            });
          }
        }
      } else if (disposition === workspaceCorrectionDispositionValues.decisionQueue) {
        decisionQueueReportIds.push(result.feedbackReportId);
      } else {
        needsContextReportIds.push(result.feedbackReportId);
        diagnostics.push({
          code: workspaceCorrectionDiagnosticCodeValues.needsContext,
          message: `Correction for bridge unit ${correction.bridgeUnitId} was recorded but parked for lack of context; it will not schedule a repair until context arrives.`,
        });
      }
      if (record.duplicate) {
        diagnostics.push({
          code: workspaceCorrectionDiagnosticCodeValues.duplicate,
          message: `Correction for bridge unit ${correction.bridgeUnitId} duplicates an existing edit-history record; no new event was appended.`,
        });
      }
      edits.push(editView(record));
    }

    return {
      ...base,
      batchId,
      submittedCount: edits.length,
      edits,
      repairCandidateReportIds: sortedUnique(repairCandidateReportIds),
      decisionQueueReportIds: sortedUnique(decisionQueueReportIds),
      needsContextReportIds: sortedUnique(needsContextReportIds),
      affectedBridgeUnitIds: sortedUnique([...affected]),
      writebacks,
      scheduledRerunJobIds: sortedUnique([...scheduledRerunJobIds]),
      diagnostics,
    };
  }
}

/**
 * Service-boundary validation mirroring the edit repository's
 * `normalizeCorrectionEdit` checks (workspace-correction-repository.ts). Runs
 * over the WHOLE batch before any side effect so a later-item failure never
 * leaves earlier-item feedback rows written (no partial mutation). Returns one
 * structured diagnostic per invalid field, identifying the correction index,
 * the field, and the reason.
 */
function validateCorrectionBatch(
  input: SubmitWorkspaceCorrectionsInput,
): WorkspaceCorrectionDiagnostic[] {
  const diagnostics: WorkspaceCorrectionDiagnostic[] = [];
  const invalid = (index: number | null, field: string, reason: string): void => {
    const where =
      index === null
        ? "batch"
        : `correction[${index}] (bridgeUnitId ${input.corrections[index]?.bridgeUnitId ?? "?"})`;
    diagnostics.push({
      code: workspaceCorrectionDiagnosticCodeValues.invalidCorrection,
      message: `Correction batch refused: ${where} field ${field} is invalid: ${reason}. No feedback report, edit-history row, or queue item was created for any correction in the batch (no partial mutation).`,
    });
  };

  // Batch-level identity fields the repository requires non-empty (trimmed).
  // An empty value here would otherwise fail only AFTER the first correction's
  // feedback row is written.
  for (const [field, value] of [
    ["projectId", input.projectId],
    ["localeBranchId", input.localeBranchId],
    ["actorUserId", input.actorUserId],
  ] as const) {
    if (value.trim().length === 0) {
      invalid(null, field, "must be non-empty");
    }
  }

  input.corrections.forEach((correction, index) => {
    // reason: repository trims then rejects empty.
    if (correction.reason.trim().length === 0) {
      invalid(index, "reason", "must be a non-empty reason");
    }
    // correctedText → afterText: repository rejects length 0 (NOT trimmed).
    if (correction.correctedText.length === 0) {
      invalid(index, "correctedText", "must be non-empty corrected text");
    }
    // sourceRevisionId / bridgeUnitId: repository requires non-empty (trimmed).
    if (correction.sourceRevisionId.trim().length === 0) {
      invalid(index, "sourceRevisionId", "must be non-empty");
    }
    if (correction.bridgeUnitId.trim().length === 0) {
      invalid(index, "bridgeUnitId", "must be non-empty");
    }
  });

  return diagnostics;
}

function buildFeedbackImportInput(
  input: SubmitWorkspaceCorrectionsInput,
  correction: WorkspaceCorrectionSubmission,
  feedbackType: FeedbackType,
  batchId: string,
): ManualFeedbackImportInput {
  const importInput: ManualFeedbackImportInput = {
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
    sourceBundleId: input.sourceBundleId,
    targetLocale: input.targetLocale,
    feedbackType,
    reporter: {
      role: "reviewer",
      reporterId: input.actorUserId,
      displayName: input.actorDisplayName ?? input.actorUserId,
    },
    reporterNote: correction.reason,
    suggestedEdit: correction.correctedText,
    lineReference: {
      bridgeUnitId: correction.bridgeUnitId,
      ...(correction.sourceUnitKey === undefined
        ? {}
        : { sourceUnitKey: correction.sourceUnitKey }),
    },
    metadata: {
      workspaceCorrection: true,
      workspaceCorrectionBatchId: batchId,
      sourceRevisionId: correction.sourceRevisionId,
      affectedUnitIds: [correction.bridgeUnitId],
      bridgeUnitIds: [correction.bridgeUnitId],
      ...correction.metadata,
    },
  };
  if (correction.attachments !== undefined) {
    importInput.attachments = correction.attachments;
  }
  return importInput;
}

function previewUnitFromContext(
  reviewItemId: string,
  localeBranchId: string,
  context: ReviewerDetailContext,
): WorkspaceCorrectionPreviewUnit {
  const unitDiagnostics: WorkspaceCorrectionDiagnostic[] = [];
  if (context.source === null && context.draft === null) {
    unitDiagnostics.push({
      code: workspaceCorrectionDiagnosticCodeValues.previewContextUnavailable,
      message: `Review item ${reviewItemId} has neither source nor draft text loaded; the reviewer cannot see before/after context.`,
    });
  }
  const glossary: WorkspaceCorrectionGlossaryRef[] = context.glossary.map((entry) => ({
    termId: entry.termId,
    sourceTerm: entry.sourceTerm,
    preferredTranslation: entry.preferredTranslation,
    status: entry.glossaryEntryStatus,
  }));
  const runtimeEvidenceLinks: WorkspaceRuntimeEvidenceLink[] = context.runtimeEvidence.map(
    (evidence) => ({
      evidenceKind: evidence.evidenceKind,
      evidenceTier: evidence.evidenceTier,
      runtimeTargetId: evidence.runtimeTargetId,
      observationEventIds: evidence.observationEventIds,
      artifactHashes: evidence.artifactHashes,
      providerProofRefs: evidence.providerProofRefs,
      summary: evidence.summary,
    }),
  );
  const screenshotArtifactHashes = sortedUnique(
    context.runtimeEvidence
      .filter((evidence) => evidence.evidenceKind === "screenshot_artifact")
      .flatMap((evidence) => evidence.artifactHashes),
  );
  return {
    reviewItemId,
    localeBranchId: context.item?.localeBranchId ?? localeBranchId,
    sourceRevisionId: context.item?.sourceRevisionId ?? context.source?.sourceRevisionId ?? null,
    bridgeUnitId: context.source?.bridgeUnitId ?? null,
    sourceUnitKey: context.source?.sourceUnitKey ?? null,
    sourceLocale: context.source?.sourceLocale ?? null,
    sourceText: context.source?.sourceText ?? null,
    targetLocale: context.draft?.targetLocale ?? null,
    draftText: context.draft?.draftText ?? null,
    finalText: context.draft?.approvedPatchText ?? null,
    styleGuidePolicyVersionId: context.policy?.styleGuidePolicyVersionId ?? null,
    styleGuidePolicyStatus: context.policy?.styleGuidePolicyStatus ?? null,
    glossary,
    runtimeEvidenceLinks,
    screenshotArtifactHashes,
    diagnostics: unitDiagnostics,
  };
}

function editView(record: WorkspaceCorrectionEditRecord): WorkspaceCorrectionEditView {
  return {
    correctionEditId: record.correctionEditId,
    projectId: record.projectId,
    localeBranchId: record.localeBranchId,
    sourceRevisionId: record.sourceRevisionId,
    bridgeUnitId: record.bridgeUnitId,
    actorUserId: record.actorUserId,
    reason: record.reason,
    beforeText: record.beforeText,
    afterText: record.afterText,
    disposition: record.disposition,
    triageLabel: record.triageLabel,
    feedbackReportId: record.feedbackReportId,
    feedbackEvidenceId: record.feedbackEvidenceId,
    reviewItemId: record.reviewItemId,
    duplicate: record.duplicate,
  };
}

function permissionDenialReason(
  permission: WorkspaceCorrectionPermissionView,
  required: string,
): string {
  const reason =
    permission.denialReasons.find((entry) => entry.includes(required)) ??
    permission.denialReasons[0] ??
    `user ${permission.actorUserId} is missing permission ${required}`;
  return `Workspace correction blocked: ${reason}`;
}

function batchIdFor(input: SubmitWorkspaceCorrectionsInput): string {
  const seed = JSON.stringify({
    localeBranchId: input.localeBranchId,
    batchLabel: input.batchLabel ?? null,
    corrections: input.corrections.map((correction) => ({
      bridgeUnitId: correction.bridgeUnitId,
      sourceRevisionId: correction.sourceRevisionId,
      correctedText: correction.correctedText,
      reason: correction.reason,
    })),
  });
  return `workspace-correction-batch-${createHash("sha256").update(seed).digest("hex").slice(0, 16)}`;
}

function emptyBatchId(input: SubmitWorkspaceCorrectionsInput): string {
  return `workspace-correction-batch-${createHash("sha256")
    .update(JSON.stringify({ localeBranchId: input.localeBranchId, denied: true }))
    .digest("hex")
    .slice(0, 16)}`;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}
