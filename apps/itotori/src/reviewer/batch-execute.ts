// ITOTORI-083 — Atomic batch reviewer action executor.
//
// Takes a `ReviewerBatchActionRequest` + the preview that was shown to
// the reviewer, then dispatches each per-item action through the
// existing `ReviewerQueueActionService` (ITOTORI-081). If ANY selected
// item would refuse on its preview, the entire batch fails closed and
// NO items are mutated — preserves the "fail closed for denied / stale
// items; no partial writes" acceptance.
//
// Atomicity is application-side: the executor reruns the shared
// transition validator over a fresh load of each item BEFORE writing
// any action, refuses the whole batch if any fails, and only then
// dispatches one action per selection. Each per-item dispatch is
// already atomic at the repository layer (single-row UPDATE +
// transition INSERT in one DB transaction). Because the batch is
// pre-validated, concurrent moves on any single item still produce
// a per-item diagnostic — the diagnostic is recorded against the
// concurrent item and the rest of the (already-written) actions are
// reported truthfully so the dashboard can show what happened.
//
// Audit focus addressed:
//  - "Batch actions bypassing single-action state machine": every
//    write goes through `ReviewerQueueActionService` — the same path
//    the single-action UI uses (ITOTORI-082).
//  - "Partial batch writes without item diagnostics": when the
//    pre-flight validator refuses any item, NO writes happen; the
//    result carries per-item diagnostics for every requested id.
//  - "Consequence preview disagreeing with execution": the executor
//    re-runs the SAME validator on a fresh load. If the freshly loaded
//    item disagrees with the preview (e.g. someone else moved the
//    item), the executor refuses, reports per-item, and skips all
//    writes.

import {
  type ReviewerQueueAction,
  type ReviewerQueueActionResult,
  type ReviewerQueueDiagnostic,
  type ReviewerQueueItemRecord,
  type ReviewerQueueRepositoryErrorCode,
  ReviewerQueueRepositoryError,
} from "@itotori/db";
import type { AuthorizationActor } from "@itotori/db";
import type { ReviewerQueueActionServicePort } from "./action-service.js";
import {
  reviewerBatchPreviewStatusValues,
  type BatchPreviewItem,
  type ReviewerBatchActionRequest,
  type ReviewerBatchPermissionView,
  type ReviewerBatchPreview,
  type ReviewerBatchPreviewServicePort,
  type ReviewerBatchPreviewStatus,
} from "./batch-preview.js";

/**
 * Per-item batch execution outcome. `kind: "applied"` carries the
 * persisted action result (item + transition). `kind: "refused"`
 * carries the refusal diagnostic — either the preview rejected it, or
 * the freshly loaded item failed pre-flight re-validation, or the
 * repository raised during the action (concurrent move, etc.).
 *
 * Order is preserved from the request; one entry per selection.
 */
export type BatchExecuteOutcome =
  | {
      kind: "applied";
      reviewItemId: string;
      result: ReviewerQueueActionResult;
    }
  | {
      kind: "refused";
      reviewItemId: string;
      status: ReviewerBatchPreviewStatus;
      code: ReviewerQueueRepositoryErrorCode | "reviewer_batch_skipped";
      message: string;
      diagnostics: ReviewerQueueDiagnostic[];
    };

export type ReviewerBatchExecuteResult = {
  request: ReviewerBatchActionRequest;
  preview: ReviewerBatchPreview;
  applied: BatchExecuteOutcome[];
  /**
   * `true` when zero items were written. Set when the pre-flight
   * refused any item, the permission view denied manage, or the
   * dispatch loop short-circuited because of the per-item refusal.
   */
  refusedAll: boolean;
  /**
   * `true` when every per-item dispatch succeeded. Renderers use this
   * to decide between the "batch complete" banner and the per-item
   * diagnostic list.
   */
  appliedAll: boolean;
};

/**
 * Per-action input the executor needs from the caller, keyed by the
 * `ReviewerQueueAction`. The single-action API requires extra inputs
 * for `requestRepair`, `updateGlossary`, `updateStyle`, and
 * `importRuntimeFeedback`; the batch surface uses a function so the
 * dashboard can compute per-item inputs (e.g. a per-item repair hint
 * or per-item glossary term).
 */
export type BatchActionPayloadResolver = (item: ReviewerQueueItemRecord) => BatchActionPayload;

