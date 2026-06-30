// ALPHA-002 — Playable draft feedback loop tests.
//
// Drives the real composition end to end with no DB:
//   batched intake → triage labels → reviewer-queue decision items
//   (real `ManualFeedbackImportService.createItem` path) → scoped repair
//   (real `buildReviewerTriggeredRerunJobInputs`) → before/after evidence.
//
// The repair-job output the evidence is built from is REAL — it comes
// from the reviewer-triggered rerun scheduler, not a fixture. Only the
// leaf DB ports (feedback repository, reviewer-queue repository) are
// in-memory stubs, mirroring the existing reviewer-action-service tests.

import { describe, expect, it } from "vitest";
import type {
  AuthorizationActor,
  CreateReviewerQueueItemInput,
  ItotoriFeedbackRepositoryPort,
  ItotoriReviewerQueueRepositoryPort,
  ManualFeedbackImportInput,
  ManualFeedbackImportResult,
  ManualFeedbackReviewerQueueContext,
  ReviewerQueueActionResult,
  ReviewerQueueItemRecord,
  ReviewerQueueTransitionRecord,
} from "@itotori/db";
import {
  feedbackContextStatusValues,
  feedbackTriageLabelValues,
  feedbackTypeValues,
  reviewerQueueActionValues,
  reviewerQueueItemKindValues,
  reviewerQueueItemStateValues,
} from "@itotori/db";
import { ManualFeedbackImportService } from "../src/manual-feedback.js";
import {
  buildDraftFeedbackLoopEvidence,
  buildDraftFeedbackRepairPlan,
  DraftFeedbackBatchError,
  DraftFeedbackBatchService,
  dispositionFor,
} from "../src/draft-feedback/index.js";

const actor: AuthorizationActor = { userId: "local-user" };
const PROJECT_ID = "project-fixture";
const BRANCH_ID = "branch-fixture";
const SOURCE_REVISION_ID = "source-revision-fixture";

// ---------------------------------------------------------------------------
// In-memory leaf ports (mirror real triage-label mapping + queue create).
// ---------------------------------------------------------------------------

type StoredReport = {
  feedbackReportId: string;
  feedbackEvidenceId: string;
  triageLabel: ManualFeedbackImportResult["triageLabel"];
  context: ManualFeedbackReviewerQueueContext;
};

function triageLabelFor(type: ManualFeedbackImportInput["feedbackType"]) {
  switch (type) {
    case feedbackTypeValues.objectiveDefect:
      return feedbackTriageLabelValues.objectiveDefectCandidate;
    case feedbackTypeValues.stylePreference:
      return feedbackTriageLabelValues.styleDisputeCandidate;
    default:
      return feedbackTriageLabelValues.needsContext;
  }
}

class StubFeedbackRepository implements Pick<
  ItotoriFeedbackRepositoryPort,
  "importManualFeedback" | "loadManualFeedbackReviewerQueueContext"
> {
  private counter = 0;
  private readonly reports = new Map<string, StoredReport>();

  async importManualFeedback(
    _actor: AuthorizationActor,
    input: ManualFeedbackImportInput,
  ): Promise<ManualFeedbackImportResult> {
    this.counter += 1;
    const feedbackReportId = `feedback-report-${this.counter}`;
    const feedbackEvidenceId = `feedback-evidence-${this.counter}`;
    const triageLabel = triageLabelFor(input.feedbackType);
    const bridgeUnitId = input.lineReference?.bridgeUnitId;
    const context: ManualFeedbackReviewerQueueContext = {
      feedbackReportId,
      feedbackEvidenceId,
      projectId: input.projectId,
      localeBranchId: input.localeBranchId ?? BRANCH_ID,
      sourceRevisionId: SOURCE_REVISION_ID,
      feedbackType: input.feedbackType,
      triageLabel,
      contextStatus: feedbackContextStatusValues.contextualized,
      reporterNote: input.reporterNote,
      context:
        bridgeUnitId === undefined
          ? { lineReference: {} }
          : { lineReference: { bridgeUnitId }, affectedUnitIds: [bridgeUnitId] },
      attachments: [],
      affectedArtifactIds: [],
    };
    this.reports.set(`${feedbackReportId}:${feedbackEvidenceId}`, {
      feedbackReportId,
      feedbackEvidenceId,
      triageLabel,
      context,
    });
    return {
      feedbackReportId,
      feedbackEvidenceId,
      feedbackSourceId: `feedback-source-${this.counter}`,
      dedupeKey: `dedupe-${this.counter}`,
      triageLabel,
      reportStatus: "open",
      contextStatus: feedbackContextStatusValues.contextualized,
      reportCount: 1,
      duplicate: false,
    };
  }

  async loadManualFeedbackReviewerQueueContext(
    _actor: AuthorizationActor,
    feedbackReportId: string,
    feedbackEvidenceId: string,
  ): Promise<ManualFeedbackReviewerQueueContext | null> {
    return this.reports.get(`${feedbackReportId}:${feedbackEvidenceId}`)?.context ?? null;
  }
}

