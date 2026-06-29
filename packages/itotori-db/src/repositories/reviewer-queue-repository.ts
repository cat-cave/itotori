// ITOTORI-081 — Reviewer queue repository.
//
// Persists `ReviewerQueueItem` rows and the append-only transition log.
// Every action checks `queue.manage` (write) or `queue.read` (read)
// before mutating any state, per SHARED-013 / SHARED-014. State
// transitions write the item row and the transition log atomically in
// a single DB transaction so a partial write is impossible: invalid /
// stale / denied actions return a semantic diagnostic, never half-apply.
//
// Runtime-evidence items carry Utsushi `evidenceTier`,
// `observationEventIds`, and `artifactHashes` verbatim through every
// transition; the SQL discriminant check on the items table guards that
// invariant at the database layer (audit focus: "Runtime evidence
// feedback losing evidence tier").

import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { ItotoriDatabase } from "../connection.js";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import {
  ItotoriEventQueueRepository,
  type JobQueueInput,
  type JobQueueRecord,
  type QueueSqlExecutor,
} from "./event-queue-repository.js";
import {
  reviewerQueueActionValues,
  reviewerQueueItemKindValues,
  reviewerQueueItemStateValues,
  reviewerQueueItems,
  reviewerQueueTransitions,
  type ReviewerQueueAction,
  type ReviewerQueueDiagnostic,
  type ReviewerQueueItemKind,
  type ReviewerQueueItemRecord,
  type ReviewerQueueItemState,
  type ReviewerQueueTransitionRecord,
} from "../schema.js";

export const reviewerQueueItemKindList: ReadonlyArray<ReviewerQueueItemKind> = [
  reviewerQueueItemKindValues.qa,
  reviewerQueueItemKindValues.style,
  reviewerQueueItemKindValues.glossary,
  reviewerQueueItemKindValues.feedback,
  reviewerQueueItemKindValues.runtimeEvidence,
];

export const reviewerQueueItemStateList: ReadonlyArray<ReviewerQueueItemState> = [
  reviewerQueueItemStateValues.pending,
  reviewerQueueItemStateValues.inReview,
  reviewerQueueItemStateValues.accepted,
  reviewerQueueItemStateValues.rejected,
  reviewerQueueItemStateValues.repairRequested,
  reviewerQueueItemStateValues.deferred,
  reviewerQueueItemStateValues.escalated,
];

export const reviewerQueueActionList: ReadonlyArray<ReviewerQueueAction> = [
  reviewerQueueActionValues.approve,
  reviewerQueueActionValues.reject,
  reviewerQueueActionValues.defer,
  reviewerQueueActionValues.escalate,
  reviewerQueueActionValues.requestRepair,
  reviewerQueueActionValues.updateGlossary,
  reviewerQueueActionValues.updateStyle,
  reviewerQueueActionValues.importRuntimeFeedback,
];

/**
 * Closed taxonomy of reasons the repository refuses to mutate state.
 * The orchestrator surfaces each code as a typed diagnostic; the
 * dashboard renders the message verbatim. No code carries silent
 * failures — every refusal also carries the prior state so the caller
 * can re-render the queue without a re-fetch.
 */
export const reviewerQueueRepositoryErrorCodes = [
  "reviewer_queue_item_not_found",
  "reviewer_queue_item_invalid_input",
  "reviewer_queue_item_invalid_transition",
  "reviewer_queue_item_concurrent_modification",
  "reviewer_queue_item_stale_revision",
  "reviewer_queue_item_stale_lease",
  "reviewer_queue_item_duplicate",
  "reviewer_queue_item_runtime_evidence_invariant",
] as const;

export type ReviewerQueueRepositoryErrorCode = (typeof reviewerQueueRepositoryErrorCodes)[number];

export class ReviewerQueueRepositoryError extends Error {
  constructor(
    readonly code: ReviewerQueueRepositoryErrorCode,
    message: string,
    readonly diagnostics: ReviewerQueueDiagnostic[] = [],
  ) {
    super(message);
    this.name = "ReviewerQueueRepositoryError";
  }
}

/**
 * Input for `createItem`. Runtime-evidence items MUST supply
 * `evidenceTier`, `observationEventIds`, and `artifactHashes`; other
 * kinds MUST NOT (the discriminant is enforced both here and in SQL).
 */
export type CreateReviewerQueueItemInput = {
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  itemKind: ReviewerQueueItemKind;
  sourceItemRef: string;
  summary: string;
  affectedArtifactIds?: string[];
  priority?: number;
  evidenceTier?: string;
  observationEventIds?: string[];
  artifactHashes?: string[];
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  createdByUserId?: string | null;
  assignedToUserId?: string | null;
  createdAt?: Date;
};

