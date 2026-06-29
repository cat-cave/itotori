// ITOTORI-083 — Dashboard batch action fixtures.
//
// Closed-typed fixtures covering the acceptance scenarios:
//
//   - empty selection
//   - mixed kinds (qa + glossary + runtime_evidence) — exercises the
//     per-kind action validator
//   - mixed allowed / denied / stale / conflicting (acceptance #4)
//   - successful atomic batch execution
//
// Renderers and tests import these so the visible copy is deterministic
// and the per-status counts pin the rendered banner.

import {
  reviewerQueueActionValues,
  reviewerQueueItemKindValues,
  reviewerQueueItemStateValues,
  type ReviewerQueueItemRecord,
} from "@itotori/db";
import type { ReviewerQueueDecisionContextRefs } from "./action-service.js";
import {
  reviewerBatchPreviewStatusValues,
  type BatchPreviewItem,
  type ReviewerBatchActionRequest,
  type ReviewerBatchConsequence,
  type ReviewerBatchPermissionView,
  type ReviewerBatchPreview,
} from "./batch-preview.js";

const fixtureProjectId = "project-itotori-083";
const fixtureLocaleBranchId = "locale-branch-itotori-083";
const fixtureSourceRevisionId = "source-revision-itotori-083";
const fixtureCreatedAt = new Date("2026-06-26T00:00:00Z");

function makeItem(
  reviewItemId: string,
  itemKind: ReviewerQueueItemRecord["itemKind"],
  state: ReviewerQueueItemRecord["state"],
  overrides: Partial<ReviewerQueueItemRecord> = {},
): ReviewerQueueItemRecord {
  const isRuntime = itemKind === reviewerQueueItemKindValues.runtimeEvidence;
  return {
    reviewItemId,
    projectId: fixtureProjectId,
    localeBranchId: fixtureLocaleBranchId,
    sourceRevisionId: fixtureSourceRevisionId,
    itemKind,
    sourceItemRef: `${itemKind}-fixture-${reviewItemId}`,
    state,
    priority: 0,
    summary: `fixture ${itemKind} item ${reviewItemId}`,
    affectedArtifactIds: [`affected-${reviewItemId}-1`, `affected-${reviewItemId}-2`],
    evidenceTier: isRuntime ? "tier-2-trace" : null,
    observationEventIds: isRuntime ? [`observation-${reviewItemId}-1`] : null,
    artifactHashes: isRuntime ? [`sha256:${reviewItemId}-bytes`] : null,
    payload: {},
    metadata: { contextRefs: fixtureDecisionContextRefs(reviewItemId) },
    createdByUserId: null,
    assignedToUserId: null,
    createdAt: fixtureCreatedAt,
    updatedAt: fixtureCreatedAt,
    resolvedAt: state === reviewerQueueItemStateValues.pending ? null : fixtureCreatedAt,
    ...overrides,
  };
}

export function fixtureDecisionContextRefs(reviewItemId: string): ReviewerQueueDecisionContextRefs {
  return {
    source: {
      bridgeUnitId: `bridge-unit-${reviewItemId}`,
      sourceUnitKey: `scene.001.${reviewItemId}`,
      sourceRevisionId: fixtureSourceRevisionId,
    },
    draft: {
      draftId: `draft-${reviewItemId}`,
      draftAttemptId: `draft-attempt-${reviewItemId}`,
    },
    runtime: {
      runtimeTargetId: `runtime-target-${reviewItemId}`,
      observationEventIds: [`observation-${reviewItemId}-1`],
      artifactHashes: [`sha256:${reviewItemId}-runtime`],
    },
    style: {
      styleGuidePolicyVersionId: `style-policy-${reviewItemId}`,
    },
    glossary: {
      termIds: [`term-${reviewItemId}`],
    },
    qa: {
      findingIds: [`finding-${reviewItemId}`],
    },
  };
}

export function fixtureBatchPermissionView(
  overrides: Partial<ReviewerBatchPermissionView> = {},
): ReviewerBatchPermissionView {
  return {
    actorUserId: "local-user",
    canReadQueue: true,
    canManageQueue: true,
    denialReasons: [],
    ...overrides,
  };
}

export function fixtureRerunJobConsequence(reviewItemId: string): ReviewerBatchConsequence {
  return {
    kind: "rerun_job",
    runtimeTargetId: `utsushi-runtime-target-${reviewItemId}`,
    jobLabel: `Rerun scene-1 trace for ${reviewItemId}`,
  };
}

export function fixturePolicyWriteConsequence(reviewItemId: string): ReviewerBatchConsequence {
  return {
    kind: "policy_version_write",
    styleGuidePolicyVersionId: `style-guide-version-${reviewItemId}`,
    ruleLabel: "Honorifics: keep -san suffix",
  };
}

