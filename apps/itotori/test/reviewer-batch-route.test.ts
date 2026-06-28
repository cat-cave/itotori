// @vitest-environment jsdom
// ITOTORI-083 — Reviewer batch SPA route tests.

import { describe, expect, it } from "vitest";
import { reviewerQueueActionValues, type AuthorizationActor } from "@itotori/db";
import {
  confirmReviewerBatch,
  fixtureAllAllowedPreview,
  fixtureBatchPermissionView,
  fixtureMixedPreview,
  loadReviewerBatchPreview,
  parseReviewerBatchRoute,
  renderReviewerBatchRoute,
  type BatchExecuteOutcome,
  type ReviewerBatchActionRequest,
  type ReviewerBatchActionServicePort,
  type ReviewerBatchExecuteResult,
  type ReviewerBatchPreview,
  type ReviewerBatchPreviewServicePort,
} from "../src/reviewer/index.js";

describe("parseReviewerBatchRoute (route loader)", () => {
  it("matches the canonical batch route", () => {
    expect(parseReviewerBatchRoute("/reviewer-queue/batch")).toBe(true);
    expect(parseReviewerBatchRoute("/reviewer-queue/detail")).toBeNull();
  });
});

describe("loadReviewerBatchPreview", () => {
  it("delegates to the preview service with the request + permission view", async () => {
    const preview = fixtureAllAllowedPreview();
    const previewService: ReviewerBatchPreviewServicePort = {
      preview: async (_req, _perm) => preview,
    };
    const result = await loadReviewerBatchPreview(preview.request, {
      permission: fixtureBatchPermissionView(),
      previewService,
    });
    expect(result).toBe(preview);
  });
});

describe("renderReviewerBatchRoute — DOM integration", () => {
  it("renders the loading shell then the ready view when the preview resolves", async () => {
    const preview = fixtureAllAllowedPreview();
    const previewService: ReviewerBatchPreviewServicePort = {
      preview: async () => preview,
    };
    const root = document.createElement("div");
    await renderReviewerBatchRoute(root, preview.request, {
      permission: fixtureBatchPermissionView(),
      previewService,
    });
    const main = root.querySelector(".reviewer-batch")!;
    expect(main.getAttribute("data-state")).toBe("ready");
  });

  it("renders the denied view when permissionDenied is true on the preview", async () => {
    const denied: ReviewerBatchPreview = {
      ...fixtureMixedPreview(),
      permission: {
        actorUserId: "anon",
        canReadQueue: false,
        canManageQueue: false,
        denialReasons: ["user anon is missing permission queue.read"],
      },
      permissionDenied: true,
    };
    const previewService: ReviewerBatchPreviewServicePort = {
      preview: async () => denied,
    };
    const request: ReviewerBatchActionRequest = {
      action: reviewerQueueActionValues.approve,
      actorUserId: "anon",
      selections: denied.items.map((entry) => ({
        reviewItemId: entry.reviewItemId,
        expectedSourceRevisionId: entry.expectedSourceRevisionId,
      })),
    };
    const root = document.createElement("div");
    await renderReviewerBatchRoute(root, request, {
      permission: denied.permission,
      previewService,
    });
    expect(root.querySelector('[data-state="denied"]')).not.toBeNull();
  });

  it("renders an error pane when the preview service throws", async () => {
    const previewService: ReviewerBatchPreviewServicePort = {
      preview: async () => {
        throw new Error("preview service offline");
      },
    };
    const root = document.createElement("div");
    await renderReviewerBatchRoute(
      root,
      {
        action: reviewerQueueActionValues.approve,
        actorUserId: "local-user",
        selections: [],
      },
      {
        permission: fixtureBatchPermissionView(),
        previewService,
      },
    );
    expect(root.querySelector('[data-state="error"]')).not.toBeNull();
    expect(root.textContent).toContain("preview service offline");
  });

  it("wires the Confirm button to execution and renders per-item results", async () => {
    const preview = fixtureAllAllowedPreview();
    const actor: AuthorizationActor = { userId: "local-user" };
    const fakeResult = makeExecuteResult(preview, actor);
    const previewService: ReviewerBatchPreviewServicePort = {
      preview: async () => preview,
    };
    const actionService: ReviewerBatchActionServicePort = {
      execute: async () => fakeResult,
    };
    const root = document.createElement("div");

    await renderReviewerBatchRoute(root, preview.request, {
      permission: fixtureBatchPermissionView(),
      previewService,
      confirm: {
        permission: fixtureBatchPermissionView(),
        actionService,
        actor,
      },
    });
    root.querySelector<HTMLButtonElement>('button[data-batch-action="confirm"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(root.querySelector('[data-state="executed"]')).not.toBeNull();
    expect(root.querySelectorAll('[data-execute-result="applied"]')).toHaveLength(
      preview.items.length,
    );
  });
});

describe("confirmReviewerBatch", () => {
  it("dispatches to the batch action service and returns the executor result", async () => {
    const preview = fixtureAllAllowedPreview();
    const actor: AuthorizationActor = { userId: "local-user" };
    const fakeResult: ReviewerBatchExecuteResult = {
      request: preview.request,
      preview,
      applied: preview.items.map(
        (entry): BatchExecuteOutcome => ({
          kind: "applied",
          reviewItemId: entry.reviewItemId,
          result: {
            item: entry.item!,
            transition: {
              transitionId: `t-${entry.reviewItemId}`,
              reviewItemId: entry.reviewItemId,
              localeBranchId: entry.item!.localeBranchId,
              sourceRevisionId: entry.item!.sourceRevisionId,
              itemKind: entry.item!.itemKind,
              action: preview.request.action,
              priorState: entry.priorState!,
              nextState: entry.nextState!,
              actorUserId: actor.userId,
              affectedArtifactIds: [],
              diagnostics: [],
              metadata: {},
              createdAt: new Date(),
            },
          },
        }),
      ),
      refusedAll: false,
      appliedAll: true,
    };
    const actionService: ReviewerBatchActionServicePort = {
      execute: async (_actor, _req, _perm) => fakeResult,
    };
    const result = await confirmReviewerBatch(preview.request, {
      permission: fixtureBatchPermissionView(),
      actionService,
      actor,
    });
    expect(result).toBe(fakeResult);
  });
});

function makeExecuteResult(
  preview: ReviewerBatchPreview,
  actor: AuthorizationActor,
): ReviewerBatchExecuteResult {
  return {
    request: preview.request,
    preview,
    applied: preview.items.map(
      (entry): BatchExecuteOutcome => ({
        kind: "applied",
        reviewItemId: entry.reviewItemId,
        result: {
          item: entry.item!,
          transition: {
            transitionId: `t-${entry.reviewItemId}`,
            reviewItemId: entry.reviewItemId,
            localeBranchId: entry.item!.localeBranchId,
            sourceRevisionId: entry.item!.sourceRevisionId,
            itemKind: entry.item!.itemKind,
            action: preview.request.action,
            priorState: entry.priorState!,
            nextState: entry.nextState!,
            actorUserId: actor.userId,
            affectedArtifactIds: [],
            diagnostics: [],
            metadata: { batchActionId: "batch-action-route-test" },
            createdAt: new Date(),
          },
        },
      }),
    ),
    refusedAll: false,
    appliedAll: true,
  };
}
