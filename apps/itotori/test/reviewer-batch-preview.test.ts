// ITOTORI-083 — Reviewer batch consequence preview service tests.
//
// The preview computes per-item outcomes (allowed / denied / stale /
// conflicting / not_found / duplicate) for a `ReviewerBatchActionRequest`
// without mutating anything. Tests stub the `ReviewerBatchConsequenceResolverPort`
// so behavior is observable without standing up Postgres.
//
// Coverage:
//  - Permission gate (queue.read missing => denied, resolver never consulted)
//  - Empty selection
//  - Single allowed item with consequences
//  - Mixed allowed / stale / conflicting / not_found / duplicate
//  - Conflicting kinds (mixed item kind + action) — exercises shared
//    transition validator
//  - Manage permission missing => preview rows tagged
//    `permission_denied_manage` (allowed-to-preview but not to confirm)
//  - Input validation (missing fields / bad action)

import { describe, expect, it, vi } from "vitest";
import {
  reviewerQueueActionValues,
  reviewerQueueItemStateValues,
  type ReviewerQueueItemRecord,
} from "@itotori/db";
import {
  fixtureAcceptedItem,
  fixtureBatchPermissionView,
  fixtureConflictingActionRequest,
  fixtureEmptyRequest,
  fixtureMixedKindRequest,
  fixturePendingGlossaryItem,
  fixturePendingQaItem,
  fixturePendingRuntimeEvidenceItem,
  fixtureRerunJobConsequence,
  itotori083FixtureSourceRevisionId,
  ReviewerBatchPreviewService,
  ReviewerBatchPreviewServiceInputError,
  reviewerBatchPreviewStatusValues,
  type ReviewerBatchActionRequest,
  type ReviewerBatchConsequence,
  type ReviewerBatchConsequenceResolverPort,
} from "../src/reviewer/index.js";

type StubResolverHandle = {
  resolver: ReviewerBatchConsequenceResolverPort;
  loadItem: ReturnType<typeof vi.fn>;
  resolveConsequences: ReturnType<typeof vi.fn>;
};

function stubResolver(opts: {
  items?: Record<string, ReviewerQueueItemRecord>;
  consequences?: ReviewerBatchConsequence[];
}): StubResolverHandle {
  const items = opts.items ?? {};
  const loadItem = vi.fn(async (id: string) => items[id] ?? null);
  const resolveConsequences = vi.fn(
    async (_input: {
      item: ReviewerQueueItemRecord;
      action: (typeof reviewerQueueActionValues)[keyof typeof reviewerQueueActionValues];
      nextState: (typeof reviewerQueueItemStateValues)[keyof typeof reviewerQueueItemStateValues];
    }) => opts.consequences ?? [],
  );
  return {
    resolver: { loadItem, resolveConsequences },
    loadItem,
    resolveConsequences,
  };
}

describe("ReviewerBatchPreviewService — permission gate", () => {
  it("returns a denied preview and skips the resolver entirely when queue.read is missing", async () => {
    const stub = stubResolver({});
    const service = new ReviewerBatchPreviewService(stub.resolver);
    const request: ReviewerBatchActionRequest = {
      action: reviewerQueueActionValues.approve,
      actorUserId: "anon",
      selections: [
        { reviewItemId: "x", expectedSourceRevisionId: itotori083FixtureSourceRevisionId },
      ],
    };

    const preview = await service.preview(
      request,
      fixtureBatchPermissionView({
        actorUserId: "anon",
        canReadQueue: false,
        canManageQueue: false,
        denialReasons: ["user anon is missing permission queue.read"],
      }),
    );

    expect(preview.permissionDenied).toBe(true);
    expect(preview.items[0]?.diagnostics[0]?.message).toContain("queue.read");
    expect(preview.items[0]?.requiredPermission).toBe("queue.read");

    // Audit guard: resolver must never be consulted on the denied path.
    expect(stub.loadItem).not.toHaveBeenCalled();
    expect(stub.resolveConsequences).not.toHaveBeenCalled();
  });

  it("tags rows permission_denied_manage when queue.read passes but queue.manage is missing", async () => {
    const item = fixturePendingQaItem();
    const stub = stubResolver({
      items: { [item.reviewItemId]: item },
      consequences: [fixtureRerunJobConsequence(item.reviewItemId)],
    });
    const service = new ReviewerBatchPreviewService(stub.resolver);
    const preview = await service.preview(
      {
        action: reviewerQueueActionValues.approve,
        actorUserId: "viewer",
        selections: [
          {
            reviewItemId: item.reviewItemId,
            expectedSourceRevisionId: item.sourceRevisionId,
          },
        ],
      },
      fixtureBatchPermissionView({
        actorUserId: "viewer",
        canReadQueue: true,
        canManageQueue: false,
        denialReasons: ["user viewer is missing permission queue.manage"],
      }),
    );

    expect(preview.permissionDenied).toBe(false);
    expect(preview.items[0]?.status).toBe(reviewerBatchPreviewStatusValues.permissionDeniedManage);
    expect(preview.items[0]?.requiredPermission).toBe("queue.manage");
    expect(preview.items[0]?.consequences.length).toBeGreaterThan(0);
    expect(preview.allAllowed).toBe(false);
  });
});

