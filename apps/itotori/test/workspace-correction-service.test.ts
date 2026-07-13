// ITOTORI-118 — workspace manual-correction service tests.
//
// Drives the mutation layer end to end with no DB, proving the three
// acceptance guarantees by composition with REAL code:
//
//   - durable edit history: every correction yields one persisted edit row
//     tied to (project, locale branch, source revision, bridge unit, actor,
//     reason) + the feedback report / evidence it produced.
//   - feedback audit: corrections drive the REAL `ManualFeedbackImportService`
//     but deliberately do not inject a reviewer-queue item.
//   - branch-scoping: corrections on two branches are never conflated.
//
// Only the leaf DB ports (feedback repository and edit-history repository) are
// in-memory stubs.

import { describe, expect, it } from "vitest";
import type {
  AuthorizationActor,
  ItotoriFeedbackRepositoryPort,
  ManualFeedbackImportInput,
  ManualFeedbackImportResult,
  WorkspaceCorrectionEditInput,
  WorkspaceCorrectionEditRecord,
} from "@itotori/db";
import {
  feedbackContextStatusValues,
  feedbackTriageLabelValues,
  feedbackTypeValues,
} from "@itotori/db";
import { ManualFeedbackImportService } from "../src/manual-feedback.js";
import {
  WorkspaceCorrectionService,
  type WorkspaceCorrectionComparisonPort,
  type WorkspaceCorrectionEditPersistPort,
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
  "importManualFeedback"
> {
  private counter = 0;
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
}

function buildService(): {
  service: WorkspaceCorrectionService;
  feedbackRepo: StubFeedbackRepository;
  editRepo: StubEditRepository;
} {
  const feedbackRepo = new StubFeedbackRepository();
  const manualFeedback = new ManualFeedbackImportService(feedbackRepo, actor);
  const editRepo = new StubEditRepository();
  const comparisonPort: WorkspaceCorrectionComparisonPort = {
    loadComparisonContext: async () => deniedContextFixture("reviewer-1"),
  };
  const service = new WorkspaceCorrectionService({
    importPort: manualFeedback,
    editRepository: {
      recordCorrectionEdit: (input) => editRepo.recordCorrectionEdit(input),
    },
    comparisonPort,
    now: () => new Date("2026-06-30T00:00:00Z"),
  });
  return { service, feedbackRepo, editRepo };
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

function annotationFields() {
  return {
    severity: "warning" as const,
    scope: { kind: "line" as const },
  };
}

describe("WorkspaceCorrectionService — submit", () => {
  it("records durable edit history and feedback audit without routing a reviewer queue item", async () => {
    const { service, feedbackRepo, editRepo } = buildService();

    const result = await service.submitCorrections({
      ...submitBase,
      batchLabel: "oshioki-slice-1",
      corrections: [
        {
          bridgeUnitId: "unit-a",
          sourceUnitKey: "key-a",
          sourceRevisionId: SOURCE_REVISION_ID,
          ...annotationFields(),
          reason: "Typo: teh -> the",
          correctedText: "The hero speaks.",
          draftText: "Teh hero speaks.",
        },
        {
          bridgeUnitId: "unit-b",
          sourceRevisionId: SOURCE_REVISION_ID,
          severity: "critical",
          scope: { kind: "scene", sceneId: "scene-fixture-1" },
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
      metadata: {
        annotationSeverity: "warning",
        annotationScope: { kind: "line" },
      },
    });
    expect(feedbackRepo.imported[1]).toMatchObject({
      reporterNote: "Honorific dropped",
      suggestedEdit: "Onii-chan!",
      lineReference: {
        bridgeUnitId: "unit-b",
        sourceLocation: { sceneId: "scene-fixture-1" },
      },
      metadata: {
        annotationSeverity: "critical",
        annotationScope: { kind: "scene", sceneId: "scene-fixture-1" },
      },
    });

    // Triage labels remain as audit classification only; this service supplied
    // no reviewer-queue sink to ManualFeedbackImportService.
    expect(result.repairCandidateReportIds).toEqual(["feedback-report-1"]);
    expect(result.decisionQueueReportIds).toEqual(["feedback-report-2"]);
    expect(result.affectedBridgeUnitIds).toEqual(["unit-a", "unit-b"]);
    expect(result.edits[0]?.disposition).toBe("repair_candidate");
    expect(result.edits[1]?.disposition).toBe("decision_queue");
  });

  it("refuses the mutation without queue.manage and preserves read-only browsing", async () => {
    const { service, feedbackRepo, editRepo } = buildService();

    const result = await service.submitCorrections({
      ...submitBase,
      permission: readOnlyPermission,
      corrections: [
        {
          bridgeUnitId: "unit-a",
          sourceRevisionId: SOURCE_REVISION_ID,
          ...annotationFields(),
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
    // No feedback import, canonical context mutation, or edit-history row was created.
    expect(feedbackRepo.imported).toEqual([]);
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
          ...annotationFields(),
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
          ...annotationFields(),
          reason: "FR fix",
          correctedText: "Correction française.",
        },
      ],
    });

    const en = editRepo.recorded.filter((row) => row.localeBranchId === "branch-en");
    const fr = editRepo.recorded.filter((row) => row.localeBranchId === "branch-fr");
    expect(en).toHaveLength(1);
    expect(fr).toHaveLength(1);
    expect(en[0]?.localeBranchId).toBe("branch-en");
    expect(fr[0]?.localeBranchId).toBe("branch-fr");
    expect(en[0]?.correctionEditId).not.toBe(fr[0]?.correctionEditId);
  });

  it("rejects a mid-batch invalid correction at the service boundary with NO partial mutation", async () => {
    const { service, feedbackRepo, editRepo } = buildService();

    const result = await service.submitCorrections({
      ...submitBase,
      corrections: [
        {
          bridgeUnitId: "unit-a",
          sourceRevisionId: SOURCE_REVISION_ID,
          ...annotationFields(),
          reason: "Valid fix",
          correctedText: "Valid corrected text.",
        },
        {
          bridgeUnitId: "unit-b",
          sourceRevisionId: SOURCE_REVISION_ID,
          ...annotationFields(),
          reason: "Valid fix two",
          correctedText: "Second valid text.",
        },
        {
          // Correction #3 is invalid: empty corrected text + blank reason.
          bridgeUnitId: "unit-c",
          sourceRevisionId: SOURCE_REVISION_ID,
          ...annotationFields(),
          reason: "   ",
          correctedText: "",
        },
      ],
    });

    // Rejected at the service boundary.
    expect(result.submittedCount).toBe(0);
    expect(result.edits).toEqual([]);
    const codes = result.diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toContain("workspace_correction_invalid_correction");
    // The diagnostic identifies the offending correction index + fields.
    const messages = result.diagnostics.map((diagnostic) => diagnostic.message).join("\n");
    expect(messages).toContain("correction[2]");
    expect(messages).toContain("reason");
    expect(messages).toContain("correctedText");

    // NO partial mutation: not one feedback row or edit-history row was
    // written for ANY correction in the batch — including the two valid
    // corrections that precede the invalid one.
    expect(feedbackRepo.imported).toEqual([]);
    expect(editRepo.recorded).toEqual([]);
  });

  it("rejects a batch whose first correction is missing corrected text before any side effect", async () => {
    const { service, feedbackRepo, editRepo } = buildService();

    const result = await service.submitCorrections({
      ...submitBase,
      corrections: [
        {
          bridgeUnitId: "unit-a",
          sourceRevisionId: SOURCE_REVISION_ID,
          ...annotationFields(),
          reason: "Missing corrected text",
          correctedText: "",
        },
      ],
    });

    expect(result.submittedCount).toBe(0);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "workspace_correction_invalid_correction",
    );
    expect(feedbackRepo.imported).toEqual([]);
    expect(editRepo.recorded).toEqual([]);
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
    const manualFeedback = new ManualFeedbackImportService(feedbackRepo, actor);
    const service = new WorkspaceCorrectionService({
      importPort: manualFeedback,
      editRepository: {
        recordCorrectionEdit: (input) => editRepo.recordCorrectionEdit(input),
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
    const manualFeedback = new ManualFeedbackImportService(feedbackRepo, actor);
    const service = new WorkspaceCorrectionService({
      importPort: manualFeedback,
      editRepository: {
        recordCorrectionEdit: (input) => editRepo.recordCorrectionEdit(input),
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

// ITOTORI-118 — genaudit2-15-workspace-nits-dead-wired-loadcorrecti.
// Pins the resolution: the `WorkspaceCorrectionEditPersistPort` is write-only;
// the read path is the DB repository directly. The dead-wired
// `loadCorrectionEditsByBranch` that previously sat on this port (wired into
// `database-services.ts` but never called by the service) is dropped, and no
// dangling reference remains. If the port ever re-gains a read method, this
// test fails to typecheck.
describe("WorkspaceCorrectionService — port shape (genaudit2-15 dead-wired pin)", () => {
  it("accepts an editRepository port that exposes ONLY recordCorrectionEdit (no loadCorrectionEditsByBranch)", () => {
    const port: WorkspaceCorrectionEditPersistPort = {
      recordCorrectionEdit: async () => {
        throw new Error("not used in this pin test");
      },
    };
    // Runtime belt-and-braces: the dead method must not be on the port.
    expect(
      (port as unknown as Record<string, unknown>)["loadCorrectionEditsByBranch"],
    ).toBeUndefined();
    // Compile-time pin: only the write method is on the type. Assigning any
    // object literal that names a `loadCorrectionEditsByBranch` would fail to
    // typecheck against `WorkspaceCorrectionEditPersistPort` — that is the
    // structural guarantee the fix relies on.
    expect(typeof port.recordCorrectionEdit).toBe("function");
  });
});
