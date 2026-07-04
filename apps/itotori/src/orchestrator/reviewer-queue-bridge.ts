// itotori-loop-to-review-queue-bridge (pre-pilot #2).
//
// The agentic loop (`runAgenticLoopForUnit`) is persistence-pure: it chains
// every agentic stage and emits an `AgenticLoopBundle`, but historically it
// NEVER created a reviewer-queue item — so a driven run's `deferred_to_human`
// outcome (or a threshold-exceeding QA finding) produced a `deferredReason`
// string that no human ever saw. The automated pipeline and the HITL reviewer
// machinery were two separate universes.
//
// This module is the bridge. When the loop's outcome warrants human judgment it
// builds ONE `reviewer_queue_items` record (via the existing
// `ItotoriReviewerQueueRepository.createItem` — NOT a new queue) carrying the
// FULL decision context the product workflow mandates
// (docs/itotori-product-workflow.md §"Decision Queue Record Shape"):
//
//   - source     : source text / hash / revision / unit key / spans
//   - draft      : the current (accepted) or rejected draft text + status
//   - context    : the (now-real) structure-informed context artifact refs
//   - evidence   : the QA findings + deterministic violations that fired
//   - reasoning  : the loop's deferredReason + bounded-repair history
//   - options    : accept / reject / edit / defer / escalate
//
// The record is a CONTEXT-RICH decision, never a random-line review: if the
// loop could not assemble source+draft+context the product workflow says the
// item is `needs_context`, not `ready_for_human`.
//
// Idempotency: the reviewer-queue table has a UNIQUE index on
// (locale_branch_id, source_revision_id, item_kind, source_item_ref). The
// bridge derives a DETERMINISTIC `sourceItemRef` from the bridge unit, so
// re-running the SAME unit+revision collapses to the SAME row — a pre-check via
// `loadItemsByBranch` plus the repository's typed
// `reviewer_queue_item_duplicate` catch (the race backstop) means a re-run
// never duplicates. This mirrors `manual-feedback.ts`'s belt-and-suspenders.

import type {
  AuthorizationActor,
  CreateReviewerQueueItemInput,
  ItotoriReviewerQueueRepositoryPort,
  ReviewerQueueItemRecord,
} from "@itotori/db";
import { ReviewerQueueRepositoryError, reviewerQueueItemKindValues } from "@itotori/db";
import type {
  AgenticLoopBundle,
  LocalizationUnitV02,
  QaFinding,
  QaFindingSeverity,
} from "@itotori/localization-bridge-schema";
import type { DraftProtectedSpanViolation } from "../draft/protected-span-validator.js";

/**
 * Severity floor at/above which a QA finding warrants human review even when
 * the loop otherwise accepted (or repaired-then-accepted) the draft. `minor`
 * and `info` findings stay in the automated lane; `critical` and `major`
 * findings reach a human. Widening this set is an explicit editorial decision,
 * not a silent default.
 */
export const AGENTIC_LOOP_REVIEW_SEVERITY_FLOOR: ReadonlySet<QaFindingSeverity> =
  new Set<QaFindingSeverity>(["critical", "major"]);

/** Product-workflow decision-record schema tag embedded in the queue payload. */
export const AGENTIC_LOOP_DECISION_RECORD_SCHEMA_VERSION =
  "itotori.agentic-loop-decision-record.v1" as const;

/**
 * The reviewer-queue write surface the bridge needs. Deliberately narrowed to
 * `createItem` + `loadItemsByBranch` (the idempotency pre-check) so a driven
 * run wires the real `ItotoriReviewerQueueRepository` and tests wire an
 * in-memory fake without dragging the full action/transition surface along.
 */
export type AgenticLoopReviewerQueueSink = {
  repository: Pick<ItotoriReviewerQueueRepositoryPort, "createItem" | "loadItemsByBranch">;
};

