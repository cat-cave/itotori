// ITOTORI-118 — workspace manual-correction service tests.
//
// Drives the mutation layer end to end with no DB, proving the three
// acceptance guarantees by composition with REAL code:
//
//   - durable edit history: every correction yields one persisted edit row
//     tied to (project, locale branch, source revision, bridge unit, actor,
//     reason) + the feedback report / evidence it produced.
//   - SAME feedback + decision + targeted-rerun loop: the corrections drive the
//     REAL `ManualFeedbackImportService`, which enqueues REAL reviewer-queue
//     items; feeding one of those items into the REAL
//     `buildReviewerTriggeredRerunJobInputs` scopes the rerun to exactly the
//     corrected bridge units (affected-unit rerun enqueue integration).
//   - branch-scoping: corrections on two branches are never conflated.
//
// Only the leaf DB ports (feedback repository, reviewer-queue repository,
// edit-history repository) are in-memory stubs.

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
  WorkspaceCorrectionEditInput,
  WorkspaceCorrectionEditRecord,
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
import { buildReviewerTriggeredRerunJobInputs } from "../src/reviewer/repair-rerun-scheduler.js";
import {
  WorkspaceCorrectionService,
  type WorkspaceCorrectionComparisonPort,
} from "../src/workspace/correction-service.js";
import {
  readyContextFixture,
  deniedContextFixture,
  draftFixture,
  glossaryFixture,
  sourceUnitFixture,
} from "../src/reviewer/detail-fixtures.js";

const actor: AuthorizationActor = { userId: "local-user" };
const PROJECT_ID = "project-it118";
const BRANCH_ID = "branch-it118";
const SOURCE_REVISION_ID = "source-revision-it118";
const SOURCE_BUNDLE_ID = "source-bundle-it118";

const managePermission = {
  actorUserId: "reviewer-1",
  canReadQueue: true,
  canManageQueue: true,
  denialReasons: [] as string[],
};

