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
const nonSuccessfulReruns = [
  { state: "pending", jobStatus: "queued", error: null },
  { state: "failed", jobStatus: "dead_letter", error: "registered redraft exhausted retries" },
] as const;

describe("PatchIterationService context feedback", () => {
  it("turns a scoped comment into a canonical note receipt for the registered redraft", async () => {
    const fixture = serviceFixture();
    const receipt = wikiReceipt({
      contextArtifactId: "context-comment-note",
      contextEntryVersionId: "context-comment-note-v1",
      affectedUnitIds: ["bridge-unit-a"],
      correctionId: "correction-comment-note",
      redraftJobId: "context-correction-job-comment-note",
    });
    fixture.add.mockResolvedValue(receipt);

    const feedback = await fixture.service.feedback({
      observedPatchVersionId,
      eventKind: "comment",
      body: "The delivery needs a less formal tone in this route.",
      affectedBridgeUnitIds: ["bridge-unit-a"],
    });

    expect(fixture.add).toHaveBeenCalledWith({
      projectId: "project-context-feedback",
      localeBranchId: "branch-context-feedback",
      sourceRevisionId: "source-context-feedback",
      kind: "note",
      title: expect.stringMatching(/^Play-test comment feedback-event:/u),
      body: "The delivery needs a less formal tone in this route.",
      reason: "Scoped play-test comment requires a durable refinement redraft.",
      affectedUnitIds: ["bridge-unit-a"],
    });
    expect(fixture.recordFeedbackEvent).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({
        eventKind: "comment",
        contextArtifactId: receipt.contextArtifactId,
        contextEntryVersionId: receipt.contextEntryVersionId,
        affectedBridgeUnitIds: receipt.affectedUnitIds,
        metadata: expect.objectContaining({
          commentRedraft: true,
          contextCorrection: expect.objectContaining({
            correctionId: receipt.correctionId,
            redraftJobId: receipt.redraftJobId,
          }),
        }),
      }),
    );
    expect(feedback).toMatchObject({
      eventKind: "comment",
      contextArtifactId: receipt.contextArtifactId,
      contextEntryVersionId: receipt.contextEntryVersionId,
    });
  });

  it("rejects a scoped comment with a missing or blank body before it creates a canonical note", async () => {
    for (const body of [undefined, "   "]) {
      const fixture = serviceFixture();

      await expect(
        fixture.service.feedback({
          observedPatchVersionId,
          eventKind: "comment",
          ...(body === undefined ? {} : { body }),
          affectedBridgeUnitIds: ["bridge-unit-a"],
        }),
      ).rejects.toMatchObject({ code: "scoped_comment_body_required" });

      expect(fixture.add).not.toHaveBeenCalled();
      expect(fixture.recordFeedbackEvent).not.toHaveBeenCalled();
    }
  });

  it("rejects an unscoped comment instead of creating an event-only feedback inbox item", async () => {
    for (const input of [
      { body: "A comment without a unit must not report success." },
      {},
    ] as const) {
      const fixture = serviceFixture();

      await expect(
        fixture.service.feedback({
          observedPatchVersionId,
          eventKind: "comment",
          ...input,
        }),
      ).rejects.toMatchObject({ code: "scoped_comment_required" });

      expect(fixture.add).not.toHaveBeenCalled();
      expect(fixture.recordFeedbackEvent).not.toHaveBeenCalled();
    }
  });

  it("preflights scoped-comment unit membership before it creates a canonical note", async () => {
    const fixture = serviceFixture();

    await expect(
      fixture.service.feedback({
        observedPatchVersionId,
        eventKind: "comment",
        body: "This comment names a unit that is not in the observed patch.",
        affectedBridgeUnitIds: ["bridge-unit-not-observed"],
      }),
    ).rejects.toMatchObject({ code: "feedback_unit_not_observed" });

    expect(fixture.add).not.toHaveBeenCalled();
    expect(fixture.recordFeedbackEvent).not.toHaveBeenCalled();
  });

  it("rejects a caller-supplied comment receipt before it creates a canonical note", async () => {
    const fixture = serviceFixture();

    await expect(
      fixture.service.feedback({
        observedPatchVersionId,
        eventKind: "comment",
        body: "The server must own the canonical receipt.",
        affectedBridgeUnitIds: ["bridge-unit-a"],
        contextArtifactId: "client-predicted-context-artifact",
        contextEntryVersionId: "client-predicted-context-version",
      }),
    ).rejects.toMatchObject({ code: "context_feedback_receipt_not_allowed" });

    expect(fixture.add).not.toHaveBeenCalled();
    expect(fixture.recordFeedbackEvent).not.toHaveBeenCalled();
  });

  it.each(nonSuccessfulReruns)(
    "does not persist scoped comment feedback when its exact canonical rerun is $state",
    async (rerun) => {
      const fixture = serviceFixture();
      fixture.add.mockResolvedValue(wikiReceipt({ rerun }));

      await expect(
        fixture.service.feedback({
          observedPatchVersionId,
          eventKind: "comment",
          body: "The correction must finish before feedback becomes refinable.",
          affectedBridgeUnitIds: ["bridge-unit-a"],
        }),
      ).rejects.toMatchObject({ code: "context_redraft_not_succeeded" });

      expect(fixture.add).toHaveBeenCalledOnce();
      expect(fixture.recordFeedbackEvent).not.toHaveBeenCalled();
    },
  );

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

  it("preflights added-context unit membership before it creates a canonical note", async () => {
    const fixture = serviceFixture();

    await expect(
      fixture.service.feedback({
        observedPatchVersionId,
        eventKind: "added_context",
        contextFeedback: {
          operation: "add",
          kind: "note",
          title: "Foreign unit context",
          body: "This request must fail before it changes Node 9.",
          reason: "The unit is outside the observed v1 patch.",
          affectedBridgeUnitIds: ["bridge-unit-not-observed"],
        },
      }),
    ).rejects.toMatchObject({ code: "feedback_unit_not_observed" });

    expect(fixture.add).not.toHaveBeenCalled();
    expect(fixture.recordFeedbackEvent).not.toHaveBeenCalled();
  });

  it("rejects a caller-supplied receipt on a canonical context mutation before Node 9", async () => {
    const fixture = serviceFixture();

    await expect(
      fixture.service.feedback({
        observedPatchVersionId,
        eventKind: "added_context",
        contextArtifactId: "client-predicted-context-artifact",
        contextEntryVersionId: "client-predicted-context-version",
        contextFeedback: {
          operation: "add",
          kind: "note",
          title: "Server-owned receipt",
          body: "The nested mutation owns its canonical head.",
          reason: "Do not accept a post-write receipt assertion.",
          affectedBridgeUnitIds: ["bridge-unit-a"],
        },
      }),
    ).rejects.toMatchObject({ code: "context_feedback_receipt_not_allowed" });

    expect(fixture.add).not.toHaveBeenCalled();
    expect(fixture.recordFeedbackEvent).not.toHaveBeenCalled();
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

  it("preflights optional wiki-edit affected units before it edits canonical context", async () => {
    const fixture = serviceFixture();

    await expect(
      fixture.service.feedback({
        observedPatchVersionId,
        eventKind: "wiki_edit",
        contextFeedback: {
          operation: "edit",
          contextArtifactId: "context-existing-wiki",
          body: "This edit must not create a correction for an outside unit.",
          reason: "The requested extra impact is outside the observed patch.",
          affectedBridgeUnitIds: ["bridge-unit-not-observed"],
        },
      }),
    ).rejects.toMatchObject({ code: "feedback_unit_not_observed" });

    expect(fixture.edit).not.toHaveBeenCalled();
    expect(fixture.recordFeedbackEvent).not.toHaveBeenCalled();
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
    expect(fixture.terminalize).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({
        runId: "run-context-v2",
        terminalStatus: "failed",
        lease: { ownerId: expect.stringMatching(/^patch-iteration-refinement:/u), fenceToken: 2 },
        rootCause: expect.objectContaining({ code: "redraft_output_unchanged" }),
      }),
    );
  });

  it("does not silently import unrelated branch wiki heads into result-only refinement", async () => {
    const fixture = refinementFixture({
      durableTarget: "Observed v1 target",
      canonicalComment: false,
    });

    await expect(
      fixture.service.refine({
        basePatchVersionId: observedPatchVersionId,
        feedbackBatchIds: ["feedback-comment-batch"],
      }),
    ).rejects.toMatchObject({ code: "feedback_redraft_source_missing" });

    // `[]`, rather than omitted, prevents the lower-level repository default
    // from treating every current branch head as selected feedback.
    expect(fixture.createRefinementRun).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({ wikiHeads: [] }),
    );
  });

  it("uses a new durable draft when an inherited result edit is already applied on the selected child", async () => {
    const durableTarget = "The later context correction is the real v3 target.";
    const fixture = refinementFixture({
      durableTarget,
      inheritedResultEdit: "The v1 result edit already selected into v2.",
      persistFailure: new Error("stop after proving inherited target handling"),
    });

    await expect(
      fixture.service.refine({
        basePatchVersionId: "patch-context-v2",
        feedbackBatchIds: ["feedback-comment-batch"],
      }),
    ).rejects.toThrow("stop after proving inherited target handling");

    // The result-edit target is already the v2 base text, so it is retained as
    // visible provenance but cannot mask the selected comment's durable Node
    // 8 draft. This is the service half of the default-dashboard lineage flow.
    expect(fixture.loadDraftTexts).toHaveBeenCalledWith({
      projectId: "project-context-feedback",
      localeBranchId: "branch-context-feedback",
      bridgeUnitIds: ["bridge-unit-a"],
    });
    expect(fixture.persistUnit).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({
        bridgeUnitId: "bridge-unit-a",
        outcome: expect.objectContaining({
          candidates: [expect.objectContaining({ body: durableTarget })],
        }),
      }),
    );
    expect(fixture.createRefinementRun).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({
        basePatchVersionId: "patch-context-v2",
        redraftUnitIds: [],
      }),
    );
  });

  it("refuses an inherited result edit alone instead of manufacturing a no-op child", async () => {
    const fixture = refinementFixture({
      durableTarget: "An unrelated branch draft must never replay an inherited edit.",
      inheritedResultEdit: "The v1 result edit already selected into v2.",
    });

    await expect(
      fixture.service.refine({
        basePatchVersionId: "patch-context-v2",
        feedbackEventIds: ["feedback-result-edit-v1"],
      }),
    ).rejects.toMatchObject({ code: "no_refinement_changes" });

    expect(fixture.loadDraftTexts).not.toHaveBeenCalled();
    expect(fixture.persistUnit).not.toHaveBeenCalled();
  });

  it.each(nonSuccessfulReruns)(
    "does not refine legacy canonical feedback whose recorded rerun is $state",
    async (rerun) => {
      const fixture = refinementFixture({
        durableTarget: "A later branch draft must not rescue this stale correction.",
        contextRerun: rerun,
      });

      await expect(
        fixture.service.refine({
          basePatchVersionId: observedPatchVersionId,
          feedbackBatchIds: ["feedback-comment-batch"],
        }),
      ).rejects.toMatchObject({ code: "context_redraft_not_succeeded" });

      expect(fixture.createRefinementRun).not.toHaveBeenCalled();
      expect(fixture.loadDraftTexts).not.toHaveBeenCalled();
    },
  );
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
    units: [
      patchUnit("bridge-unit-a", 0),
      patchUnit("bridge-unit-b", 1),
      patchUnit("bridge-unit-c", 2),
    ],
    qaCallouts: [],
  };
}

