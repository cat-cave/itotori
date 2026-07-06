// ITOTORI-081 — ReviewerQueueAction service tests (no DB).
//
// The service is a typed shell over the reviewer-queue repository. The
// tests below stub the repository so we can assert the action API
// dispatches to the correct (action, metadata) pair and that the input
// guards refuse malformed action payloads. Repository-side state machine
// invariants live in packages/itotori-db/test/reviewer-queue-repository.

import { describe, expect, it, vi } from "vitest";
import type {
  AuthorizationActor,
  ItotoriReviewerQueueRepositoryPort,
  JobQueueInput,
  ReviewerQueueActionInput,
  ReviewerQueueActionJobPlanner,
  ReviewerQueueActionResult,
  ReviewerQueueItemRecord,
  ReviewerQueueTransitionRecord,
} from "@itotori/db";
import {
  ReviewerQueueRepositoryError,
  reviewerQueueActionValues,
  reviewerQueueItemKindValues,
  reviewerQueueItemStateValues,
} from "@itotori/db";
import {
  isRuntimeEvidenceItem,
  ReviewerQueueActionService,
  ReviewerQueueActionServiceInputError,
  type ReviewerQueueDecisionContextRefs,
  reviewerTriggeredRerunJobNameValues,
} from "../src/reviewer/index.js";

const actor: AuthorizationActor = { userId: "local-user" };
const decisionContextRefs: ReviewerQueueDecisionContextRefs = {
  source: {
    bridgeUnitId: "bridge-unit-fixture",
    sourceUnitKey: "scene.001.line.001",
    sourceRevisionId: "source-revision-fixture",
  },
  draft: {
    draftId: "draft-fixture",
    draftAttemptId: "draft-attempt-fixture",
  },
  runtime: {
    runtimeTargetId: "runtime-target-fixture",
    observationEventIds: ["observation-fixture-1"],
    artifactHashes: ["sha256:runtime-fixture"],
  },
  style: {
    styleGuidePolicyVersionId: "style-guide-version-fixture",
  },
  glossary: {
    termIds: ["term-fixture"],
  },
  qa: {
    findingIds: ["qa-finding-fixture"],
  },
};

function itemFixture(overrides: Partial<ReviewerQueueItemRecord> = {}): ReviewerQueueItemRecord {
  return {
    reviewItemId: "reviewer-queue-fixture-1",
    projectId: "project-fixture",
    localeBranchId: "branch-fixture",
    sourceRevisionId: "source-revision-fixture",
    itemKind: reviewerQueueItemKindValues.qa,
    sourceItemRef: "qa-finding-1",
    state: reviewerQueueItemStateValues.accepted,
    priority: 0,
    summary: "fixture",
    affectedArtifactIds: [],
    evidenceTier: null,
    observationEventIds: null,
    artifactHashes: null,
    payload: {},
    metadata: {},
    createdByUserId: null,
    assignedToUserId: null,
    createdAt: new Date("2026-06-24T00:00:00Z"),
    updatedAt: new Date("2026-06-24T00:00:00Z"),
    resolvedAt: new Date("2026-06-24T00:00:00Z"),
    ...overrides,
  };
}

function transitionFixture(
  overrides: Partial<ReviewerQueueTransitionRecord> = {},
): ReviewerQueueTransitionRecord {
  return {
    transitionId: "reviewer-queue-transition-fixture-1",
    reviewItemId: "reviewer-queue-fixture-1",
    localeBranchId: "branch-fixture",
    sourceRevisionId: "source-revision-fixture",
    itemKind: reviewerQueueItemKindValues.qa,
    action: reviewerQueueActionValues.approve,
    priorState: reviewerQueueItemStateValues.pending,
    nextState: reviewerQueueItemStateValues.accepted,
    actorUserId: "local-user",
    affectedArtifactIds: [],
    diagnostics: [],
    metadata: {},
    createdAt: new Date("2026-06-24T00:00:00Z"),
    ...overrides,
  };
}