export function fixtureGlossaryWriteConsequence(reviewItemId: string): ReviewerBatchConsequence {
  return {
    kind: "glossary_term_write",
    termId: `term-${reviewItemId}`,
    approvedTranslation: "Hero",
  };
}

export function fixtureExportConsequence(reviewItemId: string): ReviewerBatchConsequence {
  return {
    kind: "export_artifact",
    exportArtifactId: `export-artifact-${reviewItemId}`,
    artifactLabel: "Patch bundle for Sweetie HD",
  };
}

export function fixtureBenchmarkConsequence(reviewItemId: string): ReviewerBatchConsequence {
  return {
    kind: "benchmark_artifact",
    benchmarkArtifactId: `benchmark-${reviewItemId}`,
    benchmarkLabel: "Scene 1 baseline",
  };
}

export function fixtureDraftStateChangeConsequence(reviewItemId: string): ReviewerBatchConsequence {
  return {
    kind: "draft_state_change",
    draftId: `draft-${reviewItemId}`,
    nextDraftStatus: "accepted",
  };
}

// -- Item fixtures ---------------------------------------------------

export function fixturePendingQaItem(
  reviewItemId = "reviewer-queue-083-qa-1",
  overrides: Partial<ReviewerQueueItemRecord> = {},
): ReviewerQueueItemRecord {
  return makeItem(
    reviewItemId,
    reviewerQueueItemKindValues.qa,
    reviewerQueueItemStateValues.pending,
    overrides,
  );
}

export function fixturePendingGlossaryItem(
  reviewItemId = "reviewer-queue-083-glossary-1",
  overrides: Partial<ReviewerQueueItemRecord> = {},
): ReviewerQueueItemRecord {
  return makeItem(
    reviewItemId,
    reviewerQueueItemKindValues.glossary,
    reviewerQueueItemStateValues.pending,
    overrides,
  );
}

export function fixturePendingRuntimeEvidenceItem(
  reviewItemId = "reviewer-queue-083-runtime-1",
  overrides: Partial<ReviewerQueueItemRecord> = {},
): ReviewerQueueItemRecord {
  return makeItem(
    reviewItemId,
    reviewerQueueItemKindValues.runtimeEvidence,
    reviewerQueueItemStateValues.pending,
    overrides,
  );
}

export function fixtureAcceptedItem(
  reviewItemId = "reviewer-queue-083-resolved-1",
): ReviewerQueueItemRecord {
  return makeItem(
    reviewItemId,
    reviewerQueueItemKindValues.qa,
    reviewerQueueItemStateValues.accepted,
  );
}

// -- Request fixtures -----------------------------------------------

export function fixtureEmptyRequest(): ReviewerBatchActionRequest {
  return {
    action: reviewerQueueActionValues.approve,
    actorUserId: "local-user",
    selections: [],
  };
}

export function fixtureMixedKindRequest(): ReviewerBatchActionRequest {
  return {
    action: reviewerQueueActionValues.approve,
    actorUserId: "local-user",
    selections: [
      {
        reviewItemId: "reviewer-queue-083-qa-1",
        expectedSourceRevisionId: fixtureSourceRevisionId,
      },
      {
        reviewItemId: "reviewer-queue-083-glossary-1",
        expectedSourceRevisionId: fixtureSourceRevisionId,
      },
      {
        reviewItemId: "reviewer-queue-083-runtime-1",
        expectedSourceRevisionId: fixtureSourceRevisionId,
      },
    ],
  };
}

export function fixtureConflictingActionRequest(): ReviewerBatchActionRequest {
  // `updateGlossary` is only valid for glossary kind. Mixing it with a
  // qa item triggers the action-allowed-kinds refusal.
  return {
    action: reviewerQueueActionValues.updateGlossary,
    actorUserId: "local-user",
    selections: [
      {
        reviewItemId: "reviewer-queue-083-glossary-1",
        expectedSourceRevisionId: fixtureSourceRevisionId,
      },
      {
        reviewItemId: "reviewer-queue-083-qa-1",
        expectedSourceRevisionId: fixtureSourceRevisionId,
      },
    ],
  };
}

// -- Preview row fixtures --------------------------------------------

function makePreviewItem(overrides: Partial<BatchPreviewItem>): BatchPreviewItem {
  return {
    reviewItemId: "reviewer-queue-083-qa-1",
    expectedSourceRevisionId: fixtureSourceRevisionId,
    status: reviewerBatchPreviewStatusValues.allowed,
    action: reviewerQueueActionValues.approve,
    requiredPermission: "queue.manage",
    item: fixturePendingQaItem(),
    priorState: reviewerQueueItemStateValues.pending,
    nextState: reviewerQueueItemStateValues.accepted,
    diagnostics: [],
    message: null,
    consequences: [],
    ...overrides,
  };
}

