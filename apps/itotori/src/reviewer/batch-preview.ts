// ITOTORI-083 — Reviewer batch action consequence preview.
//
// The reviewer selects N queue items and an action; this service
// computes — WITHOUT mutating anything — what the action would do to
// each item: the next state (via the shared ITOTORI-081 transition
// validator), the affected drafts / exports / rerun jobs / glossary
// terms / policy versions / benchmark artifacts, and a per-item status
// (allowed / denied / stale / conflicting). The dashboard renders the
// result so the reviewer confirms with full knowledge.
//
// The preview path is gated on `queue.read`: the caller resolves the
// permission via `auth.ts` and passes a `ReviewerBatchPermissionView`.
// The execution path (batch-execute.ts) re-checks `queue.manage` per
// the permission matrix.
//
// Audit focus addressed here:
//  - "Batch actions bypassing single-action state machine": the preview
//    runs `validateReviewerQueueTransition` (the same function the
//    repository's `applyAction` runs) for every selected item. Anything
//    the repository would refuse is refused at preview time too.
//  - "Consequence preview disagreeing with execution": the per-item
//    `nextState`, error code, and message returned by the preview are
//    EXACTLY what `applyAction` would return for the same input, by
//    construction (single shared validator).
//  - "Partial batch writes without item diagnostics": preview returns
//    one `BatchPreviewItem` per requested id, even when the id is
//    missing (item = null) or duplicated; nothing collapses silently.
//
// The service is deterministic. It makes no LLM calls and carries no
// (model, provider) pair (pair-policy v0.3 applies only to model
// invocations).

import {
  reviewerQueueActionAllowedKinds,
  reviewerQueueActionList,
  reviewerQueueActionToNextState,
  reviewerQueueItemKindValues,
  reviewerQueueItemStateValues,
  validateReviewerQueueTransition,
  type ReviewerQueueAction,
  type ReviewerQueueDiagnostic,
  type ReviewerQueueItemKind,
  type ReviewerQueueItemRecord,
  type ReviewerQueueItemState,
  type ReviewerQueueRepositoryErrorCode,
} from "@itotori/db";

/**
 * Permission view consumed by the batch preview / execute services.
 * Resolved by the SPA bootstrap / API layer via `auth.ts`; the batch
 * surface itself never calls `requirePermission` directly (the API
 * mutation permission matrix audit forbids ad-hoc callsites).
 *
 * `canReadQueue` gates preview. `canManageQueue` gates execution. The
 * preview surface returns a denied view when `canReadQueue=false`; the
 * execution surface returns a denied view when `canManageQueue=false`.
 */
export type ReviewerBatchPermissionView = {
  actorUserId: string;
  canReadQueue: boolean;
  canManageQueue: boolean;
  denialReasons: string[];
};

/**
 * One requested entry in the batch: the queue item to act on plus the
 * source revision the reviewer saw when they selected. The repository
 * compares `expectedSourceRevisionId` against the item's persisted
 * revision and refuses on mismatch (stale).
 */
export type ReviewerBatchSelection = {
  reviewItemId: string;
  expectedSourceRevisionId: string;
};

export type ReviewerBatchActionRequest = {
  action: ReviewerQueueAction;
  actorUserId: string;
  selections: ReviewerBatchSelection[];
};

/**
 * Per-item preview status. Matches the closed taxonomy of repository
 * refusal codes plus `allowed` (would succeed), `not_found` (item id
 * was not resolvable), `duplicate_selection` (the same review item id
 * appears twice in one request), `permission_denied_read` (the actor
 * lacks `queue.read`, so even previewing is refused), and
 * `permission_denied_manage` (the actor can preview but lacks
 * `queue.manage`, so execution would fail). Read- and manage-gate
 * denials are distinct members so downstream consumers can tell a
 * preview refusal from a confirm refusal by status alone.
 */