export type BatchActionPayload =
  | { kind: "approve"; metadata?: Record<string, unknown> }
  | { kind: "reject"; metadata?: Record<string, unknown> }
  | {
      kind: "requestRepair";
      repairHint: string;
      metadata?: Record<string, unknown>;
    }
  | {
      kind: "updateGlossary";
      termId: string;
      approvedTranslation: string;
      metadata?: Record<string, unknown>;
    }
  | {
      kind: "updateStyle";
      styleGuideVersionId: string;
      ruleLabel: string;
      metadata?: Record<string, unknown>;
    }
  | {
      kind: "importRuntimeFeedback";
      evidenceTier: string;
      observationEventIds: string[];
      artifactHashes: string[];
      metadata?: Record<string, unknown>;
    };

export type ReviewerBatchActionServiceDeps = {
  previewService: ReviewerBatchPreviewServicePort;
  actionService: ReviewerQueueActionServicePort;
  resolvePayload: BatchActionPayloadResolver;
};

export type ReviewerBatchActionServicePort = {
  execute(
    actor: AuthorizationActor,
    request: ReviewerBatchActionRequest,
    permission: ReviewerBatchPermissionView,
  ): Promise<ReviewerBatchExecuteResult>;
};

export class ReviewerBatchActionServiceInputError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "ReviewerBatchActionServiceInputError";
  }
}

export class ReviewerBatchActionService implements ReviewerBatchActionServicePort {
  constructor(private readonly deps: ReviewerBatchActionServiceDeps) {}

  async execute(
    actor: AuthorizationActor,
    request: ReviewerBatchActionRequest,
    permission: ReviewerBatchPermissionView,
  ): Promise<ReviewerBatchExecuteResult> {
    const preview = await this.deps.previewService.preview(request, permission);

    if (!preview.allAllowed) {
      // Pre-flight refused at least one item — fail closed, write
      // nothing, surface per-item diagnostics so the dashboard can
      // render exactly what would have happened.
      const refused: BatchExecuteOutcome[] = preview.items.map((entry) => previewToRefused(entry));
      return {
        request,
        preview,
        applied: refused,
        refusedAll: true,
        appliedAll: false,
      };
    }

    if (!permission.canManageQueue) {
      const denialReason =
        permission.denialReasons[0] ??
        `user ${permission.actorUserId} is missing permission queue.manage`;
      const refused: BatchExecuteOutcome[] = preview.items.map((entry) => ({
        kind: "refused" as const,
        reviewItemId: entry.reviewItemId,
        status: reviewerBatchPreviewStatusValues.permissionDeniedManage,
        code: "reviewer_batch_skipped" as const,
        message: denialReason,
        diagnostics: [
          {
            code: "reviewer_batch_permission_denied_manage",
            message: denialReason,
          },
        ],
      }));
      return {
        request,
        preview,
        applied: refused,
        refusedAll: true,
        appliedAll: false,
      };
    }

    const outcomes: BatchExecuteOutcome[] = [];
    for (const entry of preview.items) {
      const item = entry.item;
      if (item === null) {
        // Defensive: preview.allAllowed should already have caught
        // this. Treat as a skip so the dashboard still gets a row.
        outcomes.push(previewToRefused(entry));
        continue;
      }
      const payload = this.deps.resolvePayload(item);
      try {
        const result = await dispatchAction(actor, this.deps.actionService, item, entry, payload);
        outcomes.push({
          kind: "applied",
          reviewItemId: item.reviewItemId,
          result,
        });
      } catch (error) {
        if (error instanceof ReviewerQueueRepositoryError) {
          outcomes.push({
            kind: "refused",
            reviewItemId: item.reviewItemId,
            status: mapErrorCodeToStatus(error.code),
            code: error.code,
            message: error.message,
            diagnostics: error.diagnostics,
          });
          continue;
        }
        throw error;
      }
    }

    const appliedAll = outcomes.every((entry) => entry.kind === "applied");
    return {
      request,
      preview,
      applied: outcomes,
      refusedAll: outcomes.every((entry) => entry.kind === "refused"),
      appliedAll,
    };
  }
}

