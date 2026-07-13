// ALPHA-002 — Batched draft-feedback intake.
//
// Composes the existing `ManualFeedbackImportService` (driven once per
// submission) so a play tester can collect many corrections from a playable
// slice and submit them as one batch. The service adds NO new persistence
// of its own — every submission flows through the same feedback
// repository path the single-item importer already uses. When the importer is
// wired with canonical context corrections, it owns that direct no-queue
// routing; this module only batches and partitions the audit results.

import { createHash } from "node:crypto";
import type { ManualFeedbackImportPort } from "../manual-feedback.js";
import type {
  DraftFeedbackBatchInput,
  DraftFeedbackBatchItem,
  DraftFeedbackBatchResult,
} from "./types.js";

export interface DraftFeedbackBatchPort {
  submitBatch(input: DraftFeedbackBatchInput): Promise<DraftFeedbackBatchResult>;
}

export class DraftFeedbackBatchError extends Error {
  constructor(
    readonly code: "empty_batch",
    message: string,
  ) {
    super(message);
    this.name = "DraftFeedbackBatchError";
  }
}

export class DraftFeedbackBatchService implements DraftFeedbackBatchPort {
  constructor(private readonly importPort: ManualFeedbackImportPort) {}

  /**
   * Submit a batch of feedback. Each submission is imported through the
   * existing single-item path, which always writes its canonical correction
   * before returning an outcome. A batch cannot park a targetless submission.
   */
  async submitBatch(input: DraftFeedbackBatchInput): Promise<DraftFeedbackBatchResult> {
    if (input.submissions.length === 0) {
      throw new DraftFeedbackBatchError(
        "empty_batch",
        "draft feedback batch refused: a batch must contain at least one submission",
      );
    }

    const items: DraftFeedbackBatchItem[] = [];
    for (let index = 0; index < input.submissions.length; index += 1) {
      const submission = input.submissions[index]!;
      const result = await this.importPort.importManualFeedback(submission);
      const triageLabel = result.triageLabel;
      const item: DraftFeedbackBatchItem = {
        submissionIndex: index,
        feedbackType: submission.feedbackType,
        triageLabel,
        feedbackReportId: result.feedbackReportId,
        contextCorrectionId: result.contextCorrection.correctionId,
        bridgeUnitIds: bridgeUnitIdsForSubmission(submission),
        observed: submission.reporterNote,
        ...(submission.suggestedEdit === undefined
          ? {}
          : { suggestedEdit: submission.suggestedEdit }),
        duplicate: result.duplicate,
      };
      items.push(item);
    }

    return assembleResult(input, items);
  }
}

function assembleResult(
  input: DraftFeedbackBatchInput,
  items: ReadonlyArray<DraftFeedbackBatchItem>,
): DraftFeedbackBatchResult {
  const contextCorrectionReportIds: string[] = [];
  const contextCorrectionIds: string[] = [];
  const affected = new Set<string>();
  for (const item of items) {
    contextCorrectionReportIds.push(item.feedbackReportId);
    contextCorrectionIds.push(item.contextCorrectionId);
    for (const unit of item.bridgeUnitIds) {
      affected.add(unit);
    }
  }
  return {
    batchId: mintBatchId(input),
    ...(input.batchLabel === undefined ? {} : { batchLabel: input.batchLabel }),
    submittedCount: items.length,
    items,
    contextCorrectionReportIds,
    contextCorrectionIds,
    affectedBridgeUnitIds: sortedUnique([...affected]),
  };
}

function bridgeUnitIdsForSubmission(
  submission: DraftFeedbackBatchInput["submissions"][number],
): string[] {
  return [submission.lineReference.bridgeUnitId];
}

function mintBatchId(input: DraftFeedbackBatchInput): string {
  // Deterministic id over the submissions' stable identity so a replay
  // of the same batch produces a byte-equal id.
  const seed = JSON.stringify({
    label: input.batchLabel ?? null,
    submissions: input.submissions.map((submission) => ({
      projectId: submission.projectId,
      localeBranchId: submission.localeBranchId,
      feedbackType: submission.feedbackType,
      reporterNote: submission.reporterNote,
      bridgeUnitIds: bridgeUnitIdsForSubmission(submission),
      suggestedEdit: submission.suggestedEdit ?? null,
    })),
  });
  return `draft-feedback-batch-${createHash("sha256").update(seed).digest("hex").slice(0, 16)}`;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}
