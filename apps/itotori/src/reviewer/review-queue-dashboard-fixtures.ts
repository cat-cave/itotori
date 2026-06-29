import {
  reviewerQueueActionValues,
  reviewerQueueItemKindValues,
  reviewerQueueItemStateValues,
} from "@itotori/db";
import {
  fixtureAllowedRow,
  fixtureBatchPermissionView,
  fixtureDecisionContextRefs,
  fixturePendingQaItem,
} from "./batch-fixtures.js";
import type { BatchPreviewItem, ReviewerBatchPreview } from "./batch-preview.js";

export const itotori023DashboardFixtureIds = {
  projectId: "project-itotori-023",
  localeBranchId: "locale-branch-itotori-023",
  sourceRevisionId: "source-revision-itotori-023",
} as const;

export type ReviewerQueueDashboardFixtureState =
  | "pending"
  | "resolved"
  | "deferred"
  | "escalated"
  | "batch_applied";

export type ReviewerQueueDashboardFixtureDecision = {
  decisionId: string;
  findingId: string;
  dashboardState: ReviewerQueueDashboardFixtureState;
  item: ReturnType<typeof fixturePendingQaItem>;
  contextRefs: ReturnType<typeof fixtureDecisionContextRefs>;
  lastAction: string | null;
  batchActionId: string | null;
};

export type ReviewerQueueDashboardFixtures = {
  decisions: ReviewerQueueDashboardFixtureDecision[];
  batchAppliedPreview: ReviewerBatchPreview;
};

export function reviewQueueDashboardFixtures(): ReviewerQueueDashboardFixtures {
  const pending = decision("decision-itotori-023-pending", "pending", null, null);
  const resolved = decision(
    "decision-itotori-023-resolved",
    "resolved",
    reviewerQueueActionValues.approve,
    null,
    reviewerQueueItemStateValues.accepted,
  );
  const deferred = decision(
    "decision-itotori-023-deferred",
    "deferred",
    reviewerQueueActionValues.defer,
    null,
    reviewerQueueItemStateValues.deferred,
  );
  const escalated = decision(
    "decision-itotori-023-escalated",
    "escalated",
    reviewerQueueActionValues.escalate,
    null,
    reviewerQueueItemStateValues.escalated,
  );
  const batchApplied = decision(
    "decision-itotori-023-batch-applied",
    "batch_applied",
    reviewerQueueActionValues.reject,
    "batch-action-itotori-023-reject",
    reviewerQueueItemStateValues.rejected,
  );
  return {
    decisions: [pending, resolved, deferred, escalated, batchApplied],
    batchAppliedPreview: batchPreview([batchApplied]),
  };
}

function decision(
  decisionId: string,
  dashboardState: ReviewerQueueDashboardFixtureState,
  lastAction: string | null,
  batchActionId: string | null,
  state: ReturnType<typeof fixturePendingQaItem>["state"] = reviewerQueueItemStateValues.pending,
): ReviewerQueueDashboardFixtureDecision {
  const contextRefs = fixtureDecisionContextRefs(decisionId);
  const item = fixturePendingQaItem(decisionId, {
    projectId: itotori023DashboardFixtureIds.projectId,
    localeBranchId: itotori023DashboardFixtureIds.localeBranchId,
    sourceRevisionId: itotori023DashboardFixtureIds.sourceRevisionId,
    itemKind: reviewerQueueItemKindValues.qa,
    sourceItemRef: decisionId,
    state,
    summary: `ITOTORI-023 ${dashboardState} decision`,
    metadata: {
      decisionId,
      findingId: `finding-${decisionId}`,
      contextRefs,
      ...(batchActionId === null ? {} : { batchActionId }),
    },
    resolvedAt:
      state === reviewerQueueItemStateValues.accepted ||
      state === reviewerQueueItemStateValues.rejected
        ? new Date("2026-06-26T00:00:00Z")
        : null,
  });
  return {
    decisionId,
    findingId: `finding-${decisionId}`,
    dashboardState,
    item,
    contextRefs,
    lastAction,
    batchActionId,
  };
}

function batchPreview(decisions: ReviewerQueueDashboardFixtureDecision[]): ReviewerBatchPreview {
  const rows: BatchPreviewItem[] = decisions.map((entry) => ({
    ...fixtureAllowedRow(entry.decisionId),
    expectedSourceRevisionId: itotori023DashboardFixtureIds.sourceRevisionId,
    item: entry.item,
    priorState: reviewerQueueItemStateValues.pending,
    nextState: reviewerQueueItemStateValues.rejected,
  }));
  return {
    request: {
      action: reviewerQueueActionValues.reject,
      actorUserId: "local-user",
      selections: decisions.map((entry) => ({
        reviewItemId: entry.decisionId,
        expectedSourceRevisionId: itotori023DashboardFixtureIds.sourceRevisionId,
      })),
    },
    permission: fixtureBatchPermissionView(),
    items: rows,
    aggregate: {
      total: rows.length,
      allowed: rows.length,
      denied: 0,
      stale: 0,
      notFound: 0,
      duplicate: 0,
      runtimeEvidenceInvariant: 0,
      invalidInput: 0,
      invalidTransition: 0,
      concurrentModification: 0,
      permissionDeniedRead: 0,
      permissionDeniedManage: 0,
    },
    allAllowed: rows.length > 0,
    permissionDenied: false,
  };
}
