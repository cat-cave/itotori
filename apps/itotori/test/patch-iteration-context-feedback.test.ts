// Node 11 context feedback is intentionally a narrow composition test: the
// iteration service must delegate mutation to Node 9, retain Node 8's exact
// receipt, and never accept client-supplied project/branch/source identity.

import type {
  AuthorizationActor,
  ItotoriLocalizationIterationRepositoryPort,
  ItotoriLocalizationJournalRepositoryPort,
  ItotoriLocalizationRunFinalizerRepositoryPort,
  LocalizationJournalRunRecord,
  LocalizationRefinementRunRecord,
  PatchPlaySurface,
  RecordPlayTestFeedbackEventInput,
} from "@itotori/db";
import { describe, expect, it, vi } from "vitest";
import { PatchIterationService } from "../src/iteration/patch-iteration-service.js";
import type { WikiBrainEditResult, WikiBrainServicePort } from "../src/wiki/service.js";

const actor: AuthorizationActor = { userId: "patch-iteration-context-feedback-user" };
const observedPatchVersionId = "patch-context-v1";

describe("PatchIterationService context feedback", () => {
  it("routes added context through Node 9 and persists the exact Node 8 receipt", async () => {
    const fixture = serviceFixture();
    const receipt = wikiReceipt({
      contextArtifactId: "context-added-note",
      contextEntryVersionId: "context-added-note-v1",
      affectedUnitIds: ["bridge-unit-a", "bridge-unit-b"],
      correctionId: "correction-added-note",
      redraftJobId: "context-correction-job-added-note",
    });
    fixture.add.mockResolvedValue(receipt);

    const feedback = await fixture.service.feedback({
      observedPatchVersionId,
      eventKind: "added_context",
      body: "The play test added delivery context.",
      contextFeedback: {
        operation: "add",
        kind: "note",
        title: "Delivery context",
        body: "Captain Wato keeps the formal honorific in this scene.",
        reason: "Observed during the v1 play session.",
        affectedBridgeUnitIds: ["bridge-unit-a", "bridge-unit-b"],
      },
    });

    expect(fixture.add).toHaveBeenCalledWith({
      projectId: "project-context-feedback",
      localeBranchId: "branch-context-feedback",
      sourceRevisionId: "source-context-feedback",
      kind: "note",
      title: "Delivery context",
      body: "Captain Wato keeps the formal honorific in this scene.",
      reason: "Observed during the v1 play session.",
      affectedUnitIds: ["bridge-unit-a", "bridge-unit-b"],
    });
    expect(fixture.edit).not.toHaveBeenCalled();
    expect(fixture.recordFeedbackEvent).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({
        observedPatchVersionId,
        eventKind: "added_context",
        contextArtifactId: receipt.contextArtifactId,
        contextEntryVersionId: receipt.contextEntryVersionId,
        affectedBridgeUnitIds: receipt.affectedUnitIds,
        metadata: expect.objectContaining({
          contextCorrection: expect.objectContaining({
            schemaVersion: "itotori.patch-iteration.context-correction.v0",
            correctionId: receipt.correctionId,
            redraftJobId: receipt.redraftJobId,
            contextArtifactId: receipt.contextArtifactId,
            contextEntryVersionId: receipt.contextEntryVersionId,
            affectedBridgeUnitIds: receipt.affectedUnitIds,
            rerun: receipt.rerun,
          }),
        }),
      }),
    );
    expect(feedback).toMatchObject({
      contextArtifactId: receipt.contextArtifactId,
      contextEntryVersionId: receipt.contextEntryVersionId,
      affectedBridgeUnitIds: receipt.affectedUnitIds,
    });
  });

  it("routes an existing wiki edit through Node 9 and records its returned impact", async () => {
    const fixture = serviceFixture();
    const receipt = wikiReceipt({
      contextArtifactId: "context-existing-wiki",
      contextEntryVersionId: "context-existing-wiki-v3",
      affectedUnitIds: ["bridge-unit-a", "bridge-unit-c"],
      correctionId: "correction-existing-wiki",
      redraftJobId: "context-correction-job-existing-wiki",
    });
    fixture.edit.mockResolvedValue(receipt);

    await fixture.service.feedback({
      observedPatchVersionId,
      eventKind: "wiki_edit",
      contextFeedback: {
        operation: "edit",
        contextArtifactId: "context-existing-wiki",
        body: "The glossary entry uses the established title.",
        reason: "The v1 play test found an inconsistent title.",
        title: "Captain Wato",
        affectedBridgeUnitIds: ["bridge-unit-c"],
      },
    });

    expect(fixture.edit).toHaveBeenCalledWith({
      projectId: "project-context-feedback",
      localeBranchId: "branch-context-feedback",
      contextArtifactId: "context-existing-wiki",
      body: "The glossary entry uses the established title.",
      reason: "The v1 play test found an inconsistent title.",
      title: "Captain Wato",
      affectedUnitIds: ["bridge-unit-c"],
    });
    expect(fixture.recordFeedbackEvent).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({
        contextArtifactId: receipt.contextArtifactId,
        contextEntryVersionId: receipt.contextEntryVersionId,
        // WikiBrain may merge citations/known impact with the caller's extra
        // unit. The stored event must retain that authoritative full set.
        affectedBridgeUnitIds: ["bridge-unit-a", "bridge-unit-c"],
      }),
    );
  });

  it("retains an explicit reference-only path for a correction already made in Node 9", async () => {
    const fixture = serviceFixture({ wiki: undefined });

    await fixture.service.feedback({
      observedPatchVersionId,
      eventKind: "wiki_edit",
      body: "Attach the pre-existing canonical wiki correction to this v1 inbox.",
      contextArtifactId: "context-already-edited",
      contextEntryVersionId: "context-already-edited-v2",
      affectedBridgeUnitIds: ["bridge-unit-a"],
    });

    expect(fixture.add).not.toHaveBeenCalled();
    expect(fixture.edit).not.toHaveBeenCalled();
    expect(fixture.recordFeedbackEvent).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({
        contextArtifactId: "context-already-edited",
        contextEntryVersionId: "context-already-edited-v2",
        affectedBridgeUnitIds: ["bridge-unit-a"],
      }),
    );
  });

  it("keeps reference-only added-context/wiki feedback strict about the canonical head pair", async () => {
    const fixture = serviceFixture({ wiki: undefined });

    await expect(
      fixture.service.feedback({
        observedPatchVersionId,
        eventKind: "added_context",
        contextArtifactId: "context-missing-head",
      }),
    ).rejects.toMatchObject({ code: "context_reference_required" });

    expect(fixture.recordFeedbackEvent).not.toHaveBeenCalled();
  });

  it("refuses an unchanged durable redraft instead of copying the observed target into v2", async () => {
    const fixture = refinementFixture({ durableTarget: "Observed v1 target" });

    await expect(
      fixture.service.refine({
        basePatchVersionId: observedPatchVersionId,
        feedbackBatchIds: ["feedback-comment-batch"],
      }),
    ).rejects.toMatchObject({ code: "redraft_output_unchanged" });

    expect(fixture.loadDraftTexts).toHaveBeenCalledWith({
      projectId: "project-context-feedback",
      localeBranchId: "branch-context-feedback",
      bridgeUnitIds: ["bridge-unit-a"],
    });
    expect(fixture.persistUnit).not.toHaveBeenCalled();
  });

  it("does not silently import unrelated branch wiki heads into result-only refinement", async () => {
    const fixture = refinementFixture({ durableTarget: "Observed v1 target" });

    await expect(
      fixture.service.refine({
        basePatchVersionId: observedPatchVersionId,
        feedbackBatchIds: ["feedback-comment-batch"],
      }),
    ).rejects.toMatchObject({ code: "redraft_output_unchanged" });

    // `[]`, rather than omitted, prevents the lower-level repository default
    // from treating every current branch head as selected feedback.
    expect(fixture.createRefinementRun).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({ wikiHeads: [] }),
    );
  });
});