function patchUnit(bridgeUnitId: string, unitOrdinal: number): PatchPlaySurface["units"][number] {
  return {
    bridgeUnitId,
    sourceRunId: "run-context-v1",
    journalOutcomeId: `outcome-v1-${bridgeUnitId}`,
    resultRevisionId: `revision-v1-${bridgeUnitId}`,
    targetBody: "Observed v1 target",
    memberOrigin: "run_written_outcome",
    reusedFromPatchVersionId: null,
    unitOrdinal,
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

function refinementFixture(input: {
  durableTarget: string;
  contextRerun?: WikiBrainEditResult["rerun"];
  /** Set false to model an old generic affected comment without a Node 8 receipt. */
  canonicalComment?: boolean;
  /** The result edit's target is already selected as the current child base. */
  inheritedResultEdit?: string;
  /** Stop after target selection when the test need not materialize a patch. */
  persistFailure?: Error;
}) {
  const base = patchSurface();
  if (input.inheritedResultEdit !== undefined) {
    base.patchVersionId = "patch-context-v2";
    base.parentPatchVersionId = observedPatchVersionId;
  }
  base.units = [
    {
      bridgeUnitId: "bridge-unit-a",
      sourceRunId: base.runId,
      journalOutcomeId: "outcome-v1-a",
      resultRevisionId: "revision-v1-a",
      targetBody: input.inheritedResultEdit ?? "Observed v1 target",
      memberOrigin: "run_written_outcome",
      reusedFromPatchVersionId: null,
      unitOrdinal: 0,
    },
  ];
  const loadDraftTexts = vi.fn(async () => new Map([["bridge-unit-a", input.durableTarget]]));
  const persistUnit = vi.fn(async () => {
    if (input.persistFailure !== undefined) throw input.persistFailure;
  });
  const refinement: LocalizationRefinementRunRecord = {
    run: {
      ...observedRun(),
      runId: "run-context-v2",
      basePatchVersionId: base.patchVersionId,
      fenceToken: 2,
      status: "running",
    },
    basePatchVersionId: base.patchVersionId,
    feedbackBatches: [
      {
        feedbackBatchId: "feedback-comment-batch",
        observedPatchVersionId,
        eventIds:
          input.inheritedResultEdit === undefined
            ? ["feedback-comment-event"]
            : ["feedback-comment-event", "feedback-result-edit-v1"],
      },
    ],
    wikiHeads: [],
    members: [
      {
        bridgeUnitId: "bridge-unit-a",
        strategy: "redraft",
        basePatchVersionId: base.patchVersionId,
        baseSourceRunId: base.runId,
        baseJournalOutcomeId: "outcome-v1-a",
        baseResultRevisionId: "revision-v1-a",
      },
    ],
  };
  const createRefinementRun = vi.fn(
    async (_actor, createInput: { feedbackEventIds?: readonly string[] }) => {
      const inheritedResultEditOnly =
        input.inheritedResultEdit !== undefined &&
        createInput.feedbackEventIds?.length === 1 &&
        createInput.feedbackEventIds[0] === "feedback-result-edit-v1";
      return {
        ...refinement,
        members: refinement.members.map((member) => ({
          ...member,
          strategy: inheritedResultEditOnly ? ("reuse" as const) : member.strategy,
        })),
      };
    },
  );
  const terminalize = vi.fn();
  const commentContextRerun: WikiBrainEditResult["rerun"] | undefined =
    input.contextRerun ??
    (input.canonicalComment === false
      ? undefined
      : { state: "succeeded", jobStatus: "succeeded", error: null });
  const observedParent = {
    ...base,
    patchVersionId: observedPatchVersionId,
    parentPatchVersionId: null,
    units: base.units.map((unit) => ({ ...unit, targetBody: "Observed v1 target" })),
  };
  const iteration = {
    loadPatchPlaySurface: vi.fn(async (_actor, patchVersionId: string) =>
      patchVersionId === observedPatchVersionId ? observedParent : base,
    ),
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
              metadata:
                commentContextRerun === undefined
                  ? {}
                  : { contextCorrection: { rerun: commentContextRerun } },
              resultRevisionId: null,
              contextArtifactId:
                commentContextRerun === undefined ? null : "context-comment-legacy-receipt",
              contextEntryVersionId:
                commentContextRerun === undefined ? null : "context-comment-legacy-receipt-v1",
              affectedBridgeUnitIds: ["bridge-unit-a"],
              createdAt: new Date("2026-07-13T02:00:00.000Z"),
            },
            ...(input.inheritedResultEdit === undefined
              ? []
              : [
                  {
                    feedbackEventId: "feedback-result-edit-v1",
                    feedbackBatchId: "feedback-comment-batch",
                    observedPatchVersionId,
                    playSessionId: null,
                    actorUserId: actor.userId,
                    eventKind: "result_edit" as const,
                    body: "The result edit that Node 10 already selected into v2.",
                    metadata: {
                      targetBody: input.inheritedResultEdit,
                      resultRevisionPatchVersionId: "patch-context-v2",
                    },
                    resultRevisionId: "revision-play-tester-v2-a",
                    contextArtifactId: null,
                    contextEntryVersionId: null,
                    affectedBridgeUnitIds: ["bridge-unit-a"],
                    createdAt: new Date("2026-07-13T02:01:00.000Z"),
                  },
                ]),
          ],
        },
      ],
    })),
    createRefinementRun,
  } as unknown as ItotoriLocalizationIterationRepositoryPort;
  const journal = {
    loadRun: vi.fn(async () => observedRun()),
    beginAttempt: vi.fn(),
    completeAttempt: vi.fn(),
    persistUnit,
  } as unknown as ItotoriLocalizationJournalRepositoryPort;
  return {
    service: new PatchIterationService({
      actor,
      iteration,
      journal,
      finalizer: { terminalize } as unknown as ItotoriLocalizationRunFinalizerRepositoryPort,
      draftTexts: { load: loadDraftTexts },
    }),
    loadDraftTexts,
    persistUnit,
    createRefinementRun,
    terminalize,
  };
}
