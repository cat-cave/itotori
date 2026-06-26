// ITOTORI-083 — Atomic batch execution tests.
//
// The executor calls the preview service first; if any item refuses,
// NO writes happen. Otherwise per-item dispatch through the existing
// ReviewerQueueActionService (ITOTORI-081). Each dispatch is observed
// via a stub action service so failure modes (concurrent move,
// permission denial, etc.) can be simulated.

import { describe, expect, it, vi } from "vitest";
import {
  ReviewerQueueRepositoryError,
  reviewerQueueActionValues,
  reviewerQueueItemKindValues,
  reviewerQueueItemStateValues,
  type AuthorizationActor,
  type ItotoriReviewerQueueRepositoryPort,
  type JobQueueInput,
  type ReviewerQueueActionInput,
  type ReviewerQueueActionJobPlanner,
  type ReviewerQueueActionResult,
  type ReviewerQueueItemRecord,
} from "@itotori/db";
import {
  fixtureBatchPermissionView,
  fixturePendingGlossaryItem,
  fixturePendingQaItem,
  fixturePendingRuntimeEvidenceItem,
  fixtureRerunJobConsequence,
  itotori083FixtureSourceRevisionId,
  ReviewerBatchActionService,
  ReviewerBatchActionServiceInputError,
  ReviewerBatchPreviewService,
  ReviewerQueueActionService,
  reviewerBatchPreviewStatusValues,
  reviewerTriggeredRerunJobNameValues,
  type BatchActionPayload,
  type BatchActionPayloadResolver,
  type ReviewerBatchActionRequest,
  type ReviewerBatchConsequenceResolverPort,
  type ReviewerQueueActionServicePort,
} from "../src/reviewer/index.js";

const actor: AuthorizationActor = { userId: "local-user" };

function makeResolver(
  items: Record<string, ReviewerQueueItemRecord>,
): ReviewerBatchConsequenceResolverPort {
  return {
    loadItem: async (id) => items[id] ?? null,
    resolveConsequences: async (input) => [fixtureRerunJobConsequence(input.item.reviewItemId)],
  };
}

function makeActionStub(): {
  service: ReviewerQueueActionServicePort;
  calls: Array<{ method: string; reviewItemId: string }>;
} {
  const calls: Array<{ method: string; reviewItemId: string }> = [];
  const record = (method: string, reviewItemId: string): ReviewerQueueActionResult => {
    calls.push({ method, reviewItemId });
    const item: ReviewerQueueItemRecord = {
      reviewItemId,
      projectId: "p",
      localeBranchId: "b",
      sourceRevisionId: itotori083FixtureSourceRevisionId,
      itemKind: reviewerQueueItemKindValues.qa,
      sourceItemRef: `ref-${reviewItemId}`,
      state: reviewerQueueItemStateValues.accepted,
      priority: 0,
      summary: "stub",
      affectedArtifactIds: [],
      evidenceTier: null,
      observationEventIds: null,
      artifactHashes: null,
      payload: {},
      metadata: {},
      createdByUserId: null,
      assignedToUserId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      resolvedAt: new Date(),
    };
    return {
      item,
      transition: {
        transitionId: `t-${reviewItemId}`,
        reviewItemId,
        localeBranchId: item.localeBranchId,
        sourceRevisionId: item.sourceRevisionId,
        itemKind: item.itemKind,
        action: reviewerQueueActionValues.approve,
        priorState: reviewerQueueItemStateValues.pending,
        nextState: reviewerQueueItemStateValues.accepted,
        actorUserId: actor.userId,
        affectedArtifactIds: [],
        diagnostics: [],
        metadata: {},
        createdAt: new Date(),
      },
    };
  };
  const service: ReviewerQueueActionServicePort = {
    approve: vi.fn(async (_actor, input) => record("approve", input.reviewItemId)),
    reject: vi.fn(async (_actor, input) => record("reject", input.reviewItemId)),
    requestRepair: vi.fn(async (_actor, input) => record("requestRepair", input.reviewItemId)),
    updateGlossary: vi.fn(async (_actor, input) => record("updateGlossary", input.reviewItemId)),
    updateStyle: vi.fn(async (_actor, input) => record("updateStyle", input.reviewItemId)),
    importRuntimeFeedback: vi.fn(async (_actor, input) =>
      record("importRuntimeFeedback", input.reviewItemId),
    ),
  };
  return { service, calls };
}

