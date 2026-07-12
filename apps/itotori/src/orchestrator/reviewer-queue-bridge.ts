// itotori-loop-to-review-queue-bridge (pre-pilot #2).
//
// The agentic loop (`runAgenticLoopForUnit`) is persistence-pure: it chains
// every agentic stage and emits an `AgenticLoopBundle`, but historically it
// used the queue as a sink for withheld drafts. It now carries only
// threshold-crossing QA callouts on an already-written candidate. The automated
// pipeline and the legacy reviewer machinery remain separate universes.
//
// This module is the bridge. When the loop's annotations warrant a callout it
// builds ONE `reviewer_queue_items` record (via the existing
// `ItotoriReviewerQueueRepository.createItem` — NOT a new queue) carrying the
// FULL decision context the product workflow mandates
// (docs/itotori-product-workflow.md §"Decision Queue Record Shape"):
//
//   - source     : source text / hash / revision / unit key / spans
//   - draft      : the selected written draft text + status
//   - context    : the (now-real) structure-informed context artifact refs
//   - evidence   : the QA findings + deterministic violations that fired
//   - reasoning  : informational QA flags + bounded-repair history
//   - options    : informational callout only
//
// The record is a CONTEXT-RICH decision, never a random-line review: if the
// loop could not assemble source+draft+context the product workflow says the
// item is `needs_context`, not `ready_for_human`.
//
// Idempotency: the reviewer-queue table has a UNIQUE index on
// (locale_branch_id, source_revision_id, item_kind, source_item_ref). The
// bridge keys the row to the run/bundle-level source revision and derives a
// DETERMINISTIC `sourceItemRef` from the individual bridge unit, so re-running
// the SAME unit within that revision collapses to the SAME row — a pre-check via
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
import type { StructuredContextInjection } from "../agents/structure-informed-context/shapes.js";
import { structuredContextForDecisionRecord } from "../reviewer/structure-context-feed.js";

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
 * assembles this from its own internal state (findings, violations, context
 * refs) at finalization — raw QA evidence is threaded here explicitly while
 * the bundle owns the selected written candidate.
 */
export type AgenticLoopBridgeInput = {
  actor: AuthorizationActor;
  sink: AgenticLoopReviewerQueueSink;
  bundle: AgenticLoopBundle;
  unit: LocalizationUnitV02;
  /**
   * Run/bundle-level source revision id — the id `ensureRunProjectScope`
   * registers and every other bridge FKs to. This is NOT the per-unit
   * content-hash id in `unit.sourceRevision.revisionId`.
   */
  sourceRevisionId: string;
  qaFindings: ReadonlyArray<QaFinding>;
  deterministicViolations: ReadonlyArray<DraftProtectedSpanViolation>;
  /** Citable context artifact refs (structure slice + live semantic enrichment). */
  contextArtifactRefs: ReadonlyArray<string>;
  /** Citation refs selected by the draft the reviewer sees. */
  citationRefs: ReadonlyArray<string>;
  /**
   * wiki-structure-context-feed — the exact structure-informed injection the
   * translate stage consumed (scene summary + route position + character arcs).
   * Stored on the decision record so the reviewer detail UI can show WHY the
   * draft chose its wording without re-deriving structure at read time.
   */
  structuredContext?: StructuredContextInjection | undefined;
  /** The scene id the unit belongs to, when a decoded structure drove the run. */
  sceneId?: number | undefined;
  /** Deterministic clock seam so a driven run + tests get stable createdAt. */
  now?: (() => Date) | undefined;
};

/**
 * True when permanent QA annotations warrant an optional human callout. A
 * clean written outcome warrants nothing; quality never controls coverage.
 */
