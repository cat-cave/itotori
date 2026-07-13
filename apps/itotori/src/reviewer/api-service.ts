import {
  reviewerQueueActionValues,
  reviewerQueueItemStateValues,
  type AuthorizationActor,
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
  type BatchPreviewItem,
  type ReviewerBatchActionRequest,
  type ReviewerBatchConsequenceResolverPort,
  type ReviewerBatchPreview,
} from "./batch-preview.js";
import {
  ReviewerBatchActionService,
  type BatchActionPayload,
  type BatchActionPayloadResolver,
  type BatchExecuteOutcome,
  type ReviewerBatchExecuteResult,
} from "./batch-execute.js";
import type { ReviewerQueueActionServicePort } from "./action-service.js";
import {
  buildStructureContextFeedFromDecisionContext,
  extractDecisionRecordStructureContext,
} from "./structure-context-feed.js";

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

export type ReviewerQueuePagination = {
  total: number;
  limit: number;
  offset: number;
  page: number;
  pageCount: number;
  hasMore: boolean;
  nextOffset: number | null;
};

export type ReviewerQueueDashboardReadModel = {
  schemaVersion: "reviewer.queue_dashboard.v0.1";
  localeBranchId: string;
  generatedAt: Date;
  permission: ReviewerQueuePermissionView;
  pagination: ReviewerQueuePagination;
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
  actionService?: ReviewerQueueActionServicePort;
  evidenceLoader?: ReviewerDetailEvidenceLoaderPort;
  consequenceResolver?: ReviewerBatchConsequenceResolverPort;
  now?: () => Date;
};

/**
 * ITOTORI-082 — single-item reviewer action HTTP seam.
 *
 * The batch surface (preview + confirm) already carries the full
 * consequence-disclosure + atomic-write machinery over
 * `ReviewerQueueActionService`. A reviewer acting on ONE item should
 * not have to construct a batch-of-one: `ReviewerSingleActionRequest`
 * names a single review item + the reviewer's action inputs, and
 * `actionSingleItem` runs it through the SAME batch preview + execute
 * path (batch-of-one), so the state machine, actor-gating, and
 * consequence disclosure are identical to the batch route. The per-item
 * reviewer verbs are approve, reject, defer, and escalate. Target-line edits
 * are play-tester result revisions, not reviewer-queue actions.
 */
export type ReviewerSingleActionInput =
  | { action: "approve" }
  | { action: "reject" }
  | { action: "defer"; deferReason: string }
  | { action: "escalate"; escalationReason: string; escalationTarget: string };

export type ReviewerSingleAction = ReviewerSingleActionInput["action"];

export type ReviewerSingleActionRequest = {
  reviewItemId: string;
  actorUserId: string;
  expectedSourceRevisionId: string;
} & ReviewerSingleActionInput;

/**
 * Result of a single-item action. `preview` is the one
 * consequence-disclosure row the reviewer would have seen; `outcome`
 * mirrors what batch-confirm returns for one item — `kind: "applied"`
 * carries the persisted item + transition (the new state), `kind:
 * "refused"` carries the typed refusal (unknown item / invalid
 * transition / already-actioned / stale / permission), which the HTTP
 * seam maps to a typed status code instead of a 500.
 */
export type ReviewerSingleActionResult = {
  request: ReviewerSingleActionRequest;
  preview: BatchPreviewItem;
  outcome: BatchExecuteOutcome;
  applied: boolean;
  refused: boolean;
};