/**
 * Everything the bridge needs from one `runAgenticLoopForUnit` pass. The loop
 * assembles this from its own internal state (findings, violations, draft,
 * context refs) at finalization — the `AgenticLoopBundle` alone does NOT expose
 * the individual findings/violations, so they are threaded here explicitly.
 */
export type AgenticLoopBridgeInput = {
  actor: AuthorizationActor;
  sink: AgenticLoopReviewerQueueSink;
  bundle: AgenticLoopBundle;
  unit: LocalizationUnitV02;
  /**
   * The current (accepted) or REJECTED draft text. Carried even on a
   * `deferred_to_human` outcome so the reviewer sees what the loop produced and
   * why it was held — a defer with no visible draft would be a random-line
   * review, which the product workflow forbids.
   */
  draftText?: string | undefined;
  /** The loop's reasoning string when it deferred (repair-budget / P0 / critical). */
  deferredReason?: string | undefined;
  qaFindings: ReadonlyArray<QaFinding>;
  deterministicViolations: ReadonlyArray<DraftProtectedSpanViolation>;
  /** Citable context artifact refs (structure slice + live semantic enrichment). */
  contextArtifactRefs: ReadonlyArray<string>;
  /** The scene id the unit belongs to, when a decoded structure drove the run. */
  sceneId?: number | undefined;
  /** Deterministic clock seam so a driven run + tests get stable createdAt. */
  now?: (() => Date) | undefined;
};

/**
 * True when the loop's outcome warrants a human decision:
 *   - the loop deferred (`deferred_to_human` / `short_circuit_deterministic_p0`),
 *     OR
 *   - a QA finding is at/above the review severity floor even though the draft
 *     was otherwise accepted (an accepted draft can still carry a major finding
 *     that merits a human glance).
 * A clean run (accepted, no floor-crossing finding) warrants NOTHING.
 */
export function agenticLoopWarrantsReviewerQueueItem(input: {
  bundle: AgenticLoopBundle;
  qaFindings: ReadonlyArray<QaFinding>;
}): boolean {
  const outcome = input.bundle.routingSummary.outcome;
  if (outcome === "deferred_to_human" || outcome === "short_circuit_deterministic_p0") {
    return true;
  }
  return input.qaFindings.some((finding) =>
    AGENTIC_LOOP_REVIEW_SEVERITY_FLOOR.has(finding.severity),
  );
}

/**
 * Stable, deterministic `sourceItemRef` for a loop-produced decision. Combined
 * with (locale_branch_id, source_revision_id, item_kind) this is the queue's
 * idempotency key: the SAME unit+revision always maps to the SAME row.
 */
export function agenticLoopDecisionSourceItemRef(unit: LocalizationUnitV02): string {
  return `agentic-loop:${unit.bridgeUnitId}`;
}

function agenticLoopDecisionId(unit: LocalizationUnitV02): string {
  return `decision-agentic-loop-${unit.bridgeUnitId}`;
}

/**
 * Build the product-workflow decision record + the `createItem` input from a
 * finished loop pass. Pure — no I/O — so it is independently testable and the
 * persist step stays a thin wrapper. The rich decision record lives on
 * `payload.decisionRecord`; `metadata` carries the display keys the reviewer
 * dashboard reads (`decisionId`, `findingId`) plus provenance.
 */