export const reviewerBatchPreviewStatusValues = {
  allowed: "allowed",
  notFound: "not_found",
  duplicateSelection: "duplicate_selection",
  permissionDeniedRead: "permission_denied_read",
  permissionDeniedManage: "permission_denied_manage",
  invalidInput: "reviewer_queue_item_invalid_input",
  invalidTransition: "reviewer_queue_item_invalid_transition",
  staleRevision: "reviewer_queue_item_stale_revision",
  runtimeEvidenceInvariant: "reviewer_queue_item_runtime_evidence_invariant",
} as const;

export type ReviewerBatchPreviewStatus =
  (typeof reviewerBatchPreviewStatusValues)[keyof typeof reviewerBatchPreviewStatusValues];

/**
 * Closed taxonomy of consequences the preview enumerates. Each rerun
 * job / policy write / glossary write / export / benchmark impact is
 * surfaced verbatim so the dashboard renders one row per affected
 * downstream artifact.
 */
export type ReviewerBatchConsequence =
  | {
      kind: "rerun_job";
      runtimeTargetId: string;
      jobLabel: string;
    }
  | {
      kind: "policy_version_write";
      styleGuidePolicyVersionId: string;
      ruleLabel: string;
    }
  | {
      kind: "glossary_term_write";
      termId: string;
      approvedTranslation: string;
    }
  | {
      kind: "export_artifact";
      exportArtifactId: string;
      artifactLabel: string;
    }
  | {
      kind: "benchmark_artifact";
      benchmarkArtifactId: string;
      benchmarkLabel: string;
    }
  | {
      kind: "draft_state_change";
      draftId: string;
      nextDraftStatus: string;
    };

/**
 * Per-item preview row. Carries the validator outcome, the next state
 * the action would write, the required permission, the affected
 * artifact ids the batch declared, and any per-item consequences the
 * preview resolver supplied (rerun jobs, glossary writes, etc.).
 */
export type BatchPreviewItem = {
  reviewItemId: string;
  expectedSourceRevisionId: string;
  status: ReviewerBatchPreviewStatus;
  /**
   * The reviewer-queue action this preview row was computed for.
   * Always `request.action` — duplicated onto the row so the
   * downstream renderer / executor never needs to thread it through.
   */
  action: ReviewerQueueAction;
  /**
   * The permission that must be held to execute the action. Preview
   * needs `queue.read`; execute needs `queue.manage`. Both are
   * surfaced so the renderer can show one row per gate.
   */
  requiredPermission: "queue.read" | "queue.manage";
  /** Persisted item snapshot the preview ran against (null if missing). */
  item: ReviewerQueueItemRecord | null;
  priorState: ReviewerQueueItemState | null;
  nextState: ReviewerQueueItemState | null;
  diagnostics: ReviewerQueueDiagnostic[];
  message: string | null;
  consequences: ReviewerBatchConsequence[];
};

/**
 * Top-level preview result. The `aggregate` rolls up per-status counts
 * so the renderer can show a single banner (e.g. "3 allowed, 1 stale,
 * 1 invalid_input"). `request` is echoed back so renderers do not have
 * to thread the original request through.
 */
export type ReviewerBatchPreview = {
  request: ReviewerBatchActionRequest;
  permission: ReviewerBatchPermissionView;
  items: BatchPreviewItem[];
  aggregate: {
    total: number;
    allowed: number;
    denied: number;
    stale: number;
    notFound: number;
    duplicate: number;
    runtimeEvidenceInvariant: number;
    invalidInput: number;
    invalidTransition: number;
    permissionDeniedRead: number;
    permissionDeniedManage: number;
  };
  /**
   * `true` iff every preview row is `allowed`. Renderers use this to
   * gate the confirm button; executors use this to assert the preview
   * matched before mutating.
   */
  allAllowed: boolean;
  permissionDenied: boolean;
};

/**
 * Port the preview service uses to resolve per-item consequences
 * (affected drafts, exports, rerun jobs, glossary terms, policy
 * versions, benchmark artifacts). Concrete implementations are wired
 * in `services/database-services.ts`; tests pass a hand-rolled stub.
 *
 * The port returns the item + consequences in a single call so the
 * preview service can issue one query per id (caller-side batching is
 * fine but not required).
 */
