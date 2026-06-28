import {
  reviewerQueueActionValues,
  reviewerQueueItemStateValues,
  type ReviewerQueueAction,
  type ReviewerQueueItemRecord,
  type ReviewerQueueItemState,
  type ReviewerQueueTransitionRecord,
} from "@itotori/db";
import type { ReviewerQueuePermissionView } from "../auth.js";
import {
  loadReviewerDetailContext,
  type ReviewerDetailEvidenceLoaderPort,
} from "./detail-route.js";
import type { ReviewerDetailContext } from "./detail-fixtures.js";
import {
  ReviewerBatchPreviewService,
  type ReviewerBatchActionRequest,
  type ReviewerBatchConsequenceResolverPort,
  type ReviewerBatchPreview,
} from "./batch-preview.js";

export const reviewerQueueDashboardStateValues = {
  pending: "pending",
  resolved: "resolved",
  deferred: "deferred",
  escalated: "escalated",
  batchApplied: "batch_applied",
} as const;

export type ReviewerQueueDashboardState =
  (typeof reviewerQueueDashboardStateValues)[keyof typeof reviewerQueueDashboardStateValues];

export type ReviewerQueueDashboardRow = {
  reviewItemId: string;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  itemKind: ReviewerQueueItemRecord["itemKind"];
  sourceItemRef: string;
  summary: string;
  priority: number;
  state: ReviewerQueueItemState;
  dashboardState: ReviewerQueueDashboardState;
  lastAction: ReviewerQueueAction | null;
  batchActionId: string | null;
  findingId: string | null;
  decisionId: string | null;
  detailPath: string;
  selectedForBatch: boolean;
  createdAt: Date;
  updatedAt: Date;
  resolvedAt: Date | null;
};

export type ReviewerQueueDashboardAggregate = Record<ReviewerQueueDashboardState, number>;

export type ReviewerQueueDashboardReadModel = {
  schemaVersion: "reviewer.queue_dashboard.v0.1";
  localeBranchId: string;
  generatedAt: Date;
  permission: ReviewerQueuePermissionView;
  rows: ReviewerQueueDashboardRow[];
  aggregate: ReviewerQueueDashboardAggregate;
  defaultBatchRequest: ReviewerBatchActionRequest;
};

export type ReviewerQueueReadRepositoryPort = {
  loadItemsByBranch(localeBranchId: string): Promise<ReviewerQueueItemRecord[]>;
  loadTransitionsByItem(reviewItemId: string): Promise<ReviewerQueueTransitionRecord[]>;
  getItem(reviewItemId: string): Promise<ReviewerQueueItemRecord | null>;
};

export type ReviewerQueueApiServiceDeps = {
  repository: ReviewerQueueReadRepositoryPort;
  evidenceLoader?: ReviewerDetailEvidenceLoaderPort;
  consequenceResolver?: ReviewerBatchConsequenceResolverPort;
  now?: () => Date;
};

export type ReviewerQueueApiServicePort = {
  loadDashboard(input: {
    localeBranchId: string;
    permission: ReviewerQueuePermissionView;
  }): Promise<ReviewerQueueDashboardReadModel>;
  loadDetailContext(input: {
    reviewItemId: string;
    permission: ReviewerQueuePermissionView;
  }): Promise<ReviewerDetailContext>;
  previewBatch(input: {
    request: ReviewerBatchActionRequest;
    permission: ReviewerQueuePermissionView;
  }): Promise<ReviewerBatchPreview>;
};

export class ReviewerQueueApiService implements ReviewerQueueApiServicePort {
  private readonly evidenceLoader: ReviewerDetailEvidenceLoaderPort;
  private readonly consequenceResolver: ReviewerBatchConsequenceResolverPort;
  private readonly now: () => Date;

  constructor(private readonly deps: ReviewerQueueApiServiceDeps) {
    this.evidenceLoader = deps.evidenceLoader ?? defaultEvidenceLoader(deps.repository);
    this.consequenceResolver =
      deps.consequenceResolver ?? defaultConsequenceResolver(deps.repository);
    this.now = deps.now ?? (() => new Date());
  }

  async loadDashboard(input: {
    localeBranchId: string;
    permission: ReviewerQueuePermissionView;
  }): Promise<ReviewerQueueDashboardReadModel> {
    const items = await this.deps.repository.loadItemsByBranch(input.localeBranchId);
    const rows = await Promise.all(items.map((item) => this.dashboardRow(item)));
    const sortedRows = rows.sort((left, right) => {
      if (left.dashboardState !== right.dashboardState) {
        return dashboardStateRank(left.dashboardState) - dashboardStateRank(right.dashboardState);
      }
      if (left.priority !== right.priority) {
        return right.priority - left.priority;
      }
      return left.createdAt.getTime() - right.createdAt.getTime();
    });
    return {
      schemaVersion: "reviewer.queue_dashboard.v0.1",
      localeBranchId: input.localeBranchId,
      generatedAt: this.now(),
      permission: input.permission,
      rows: sortedRows,
      aggregate: aggregateRows(sortedRows),
      defaultBatchRequest: {
        action: reviewerQueueActionValues.approve,
        actorUserId: input.permission.actorUserId,
        selections: sortedRows
          .filter((row) => row.selectedForBatch)
          .map((row) => ({
            reviewItemId: row.reviewItemId,
            expectedSourceRevisionId: row.sourceRevisionId,
          })),
      },
    };
  }