describe("ReviewerBatchPreviewService — empty selection", () => {
  it("returns total=0 and allAllowed=false for an empty selection", async () => {
    const stub = stubResolver({});
    const service = new ReviewerBatchPreviewService(stub.resolver);
    const preview = await service.preview(fixtureEmptyRequest(), fixtureBatchPermissionView());

    expect(preview.items.length).toBe(0);
    expect(preview.aggregate.total).toBe(0);
    expect(preview.allAllowed).toBe(false);
    expect(stub.loadItem).not.toHaveBeenCalled();
  });
});

describe("ReviewerBatchPreviewService — allowed selections", () => {
  it("computes the next state and consequences via the shared transition validator", async () => {
    const item = fixturePendingQaItem("reviewer-queue-083-qa-only-1");
    const consequence = fixtureRerunJobConsequence(item.reviewItemId);
    const stub = stubResolver({
      items: { [item.reviewItemId]: item },
      consequences: [consequence],
    });
    const service = new ReviewerBatchPreviewService(stub.resolver);
    const preview = await service.preview(
      {
        action: reviewerQueueActionValues.approve,
        actorUserId: "local-user",
        selections: [
          {
            reviewItemId: item.reviewItemId,
            expectedSourceRevisionId: item.sourceRevisionId,
          },
        ],
      },
      fixtureBatchPermissionView(),
    );

    expect(preview.allAllowed).toBe(true);
    expect(preview.items[0]?.status).toBe(reviewerBatchPreviewStatusValues.allowed);
    expect(preview.items[0]?.priorState).toBe(reviewerQueueItemStateValues.pending);
    expect(preview.items[0]?.nextState).toBe(reviewerQueueItemStateValues.accepted);
    expect(preview.items[0]?.consequences).toEqual([consequence]);
    expect(stub.resolveConsequences).toHaveBeenCalledTimes(1);
  });

  it("aggregates per-status counts for mixed item kinds (qa + glossary + runtime_evidence)", async () => {
    const qa = fixturePendingQaItem("reviewer-queue-083-qa-1");
    const glossary = fixturePendingGlossaryItem("reviewer-queue-083-glossary-1");
    const runtime = fixturePendingRuntimeEvidenceItem("reviewer-queue-083-runtime-1");
    const stub = stubResolver({
      items: {
        [qa.reviewItemId]: qa,
        [glossary.reviewItemId]: glossary,
        [runtime.reviewItemId]: runtime,
      },
    });
    const service = new ReviewerBatchPreviewService(stub.resolver);
    const preview = await service.preview(fixtureMixedKindRequest(), fixtureBatchPermissionView());

    expect(preview.aggregate.total).toBe(3);
    expect(preview.aggregate.allowed).toBe(3);
    expect(preview.allAllowed).toBe(true);
    expect(preview.items.map((entry) => entry.status)).toEqual([
      reviewerBatchPreviewStatusValues.allowed,
      reviewerBatchPreviewStatusValues.allowed,
      reviewerBatchPreviewStatusValues.allowed,
    ]);
  });
});