const readOnlyPermission = {
  actorUserId: "reviewer-1",
  canReadQueue: true,
  canManageQueue: false,
  denialReasons: ["user reviewer-1 is missing permission queue.manage"],
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
  private readonly reports = new Map<string, ManualFeedbackReviewerQueueContext>();
  readonly imported: ManualFeedbackImportInput[] = [];

  async importManualFeedback(
    _actor: AuthorizationActor,
    input: ManualFeedbackImportInput,
  ): Promise<ManualFeedbackImportResult> {
    this.imported.push(input);
    this.counter += 1;
    const feedbackReportId = `feedback-report-${this.counter}`;
    const feedbackEvidenceId = `feedback-evidence-${this.counter}`;
    const triageLabel = triageLabelFor(input.feedbackType);
    const bridgeUnitId = input.lineReference?.bridgeUnitId;
    this.reports.set(`${feedbackReportId}:${feedbackEvidenceId}`, {
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
    return this.reports.get(`${feedbackReportId}:${feedbackEvidenceId}`) ?? null;
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
    const now = new Date("2026-06-30T00:00:00Z");
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

class StubEditRepository {
  readonly recorded: WorkspaceCorrectionEditRecord[] = [];

  async recordCorrectionEdit(
    input: WorkspaceCorrectionEditInput,
  ): Promise<WorkspaceCorrectionEditRecord> {
    const correctionEditId = `workspace-correction-${input.localeBranchId}-${input.bridgeUnitId}-${input.afterText}`;
    const duplicate = this.recorded.some((row) => row.correctionEditId === correctionEditId);
    const record: WorkspaceCorrectionEditRecord = {
      correctionEditId,
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      sourceRevisionId: input.sourceRevisionId,
      bridgeUnitId: input.bridgeUnitId,
      actorUserId: input.actorUserId,
      reason: input.reason,
      beforeText: input.beforeText ?? null,
      afterText: input.afterText,
      disposition: input.disposition,
      triageLabel: input.triageLabel,
      feedbackReportId: input.feedbackReportId,
      feedbackEvidenceId: input.feedbackEvidenceId,
      reviewItemId: input.reviewItemId ?? null,
      batchId: input.batchId,
      metadata: input.metadata ?? {},
      createdAt: new Date("2026-06-30T00:00:00Z"),
      duplicate,
    };
    if (!duplicate) {
      this.recorded.push(record);
    }
    return record;
  }

  async loadCorrectionEditsByBranch(
    localeBranchId: string,
  ): Promise<WorkspaceCorrectionEditRecord[]> {
    return this.recorded.filter((row) => row.localeBranchId === localeBranchId);
  }
}

function buildService(): {
  service: WorkspaceCorrectionService;
  feedbackRepo: StubFeedbackRepository;
  reviewerQueue: StubReviewerQueueRepository;
  editRepo: StubEditRepository;
} {
  const feedbackRepo = new StubFeedbackRepository();
  const reviewerQueue = new StubReviewerQueueRepository();
  const manualFeedback = new ManualFeedbackImportService(feedbackRepo, actor, reviewerQueue);
  const editRepo = new StubEditRepository();
  const comparisonPort: WorkspaceCorrectionComparisonPort = {
    loadComparisonContext: async () => deniedContextFixture("reviewer-1"),
  };
  const service = new WorkspaceCorrectionService({
    importPort: manualFeedback,
    editRepository: {
      recordCorrectionEdit: (input) => editRepo.recordCorrectionEdit(input),
      loadCorrectionEditsByBranch: (localeBranchId) =>
        editRepo.loadCorrectionEditsByBranch(localeBranchId),
    },
    comparisonPort,
    now: () => new Date("2026-06-30T00:00:00Z"),
  });
  return { service, feedbackRepo, reviewerQueue, editRepo };
}

// Build a real `requestRepair` action result from a created feedback item so
// the REAL rerun scheduler scopes the rerun to the item's affected units.
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
    metadata: {},
    createdAt: new Date("2026-06-30T01:00:00Z"),
  };
  return { item, transition };
}

const submitBase = {
  projectId: PROJECT_ID,
  localeBranchId: BRANCH_ID,
  sourceBundleId: SOURCE_BUNDLE_ID,
  targetLocale: "en-US",
  actorUserId: "reviewer-1",
  actorDisplayName: "Reviewer One",
  permission: managePermission,
};

describe("WorkspaceCorrectionService — submit", () => {
  it("records durable edit history tied to project/branch/revision/unit/actor/reason and routes through the same feedback path", async () => {
    const { service, feedbackRepo, reviewerQueue, editRepo } = buildService();

    const result = await service.submitCorrections({
      ...submitBase,
      batchLabel: "oshioki-slice-1",
      corrections: [
        {
          bridgeUnitId: "unit-a",
          sourceUnitKey: "key-a",
          sourceRevisionId: SOURCE_REVISION_ID,
          reason: "Typo: teh -> the",
          correctedText: "The hero speaks.",
          draftText: "Teh hero speaks.",
        },
        {
          bridgeUnitId: "unit-b",
          sourceRevisionId: SOURCE_REVISION_ID,
          reason: "Honorific dropped",
          correctedText: "Onii-chan!",
          draftText: "Big brother!",
          feedbackType: feedbackTypeValues.stylePreference,
        },
      ],
    });

    expect(result.submittedCount).toBe(2);

    // Durable edit history: one row per correction with the full identity.
    expect(editRepo.recorded).toHaveLength(2);
    const first = editRepo.recorded[0]!;
    expect(first.projectId).toBe(PROJECT_ID);
    expect(first.localeBranchId).toBe(BRANCH_ID);
    expect(first.sourceRevisionId).toBe(SOURCE_REVISION_ID);
    expect(first.bridgeUnitId).toBe("unit-a");
    expect(first.actorUserId).toBe("reviewer-1");
    expect(first.reason).toBe("Typo: teh -> the");
    expect(first.beforeText).toBe("Teh hero speaks.");
    expect(first.afterText).toBe("The hero speaks.");
    expect(first.feedbackReportId).toBe("feedback-report-1");
    expect(first.feedbackEvidenceId).toBe("feedback-evidence-1");

    // SAME feedback path: each correction was imported with its corrected text
    // (suggestedEdit) + reason (reporterNote) + bridge-unit line reference.
    expect(feedbackRepo.imported).toHaveLength(2);
    expect(feedbackRepo.imported[0]).toMatchObject({
      feedbackType: feedbackTypeValues.objectiveDefect,
      reporterNote: "Typo: teh -> the",
      suggestedEdit: "The hero speaks.",
      lineReference: { bridgeUnitId: "unit-a", sourceUnitKey: "key-a" },
    });

    // SAME decision queue: the style correction became a `style` reviewer-queue
    // item; the typo became a `feedback` item — both enqueued by the real
    // ManualFeedbackImportService, not a fork.
    const kinds = reviewerQueue.created.map((item) => item.itemKind).sort();
    expect(kinds).toEqual(
      [reviewerQueueItemKindValues.feedback, reviewerQueueItemKindValues.style].sort(),
    );

    // Routing partitions + affected-unit rerun scope.
    expect(result.repairCandidateReportIds).toEqual(["feedback-report-1"]);
    expect(result.decisionQueueReportIds).toEqual(["feedback-report-2"]);
    expect(result.affectedBridgeUnitIds).toEqual(["unit-a", "unit-b"]);
    expect(result.edits[0]?.disposition).toBe("repair_candidate");
    expect(result.edits[1]?.disposition).toBe("decision_queue");
  });

  it("scopes the targeted rerun to exactly the corrected bridge units (real scheduler)", async () => {
    const { service, reviewerQueue } = buildService();

    await service.submitCorrections({
      ...submitBase,
      corrections: [
        {
          bridgeUnitId: "unit-a",
          sourceRevisionId: SOURCE_REVISION_ID,
          reason: "Typo fix",
          correctedText: "Fixed text.",
        },
      ],
    });

    // The real feedback path enqueued a `feedback` reviewer-queue item carrying
    // the affected bridge unit; a reviewer `requestRepair` runs through the REAL
    // rerun scheduler and scopes the rerun to that unit only.
    const feedbackItem = reviewerQueue.created.find(
      (item) => item.itemKind === reviewerQueueItemKindValues.feedback,
    );
    expect(feedbackItem).toBeDefined();
    const jobs = buildReviewerTriggeredRerunJobInputs(requestRepairResult(feedbackItem!));
    expect(jobs.length).toBeGreaterThan(0);
    const bridgeUnitSubjects = new Set(
      jobs.flatMap((job) =>
        (job.subjectRefs ?? [])
          .filter(
            (ref): ref is { subjectKind: string; subjectId: string } =>
              typeof ref === "object" &&
              ref !== null &&
              (ref as { subjectKind?: unknown }).subjectKind === "bridge_unit",
          )
          .map((ref) => ref.subjectId),
      ),
    );
    expect([...bridgeUnitSubjects]).toEqual(["unit-a"]);
  });

  it("refuses the mutation without queue.manage and preserves read-only browsing", async () => {
    const { service, feedbackRepo, reviewerQueue, editRepo } = buildService();

    const result = await service.submitCorrections({
      ...submitBase,
      permission: readOnlyPermission,
      corrections: [
        {
          bridgeUnitId: "unit-a",
          sourceRevisionId: SOURCE_REVISION_ID,
          reason: "Typo fix",
          correctedText: "Fixed text.",
        },
      ],
    });

    expect(result.submittedCount).toBe(0);
    expect(result.edits).toEqual([]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "workspace_correction_mutation_permission_denied",
    );
    // No feedback import, no queue item, no edit-history row was created.
    expect(feedbackRepo.imported).toEqual([]);
    expect(reviewerQueue.created).toEqual([]);
    expect(editRepo.recorded).toEqual([]);
  });

  it("keeps corrections on different branches distinct (no conflation)", async () => {
    const { service, editRepo } = buildService();

    await service.submitCorrections({
      ...submitBase,
      localeBranchId: "branch-en",
      corrections: [
        {
          bridgeUnitId: "unit-shared",
          sourceRevisionId: SOURCE_REVISION_ID,
          reason: "EN fix",
          correctedText: "English fix.",
        },
      ],
    });
    await service.submitCorrections({
      ...submitBase,
      localeBranchId: "branch-fr",
      corrections: [
        {
          bridgeUnitId: "unit-shared",
          sourceRevisionId: SOURCE_REVISION_ID,
          reason: "FR fix",
          correctedText: "Correction française.",
        },
      ],
    });

    const en = await editRepo.loadCorrectionEditsByBranch("branch-en");
    const fr = await editRepo.loadCorrectionEditsByBranch("branch-fr");
    expect(en).toHaveLength(1);
    expect(fr).toHaveLength(1);
    expect(en[0]?.localeBranchId).toBe("branch-en");
    expect(fr[0]?.localeBranchId).toBe("branch-fr");
    expect(en[0]?.correctionEditId).not.toBe(fr[0]?.correctionEditId);
  });

  it("refuses an empty batch with a structured diagnostic", async () => {
    const { service } = buildService();
    const result = await service.submitCorrections({ ...submitBase, corrections: [] });
    expect(result.submittedCount).toBe(0);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "workspace_correction_empty_batch",
    );
  });
});

describe("WorkspaceCorrectionService — preview", () => {
  it("composes the reviewer-detail context into before/after + style/glossary/runtime", async () => {
    const { editRepo } = buildService();
    const feedbackRepo = new StubFeedbackRepository();
    const reviewerQueue = new StubReviewerQueueRepository();
    const manualFeedback = new ManualFeedbackImportService(feedbackRepo, actor, reviewerQueue);
    const service = new WorkspaceCorrectionService({
      importPort: manualFeedback,
      editRepository: {
        recordCorrectionEdit: (input) => editRepo.recordCorrectionEdit(input),
        loadCorrectionEditsByBranch: (localeBranchId) =>
          editRepo.loadCorrectionEditsByBranch(localeBranchId),
      },
      comparisonPort: {
        loadComparisonContext: async () => ({
          ...readyContextFixture(),
          source: sourceUnitFixture({ bridgeUnitId: "unit-a", sourceText: "源文" }),
          draft: draftFixture({ draftText: "Draft text.", approvedPatchText: "Final text." }),
          glossary: [glossaryFixture({ sourceTerm: "勇者", preferredTranslation: "hero" })],
        }),
      },
      now: () => new Date("2026-06-30T00:00:00Z"),
    });

    const preview = await service.loadPreview({
      localeBranchId: "locale-branch-itotori-082",
      reviewItemIds: ["review-item-1"],
      permission: managePermission,
    });

    expect(preview.units).toHaveLength(1);
    const unit = preview.units[0]!;
    expect(unit.sourceText).toBe("源文");
    expect(unit.draftText).toBe("Draft text.");
    expect(unit.finalText).toBe("Final text.");
    expect(unit.styleGuidePolicyVersionId).not.toBeNull();
    expect(unit.glossary[0]).toMatchObject({ sourceTerm: "勇者", preferredTranslation: "hero" });
  });

  it("drops a review item on a different branch with a conflation guard", async () => {
    const { editRepo } = buildService();
    const feedbackRepo = new StubFeedbackRepository();
    const reviewerQueue = new StubReviewerQueueRepository();
    const manualFeedback = new ManualFeedbackImportService(feedbackRepo, actor, reviewerQueue);
    const service = new WorkspaceCorrectionService({
      importPort: manualFeedback,
      editRepository: {
        recordCorrectionEdit: (input) => editRepo.recordCorrectionEdit(input),
        loadCorrectionEditsByBranch: (localeBranchId) =>
          editRepo.loadCorrectionEditsByBranch(localeBranchId),
      },
      comparisonPort: {
        loadComparisonContext: async () => readyContextFixture(),
      },
      now: () => new Date("2026-06-30T00:00:00Z"),
    });

    const preview = await service.loadPreview({
      localeBranchId: "some-other-branch",
      reviewItemIds: ["review-item-1"],
      permission: managePermission,
    });

    expect(preview.units).toEqual([]);
    expect(preview.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "workspace_correction_branch_conflation_guard",
    );
  });

  it("denies the preview without queue.read", async () => {
    const { service } = buildService();
    const preview = await service.loadPreview({
      localeBranchId: BRANCH_ID,
      reviewItemIds: ["review-item-1"],
      permission: {
        actorUserId: "reviewer-1",
        canReadQueue: false,
        canManageQueue: false,
        denialReasons: ["user reviewer-1 is missing permission queue.read"],
      },
    });
    expect(preview.units).toEqual([]);
    expect(preview.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "workspace_correction_read_permission_denied",
    );
  });
});