export function buildAgenticLoopReviewerQueueItemInput(
  input: AgenticLoopBridgeInput,
): CreateReviewerQueueItemInput {
  const { bundle, unit } = input;
  const outcome = bundle.routingSummary.outcome;
  const deferred = outcome === "deferred_to_human" || outcome === "short_circuit_deterministic_p0";
  const flaggedFindings = input.qaFindings.filter((finding) =>
    AGENTIC_LOOP_REVIEW_SEVERITY_FLOOR.has(finding.severity),
  );

  const decisionId = agenticLoopDecisionId(unit);
  const sourceItemRef = agenticLoopDecisionSourceItemRef(unit);
  const hasDraft = typeof input.draftText === "string" && input.draftText.length > 0;

  const reasoningSummary =
    input.deferredReason !== undefined
      ? input.deferredReason
      : `${flaggedFindings.length} QA finding(s) at/above the review severity floor`;

  const summary = deferred
    ? `Agentic loop deferred ${unit.sourceUnitKey}: ${reasoningSummary}`
    : `Agentic loop flagged ${unit.sourceUnitKey}: ${reasoningSummary}`;

  const repairStage = bundle.stages.find((stage) => stage.stageName === "repair");

  const decisionType = deferred ? "deferred_translation_review" : "qa_finding_review";

  // Product-workflow "Decision Queue Record Shape". Field names track the doc;
  // this carries source / draft / context / evidence / reasoning / options so
  // the reviewer never judges an isolated line.
  const decisionRecord: Record<string, unknown> = {
    schemaVersion: AGENTIC_LOOP_DECISION_RECORD_SCHEMA_VERSION,
    decisionId,
    projectId: bundle.projectId,
    localeBranchId: bundle.localeBranchId,
    targetLocale: bundle.targetLocale,
    // Full context is present, so this is a real human decision, not needs_context.
    state: "ready_for_human",
    decisionType,
    outcome,
    source: {
      bridgeUnitId: unit.bridgeUnitId,
      surfaceKind: unit.surfaceKind,
      sourceUnitKey: unit.sourceUnitKey,
      occurrenceId: unit.occurrenceId,
      sourceLocale: unit.sourceLocale,
      sourceText: unit.sourceText,
      sourceHash: unit.sourceHash,
      sourceRevision: unit.sourceRevision,
      sourceLocation: unit.sourceLocation,
      spans: unit.spans,
    },
    draft: {
      // The current or rejected draft the loop produced (null when the loop
      // deferred before any draft survived, e.g. a P0 short-circuit).
      draftText: hasDraft ? input.draftText : null,
      draftStatus: deferred
        ? hasDraft
          ? "deferred_with_draft"
          : "deferred_no_draft"
        : "qa_flagged",
      targetLocale: bundle.targetLocale,
      localeBranchId: bundle.localeBranchId,
    },
    context: {
      contextArtifactRefs: [...input.contextArtifactRefs],
      ...(input.sceneId !== undefined ? { sceneId: input.sceneId } : {}),
    },
    // Reasoning + findings — the evidence the reviewer weighs.
    reasoningAndFindings: {
      summary: reasoningSummary,
      ...(input.deferredReason !== undefined ? { deferredReason: input.deferredReason } : {}),
      qaFindings: input.qaFindings.map((finding) => ({
        findingId: finding.findingId,
        bridgeUnitId: finding.bridgeUnitId,
        severity: finding.severity,
        category: finding.category,
        recommendation: finding.recommendation,
        agentRationale: finding.agentRationale,
        evidenceRefs: finding.evidenceRefs,
        ...(finding.sourceSpan !== undefined ? { sourceSpan: finding.sourceSpan } : {}),
        ...(finding.draftSpan !== undefined ? { draftSpan: finding.draftSpan } : {}),
      })),
      deterministicViolations: input.deterministicViolations.map((violation) => ({
        kind: violation.kind,
        spanRefId: violation.spanRefId,
        spanKind: violation.spanKind,
        bridgeUnitId: violation.bridgeUnitId,
        detail: violation.detail,
      })),
      criticalFindingCount: bundle.routingSummary.criticalFindingCount,
      routedFindingCount: bundle.routingSummary.routedFindingCount,
      repairHistory: {
        repairStageOutcome: repairStage?.outcome ?? "absent",
        repairAttempts: bundle.routingSummary.repairAttempts,
        maxRepairAttempts: bundle.routingSummary.maxRepairAttempts,
      },
    },
    impact: {
      surfaceKind: unit.surfaceKind,
      deferred,
      flaggedFindingCount: flaggedFindings.length,
    },
    // Decision OPTIONS the reviewer chooses between. `action` maps each option
    // to the reviewer-queue action taxonomy the `qa` item kind supports
    // (approve / reject / request_repair / defer / escalate).
    options: [
      {
        optionId: "accept",
        label: "Accept the draft",
        action: "approve",
        consequence: "Marks the draft accepted and patch-ready for this unit.",
      },
      {
        optionId: "reject",
        label: "Reject the draft",
        action: "reject",
        consequence: "Marks the draft rejected; the unit needs a fresh draft.",
      },
      {
        optionId: "edit",
        label: "Send back for a repaired re-draft",
        action: "request_repair",
        consequence: "Re-queues the unit for the agentic loop with reviewer guidance.",
      },
      {
        optionId: "defer",
        label: "Defer this decision",
        action: "defer",
        consequence: "Keeps the unit blocked for export until revisited.",
      },
      {
        optionId: "escalate",
        label: "Escalate for senior review",
        action: "escalate",
        consequence: "Routes the decision to a senior reviewer.",
      },
    ],
  };

  const firstFindingId = input.qaFindings[0]?.findingId;
  const affectedArtifactIds = [
    unit.bridgeUnitId,
    ...input.contextArtifactRefs,
    ...input.qaFindings.map((finding) => `qa-finding:${finding.findingId}`),
  ];

  const createInput: CreateReviewerQueueItemInput = {
    projectId: bundle.projectId,
    localeBranchId: bundle.localeBranchId,
    sourceRevisionId: unit.sourceRevision.revisionId,
    itemKind: reviewerQueueItemKindValues.qa,
    sourceItemRef,
    summary,
    affectedArtifactIds,
    priority: deferred ? 10 : 5,
    payload: {
      source: "agentic_loop",
      decisionId,
      outcome,
      decisionRecord,
    },
    metadata: {
      source: "agentic_loop",
      decisionId,
      ...(firstFindingId !== undefined ? { findingId: firstFindingId } : {}),
      outcome,
      affectedUnitIds: [unit.bridgeUnitId],
    },
    createdByUserId: input.actor.userId,
    ...(input.now !== undefined ? { createdAt: input.now() } : {}),
  };
  return createInput;
}

