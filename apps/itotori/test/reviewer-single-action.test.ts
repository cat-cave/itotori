// ITOTORI-082 — single-item reviewer action HTTP seam (service level).
//
// The single-item action route calls ReviewerQueueApiService.actionSingleItem,
// which runs ONE item through the SAME batch preview + execute path as the
// batch route (a batch-of-one over the existing ReviewerQueueActionService).
// These tests pin that a single accept/defer/escalate transitions exactly
// one item through the action service, carries the reviewer's own inputs,
// and refuses (typed, not thrown) on unknown item / invalid transition /
// permission denial — the same closed taxonomy the batch surface uses.

import { describe, expect, it, vi } from "vitest";
import {
  reviewerQueueActionValues,
  reviewerQueueItemStateValues,
  type AuthorizationActor,
  type ReviewerQueueActionInput,
  type ReviewerQueueActionResult,
  type ReviewerQueueItemRecord,
} from "@itotori/db";
import {
  fixtureAcceptedItem,
  fixturePendingQaItem,
  ReviewerQueueApiService,
  reviewerBatchPreviewStatusValues,
  type ReviewerBatchConsequenceResolverPort,
  type ReviewerQueueActionServicePort,
  type ReviewerQueuePermissionView,
  type ReviewerSingleActionRequest,
} from "../src/reviewer/index.js";

const actor: AuthorizationActor = { userId: "reviewer-user" };

function permissionView(
  overrides: Partial<ReviewerQueuePermissionView> = {},
): ReviewerQueuePermissionView {
  return {
    actorUserId: "reviewer-user",
    canReadQueue: true,
    canManageQueue: true,
    denialReasons: [],
    ...overrides,
  };
}

function makeConsequenceResolver(
  items: Record<string, ReviewerQueueItemRecord>,
): ReviewerBatchConsequenceResolverPort {
  return {
    loadItem: async (id) => items[id] ?? null,
    resolveConsequences: async () => [],
  };
}

function nextStateForAction(
  action: ReviewerQueueActionInput["action"],
): ReviewerQueueItemRecord["state"] {
  switch (action) {
    case reviewerQueueActionValues.reject:
      return reviewerQueueItemStateValues.rejected;
    case reviewerQueueActionValues.defer:
      return reviewerQueueItemStateValues.deferred;
    case reviewerQueueActionValues.escalate:
      return reviewerQueueItemStateValues.escalated;
    default:
      return reviewerQueueItemStateValues.accepted;
  }
}

function makeActionServiceStub(items: Record<string, ReviewerQueueItemRecord>): {
  service: ReviewerQueueActionServicePort;
  applyPreparedBatch: ReturnType<typeof vi.fn>;
} {
  const applyPreparedBatch = vi.fn(
    async (
      _actor: AuthorizationActor,
      inputs: readonly ReviewerQueueActionInput[],
    ): Promise<ReviewerQueueActionResult[]> =>
      inputs.map((input) => {
        const source = items[input.reviewItemId];
        if (source === undefined) {
          throw new Error(`stub action service has no item ${input.reviewItemId}`);
        }
        const nextState = nextStateForAction(input.action);
        return {
          item: { ...source, state: nextState },
          transition: {
            transitionId: `transition-${input.reviewItemId}`,
            reviewItemId: input.reviewItemId,
            localeBranchId: source.localeBranchId,
            sourceRevisionId: source.sourceRevisionId,
            itemKind: source.itemKind,
            action: input.action,
            priorState: source.state,
            nextState,
            actorUserId: input.actorUserId,
            affectedArtifactIds: input.affectedArtifactIds ?? [],
            diagnostics: [],
            metadata: input.metadata ?? {},
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
          },
        };
      }),
  );
  const service: ReviewerQueueActionServicePort = {
    approve: vi.fn(),
    reject: vi.fn(),
    defer: vi.fn(),
    escalate: vi.fn(),
    requestRepair: vi.fn(),
    updateGlossary: vi.fn(),
    updateStyle: vi.fn(),
    importRuntimeFeedback: vi.fn(),
    applyPreparedBatch,
  } as unknown as ReviewerQueueActionServicePort;
  return { service, applyPreparedBatch };
}

function makeApiService(items: Record<string, ReviewerQueueItemRecord>): {
  api: ReviewerQueueApiService;
  applyPreparedBatch: ReturnType<typeof vi.fn>;
} {
  const { service, applyPreparedBatch } = makeActionServiceStub(items);
  const api = new ReviewerQueueApiService({
    // repository is unused when an explicit consequenceResolver + actionService
    // are supplied — the single-item path routes through both of those.
    repository: {
      loadItemsByBranch: async () => Object.values(items),
      loadTransitionsByItem: async () => [],
      getItem: async (id) => items[id] ?? null,
    },
    consequenceResolver: makeConsequenceResolver(items),
    actionService: service,
  });
  return { api, applyPreparedBatch };
}