class StubReviewerQueueRepository implements Pick<
  ItotoriReviewerQueueRepositoryPort,
  "createItem" | "loadItemsByBranch"
> {
  private counter = 0;
  readonly created: ReviewerQueueItemRecord[] = [];

  async createItem(
    _actor: AuthorizationActor,
    input: CreateReviewerQueueItemInput,
  ): Promise<ReviewerQueueItemRecord> {
    this.counter += 1;
    const now = new Date("2026-06-28T00:00:00Z");
    const record: ReviewerQueueItemRecord = {
      reviewItemId: `reviewer-queue-item-${this.counter}`,
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      sourceRevisionId: input.sourceRevisionId,
      itemKind: input.itemKind,
      sourceItemRef: input.sourceItemRef,
      state: reviewerQueueItemStateValues.pending,
      priority: input.priority ?? 0,
      summary: input.summary,
      affectedArtifactIds: input.affectedArtifactIds ?? [],
      evidenceTier: input.evidenceTier ?? null,
      observationEventIds: input.observationEventIds ?? null,
      artifactHashes: input.artifactHashes ?? null,
      payload: input.payload ?? {},
      metadata: input.metadata ?? {},
      createdByUserId: input.createdByUserId ?? null,
      assignedToUserId: input.assignedToUserId ?? null,
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
    };
    this.created.push(record);
    return record;
  }

  async loadItemsByBranch(): Promise<ReviewerQueueItemRecord[]> {
    return [...this.created];
  }
}

// ---------------------------------------------------------------------------
// Submission fixtures.
// ---------------------------------------------------------------------------

function typoSubmission(bridgeUnitId: string, note: string): ManualFeedbackImportInput {
  return {
    projectId: PROJECT_ID,
    localeBranchId: BRANCH_ID,
    targetLocale: "en-US",
    feedbackType: feedbackTypeValues.objectiveDefect,
    reporter: { role: "playtester", displayName: "Alice" },
    reporterNote: note,
    suggestedEdit: `${note} (corrected)`,
    lineReference: { bridgeUnitId },
  };
}

function styleSubmission(bridgeUnitId: string, note: string): ManualFeedbackImportInput {
  return {
    projectId: PROJECT_ID,
    localeBranchId: BRANCH_ID,
    targetLocale: "en-US",
    feedbackType: feedbackTypeValues.stylePreference,
    reporter: { role: "reviewer", displayName: "Bob" },
    reporterNote: note,
    lineReference: { bridgeUnitId },
  };
}

function buildLoop(): {
  batch: DraftFeedbackBatchService;
  reviewerQueue: StubReviewerQueueRepository;
} {
  const feedbackRepo = new StubFeedbackRepository();
  const reviewerQueue = new StubReviewerQueueRepository();
  const manualFeedback = new ManualFeedbackImportService(feedbackRepo, actor, reviewerQueue);
  return { batch: new DraftFeedbackBatchService(manualFeedback), reviewerQueue };
}