/**
 * Bridge a finished agentic-loop pass into the reviewer queue. Returns the
 * created item, or `null` when the outcome warrants no human decision OR an
 * equivalent item already exists (idempotent re-run). This is the DEFAULT loop
 * path: a driven run wires the sink and every deferral / threshold-finding
 * lands here automatically — no fixture or manual step required.
 */
export async function bridgeAgenticLoopToReviewerQueue(
  input: AgenticLoopBridgeInput,
): Promise<ReviewerQueueItemRecord | null> {
  if (
    !agenticLoopWarrantsReviewerQueueItem({ bundle: input.bundle, qaFindings: input.qaFindings })
  ) {
    return null;
  }

  const createInput = buildAgenticLoopReviewerQueueItemInput(input);

  // Idempotency pre-check (mirrors manual-feedback.ts): if an equivalent item
  // already exists for this unit+revision, do not create a second one. The
  // unique-constraint catch below is the race backstop when two runs interleave.
  const existing = await input.sink.repository.loadItemsByBranch(
    input.actor,
    createInput.localeBranchId,
  );
  const alreadyQueued = existing.some(
    (item) =>
      item.sourceItemRef === createInput.sourceItemRef &&
      item.sourceRevisionId === createInput.sourceRevisionId &&
      item.itemKind === createInput.itemKind,
  );
  if (alreadyQueued) {
    return null;
  }

  try {
    return await input.sink.repository.createItem(input.actor, createInput);
  } catch (error) {
    if (
      error instanceof ReviewerQueueRepositoryError &&
      error.code === "reviewer_queue_item_duplicate"
    ) {
      return null;
    }
    throw error;
  }
}