/**
 * Input for any reviewer action. The caller passes the action's
 * `expectedSourceRevisionId` so the repository can detect stale-source
 * decisions (reviewer acted on a revision that has since been
 * superseded). The repository returns the persisted item + transition
 * row pair so the caller does not need a second round-trip.
 */
export type ReviewerQueueActionInput = {
  reviewItemId: string;
  action: ReviewerQueueAction;
  actorUserId: string;
  expectedSourceRevisionId: string;
  expectedLeaseId?: string;
  affectedArtifactIds?: string[];
  diagnostics?: ReviewerQueueDiagnostic[];
  metadata?: Record<string, unknown>;
  /**
   * Optional override of the next state. The default per-action
   * mapping is documented on `reviewerQueueActionToNextState`. The override is
   * only honored for the `approve` and `reject` actions for the
   * glossary / style guide kinds, which may collapse to `accepted`
   * via either path.
   */
  forcedNextState?: ReviewerQueueItemState;
  at?: Date;
};

export type ReviewerQueueActionResult = {
  item: ReviewerQueueItemRecord;
  transition: ReviewerQueueTransitionRecord;
};

export type ReviewerQueueActionJobPlanner = (
  result: ReviewerQueueActionResult,
) => readonly JobQueueInput[] | Promise<readonly JobQueueInput[]>;

export type ReviewerQueueActionAndJobsResult = {
  actionResult: ReviewerQueueActionResult;
  jobs: JobQueueRecord[];
};

export type ReviewerQueueBatchActionAndJobsResult = {
  actionResults: ReviewerQueueActionResult[];
  jobs: JobQueueRecord[];
};

export type LoadReviewerQueueItemsOptions = {
  stateFilter?: ReviewerQueueItemState;
  kindFilter?: ReviewerQueueItemKind;
};

export interface ItotoriReviewerQueueRepositoryPort {
  createItem(
    actor: AuthorizationActor,
    input: CreateReviewerQueueItemInput,
  ): Promise<ReviewerQueueItemRecord>;
  applyAction(
    actor: AuthorizationActor,
    input: ReviewerQueueActionInput,
  ): Promise<ReviewerQueueActionResult>;
  applyActionAndEnqueueJobs(
    actor: AuthorizationActor,
    input: ReviewerQueueActionInput,
    planJobs: ReviewerQueueActionJobPlanner,
  ): Promise<ReviewerQueueActionAndJobsResult>;
  applyActionsAndEnqueueJobs(
    actor: AuthorizationActor,
    inputs: readonly ReviewerQueueActionInput[],
    planJobs: ReviewerQueueActionJobPlanner,
  ): Promise<ReviewerQueueBatchActionAndJobsResult>;
  getItem(actor: AuthorizationActor, reviewItemId: string): Promise<ReviewerQueueItemRecord | null>;
  loadItemsByBranch(
    actor: AuthorizationActor,
    localeBranchId: string,
    opts?: LoadReviewerQueueItemsOptions,
  ): Promise<ReviewerQueueItemRecord[]>;
  loadTransitionsByItem(
    actor: AuthorizationActor,
    reviewItemId: string,
  ): Promise<ReviewerQueueTransitionRecord[]>;
}

/**
 * Allowed prior → next state edges. Reviewer actions outside this set
 * return `reviewer_queue_item_invalid_transition`; the repository
 * surfaces both the prior and the requested next state in the
 * diagnostic message so the dashboard can render a precise error.
 *
 * Exported so the ITOTORI-083 batch consequence-preview service and the
 * repository's `applyAction` share the SAME transition validator — the
 * preview must never disagree with execution (audit focus: "Consequence
 * preview disagreeing with execution").
 *
 * Two edges are INTENTIONALLY absent (audit focus 15cc5e0b-…: "Allowed-
 * transition graph silently drops repair_requested -> in_review and
 * in_review -> pending"). They are by-design omissions, not oversights;
 * the validator rejects them with an explicit, typed
 * `reviewer_queue_item_invalid_transition` diagnostic (never a silent
 * drop). The reachability they would provide already exists via the
 * documented two-hop paths below, so adding the direct edges would only
 * let a reviewer skip an auditable step:
 *
 *   - `repair_requested -> in_review` is omitted because repair re-runs
 *     follow a RE-QUEUE model, not an auto-reassign model. When the
 *     agentic loop finishes a requested repair the item re-enters the
 *     UNCLAIMED pool via `repair_requested -> pending`; it is not handed
 *     back to whichever reviewer last held it. A reviewer reaches review
 *     again only by re-claiming through the normal `pending -> in_review`
 *     edge, so the re-claim is recorded as a fresh claim.
 *
 *   - `in_review -> pending` (a silent "un-claim") is omitted because
 *     every state change is an auditable reviewer action recorded in the
 *     append-only transition log; reverting straight to `pending` would
 *     erase the fact that the item was ever claimed. A reviewer who needs
 *     to RELEASE a claimed item does so with the `defer` action
 *     (`in_review -> deferred`), and the deferred item reopens into the
 *     pending pool via `deferred -> pending`. So a release path DOES
 *     exist (contrary to the original finding's "no path other than
 *     escalate/accept/reject") — it is just routed through the auditable
 *     `deferred` state rather than a silent revert.
 */
