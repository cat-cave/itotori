// ALPHA-002 — Playable draft feedback loop: shared types.
//
// Human draft feedback from a playable / runtime-reviewed slice flows
// through two existing seams, composed (never reimplemented) here:
//
//   1. intake + triage  → `ManualFeedbackImportService` (single item) is
//      driven once per submission by `DraftFeedbackBatchService`, so a
//      playtester can collect MANY corrections and submit them as one
//      batch. The feedback repository assigns a `FeedbackTriageLabel`
//      and immediately creates a canonical context correction.
//   2. correction       → each persisted correction owns its registered
//      rerun scheduling. A batch never parks targetless feedback for later.
//
// No `as any`, no `@ts-ignore`. The disposition switch is exhaustive
// over `FeedbackTriageLabel` at the type level.

import type { FeedbackTriageLabel, FeedbackType } from "@itotori/db";
import type { ManualFeedbackImportInput } from "../manual-feedback.js";

/**
 * A batch of human draft-feedback submissions. Each entry is a fully
 * typed `ManualFeedbackImportInput` carrying its own context
 * (`lineReference.bridgeUnitId`, `suggestedEdit`, attachments). Multiple
 * corrections are collected here and submitted together.
 */
export type DraftFeedbackBatchInput = {
  /** Optional human label surfaced on the dashboard / evidence view. */
  batchLabel?: string;
  submissions: ReadonlyArray<ManualFeedbackImportInput>;
};

/** One submission's routing outcome inside a batch. */
export type DraftFeedbackBatchItem = {
  submissionIndex: number;
  feedbackType: FeedbackType;
  triageLabel: FeedbackTriageLabel;
  feedbackReportId: string;
  /** The durable canonical correction written for this exact submission. */
  contextCorrectionId: string;
  /** The concrete bridge unit this submission points at. */
  bridgeUnitIds: ReadonlyArray<string>;
  /** The playtester's observed text / note — the "before" side. */
  observed: string;
  /** The reporter's proposed correction — the "after" side, when given. */
  suggestedEdit?: string;
  duplicate: boolean;
};

/**
 * Result of submitting a batch. Every submission has a direct correction
 * receipt; there is no deferred partition.
 */
export type DraftFeedbackBatchResult = {
  batchId: string;
  batchLabel?: string;
  submittedCount: number;
  items: ReadonlyArray<DraftFeedbackBatchItem>;
  /** Feedback reports that entered canonical context correction. */
  contextCorrectionReportIds: ReadonlyArray<string>;
  /** Durable correction ids in submission order. */
  contextCorrectionIds: ReadonlyArray<string>;
  /** Union of every bridge unit named across the batch. */
  affectedBridgeUnitIds: ReadonlyArray<string>;
};