function serviceFixture(options: { wiki?: Pick<WikiBrainServicePort, "add" | "edit"> } = {}) {
  const add = vi.fn();
  const edit = vi.fn();
  const wiki =
    options.wiki === undefined && Object.hasOwn(options, "wiki") ? undefined : { add, edit };
  const recordFeedbackEvent = vi.fn(
    async (_actor: AuthorizationActor, input: RecordPlayTestFeedbackEventInput) => ({
      feedbackEventId: "feedback-context-event",
      feedbackBatchId: input.feedbackBatchId ?? "feedback-context-individual",
      observedPatchVersionId: input.observedPatchVersionId,
      playSessionId: input.playSessionId ?? null,
      actorUserId: actor.userId,
      eventKind: input.eventKind,
      body: input.body ?? null,
      metadata: input.metadata ?? {},
      resultRevisionId: input.resultRevisionId ?? null,
      contextArtifactId: input.contextArtifactId ?? null,
      contextEntryVersionId: input.contextEntryVersionId ?? null,
      affectedBridgeUnitIds: [...(input.affectedBridgeUnitIds ?? [])],
      createdAt: new Date("2026-07-13T02:00:00.000Z"),
    }),
  );
  const iteration = {
    loadPatchPlaySurface: vi.fn(async () => patchSurface()),
    recordFeedbackEvent,
  } as unknown as ItotoriLocalizationIterationRepositoryPort;
  const journal = {
    loadRun: vi.fn(async () => observedRun()),
  } as unknown as ItotoriLocalizationJournalRepositoryPort;
  return {
    service: new PatchIterationService({
      actor,
      iteration,
      journal,
      finalizer: {} as ItotoriLocalizationRunFinalizerRepositoryPort,
      ...(wiki === undefined ? {} : { wiki }),
    }),
    add,
    edit,
    recordFeedbackEvent,
  };
}

