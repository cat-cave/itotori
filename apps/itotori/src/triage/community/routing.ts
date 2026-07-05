// ITOTORI-120 — Metadata-aware feedback triage routing.
//
// The triage queue does NOT blindly accept every report. This module takes an
// `EnrichedFeedbackItem` (work identity + edition + language completeness +
// demand bucket + readiness + existing-translation, resolved from catalog
// metadata) and produces a DETERMINISTIC routing decision:
//
//   - `disposition` — the routing verdict, keyed on the enriched signals.
//   - `lane`        — which queue the item lands in (style path vs review queue
//                     vs backlog vs needs-context). A non-review lane means the
//                     item was NOT blindly accepted into human review.
//   - `accepted`    — whether the item is accepted into the human review queue.
//   - `priority`    — 0-100, driven by demand + severity + corroboration.
//   - `rationale`   — the signals the verdict is derived from.
//
// The rules are ordered and total; the same enriched item always yields the same
// decision. No model invocation, no randomness.

import { isLowFeedbackReadiness } from "./catalog-metadata.js";
import { type EnrichedFeedbackItem, feedbackEditionMatchValues } from "./enrichment.js";

export const feedbackTriageDispositionValues = {
  /** Style preference → the style-guide dispute path (not the objective-defect queue). */
  routeToStylePath: "route_to_style_path",
  /** Completed, high-demand edition → fast-tracked into review. */
  fastTrackHighDemand: "fast_track_high_demand",
  /** Normal accept into the review queue. */
  acceptForReview: "accept_for_review",
  /** Report against an edition with no translation → held in the backlog. */
  holdPendingTranslation: "hold_pending_translation",
  /** Engine adapter not ready to produce a fix → deferred. */
  deferLowReadiness: "defer_low_readiness",
  /** Report is against a different edition than the one we translated. */
  holdEditionMismatch: "hold_edition_mismatch",
  /** Work could not be resolved in the catalog → needs context. */
  holdUnresolvedWork: "hold_unresolved_work",
} as const;

export type FeedbackTriageDisposition =
  (typeof feedbackTriageDispositionValues)[keyof typeof feedbackTriageDispositionValues];

export const feedbackQueueLaneValues = {
  styleGuide: "style_guide",
  reviewerQueue: "reviewer_queue",
  backlog: "backlog",
  needsContext: "needs_context",
} as const;

export type FeedbackQueueLane =
  (typeof feedbackQueueLaneValues)[keyof typeof feedbackQueueLaneValues];

export type FeedbackTriageSignals = {
  styleDispute: boolean;
  editionMatch: EnrichedFeedbackItem["edition"]["match"];
  languageCompleteness: EnrichedFeedbackItem["languageCompleteness"];
  demandBucket: EnrichedFeedbackItem["demandBucket"];
  readinessLevel: EnrichedFeedbackItem["readinessLevel"];
  existingTranslationStatus: EnrichedFeedbackItem["existingTranslationStatus"];
};

export type FeedbackTriageDecision = {
  feedbackId: string;
  disposition: FeedbackTriageDisposition;
  lane: FeedbackQueueLane;
  /** True only when the item is accepted into the human review / style queue. */
  accepted: boolean;
  priority: number;
  rationale: string;
  signals: FeedbackTriageSignals;
};

/**
 * Route one enriched feedback item. Ordered rules; the FIRST matching rule wins.
 * The ordering encodes the triage policy:
 *
 *   1. unresolved work           → needs-context hold  (can't act without identity)
 *   2. style dispute             → style path          (never the objective-defect queue)
 *   3. edition mismatch          → needs-context hold  (report is about another edition)
 *   4. no translation exists     → backlog hold        (nothing to review yet)
 *   5. low adapter readiness     → backlog defer       (a fix can't be produced yet)
 *   6. completed + high demand   → review, fast-tracked
 *   7. otherwise                 → review, demand-scaled priority
 */