export function fixtureAllowedRow(reviewItemId = "reviewer-queue-083-qa-1"): BatchPreviewItem {
  return makePreviewItem({
    reviewItemId,
    item: fixturePendingQaItem(reviewItemId),
    consequences: [
      fixtureRerunJobConsequence(reviewItemId),
      fixtureDraftStateChangeConsequence(reviewItemId),
      fixtureExportConsequence(reviewItemId),
    ],
  });
}

export function fixtureAllowedGlossaryRow(
  reviewItemId = "reviewer-queue-083-glossary-1",
): BatchPreviewItem {
  return makePreviewItem({
    reviewItemId,
    action: reviewerQueueActionValues.updateGlossary,
    item: fixturePendingGlossaryItem(reviewItemId),
    consequences: [
      fixtureGlossaryWriteConsequence(reviewItemId),
      fixturePolicyWriteConsequence(reviewItemId),
    ],
  });
}

export function fixtureAllowedRuntimeRow(
  reviewItemId = "reviewer-queue-083-runtime-1",
): BatchPreviewItem {
  return makePreviewItem({
    reviewItemId,
    action: reviewerQueueActionValues.importRuntimeFeedback,
    item: fixturePendingRuntimeEvidenceItem(reviewItemId),
    consequences: [
      fixtureRerunJobConsequence(reviewItemId),
      fixtureBenchmarkConsequence(reviewItemId),
    ],
  });
}

export function fixtureStaleRow(reviewItemId = "reviewer-queue-083-stale-1"): BatchPreviewItem {
  const item = makeItem(
    reviewItemId,
    reviewerQueueItemKindValues.qa,
    reviewerQueueItemStateValues.pending,
    {
      sourceRevisionId: "source-revision-itotori-083-newer",
    },
  );
  return makePreviewItem({
    reviewItemId,
    status: reviewerBatchPreviewStatusValues.staleRevision,
    item,
    priorState: item.state,
    nextState: null,
    diagnostics: [
      {
        code: "reviewer_queue_item_stale_revision",
        message: `current source_revision_id=${item.sourceRevisionId}`,
      },
    ],
    message: `reviewer action targeted source_revision=${fixtureSourceRevisionId} but item ${reviewItemId} is on source_revision=${item.sourceRevisionId}`,
  });
}

export function fixtureInvalidInputRow(
  reviewItemId = "reviewer-queue-083-conflict-1",
): BatchPreviewItem {
  return makePreviewItem({
    reviewItemId,
    action: reviewerQueueActionValues.updateGlossary,
    status: reviewerBatchPreviewStatusValues.invalidInput,
    item: fixturePendingQaItem(reviewItemId),
    priorState: reviewerQueueItemStateValues.pending,
    nextState: null,
    diagnostics: [],
    message: `action 'update_glossary' is not valid for item kind 'qa'`,
  });
}

export function fixtureInvalidTransitionRow(
  reviewItemId = "reviewer-queue-083-resolved-1",
): BatchPreviewItem {
  const item = fixtureAcceptedItem(reviewItemId);
  return makePreviewItem({
    reviewItemId,
    status: reviewerBatchPreviewStatusValues.invalidTransition,
    item,
    priorState: item.state,
    nextState: null,
    diagnostics: [
      {
        code: "reviewer_queue_item_invalid_transition",
        message: `prior_state=${item.state} requested_next_state=accepted`,
      },
    ],
    message: `cannot transition reviewer queue item ${reviewItemId} from 'accepted' to 'accepted' via action 'approve'`,
  });
}

export function fixtureNotFoundRow(
  reviewItemId = "reviewer-queue-083-missing-1",
): BatchPreviewItem {
  return makePreviewItem({
    reviewItemId,
    status: reviewerBatchPreviewStatusValues.notFound,
    item: null,
    priorState: null,
    nextState: null,
    diagnostics: [
      {
        code: "reviewer_queue_item_not_found",
        message: `reviewer queue item ${reviewItemId} not found`,
      },
    ],
    message: `reviewer queue item ${reviewItemId} not found`,
  });
}

export function fixtureDuplicateRow(reviewItemId = "reviewer-queue-083-qa-1"): BatchPreviewItem {
  return makePreviewItem({
    reviewItemId,
    status: reviewerBatchPreviewStatusValues.duplicateSelection,
    item: null,
    priorState: null,
    nextState: null,
    diagnostics: [
      {
        code: "reviewer_batch_duplicate_selection",
        message: `review item ${reviewItemId} appears more than once in the batch selection; refuse closed`,
      },
    ],
    message: `review item ${reviewItemId} appears more than once in the batch selection`,
  });
}