function patchSurface(): PatchPlaySurface {
  return {
    patchVersionId: observedPatchVersionId,
    runId: "run-context-v1",
    parentPatchVersionId: null,
    origin: "run_finalizer",
    status: "playable",
    playableAt: new Date("2026-07-13T01:00:00.000Z"),
    selectedAt: new Date("2026-07-13T01:00:00.000Z"),
    artifactHashes: {},
    artifactRefs: {},
    units: [],
    qaCallouts: [],
  };
}

function observedRun(): LocalizationJournalRunRecord {
  const now = new Date("2026-07-13T01:00:00.000Z");
  return {
    runId: "run-context-v1",
    projectId: "project-context-feedback",
    localeBranchId: "branch-context-feedback",
    sourceRevisionId: "source-context-feedback",
    targetLocale: "en-US",
    frozenScope: { kind: "explicit_units" },
    routingPolicy: {},
    costPolicy: {},
    basePatchVersionId: null,
    status: "succeeded",
    pausedBlocker: null,
    leaseOwnerId: null,
    leaseExpiresAt: null,
    fenceToken: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function wikiReceipt(overrides: Partial<WikiBrainEditResult> = {}): WikiBrainEditResult {
  return {
    schemaVersion: "wiki.context.edit.v0.2",
    generatedAt: new Date("2026-07-13T02:00:00.000Z"),
    correctionId: "context-correction-default",
    contextArtifactId: "context-artifact-default",
    contextEntryVersionId: "context-entry-default-v1",
    affectedUnitIds: ["bridge-unit-a"],
    invalidatedArtifactIds: ["invalidated-context-artifact"],
    redraftJobId: "context-correction-job-default",
    rerun: { state: "succeeded", jobStatus: "succeeded", error: null },
    entry: {} as WikiBrainEditResult["entry"],
    ...overrides,
  };
}

function refinementFixture(input: { durableTarget: string }) {
  const base = patchSurface();
  base.units = [
    {
      bridgeUnitId: "bridge-unit-a",
      sourceRunId: base.runId,
      journalOutcomeId: "outcome-v1-a",
      resultRevisionId: "revision-v1-a",
      targetBody: "Observed v1 target",
      memberOrigin: "run_written_outcome",
      reusedFromPatchVersionId: null,
      unitOrdinal: 0,
    },
  ];
  const loadDraftTexts = vi.fn(async () => new Map([["bridge-unit-a", input.durableTarget]]));
  const persistUnit = vi.fn();
  const refinement: LocalizationRefinementRunRecord = {
    run: {
      ...observedRun(),
      runId: "run-context-v2",
      basePatchVersionId: observedPatchVersionId,
      fenceToken: 2,
      status: "running",
    },
    basePatchVersionId: observedPatchVersionId,
    feedbackBatches: [
      {
        feedbackBatchId: "feedback-comment-batch",
        observedPatchVersionId,
        eventIds: ["feedback-comment-event"],
      },
    ],
    wikiHeads: [],
    members: [
      {
        bridgeUnitId: "bridge-unit-a",
        strategy: "redraft",
        basePatchVersionId: observedPatchVersionId,
        baseSourceRunId: base.runId,
        baseJournalOutcomeId: "outcome-v1-a",
        baseResultRevisionId: "revision-v1-a",
      },
    ],
  };
  const createRefinementRun = vi.fn(async () => refinement);
  const iteration = {
    loadPatchPlaySurface: vi.fn(async () => base),
    loadFeedbackInbox: vi.fn(async () => ({
      observedPatchVersionId,
      batches: [
        {
          feedbackBatchId: "feedback-comment-batch",
          observedPatchVersionId,
          actorUserId: actor.userId,
          selectionKind: "batch" as const,
          label: "A comment that needs a real redraft",
          createdAt: new Date("2026-07-13T02:00:00.000Z"),
          updatedAt: new Date("2026-07-13T02:00:00.000Z"),
          events: [
            {
              feedbackEventId: "feedback-comment-event",
              feedbackBatchId: "feedback-comment-batch",
              observedPatchVersionId,
              playSessionId: null,
              actorUserId: actor.userId,
              eventKind: "comment" as const,
              body: "This line needs a less formal tone.",
              metadata: {},
              resultRevisionId: null,
              contextArtifactId: null,
              contextEntryVersionId: null,
              affectedBridgeUnitIds: ["bridge-unit-a"],
              createdAt: new Date("2026-07-13T02:00:00.000Z"),
            },
          ],
        },
      ],
    })),
    createRefinementRun,
  } as unknown as ItotoriLocalizationIterationRepositoryPort;
  const journal = {
    loadRun: vi.fn(async () => observedRun()),
    persistUnit,
  } as unknown as ItotoriLocalizationJournalRepositoryPort;
  return {
    service: new PatchIterationService({
      actor,
      iteration,
      journal,
      finalizer: {} as ItotoriLocalizationRunFinalizerRepositoryPort,
      draftTexts: { load: loadDraftTexts },
    }),
    loadDraftTexts,
    persistUnit,
    createRefinementRun,
  };
}
