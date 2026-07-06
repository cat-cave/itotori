import { renderDashboard } from "./dashboard.js";
import { renderStyleGuideBuilderRoute } from "./style-guide-builder.js";
import { parseAssetDecisionsRoute, renderAssetDecisionsRoute } from "./asset-decisions/route.js";
import {
  parseReviewerBatchRoute,
  parseReviewerDetailRoute,
  renderReviewerBatchRoute,
  renderReviewerDetailView,
  type ReviewerBatchActionRequest,
  type ReviewerBatchActionServicePort,
  type ReviewerBatchExecuteResult,
  type ReviewerBatchPermissionView,
  type ReviewerBatchPreview,
  type ReviewerBatchPreviewServicePort,
  type ReviewerDetailContext,
} from "./reviewer/index.js";
import { parseWorkspaceRoute, renderWorkspaceRoute } from "./workspace/index.js";
import { assertItotoriApiResponse } from "./api-schema.js";
import { reviewerQueueActionList, reviewerQueueActionValues } from "@itotori/db";

const root = document.querySelector<HTMLDivElement>("#app")!;

const assetDecisionsParams = parseAssetDecisionsRoute(window.location.pathname);
const reviewerDetailParams = parseReviewerDetailRoute(window.location.pathname);
const reviewerBatchHit = parseReviewerBatchRoute(window.location.pathname);
const workspaceRoute = parseWorkspaceRoute(window.location.pathname, window.location.search);
if (assetDecisionsParams !== null) {
  await renderAssetDecisionsRoute(root, assetDecisionsParams);
} else if (reviewerBatchHit !== null) {
  const request = reviewerBatchRequestFromSearch(window.location.search);
  await renderReviewerBatchRoute(root, request, {
    permission: optimisticBatchPermission(request.actorUserId),
    previewService: makeApiBatchPreviewService(),
    confirm: {
      permission: optimisticBatchPermission(request.actorUserId),
      actionService: makeApiBatchActionService(),
      actor: { userId: request.actorUserId },
    },
  });
} else if (reviewerDetailParams !== null) {
  root.innerHTML = `
    <main class="itotori-shell" data-state="loading">Loading reviewer item...</main>
  `;
  const context = await fetchReviewerDetailContext(reviewerDetailParams.reviewItemId);
  root.innerHTML = renderReviewerDetailView(context);
} else if (workspaceRoute !== null) {
  await renderWorkspaceRoute(root, workspaceRoute, { fetchJson: fetchWorkspaceJson });
} else if (window.location.pathname === "/style-guide-builder") {
  await renderStyleGuideBuilderRoute(root);
} else {
  await renderDashboard(root);
}

async function fetchWorkspaceJson(apiPath: string): Promise<unknown> {
  const response = await fetch(apiPath, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`workspace API request failed: ${response.status}`);
  }
  return await response.json();
}

function reviewerBatchRequestFromSearch(search: string): ReviewerBatchActionRequest {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const actionParam = params.get("action");
  const action =
    actionParam !== null && isReviewerQueueAction(actionParam)
      ? actionParam
      : reviewerQueueActionValues.approve;
  const actorUserId = params.get("actorUserId") ?? "local-user";
  return {
    action,
    actorUserId,
    selections: params.getAll("selection").map(parseBatchSelectionParam),
  };
}

function isReviewerQueueAction(value: string): value is ReviewerBatchActionRequest["action"] {
  return (reviewerQueueActionList as readonly string[]).includes(value);
}

function parseBatchSelectionParam(value: string): ReviewerBatchActionRequest["selections"][number] {
  const separator = value.lastIndexOf("@");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error("batch selection must be encoded as reviewItemId@sourceRevisionId");
  }
  return {
    reviewItemId: value.slice(0, separator),
    expectedSourceRevisionId: value.slice(separator + 1),
  };
}

function optimisticBatchPermission(actorUserId: string): ReviewerBatchPermissionView {
  return {
    actorUserId,
    canReadQueue: true,
    canManageQueue: false,
    denialReasons: [],
  };
}

function makeApiBatchPreviewService(): ReviewerBatchPreviewServicePort {
  return {
    preview: async (request) => {
      const response = await fetch("/api/reviewer/queue/batch-preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      if (!response.ok) {
        throw new Error(`failed to load reviewer batch preview: ${response.status}`);
      }
      const body = await response.json();
      assertItotoriApiResponse("reviewer.batchPreview", body);
      return body as ReviewerBatchPreview;
    },
  };
}

function makeApiBatchActionService(): ReviewerBatchActionServicePort {
  return {
    execute: async (_actor, request) => {
      const response = await fetch("/api/reviewer/queue/batch-confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      if (!response.ok) {
        throw new Error(`failed to confirm reviewer batch: ${response.status}`);
      }
      const body = await response.json();
      assertItotoriApiResponse("reviewer.batchExecute", body);
      return body as ReviewerBatchExecuteResult;
    },
  };
}

async function fetchReviewerDetailContext(reviewItemId: string): Promise<ReviewerDetailContext> {
  const response = await fetch(`/api/reviewer/queue/${encodeURIComponent(reviewItemId)}/detail`);
  if (!response.ok) {
    throw new Error(`failed to load reviewer detail: ${response.status}`);
  }
  const body = await response.json();
  assertItotoriApiResponse("reviewer.detail", body);
  return body as ReviewerDetailContext;
}