const approvePayload: BatchActionPayloadResolver = () => ({ kind: "approve" });

describe("ReviewerBatchActionService — happy path", () => {
  it("dispatches one action per item when every preview row is allowed", async () => {
    const qa1 = fixturePendingQaItem("reviewer-queue-083-qa-1");
    const qa2 = fixturePendingQaItem("reviewer-queue-083-qa-2");
    const previewService = new ReviewerBatchPreviewService(
      makeResolver({ [qa1.reviewItemId]: qa1, [qa2.reviewItemId]: qa2 }),
    );
    const { service: actionService, calls } = makeActionStub();
    const executor = new ReviewerBatchActionService({
      previewService,
      actionService,
      resolvePayload: approvePayload,
    });
    const request: ReviewerBatchActionRequest = {
      action: reviewerQueueActionValues.approve,
      actorUserId: actor.userId,
      selections: [
        { reviewItemId: qa1.reviewItemId, expectedSourceRevisionId: qa1.sourceRevisionId },
        { reviewItemId: qa2.reviewItemId, expectedSourceRevisionId: qa2.sourceRevisionId },
      ],
    };

    const result = await executor.execute(actor, request, fixtureBatchPermissionView());

    expect(result.appliedAll).toBe(true);
    expect(result.refusedAll).toBe(false);
    expect(result.applied.length).toBe(2);
    expect(result.applied.every((entry) => entry.kind === "applied")).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(["approve", "approve"]);
    expect(calls.map((c) => c.reviewItemId)).toEqual([qa1.reviewItemId, qa2.reviewItemId]);
  });

  it("uses the real reviewer action service path that plans rerun jobs atomically", async () => {
    const qa = fixturePendingQaItem("reviewer-queue-083-qa-rerun");
    const previewService = new ReviewerBatchPreviewService(makeResolver({ [qa.reviewItemId]: qa }));
    const plannedJobs: JobQueueInput[] = [];
    const repo = makeAtomicActionRepo(plannedJobs);
    const actionService = new ReviewerQueueActionService(repo);
    const executor = new ReviewerBatchActionService({
      previewService,
      actionService,
      resolvePayload: () => ({ kind: "requestRepair", repairHint: "refresh affected draft" }),
    });

    const result = await executor.execute(
      actor,
      {
        action: reviewerQueueActionValues.requestRepair,
        actorUserId: actor.userId,
        selections: [
          { reviewItemId: qa.reviewItemId, expectedSourceRevisionId: qa.sourceRevisionId },
        ],
      },
      fixtureBatchPermissionView(),
    );

    expect(result.appliedAll).toBe(true);
    expect(plannedJobs.map((job) => job.jobName)).toEqual([
      reviewerTriggeredRerunJobNameValues.draftRepair,
      reviewerTriggeredRerunJobNameValues.qaReplay,
      reviewerTriggeredRerunJobNameValues.exportRegeneration,
      reviewerTriggeredRerunJobNameValues.runtimeValidation,
    ]);
  });
});

describe("ReviewerBatchActionService — atomic pre-flight", () => {
  it("fails closed and writes zero rows when any preview row would refuse", async () => {
    const qa = fixturePendingQaItem("reviewer-queue-083-qa-1");
    const stale = fixturePendingQaItem("reviewer-queue-083-stale-1");
    const previewService = new ReviewerBatchPreviewService(
      makeResolver({ [qa.reviewItemId]: qa, [stale.reviewItemId]: stale }),
    );
    const { service: actionService, calls } = makeActionStub();
    const executor = new ReviewerBatchActionService({
      previewService,
      actionService,
      resolvePayload: approvePayload,
    });
    const request: ReviewerBatchActionRequest = {
      action: reviewerQueueActionValues.approve,
      actorUserId: actor.userId,
      selections: [
        { reviewItemId: qa.reviewItemId, expectedSourceRevisionId: qa.sourceRevisionId },
        {
          reviewItemId: stale.reviewItemId,
          // Mismatch triggers stale_revision in the preview.
          expectedSourceRevisionId: "source-revision-newer",
        },
      ],
    };

    const result = await executor.execute(actor, request, fixtureBatchPermissionView());

    expect(result.appliedAll).toBe(false);
    expect(result.refusedAll).toBe(true);
    expect(calls.length).toBe(0);
    expect(result.applied.every((entry) => entry.kind === "refused")).toBe(true);
    expect(result.applied[1]?.kind === "refused" && result.applied[1].status).toBe(
      reviewerBatchPreviewStatusValues.staleRevision,
    );
  });

  it("refuses every row when the actor lacks queue.manage", async () => {
    const qa = fixturePendingQaItem("reviewer-queue-083-qa-1");
    const previewService = new ReviewerBatchPreviewService(makeResolver({ [qa.reviewItemId]: qa }));
    const { service: actionService, calls } = makeActionStub();
    const executor = new ReviewerBatchActionService({
      previewService,
      actionService,
      resolvePayload: approvePayload,
    });
    const result = await executor.execute(
      actor,
      {
        action: reviewerQueueActionValues.approve,
        actorUserId: actor.userId,
        selections: [
          { reviewItemId: qa.reviewItemId, expectedSourceRevisionId: qa.sourceRevisionId },
        ],
      },
      fixtureBatchPermissionView({ canManageQueue: false }),
    );

    expect(result.refusedAll).toBe(true);
    expect(calls.length).toBe(0);
    expect(result.applied[0]?.kind === "refused" && result.applied[0].status).toBe(
      reviewerBatchPreviewStatusValues.permissionDeniedManage,
    );
  });
});

