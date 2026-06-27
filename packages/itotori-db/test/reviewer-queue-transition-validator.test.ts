// ITOTORI-083 — Shared transition validator unit tests.
//
// The validator is the SINGLE source of truth used by both
// `ItotoriReviewerQueueRepository.applyAction` (execution) and
// `ReviewerBatchPreviewService.preview` (preview). This file pins the
// validator's behavior in isolation — same input → same diagnostic.

import { describe, expect, it } from "vitest";
import {
  reviewerQueueActionAllowedKinds,
  reviewerQueueActionToNextState,
  reviewerQueueActionValues,
  reviewerQueueAllowedTransitions,
  reviewerQueueItemKindValues,
  reviewerQueueItemStateValues,
  validateReviewerQueueTransition,
} from "../src/repositories/reviewer-queue-repository.js";
import type { ReviewerQueueItemRecord } from "../src/schema.js";

function makeItem(overrides: Partial<ReviewerQueueItemRecord> = {}): ReviewerQueueItemRecord {
  return {
    reviewItemId: "reviewer-queue-test",
    projectId: "project-test",
    localeBranchId: "branch-test",
    sourceRevisionId: "source-revision-test",
    itemKind: reviewerQueueItemKindValues.qa,
    sourceItemRef: "ref-test",
    state: reviewerQueueItemStateValues.pending,
    priority: 0,
    summary: "test",
    affectedArtifactIds: [],
    evidenceTier: null,
    observationEventIds: null,
    artifactHashes: null,
    payload: {},
    metadata: {},
    createdByUserId: null,
    assignedToUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    resolvedAt: null,
    ...overrides,
  };
}

describe("validateReviewerQueueTransition — allowed", () => {
  it("returns ok with the action's default next state when the action is valid", () => {
    const result = validateReviewerQueueTransition({
      item: makeItem(),
      action: reviewerQueueActionValues.approve,
      expectedSourceRevisionId: "source-revision-test",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nextState).toBe(reviewerQueueItemStateValues.accepted);
      expect(result.priorState).toBe(reviewerQueueItemStateValues.pending);
    }
  });

  it("honors a forcedNextState override when supplied", () => {
    const result = validateReviewerQueueTransition({
      item: makeItem(),
      action: reviewerQueueActionValues.approve,
      expectedSourceRevisionId: "source-revision-test",
      forcedNextState: reviewerQueueItemStateValues.inReview,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nextState).toBe(reviewerQueueItemStateValues.inReview);
    }
  });

  it("allows defer from pending into the deferred state", () => {
    const result = validateReviewerQueueTransition({
      item: makeItem(),
      action: reviewerQueueActionValues.defer,
      expectedSourceRevisionId: "source-revision-test",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nextState).toBe(reviewerQueueItemStateValues.deferred);
      expect(result.priorState).toBe(reviewerQueueItemStateValues.pending);
    }
  });
});

describe("validateReviewerQueueTransition — refusal taxonomy", () => {
  it("returns reviewer_queue_item_invalid_input when the action is not allowed for the kind", () => {
    const result = validateReviewerQueueTransition({
      item: makeItem({ itemKind: reviewerQueueItemKindValues.qa }),
      action: reviewerQueueActionValues.updateGlossary,
      expectedSourceRevisionId: "source-revision-test",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("reviewer_queue_item_invalid_input");
      expect(result.message).toContain("action 'update_glossary'");
      expect(result.message).toContain("'qa'");
    }
  });

  it("returns reviewer_queue_item_stale_revision when the expected revision does not match", () => {
    const result = validateReviewerQueueTransition({
      item: makeItem(),
      action: reviewerQueueActionValues.approve,
      expectedSourceRevisionId: "source-revision-other",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("reviewer_queue_item_stale_revision");
      expect(result.diagnostics[0]?.code).toBe("reviewer_queue_item_stale_revision");
      expect(result.message).toContain("targeted source_revision=source-revision-other");
      expect(result.message).toContain("source_revision=source-revision-test");
    }
  });

  it("returns reviewer_queue_item_runtime_evidence_invariant when runtime fields are missing", () => {
    const result = validateReviewerQueueTransition({
      item: makeItem({
        itemKind: reviewerQueueItemKindValues.runtimeEvidence,
        evidenceTier: null,
        observationEventIds: null,
        artifactHashes: null,
      }),
      action: reviewerQueueActionValues.approve,
      expectedSourceRevisionId: "source-revision-test",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("reviewer_queue_item_runtime_evidence_invariant");
    }
  });

  it("returns reviewer_queue_item_invalid_transition for terminal-state attempts", () => {
    const result = validateReviewerQueueTransition({
      item: makeItem({ state: reviewerQueueItemStateValues.accepted }),
      action: reviewerQueueActionValues.approve,
      expectedSourceRevisionId: "source-revision-test",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("reviewer_queue_item_invalid_transition");
      expect(result.diagnostics[0]?.code).toBe("reviewer_queue_item_invalid_transition");
      expect(result.message).toContain("from 'accepted' to 'accepted'");
    }
  });
});

describe("validateReviewerQueueTransition — exported constants", () => {
  it("exposes a non-empty closed list of allowed transitions", () => {
    expect(reviewerQueueAllowedTransitions.length).toBeGreaterThan(0);
    for (const [prior, next] of reviewerQueueAllowedTransitions) {
      expect(typeof prior).toBe("string");
      expect(typeof next).toBe("string");
    }
  });

  it("exposes the action → next-state default mapping", () => {
    expect(reviewerQueueActionToNextState[reviewerQueueActionValues.approve]).toBe(
      reviewerQueueItemStateValues.accepted,
    );
    expect(reviewerQueueActionToNextState[reviewerQueueActionValues.reject]).toBe(
      reviewerQueueItemStateValues.rejected,
    );
    expect(reviewerQueueActionToNextState[reviewerQueueActionValues.defer]).toBe(
      reviewerQueueItemStateValues.deferred,
    );
    expect(reviewerQueueActionToNextState[reviewerQueueActionValues.requestRepair]).toBe(
      reviewerQueueItemStateValues.repairRequested,
    );
  });

  it("exposes the per-action allowed kinds", () => {
    expect(reviewerQueueActionAllowedKinds[reviewerQueueActionValues.updateGlossary]).toEqual([
      reviewerQueueItemKindValues.glossary,
    ]);
    expect(reviewerQueueActionAllowedKinds[reviewerQueueActionValues.updateStyle]).toEqual([
      reviewerQueueItemKindValues.style,
    ]);
  });
});