// Build a real `requestRepair` action result from a created feedback item
// so the scheduler scopes the rerun to the item's affected units.
function requestRepairResult(item: ReviewerQueueItemRecord): ReviewerQueueActionResult {
  const transition: ReviewerQueueTransitionRecord = {
    transitionId: `transition-${item.reviewItemId}`,
    reviewItemId: item.reviewItemId,
    localeBranchId: item.localeBranchId,
    sourceRevisionId: item.sourceRevisionId,
    itemKind: item.itemKind,
    action: reviewerQueueActionValues.requestRepair,
    priorState: reviewerQueueItemStateValues.pending,
    nextState: reviewerQueueItemStateValues.repairRequested,
    actorUserId: actor.userId,
    affectedArtifactIds: [],
    diagnostics: [],
    metadata: { repairHint: "fix the typo" },
    createdAt: new Date("2026-06-28T01:00:00Z"),
  };
  return { item, transition };
}

describe("DraftFeedbackBatchService — batched intake + triage", () => {
  it("collects multiple typo corrections with context and routes a style dispute to the decision queue", async () => {
    const { batch, reviewerQueue } = buildLoop();

    const result = await batch.submitBatch({
      batchLabel: "oshioki-slice-1",
      submissions: [
        typoSubmission("unit-a", "Teh hero speaks"),
        typoSubmission("unit-b", "recieve the sword"),
        styleSubmission("unit-c", "honorifics should stay"),
      ],
    });

    // Batched: every submission collected in order.
    expect(result.submittedCount).toBe(3);
    expect(result.items.map((item) => item.submissionIndex)).toEqual([0, 1, 2]);

    // Typo corrections carry their context (the bridge unit they target)
    // and the proposed correction.
    expect(result.items[0]?.disposition).toBe("repair_candidate");
    expect(result.items[0]?.bridgeUnitIds).toEqual(["unit-a"]);
    expect(result.items[0]?.suggestedEdit).toBe("Teh hero speaks (corrected)");
    expect(result.items[1]?.bridgeUnitIds).toEqual(["unit-b"]);
    expect(result.repairCandidateReportIds).toHaveLength(2);
    expect(result.affectedBridgeUnitIds).toEqual(["unit-a", "unit-b", "unit-c"]);

    // Style dispute → decision queue.
    expect(result.items[2]?.disposition).toBe("decision_queue");
    expect(result.decisionQueueReportIds).toHaveLength(1);

    // The style dispute became a real `style` reviewer-queue (decision
    // queue) item; the typos became `feedback` items.
    const styleItems = reviewerQueue.created.filter(
      (item) => item.itemKind === reviewerQueueItemKindValues.style,
    );
    const feedbackItems = reviewerQueue.created.filter(
      (item) => item.itemKind === reviewerQueueItemKindValues.feedback,
    );
    expect(styleItems).toHaveLength(1);
    expect(feedbackItems).toHaveLength(2);
    // Feedback items carry the affected unit so the repair can be scoped.
    expect(feedbackItems[0]?.payload.affectedUnitIds).toEqual(["unit-a"]);
  });

  it("rejects an empty batch with a typed error", async () => {
    const { batch } = buildLoop();
    await expect(batch.submitBatch({ submissions: [] })).rejects.toBeInstanceOf(
      DraftFeedbackBatchError,
    );
  });

  it("is deterministic: the same batch yields the same batchId", async () => {
    const submissions = [typoSubmission("unit-a", "Teh hero speaks")];
    const first = await buildLoop().batch.submitBatch({ submissions });
    const second = await buildLoop().batch.submitBatch({ submissions });
    expect(first.batchId).toBe(second.batchId);
  });
});