export type ReviewerQueueApiServicePort = {
  loadDashboard(input: {
    localeBranchId: string;
    permission: ReviewerQueuePermissionView;
    limit?: number;
    offset?: number;
  }): Promise<ReviewerQueueDashboardReadModel>;
  loadDetailContext(input: {
    reviewItemId: string;
    permission: ReviewerQueuePermissionView;
  }): Promise<ReviewerDetailContext>;
  loadReviewItemIdsByBridgeUnit(input: {
    localeBranchId: string;
    bridgeUnitIds: string[];
  }): Promise<Map<string, string>>;
  previewBatch(input: {
    request: ReviewerBatchActionRequest;
    permission: ReviewerQueuePermissionView;
  }): Promise<ReviewerBatchPreview>;
  executeBatch(input: {
    actor: AuthorizationActor;
    request: ReviewerBatchActionRequest;
    permission: ReviewerQueuePermissionView;
  }): Promise<ReviewerBatchExecuteResult>;
  actionSingleItem(input: {
    actor: AuthorizationActor;
    request: ReviewerSingleActionRequest;
    permission: ReviewerQueuePermissionView;
  }): Promise<ReviewerSingleActionResult>;
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
    limit?: number;
    offset?: number;
  }): Promise<ReviewerQueueDashboardReadModel> {
    const limit = normalizeReviewerQueueLimit(input.limit);
    const offset = normalizeReviewerQueueOffset(input.offset);
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
    const pageRows = sortedRows.slice(offset, offset + limit);
    return {
      schemaVersion: "reviewer.queue_dashboard.v0.1",
      localeBranchId: input.localeBranchId,
      generatedAt: this.now(),
      permission: input.permission,
      pagination: reviewerQueuePagination(sortedRows.length, limit, offset),
      rows: pageRows,
      aggregate: aggregateRows(sortedRows),
      defaultBatchRequest: {
        action: reviewerQueueActionValues.approve,
        actorUserId: input.permission.actorUserId,
        selections: pageRows
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

  async loadReviewItemIdsByBridgeUnit(input: {
    localeBranchId: string;
    bridgeUnitIds: string[];
  }): Promise<Map<string, string>> {
    const wanted = new Set(input.bridgeUnitIds);
    const result = new Map<string, string>();
    if (wanted.size === 0) {
      return result;
    }
    const items = await this.deps.repository.loadItemsByBranch(input.localeBranchId);
    const sorted = items.slice().sort((left, right) => {
      const stateRank =
        reviewerItemSelectionRank(left.state) - reviewerItemSelectionRank(right.state);
      if (stateRank !== 0) {
        return stateRank;
      }
      return right.updatedAt.getTime() - left.updatedAt.getTime();
    });
    for (const item of sorted) {
      const bridgeUnitId = bridgeUnitIdFromReviewItemMetadata(item.metadata);
      if (bridgeUnitId === null || !wanted.has(bridgeUnitId) || result.has(bridgeUnitId)) {
        continue;
      }
      result.set(bridgeUnitId, item.reviewItemId);
    }
    return result;
  }

  async previewBatch(input: {
    request: ReviewerBatchActionRequest;
    permission: ReviewerQueuePermissionView;
  }): Promise<ReviewerBatchPreview> {
    const service = new ReviewerBatchPreviewService(this.consequenceResolver);
    return service.preview(input.request, input.permission);
  }

  async executeBatch(input: {
    actor: AuthorizationActor;
    request: ReviewerBatchActionRequest;
    permission: ReviewerQueuePermissionView;
  }): Promise<ReviewerBatchExecuteResult> {
    if (this.deps.actionService === undefined) {
      throw new Error("reviewer batch execution requires an action service");
    }
    const batchActionId = `batch-action-${this.now()
      .toISOString()
      .replace(/[^0-9A-Za-z]/gu, "")}`;
    const service = new ReviewerBatchActionService({
      previewService: new ReviewerBatchPreviewService(this.consequenceResolver),
      actionService: this.deps.actionService,
      resolvePayload: defaultBatchPayloadResolver(input.request.action, batchActionId),
    });
    return service.execute(input.actor, input.request, input.permission);
  }

  async actionSingleItem(input: {
    actor: AuthorizationActor;
    request: ReviewerSingleActionRequest;
    permission: ReviewerQueuePermissionView;
  }): Promise<ReviewerSingleActionResult> {
    if (this.deps.actionService === undefined) {
      throw new Error("reviewer single-item action requires an action service");
    }
    const singleActionId = `single-action-${this.now()
      .toISOString()
      .replace(/[^0-9A-Za-z]/gu, "")}`;
    // Run the single item through the SAME batch preview + execute path
    // (a batch-of-one) so the transition validator, atomic write through
    // ReviewerQueueActionService, and consequence disclosure are
    // identical to the batch route — no parallel state machine.
    const batchRequest: ReviewerBatchActionRequest = {
      action: input.request.action,
      actorUserId: input.request.actorUserId,
      selections: [
        {
          reviewItemId: input.request.reviewItemId,
          expectedSourceRevisionId: input.request.expectedSourceRevisionId,
        },
      ],
    };
    const service = new ReviewerBatchActionService({
      previewService: new ReviewerBatchPreviewService(this.consequenceResolver),
      actionService: this.deps.actionService,
      resolvePayload: singleActionPayloadResolver(input.request, singleActionId),
    });
    const result = await service.execute(input.actor, batchRequest, input.permission);
    const outcome = result.applied[0];
    const preview = result.preview.items[0];
    if (outcome === undefined || preview === undefined) {
      throw new Error("single-item reviewer action produced no outcome");
    }
    return {
      request: input.request,
      preview,
      outcome,
      applied: outcome.kind === "applied",
      refused: outcome.kind === "refused",
    };
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

const REVIEWER_QUEUE_DEFAULT_LIMIT = 100;
const REVIEWER_QUEUE_MAX_LIMIT = 500;

function normalizeReviewerQueueLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return REVIEWER_QUEUE_DEFAULT_LIMIT;
  }
  if (!Number.isInteger(limit) || limit < 1) {
    return REVIEWER_QUEUE_DEFAULT_LIMIT;
  }
  return Math.min(limit, REVIEWER_QUEUE_MAX_LIMIT);
}

function normalizeReviewerQueueOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isInteger(offset) || offset < 0) {
    return 0;
  }
  return offset;
}

function reviewerQueuePagination(
  total: number,
  limit: number,
  offset: number,
): ReviewerQueuePagination {
  const pageCount = total === 0 ? 0 : Math.ceil(total / limit);
  const hasMore = offset + limit < total;
  return {
    total,
    limit,
    offset,
    page: Math.floor(offset / limit) + 1,
    pageCount,
    hasMore,
    nextOffset: hasMore ? offset + limit : null,
  };
}

