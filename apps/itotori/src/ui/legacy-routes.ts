// fnd-spa-shell — bridge for the routes NOT ported to React by this node.
//
// fnd-spa-shell replaces the dashboard / reviewer-detail / workspace
// HTML-string renderers with React. The asset-decisions, reviewer-batch, and
// style-guide-builder routes are SEPARATE downstream screen nodes that still
// use their own HTML-string renderers (out of this node's delete scope). This
// module keeps them working by returning the async renderer to mount into a
// container — an honest, temporary bridge (each is a tracked follow-on
// screen), NOT a dual path for a replaced view.

import { parseAssetDecisionsRoute, renderAssetDecisionsRoute } from "../asset-decisions/route.js";
import {
  parseReviewerBatchRoute,
  renderReviewerBatchRoute,
  type ReviewerBatchActionRequest,
  type ReviewerBatchActionServicePort,
  type ReviewerBatchExecuteResult,
  type ReviewerBatchPermissionView,
  type ReviewerBatchPreview,
  type ReviewerBatchPreviewServicePort,
} from "../reviewer/index.js";
import { renderStyleGuideBuilderRoute } from "../style-guide-builder.js";
import { assertItotoriApiResponse } from "../api-schema.js";
import { reviewerQueueActionList, reviewerQueueActionValues } from "@itotori/db";

export type LegacyRouteRenderer = (root: HTMLElement) => void | Promise<void>;

/**
 * Return the async HTML-string renderer for a route this node does not port,
 * or `null` when the path is owned by a React screen (so `App` renders React).
 */
export function matchLegacyRoute(pathname: string, search: string): LegacyRouteRenderer | null {
  const assetDecisions = parseAssetDecisionsRoute(pathname);
  if (assetDecisions !== null) {
    return (root) => renderAssetDecisionsRoute(root, assetDecisions);
  }
  const reviewerBatch = parseReviewerBatchRoute(pathname);
  if (reviewerBatch !== null) {
    const request = reviewerBatchRequestFromSearch(search);
    return (root) =>
      renderReviewerBatchRoute(root, request, {
        permission: optimisticBatchPermission(request.actorUserId),
        previewService: makeApiBatchPreviewService(),
        confirm: {
          permission: optimisticBatchPermission(request.actorUserId),
          actionService: makeApiBatchActionService(),
          actor: { userId: request.actorUserId },
        },
      });
  }
  if (pathname === "/style-guide-builder") {
    return (root) => renderStyleGuideBuilderRoute(root);
  }
  return null;
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