describe("buildDraftFeedbackRepairPlan — scoped repair from real rerun output", () => {
  it("re-runs only the affected bridge units, never the whole slice", async () => {
    const { batch, reviewerQueue } = buildLoop();
    await batch.submitBatch({
      submissions: [
        typoSubmission("unit-a", "Teh hero speaks"),
        typoSubmission("unit-b", "recieve the sword"),
        styleSubmission("unit-c", "honorifics should stay"),
      ],
    });

    // Reviewer requests a repair on the two typo (feedback) items.
    const feedbackItems = reviewerQueue.created.filter(
      (item) => item.itemKind === reviewerQueueItemKindValues.feedback,
    );
    const plan = buildDraftFeedbackRepairPlan(feedbackItems.map(requestRepairResult));

    // Scope is read back from the real rerun-job subject refs.
    expect(plan.repairScheduledUnitIds).toEqual(["unit-a", "unit-b"]);
    expect(plan.rerunJobs.length).toBeGreaterThan(0);
    // Every rerun job is scoped — none widens to the whole project.
    for (const job of plan.rerunJobs) {
      expect(job.queueName).toBe("reviewer-rerun");
    }
    expect(plan.perItem).toHaveLength(2);
    expect(plan.perItem[0]?.affectedUnitIds).toEqual(["unit-a"]);
  });

  it("contributes nothing for non-repair reviewer actions", () => {
    const empty = buildDraftFeedbackRepairPlan([]);
    expect(empty.rerunJobs).toHaveLength(0);
    expect(empty.repairScheduledUnitIds).toHaveLength(0);
  });
});

describe("buildDraftFeedbackLoopEvidence — before/after dashboard", () => {
  it("proves the repair touched only affected work and left the rest of the slice untouched", async () => {
    const { batch, reviewerQueue } = buildLoop();
    const batchResult = await batch.submitBatch({
      batchLabel: "oshioki-slice-1",
      submissions: [
        typoSubmission("unit-a", "Teh hero speaks"),
        typoSubmission("unit-b", "recieve the sword"),
        styleSubmission("unit-c", "honorifics should stay"),
      ],
    });

    const feedbackItems = reviewerQueue.created.filter(
      (item) => item.itemKind === reviewerQueueItemKindValues.feedback,
    );
    const repairPlan = buildDraftFeedbackRepairPlan(feedbackItems.map(requestRepairResult));

    const evidence = buildDraftFeedbackLoopEvidence({
      batchResult,
      repairPlan,
      // The reviewed slice has four units; only two had typo feedback.
      unitsInScope: ["unit-a", "unit-b", "unit-c", "unit-d"],
    });

    expect(evidence.before.unitsInScope).toEqual(["unit-a", "unit-b", "unit-c", "unit-d"]);
    expect(evidence.before.repairCandidateCount).toBe(2);
    expect(evidence.before.decisionQueueCount).toBe(1);

    expect(evidence.after.repairScheduledUnitIds).toEqual(["unit-a", "unit-b"]);
    // Load-bearing: the repair left these in-scope units alone.
    expect(evidence.after.untouchedUnitIds).toEqual(["unit-c", "unit-d"]);
    expect(evidence.after.rerunJobCount).toBeGreaterThan(0);
    expect(evidence.after.decisionQueueReportIds).toHaveLength(1);
    expect(evidence.scoped).toBe(true);

    // Before/after correction text is surfaced per affected unit.
    expect(evidence.corrections).toEqual([
      {
        bridgeUnitId: "unit-a",
        observed: "Teh hero speaks",
        suggested: "Teh hero speaks (corrected)",
      },
      {
        bridgeUnitId: "unit-b",
        observed: "recieve the sword",
        suggested: "recieve the sword (corrected)",
      },
    ]);
  });
});

describe("dispositionFor — exhaustive triage-label mapping", () => {
  it("maps every triage label to a disposition", () => {
    expect(dispositionFor(feedbackTriageLabelValues.styleDisputeCandidate)).toBe("decision_queue");
    expect(dispositionFor(feedbackTriageLabelValues.needsContext)).toBe("needs_context");
    expect(dispositionFor(feedbackTriageLabelValues.objectiveDefectCandidate)).toBe(
      "repair_candidate",
    );
    expect(dispositionFor(feedbackTriageLabelValues.glossaryCanonCandidate)).toBe(
      "repair_candidate",
    );
    expect(dispositionFor(feedbackTriageLabelValues.runtimeIssueCandidate)).toBe(
      "repair_candidate",
    );
    expect(dispositionFor(feedbackTriageLabelValues.assetIssueCandidate)).toBe("repair_candidate");
  });
});