function reviewerItemSelectionRank(state: ReviewerQueueItemState): number {
  if (state === reviewerQueueItemStateValues.pending) {
    return 0;
  }
  if (state === reviewerQueueItemStateValues.repairRequested) {
    return 1;
  }
  if (state === reviewerQueueItemStateValues.deferred) {
    return 2;
  }
  if (state === reviewerQueueItemStateValues.escalated) {
    return 3;
  }
  return 4;
}

function bridgeUnitIdFromReviewItemMetadata(
  metadata: ReviewerQueueItemRecord["metadata"],
): string | null {
  const contextRefs = (metadata as { contextRefs?: unknown }).contextRefs;
  if (contextRefs === null || typeof contextRefs !== "object") {
    return null;
  }
  const source = (contextRefs as { source?: unknown }).source;
  if (source === null || typeof source !== "object") {
    return null;
  }
  const bridgeUnitId = (source as { bridgeUnitId?: unknown }).bridgeUnitId;
  return typeof bridgeUnitId === "string" && bridgeUnitId.length > 0 ? bridgeUnitId : null;
}

function defaultEvidenceLoader(
  repository: ReviewerQueueReadRepositoryPort,
): ReviewerDetailEvidenceLoaderPort {
  return {
    loadItem: (reviewItemId) => repository.getItem(reviewItemId),
    loadTransitions: (reviewItemId) => repository.loadTransitionsByItem(reviewItemId),
    loadDetailEvidence: async (item) => {
      // wiki-structure-context-feed — hydrate the structure-informed feed from
      // the agentic-loop decision record when present so the default (DB-wired)
      // path still shows WHY the draft chose its wording without a custom
      // evidence loader. Source/draft/policy stay null here unless a richer
      // loader is injected; the feed is derived purely from the payload.
      const structureContextFeed = buildStructureContextFeedFromDecisionContext(
        extractDecisionRecordStructureContext(item.payload),
      );
      const rationaleRefs =
        structureContextFeed === null
          ? []
          : structureContextFeed.items.map((feedItem) => ({
              refKind: "context_artifact" as const,
              refId: feedItem.artifactRef,
              label: feedItem.title,
            }));
      return {
        loadedSourceRevisionId: item.sourceRevisionId,
        source: null,
        draft: null,
        policy: null,
        glossary: [],
        branchReference: null,
        qaFindings: [],
        runtimeEvidence: [],
        rationaleRefs,
        structureContextFeed,
        diagnostics: [],
      };
    },
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

function defaultBatchPayloadResolver(
  action: ReviewerQueueAction,
  batchActionId: string,
): BatchActionPayloadResolver {
  return (item) => defaultBatchPayload(action, item, batchActionId);
}

/**
 * Single-item payload resolver — unlike the batch defaults (which
 * synthesize canned reasons because a batch spans many items), the
 * single-item route carries the reviewer's OWN inputs (defer reason,
 * escalation reason/target, repair hint) verbatim. The resolver ignores
 * the loaded item and returns the reviewer-supplied payload.
 */
function singleActionPayloadResolver(
  request: ReviewerSingleActionRequest,
  singleActionId: string,
): BatchActionPayloadResolver {
  return () => singleActionPayload(request, singleActionId);
}

function singleActionPayload(
  request: ReviewerSingleActionRequest,
  singleActionId: string,
): BatchActionPayload {
  const metadata = { singleActionId };
  switch (request.action) {
    case reviewerQueueActionValues.approve:
      return { kind: "approve", metadata };
    case reviewerQueueActionValues.reject:
      return { kind: "reject", metadata };
    case reviewerQueueActionValues.defer:
      return { kind: "defer", deferReason: request.deferReason, metadata };
    case reviewerQueueActionValues.escalate:
      return {
        kind: "escalate",
        escalationReason: request.escalationReason,
        escalationTarget: request.escalationTarget,
        metadata,
      };
    default: {
      const exhaustive: never = request;
      throw new Error(`unhandled single reviewer action: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function defaultBatchPayload(
  action: ReviewerQueueAction,
  item: ReviewerQueueItemRecord,
  batchActionId: string,
): BatchActionPayload {
  const metadata = { batchActionId };
  switch (action) {
    case reviewerQueueActionValues.approve:
      return { kind: "approve", metadata };
    case reviewerQueueActionValues.reject:
      return { kind: "reject", metadata };
    case reviewerQueueActionValues.defer:
      return { kind: "defer", deferReason: "batch deferred by reviewer", metadata };
    case reviewerQueueActionValues.escalate:
      return {
        kind: "escalate",
        escalationReason: "batch escalated by reviewer",
        escalationTarget: "senior-reviewer",
        metadata,
      };
    case reviewerQueueActionValues.importRuntimeFeedback:
      return {
        kind: "importRuntimeFeedback",
        evidenceTier: item.evidenceTier ?? "batch-runtime-evidence",
        observationEventIds: item.observationEventIds ?? [item.reviewItemId],
        artifactHashes: item.artifactHashes ?? [item.reviewItemId],
        metadata,
      };
    default: {
      throw new Error(`unsupported reviewer batch action: ${action}`);
    }
  }
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