describe("ReviewerBatchPreviewService — refusal paths (shared validator)", () => {
  it("flags a stale source revision via the same diagnostic the repository would emit", async () => {
    const item = fixturePendingQaItem();
    const stub = stubResolver({ items: { [item.reviewItemId]: item } });
    const service = new ReviewerBatchPreviewService(stub.resolver);
    const preview = await service.preview(
      {
        action: reviewerQueueActionValues.approve,
        actorUserId: "local-user",
        selections: [
          {
            reviewItemId: item.reviewItemId,
            expectedSourceRevisionId: "source-revision-otherwise-newer",
          },
        ],
      },
      fixtureBatchPermissionView(),
    );

    expect(preview.items[0]?.status).toBe(reviewerBatchPreviewStatusValues.staleRevision);
    expect(preview.items[0]?.diagnostics[0]?.code).toBe("reviewer_queue_item_stale_revision");
    expect(preview.items[0]?.message).toContain(
      "targeted source_revision=source-revision-otherwise-newer",
    );
    expect(preview.allAllowed).toBe(false);
  });

  it("flags conflicting action / kind pairs as reviewer_queue_item_invalid_input", async () => {
    const glossary = fixturePendingGlossaryItem();
    const qa = fixturePendingQaItem();
    const stub = stubResolver({
      items: { [glossary.reviewItemId]: glossary, [qa.reviewItemId]: qa },
    });
    const service = new ReviewerBatchPreviewService(stub.resolver);
    const preview = await service.preview(
      fixtureConflictingActionRequest(),
      fixtureBatchPermissionView(),
    );

    expect(preview.items[0]?.status).toBe(reviewerBatchPreviewStatusValues.allowed);
    expect(preview.items[1]?.status).toBe(reviewerBatchPreviewStatusValues.invalidInput);
    expect(preview.items[1]?.message).toContain(
      "action 'update_glossary' is not valid for item kind 'qa'",
    );
    expect(preview.allAllowed).toBe(false);
    expect(preview.aggregate.invalidInput).toBe(1);
    expect(preview.aggregate.allowed).toBe(1);
  });

  it("flags invalid transitions (terminal state) as reviewer_queue_item_invalid_transition", async () => {
    const accepted = fixtureAcceptedItem();
    const stub = stubResolver({ items: { [accepted.reviewItemId]: accepted } });
    const service = new ReviewerBatchPreviewService(stub.resolver);
    const preview = await service.preview(
      {
        action: reviewerQueueActionValues.approve,
        actorUserId: "local-user",
        selections: [
          {
            reviewItemId: accepted.reviewItemId,
            expectedSourceRevisionId: accepted.sourceRevisionId,
          },
        ],
      },
      fixtureBatchPermissionView(),
    );

    expect(preview.items[0]?.status).toBe(reviewerBatchPreviewStatusValues.invalidTransition);
    expect(preview.items[0]?.diagnostics[0]?.code).toBe("reviewer_queue_item_invalid_transition");
    expect(preview.items[0]?.message).toContain("from 'accepted' to 'accepted'");
  });

  it("returns one not_found row per missing review item id", async () => {
    const stub = stubResolver({});
    const service = new ReviewerBatchPreviewService(stub.resolver);
    const preview = await service.preview(
      {
        action: reviewerQueueActionValues.approve,
        actorUserId: "local-user",
        selections: [
          {
            reviewItemId: "reviewer-queue-083-missing-1",
            expectedSourceRevisionId: itotori083FixtureSourceRevisionId,
          },
        ],
      },
      fixtureBatchPermissionView(),
    );

    expect(preview.items[0]?.status).toBe(reviewerBatchPreviewStatusValues.notFound);
    expect(preview.items[0]?.diagnostics[0]?.code).toBe("reviewer_queue_item_not_found");
    expect(preview.aggregate.notFound).toBe(1);
  });

  it("surfaces the missing item permission gate according to manage access", async () => {
    const service = new ReviewerBatchPreviewService(stubResolver({}).resolver);
    const request: ReviewerBatchActionRequest = {
      action: reviewerQueueActionValues.approve,
      actorUserId: "local-user",
      selections: [
        {
          reviewItemId: "reviewer-queue-083-missing-1",
          expectedSourceRevisionId: itotori083FixtureSourceRevisionId,
        },
      ],
    };

    const managerPreview = await service.preview(
      request,
      fixtureBatchPermissionView({ canManageQueue: true }),
    );
    const readOnlyPreview = await service.preview(
      request,
      fixtureBatchPermissionView({ canManageQueue: false }),
    );

    expect(managerPreview.items[0]?.requiredPermission).toBe("queue.manage");
    expect(readOnlyPreview.items[0]?.requiredPermission).toBe("queue.read");
  });

  it("flags duplicate selections so the dashboard never silently collapses them", async () => {
    const item = fixturePendingQaItem();
    const stub = stubResolver({ items: { [item.reviewItemId]: item } });
    const service = new ReviewerBatchPreviewService(stub.resolver);
    const preview = await service.preview(
      {
        action: reviewerQueueActionValues.approve,
        actorUserId: "local-user",
        selections: [
          {
            reviewItemId: item.reviewItemId,
            expectedSourceRevisionId: item.sourceRevisionId,
          },
          {
            reviewItemId: item.reviewItemId,
            expectedSourceRevisionId: item.sourceRevisionId,
          },
        ],
      },
      fixtureBatchPermissionView(),
    );

    expect(preview.items.length).toBe(2);
    expect(preview.items[0]?.status).toBe(reviewerBatchPreviewStatusValues.allowed);
    expect(preview.items[1]?.status).toBe(reviewerBatchPreviewStatusValues.duplicateSelection);
    expect(preview.aggregate.duplicate).toBe(1);
    expect(preview.allAllowed).toBe(false);
  });

  it("flags runtime-evidence invariant when persisted refs are null", async () => {
    const broken: ReviewerQueueItemRecord = {
      ...fixturePendingRuntimeEvidenceItem(),
      evidenceTier: null,
      observationEventIds: null,
      artifactHashes: null,
    };
    const stub = stubResolver({ items: { [broken.reviewItemId]: broken } });
    const service = new ReviewerBatchPreviewService(stub.resolver);
    const preview = await service.preview(
      {
        action: reviewerQueueActionValues.approve,
        actorUserId: "local-user",
        selections: [
          {
            reviewItemId: broken.reviewItemId,
            expectedSourceRevisionId: broken.sourceRevisionId,
          },
        ],
      },
      fixtureBatchPermissionView(),
    );

    expect(preview.items[0]?.status).toBe(
      reviewerBatchPreviewStatusValues.runtimeEvidenceInvariant,
    );
  });
});

