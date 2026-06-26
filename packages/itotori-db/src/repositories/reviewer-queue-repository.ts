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
  reviewerQueueItemStateValues.escalated,
];

export const reviewerQueueActionList: ReadonlyArray<ReviewerQueueAction> = [
  reviewerQueueActionValues.approve,
  reviewerQueueActionValues.reject,
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
  "reviewer_queue_item_stale_revision",
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
  affectedArtifactIds?: string[];
  diagnostics?: ReviewerQueueDiagnostic[];
  metadata?: Record<string, unknown>;
  /**
   * Optional override of the next state. The default per-action
   * mapping is documented on `actionToNextState`. The override is
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
 */
const allowedTransitions: ReadonlyArray<readonly [ReviewerQueueItemState, ReviewerQueueItemState]> =
  [
    [reviewerQueueItemStateValues.pending, reviewerQueueItemStateValues.inReview],
    [reviewerQueueItemStateValues.pending, reviewerQueueItemStateValues.accepted],
    [reviewerQueueItemStateValues.pending, reviewerQueueItemStateValues.rejected],
    [reviewerQueueItemStateValues.pending, reviewerQueueItemStateValues.repairRequested],
    [reviewerQueueItemStateValues.pending, reviewerQueueItemStateValues.escalated],
    [reviewerQueueItemStateValues.inReview, reviewerQueueItemStateValues.accepted],
    [reviewerQueueItemStateValues.inReview, reviewerQueueItemStateValues.rejected],
    [reviewerQueueItemStateValues.inReview, reviewerQueueItemStateValues.repairRequested],
    [reviewerQueueItemStateValues.inReview, reviewerQueueItemStateValues.escalated],
    [reviewerQueueItemStateValues.repairRequested, reviewerQueueItemStateValues.pending],
    [reviewerQueueItemStateValues.repairRequested, reviewerQueueItemStateValues.accepted],
    [reviewerQueueItemStateValues.repairRequested, reviewerQueueItemStateValues.rejected],
    [reviewerQueueItemStateValues.escalated, reviewerQueueItemStateValues.accepted],
    [reviewerQueueItemStateValues.escalated, reviewerQueueItemStateValues.rejected],
  ];

const allowedTransitionSet = new Set(allowedTransitions.map(([prior, next]) => `${prior}→${next}`));

/**
 * Default action → next-state mapping. The repository uses these
 * unless the caller supplies a `forcedNextState` override.
 */
const actionToNextState: Readonly<Record<ReviewerQueueAction, ReviewerQueueItemState>> = {
  [reviewerQueueActionValues.approve]: reviewerQueueItemStateValues.accepted,
  [reviewerQueueActionValues.reject]: reviewerQueueItemStateValues.rejected,
  [reviewerQueueActionValues.requestRepair]: reviewerQueueItemStateValues.repairRequested,
  [reviewerQueueActionValues.updateGlossary]: reviewerQueueItemStateValues.accepted,
  [reviewerQueueActionValues.updateStyle]: reviewerQueueItemStateValues.accepted,
  [reviewerQueueActionValues.importRuntimeFeedback]: reviewerQueueItemStateValues.accepted,
};

/**
 * Each action is only valid for a subset of item kinds. Mixing an
 * action with the wrong kind (e.g. `updateGlossary` on a runtime
 * evidence item) returns `reviewer_queue_item_invalid_input` before any
 * SQL fires.
 */
const actionAllowedKinds: Readonly<
  Record<ReviewerQueueAction, ReadonlyArray<ReviewerQueueItemKind>>
> = {
  [reviewerQueueActionValues.approve]: reviewerQueueItemKindList,
  [reviewerQueueActionValues.reject]: reviewerQueueItemKindList,
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

    return this.db.transaction(async (tx) => {
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

      const allowedKinds = actionAllowedKinds[input.action];
      if (!allowedKinds.includes(existing.itemKind)) {
        throw new ReviewerQueueRepositoryError(
          "reviewer_queue_item_invalid_input",
          `action '${input.action}' is not valid for item kind '${existing.itemKind}'`,
        );
      }

      if (existing.sourceRevisionId !== input.expectedSourceRevisionId) {
        throw new ReviewerQueueRepositoryError(
          "reviewer_queue_item_stale_revision",
          `reviewer action targeted source_revision=${input.expectedSourceRevisionId} but item ${input.reviewItemId} is on source_revision=${existing.sourceRevisionId}`,
          [
            {
              code: "reviewer_queue_item_stale_revision",
              message: `current source_revision_id=${existing.sourceRevisionId}`,
            },
          ],
        );
      }

      const requestedNextState = input.forcedNextState ?? actionToNextState[input.action];
      if (!allowedTransitionSet.has(`${existing.state}→${requestedNextState}`)) {
        throw new ReviewerQueueRepositoryError(
          "reviewer_queue_item_invalid_transition",
          `cannot transition reviewer queue item ${input.reviewItemId} from '${existing.state}' to '${requestedNextState}' via action '${input.action}'`,
          [
            {
              code: "reviewer_queue_item_invalid_transition",
              message: `prior_state=${existing.state} requested_next_state=${requestedNextState}`,
            },
          ],
        );
      }

      // Runtime-evidence invariant: every transition on a
      // runtime_evidence item preserves the evidence tier, observation
      // event ids, and artifact hashes verbatim. The SQL discriminant
      // already prevents NULL-ing them at the row level; this explicit
      // application-side guard preserves the invariant when a payload
      // is supplied alongside the action.
      if (
        existing.itemKind === reviewerQueueItemKindValues.runtimeEvidence &&
        (existing.evidenceTier === null ||
          existing.observationEventIds === null ||
          existing.artifactHashes === null)
      ) {
        throw new ReviewerQueueRepositoryError(
          "reviewer_queue_item_runtime_evidence_invariant",
          `runtime evidence item ${input.reviewItemId} is missing evidence tier or observation refs; refusing to transition`,
        );
      }

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
        // Optimistic lock collision: the item moved out from under us
        // between the SELECT and the UPDATE. Treat as invalid transition
        // so the caller retries with a fresh read.
        throw new ReviewerQueueRepositoryError(
          "reviewer_queue_item_invalid_transition",
          `reviewer queue item ${input.reviewItemId} state changed concurrently; please retry with a fresh fetch`,
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