describe("ReviewerBatchActionService — per-item dispatch surfaces repository diagnostics", () => {
  it("captures a ReviewerQueueRepositoryError thrown by the action service as a per-item refusal", async () => {
    const qa1 = fixturePendingQaItem("reviewer-queue-083-qa-1");
    const qa2 = fixturePendingQaItem("reviewer-queue-083-qa-2");
    const previewService = new ReviewerBatchPreviewService(
      makeResolver({ [qa1.reviewItemId]: qa1, [qa2.reviewItemId]: qa2 }),
    );
    const { service: actionService } = makeActionStub();
    let count = 0;
    actionService.approve = vi.fn(async (_a, input) => {
      count += 1;
      if (count === 1) {
        return makeResult(input.reviewItemId);
      }
      // Simulate a concurrent move on the second item: the preview
      // saw it pending, but by the time we dispatched another writer
      // had moved it.
      throw new ReviewerQueueRepositoryError(
        "reviewer_queue_item_invalid_transition",
        `reviewer queue item ${input.reviewItemId} state changed concurrently; please retry with a fresh fetch`,
      );
    });
    const executor = new ReviewerBatchActionService({
      previewService,
      actionService,
      resolvePayload: approvePayload,
    });

    const result = await executor.execute(
      actor,
      {
        action: reviewerQueueActionValues.approve,
        actorUserId: actor.userId,
        selections: [
          { reviewItemId: qa1.reviewItemId, expectedSourceRevisionId: qa1.sourceRevisionId },
          { reviewItemId: qa2.reviewItemId, expectedSourceRevisionId: qa2.sourceRevisionId },
        ],
      },
      fixtureBatchPermissionView(),
    );

    expect(result.appliedAll).toBe(false);
    expect(result.applied[0]?.kind).toBe("applied");
    expect(result.applied[1]?.kind === "refused" && result.applied[1].status).toBe(
      reviewerBatchPreviewStatusValues.invalidTransition,
    );
  });
});