export function routeEnrichedFeedback(item: EnrichedFeedbackItem): FeedbackTriageDecision {
  const signals: FeedbackTriageSignals = {
    styleDispute: item.styleDispute,
    editionMatch: item.edition.match,
    languageCompleteness: item.languageCompleteness,
    demandBucket: item.demandBucket,
    readinessLevel: item.readinessLevel,
    existingTranslationStatus: item.existingTranslationStatus,
  };

  // 1. Work identity is a prerequisite for every catalog-keyed rule.
  if (item.resolution === "unresolved_work") {
    return decide(
      item,
      signals,
      feedbackTriageDispositionValues.holdUnresolvedWork,
      feedbackQueueLaneValues.needsContext,
      false,
      5,
      `work ${item.raw.workId} is not resolvable in the catalog; cannot route without work identity`,
    );
  }

  // 2. Style preferences are editorial, not defects — always the style path.
  if (item.styleDispute) {
    return decide(
      item,
      signals,
      feedbackTriageDispositionValues.routeToStylePath,
      feedbackQueueLaneValues.styleGuide,
      true,
      styleDisputePriority(item),
      "style-preference feedback routes to the style-guide dispute path",
    );
  }

  // 3. A report against a KNOWN-but-different edition, or an edition not in the
  //    catalog, is not about what we translated.
  if (
    item.edition.match === feedbackEditionMatchValues.differentEdition ||
    item.edition.match === feedbackEditionMatchValues.unknownEdition
  ) {
    return decide(
      item,
      signals,
      feedbackTriageDispositionValues.holdEditionMismatch,
      feedbackQueueLaneValues.needsContext,
      false,
      8,
      `report targets edition '${describeRequestedEdition(item)}' which is not the translated edition`,
    );
  }

  // 4. No translation exists for the reporter's language yet.
  if (
    item.existingTranslationStatus === "none" &&
    (item.languageCompleteness === "no_english" || item.languageCompleteness === null)
  ) {
    return decide(
      item,
      signals,
      feedbackTriageDispositionValues.holdPendingTranslation,
      feedbackQueueLaneValues.backlog,
      false,
      3,
      `no ${item.raw.targetLanguage} translation exists (existing_translation=none, completeness=${item.languageCompleteness ?? "unknown"}); backlog until a draft exists`,
    );
  }

  // 5. The engine adapter is not ready enough to produce a fix.
  if (item.readinessLevel !== null && isLowFeedbackReadiness(item.readinessLevel)) {
    return decide(
      item,
      signals,
      feedbackTriageDispositionValues.deferLowReadiness,
      feedbackQueueLaneValues.backlog,
      false,
      6,
      `adapter readiness '${item.readinessLevel}' is below extract-ready; a fix cannot be produced yet`,
    );
  }

  // 6. A completed, high-demand edition earns a fast-tracked review.
  if (
    item.existingTranslationStatus === "official_or_complete" &&
    (item.demandBucket === "high" || item.demandBucket === "very_high")
  ) {
    return decide(
      item,
      signals,
      feedbackTriageDispositionValues.fastTrackHighDemand,
      feedbackQueueLaneValues.reviewerQueue,
      true,
      fastTrackPriority(item),
      `completed translation on ${item.demandBucket}-demand work; fast-track into review`,
    );
  }

  // 7. Default: accept into review with a demand-scaled priority.
  return decide(
    item,
    signals,
    feedbackTriageDispositionValues.acceptForReview,
    feedbackQueueLaneValues.reviewerQueue,
    true,
    acceptPriority(item),
    `actionable report on a translated edition; accept into review (demand=${item.demandBucket ?? "unknown"})`,
  );
}

function decide(
  item: EnrichedFeedbackItem,
  signals: FeedbackTriageSignals,
  disposition: FeedbackTriageDisposition,
  lane: FeedbackQueueLane,
  accepted: boolean,
  priority: number,
  rationale: string,
): FeedbackTriageDecision {
  return {
    feedbackId: item.feedbackId,
    disposition,
    lane,
    accepted,
    priority: clampPriority(priority),
    rationale,
    signals,
  };
}

function demandBase(item: EnrichedFeedbackItem): number {
  switch (item.demandBucket) {
    case "very_high":
      return 90;
    case "high":
      return 75;
    case "medium":
      return 50;
    case "low":
      return 30;
    case "none":
      return 15;
    case null:
      return 20;
  }
}

/** Multiple corroborating reporters nudge priority up (bounded). */
function corroborationBonus(item: EnrichedFeedbackItem): number {
  const count = item.raw.reportCount ?? 1;
  if (count <= 1) {
    return 0;
  }
  return Math.min(10, (count - 1) * 2);
}

function acceptPriority(item: EnrichedFeedbackItem): number {
  return demandBase(item) + corroborationBonus(item);
}

function fastTrackPriority(item: EnrichedFeedbackItem): number {
  // Completed + high demand: start above the accept band.
  return demandBase(item) + corroborationBonus(item) + 5;
}

function styleDisputePriority(item: EnrichedFeedbackItem): number {
  // Style disputes are handled off the defect path; demand still orders them but
  // they sit below objective defects of comparable demand.
  return Math.round(demandBase(item) * 0.6) + corroborationBonus(item);
}

function describeRequestedEdition(item: EnrichedFeedbackItem): string {
  const requested = item.edition.requested;
  if (requested === null) {
    return "unspecified";
  }
  return requested.releaseId ?? requested.editionName ?? requested.platform ?? "unspecified";
}

function clampPriority(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 100) {
    return 100;
  }
  return Math.round(value);
}
