// fnd-spa-shell — bridge for the routes NOT ported to React by this node.
//
// fnd-spa-shell replaces the dashboard / reviewer-detail / workspace
// HTML-string renderers with React. The asset-decisions, reviewer-batch, and
// style-guide-builder routes are SEPARATE downstream screen nodes that still
// use their own HTML-string renderers (out of this node's delete scope). This
// module keeps them working by returning the async renderer to mount into a
// container — an honest, temporary bridge (each is a tracked follow-on
// screen), NOT a dual path for a replaced view.

import { assertBrowserItotoriApiResponse } from "../api-client-guards.js";
import type { AssetDecisionsRouteParams } from "../asset-decisions/route.js";
import type {
  ReviewerBatchActionRequest,
  ReviewerBatchActionServicePort,
  ReviewerBatchExecuteResult,
  ReviewerBatchPermissionView,
  ReviewerBatchPreview,
  ReviewerBatchPreviewServicePort,
} from "../reviewer/index.js";

export type LegacyRouteRenderer = (root: HTMLElement) => void | Promise<void>;

const assetDecisionsRoutePathRegex =
  /^\/projects\/([^/]+)\/locale-branches\/([^/]+)\/asset-decisions(\/batch)?$/u;
const reviewerBatchRoutePathRegex = /^\/reviewer-queue\/batch$/u;

const reviewerQueueActionValues = {
  approve: "approve",
  reject: "reject",
  defer: "defer",
  escalate: "escalate",
  requestRepair: "request_repair",
  updateGlossary: "update_glossary",
  updateStyle: "update_style",
  importRuntimeFeedback: "import_runtime_feedback",
} as const;

const reviewerQueueActionList = Object.values(reviewerQueueActionValues);

/**
 * Return the async HTML-string renderer for a route this node does not port,
 * or `null` when the path is owned by a React screen (so `App` renders React).
 */
export function matchLegacyRoute(pathname: string, search: string): LegacyRouteRenderer | null {
  const assetDecisions = parseAssetDecisionsRoute(pathname);
  if (assetDecisions !== null) {
    return async (root) => {
      const { renderAssetDecisionsRoute } = await import("../asset-decisions/route.js");
      await renderAssetDecisionsRoute(root, assetDecisions);
    };
  }
  const reviewerBatch = parseReviewerBatchRoute(pathname);
  if (reviewerBatch !== null) {
    const request = reviewerBatchRequestFromSearch(search);
    return async (root) => {
      const { renderReviewerBatchRoute } = await import("../reviewer/batch-route.js");
      await renderReviewerBatchRoute(root, request, {
        permission: optimisticBatchPermission(request.actorUserId),
        previewService: makeApiBatchPreviewService(),
        confirm: {
          permission: optimisticBatchPermission(request.actorUserId),
          actionService: makeApiBatchActionService(),
          actor: { userId: request.actorUserId },
        },
      });
    };
  }
  if (pathname === "/style-guide-builder") {
    return async (root) => {
      const { renderStyleGuideBuilderRoute } = await import("../style-guide-builder.js");
      await renderStyleGuideBuilderRoute(root);
    };
  }
  return null;
}

function parseAssetDecisionsRoute(pathname: string): AssetDecisionsRouteParams | null {
  const match = assetDecisionsRoutePathRegex.exec(pathname);
  const projectId = match?.[1];
  const localeBranchId = match?.[2];
  if (projectId === undefined || localeBranchId === undefined) {
    return null;
  }
  return {
    projectId: decodeURIComponent(projectId),
    localeBranchId: decodeURIComponent(localeBranchId),
    view: match?.[3] === "/batch" ? "batch" : "policy",
  };
}

function parseReviewerBatchRoute(pathname: string): true | null {
  return reviewerBatchRoutePathRegex.exec(pathname) === null ? null : true;
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
      assertBrowserItotoriApiResponse("reviewer.batchPreview", body);
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
      assertBrowserItotoriApiResponse("reviewer.batchExecute", body);
      return body as ReviewerBatchExecuteResult;
    },
  };
}