describe("ReviewerQueueApiService.actionSingleItem", () => {
  it("accepts one pending item through the shared action service and returns the new state", async () => {
    const item = fixturePendingQaItem("reviewer-queue-single-1");
    const { api, applyPreparedBatch } = makeApiService({ [item.reviewItemId]: item });
    const request: ReviewerSingleActionRequest = {
      reviewItemId: item.reviewItemId,
      action: reviewerQueueActionValues.approve,
      actorUserId: actor.userId,
      expectedSourceRevisionId: item.sourceRevisionId,
    };

    const result = await api.actionSingleItem({ actor, request, permission: permissionView() });

    expect(result.applied).toBe(true);
    expect(result.refused).toBe(false);
    expect(result.outcome.kind).toBe("applied");
    if (result.outcome.kind === "applied") {
      expect(result.outcome.reviewItemId).toBe(item.reviewItemId);
      expect(result.outcome.result.transition.nextState).toBe(
        reviewerQueueItemStateValues.accepted,
      );
      expect(result.outcome.result.item.state).toBe(reviewerQueueItemStateValues.accepted);
    }
    // One item, one prepared action through the existing batch write path.
    expect(applyPreparedBatch).toHaveBeenCalledTimes(1);
    const [, inputs] = applyPreparedBatch.mock.calls[0] as [
      AuthorizationActor,
      ReviewerQueueActionInput[],
    ];
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.reviewItemId).toBe(item.reviewItemId);
    expect(inputs[0]?.action).toBe(reviewerQueueActionValues.approve);
  });

  it("carries a reviewer-supplied defer reason into the prepared action input", async () => {
    const item = fixturePendingQaItem("reviewer-queue-single-2");
    const { api, applyPreparedBatch } = makeApiService({ [item.reviewItemId]: item });
    const request: ReviewerSingleActionRequest = {
      reviewItemId: item.reviewItemId,
      action: reviewerQueueActionValues.defer,
      actorUserId: actor.userId,
      expectedSourceRevisionId: item.sourceRevisionId,
      deferReason: "waiting on runtime evidence",
    };

    const result = await api.actionSingleItem({ actor, request, permission: permissionView() });

    expect(result.applied).toBe(true);
    if (result.outcome.kind === "applied") {
      expect(result.outcome.result.transition.nextState).toBe(
        reviewerQueueItemStateValues.deferred,
      );
    }
    const [, inputs] = applyPreparedBatch.mock.calls[0] as [
      AuthorizationActor,
      ReviewerQueueActionInput[],
    ];
    expect(inputs[0]?.metadata).toMatchObject({ deferReason: "waiting on runtime evidence" });
  });

  it("escalates one item, carrying the reviewer's escalation reason + target", async () => {
    const item = fixturePendingQaItem("reviewer-queue-single-3");
    const { api, applyPreparedBatch } = makeApiService({ [item.reviewItemId]: item });
    const request: ReviewerSingleActionRequest = {
      reviewItemId: item.reviewItemId,
      action: reviewerQueueActionValues.escalate,
      actorUserId: actor.userId,
      expectedSourceRevisionId: item.sourceRevisionId,
      escalationReason: "ambiguous honorific",
      escalationTarget: "senior-reviewer",
    };

    const result = await api.actionSingleItem({ actor, request, permission: permissionView() });

    expect(result.applied).toBe(true);
    if (result.outcome.kind === "applied") {
      expect(result.outcome.result.transition.nextState).toBe(
        reviewerQueueItemStateValues.escalated,
      );
    }
    const [, inputs] = applyPreparedBatch.mock.calls[0] as [
      AuthorizationActor,
      ReviewerQueueActionInput[],
    ];
    expect(inputs[0]?.metadata).toMatchObject({
      escalationReason: "ambiguous honorific",
      escalationTarget: "senior-reviewer",
    });
  });

  it("refuses an unknown item as not_found without writing", async () => {
    const item = fixturePendingQaItem("reviewer-queue-single-known");
    const { api, applyPreparedBatch } = makeApiService({ [item.reviewItemId]: item });
    const request: ReviewerSingleActionRequest = {
      reviewItemId: "reviewer-queue-single-missing",
      action: reviewerQueueActionValues.approve,
      actorUserId: actor.userId,
      expectedSourceRevisionId: item.sourceRevisionId,
    };

    const result = await api.actionSingleItem({ actor, request, permission: permissionView() });

    expect(result.refused).toBe(true);
    expect(result.outcome.kind).toBe("refused");
    if (result.outcome.kind === "refused") {
      expect(result.outcome.status).toBe(reviewerBatchPreviewStatusValues.notFound);
    }
    expect(applyPreparedBatch).not.toHaveBeenCalled();
  });

  it("refuses an already-actioned item as an invalid transition without writing", async () => {
    const item = fixtureAcceptedItem("reviewer-queue-single-done");
    const { api, applyPreparedBatch } = makeApiService({ [item.reviewItemId]: item });
    const request: ReviewerSingleActionRequest = {
      reviewItemId: item.reviewItemId,
      action: reviewerQueueActionValues.approve,
      actorUserId: actor.userId,
      expectedSourceRevisionId: item.sourceRevisionId,
    };

    const result = await api.actionSingleItem({ actor, request, permission: permissionView() });

    expect(result.refused).toBe(true);
    if (result.outcome.kind === "refused") {
      expect(result.outcome.status).toBe(reviewerBatchPreviewStatusValues.invalidTransition);
    }
    expect(applyPreparedBatch).not.toHaveBeenCalled();
  });

  it("refuses a single action when the actor lacks queue.manage", async () => {
    const item = fixturePendingQaItem("reviewer-queue-single-authz");
    const { api, applyPreparedBatch } = makeApiService({ [item.reviewItemId]: item });
    const request: ReviewerSingleActionRequest = {
      reviewItemId: item.reviewItemId,
      action: reviewerQueueActionValues.approve,
      actorUserId: actor.userId,
      expectedSourceRevisionId: item.sourceRevisionId,
    };

    const result = await api.actionSingleItem({
      actor,
      request,
      permission: permissionView({
        canManageQueue: false,
        denialReasons: ["user reviewer-user is missing permission queue.manage"],
      }),
    });

    expect(result.refused).toBe(true);
    if (result.outcome.kind === "refused") {
      expect(result.outcome.status).toBe(reviewerBatchPreviewStatusValues.permissionDeniedManage);
    }
    expect(applyPreparedBatch).not.toHaveBeenCalled();
  });
});