export interface ReviewerBatchConsequenceResolverPort {
  loadItem(reviewItemId: string): Promise<ReviewerQueueItemRecord | null>;
  resolveConsequences(input: {
    item: ReviewerQueueItemRecord;
    action: ReviewerQueueAction;
    nextState: ReviewerQueueItemState;
  }): Promise<ReviewerBatchConsequence[]>;
}

export type ReviewerBatchPreviewServicePort = {
  preview(
    request: ReviewerBatchActionRequest,
    permission: ReviewerBatchPermissionView,
  ): Promise<ReviewerBatchPreview>;
};

export class ReviewerBatchPreviewServiceInputError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "ReviewerBatchPreviewServiceInputError";
  }
}

export class ReviewerBatchPreviewService implements ReviewerBatchPreviewServicePort {
  constructor(private readonly resolver: ReviewerBatchConsequenceResolverPort) {}

  async preview(
    request: ReviewerBatchActionRequest,
    permission: ReviewerBatchPermissionView,
  ): Promise<ReviewerBatchPreview> {
    assertRequestShape(request);

    if (!permission.canReadQueue) {
      // Permission denial returns one synthesized row per requested id
      // so the renderer never silently drops a selection. The resolver
      // is NEVER consulted on the denied path (audit guard).
      return buildDeniedPreview(request, permission);
    }

    const seen = new Map<string, number>();
    for (const selection of request.selections) {
      seen.set(selection.reviewItemId, (seen.get(selection.reviewItemId) ?? 0) + 1);
    }

    const items: BatchPreviewItem[] = [];
    for (const selection of request.selections) {
      const isDuplicate = (seen.get(selection.reviewItemId) ?? 0) > 1;
      const isFirstOccurrence =
        items.find((entry) => entry.reviewItemId === selection.reviewItemId) === undefined;

      if (isDuplicate && !isFirstOccurrence) {
        items.push(duplicateRow(request.action, selection, permission.canManageQueue));
        continue;
      }

      const item = await this.resolver.loadItem(selection.reviewItemId);
      if (item === null) {
        items.push(notFoundRow(request.action, selection, permission.canManageQueue));
        continue;
      }

      const validation = validateReviewerQueueTransition({
        item,
        action: request.action,
        expectedSourceRevisionId: selection.expectedSourceRevisionId,
      });

      if (!validation.ok) {
        items.push({
          reviewItemId: item.reviewItemId,
          expectedSourceRevisionId: selection.expectedSourceRevisionId,
          status: mapRefusalCodeToStatus(validation.code),
          action: request.action,
          requiredPermission: "queue.manage",
          item,
          priorState: item.state,
          nextState: null,
          diagnostics: validation.diagnostics,
          message: validation.message,
          consequences: [],
        });
        continue;
      }

      const consequences = await this.resolver.resolveConsequences({
        item,
        action: validation.action,
        nextState: validation.nextState,
      });

      const allowedStatus: ReviewerBatchPreviewStatus = permission.canManageQueue
        ? reviewerBatchPreviewStatusValues.allowed
        : reviewerBatchPreviewStatusValues.permissionDeniedManage;
      const message = permission.canManageQueue
        ? null
        : `actor ${permission.actorUserId} can preview but lacks permission queue.manage to confirm`;
      const diagnostics: ReviewerQueueDiagnostic[] = permission.canManageQueue
        ? []
        : [
            {
              code: "reviewer_batch_permission_denied_manage",
              message: message ?? "",
            },
          ];
      items.push({
        reviewItemId: item.reviewItemId,
        expectedSourceRevisionId: selection.expectedSourceRevisionId,
        status: allowedStatus,
        action: request.action,
        requiredPermission: "queue.manage",
        item,
        priorState: validation.priorState,
        nextState: validation.nextState,
        diagnostics,
        message,
        consequences,
      });
    }

    return finalizePreview(request, permission, items);
  }
}

