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

import { renderReviewerBatchPreviewView } from "./batch-view.js";
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
  renderLoading(root, request);
  try {
    const preview = await loadReviewerBatchPreview(request, deps);
    root.innerHTML = renderReviewerBatchPreviewView(preview);
  } catch (error) {
    renderError(root, request, error);
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

function renderLoading(root: HTMLElement, request: ReviewerBatchActionRequest): void {
  root.innerHTML = `
    <main class="itotori-shell reviewer-batch" data-state="loading"
      data-action="${escapeHtml(request.action)}">
      <p role="status">
        Previewing batch <code>${escapeHtml(request.action)}</code> over
        ${request.selections.length}
        ${request.selections.length === 1 ? "selection" : "selections"}…
      </p>
    </main>
  `;
}

function renderError(root: HTMLElement, request: ReviewerBatchActionRequest, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  root.innerHTML = `
    <main class="itotori-shell reviewer-batch" data-state="error"
      data-action="${escapeHtml(request.action)}">
      <h1>Batch preview unavailable</h1>
      <p role="alert">Could not preview batch action <code>${escapeHtml(request.action)}</code>.</p>
      <pre>${escapeHtml(message)}</pre>
    </main>
  `;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