function itemKindForAction(input: ReviewerQueueActionInput): ReviewerQueueItemRecord["itemKind"] {
  switch (input.action) {
    case reviewerQueueActionValues.updateStyle:
      return reviewerQueueItemKindValues.style;
    case reviewerQueueActionValues.updateGlossary:
      return reviewerQueueItemKindValues.glossary;
    case reviewerQueueActionValues.importRuntimeFeedback:
      return reviewerQueueItemKindValues.feedback;
    default:
      return reviewerQueueItemKindValues.qa;
  }
}

function makeStubRepo(): {
  repo: ItotoriReviewerQueueRepositoryPort;
  applyAction: ReturnType<typeof vi.fn>;
  applyActionAndEnqueueJobs: ReturnType<typeof vi.fn>;
  applyActionsAndEnqueueJobs: ReturnType<typeof vi.fn>;
  getItem: ReturnType<typeof vi.fn>;
  getItemForManage: ReturnType<typeof vi.fn>;
  plannedJobs: JobQueueInput[];
} {
  const applyAction = vi.fn<
    [AuthorizationActor, ReviewerQueueActionInput],
    Promise<ReviewerQueueActionResult>
  >();
  applyAction.mockImplementation(async (_actor, input) =>
    Promise.resolve({
      item: itemFixture({
        reviewItemId: input.reviewItemId,
        itemKind: itemKindForAction(input),
        state:
          input.action === reviewerQueueActionValues.requestRepair
            ? reviewerQueueItemStateValues.repairRequested
            : input.action === reviewerQueueActionValues.defer
              ? reviewerQueueItemStateValues.deferred
              : input.action === reviewerQueueActionValues.escalate
                ? reviewerQueueItemStateValues.escalated
                : input.action === reviewerQueueActionValues.reject
                  ? reviewerQueueItemStateValues.rejected
                  : reviewerQueueItemStateValues.accepted,
      }),
      transition: transitionFixture({
        reviewItemId: input.reviewItemId,
        itemKind: itemKindForAction(input),
        action: input.action,
        actorUserId: input.actorUserId,
        affectedArtifactIds: input.affectedArtifactIds ?? [],
        metadata: input.metadata ?? {},
      }),
    }),
  );
  const plannedJobs: JobQueueInput[] = [];
  const applyActionAndEnqueueJobs = vi.fn<
    [AuthorizationActor, ReviewerQueueActionInput, ReviewerQueueActionJobPlanner],
    Promise<{ actionResult: ReviewerQueueActionResult; jobs: [] }>
  >();
  applyActionAndEnqueueJobs.mockImplementation(async (actor, input, planJobs) => {
    const actionResult = await applyAction(actor, input);
    plannedJobs.push(...(await planJobs(actionResult)));
    return { actionResult, jobs: [] };
  });
  const applyActionsAndEnqueueJobs = vi.fn<
    [AuthorizationActor, readonly ReviewerQueueActionInput[], ReviewerQueueActionJobPlanner],
    Promise<{ actionResults: ReviewerQueueActionResult[]; jobs: [] }>
  >();
  applyActionsAndEnqueueJobs.mockImplementation(async (actor, inputs, planJobs) => {
    const actionResults: ReviewerQueueActionResult[] = [];
    for (const input of inputs) {
      const actionResult = await applyAction(actor, input);
      plannedJobs.push(...(await planJobs(actionResult)));
      actionResults.push(actionResult);
    }
    return { actionResults, jobs: [] };
  });
  // Default to a feedback-kind item: feedback items carry no persisted
  // evidence tier, so importRuntimeFeedback records the supplied values
  // verbatim without a persisted-vs-supplied comparison. Runtime-evidence
  // tests override this to exercise the enforcement path.
  const getItem = vi.fn<[AuthorizationActor, string], Promise<ReviewerQueueItemRecord | null>>();
  getItem.mockImplementation(async (_actor, reviewItemId) =>
    itemFixture({ reviewItemId, itemKind: reviewerQueueItemKindValues.feedback }),
  );
  // importRuntimeFeedback reads the item it is about to manage under the
  // MANAGE scope (`getItemForManage`, gated on queue.manage), never the
  // public queue.read `getItem`. Runtime-evidence enforcement tests drive
  // this mock, not `getItem`.
  const getItemForManage = vi.fn<
    [AuthorizationActor, string],
    Promise<ReviewerQueueItemRecord | null>
  >();
  getItemForManage.mockImplementation(async (_actor, reviewItemId) =>
    itemFixture({ reviewItemId, itemKind: reviewerQueueItemKindValues.feedback }),
  );
  const repo: ItotoriReviewerQueueRepositoryPort = {
    createItem: vi.fn(),
    applyAction,
    applyActionAndEnqueueJobs,
    applyActionsAndEnqueueJobs,
    getItem,
    getItemForManage,
    loadItemsByBranch: vi.fn(),
    loadTransitionsByItem: vi.fn(),
  };
  return {
    repo,
    applyAction,
    applyActionAndEnqueueJobs,
    applyActionsAndEnqueueJobs,
    getItem,
    getItemForManage,
    plannedJobs,
  };
}

