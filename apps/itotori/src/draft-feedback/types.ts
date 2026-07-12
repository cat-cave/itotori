// ALPHA-002 — Playable draft feedback loop: shared types.
//
// Human draft feedback from a playable / runtime-reviewed slice flows
// through two existing seams, composed (never reimplemented) here:
//
//   1. intake + triage  → `ManualFeedbackImportService` (single item) is
//      driven once per submission by `DraftFeedbackBatchService`, so a
//      reviewer can collect MANY corrections and submit them as one
//      batch. The feedback repository assigns a `FeedbackTriageLabel`
//      that this module narrows to a `DraftFeedbackDisposition`.
//   2. disposition      → the triage label is exposed as a typed
//      `DraftFeedbackDisposition` for its caller. It deliberately does not
//      lower reviewer decisions into jobs; canonical context corrections own
//      registered rerun scheduling.
//
// No `as any`, no `@ts-ignore`. The disposition switch is exhaustive
// over `FeedbackTriageLabel` at the type level.

import type { FeedbackTriageLabel, FeedbackType } from "@itotori/db";
import type { ManualFeedbackImportInput } from "../manual-feedback.js";

/**
 * What the loop does with a submission once the feedback repository has
 * assigned a triage label.
 *   - `repair_candidate` — an objective defect / glossary / runtime /
 *     asset issue with enough context to schedule a scoped repair.
 *   - `decision_queue`   — a style dispute. Becomes a `style` reviewer-
 *     queue item for a human decision; never auto-repaired.
 *   - `needs_context`    — the report lacks the context needed to route;
 *     it is parked (no queue item, no repair) until context arrives.
 */
export const DRAFT_FEEDBACK_DISPOSITIONS = [
  "repair_candidate",
  "decision_queue",
  "needs_context",
] as const;
export type DraftFeedbackDisposition = (typeof DRAFT_FEEDBACK_DISPOSITIONS)[number];

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
  disposition: DraftFeedbackDisposition;
  feedbackReportId: string;
  /** Bridge units this submission points at (from its line reference). */
  bridgeUnitIds: ReadonlyArray<string>;
  /** The reviewer's observed text / note — the "before" side. */
  observed: string;
  /** The reviewer's proposed correction — the "after" side, when given. */
  suggestedEdit?: string;
  duplicate: boolean;
};

/**
 * Result of submitting a batch. The report-id partitions let the
 * orchestrator drive the existing reviewer-queue / repair seams without
 * re-deriving which submission needs what.
 */
export type DraftFeedbackBatchResult = {
  batchId: string;
  batchLabel?: string;
  submittedCount: number;
  items: ReadonlyArray<DraftFeedbackBatchItem>;
  /** Feedback reports eligible for a scoped repair re-run (typos etc.). */
  repairCandidateReportIds: ReadonlyArray<string>;
  /** Feedback reports routed to the decision queue (style disputes). */
  decisionQueueReportIds: ReadonlyArray<string>;
  /** Union of every bridge unit named across the batch. */
  affectedBridgeUnitIds: ReadonlyArray<string>;
};