describe("ReviewerBatchPreviewService — input validation", () => {
  it("refuses a request whose action is not a closed-enum action", async () => {
    const stub = stubResolver({});
    const service = new ReviewerBatchPreviewService(stub.resolver);
    await expect(
      service.preview(
        {
          action: "not_a_real_action" as never,
          actorUserId: "local-user",
          selections: [],
        },
        fixtureBatchPermissionView(),
      ),
    ).rejects.toBeInstanceOf(ReviewerBatchPreviewServiceInputError);
  });

  it("refuses a request whose actorUserId is empty", async () => {
    const stub = stubResolver({});
    const service = new ReviewerBatchPreviewService(stub.resolver);
    await expect(
      service.preview(
        {
          action: reviewerQueueActionValues.approve,
          actorUserId: "",
          selections: [],
        },
        fixtureBatchPermissionView(),
      ),
    ).rejects.toBeInstanceOf(ReviewerBatchPreviewServiceInputError);
  });

  it("refuses a selection with an empty expectedSourceRevisionId", async () => {
    const stub = stubResolver({});
    const service = new ReviewerBatchPreviewService(stub.resolver);
    await expect(
      service.preview(
        {
          action: reviewerQueueActionValues.approve,
          actorUserId: "local-user",
          selections: [{ reviewItemId: "x", expectedSourceRevisionId: "" }],
        },
        fixtureBatchPermissionView(),
      ),
    ).rejects.toBeInstanceOf(ReviewerBatchPreviewServiceInputError);
  });
});
