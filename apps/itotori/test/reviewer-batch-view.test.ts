// @vitest-environment jsdom
// ITOTORI-083 — Reviewer batch preview view (pure render) tests.

import { describe, expect, it } from "vitest";
import { reviewerQueueActionValues } from "@itotori/db";
import {
  fixtureAllAllowedPreview,
  fixtureDeniedPreview,
  fixtureEmptyPreview,
  fixtureMixedPreview,
  parseReviewerBatchRoute,
  renderReviewerBatchExecuteView,
  renderReviewerBatchPreviewView,
  reviewerBatchPreviewStatusValues,
  type BatchExecuteOutcome,
  type ReviewerBatchExecuteResult,
  type ReviewerBatchPreview,
} from "../src/reviewer/index.js";

function renderInto(html: string): HTMLDivElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
}

describe("parseReviewerBatchRoute", () => {
  it("matches /reviewer-queue/batch", () => {
    expect(parseReviewerBatchRoute("/reviewer-queue/batch")).toBe(true);
    expect(parseReviewerBatchRoute("/reviewer-queue/batch/")).toBeNull();
    expect(parseReviewerBatchRoute("/reviewer-queue/some-id")).toBeNull();
    expect(parseReviewerBatchRoute("/dashboard")).toBeNull();
  });
});

describe("renderReviewerBatchPreviewView — denial UI", () => {
  it("renders the denial panel and omits per-item rows when canReadQueue=false", () => {
    const root = renderInto(renderReviewerBatchPreviewView(fixtureDeniedPreview("anon")));
    const main = root.querySelector(".reviewer-batch")!;
    expect(main.getAttribute("data-state")).toBe("denied");
    expect(root.textContent).toContain("Access denied");
    expect(root.querySelector('[data-panel-id="items"]')).toBeNull();
    expect(root.querySelector('[data-panel-id="empty-selection"]')).toBeNull();
  });
});

describe("renderReviewerBatchPreviewView — empty selection", () => {
  it("renders the empty-selection panel when zero items are selected", () => {
    const root = renderInto(renderReviewerBatchPreviewView(fixtureEmptyPreview()));
    expect(root.querySelector('[data-panel-id="empty-selection"]')).not.toBeNull();
    expect(root.textContent).toContain("No review items selected");
  });
});

describe("renderReviewerBatchPreviewView — all allowed", () => {
  it("enables the confirm button and emits an aggregate banner", () => {
    const preview = fixtureAllAllowedPreview();
    const root = renderInto(renderReviewerBatchPreviewView(preview));
    const confirm = root.querySelector('button[data-batch-action="confirm"]')!;
    expect(confirm.hasAttribute("disabled")).toBe(false);
    expect(root.querySelector('[data-all-allowed="true"]')).not.toBeNull();
  });

  it("disables confirm when allAllowed is true but canManage is false", () => {
    const preview: ReviewerBatchPreview = {
      ...fixtureAllAllowedPreview(),
      permission: {
        actorUserId: "viewer",
        canReadQueue: true,
        canManageQueue: false,
        denialReasons: [],
      },
    };
    const root = renderInto(renderReviewerBatchPreviewView(preview));
    const confirm = root.querySelector('button[data-batch-action="confirm"]')!;
    expect(confirm.hasAttribute("disabled")).toBe(true);
  });
});

describe("renderReviewerBatchPreviewView — mixed allowed / denied / stale / conflicting / not_found", () => {
  it("renders one row per selection with status, required permission, and message visible", () => {
    const preview = fixtureMixedPreview();
    const root = renderInto(renderReviewerBatchPreviewView(preview));
    const rows = Array.from(root.querySelectorAll("[data-review-item-id]"));
    expect(rows.length).toBe(5);
    const statuses = rows.map((row) => row.getAttribute("data-status"));
    expect(statuses).toEqual([
      reviewerBatchPreviewStatusValues.allowed,
      reviewerBatchPreviewStatusValues.staleRevision,
      reviewerBatchPreviewStatusValues.invalidInput,
      reviewerBatchPreviewStatusValues.invalidTransition,
      reviewerBatchPreviewStatusValues.notFound,
    ]);
    expect(root.textContent).toContain("1 allowed");
    expect(root.textContent).toContain("1 stale");
    expect(root.textContent).toContain("1 invalid input");
    expect(root.textContent).toContain("1 invalid transition");
    expect(root.textContent).toContain("1 not found");
  });

  it("disables confirm when not every item is allowed", () => {
    const root = renderInto(renderReviewerBatchPreviewView(fixtureMixedPreview()));
    const confirm = root.querySelector('button[data-batch-action="confirm"]')!;
    expect(confirm.hasAttribute("disabled")).toBe(true);
  });

  it("renders the consequence list per allowed row", () => {
    const root = renderInto(renderReviewerBatchPreviewView(fixtureMixedPreview()));
    const consequences = Array.from(root.querySelectorAll("[data-consequence-kind]")).map((node) =>
      node.getAttribute("data-consequence-kind"),
    );
    // The allowed row in `fixtureMixedPreview` carries: rerun_job +
    // draft_state_change + export_artifact.
    expect(consequences).toEqual(["rerun_job", "draft_state_change", "export_artifact"]);
  });
});

describe("renderReviewerBatchPreviewView — defensive escaping", () => {
  it("escapes hostile strings in messages and ids", () => {
    const preview: ReviewerBatchPreview = {
      ...fixtureMixedPreview(),
      request: {
        ...fixtureMixedPreview().request,
        action: reviewerQueueActionValues.approve,
      },
      items: fixtureMixedPreview().items.map((entry) => ({
        ...entry,
        message: entry.message === null ? null : `${entry.message}<script>alert(1)</script>`,
      })),
    };
    const html = renderReviewerBatchPreviewView(preview);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("renderReviewerBatchExecuteView", () => {
  it("renders applied and refused execution outcomes", () => {
    const preview = fixtureAllAllowedPreview();
    const first = preview.items[0]!;
    const result: ReviewerBatchExecuteResult = {
      request: preview.request,
      preview,
      applied: [
        {
          kind: "applied",
          reviewItemId: first.reviewItemId,
          result: {
            item: first.item!,
            transition: {
              transitionId: `transition-${first.reviewItemId}`,
              reviewItemId: first.reviewItemId,
              localeBranchId: first.item!.localeBranchId,
              sourceRevisionId: first.item!.sourceRevisionId,
              itemKind: first.item!.itemKind,
              action: preview.request.action,
              priorState: first.priorState!,
              nextState: first.nextState!,
              actorUserId: preview.request.actorUserId,
              affectedArtifactIds: [],
              diagnostics: [],
              metadata: { batchActionId: "batch-action-view-test" },
              createdAt: new Date(),
            },
          },
        },
        {
          kind: "refused",
          reviewItemId: "reviewer-queue-refused",
          status: reviewerBatchPreviewStatusValues.staleRevision,
          code: "reviewer_queue_item_stale_revision",
          message: "source revision changed",
          diagnostics: [],
        } satisfies BatchExecuteOutcome,
      ],
      refusedAll: false,
      appliedAll: false,
    };

    const root = renderInto(renderReviewerBatchExecuteView(result));

    expect(root.querySelector('[data-state="executed"]')).not.toBeNull();
    expect(root.querySelectorAll('[data-execute-result="applied"]')).toHaveLength(1);
    expect(root.querySelectorAll('[data-execute-result="refused"]')).toHaveLength(1);
    expect(root.textContent).toContain("1 applied, 1 refused");
    expect(root.textContent).toContain("source revision changed");
  });
});