export const reviewerQueueAllowedTransitions: ReadonlyArray<
  readonly [ReviewerQueueItemState, ReviewerQueueItemState]
> = [
  [reviewerQueueItemStateValues.pending, reviewerQueueItemStateValues.inReview],
  [reviewerQueueItemStateValues.pending, reviewerQueueItemStateValues.accepted],
  [reviewerQueueItemStateValues.pending, reviewerQueueItemStateValues.rejected],
  [reviewerQueueItemStateValues.pending, reviewerQueueItemStateValues.repairRequested],
  [reviewerQueueItemStateValues.pending, reviewerQueueItemStateValues.deferred],
  [reviewerQueueItemStateValues.pending, reviewerQueueItemStateValues.escalated],
  [reviewerQueueItemStateValues.inReview, reviewerQueueItemStateValues.accepted],
  [reviewerQueueItemStateValues.inReview, reviewerQueueItemStateValues.rejected],
  [reviewerQueueItemStateValues.inReview, reviewerQueueItemStateValues.repairRequested],
  [reviewerQueueItemStateValues.inReview, reviewerQueueItemStateValues.deferred],
  [reviewerQueueItemStateValues.inReview, reviewerQueueItemStateValues.escalated],
  [reviewerQueueItemStateValues.repairRequested, reviewerQueueItemStateValues.pending],
  [reviewerQueueItemStateValues.repairRequested, reviewerQueueItemStateValues.accepted],
  [reviewerQueueItemStateValues.repairRequested, reviewerQueueItemStateValues.rejected],
  [reviewerQueueItemStateValues.deferred, reviewerQueueItemStateValues.pending],
  [reviewerQueueItemStateValues.deferred, reviewerQueueItemStateValues.accepted],
  [reviewerQueueItemStateValues.deferred, reviewerQueueItemStateValues.rejected],
  [reviewerQueueItemStateValues.deferred, reviewerQueueItemStateValues.escalated],
  [reviewerQueueItemStateValues.escalated, reviewerQueueItemStateValues.accepted],
  [reviewerQueueItemStateValues.escalated, reviewerQueueItemStateValues.rejected],
];

const allowedTransitionSet = new Set(
  reviewerQueueAllowedTransitions.map(([prior, next]) => `${prior}→${next}`),
);

/**
 * Default action → next-state mapping. The repository uses these
 * unless the caller supplies a `forcedNextState` override. Exported so
 * the ITOTORI-083 batch preview reads the SAME mapping (audit focus).
 */
export const reviewerQueueActionToNextState: Readonly<
  Record<ReviewerQueueAction, ReviewerQueueItemState>
> = {
  [reviewerQueueActionValues.approve]: reviewerQueueItemStateValues.accepted,
  [reviewerQueueActionValues.reject]: reviewerQueueItemStateValues.rejected,
  [reviewerQueueActionValues.defer]: reviewerQueueItemStateValues.deferred,
  [reviewerQueueActionValues.escalate]: reviewerQueueItemStateValues.escalated,
  [reviewerQueueActionValues.requestRepair]: reviewerQueueItemStateValues.repairRequested,
  [reviewerQueueActionValues.updateGlossary]: reviewerQueueItemStateValues.accepted,
  [reviewerQueueActionValues.updateStyle]: reviewerQueueItemStateValues.accepted,
  [reviewerQueueActionValues.importRuntimeFeedback]: reviewerQueueItemStateValues.accepted,
};

/**
 * Each action is only valid for a subset of item kinds. Mixing an
 * action with the wrong kind (e.g. `updateGlossary` on a runtime
 * evidence item) returns `reviewer_queue_item_invalid_input` before any
 * SQL fires. Exported so the ITOTORI-083 batch preview reads the SAME
 * mapping (audit focus).
 */
