// ITOTORI-083 — Atomic batch reviewer action executor.
//
// Takes a `ReviewerBatchActionRequest` + the preview that was shown to
// the reviewer, then applies every selected item's action through the
// existing `ReviewerQueueActionService` (ITOTORI-081). If ANY selected
// item would refuse on its preview, the entire batch fails closed and
// NO items are mutated — preserves the "fail closed for denied / stale
// items; no partial writes" acceptance.
//
// Atomicity is all-or-nothing at the repository layer, NOT a per-item
// best-effort loop. The executor reruns the shared transition validator
// over a fresh load of each item BEFORE writing anything, refuses the
// whole batch if any fails, and only then hands the prepared inputs to
// `actionService.applyPreparedBatch`. That call wraps every per-item
// UPDATE + transition INSERT in a SINGLE database transaction
// (`ReviewerQueueRepository.applyActionsAndEnqueueJobs`): the whole
// batch commits together or rolls back together. There is no window in
// which items 0..k-1 stay persisted while item k refuses.
//
// Consequently a concurrent move on any single item rejects the entire
// transaction. The repository rolls back the already-attempted writes,
// and the executor catches the `ReviewerQueueRepositoryError` and
// reports EVERY requested id as refused with `refusedAll: true`. The
// dashboard never sees a partial batch: it is either all-applied or
// all-refused. The repository-layer rollback is proven directly by
// "applyActionsAndEnqueueJobs rolls back all reviewer transitions when
// a later action is stale" in reviewer-queue-repository.test.ts; the
// executor-layer all-refused reporting is proven by the atomic-batch
// tests in reviewer-batch-execute.test.ts.
//
// Audit focus addressed:
//  - "Batch actions bypassing single-action state machine": every
//    write goes through `ReviewerQueueActionService` — the same path
//    the single-action UI uses (ITOTORI-082).
//  - "Partial batch writes without item diagnostics": when the
//    pre-flight validator refuses any item, NO writes happen; the
//    result carries per-item diagnostics for every requested id.
//  - "Atomicity claim weaker than no-partial-writes": a mid-batch
//    repository refusal rolls back the whole transaction, so there are
//    no already-written transitions to recover; the executor surfaces
//    zero "applied" outcomes and refuses the entire batch.
//  - "Consequence preview disagreeing with execution": the executor
//    re-runs the SAME validator on a fresh load. If the freshly loaded
//    item disagrees with the preview (e.g. someone else moved the
//    item), the executor refuses, reports per-item, and skips all
//    writes.

import {
  reviewerQueueActionValues,
  type ReviewerQueueActionInput,
  type ReviewerQueueAction,
  type ReviewerQueueActionResult,
  type ReviewerQueueDiagnostic,
  type ReviewerQueueItemRecord,
  type ReviewerQueueRepositoryErrorCode,
  ReviewerQueueRepositoryError,
} from "@itotori/db";
import type { AuthorizationActor } from "@itotori/db";
import type {
  ReviewerQueueActionServicePort,
  ReviewerQueueDecisionContextRefs,
} from "./action-service.js";
import {
  assertImportRuntimeFeedbackMatchesPersisted,
  buildReviewerQueueActionInput,
} from "./action-service.js";
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
   * refused any item, the permission view denied manage, or the atomic
   * `applyPreparedBatch` transaction rejected and rolled back — in
   * which case the entire batch is reported refused (no partial writes).
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
  | { kind: "defer"; deferReason: string; metadata?: Record<string, unknown> }
  | {
      kind: "escalate";
      escalationReason: string;
      escalationTarget: string;
      metadata?: Record<string, unknown>;
    }
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

    const contextRefRefusals = preflightDecisionContextRefs(preview.items);
    if (contextRefRefusals !== null) {
      return {
        request,
        preview,
        applied: contextRefRefusals,
        refusedAll: true,
        appliedAll: false,
      };
    }

    const preparedActions: Array<{
      entry: BatchPreviewItem;
      input: ReviewerQueueActionInput;
    }> = [];
    for (const entry of preview.items) {
      const item = entry.item;
      if (item === null) {
        // Defensive: preview.allAllowed should already have caught
        // this. Refuse the whole batch before any writes.
        return {
          request,
          preview,
          applied: preview.items.map((row) => previewToRefused(row)),
          refusedAll: true,
          appliedAll: false,
        };
      }
      const payload = this.deps.resolvePayload(item);
      preparedActions.push({
        entry,
        input: buildPreparedActionInput(actor, item, entry, payload),
      });
    }

    let results: ReviewerQueueActionResult[];
    try {
      results = await this.deps.actionService.applyPreparedBatch(
        actor,
        preparedActions.map((entry) => entry.input),
      );
    } catch (error) {
      if (error instanceof ReviewerQueueRepositoryError) {
        return {
          request,
          preview,
          applied: preview.items.map((entry) => repositoryErrorToRefused(entry, error)),
          refusedAll: true,
          appliedAll: false,
        };
      }
      throw error;
    }

    return {
      request,
      preview,
      applied: results.map((result, index) => ({
        kind: "applied" as const,
        reviewItemId: preparedActions[index]?.entry.reviewItemId ?? result.item.reviewItemId,
        result,
      })),
      refusedAll: false,
      appliedAll: true,
    };
  }
}