function assertRequestShape(request: ReviewerBatchActionRequest): void {
  if (!reviewerQueueActionList.includes(request.action)) {
    throw new ReviewerBatchPreviewServiceInputError(
      "action",
      `action must be one of ${reviewerQueueActionList.join(", ")}`,
    );
  }
  if (typeof request.actorUserId !== "string" || request.actorUserId.length === 0) {
    throw new ReviewerBatchPreviewServiceInputError("actorUserId", "actorUserId must be non-empty");
  }
  if (!Array.isArray(request.selections)) {
    throw new ReviewerBatchPreviewServiceInputError("selections", "selections must be an array");
  }
  for (const [index, selection] of request.selections.entries()) {
    if (typeof selection.reviewItemId !== "string" || selection.reviewItemId.length === 0) {
      throw new ReviewerBatchPreviewServiceInputError(
        `selections[${index}].reviewItemId`,
        "reviewItemId must be a non-empty string",
      );
    }
    if (
      typeof selection.expectedSourceRevisionId !== "string" ||
      selection.expectedSourceRevisionId.length === 0
    ) {
      throw new ReviewerBatchPreviewServiceInputError(
        `selections[${index}].expectedSourceRevisionId`,
        "expectedSourceRevisionId must be a non-empty string",
      );
    }
  }
}

function buildDeniedPreview(
  request: ReviewerBatchActionRequest,
  permission: ReviewerBatchPermissionView,
): ReviewerBatchPreview {
  const denialReason =
    permission.denialReasons[0] ??
    `user ${permission.actorUserId} is missing permission queue.read`;
  const items: BatchPreviewItem[] = request.selections.map((selection) => ({
    reviewItemId: selection.reviewItemId,
    expectedSourceRevisionId: selection.expectedSourceRevisionId,
    status: reviewerBatchPreviewStatusValues.permissionDeniedRead,
    action: request.action,
    requiredPermission: "queue.read",
    item: null,
    priorState: null,
    nextState: null,
    diagnostics: [
      {
        code: "reviewer_batch_permission_denied_read",
        message: denialReason,
      },
    ],
    message: denialReason,
    consequences: [],
  }));
  return finalizePreview(request, permission, items, true);
}

function finalizePreview(
  request: ReviewerBatchActionRequest,
  permission: ReviewerBatchPermissionView,
  items: BatchPreviewItem[],
  permissionDenied = false,
): ReviewerBatchPreview {
  const aggregate = {
    total: items.length,
    allowed: 0,
    denied: 0,
    stale: 0,
    notFound: 0,
    duplicate: 0,
    runtimeEvidenceInvariant: 0,
    invalidInput: 0,
    invalidTransition: 0,
    permissionDeniedRead: 0,
    permissionDeniedManage: 0,
  };
  for (const entry of items) {
    switch (entry.status) {
      case reviewerBatchPreviewStatusValues.allowed:
        aggregate.allowed += 1;
        break;
      case reviewerBatchPreviewStatusValues.notFound:
        aggregate.notFound += 1;
        aggregate.denied += 1;
        break;
      case reviewerBatchPreviewStatusValues.duplicateSelection:
        aggregate.duplicate += 1;
        aggregate.denied += 1;
        break;
      case reviewerBatchPreviewStatusValues.staleRevision:
        aggregate.stale += 1;
        aggregate.denied += 1;
        break;
      case reviewerBatchPreviewStatusValues.runtimeEvidenceInvariant:
        aggregate.runtimeEvidenceInvariant += 1;
        aggregate.denied += 1;
        break;
      case reviewerBatchPreviewStatusValues.invalidInput:
        aggregate.invalidInput += 1;
        aggregate.denied += 1;
        break;
      case reviewerBatchPreviewStatusValues.invalidTransition:
        aggregate.invalidTransition += 1;
        aggregate.denied += 1;
        break;
      case reviewerBatchPreviewStatusValues.permissionDeniedRead:
        aggregate.permissionDeniedRead += 1;
        aggregate.denied += 1;
        break;
      case reviewerBatchPreviewStatusValues.permissionDeniedManage:
        aggregate.permissionDeniedManage += 1;
        aggregate.denied += 1;
        break;
      default: {
        const exhaustive: never = entry.status;
        throw new Error(`unhandled batch preview status: ${exhaustive as string}`);
      }
    }
  }
  return {
    request,
    permission,
    items,
    aggregate,
    allAllowed: aggregate.total > 0 && aggregate.allowed === aggregate.total,
    permissionDenied: permissionDenied || !permission.canReadQueue,
  };
}