export const reviewerQueueActionAllowedKinds: Readonly<
  Record<ReviewerQueueAction, ReadonlyArray<ReviewerQueueItemKind>>
> = {
  [reviewerQueueActionValues.approve]: reviewerQueueItemKindList,
  [reviewerQueueActionValues.reject]: reviewerQueueItemKindList,
  [reviewerQueueActionValues.defer]: reviewerQueueItemKindList,
  [reviewerQueueActionValues.escalate]: reviewerQueueItemKindList,
  [reviewerQueueActionValues.requestRepair]: [
    reviewerQueueItemKindValues.qa,
    reviewerQueueItemKindValues.runtimeEvidence,
    reviewerQueueItemKindValues.feedback,
  ],
  [reviewerQueueActionValues.updateGlossary]: [reviewerQueueItemKindValues.glossary],
  [reviewerQueueActionValues.updateStyle]: [reviewerQueueItemKindValues.style],
  [reviewerQueueActionValues.importRuntimeFeedback]: [
    reviewerQueueItemKindValues.runtimeEvidence,
    reviewerQueueItemKindValues.feedback,
  ],
};

/**
 * Pure transition validator shared by `ItotoriReviewerQueueRepository.applyAction`
 * (execution path) and the ITOTORI-083 batch consequence preview service.
 * Same input → same diagnostic; the preview never disagrees with execution.
 *
 * Returns `{ ok: true, nextState }` when the action is allowed for the
 * item kind, the expected source revision matches the item, and the
 * (prior → next) edge is in `reviewerQueueAllowedTransitions`. Otherwise
 * returns `{ ok: false, code, message, diagnostics? }` matching the
 * exact error shape `applyAction` would have thrown.
 */
export type ReviewerQueueTransitionValidation =
  | {
      ok: true;
      action: ReviewerQueueAction;
      priorState: ReviewerQueueItemState;
      nextState: ReviewerQueueItemState;
    }
  | {
      ok: false;
      code: ReviewerQueueRepositoryErrorCode;
      message: string;
      diagnostics: ReviewerQueueDiagnostic[];
    };

export function validateReviewerQueueTransition(args: {
  item: ReviewerQueueItemRecord;
  action: ReviewerQueueAction;
  expectedSourceRevisionId: string;
  forcedNextState?: ReviewerQueueItemState;
}): ReviewerQueueTransitionValidation {
  const allowedKinds = reviewerQueueActionAllowedKinds[args.action];
  if (!allowedKinds.includes(args.item.itemKind)) {
    return {
      ok: false,
      code: "reviewer_queue_item_invalid_input",
      message: `action '${args.action}' is not valid for item kind '${args.item.itemKind}'`,
      diagnostics: [],
    };
  }

  if (args.item.sourceRevisionId !== args.expectedSourceRevisionId) {
    return {
      ok: false,
      code: "reviewer_queue_item_stale_revision",
      message: `reviewer action targeted source_revision=${args.expectedSourceRevisionId} but item ${args.item.reviewItemId} is on source_revision=${args.item.sourceRevisionId}`,
      diagnostics: [
        {
          code: "reviewer_queue_item_stale_revision",
          message: `current source_revision_id=${args.item.sourceRevisionId}`,
        },
      ],
    };
  }

  if (
    args.item.itemKind === reviewerQueueItemKindValues.runtimeEvidence &&
    (args.item.evidenceTier === null ||
      args.item.observationEventIds === null ||
      args.item.artifactHashes === null)
  ) {
    return {
      ok: false,
      code: "reviewer_queue_item_runtime_evidence_invariant",
      message: `runtime evidence item ${args.item.reviewItemId} is missing evidence tier or observation refs; refusing to transition`,
      diagnostics: [],
    };
  }

  const requestedNextState = args.forcedNextState ?? reviewerQueueActionToNextState[args.action];
  if (!allowedTransitionSet.has(`${args.item.state}→${requestedNextState}`)) {
    return {
      ok: false,
      code: "reviewer_queue_item_invalid_transition",
      message: `cannot transition reviewer queue item ${args.item.reviewItemId} from '${args.item.state}' to '${requestedNextState}' via action '${args.action}'`,
      diagnostics: [
        {
          code: "reviewer_queue_item_invalid_transition",
          message: `prior_state=${args.item.state} requested_next_state=${requestedNextState}`,
        },
      ],
    };
  }

  return {
    ok: true,
    action: args.action,
    priorState: args.item.state,
    nextState: requestedNextState,
  };
}

