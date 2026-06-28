// ITOTORI-083 — Reviewer batch action SPA route.
//
// The route renders a loading shell, computes the
// `ReviewerBatchPreview` via the typed preview service (gated on
// `queue.read`), and swaps in the rendered view. A second handler
// hooks the Confirm button to the batch executor (gated on
// `queue.manage`); both gates are pre-resolved by `auth.ts` and threaded
// through as a `ReviewerBatchPermissionView`.
//
// The route deliberately separates the preview port from the executor
// port so tests can pin them independently — preview must run on
// `queue.read` alone (no manage required), execution must refuse
// without `queue.manage`.

import {
  renderReviewerBatchErrorView,
  renderReviewerBatchLoadingView,
  renderReviewerBatchPreviewView,
} from "./batch-view.js";
import type {
  ReviewerBatchActionRequest,
  ReviewerBatchPermissionView,
  ReviewerBatchPreview,
  ReviewerBatchPreviewServicePort,
} from "./batch-preview.js";
import type {
  ReviewerBatchActionServicePort,
  ReviewerBatchExecuteResult,
} from "./batch-execute.js";
import type { AuthorizationActor } from "@itotori/db";

export { reviewerBatchRoutePathRegex } from "./batch-view.js";

export type ReviewerBatchRouteDeps = {
  permission: ReviewerBatchPermissionView;
  previewService: ReviewerBatchPreviewServicePort;
};

export async function loadReviewerBatchPreview(
  request: ReviewerBatchActionRequest,
  deps: ReviewerBatchRouteDeps,
): Promise<ReviewerBatchPreview> {
  return deps.previewService.preview(request, deps.permission);
}

export async function renderReviewerBatchRoute(
  root: HTMLElement,
  request: ReviewerBatchActionRequest,
  deps: ReviewerBatchRouteDeps,
): Promise<void> {
  root.innerHTML = renderReviewerBatchLoadingView(request);
  try {
    const preview = await loadReviewerBatchPreview(request, deps);
    root.innerHTML = renderReviewerBatchPreviewView(preview);
  } catch (error) {
    root.innerHTML = renderReviewerBatchErrorView(request, error);
  }
}

export type ReviewerBatchConfirmDeps = {
  permission: ReviewerBatchPermissionView;
  actionService: ReviewerBatchActionServicePort;
  actor: AuthorizationActor;
};

/**
 * Confirm handler — wires the rendered Confirm button to the executor.
 * Returns the executor result so the caller can re-render the page
 * with per-item outcomes. The executor double-checks the preview
 * inside; no second permission view is required.
 */
export async function confirmReviewerBatch(
  request: ReviewerBatchActionRequest,
  deps: ReviewerBatchConfirmDeps,
): Promise<ReviewerBatchExecuteResult> {
  return deps.actionService.execute(deps.actor, request, deps.permission);
}
