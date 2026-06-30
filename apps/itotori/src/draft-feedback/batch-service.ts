// ALPHA-002 — Batched draft-feedback intake.
//
// Composes the existing `ManualFeedbackImportService` (driven once per
// submission) so a reviewer can collect many corrections from a playable
// slice and submit them as one batch. The service adds NO new persistence
// of its own — every submission flows through the same feedback
// repository + reviewer-queue path the single-item importer already uses,
// so style disputes land in the decision queue and objective defects
// become repair candidates exactly as before. This module only batches
// and partitions the results.

import { createHash } from "node:crypto";
import { type FeedbackTriageLabel, feedbackTriageLabelValues } from "@itotori/db";
import type { ManualFeedbackImportPort } from "../manual-feedback.js";
import type {
  DraftFeedbackBatchInput,
  DraftFeedbackBatchItem,
  DraftFeedbackBatchResult,
  DraftFeedbackDisposition,
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
   * existing single-item path (preserving its triage label, reviewer-
   * queue routing, and dedupe behavior); the results are partitioned by
   * disposition so the orchestrator can drive the existing repair /
   * decision-queue seams.
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
        disposition: dispositionFor(triageLabel),
        feedbackReportId: result.feedbackReportId,
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

/**
 * Narrow the feedback repository's triage label to a loop disposition.
 * Exhaustive over `FeedbackTriageLabel`: adding a new label without a
 * branch here is a compile error.
 */
export function dispositionFor(label: FeedbackTriageLabel): DraftFeedbackDisposition {
  switch (label) {
    case feedbackTriageLabelValues.styleDisputeCandidate:
      return "decision_queue";
    case feedbackTriageLabelValues.needsContext:
      return "needs_context";
    case feedbackTriageLabelValues.objectiveDefectCandidate:
    case feedbackTriageLabelValues.glossaryCanonCandidate:
    case feedbackTriageLabelValues.runtimeIssueCandidate:
    case feedbackTriageLabelValues.assetIssueCandidate:
      return "repair_candidate";
    default:
      return assertNever(label);
  }
}

function assembleResult(
  input: DraftFeedbackBatchInput,
  items: ReadonlyArray<DraftFeedbackBatchItem>,
): DraftFeedbackBatchResult {
  const repairCandidateReportIds: string[] = [];
  const decisionQueueReportIds: string[] = [];
  const affected = new Set<string>();
  for (const item of items) {
    if (item.disposition === "repair_candidate") {
      repairCandidateReportIds.push(item.feedbackReportId);
    } else if (item.disposition === "decision_queue") {
      decisionQueueReportIds.push(item.feedbackReportId);
    }
    for (const unit of item.bridgeUnitIds) {
      affected.add(unit);
    }
  }
  return {
    batchId: mintBatchId(input),
    ...(input.batchLabel === undefined ? {} : { batchLabel: input.batchLabel }),
    submittedCount: items.length,
    items,
    repairCandidateReportIds,
    decisionQueueReportIds,
    affectedBridgeUnitIds: sortedUnique([...affected]),
  };
}

function bridgeUnitIdsForSubmission(submission: {
  lineReference?: { bridgeUnitId?: string };
  metadata?: Record<string, unknown>;
}): ReadonlyArray<string> {
  const ids: string[] = [];
  const fromLine = submission.lineReference?.bridgeUnitId;
  if (typeof fromLine === "string" && fromLine.length > 0) {
    ids.push(fromLine);
  }
  for (const key of ["affectedUnitIds", "affectedBridgeUnitIds", "bridgeUnitIds", "unitIds"]) {
    const value = submission.metadata?.[key];
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "string" && entry.length > 0) {
          ids.push(entry);
        }
      }
    }
  }
  return sortedUnique(ids);
}

function mintBatchId(input: DraftFeedbackBatchInput): string {
  // Deterministic id over the submissions' stable identity so a replay
  // of the same batch produces a byte-equal id.
  const seed = JSON.stringify({
    label: input.batchLabel ?? null,
    submissions: input.submissions.map((submission) => ({
      projectId: submission.projectId,
      targetLocale: submission.targetLocale,
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

function assertNever(value: never): never {
  throw new Error(`draft feedback batch: unexpected triage label ${String(value)}`);
}