// -- Preview aggregate fixtures --------------------------------------

export function fixtureEmptyPreview(): ReviewerBatchPreview {
  return {
    request: fixtureEmptyRequest(),
    permission: fixtureBatchPermissionView(),
    items: [],
    aggregate: {
      total: 0,
      allowed: 0,
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
    allAllowed: false,
    permissionDenied: false,
  };
}

export function fixtureAllAllowedPreview(): ReviewerBatchPreview {
  const items = [
    fixtureAllowedRow("reviewer-queue-083-qa-1"),
    fixtureAllowedRow("reviewer-queue-083-qa-2"),
  ];
  const request: ReviewerBatchActionRequest = {
    action: reviewerQueueActionValues.approve,
    actorUserId: "local-user",
    selections: items.map((entry) => ({
      reviewItemId: entry.reviewItemId,
      expectedSourceRevisionId: entry.expectedSourceRevisionId,
    })),
  };
  return {
    request,
    permission: fixtureBatchPermissionView(),
    items,
    aggregate: {
      total: 2,
      allowed: 2,
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
    allAllowed: true,
    permissionDenied: false,
  };
}

/**
 * Mixed allowed / denied / stale / conflicting / not-found preview —
 * the canonical fixture for acceptance #4 "Dashboard fixtures cover
 * empty selection, mixed item kinds, conflicting actions, and
 * successful atomic batch execution."
 */
export function fixtureMixedPreview(): ReviewerBatchPreview {
  const items: BatchPreviewItem[] = [
    fixtureAllowedRow("reviewer-queue-083-qa-1"),
    fixtureStaleRow("reviewer-queue-083-stale-1"),
    fixtureInvalidInputRow("reviewer-queue-083-conflict-1"),
    fixtureInvalidTransitionRow("reviewer-queue-083-resolved-1"),
    fixtureNotFoundRow("reviewer-queue-083-missing-1"),
  ];
  const request: ReviewerBatchActionRequest = {
    action: reviewerQueueActionValues.approve,
    actorUserId: "local-user",
    selections: items.map((entry) => ({
      reviewItemId: entry.reviewItemId,
      expectedSourceRevisionId: entry.expectedSourceRevisionId,
    })),
  };
  return {
    request,
    permission: fixtureBatchPermissionView(),
    items,
    aggregate: {
      total: 5,
      allowed: 1,
      denied: 4,
      stale: 1,
      notFound: 1,
      duplicate: 0,
      runtimeEvidenceInvariant: 0,
      invalidInput: 1,
      invalidTransition: 1,
      concurrentModification: 0,
      permissionDeniedRead: 0,
      permissionDeniedManage: 0,
    },
    allAllowed: false,
    permissionDenied: false,
  };
}

export function fixtureDeniedPreview(actorUserId = "anon"): ReviewerBatchPreview {
  const request: ReviewerBatchActionRequest = {
    action: reviewerQueueActionValues.approve,
    actorUserId,
    selections: [
      {
        reviewItemId: "reviewer-queue-083-qa-1",
        expectedSourceRevisionId: fixtureSourceRevisionId,
      },
    ],
  };
  return {
    request,
    permission: {
      actorUserId,
      canReadQueue: false,
      canManageQueue: false,
      denialReasons: [`user ${actorUserId} is missing permission queue.read`],
    },
    items: [
      {
        reviewItemId: "reviewer-queue-083-qa-1",
        expectedSourceRevisionId: fixtureSourceRevisionId,
        status: reviewerBatchPreviewStatusValues.permissionDeniedRead,
        action: reviewerQueueActionValues.approve,
        requiredPermission: "queue.read",
        item: null,
        priorState: null,
        nextState: null,
        diagnostics: [
          {
            code: "reviewer_batch_permission_denied_read",
            message: `user ${actorUserId} is missing permission queue.read`,
          },
        ],
        message: `user ${actorUserId} is missing permission queue.read`,
        consequences: [],
      },
    ],
    aggregate: {
      total: 1,
      allowed: 0,
      denied: 1,
      stale: 0,
      notFound: 0,
      duplicate: 0,
      runtimeEvidenceInvariant: 0,
      invalidInput: 0,
      invalidTransition: 0,
      concurrentModification: 0,
      permissionDeniedRead: 1,
      permissionDeniedManage: 0,
    },
    allAllowed: false,
    permissionDenied: true,
  };
}

export const itotori083FixtureProjectId = fixtureProjectId;
export const itotori083FixtureLocaleBranchId = fixtureLocaleBranchId;
export const itotori083FixtureSourceRevisionId = fixtureSourceRevisionId;