export class ItotoriReviewerQueueRepository implements ItotoriReviewerQueueRepositoryPort {
  constructor(private readonly db: ItotoriDatabase) {}

  async createItem(
    actor: AuthorizationActor,
    input: CreateReviewerQueueItemInput,
  ): Promise<ReviewerQueueItemRecord> {
    await requirePermission(this.db, actor, permissionValues.queueManage);
    assertCreateInput(input);

    const reviewItemId = `reviewer-queue-${randomUUID()}`;
    const createdAt = input.createdAt ?? new Date();

    try {
      const inserted = await this.db
        .insert(reviewerQueueItems)
        .values({
          reviewItemId,
          projectId: input.projectId,
          localeBranchId: input.localeBranchId,
          sourceRevisionId: input.sourceRevisionId,
          itemKind: input.itemKind,
          sourceItemRef: input.sourceItemRef,
          state: reviewerQueueItemStateValues.pending,
          priority: input.priority ?? 0,
          summary: input.summary,
          affectedArtifactIds: input.affectedArtifactIds ?? [],
          evidenceTier: input.evidenceTier ?? null,
          observationEventIds:
            input.itemKind === reviewerQueueItemKindValues.runtimeEvidence
              ? (input.observationEventIds ?? [])
              : null,
          artifactHashes:
            input.itemKind === reviewerQueueItemKindValues.runtimeEvidence
              ? (input.artifactHashes ?? [])
              : null,
          payload: input.payload ?? {},
          metadata: input.metadata ?? {},
          createdByUserId: input.createdByUserId ?? null,
          assignedToUserId: input.assignedToUserId ?? null,
          createdAt,
          updatedAt: createdAt,
          resolvedAt: null,
        })
        .returning();
      const row = inserted[0];
      if (row === undefined) {
        throw new ReviewerQueueRepositoryError(
          "reviewer_queue_item_not_found",
          `reviewer queue item ${reviewItemId} disappeared immediately after insert`,
        );
      }
      return rowToItem(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ReviewerQueueRepositoryError(
          "reviewer_queue_item_duplicate",
          `reviewer queue already has an item for locale_branch=${input.localeBranchId} source_revision=${input.sourceRevisionId} kind=${input.itemKind} ref=${input.sourceItemRef}`,
        );
      }
      throw error;
    }
  }

  async applyAction(
    actor: AuthorizationActor,
    input: ReviewerQueueActionInput,
  ): Promise<ReviewerQueueActionResult> {
    await requirePermission(this.db, actor, permissionValues.queueManage);
    assertActionInputShape(input);

    return this.db.transaction(async (tx) => applyActionInTransaction(tx, input));
  }

  async applyActionAndEnqueueJobs(
    actor: AuthorizationActor,
    input: ReviewerQueueActionInput,
    planJobs: ReviewerQueueActionJobPlanner,
  ): Promise<ReviewerQueueActionAndJobsResult> {
    await requirePermission(this.db, actor, permissionValues.queueManage);
    assertActionInputShape(input);

    return this.db.transaction(async (tx) => {
      const actionResult = await applyActionInTransaction(tx, input);
      const jobInputs = await planJobs(actionResult);
      const jobs = await ItotoriEventQueueRepository.enqueueJobsInTransaction(
        tx as unknown as QueueSqlExecutor,
        jobInputs,
      );
      return { actionResult, jobs };
    });
  }

  async applyActionsAndEnqueueJobs(
    actor: AuthorizationActor,
    inputs: readonly ReviewerQueueActionInput[],
    planJobs: ReviewerQueueActionJobPlanner,
  ): Promise<ReviewerQueueBatchActionAndJobsResult> {
    await requirePermission(this.db, actor, permissionValues.queueManage);
    if (inputs.length === 0) {
      throw new ReviewerQueueRepositoryError(
        "reviewer_queue_item_invalid_input",
        "batch action requires at least one reviewer queue item",
      );
    }
    for (const input of inputs) {
      assertActionInputShape(input);
    }

    return this.db.transaction(async (tx) => {
      const actionResults: ReviewerQueueActionResult[] = [];
      const jobs: JobQueueRecord[] = [];
      for (const input of inputs) {
        const actionResult = await applyActionInTransaction(tx, input);
        const jobInputs = await planJobs(actionResult);
        jobs.push(
          ...(await ItotoriEventQueueRepository.enqueueJobsInTransaction(
            tx as unknown as QueueSqlExecutor,
            jobInputs,
          )),
        );
        actionResults.push(actionResult);
      }
      return { actionResults, jobs };
    });
  }