describe("ReviewerBatchActionService — payload resolver dispatch", () => {
  it("dispatches updateGlossary with termId + approvedTranslation for glossary items", async () => {
    const item = fixturePendingGlossaryItem();
    const previewService = new ReviewerBatchPreviewService(
      makeResolver({ [item.reviewItemId]: item }),
    );
    const { service: actionService } = makeActionStub();
    const executor = new ReviewerBatchActionService({
      previewService,
      actionService,
      resolvePayload: () => ({
        kind: "updateGlossary",
        termId: "term-42",
        approvedTranslation: "Hero",
      }),
    });

    const result = await executor.execute(
      actor,
      {
        action: reviewerQueueActionValues.updateGlossary,
        actorUserId: actor.userId,
        selections: [
          { reviewItemId: item.reviewItemId, expectedSourceRevisionId: item.sourceRevisionId },
        ],
      },
      fixtureBatchPermissionView(),
    );

    expect(result.appliedAll).toBe(true);
    expect(actionService.updateGlossary).toHaveBeenCalledTimes(1);
  });

  it("dispatches importRuntimeFeedback with evidence tier + observation events", async () => {
    const item = fixturePendingRuntimeEvidenceItem();
    const previewService = new ReviewerBatchPreviewService(
      makeResolver({ [item.reviewItemId]: item }),
    );
    const { service: actionService } = makeActionStub();
    const executor = new ReviewerBatchActionService({
      previewService,
      actionService,
      resolvePayload: (loaded) => ({
        kind: "importRuntimeFeedback",
        evidenceTier: loaded.evidenceTier ?? "tier-2-trace",
        observationEventIds: loaded.observationEventIds ?? ["observation-fallback-1"],
        artifactHashes: loaded.artifactHashes ?? ["sha256:fallback"],
      }),
    });

    const result = await executor.execute(
      actor,
      {
        action: reviewerQueueActionValues.importRuntimeFeedback,
        actorUserId: actor.userId,
        selections: [
          { reviewItemId: item.reviewItemId, expectedSourceRevisionId: item.sourceRevisionId },
        ],
      },
      fixtureBatchPermissionView(),
    );

    expect(result.appliedAll).toBe(true);
    expect(actionService.importRuntimeFeedback).toHaveBeenCalledTimes(1);
  });

  it("refuses when the payload kind does not match the preview action", async () => {
    const item = fixturePendingQaItem();
    const previewService = new ReviewerBatchPreviewService(
      makeResolver({ [item.reviewItemId]: item }),
    );
    const { service: actionService } = makeActionStub();
    const executor = new ReviewerBatchActionService({
      previewService,
      actionService,
      // Returns a reject payload, but request says approve.
      resolvePayload: () => ({ kind: "reject" }) satisfies BatchActionPayload,
    });

    await expect(
      executor.execute(
        actor,
        {
          action: reviewerQueueActionValues.approve,
          actorUserId: actor.userId,
          selections: [
            { reviewItemId: item.reviewItemId, expectedSourceRevisionId: item.sourceRevisionId },
          ],
        },
        fixtureBatchPermissionView(),
      ),
    ).rejects.toBeInstanceOf(ReviewerBatchActionServiceInputError);
  });
});

function makeResult(reviewItemId: string): ReviewerQueueActionResult {
  const item: ReviewerQueueItemRecord = {
    reviewItemId,
    projectId: "p",
    localeBranchId: "b",
    sourceRevisionId: itotori083FixtureSourceRevisionId,
    itemKind: reviewerQueueItemKindValues.qa,
    sourceItemRef: `ref-${reviewItemId}`,
    state: reviewerQueueItemStateValues.accepted,
    priority: 0,
    summary: "stub",
    affectedArtifactIds: [],
    evidenceTier: null,
    observationEventIds: null,
    artifactHashes: null,
    payload: {},
    metadata: {},
    createdByUserId: null,
    assignedToUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    resolvedAt: new Date(),
  };
  return {
    item,
    transition: {
      transitionId: `t-${reviewItemId}`,
      reviewItemId,
      localeBranchId: item.localeBranchId,
      sourceRevisionId: item.sourceRevisionId,
      itemKind: item.itemKind,
      action: reviewerQueueActionValues.approve,
      priorState: reviewerQueueItemStateValues.pending,
      nextState: reviewerQueueItemStateValues.accepted,
      actorUserId: actor.userId,
      affectedArtifactIds: [],
      diagnostics: [],
      metadata: {},
      createdAt: new Date(),
    },
  };
}

function makeAtomicActionRepo(plannedJobs: JobQueueInput[]): ItotoriReviewerQueueRepositoryPort {
  return {
    createItem: vi.fn(),
    applyAction: vi.fn(),
    applyActionAndEnqueueJobs: vi.fn(
      async (
        actor: AuthorizationActor,
        input: ReviewerQueueActionInput,
        planJobs: ReviewerQueueActionJobPlanner,
      ) => {
        const actionResult = makeResult(input.reviewItemId);
        actionResult.transition.action = input.action;
        actionResult.transition.actorUserId = actor.userId;
        actionResult.transition.metadata = input.metadata ?? {};
        actionResult.transition.affectedArtifactIds = input.affectedArtifactIds ?? [];
        plannedJobs.push(...(await planJobs(actionResult)));
        return { actionResult, jobs: [] };
      },
    ),
    getItem: vi.fn(),
    loadItemsByBranch: vi.fn(),
    loadTransitionsByItem: vi.fn(),
  };
}