  async loadDetailContext(input: {
    reviewItemId: string;
    permission: ReviewerQueuePermissionView;
  }): Promise<ReviewerDetailContext> {
    return loadReviewerDetailContext(
      { reviewItemId: input.reviewItemId },
      {
        permission: input.permission,
        evidenceLoader: this.evidenceLoader,
      },
    );
  }

  async previewBatch(input: {
    request: ReviewerBatchActionRequest;
    permission: ReviewerQueuePermissionView;
  }): Promise<ReviewerBatchPreview> {
    const service = new ReviewerBatchPreviewService(this.consequenceResolver);
    return service.preview(input.request, input.permission);
  }

  private async dashboardRow(item: ReviewerQueueItemRecord): Promise<ReviewerQueueDashboardRow> {
    const transitions = await this.deps.repository.loadTransitionsByItem(item.reviewItemId);
    const latestTransition = transitions.at(-1) ?? null;
    const batchActionId =
      stringMetadata(item.metadata, "batchActionId") ??
      stringMetadata(latestTransition?.metadata, "batchActionId");
    const dashboardState = dashboardStateFor(item.state, batchActionId);
    return {
      reviewItemId: item.reviewItemId,
      projectId: item.projectId,
      localeBranchId: item.localeBranchId,
      sourceRevisionId: item.sourceRevisionId,
      itemKind: item.itemKind,
      sourceItemRef: item.sourceItemRef,
      summary: item.summary,
      priority: item.priority,
      state: item.state,
      dashboardState,
      lastAction: latestTransition?.action ?? null,
      batchActionId,
      findingId: stringMetadata(item.metadata, "findingId"),
      decisionId: stringMetadata(item.metadata, "decisionId"),
      detailPath: `/reviewer-queue/${encodeURIComponent(item.reviewItemId)}`,
      selectedForBatch: dashboardState === reviewerQueueDashboardStateValues.pending,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      resolvedAt: item.resolvedAt,
    };
  }
}

function defaultEvidenceLoader(
  repository: ReviewerQueueReadRepositoryPort,
): ReviewerDetailEvidenceLoaderPort {
  return {
    loadItem: (reviewItemId) => repository.getItem(reviewItemId),
    loadTransitions: (reviewItemId) => repository.loadTransitionsByItem(reviewItemId),
    loadDetailEvidence: async (item) => ({
      loadedSourceRevisionId: item.sourceRevisionId,
      source: null,
      draft: null,
      policy: null,
      glossary: [],
      qaFindings: [],
      runtimeEvidence: [],
      rationaleRefs: [],
      diagnostics: [],
    }),
  };
}

function defaultConsequenceResolver(
  repository: ReviewerQueueReadRepositoryPort,
): ReviewerBatchConsequenceResolverPort {
  return {
    loadItem: (reviewItemId) => repository.getItem(reviewItemId),
    resolveConsequences: async () => [],
  };
}

function dashboardStateFor(
  state: ReviewerQueueItemState,
  batchActionId: string | null,
): ReviewerQueueDashboardState {
  if (batchActionId !== null) {
    return reviewerQueueDashboardStateValues.batchApplied;
  }
  if (state === reviewerQueueItemStateValues.deferred) {
    return reviewerQueueDashboardStateValues.deferred;
  }
  if (state === reviewerQueueItemStateValues.escalated) {
    return reviewerQueueDashboardStateValues.escalated;
  }
  if (
    state === reviewerQueueItemStateValues.accepted ||
    state === reviewerQueueItemStateValues.rejected
  ) {
    return reviewerQueueDashboardStateValues.resolved;
  }
  return reviewerQueueDashboardStateValues.pending;
}

function dashboardStateRank(state: ReviewerQueueDashboardState): number {
  switch (state) {
    case reviewerQueueDashboardStateValues.pending:
      return 0;
    case reviewerQueueDashboardStateValues.escalated:
      return 1;
    case reviewerQueueDashboardStateValues.deferred:
      return 2;
    case reviewerQueueDashboardStateValues.resolved:
      return 3;
    case reviewerQueueDashboardStateValues.batchApplied:
      return 4;
  }
}

function aggregateRows(rows: ReviewerQueueDashboardRow[]): ReviewerQueueDashboardAggregate {
  const aggregate: ReviewerQueueDashboardAggregate = {
    pending: 0,
    resolved: 0,
    deferred: 0,
    escalated: 0,
    batch_applied: 0,
  };
  for (const row of rows) {
    aggregate[row.dashboardState] += 1;
  }
  return aggregate;
}

function stringMetadata(metadata: Record<string, unknown> | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}