  async getItem(
    actor: AuthorizationActor,
    reviewItemId: string,
  ): Promise<ReviewerQueueItemRecord | null> {
    await requirePermission(this.db, actor, permissionValues.queueRead);
    const rows = await this.db
      .select()
      .from(reviewerQueueItems)
      .where(eq(reviewerQueueItems.reviewItemId, reviewItemId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return rowToItem(row);
  }

  async loadItemsByBranch(
    actor: AuthorizationActor,
    localeBranchId: string,
    opts: LoadReviewerQueueItemsOptions = {},
  ): Promise<ReviewerQueueItemRecord[]> {
    await requirePermission(this.db, actor, permissionValues.queueRead);

    const conditions = [eq(reviewerQueueItems.localeBranchId, localeBranchId)];
    if (opts.stateFilter !== undefined) {
      conditions.push(eq(reviewerQueueItems.state, opts.stateFilter));
    }
    if (opts.kindFilter !== undefined) {
      conditions.push(eq(reviewerQueueItems.itemKind, opts.kindFilter));
    }
    const rows = await this.db
      .select()
      .from(reviewerQueueItems)
      .where(and(...conditions))
      .orderBy(asc(reviewerQueueItems.createdAt));
    return rows.map(rowToItem);
  }

  async loadTransitionsByItem(
    actor: AuthorizationActor,
    reviewItemId: string,
  ): Promise<ReviewerQueueTransitionRecord[]> {
    await requirePermission(this.db, actor, permissionValues.queueRead);
    const rows = await this.db
      .select()
      .from(reviewerQueueTransitions)
      .where(eq(reviewerQueueTransitions.reviewItemId, reviewItemId))
      .orderBy(asc(reviewerQueueTransitions.createdAt));
    return rows.map(rowToTransition);
  }
}

export type ReviewerQueueTransaction = Pick<ItotoriDatabase, "select" | "update" | "insert">;

/**
 * Core of every reviewer action: re-reads the item under the caller's
 * transaction, validates the transition, then writes the item row and
 * transition log atomically. Exported so the optimistic-lock /
 * concurrent-modification split can be unit-tested deterministically
 * with a stub transaction (the 0-row UPDATE race is not reproducible
 * through a single-snapshot live transaction).
 */
export async function applyActionInTransaction(
  tx: ReviewerQueueTransaction,
  input: ReviewerQueueActionInput,
): Promise<ReviewerQueueActionResult> {
  const existingRows = await tx
    .select()
    .from(reviewerQueueItems)
    .where(eq(reviewerQueueItems.reviewItemId, input.reviewItemId))
    .limit(1);
  const existing = existingRows[0];
  if (existing === undefined) {
    throw new ReviewerQueueRepositoryError(
      "reviewer_queue_item_not_found",
      `reviewer queue item ${input.reviewItemId} not found`,
    );
  }

  // Shared with the ITOTORI-083 batch preview: same input yields the
  // same diagnostic before this transaction writes anything.
  const existingItem = rowToItem(existing);
  if (input.expectedLeaseId !== undefined) {
    const currentLeaseId =
      typeof existingItem.metadata.leaseId === "string" ? existingItem.metadata.leaseId : null;
    if (currentLeaseId !== input.expectedLeaseId) {
      throw new ReviewerQueueRepositoryError(
        "reviewer_queue_item_stale_lease",
        `reviewer action targeted lease=${input.expectedLeaseId} but item ${input.reviewItemId} is on lease=${currentLeaseId ?? "none"}`,
        [
          {
            code: "reviewer_queue_item_stale_lease",
            message: `current lease_id=${currentLeaseId ?? "none"}`,
          },
        ],
      );
    }
  }
  const validation = validateReviewerQueueTransition({
    item: existingItem,
    action: input.action,
    expectedSourceRevisionId: input.expectedSourceRevisionId,
    ...(input.forcedNextState === undefined ? {} : { forcedNextState: input.forcedNextState }),
  });
  if (!validation.ok) {
    throw new ReviewerQueueRepositoryError(
      validation.code,
      validation.message,
      validation.diagnostics,
    );
  }
  const requestedNextState = validation.nextState;

  const transitionId = `reviewer-queue-transition-${randomUUID()}`;
  const at = input.at ?? new Date();
  const isTerminal =
    requestedNextState === reviewerQueueItemStateValues.accepted ||
    requestedNextState === reviewerQueueItemStateValues.rejected;

  const updateRows = await tx
    .update(reviewerQueueItems)
    .set({
      state: requestedNextState,
      updatedAt: at,
      resolvedAt: isTerminal ? at : null,
      affectedArtifactIds:
        input.affectedArtifactIds === undefined
          ? existing.affectedArtifactIds
          : input.affectedArtifactIds,
    })
    .where(
      and(
        eq(reviewerQueueItems.reviewItemId, input.reviewItemId),
        eq(reviewerQueueItems.state, existing.state),
        eq(reviewerQueueItems.sourceRevisionId, input.expectedSourceRevisionId),
      ),
    )
    .returning();
  const updated = updateRows[0];
  if (updated === undefined) {
    // The transition was already validated against `existing` above, so a
    // 0-row UPDATE means the optimistic-lock guard (state +
    // source_revision) no longer matched: a concurrent writer either moved
    // the row or deleted it between our SELECT and UPDATE. Re-read to tell
    // the two apart so a deleted row is not mislabeled as a concurrency
    // collision, and so callers can distinguish a retryable race from a
    // permanently-illegal transition.
    const recheckRows = await tx
      .select()
      .from(reviewerQueueItems)
      .where(eq(reviewerQueueItems.reviewItemId, input.reviewItemId))
      .limit(1);
    if (recheckRows[0] === undefined) {
      throw new ReviewerQueueRepositoryError(
        "reviewer_queue_item_not_found",
        `reviewer queue item ${input.reviewItemId} not found`,
      );
    }
    throw new ReviewerQueueRepositoryError(
      "reviewer_queue_item_concurrent_modification",
      `reviewer queue item ${input.reviewItemId} was modified concurrently (state or source_revision moved since it was read); please retry with a fresh fetch`,
      [
        {
          code: "reviewer_queue_item_concurrent_modification",
          message: `expected_prior_state=${existing.state} expected_source_revision_id=${input.expectedSourceRevisionId}`,
        },
      ],
    );
  }

  const transitionRows = await tx
    .insert(reviewerQueueTransitions)
    .values({
      transitionId,
      reviewItemId: input.reviewItemId,
      localeBranchId: existing.localeBranchId,
      sourceRevisionId: existing.sourceRevisionId,
      itemKind: existing.itemKind,
      action: input.action,
      priorState: existing.state,
      nextState: requestedNextState,
      actorUserId: input.actorUserId,
      affectedArtifactIds: input.affectedArtifactIds ?? existing.affectedArtifactIds,
      diagnostics: input.diagnostics ?? [],
      metadata: input.metadata ?? {},
      createdAt: at,
    })
    .returning();
  const transition = transitionRows[0];
  if (transition === undefined) {
    throw new ReviewerQueueRepositoryError(
      "reviewer_queue_item_not_found",
      `reviewer queue transition ${transitionId} disappeared immediately after insert`,
    );
  }

  return {
    item: rowToItem(updated),
    transition: rowToTransition(transition),
  };
}

function assertCreateInput(input: CreateReviewerQueueItemInput): void {
  if (input.projectId.length === 0) {
    throw new ReviewerQueueRepositoryError(
      "reviewer_queue_item_invalid_input",
      "projectId must be non-empty",
    );
  }
  if (input.localeBranchId.length === 0) {
    throw new ReviewerQueueRepositoryError(
      "reviewer_queue_item_invalid_input",
      "localeBranchId must be non-empty",
    );
  }
  if (input.sourceRevisionId.length === 0) {
    throw new ReviewerQueueRepositoryError(
      "reviewer_queue_item_invalid_input",
      "sourceRevisionId must be non-empty",
    );
  }
  if (input.sourceItemRef.length === 0) {
    throw new ReviewerQueueRepositoryError(
      "reviewer_queue_item_invalid_input",
      "sourceItemRef must be non-empty",
    );
  }
  if (input.summary.length === 0) {
    throw new ReviewerQueueRepositoryError(
      "reviewer_queue_item_invalid_input",
      "summary must be non-empty",
    );
  }
  if (!reviewerQueueItemKindList.includes(input.itemKind)) {
    throw new ReviewerQueueRepositoryError(
      "reviewer_queue_item_invalid_input",
      `itemKind must be one of ${reviewerQueueItemKindList.join(", ")}`,
    );
  }
  if (input.itemKind === reviewerQueueItemKindValues.runtimeEvidence) {
    if (input.evidenceTier === undefined || input.evidenceTier.length === 0) {
      throw new ReviewerQueueRepositoryError(
        "reviewer_queue_item_runtime_evidence_invariant",
        "runtime evidence items must declare evidenceTier",
      );
    }
    if (input.observationEventIds === undefined) {
      throw new ReviewerQueueRepositoryError(
        "reviewer_queue_item_runtime_evidence_invariant",
        "runtime evidence items must declare observationEventIds",
      );
    }
    if (input.artifactHashes === undefined) {
      throw new ReviewerQueueRepositoryError(
        "reviewer_queue_item_runtime_evidence_invariant",
        "runtime evidence items must declare artifactHashes",
      );
    }
  } else {
    if (input.evidenceTier !== undefined) {
      throw new ReviewerQueueRepositoryError(
        "reviewer_queue_item_runtime_evidence_invariant",
        `evidenceTier is only valid for itemKind='${reviewerQueueItemKindValues.runtimeEvidence}'`,
      );
    }
    if (input.observationEventIds !== undefined) {
      throw new ReviewerQueueRepositoryError(
        "reviewer_queue_item_runtime_evidence_invariant",
        `observationEventIds is only valid for itemKind='${reviewerQueueItemKindValues.runtimeEvidence}'`,
      );
    }
    if (input.artifactHashes !== undefined) {
      throw new ReviewerQueueRepositoryError(
        "reviewer_queue_item_runtime_evidence_invariant",
        `artifactHashes is only valid for itemKind='${reviewerQueueItemKindValues.runtimeEvidence}'`,
      );
    }
  }
}

function assertActionInputShape(input: ReviewerQueueActionInput): void {
  if (input.reviewItemId.length === 0) {
    throw new ReviewerQueueRepositoryError(
      "reviewer_queue_item_invalid_input",
      "reviewItemId must be non-empty",
    );
  }
  if (input.actorUserId.length === 0) {
    throw new ReviewerQueueRepositoryError(
      "reviewer_queue_item_invalid_input",
      "actorUserId must be non-empty",
    );
  }
  if (input.expectedSourceRevisionId.length === 0) {
    throw new ReviewerQueueRepositoryError(
      "reviewer_queue_item_invalid_input",
      "expectedSourceRevisionId must be non-empty",
    );
  }
  if (!reviewerQueueActionList.includes(input.action)) {
    throw new ReviewerQueueRepositoryError(
      "reviewer_queue_item_invalid_input",
      `action must be one of ${reviewerQueueActionList.join(", ")}`,
    );
  }
  if (
    input.forcedNextState !== undefined &&
    !reviewerQueueItemStateList.includes(input.forcedNextState)
  ) {
    throw new ReviewerQueueRepositoryError(
      "reviewer_queue_item_invalid_input",
      `forcedNextState must be one of ${reviewerQueueItemStateList.join(", ")}`,
    );
  }
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  while (current !== undefined && current !== null) {
    if (typeof current === "object" && "code" in current) {
      const code = (current as { code?: unknown }).code;
      if (code === "23505") {
        return true;
      }
    }
    if (typeof current === "object" && "cause" in current) {
      current = (current as { cause?: unknown }).cause;
    } else {
      break;
    }
  }
  return false;
}

function rowToItem(row: typeof reviewerQueueItems.$inferSelect): ReviewerQueueItemRecord {
  return {
    reviewItemId: row.reviewItemId,
    projectId: row.projectId,
    localeBranchId: row.localeBranchId,
    sourceRevisionId: row.sourceRevisionId,
    itemKind: row.itemKind,
    sourceItemRef: row.sourceItemRef,
    state: row.state,
    priority: row.priority,
    summary: row.summary,
    affectedArtifactIds: row.affectedArtifactIds,
    evidenceTier: row.evidenceTier,
    observationEventIds: row.observationEventIds,
    artifactHashes: row.artifactHashes,
    payload: row.payload,
    metadata: row.metadata,
    createdByUserId: row.createdByUserId,
    assignedToUserId: row.assignedToUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    resolvedAt: row.resolvedAt,
  };
}

function rowToTransition(
  row: typeof reviewerQueueTransitions.$inferSelect,
): ReviewerQueueTransitionRecord {
  return {
    transitionId: row.transitionId,
    reviewItemId: row.reviewItemId,
    localeBranchId: row.localeBranchId,
    sourceRevisionId: row.sourceRevisionId,
    itemKind: row.itemKind,
    action: row.action,
    priorState: row.priorState,
    nextState: row.nextState,
    actorUserId: row.actorUserId,
    affectedArtifactIds: row.affectedArtifactIds,
    diagnostics: row.diagnostics,
    metadata: row.metadata,
    createdAt: row.createdAt,
  };
}

export { reviewerQueueActionValues, reviewerQueueItemKindValues, reviewerQueueItemStateValues };