export function agenticLoopWarrantsReviewerQueueItem(input: {
  bundle: AgenticLoopBundle;
  qaFindings: ReadonlyArray<QaFinding>;
}): boolean {
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
  const outcome = bundle.writtenOutcome.status;
  const flaggedFindings = input.qaFindings.filter((finding) =>
    AGENTIC_LOOP_REVIEW_SEVERITY_FLOOR.has(finding.severity),
  );
  const selectedCandidate = bundle.writtenOutcome.candidates.find(
    (candidate) => candidate.id === bundle.writtenOutcome.selectedCandidateId,
  );
  if (selectedCandidate === undefined) {
    throw new Error(
      `reviewer-queue bridge refused: written outcome for ${unit.bridgeUnitId} has no selected candidate`,
    );
  }

  const decisionId = agenticLoopDecisionId(unit);
  const sourceItemRef = agenticLoopDecisionSourceItemRef(unit);
  const qualityFlags = bundle.writtenOutcome.qualityFlags;
  const reasoningSummary = `${flaggedFindings.length} QA finding(s) at/above the review severity floor`;
  const summary = `Agentic loop QA callout for ${unit.sourceUnitKey}: ${reasoningSummary}`;

  const repairStage = bundle.stages.find((stage) => stage.stageName === "repair");

  // Product-workflow "Decision Queue Record Shape". Field names track the doc;
  // this carries source / selected draft / context / evidence / annotations so
  // the reviewer never judges an isolated line or controls coverage.
  const decisionRecord: Record<string, unknown> = {
    schemaVersion: AGENTIC_LOOP_DECISION_RECORD_SCHEMA_VERSION,
    decisionId,
    projectId: bundle.projectId,
    localeBranchId: bundle.localeBranchId,
    targetLocale: bundle.targetLocale,
    // Full context is present, so this is a real human decision, not needs_context.
    state: "ready_for_human",
    decisionType: "qa_finding_review",
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
      draftText: selectedCandidate.body,
      draftStatus: "written_with_qa_callout",
      targetLocale: bundle.targetLocale,
      localeBranchId: bundle.localeBranchId,
    },
    context: {
      contextArtifactRefs: [...input.contextArtifactRefs],
      citationRefs: [...input.citationRefs],
      ...(input.sceneId !== undefined ? { sceneId: input.sceneId } : {}),
      // wiki-structure-context-feed — persist the structure-informed injection
      // texts the translate stage actually rendered into the prompt so the
      // reviewer can see the same scene summary / character arcs / route map
      // that fed the draft wording.
      ...(input.structuredContext !== undefined
        ? {
            structuredContext: structuredContextForDecisionRecord(input.structuredContext),
          }
        : {}),
    },
    // Reasoning + findings — the evidence the reviewer weighs.
    reasoningAndFindings: {
      summary: reasoningSummary,
      qualityFlags,
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
      criticalFindingCount: input.qaFindings.filter((finding) => finding.severity === "critical")
        .length,
      routedFindingCount: input.qaFindings.length,
      repairHistory: {
        repairStageOutcome: repairStage?.outcome ?? "absent",
      },
    },
    impact: {
      surfaceKind: unit.surfaceKind,
      written: true,
      flaggedFindingCount: flaggedFindings.length,
    },
    // This retained bridge is notification-only. It deliberately exposes no
    // action that can erase the selected text or make QA a release gate.
    options: [
      {
        optionId: "inspect",
        label: "Inspect QA callout",
        action: "approve",
        consequence: "Leaves the written draft and configured patch coverage unchanged.",
      },
    ],
  };

  const firstFindingId = input.qaFindings[0]?.findingId;
  const affectedArtifactIds = [
    unit.bridgeUnitId,
    ...input.contextArtifactRefs,
    ...input.citationRefs,
    ...input.qaFindings.map((finding) => `qa-finding:${finding.findingId}`),
  ];

  const createInput: CreateReviewerQueueItemInput = {
    projectId: bundle.projectId,
    localeBranchId: bundle.localeBranchId,
    sourceRevisionId: input.sourceRevisionId,
    itemKind: reviewerQueueItemKindValues.qa,
    sourceItemRef,
    summary,
    affectedArtifactIds,
    priority: 5,
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
 * created item, or `null` when no annotation warrants a callout OR an
 * equivalent item already exists (idempotent re-run). This is the DEFAULT loop
 * path: a driven run wires the sink and every threshold finding lands here
 * automatically — no fixture or manual step required.
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