function notFoundRow(
  action: ReviewerQueueAction,
  selection: ReviewerBatchSelection,
  canManage: boolean,
): BatchPreviewItem {
  return {
    reviewItemId: selection.reviewItemId,
    expectedSourceRevisionId: selection.expectedSourceRevisionId,
    status: reviewerBatchPreviewStatusValues.notFound,
    action,
    requiredPermission: canManage ? "queue.manage" : "queue.read",
    item: null,
    priorState: null,
    nextState: null,
    diagnostics: [
      {
        code: "reviewer_queue_item_not_found",
        message: `reviewer queue item ${selection.reviewItemId} not found`,
      },
    ],
    message: `reviewer queue item ${selection.reviewItemId} not found`,
    consequences: [],
  };
}

function duplicateRow(
  action: ReviewerQueueAction,
  selection: ReviewerBatchSelection,
  _canManage: boolean,
): BatchPreviewItem {
  return {
    reviewItemId: selection.reviewItemId,
    expectedSourceRevisionId: selection.expectedSourceRevisionId,
    status: reviewerBatchPreviewStatusValues.duplicateSelection,
    action,
    requiredPermission: "queue.manage",
    item: null,
    priorState: null,
    nextState: null,
    diagnostics: [
      {
        code: "reviewer_batch_duplicate_selection",
        message: `review item ${selection.reviewItemId} appears more than once in the batch selection; refuse closed`,
      },
    ],
    message: `review item ${selection.reviewItemId} appears more than once in the batch selection`,
    consequences: [],
  };
}

function mapRefusalCodeToStatus(
  code: ReviewerQueueRepositoryErrorCode,
): ReviewerBatchPreviewStatus {
  switch (code) {
    case "reviewer_queue_item_invalid_input":
    case "reviewer_queue_item_stale_lease":
      return reviewerBatchPreviewStatusValues.invalidInput;
    case "reviewer_queue_item_invalid_transition":
      return reviewerBatchPreviewStatusValues.invalidTransition;
    case "reviewer_queue_item_stale_revision":
      return reviewerBatchPreviewStatusValues.staleRevision;
    case "reviewer_queue_item_runtime_evidence_invariant":
      return reviewerBatchPreviewStatusValues.runtimeEvidenceInvariant;
    case "reviewer_queue_item_not_found":
      return reviewerBatchPreviewStatusValues.notFound;
    case "reviewer_queue_item_duplicate":
      // Repository duplicate refers to (locale_branch, source_revision,
      // kind, source_item_ref) uniqueness, not the same-id-twice case
      // the batch surface owns. Surface as invalid_input so the
      // dashboard renders the diagnostic verbatim.
      return reviewerBatchPreviewStatusValues.invalidInput;
    default: {
      const exhaustive: never = code;
      throw new Error(`unhandled refusal code: ${exhaustive as string}`);
    }
  }
}

/**
 * Re-export shared helpers / values so dashboard fixtures can reach a
 * single import surface (`@itotori/app`'s reviewer index) instead of
 * pulling from `@itotori/db` directly.
 */
export {
  reviewerQueueActionAllowedKinds,
  reviewerQueueActionToNextState,
  reviewerQueueItemKindValues,
  reviewerQueueItemStateValues,
};
export type { ReviewerQueueAction, ReviewerQueueItemKind, ReviewerQueueItemState };