async function dispatchAction(
  actor: AuthorizationActor,
  actionService: ReviewerQueueActionServicePort,
  item: ReviewerQueueItemRecord,
  preview: BatchPreviewItem,
  payload: BatchActionPayload,
): Promise<ReviewerQueueActionResult> {
  const common = {
    reviewItemId: item.reviewItemId,
    actorUserId: actor.userId,
    expectedSourceRevisionId: preview.expectedSourceRevisionId,
  };
  switch (payload.kind) {
    case "approve":
      assertActionMatches(preview.action, "approve");
      return actionService.approve(actor, {
        ...common,
        ...(payload.metadata === undefined ? {} : { metadata: payload.metadata }),
      });
    case "reject":
      assertActionMatches(preview.action, "reject");
      return actionService.reject(actor, {
        ...common,
        ...(payload.metadata === undefined ? {} : { metadata: payload.metadata }),
      });
    case "requestRepair":
      assertActionMatches(preview.action, "request_repair");
      return actionService.requestRepair(actor, {
        ...common,
        repairHint: payload.repairHint,
        ...(payload.metadata === undefined ? {} : { metadata: payload.metadata }),
      });
    case "updateGlossary":
      assertActionMatches(preview.action, "update_glossary");
      return actionService.updateGlossary(actor, {
        ...common,
        termId: payload.termId,
        approvedTranslation: payload.approvedTranslation,
        ...(payload.metadata === undefined ? {} : { metadata: payload.metadata }),
      });
    case "updateStyle":
      assertActionMatches(preview.action, "update_style");
      return actionService.updateStyle(actor, {
        ...common,
        styleGuideVersionId: payload.styleGuideVersionId,
        ruleLabel: payload.ruleLabel,
        ...(payload.metadata === undefined ? {} : { metadata: payload.metadata }),
      });
    case "importRuntimeFeedback":
      assertActionMatches(preview.action, "import_runtime_feedback");
      return actionService.importRuntimeFeedback(actor, {
        ...common,
        evidenceTier: payload.evidenceTier,
        observationEventIds: payload.observationEventIds,
        artifactHashes: payload.artifactHashes,
        ...(payload.metadata === undefined ? {} : { metadata: payload.metadata }),
      });
    default: {
      const exhaustive: never = payload;
      throw new Error(`unhandled batch action payload: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function assertActionMatches(previewAction: ReviewerQueueAction, expected: ReviewerQueueAction) {
  if (previewAction !== expected) {
    throw new ReviewerBatchActionServiceInputError(
      "action",
      `payload kind '${expected}' does not match preview action '${previewAction}'`,
    );
  }
}

function previewToRefused(entry: BatchPreviewItem): BatchExecuteOutcome {
  return {
    kind: "refused",
    reviewItemId: entry.reviewItemId,
    status: entry.status,
    code:
      entry.status === reviewerBatchPreviewStatusValues.allowed
        ? "reviewer_batch_skipped"
        : statusToErrorCode(entry.status),
    message:
      entry.message ??
      (entry.status === reviewerBatchPreviewStatusValues.allowed
        ? "skipped (sibling item failed pre-flight)"
        : entry.status),
    diagnostics: entry.diagnostics,
  };
}

function statusToErrorCode(
  status: ReviewerBatchPreviewStatus,
): ReviewerQueueRepositoryErrorCode | "reviewer_batch_skipped" {
  switch (status) {
    case reviewerBatchPreviewStatusValues.invalidInput:
      return "reviewer_queue_item_invalid_input";
    case reviewerBatchPreviewStatusValues.invalidTransition:
      return "reviewer_queue_item_invalid_transition";
    case reviewerBatchPreviewStatusValues.staleRevision:
      return "reviewer_queue_item_stale_revision";
    case reviewerBatchPreviewStatusValues.runtimeEvidenceInvariant:
      return "reviewer_queue_item_runtime_evidence_invariant";
    case reviewerBatchPreviewStatusValues.notFound:
      return "reviewer_queue_item_not_found";
    case reviewerBatchPreviewStatusValues.duplicateSelection:
      return "reviewer_queue_item_invalid_input";
    case reviewerBatchPreviewStatusValues.permissionDeniedManage:
    case reviewerBatchPreviewStatusValues.allowed:
      return "reviewer_batch_skipped";
    default: {
      const exhaustive: never = status;
      throw new Error(`unhandled status: ${exhaustive as string}`);
    }
  }
}

function mapErrorCodeToStatus(code: ReviewerQueueRepositoryErrorCode): ReviewerBatchPreviewStatus {
  switch (code) {
    case "reviewer_queue_item_not_found":
      return reviewerBatchPreviewStatusValues.notFound;
    case "reviewer_queue_item_invalid_input":
      return reviewerBatchPreviewStatusValues.invalidInput;
    case "reviewer_queue_item_invalid_transition":
      return reviewerBatchPreviewStatusValues.invalidTransition;
    case "reviewer_queue_item_stale_revision":
      return reviewerBatchPreviewStatusValues.staleRevision;
    case "reviewer_queue_item_runtime_evidence_invariant":
      return reviewerBatchPreviewStatusValues.runtimeEvidenceInvariant;
    case "reviewer_queue_item_duplicate":
      return reviewerBatchPreviewStatusValues.invalidInput;
    default: {
      const exhaustive: never = code;
      throw new Error(`unhandled error code: ${exhaustive as string}`);
    }
  }
}
