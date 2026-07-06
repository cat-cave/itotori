// ITOTORI-083 — Atomic batch execution tests.
//
// The executor calls the preview service first; if any item refuses,
// NO writes happen. Otherwise the prepared inputs are applied as a
// single atomic batch through ReviewerQueueActionService.applyPreparedBatch
// (ITOTORI-081), which the repository runs in one DB transaction. The
// batch is all-or-nothing: a mid-batch refusal rolls back every write
// and the executor reports the whole batch as refused — there are no
// partial writes. Failure modes (concurrent move, permission denial,
// etc.) are simulated via a stub action service.

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
  ReviewerQueueActionServiceInputError,
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
    defer: vi.fn(async (_actor, input) => record("defer", input.reviewItemId)),
    escalate: vi.fn(async (_actor, input) => record("escalate", input.reviewItemId)),
    requestRepair: vi.fn(async (_actor, input) => record("requestRepair", input.reviewItemId)),
    updateGlossary: vi.fn(async (_actor, input) => record("updateGlossary", input.reviewItemId)),
    updateStyle: vi.fn(async (_actor, input) => record("updateStyle", input.reviewItemId)),
    importRuntimeFeedback: vi.fn(async (_actor, input) =>
      record("importRuntimeFeedback", input.reviewItemId),
    ),
    applyPreparedBatch: vi.fn(async (_actor, inputs) =>
      inputs.map((input) => {
        const result = record(methodForAction(input.action), input.reviewItemId);
        result.transition.action = input.action;
        result.transition.metadata = input.metadata ?? {};
        result.transition.affectedArtifactIds = input.affectedArtifactIds ?? [];
        return result;
      }),
    ),
  };
  return { service, calls };
}

function methodForAction(action: ReviewerQueueActionInput["action"]): string {
  switch (action) {
    case reviewerQueueActionValues.approve:
      return "approve";
    case reviewerQueueActionValues.reject:
      return "reject";
    case reviewerQueueActionValues.defer:
      return "defer";
    case reviewerQueueActionValues.escalate:
      return "escalate";
    case reviewerQueueActionValues.requestRepair:
      return "requestRepair";
    case reviewerQueueActionValues.updateGlossary:
      return "updateGlossary";
    case reviewerQueueActionValues.updateStyle:
      return "updateStyle";
    case reviewerQueueActionValues.importRuntimeFeedback:
      return "importRuntimeFeedback";
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
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
  it("captures a ReviewerQueueRepositoryError from the atomic batch as an all-item refusal", async () => {
    const qa1 = fixturePendingQaItem("reviewer-queue-083-qa-1");
    const qa2 = fixturePendingQaItem("reviewer-queue-083-qa-2");
    const previewService = new ReviewerBatchPreviewService(
      makeResolver({ [qa1.reviewItemId]: qa1, [qa2.reviewItemId]: qa2 }),
    );
    const { service: actionService } = makeActionStub();
    vi.mocked(actionService.applyPreparedBatch).mockRejectedValueOnce(
      new ReviewerQueueRepositoryError(
        "reviewer_queue_item_invalid_transition",
        "reviewer queue item state changed concurrently; please retry with a fresh fetch",
      ),
    );
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

    expect(result.refusedAll).toBe(true);
    expect(result.appliedAll).toBe(false);
    expect(result.applied.map((entry) => entry.kind)).toEqual(["refused", "refused"]);
    expect(
      result.applied.every(
        (entry) =>
          entry.kind === "refused" && entry.code === "reviewer_queue_item_invalid_transition",
      ),
    ).toBe(true);
  });

  // Atomicity-claim re-audit: the finding warned that a per-item dispatch
  // loop could leave items 1..N-1 applied if item N races. The executor now
  // hands the whole batch to the repository's single-transaction
  // applyPreparedBatch, so a race on the LAST item rolls the entire batch
  // back. The executor must surface ZERO "applied" outcomes — no partial
  // writes leak to the dashboard.
  it("surfaces no partial writes when the final item of the batch races", async () => {
    const items = [
      fixturePendingQaItem("reviewer-queue-083-race-1"),
      fixturePendingQaItem("reviewer-queue-083-race-2"),
      fixturePendingQaItem("reviewer-queue-083-race-3"),
    ] as const;
    const previewService = new ReviewerBatchPreviewService(
      makeResolver(Object.fromEntries(items.map((item) => [item.reviewItemId, item]))),
    );
    const { service: actionService, calls } = makeActionStub();
    // The atomic batch rejects because the final item moved concurrently;
    // the repository transaction rolls back the earlier per-item writes.
    vi.mocked(actionService.applyPreparedBatch).mockRejectedValueOnce(
      new ReviewerQueueRepositoryError(
        "reviewer_queue_item_concurrent_modification",
        "reviewer queue item reviewer-queue-083-race-3 moved before the batch committed",
      ),
    );
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
        selections: items.map((item) => ({
          reviewItemId: item.reviewItemId,
          expectedSourceRevisionId: item.sourceRevisionId,
        })),
      },
      fixtureBatchPermissionView(),
    );

    expect(result.refusedAll).toBe(true);
    expect(result.appliedAll).toBe(false);
    // No "applied" outcome leaks: items 1..N-1 are NOT reported as written.
    expect(result.applied.some((entry) => entry.kind === "applied")).toBe(false);
    expect(result.applied.map((entry) => entry.reviewItemId)).toEqual(
      items.map((item) => item.reviewItemId),
    );
    expect(
      result.applied.every(
        (entry) =>
          entry.kind === "refused" && entry.code === "reviewer_queue_item_concurrent_modification",
      ),
    ).toBe(true);
    // Single atomic dispatch — no per-item single-action fallback writes.
    expect(calls).toEqual([]);
    expect(actionService.applyPreparedBatch).toHaveBeenCalledTimes(1);
  });
});