describe("ReviewerQueueActionService", () => {
  it("approve dispatches the approve action with the carried metadata", async () => {
    const { repo, applyAction } = makeStubRepo();
    const service = new ReviewerQueueActionService(repo);

    const result = await service.approve(actor, {
      reviewItemId: "reviewer-queue-1",
      actorUserId: "local-user",
      expectedSourceRevisionId: "source-revision-fixture",
      contextRefs: decisionContextRefs,
      metadata: { reviewerNote: "looks good" },
    });

    expect(result.transition.action).toBe(reviewerQueueActionValues.approve);
    expect(applyAction).toHaveBeenCalledTimes(1);
    expect(applyAction.mock.calls[0]![1]).toMatchObject({
      action: reviewerQueueActionValues.approve,
      reviewItemId: "reviewer-queue-1",
      expectedSourceRevisionId: "source-revision-fixture",
      metadata: { reviewerNote: "looks good", contextRefs: decisionContextRefs },
    });
  });

  it("reject dispatches the reject action", async () => {
    const { repo, applyAction } = makeStubRepo();
    const service = new ReviewerQueueActionService(repo);

    await service.reject(actor, {
      reviewItemId: "reviewer-queue-2",
      actorUserId: "local-user",
      expectedSourceRevisionId: "source-revision-fixture",
      contextRefs: decisionContextRefs,
    });

    expect(applyAction.mock.calls[0]![1]!.action).toBe(reviewerQueueActionValues.reject);
  });

  it("reject preserves style dispute rationale metadata", async () => {
    const { repo, applyAction } = makeStubRepo();
    const service = new ReviewerQueueActionService(repo);

    await service.reject(actor, {
      reviewItemId: "reviewer-queue-style-dispute-reject",
      actorUserId: "local-user",
      expectedSourceRevisionId: "source-revision-fixture",
      contextRefs: decisionContextRefs,
      metadata: {
        rejectionReason: "Project voice guide already requires informal protagonist lines.",
        styleDisputeKey: "feedback-1",
      },
    });

    expect(applyAction.mock.calls[0]![1]!.metadata).toMatchObject({
      rejectionReason: "Project voice guide already requires informal protagonist lines.",
      styleDisputeKey: "feedback-1",
      contextRefs: decisionContextRefs,
    });
  });

  it("defer dispatches the defer action with no rerun jobs", async () => {
    const { repo, applyAction, plannedJobs } = makeStubRepo();
    const service = new ReviewerQueueActionService(repo);

    const result = await service.defer(actor, {
      reviewItemId: "reviewer-queue-defer",
      actorUserId: "local-user",
      expectedSourceRevisionId: "source-revision-fixture",
      contextRefs: decisionContextRefs,
      deferReason: "needs bilingual owner review",
    });

    expect(result.item.state).toBe(reviewerQueueItemStateValues.deferred);
    expect(applyAction.mock.calls[0]![1]!.action).toBe(reviewerQueueActionValues.defer);
    expect(applyAction.mock.calls[0]![1]!.metadata).toMatchObject({
      deferReason: "needs bilingual owner review",
      contextRefs: decisionContextRefs,
    });
    expect(plannedJobs).toHaveLength(0);
  });

  it("escalate dispatches the escalate action with no rerun jobs", async () => {
    const { repo, applyAction, plannedJobs } = makeStubRepo();
    const service = new ReviewerQueueActionService(repo);

    const result = await service.escalate(actor, {
      reviewItemId: "reviewer-queue-escalate",
      actorUserId: "local-user",
      expectedSourceRevisionId: "source-revision-fixture",
      contextRefs: decisionContextRefs,
      escalationReason: "ambiguous tone",
      escalationTarget: "owner-review",
    });

    expect(result.item.state).toBe(reviewerQueueItemStateValues.escalated);
    expect(applyAction.mock.calls[0]![1]!.action).toBe(reviewerQueueActionValues.escalate);
    expect(applyAction.mock.calls[0]![1]!.metadata).toMatchObject({
      escalationReason: "ambiguous tone",
      escalationTarget: "owner-review",
      contextRefs: decisionContextRefs,
    });
    expect(plannedJobs).toHaveLength(0);
  });

  it("refuses context-free decisions before repository mutation", async () => {
    const { repo, applyActionAndEnqueueJobs } = makeStubRepo();
    const service = new ReviewerQueueActionService(repo);

    await expect(
      service.approve(actor, {
        reviewItemId: "reviewer-queue-context-free",
        actorUserId: "local-user",
        expectedSourceRevisionId: "source-revision-fixture",
      }),
    ).rejects.toMatchObject({
      name: "ReviewerQueueActionServiceInputError",
      field: "contextRefs",
    });

    expect(applyActionAndEnqueueJobs).not.toHaveBeenCalled();
  });

  it("requestRepair refuses an empty repairHint", async () => {
    const { repo } = makeStubRepo();
    const service = new ReviewerQueueActionService(repo);

    await expect(
      service.requestRepair(actor, {
        reviewItemId: "reviewer-queue-3",
        actorUserId: "local-user",
        expectedSourceRevisionId: "source-revision-fixture",
        repairHint: "",
      }),
    ).rejects.toBeInstanceOf(ReviewerQueueActionServiceInputError);
  });

  it("requestRepair forwards repairHint onto the transition metadata", async () => {
    const { repo, applyAction } = makeStubRepo();
    const service = new ReviewerQueueActionService(repo);

    await service.requestRepair(actor, {
      reviewItemId: "reviewer-queue-4",
      actorUserId: "local-user",
      expectedSourceRevisionId: "source-revision-fixture",
      contextRefs: decisionContextRefs,
      repairHint: "re-translate with tighter glossary",
      metadata: { reviewerNote: "needs glossary" },
    });

    expect(applyAction.mock.calls[0]![1]!.metadata).toMatchObject({
      repairHint: "re-translate with tighter glossary",
      reviewerNote: "needs glossary",
      contextRefs: decisionContextRefs,
    });
  });

  it("plans reviewer reruns inside the repository action composition", async () => {
    const { repo, applyActionAndEnqueueJobs, plannedJobs } = makeStubRepo();
    const service = new ReviewerQueueActionService(repo);

    const result = await service.requestRepair(actor, {
      reviewItemId: "reviewer-queue-rerun",
      actorUserId: "local-user",
      expectedSourceRevisionId: "source-revision-fixture",
      contextRefs: decisionContextRefs,
      repairHint: "targeted repair",
    });

    expect(applyActionAndEnqueueJobs).toHaveBeenCalledTimes(1);
    expect(applyActionAndEnqueueJobs.mock.calls[0]![0]).toBe(actor);
    expect(result.transition.action).toBe(reviewerQueueActionValues.requestRepair);
    expect(plannedJobs.map((job) => job.jobName)).toEqual([
      reviewerTriggeredRerunJobNameValues.draftRepair,
      reviewerTriggeredRerunJobNameValues.qaReplay,
      reviewerTriggeredRerunJobNameValues.exportRegeneration,
      reviewerTriggeredRerunJobNameValues.runtimeValidation,
    ]);
    expect(plannedJobs.map((job) => job.dependsOnJobIds)).toEqual([
      [],
      [plannedJobs[0]!.jobId],
      [plannedJobs[1]!.jobId],
      [plannedJobs[2]!.jobId],
    ]);
  });

  it("does not enter the repository composition when input validation fails", async () => {
    const { repo, applyActionAndEnqueueJobs } = makeStubRepo();
    const service = new ReviewerQueueActionService(repo);

    await expect(
      service.requestRepair(actor, {
        reviewItemId: "reviewer-queue-invalid",
        actorUserId: "local-user",
        expectedSourceRevisionId: "source-revision-fixture",
        repairHint: "",
      }),
    ).rejects.toBeInstanceOf(ReviewerQueueActionServiceInputError);

    expect(applyActionAndEnqueueJobs).not.toHaveBeenCalled();
  });

  it("does not plan reruns when the repository denies or rejects the action", async () => {
    const { repo, applyActionAndEnqueueJobs, plannedJobs } = makeStubRepo();
    applyActionAndEnqueueJobs.mockRejectedValueOnce(
      new ReviewerQueueRepositoryError(
        "reviewer_queue_item_stale_revision",
        "stale source revision",
      ),
    );
    const service = new ReviewerQueueActionService(repo);

    await expect(
      service.requestRepair(actor, {
        reviewItemId: "reviewer-queue-stale",
        actorUserId: "local-user",
        expectedSourceRevisionId: "source-revision-old",
        contextRefs: decisionContextRefs,
        repairHint: "targeted repair",
      }),
    ).rejects.toBeInstanceOf(ReviewerQueueRepositoryError);

    expect(plannedJobs).toHaveLength(0);
  });

  it("updateGlossary requires termId and approvedTranslation", async () => {
    const { repo } = makeStubRepo();
    const service = new ReviewerQueueActionService(repo);

    await expect(
      service.updateGlossary(actor, {
        reviewItemId: "reviewer-queue-5",
        actorUserId: "local-user",
        expectedSourceRevisionId: "source-revision-fixture",
        termId: "",
        approvedTranslation: "Hero",
      }),
    ).rejects.toBeInstanceOf(ReviewerQueueActionServiceInputError);

    await expect(
      service.updateGlossary(actor, {
        reviewItemId: "reviewer-queue-5",
        actorUserId: "local-user",
        expectedSourceRevisionId: "source-revision-fixture",
        termId: "term-1",
        approvedTranslation: "",
      }),
    ).rejects.toBeInstanceOf(ReviewerQueueActionServiceInputError);
  });

  it("updateStyle forwards the style guide version id and rule label onto metadata", async () => {
    const { repo, applyAction } = makeStubRepo();
    const service = new ReviewerQueueActionService(repo);

    await service.updateStyle(actor, {
      reviewItemId: "reviewer-queue-6",
      actorUserId: "local-user",
      expectedSourceRevisionId: "source-revision-fixture",
      contextRefs: decisionContextRefs,
      styleGuideVersionId: "style-version-1",
      ruleLabel: "Honorifics: keep -san suffix",
    });

    expect(applyAction.mock.calls[0]![1]!.action).toBe(reviewerQueueActionValues.updateStyle);
    expect(applyAction.mock.calls[0]![1]!.metadata).toMatchObject({
      styleGuideVersionId: "style-version-1",
      ruleLabel: "Honorifics: keep -san suffix",
      contextRefs: decisionContextRefs,
    });
  });

  it("updateStyle on a style dispute item plans style invalidation reruns", async () => {
    const { repo, plannedJobs } = makeStubRepo();
    const service = new ReviewerQueueActionService(repo);

    await service.updateStyle(actor, {
      reviewItemId: "reviewer-queue-style-dispute",
      actorUserId: "local-user",
      expectedSourceRevisionId: "source-revision-fixture",
      contextRefs: decisionContextRefs,
      metadata: {
        styleDisputeKey: "feedback-1",
        feedbackReportId: "feedback-1",
        triageLabel: "style_dispute_candidate",
        affectedUnitIds: ["bridge-unit-from-feedback"],
      },
      styleGuideVersionId: "style-version-1",
      ruleLabel: "Protagonist voice: use casual register",
    });

    expect(plannedJobs.map((job) => job.jobName)).toEqual([
      reviewerTriggeredRerunJobNameValues.draftRepair,
      reviewerTriggeredRerunJobNameValues.qaReplay,
      reviewerTriggeredRerunJobNameValues.exportRegeneration,
      reviewerTriggeredRerunJobNameValues.runtimeValidation,
    ]);
    expect(plannedJobs[0]!.payload).toMatchObject({
      itemKind: reviewerQueueItemKindValues.style,
      reviewerAction: reviewerQueueActionValues.updateStyle,
      affectedUnitIds: ["bridge-unit-from-feedback"],
      ruleLabel: "Protagonist voice: use casual register",
      policyVersions: {
        styleGuideVersionId: "style-version-1",
      },
    });
  });

  it("importRuntimeFeedback refuses empty observationEventIds / artifactHashes", async () => {
    const { repo } = makeStubRepo();
    const service = new ReviewerQueueActionService(repo);

    await expect(
      service.importRuntimeFeedback(actor, {
        reviewItemId: "reviewer-queue-7",
        actorUserId: "local-user",
        expectedSourceRevisionId: "source-revision-fixture",
        evidenceTier: "tier-2",
        observationEventIds: [],
        artifactHashes: ["sha256:a"],
      }),
    ).rejects.toBeInstanceOf(ReviewerQueueActionServiceInputError);

    await expect(
      service.importRuntimeFeedback(actor, {
        reviewItemId: "reviewer-queue-7",
        actorUserId: "local-user",
        expectedSourceRevisionId: "source-revision-fixture",
        evidenceTier: "tier-2",
        observationEventIds: ["event-1"],
        artifactHashes: [],
      }),
    ).rejects.toBeInstanceOf(ReviewerQueueActionServiceInputError);
  });

  it("importRuntimeFeedback forwards the evidence tier verbatim onto transition metadata", async () => {
    const { repo, applyAction } = makeStubRepo();
    const service = new ReviewerQueueActionService(repo);

    await service.importRuntimeFeedback(actor, {
      reviewItemId: "reviewer-queue-8",
      actorUserId: "local-user",
      expectedSourceRevisionId: "source-revision-fixture",
      contextRefs: decisionContextRefs,
      evidenceTier: "tier-3-recording",
      observationEventIds: ["event-1", "event-2"],
      artifactHashes: ["sha256:a", "sha256:b"],
    });

    expect(applyAction.mock.calls[0]![1]!.action).toBe(
      reviewerQueueActionValues.importRuntimeFeedback,
    );
    expect(applyAction.mock.calls[0]![1]!.metadata).toEqual({
      evidenceTier: "tier-3-recording",
      observationEventIds: ["event-1", "event-2"],
      artifactHashes: ["sha256:a", "sha256:b"],
      contextRefs: decisionContextRefs,
    });
  });

  it("importRuntimeFeedback asserts the supplied evidence tier matches the persisted runtime-evidence item", async () => {
    const { repo, getItemForManage, applyActionAndEnqueueJobs } = makeStubRepo();
    getItemForManage.mockResolvedValue(
      itemFixture({
        reviewItemId: "reviewer-queue-runtime-mismatch",
        itemKind: reviewerQueueItemKindValues.runtimeEvidence,
        evidenceTier: "tier-2-trace",
        observationEventIds: ["event-1"],
        artifactHashes: ["sha256:a"],
      }),
    );
    const service = new ReviewerQueueActionService(repo);

    await expect(
      service.importRuntimeFeedback(actor, {
        reviewItemId: "reviewer-queue-runtime-mismatch",
        actorUserId: "local-user",
        expectedSourceRevisionId: "source-revision-fixture",
        contextRefs: decisionContextRefs,
        // Caller supplies a different (higher) tier than the item carries.
        evidenceTier: "tier-3-recording",
        observationEventIds: ["event-1"],
        artifactHashes: ["sha256:a"],
      }),
    ).rejects.toMatchObject({
      name: "ReviewerQueueActionServiceInputError",
      field: "evidenceTier",
    });

    // The mismatch must be caught before any repository mutation so the
    // transition log cannot record the wrong tier.
    expect(applyActionAndEnqueueJobs).not.toHaveBeenCalled();
  });

  it("importRuntimeFeedback rejects observation/artifact refs that drift from the persisted runtime-evidence item", async () => {
    const { repo, getItemForManage, applyActionAndEnqueueJobs } = makeStubRepo();
    getItemForManage.mockResolvedValue(
      itemFixture({
        reviewItemId: "reviewer-queue-runtime-refs",
        itemKind: reviewerQueueItemKindValues.runtimeEvidence,
        evidenceTier: "tier-2-trace",
        observationEventIds: ["event-1", "event-2"],
        artifactHashes: ["sha256:a"],
      }),
    );
    const service = new ReviewerQueueActionService(repo);

    await expect(
      service.importRuntimeFeedback(actor, {
        reviewItemId: "reviewer-queue-runtime-refs",
        actorUserId: "local-user",
        expectedSourceRevisionId: "source-revision-fixture",
        contextRefs: decisionContextRefs,
        evidenceTier: "tier-2-trace",
        observationEventIds: ["event-1"],
        artifactHashes: ["sha256:a"],
      }),
    ).rejects.toMatchObject({
      name: "ReviewerQueueActionServiceInputError",
      field: "observationEventIds",
    });

    expect(applyActionAndEnqueueJobs).not.toHaveBeenCalled();
  });

  it("importRuntimeFeedback accepts a runtime-evidence import whose values match the persisted item", async () => {
    const { repo, getItemForManage, applyAction } = makeStubRepo();
    getItemForManage.mockResolvedValue(
      itemFixture({
        reviewItemId: "reviewer-queue-runtime-match",
        itemKind: reviewerQueueItemKindValues.runtimeEvidence,
        evidenceTier: "tier-2-trace",
        observationEventIds: ["event-1", "event-2"],
        artifactHashes: ["sha256:a", "sha256:b"],
      }),
    );
    const service = new ReviewerQueueActionService(repo);

    await service.importRuntimeFeedback(actor, {
      reviewItemId: "reviewer-queue-runtime-match",
      actorUserId: "local-user",
      expectedSourceRevisionId: "source-revision-fixture",
      contextRefs: decisionContextRefs,
      evidenceTier: "tier-2-trace",
      observationEventIds: ["event-1", "event-2"],
      artifactHashes: ["sha256:a", "sha256:b"],
    });

    expect(applyAction.mock.calls[0]![1]!.metadata).toMatchObject({
      evidenceTier: "tier-2-trace",
      observationEventIds: ["event-1", "event-2"],
      artifactHashes: ["sha256:a", "sha256:b"],
    });
  });

  it("importRuntimeFeedback records a feedback-item tier verbatim without a persisted comparison", async () => {
    const { repo, getItemForManage, applyAction } = makeStubRepo();
    // Feedback items carry no persisted evidence tier (null on the row).
    getItemForManage.mockResolvedValue(
      itemFixture({
        reviewItemId: "reviewer-queue-feedback-import",
        itemKind: reviewerQueueItemKindValues.feedback,
        evidenceTier: null,
        observationEventIds: null,
        artifactHashes: null,
      }),
    );
    const service = new ReviewerQueueActionService(repo);

    await service.importRuntimeFeedback(actor, {
      reviewItemId: "reviewer-queue-feedback-import",
      actorUserId: "local-user",
      expectedSourceRevisionId: "source-revision-fixture",
      contextRefs: decisionContextRefs,
      evidenceTier: "batch-runtime-evidence",
      observationEventIds: ["event-9"],
      artifactHashes: ["sha256:z"],
    });

    expect(applyAction.mock.calls[0]![1]!.metadata).toMatchObject({
      evidenceTier: "batch-runtime-evidence",
      observationEventIds: ["event-9"],
      artifactHashes: ["sha256:z"],
    });
  });

  it("isRuntimeEvidenceItem narrows the runtime evidence shape", () => {
    const qa = itemFixture();
    expect(isRuntimeEvidenceItem(qa)).toBe(false);

    const runtime = itemFixture({
      itemKind: reviewerQueueItemKindValues.runtimeEvidence,
      evidenceTier: "tier-2",
      observationEventIds: ["event-1"],
      artifactHashes: ["sha256:a"],
    });
    expect(isRuntimeEvidenceItem(runtime)).toBe(true);
    if (isRuntimeEvidenceItem(runtime)) {
      expect(runtime.evidenceTier).toBe("tier-2");
      expect(runtime.observationEventIds).toEqual(["event-1"]);
      expect(runtime.artifactHashes).toEqual(["sha256:a"]);
    }
  });
});