function preflightDecisionContextRefs(
  items: readonly BatchPreviewItem[],
): BatchExecuteOutcome[] | null {
  const invalidIds = new Set<string>();
  for (const entry of items) {
    if (
      entry.item !== null &&
      !isDecisionContextRefs((entry.item.metadata as { contextRefs?: unknown }).contextRefs)
    ) {
      invalidIds.add(entry.reviewItemId);
    }
  }
  if (invalidIds.size === 0) {
    return null;
  }
  return items.map((entry) => {
    if (!invalidIds.has(entry.reviewItemId)) {
      return previewToRefused(entry);
    }
    return {
      kind: "refused" as const,
      reviewItemId: entry.reviewItemId,
      status: reviewerBatchPreviewStatusValues.invalidInput,
      code: "reviewer_queue_item_invalid_input" as const,
      message: `reviewer queue item ${entry.reviewItemId} is missing typed decision context refs`,
      diagnostics: [
        {
          code: "reviewer_batch_missing_context_refs",
          message:
            "batch reviewer actions require source, draft, runtime, style, glossary, and QA context refs before mutation",
        },
      ],
    };
  });
}

function buildPreparedActionInput(
  actor: AuthorizationActor,
  item: ReviewerQueueItemRecord,
  preview: BatchPreviewItem,
  payload: BatchActionPayload,
): ReviewerQueueActionInput {
  const common = {
    reviewItemId: item.reviewItemId,
    actorUserId: actor.userId,
    expectedSourceRevisionId: preview.expectedSourceRevisionId,
    contextRefs: contextRefsFromItem(item),
  };
  switch (payload.kind) {
    case "approve":
      assertActionMatches(preview.action, "approve");
      return buildReviewerQueueActionInput(
        {
          ...common,
          ...(payload.metadata === undefined ? {} : { metadata: payload.metadata }),
        },
        reviewerQueueActionValues.approve,
      );
    case "reject":
      assertActionMatches(preview.action, "reject");
      return buildReviewerQueueActionInput(
        {
          ...common,
          ...(payload.metadata === undefined ? {} : { metadata: payload.metadata }),
        },
        reviewerQueueActionValues.reject,
      );
    case "defer":
      assertActionMatches(preview.action, "defer");
      assertNonEmptyPayload("deferReason", payload.deferReason);
      return buildReviewerQueueActionInput(
        {
          ...common,
          ...(payload.metadata === undefined ? {} : { metadata: payload.metadata }),
        },
        reviewerQueueActionValues.defer,
        { deferReason: payload.deferReason },
      );
    case "escalate":
      assertActionMatches(preview.action, "escalate");
      assertNonEmptyPayload("escalationReason", payload.escalationReason);
      assertNonEmptyPayload("escalationTarget", payload.escalationTarget);
      return buildReviewerQueueActionInput(
        {
          ...common,
          ...(payload.metadata === undefined ? {} : { metadata: payload.metadata }),
        },
        reviewerQueueActionValues.escalate,
        {
          escalationReason: payload.escalationReason,
          escalationTarget: payload.escalationTarget,
        },
      );
    case "requestRepair":
      assertActionMatches(preview.action, "request_repair");
      assertNonEmptyPayload("repairHint", payload.repairHint);
      return buildReviewerQueueActionInput(
        {
          ...common,
          ...(payload.metadata === undefined ? {} : { metadata: payload.metadata }),
        },
        reviewerQueueActionValues.requestRepair,
        { repairHint: payload.repairHint },
      );
    case "updateGlossary":
      assertActionMatches(preview.action, "update_glossary");
      assertNonEmptyPayload("termId", payload.termId);
      assertNonEmptyPayload("approvedTranslation", payload.approvedTranslation);
      return buildReviewerQueueActionInput(
        {
          ...common,
          ...(payload.metadata === undefined ? {} : { metadata: payload.metadata }),
        },
        reviewerQueueActionValues.updateGlossary,
        {
          termId: payload.termId,
          approvedTranslation: payload.approvedTranslation,
        },
      );
    case "updateStyle":
      assertActionMatches(preview.action, "update_style");
      assertNonEmptyPayload("styleGuideVersionId", payload.styleGuideVersionId);
      assertNonEmptyPayload("ruleLabel", payload.ruleLabel);
      return buildReviewerQueueActionInput(
        {
          ...common,
          ...(payload.metadata === undefined ? {} : { metadata: payload.metadata }),
        },
        reviewerQueueActionValues.updateStyle,
        {
          styleGuideVersionId: payload.styleGuideVersionId,
          ruleLabel: payload.ruleLabel,
        },
      );
    case "importRuntimeFeedback":
      assertActionMatches(preview.action, "import_runtime_feedback");
      assertNonEmptyPayload("evidenceTier", payload.evidenceTier);
      assertNonEmptyPayloadArray("observationEventIds", payload.observationEventIds);
      assertNonEmptyPayloadArray("artifactHashes", payload.artifactHashes);
      // SECURITY (persisted-vs-supplied evidence): the batch surface must
      // enforce the SAME check as the single `importRuntimeFeedback` path
      // (action-service.ts). The freshly loaded `item` carries the
      // authoritative persisted tier + observation/artifact refs; reject
      // any batch item that supplies evidence which does not match, so a
      // batch caller cannot forge/substitute evidence or drift the
      // recorded tier. Byte-identical enforcement via the shared helper —
      // no divergence. Thrown before any writes → fail closed.
      assertImportRuntimeFeedbackMatchesPersisted(item, {
        evidenceTier: payload.evidenceTier,
        observationEventIds: payload.observationEventIds,
        artifactHashes: payload.artifactHashes,
      });
      return buildReviewerQueueActionInput(
        {
          ...common,
          ...(payload.metadata === undefined ? {} : { metadata: payload.metadata }),
        },
        reviewerQueueActionValues.importRuntimeFeedback,
        {
          evidenceTier: payload.evidenceTier,
          observationEventIds: payload.observationEventIds,
          artifactHashes: payload.artifactHashes,
        },
      );
    default: {
      const exhaustive: never = payload;
      throw new Error(`unhandled batch action payload: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function assertNonEmptyPayload(field: string, value: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new ReviewerBatchActionServiceInputError(field, `${field} must be a non-empty string`);
  }
}

function assertNonEmptyPayloadArray(field: string, value: ReadonlyArray<string>): void {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isNonEmptyString)) {
    throw new ReviewerBatchActionServiceInputError(
      field,
      `${field} must contain only non-empty strings`,
    );
  }
}

function repositoryErrorToRefused(
  entry: BatchPreviewItem,
  error: ReviewerQueueRepositoryError,
): BatchExecuteOutcome {
  return {
    kind: "refused",
    reviewItemId: entry.reviewItemId,
    status: mapErrorCodeToStatus(error.code),
    code: error.code,
    message: error.message,
    diagnostics: error.diagnostics,
  };
}

function contextRefsFromItem(item: ReviewerQueueItemRecord): ReviewerQueueDecisionContextRefs {
  const contextRefs = (item.metadata as { contextRefs?: unknown }).contextRefs;
  if (!isDecisionContextRefs(contextRefs)) {
    throw new ReviewerBatchActionServiceInputError(
      "contextRefs",
      `reviewer queue item ${item.reviewItemId} is missing typed decision context refs`,
    );
  }
  return contextRefs;
}

function isDecisionContextRefs(value: unknown): value is ReviewerQueueDecisionContextRefs {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as ReviewerQueueDecisionContextRefs;
  return (
    isNonEmptyString(record.source?.bridgeUnitId) &&
    isNonEmptyString(record.source?.sourceUnitKey) &&
    isNonEmptyString(record.source?.sourceRevisionId) &&
    isNonEmptyString(record.draft?.draftId) &&
    isNonEmptyString(record.draft?.draftAttemptId) &&
    isNonEmptyString(record.runtime?.runtimeTargetId) &&
    isNonEmptyStringArray(record.runtime?.observationEventIds) &&
    isNonEmptyStringArray(record.runtime?.artifactHashes) &&
    isNonEmptyString(record.style?.styleGuidePolicyVersionId) &&
    isNonEmptyStringArray(record.glossary?.termIds) &&
    isNonEmptyStringArray(record.qa?.findingIds)
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
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
    case reviewerBatchPreviewStatusValues.concurrentModification:
      return "reviewer_queue_item_concurrent_modification";
    case reviewerBatchPreviewStatusValues.staleRevision:
      return "reviewer_queue_item_stale_revision";
    case reviewerBatchPreviewStatusValues.runtimeEvidenceInvariant:
      return "reviewer_queue_item_runtime_evidence_invariant";
    case reviewerBatchPreviewStatusValues.notFound:
      return "reviewer_queue_item_not_found";
    case reviewerBatchPreviewStatusValues.duplicateSelection:
      return "reviewer_queue_item_invalid_input";
    case reviewerBatchPreviewStatusValues.permissionDeniedRead:
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
    case "reviewer_queue_item_stale_lease":
      return reviewerBatchPreviewStatusValues.invalidInput;
    case "reviewer_queue_item_invalid_transition":
      return reviewerBatchPreviewStatusValues.invalidTransition;
    case "reviewer_queue_item_concurrent_modification":
      return reviewerBatchPreviewStatusValues.concurrentModification;
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