describe("ReviewerBatchActionService — payload resolver dispatch", () => {
  it("dispatches updateGlossary with termId + approvedTranslation for glossary items", async () => {
    const item = fixturePendingGlossaryItem();
    const previewService = new ReviewerBatchPreviewService(
      makeResolver({ [item.reviewItemId]: item }),
    );
    const { service: actionService, calls } = makeActionStub();
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
    expect(actionService.applyPreparedBatch).toHaveBeenCalledTimes(1);
    expect(calls.map((call) => call.method)).toEqual(["updateGlossary"]);
  });

  it("dispatches importRuntimeFeedback with evidence tier + observation events", async () => {
    const item = fixturePendingRuntimeEvidenceItem();
    const previewService = new ReviewerBatchPreviewService(
      makeResolver({ [item.reviewItemId]: item }),
    );
    const { service: actionService, calls } = makeActionStub();
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
    expect(actionService.applyPreparedBatch).toHaveBeenCalledTimes(1);
    expect(calls.map((call) => call.method)).toEqual(["importRuntimeFeedback"]);
  });

  it("records the persisted evidence tier verbatim on a matching importRuntimeFeedback batch", async () => {
    // The runtime-evidence fixture persists evidenceTier "tier-2-trace".
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
    // The tier recorded on the transition metadata is the persisted value,
    // verbatim — consistent with the single-item path.
    expect(result.applied[0]).toMatchObject({ kind: "applied" });
    const applied = result.applied[0];
    if (applied.kind !== "applied") {
      throw new Error("expected an applied outcome");
    }
    expect(applied.result.transition.metadata).toMatchObject({
      evidenceTier: item.evidenceTier,
      observationEventIds: item.observationEventIds,
      artifactHashes: item.artifactHashes,
    });
  });

  it("rejects a batch importRuntimeFeedback whose evidence tier drifts from the persisted item", async () => {
    // SECURITY: a batch caller must NOT be able to substitute an evidence
    // tier that differs from the persisted runtime-evidence record. This
    // is the SAME enforcement the single-item path applies — the batch
    // throws the same ReviewerQueueActionServiceInputError, and no writes
    // happen (applyPreparedBatch is never reached).
    const item = fixturePendingRuntimeEvidenceItem();
    const previewService = new ReviewerBatchPreviewService(
      makeResolver({ [item.reviewItemId]: item }),
    );
    const { service: actionService } = makeActionStub();
    const executor = new ReviewerBatchActionService({
      previewService,
      actionService,
      resolvePayload: () => ({
        kind: "importRuntimeFeedback",
        evidenceTier: "tier-3-forged",
        observationEventIds: item.observationEventIds ?? ["observation-fallback-1"],
        artifactHashes: item.artifactHashes ?? ["sha256:fallback"],
      }),
    });

    const promise = executor.execute(
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
    await expect(promise).rejects.toBeInstanceOf(ReviewerQueueActionServiceInputError);
    await expect(promise).rejects.toMatchObject({ field: "evidenceTier" });
    // No partial writes: the atomic batch transaction is never entered.
    expect(actionService.applyPreparedBatch).not.toHaveBeenCalled();
  });

  it("rejects a batch importRuntimeFeedback whose observation/artifact refs drift from the persisted item", async () => {
    const item = fixturePendingRuntimeEvidenceItem();
    const previewService = new ReviewerBatchPreviewService(
      makeResolver({ [item.reviewItemId]: item }),
    );
    const { service: actionService } = makeActionStub();
    const executor = new ReviewerBatchActionService({
      previewService,
      actionService,
      resolvePayload: () => ({
        kind: "importRuntimeFeedback",
        evidenceTier: item.evidenceTier ?? "tier-2-trace",
        observationEventIds: ["observation-forged-1"],
        artifactHashes: item.artifactHashes ?? ["sha256:fallback"],
      }),
    });

    const promise = executor.execute(
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
    await expect(promise).rejects.toBeInstanceOf(ReviewerQueueActionServiceInputError);
    await expect(promise).rejects.toMatchObject({ field: "observationEventIds" });
    expect(actionService.applyPreparedBatch).not.toHaveBeenCalled();
  });

  it("dispatches defer with a defer reason", async () => {
    const item = fixturePendingQaItem("reviewer-queue-083-defer-1");
    const previewService = new ReviewerBatchPreviewService(
      makeResolver({ [item.reviewItemId]: item }),
    );
    const { service: actionService, calls } = makeActionStub();
    const executor = new ReviewerBatchActionService({
      previewService,
      actionService,
      resolvePayload: () => ({
        kind: "defer",
        deferReason: "needs owner review",
      }),
    });

    const result = await executor.execute(
      actor,
      {
        action: reviewerQueueActionValues.defer,
        actorUserId: actor.userId,
        selections: [
          { reviewItemId: item.reviewItemId, expectedSourceRevisionId: item.sourceRevisionId },
        ],
      },
      fixtureBatchPermissionView(),
    );

    expect(result.appliedAll).toBe(true);
    expect(calls.map((call) => call.method)).toEqual(["defer"]);
  });

  it("refuses context-free batch decisions before action dispatch", async () => {
    const item = fixturePendingQaItem("reviewer-queue-083-context-free", {
      metadata: {},
    });
    const previewService = new ReviewerBatchPreviewService(
      makeResolver({ [item.reviewItemId]: item }),
    );
    const { service: actionService } = makeActionStub();
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
          { reviewItemId: item.reviewItemId, expectedSourceRevisionId: item.sourceRevisionId },
        ],
      },
      fixtureBatchPermissionView(),
    );

    expect(result.refusedAll).toBe(true);
    expect(result.applied[0]).toMatchObject({
      kind: "refused",
      status: reviewerBatchPreviewStatusValues.invalidInput,
      code: "reviewer_queue_item_invalid_input",
    });
    expect(actionService.approve).not.toHaveBeenCalled();
  });

  it("fails closed before dispatch when a later batch item lacks context refs", async () => {
    const valid = fixturePendingQaItem("reviewer-queue-083-context-valid");
    const missingContext = fixturePendingQaItem("reviewer-queue-083-context-missing", {
      metadata: {},
    });
    const previewService = new ReviewerBatchPreviewService(
      makeResolver({
        [valid.reviewItemId]: valid,
        [missingContext.reviewItemId]: missingContext,
      }),
    );
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
          { reviewItemId: valid.reviewItemId, expectedSourceRevisionId: valid.sourceRevisionId },
          {
            reviewItemId: missingContext.reviewItemId,
            expectedSourceRevisionId: missingContext.sourceRevisionId,
          },
        ],
      },
      fixtureBatchPermissionView(),
    );

    expect(result.refusedAll).toBe(true);
    expect(result.appliedAll).toBe(false);
    expect(calls).toEqual([]);
    expect(result.applied.map((entry) => entry.kind)).toEqual(["refused", "refused"]);
    expect(result.applied[1]).toMatchObject({
      status: reviewerBatchPreviewStatusValues.invalidInput,
      code: "reviewer_queue_item_invalid_input",
    });
  });

  it("refuses the whole batch when atomic repository dispatch rejects", async () => {
    const first = fixturePendingQaItem("reviewer-queue-083-atomic-first");
    const second = fixturePendingQaItem("reviewer-queue-083-atomic-second");
    const previewService = new ReviewerBatchPreviewService(
      makeResolver({
        [first.reviewItemId]: first,
        [second.reviewItemId]: second,
      }),
    );
    const { service: actionService, calls } = makeActionStub();
    vi.mocked(actionService.applyPreparedBatch).mockRejectedValueOnce(
      new ReviewerQueueRepositoryError(
        "reviewer_queue_item_stale_revision",
        "reviewer queue item changed before atomic batch commit",
      ),
    );
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
          {
            reviewItemId: first.reviewItemId,
            expectedSourceRevisionId: first.sourceRevisionId,
          },
          {
            reviewItemId: second.reviewItemId,
            expectedSourceRevisionId: second.sourceRevisionId,
          },
        ],
      },
      fixtureBatchPermissionView(),
    );

    expect(result.refusedAll).toBe(true);
    expect(result.appliedAll).toBe(false);
    expect(calls).toEqual([]);
    expect(result.applied).toHaveLength(2);
    expect(result.applied).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "refused",
          reviewItemId: first.reviewItemId,
          code: "reviewer_queue_item_stale_revision",
        }),
        expect.objectContaining({
          kind: "refused",
          reviewItemId: second.reviewItemId,
          code: "reviewer_queue_item_stale_revision",
        }),
      ]),
    );
  });

  it("dispatches escalate with a target reviewer", async () => {
    const item = fixturePendingQaItem("reviewer-queue-083-escalate-1");
    const previewService = new ReviewerBatchPreviewService(
      makeResolver({ [item.reviewItemId]: item }),
    );
    const { service: actionService, calls } = makeActionStub();
    const executor = new ReviewerBatchActionService({
      previewService,
      actionService,
      resolvePayload: () => ({
        kind: "escalate",
        escalationReason: "ambiguous cultural reference",
        escalationTarget: "senior-reviewer",
      }),
    });

    const result = await executor.execute(
      actor,
      {
        action: reviewerQueueActionValues.escalate,
        actorUserId: actor.userId,
        selections: [
          { reviewItemId: item.reviewItemId, expectedSourceRevisionId: item.sourceRevisionId },
        ],
      },
      fixtureBatchPermissionView(),
    );

    expect(result.appliedAll).toBe(true);
    expect(calls.map((call) => call.method)).toEqual(["escalate"]);
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
    applyActionsAndEnqueueJobs: vi.fn(
      async (
        actor: AuthorizationActor,
        inputs: readonly ReviewerQueueActionInput[],
        planJobs: ReviewerQueueActionJobPlanner,
      ) => {
        const actionResults: ReviewerQueueActionResult[] = [];
        for (const input of inputs) {
          const actionResult = makeResult(input.reviewItemId);
          actionResult.transition.action = input.action;
          actionResult.transition.actorUserId = actor.userId;
          actionResult.transition.metadata = input.metadata ?? {};
          actionResult.transition.affectedArtifactIds = input.affectedArtifactIds ?? [];
          plannedJobs.push(...(await planJobs(actionResult)));
          actionResults.push(actionResult);
        }
        return { actionResults, jobs: [] };
      },
    ),
    getItem: vi.fn(),
    getItemForManage: vi.fn(),
    loadItemsByBranch: vi.fn(),
    loadTransitionsByItem: vi.fn(),
  };
}
