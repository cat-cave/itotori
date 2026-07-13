// p0-core-iterative-patch-versioning-and-playtest-feedback — North-Star
// synthetic/live-Postgres proof. This drives the app-facing coordinator over
// the real Kaifuu RealLive fixture rather than hand-assembling a v2 manifest.

import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { asNonBlankTargetText, type WrittenUnitOutcome } from "@itotori/localization-bridge-schema";
import {
  bootstrapLocalUser,
  hashLocalizationArtifact,
  ItotoriContextArtifactRepository,
  ItotoriLocalizationIterationRepository,
  ItotoriLocalizationJournalRepository,
  ItotoriLocalizationResultRevisionRepository,
  ItotoriLocalizationRunFinalizerRepository,
  localUserId,
  type AuthorizationActor,
  type CreateRefinementRunInput,
  type LocalizationJournalRunLeaseIdentity,
  type LocalizationRefinementRunRecord,
} from "@itotori/db";
import { describe, expect, it, vi } from "vitest";
import { runItotoriCliCommand, type ItotoriCliServices } from "../src/cli-handlers.js";
import { runKaifuuRealliveExtract } from "../src/extract/kaifuu-extract-seam.js";
import { PatchIterationService } from "../src/iteration/patch-iteration-service.js";
import { applyKaifuuRealLivePatch } from "../src/orchestrator/patch-apply-seam.js";
import { bracketWrapForRealLive } from "../src/orchestrator/localize-project-stage-command.js";
import { ProductionPlayTesterPatchArtifactMaterializer } from "../src/play/production-patch-revision-materializer.js";
import {
  bindPlayTesterResultRevisionService,
  PlayTesterResultRevisionService,
} from "../src/play/result-revision-service.js";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";

const actor: AuthorizationActor = { userId: localUserId };
const scope = {
  projectId: "project-patch-iteration-live",
  localeBranchId: "branch-patch-iteration-live",
  sourceRevisionId: "revision-patch-iteration-live",
  targetLocale: "en-US",
} as const;
const driverLease: LocalizationJournalRunLeaseIdentity = {
  ownerId: "patch-iteration-live-driver",
  fenceToken: 1,
};
const fixtureRoot = fileURLToPath(
  new URL("../../../crates/kaifuu-reallive/tests/fixtures/bridge-inventory-001/", import.meta.url),
);
// The public Kaifuu fixture's Gameexe is extraction-only metadata (its first
// line is a comment that Utsushi correctly refuses). The runtime launch proof
// supplies the same minimal valid RealLive window configuration used by the
// whole-game Utsushi integration test; Seen.txt remains the real fixture bytes.
const runtimeGameexeIni =
  "#SCREENSIZE_MOD=1\r\n" +
  "#WINDOW_ATTR=100,100,160,200,0\r\n" +
  "#WINDOW.000.POS=0:0,345\r\n" +
  "#WINDOW.000.ATTR_MOD=0\r\n" +
  "#WINDOW.000.ATTR=080,112,160,255,0\r\n" +
  "#WINDOW.000.MOJI_SIZE=25\r\n" +
  "#WINDOW.000.MOJI_POS=19,0,53,0\r\n" +
  "#WINDOW.000.MOJI_CNT=22,3\r\n" +
  "#WINDOW.000.MOJI_REP=-1,3\r\n" +
  "#WINDOW.000.NAME_MOD=0\r\n" +
  "#WINDOW.000.MESSAGE_MOD=0\r\n";

type ProductionParentArtifacts = {
  root: string;
  sourceRoot: string;
  parentPatchTarget: string;
  changedBridgeUnitId: string;
  reusedBridgeUnitId: string;
  broadenedBridgeUnitId: string;
  baseChangedTargetBody: string;
  baseReusedTargetBody: string;
  artifactRefs: Record<string, string>;
  artifactHashes: Record<string, string>;
  cleanup(): void;
};

type LivePatchPlayCliOutput = {
  surface: { patch: { patchVersionId: string } };
  session: {
    playSessionId: string;
    observedPatchVersionId: string;
    launchDescriptor: Record<string, unknown>;
    qaCallouts: unknown[];
  };
};

async function canonicalNoopFeedbackHead(
  context: Awaited<ReturnType<typeof isolatedMigratedContext>>,
  artifacts: ProductionParentArtifacts,
  label: string,
): Promise<{ contextArtifactId: string; contextEntryVersionId: string }> {
  await seedCurrentSourceUnit(context, artifacts.reusedBridgeUnitId);
  const entry = await new ItotoriContextArtifactRepository(context.db).upsertArtifact(actor, {
    projectId: scope.projectId,
    localeBranchId: scope.localeBranchId,
    sourceRevisionId: scope.sourceRevisionId,
    category: "context_note",
    title: `Canonical cleanup context ${label}`,
    body: "This canonical context exists only to exercise refinement terminalization cleanup.",
    producedByAgent: "patch-iteration-live-fixture",
    producedByTool: "tool.context-artifacts",
    producerVersion: "1.0.0",
    sourceUnits: [
      {
        bridgeUnitId: artifacts.reusedBridgeUnitId,
        citation: `patch-iteration-live:${artifacts.reusedBridgeUnitId}`,
      },
    ],
  });
  if (entry.headVersionId === null) {
    throw new Error(`canonical cleanup context ${label} did not select a head version`);
  }
  return {
    contextArtifactId: entry.contextArtifactId,
    contextEntryVersionId: entry.headVersionId,
  };
}

describe.skipIf(!process.env.DATABASE_URL)("PatchIterationService live Postgres", () => {
  it("takes a real Kaifuu v1 through CLI play feedback into a lineage-linked v2 with exact reuse", async () => {
    const context = await isolatedMigratedContext();
    const artifacts = createProductionParentArtifacts();
    try {
      await bootstrapLocalUser(context.db);
      await seedScope(context);
      const runId = "patch-iteration-live-v1";
      const v1 = await seedPlayableProductionRun(context, artifacts, runId);
      const journal = new ItotoriLocalizationJournalRepository(context.db);
      const finalizer = new ItotoriLocalizationRunFinalizerRepository(context.db);
      const iteration = new ItotoriLocalizationIterationRepository(context.db);
      const resultRevisions = bindPlayTesterResultRevisionService(
        new PlayTesterResultRevisionService({
          repository: new ItotoriLocalizationResultRevisionRepository(
            context.db,
            new ProductionPlayTesterPatchArtifactMaterializer(),
          ),
        }),
        actor,
      );
      const service = new PatchIterationService({
        actor,
        iteration,
        journal,
        finalizer,
        resultRevisions,
        now: () => new Date("2026-07-13T01:00:00.000Z"),
      });

      const v1Surface = await service.load({ patchVersionId: v1.patchVersionId });
      expect(v1Surface?.patch).toMatchObject({
        patchVersionId: v1.patchVersionId,
        status: "playable",
        units: expect.arrayContaining([
          expect.objectContaining({
            bridgeUnitId: artifacts.changedBridgeUnitId,
            targetBody: artifacts.baseChangedTargetBody,
          }),
          expect.objectContaining({
            bridgeUnitId: artifacts.reusedBridgeUnitId,
            targetBody: artifacts.baseReusedTargetBody,
          }),
        ]),
      });

      // No test launcher or scene override: `itotori patch play` reaches the
      // same default production service the dashboard uses. The launcher
      // derives the scene only from the hash-bound translated bridge, then
      // drives the materialized Kaifuu target through real Utsushi before the
      // CLI receives a durable session receipt.
      const cliOutputPath = "patch-iteration-live-play.json";
      const cliWrites = new Map<string, unknown>();
      await runItotoriCliCommand(["patch", "play", v1.patchVersionId, "--output", cliOutputPath], {
        io: {
          readJson: () => {
            throw new Error("CLI play must not read an input JSON artifact");
          },
          writeJson: (path, value) => {
            cliWrites.set(path, value);
          },
        },
        migrateDatabase: async () => {},
        withServices: async (callback) =>
          await callback({ patchIteration: service } as unknown as ItotoriCliServices),
      });
      const cliOutput = cliWrites.get(cliOutputPath) as LivePatchPlayCliOutput | undefined;
      expect(cliOutput).toMatchObject({
        surface: { patch: { patchVersionId: v1.patchVersionId } },
        session: {
          observedPatchVersionId: v1.patchVersionId,
          launchDescriptor: {
            runtime: "utsushi-reallive",
            engine: "reallive",
            scene: 1,
            replay: "observed",
            observedTextLineCount: expect.any(Number),
          },
        },
      });
      expect(cliOutput).not.toHaveProperty("delivery");
      expect(JSON.stringify(cliOutput)).not.toContain("artifactRefs");
      if (cliOutput === undefined) {
        throw new Error("CLI play did not write its requested output receipt");
      }
      const session = cliOutput.session;
      expect(session.launchDescriptor).toMatchObject({
        runtime: "utsushi-reallive",
        engine: "reallive",
        scene: 1,
        replay: "observed",
        observedTextLineCount: expect.any(Number),
      });
      expect(session.launchDescriptor).not.toHaveProperty("source");
      expect(session.qaCallouts).toEqual([
        expect.objectContaining({
          bridgeUnitId: artifacts.changedBridgeUnitId,
          contested: true,
          informational: true,
        }),
      ]);
      const persistedRuntime = await context.pool.query<{
        observed_patch_version_id: string;
        runtime: string | null;
        engine: string | null;
        scene: string | null;
        replay: string | null;
        observed_text_line_count: string | null;
      }>(
        `
          select
            observed_patch_version_id,
            launch_descriptor ->> 'runtime' as runtime,
            launch_descriptor ->> 'engine' as engine,
            launch_descriptor ->> 'scene' as scene,
            launch_descriptor ->> 'replay' as replay,
            launch_descriptor ->> 'observedTextLineCount' as observed_text_line_count
          from itotori_play_sessions
          where play_session_id = $1
        `,
        [session.playSessionId],
      );
      expect(persistedRuntime.rows).toEqual([
        {
          observed_patch_version_id: v1.patchVersionId,
          runtime: "utsushi-reallive",
          engine: "reallive",
          scene: "1",
          replay: "observed",
          observed_text_line_count: expect.stringMatching(/^\d+$/u),
        },
      ]);

      const reflectedTarget = "Refinement feedback is now in the real patch";
      const batch = await service.createFeedbackBatch({
        observedPatchVersionId: v1.patchVersionId,
        label: "North-Star real Kaifuu feedback",
      });
      const feedback = await service.feedback({
        observedPatchVersionId: v1.patchVersionId,
        feedbackBatchId: batch.feedbackBatchId,
        playSessionId: session.playSessionId,
        eventKind: "result_edit",
        targetBody: reflectedTarget,
        body: "This line needs the play-tested revision.",
        affectedBridgeUnitIds: [artifacts.changedBridgeUnitId],
      });
      expect(feedback).toMatchObject({
        observedPatchVersionId: v1.patchVersionId,
        playSessionId: session.playSessionId,
        eventKind: "result_edit",
        affectedBridgeUnitIds: [artifacts.changedBridgeUnitId],
      });
      expect(feedback.resultRevisionId).toContain("play-tester-result:");

      const v2 = await service.refine({
        basePatchVersionId: v1.patchVersionId,
        feedbackBatchIds: [batch.feedbackBatchId],
      });
      expect(v2.refinement).toMatchObject({
        basePatchVersionId: v1.patchVersionId,
        members: expect.arrayContaining([
          expect.objectContaining({
            bridgeUnitId: artifacts.changedBridgeUnitId,
            strategy: "redraft",
          }),
          expect.objectContaining({
            bridgeUnitId: artifacts.reusedBridgeUnitId,
            strategy: "reuse",
            baseResultRevisionId: `run-result:${runId}:${artifacts.reusedBridgeUnitId}`,
          }),
        ]),
      });
      expect(v2.patch).toMatchObject({
        parentPatchVersionId: v1.patchVersionId,
        origin: "refinement_run",
        status: "playable",
        units: expect.arrayContaining([
          expect.objectContaining({
            bridgeUnitId: artifacts.changedBridgeUnitId,
            sourceRunId: v2.refinement.run.runId,
            targetBody: reflectedTarget,
            memberOrigin: "run_written_outcome",
          }),
          expect.objectContaining({
            bridgeUnitId: artifacts.reusedBridgeUnitId,
            sourceRunId: runId,
            resultRevisionId: `run-result:${runId}:${artifacts.reusedBridgeUnitId}`,
            targetBody: artifacts.baseReusedTargetBody,
            memberOrigin: "reused_from_base",
            reusedFromPatchVersionId: v1.patchVersionId,
          }),
        ]),
      });
      expect(v2.patch.artifactHashes.patchTarget).not.toBe(v1.artifactHashes.patchTarget);

      const v1Seen = readFileSync(join(artifacts.parentPatchTarget, "REALLIVEDATA", "Seen.txt"));
      const v2Seen = readFileSync(
        join(v2.patch.artifactRefs.patchTarget, "REALLIVEDATA", "Seen.txt"),
      );
      expect(v2Seen.equals(v1Seen)).toBe(false);
      expect(
        reextractPatchedUnit({
          artifacts,
          bridgeUnitId: artifacts.changedBridgeUnitId,
          seenBytes: v2Seen,
          label: "verify-refinement-v2",
        }),
      ).toBe(bracketWrapForRealLive(reflectedTarget));

      const loadedV1 = await service.load({ patchVersionId: v1.patchVersionId });
      expect(loadedV1?.feedback.batches).toEqual([
        expect.objectContaining({
          feedbackBatchId: feedback.feedbackBatchId,
          events: [expect.objectContaining({ feedbackEventId: feedback.feedbackEventId })],
        }),
      ]);

      const persisted = await context.pool.query<{
        sessions: string;
        presented_callouts: string;
        feedback_batches: string;
        feedback_events: string;
        feedback_event_units: string;
        refinement_batch_snapshots: string;
        refinement_event_snapshots: string;
        observed_patch_version_id: string;
      }>(
        `
            select
              (select count(*) from itotori_play_sessions where play_session_id = $1)::text as sessions,
              (select count(*) from itotori_play_session_qa_callouts where play_session_id = $1)::text as presented_callouts,
              (select count(*) from itotori_play_test_feedback_batches where feedback_batch_id = $4)::text as feedback_batches,
              (select count(*) from itotori_play_test_feedback_events where feedback_event_id = $2)::text as feedback_events,
              (select count(*) from itotori_play_test_feedback_event_units where feedback_event_id = $2)::text as feedback_event_units,
              (select count(*) from itotori_localization_refinement_run_feedback_batches where run_id = $3)::text as refinement_batch_snapshots,
              (select count(*) from itotori_localization_refinement_run_feedback_events where run_id = $3)::text as refinement_event_snapshots,
              (select observed_patch_version_id from itotori_play_test_feedback_events where feedback_event_id = $2) as observed_patch_version_id
          `,
        [
          session.playSessionId,
          feedback.feedbackEventId,
          v2.refinement.run.runId,
          batch.feedbackBatchId,
        ],
      );
      expect(persisted.rows[0]).toEqual({
        sessions: "1",
        presented_callouts: "1",
        feedback_batches: "1",
        feedback_events: "1",
        feedback_event_units: "1",
        refinement_batch_snapshots: "1",
        refinement_event_snapshots: "1",
        observed_patch_version_id: v1.patchVersionId,
      });

      // The v1/v2 pass is intentionally scoped to two units in one fixture
      // route. A later iteration can widen that frozen scope, but must still
      // produce a complete next patch. Use a real result revision on v2 rather
      // than an event-only comment merely to make the next refinement selectable.
      const broaderBatch = await service.createFeedbackBatch({
        observedPatchVersionId: v2.patch.patchVersionId,
        label: "Broaden this scoped patch with a revised companion line",
      });
      const broaderExistingTarget = "Broader scope companion line reflected";
      await service.feedback({
        observedPatchVersionId: v2.patch.patchVersionId,
        feedbackBatchId: broaderBatch.feedbackBatchId,
        eventKind: "result_edit",
        body: "The companion line also needs the play-tested revision.",
        targetBody: broaderExistingTarget,
        affectedBridgeUnitIds: [artifacts.reusedBridgeUnitId],
      });
      const broaderTarget = "Broader scope choice reflected";
      const v3 = await service.refine({
        basePatchVersionId: v2.patch.patchVersionId,
        feedbackBatchIds: [broaderBatch.feedbackBatchId],
        scopeUnitIds: [
          artifacts.changedBridgeUnitId,
          artifacts.reusedBridgeUnitId,
          artifacts.broadenedBridgeUnitId,
        ],
        targetBodiesByUnit: { [artifacts.broadenedBridgeUnitId]: broaderTarget },
      });
      expect(v3.refinement.members).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            bridgeUnitId: artifacts.changedBridgeUnitId,
            strategy: "reuse",
          }),
          expect.objectContaining({
            bridgeUnitId: artifacts.reusedBridgeUnitId,
            strategy: "redraft",
          }),
          expect.objectContaining({
            bridgeUnitId: artifacts.broadenedBridgeUnitId,
            strategy: "new_scope",
            basePatchVersionId: null,
          }),
        ]),
      );
      expect(v3.patch).toMatchObject({
        parentPatchVersionId: v2.patch.patchVersionId,
        status: "playable",
        units: expect.arrayContaining([
          expect.objectContaining({
            bridgeUnitId: artifacts.broadenedBridgeUnitId,
            sourceRunId: v3.refinement.run.runId,
            targetBody: broaderTarget,
            memberOrigin: "run_written_outcome",
          }),
          expect.objectContaining({
            bridgeUnitId: artifacts.changedBridgeUnitId,
            sourceRunId: v2.refinement.run.runId,
            memberOrigin: "reused_from_base",
          }),
          expect.objectContaining({
            bridgeUnitId: artifacts.reusedBridgeUnitId,
            sourceRunId: v3.refinement.run.runId,
            targetBody: broaderExistingTarget,
            memberOrigin: "run_written_outcome",
          }),
        ]),
      });
      expect(v3.patch.units).toHaveLength(3);
      const v3Seen = readFileSync(
        join(v3.patch.artifactRefs.patchTarget, "REALLIVEDATA", "Seen.txt"),
      );
      // Choice labels retain their surrounding select-string quotes when
      // re-extracted; the real target content must nevertheless be present
      // in the Kaifuu bytes, proving that the broader scope is not synthetic.
      expect(
        reextractPatchedUnit({
          artifacts,
          bridgeUnitId: artifacts.broadenedBridgeUnitId,
          seenBytes: v3Seen,
          label: "verify-broadened-v3",
        }),
      ).toContain(bracketWrapForRealLive(broaderTarget));
    } finally {
      try {
        await context.close();
      } finally {
        artifacts.cleanup();
      }
    }
  }, 180_000);

  it("refines the default selected child from inherited canonical feedback without replaying its v1 result edit", async () => {
    const context = await isolatedMigratedContext();
    const artifacts = createProductionParentArtifacts();
    try {
      await bootstrapLocalUser(context.db);
      await seedScope(context);
      await seedCurrentSourceUnit(context, artifacts.changedBridgeUnitId);
      await seedCurrentSourceUnit(context, artifacts.reusedBridgeUnitId);
      const v1 = await seedPlayableProductionRun(
        context,
        artifacts,
        "patch-iteration-live-inherited-v1",
      );
      const iteration = new ItotoriLocalizationIterationRepository(context.db);
      const journal = new ItotoriLocalizationJournalRepository(context.db);
      const finalizer = new ItotoriLocalizationRunFinalizerRepository(context.db);
      const resultRevisions = bindPlayTesterResultRevisionService(
        new PlayTesterResultRevisionService({
          repository: new ItotoriLocalizationResultRevisionRepository(
            context.db,
            new ProductionPlayTesterPatchArtifactMaterializer(),
          ),
        }),
        actor,
      );
      const v3Target = "Canonical inherited feedback drives this real v3 patch.";
      const loadDraftTexts = vi.fn(async () => new Map([[artifacts.reusedBridgeUnitId, v3Target]]));
      const service = new PatchIterationService({
        actor,
        iteration,
        journal,
        finalizer,
        resultRevisions,
        draftTexts: { load: loadDraftTexts },
        now: () => new Date("2026-07-13T04:00:00.000Z"),
      });

      const batch = await service.createFeedbackBatch({
        observedPatchVersionId: v1.patchVersionId,
        label: "v1 feedback that must remain refinable from its selected child",
      });
      const v2Target = "The v1 result edit is already selected in this v2 child.";
      const resultEdit = await service.feedback({
        observedPatchVersionId: v1.patchVersionId,
        feedbackBatchId: batch.feedbackBatchId,
        eventKind: "result_edit",
        targetBody: v2Target,
        affectedBridgeUnitIds: [artifacts.changedBridgeUnitId],
      });

      // Seed the exact canonical head/receipt that a completed Node 9/8
      // correction would have returned for a different unit. The service must
      // retain the already-selected v1 result edit on A while using this
      // durable B draft for v3. That catches a whole-batch replay that would
      // otherwise re-redraft inherited result-edit feedback.
      const contextEntry = await new ItotoriContextArtifactRepository(context.db).upsertArtifact(
        actor,
        {
          projectId: scope.projectId,
          localeBranchId: scope.localeBranchId,
          sourceRevisionId: scope.sourceRevisionId,
          category: "glossary",
          title: "Inherited feedback canonical context",
          body: "The play-test correction has a durable v3 draft.",
          producedByAgent: "patch-iteration-live-fixture",
          producedByTool: "tool.context-artifacts",
          producerVersion: "1.0.0",
          sourceUnits: [
            {
              bridgeUnitId: artifacts.reusedBridgeUnitId,
              citation: `patch-iteration-live:${artifacts.reusedBridgeUnitId}`,
            },
          ],
        },
      );
      if (contextEntry.headVersionId === null) {
        throw new Error("canonical inherited-feedback fixture did not select a context head");
      }
      const comment = await iteration.recordFeedbackEvent(actor, {
        observedPatchVersionId: v1.patchVersionId,
        feedbackBatchId: batch.feedbackBatchId,
        eventKind: "comment",
        body: "The canonical comment must redraft the other selected-child unit.",
        metadata: {
          contextCorrection: {
            rerun: { state: "succeeded", jobStatus: "succeeded", error: null },
          },
        },
        contextArtifactId: contextEntry.contextArtifactId,
        contextEntryVersionId: contextEntry.headVersionId,
        affectedBridgeUnitIds: [artifacts.reusedBridgeUnitId],
      });

      const selectedChild = (await service.list({ localeBranchId: scope.localeBranchId })).find(
        (version) =>
          version.origin === "play_tester_edit" &&
          version.parentPatchVersionId === v1.patchVersionId &&
          version.selectedAt !== null,
      );
      if (selectedChild === undefined) {
        throw new Error("Node 10 did not select the result-edit child patch");
      }
      const childSurface = await service.load({ patchVersionId: selectedChild.patchVersionId });
      expect(childSurface?.feedback).toMatchObject({
        observedPatchVersionId: selectedChild.patchVersionId,
        batches: [
          expect.objectContaining({
            feedbackBatchId: batch.feedbackBatchId,
            observedPatchVersionId: v1.patchVersionId,
            events: expect.arrayContaining([
              expect.objectContaining({ feedbackEventId: resultEdit.feedbackEventId }),
              expect.objectContaining({ feedbackEventId: comment.feedbackEventId }),
            ]),
          }),
        ],
      });

      const v3 = await service.refine({
        basePatchVersionId: selectedChild.patchVersionId,
        feedbackBatchIds: [batch.feedbackBatchId],
      });
      expect(v3.refinement.members).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            bridgeUnitId: artifacts.changedBridgeUnitId,
            strategy: "reuse",
          }),
          expect.objectContaining({
            bridgeUnitId: artifacts.reusedBridgeUnitId,
            strategy: "redraft",
          }),
        ]),
      );
      expect(v3.patch).toMatchObject({
        parentPatchVersionId: selectedChild.patchVersionId,
        units: expect.arrayContaining([
          expect.objectContaining({
            bridgeUnitId: artifacts.reusedBridgeUnitId,
            targetBody: v3Target,
          }),
          expect.objectContaining({
            bridgeUnitId: artifacts.changedBridgeUnitId,
            targetBody: v2Target,
          }),
        ]),
      });
      expect(loadDraftTexts).toHaveBeenCalledWith({
        projectId: scope.projectId,
        localeBranchId: scope.localeBranchId,
        bridgeUnitIds: [artifacts.reusedBridgeUnitId],
      });
      const v3Seen = readFileSync(
        join(v3.patch.artifactRefs.patchTarget, "REALLIVEDATA", "Seen.txt"),
      );
      expect(
        reextractPatchedUnit({
          artifacts,
          bridgeUnitId: artifacts.reusedBridgeUnitId,
          seenBytes: v3Seen,
          label: "verify-inherited-feedback-v3",
        }),
      ).toContain(bracketWrapForRealLive(v3Target));
    } finally {
      try {
        await context.close();
      } finally {
        artifacts.cleanup();
      }
    }
  }, 180_000);

  it("terminalizes a failed refinement instead of leaking its running lease", async () => {
    const context = await isolatedMigratedContext();
    const artifacts = createProductionParentArtifacts();
    try {
      await bootstrapLocalUser(context.db);
      await seedScope(context);
      const v1 = await seedPlayableProductionRun(
        context,
        artifacts,
        "patch-iteration-live-cleanup-v1",
      );
      const journal = new ItotoriLocalizationJournalRepository(context.db);
      const finalizer = new ItotoriLocalizationRunFinalizerRepository(context.db);
      const iteration = new ItotoriLocalizationIterationRepository(context.db);
      const service = new PatchIterationService({
        actor,
        iteration,
        journal,
        finalizer,
        now: () => new Date("2026-07-13T03:00:00.000Z"),
      });

      const batch = await service.createFeedbackBatch({
        observedPatchVersionId: v1.patchVersionId,
        label: "exercise failed-refinement cleanup",
      });
      // Use a real canonical context fact, but deliberately freeze no wiki
      // head into this refinement. That reaches the post-seed cleanup seam
      // without reintroducing an event-only comment as a fixture shortcut.
      const canonicalContext = await canonicalNoopFeedbackHead(
        context,
        artifacts,
        "terminalization-cleanup",
      );
      await iteration.recordFeedbackEvent(actor, {
        observedPatchVersionId: v1.patchVersionId,
        feedbackBatchId: batch.feedbackBatchId,
        eventKind: "wiki_edit",
        body: "This canonical correction is intentionally outside the frozen refinement heads.",
        contextArtifactId: canonicalContext.contextArtifactId,
        contextEntryVersionId: canonicalContext.contextEntryVersionId,
      });

      await expect(
        service.refine({
          basePatchVersionId: v1.patchVersionId,
          feedbackBatchIds: [batch.feedbackBatchId],
          wikiHeads: [],
        }),
      ).rejects.toMatchObject({ code: "no_refinement_changes" });

      const persisted = await context.pool.query<{
        status: string;
        lease_owner_id: string | null;
        lease_expires_at: Date | null;
        terminal_status: string | null;
        root_cause_code: string | null;
      }>(
        `
          select
            run.status,
            run.lease_owner_id,
            run.lease_expires_at,
            summary.terminal_status,
            summary.summary_json -> 'rootCause' ->> 'code' as root_cause_code
          from itotori_localization_journal_runs run
          left join itotori_localization_run_terminal_summaries summary
            on summary.run_id = run.run_id
          where run.base_patch_version_id = $1
        `,
        [v1.patchVersionId],
      );
      expect(persisted.rows).toEqual([
        {
          status: "failed",
          lease_owner_id: null,
          lease_expires_at: null,
          terminal_status: "failed",
          root_cause_code: "no_refinement_changes",
        },
      ]);
    } finally {
      try {
        await context.close();
      } finally {
        artifacts.cleanup();
      }
    }
  }, 180_000);

  it("terminalizes a run when refinement snapshot loading fails after its commit", async () => {
    const context = await isolatedMigratedContext();
    const artifacts = createProductionParentArtifacts();
    try {
      await bootstrapLocalUser(context.db);
      await seedScope(context);
      const v1 = await seedPlayableProductionRun(
        context,
        artifacts,
        "patch-iteration-live-post-commit-cleanup-v1",
      );
      const journal = new ItotoriLocalizationJournalRepository(context.db);
      const finalizer = new ItotoriLocalizationRunFinalizerRepository(context.db);
      const iteration = new PostCommitRefinementSnapshotFailureRepository(context.db);
      const service = new PatchIterationService({
        actor,
        iteration,
        journal,
        finalizer,
        now: () => new Date("2026-07-13T03:30:00.000Z"),
      });

      const batch = await service.createFeedbackBatch({
        observedPatchVersionId: v1.patchVersionId,
        label: "post-commit refinement snapshot cleanup",
      });
      // As above, retain a canonical feedback fact and explicitly omit its
      // wiki head from this no-op refinement snapshot. The test only exercises
      // post-commit cleanup; it must not seed a legacy event-only comment.
      const canonicalContext = await canonicalNoopFeedbackHead(
        context,
        artifacts,
        "post-commit-cleanup",
      );
      await iteration.recordFeedbackEvent(actor, {
        observedPatchVersionId: v1.patchVersionId,
        feedbackBatchId: batch.feedbackBatchId,
        eventKind: "wiki_edit",
        body: "The post-commit cleanup fixture retains only canonical context feedback.",
        contextArtifactId: canonicalContext.contextArtifactId,
        contextEntryVersionId: canonicalContext.contextEntryVersionId,
      });

      await expect(
        service.refine({
          basePatchVersionId: v1.patchVersionId,
          feedbackBatchIds: [batch.feedbackBatchId],
          wikiHeads: [],
        }),
      ).rejects.toThrow("fixture refinement snapshot read failed after seed commit");

      const persisted = await context.pool.query<{
        status: string;
        lease_owner_id: string | null;
        lease_expires_at: Date | null;
        terminal_status: string | null;
        root_cause_code: string | null;
      }>(
        `
          select
            run.status,
            run.lease_owner_id,
            run.lease_expires_at,
            summary.terminal_status,
            summary.summary_json -> 'rootCause' ->> 'code' as root_cause_code
          from itotori_localization_journal_runs run
          left join itotori_localization_run_terminal_summaries summary
            on summary.run_id = run.run_id
          where run.base_patch_version_id = $1
        `,
        [v1.patchVersionId],
      );
      expect(persisted.rows).toEqual([
        {
          status: "failed",
          lease_owner_id: null,
          lease_expires_at: null,
          terminal_status: "failed",
          root_cause_code: "refinement_failure",
        },
      ]);
    } finally {
      try {
        await context.close();
      } finally {
        artifacts.cleanup();
      }
    }
  }, 180_000);
});

/** Simulates the only dangerous refinement-creation shape: seed commits, then snapshot load fails. */
class PostCommitRefinementSnapshotFailureRepository extends ItotoriLocalizationIterationRepository {
  override async createRefinementRun(
    actor: AuthorizationActor,
    input: CreateRefinementRunInput,
  ): Promise<LocalizationRefinementRunRecord> {
    await super.createRefinementRun(actor, input);
    throw new Error("fixture refinement snapshot read failed after seed commit");
  }
}

async function seedPlayableProductionRun(
  context: Awaited<ReturnType<typeof isolatedMigratedContext>>,
  artifacts: ProductionParentArtifacts,
  runId: string,
): Promise<{ patchVersionId: string; artifactHashes: Record<string, string> }> {
  const journal = new ItotoriLocalizationJournalRepository(context.db);
  const finalizer = new ItotoriLocalizationRunFinalizerRepository(context.db);
  await journal.seedRun(actor, {
    runId,
    ...scope,
    frozenScope: {
      kind: "explicit_units",
      unitIds: [artifacts.changedBridgeUnitId, artifacts.reusedBridgeUnitId],
    },
    routingPolicy: { routes: ["model-patch-iteration/provider-patch-iteration"] },
    // itotori-225-audit-allow: deterministic synthetic ceiling for fixture attempts.
    costPolicy: { kind: "patch-iteration-live", capUsd: "1.00" },
    units: [
      {
        bridgeUnitId: artifacts.changedBridgeUnitId,
        sourceUnitKey: `scene.patch-iteration.${artifacts.changedBridgeUnitId}`,
        nextAction: { kind: "drive_unit", stage: "translation" },
      },
      {
        bridgeUnitId: artifacts.reusedBridgeUnitId,
        sourceUnitKey: `scene.patch-iteration.${artifacts.reusedBridgeUnitId}`,
        nextAction: { kind: "drive_unit", stage: "translation" },
      },
    ],
    lease: { ownerId: driverLease.ownerId },
    createdAt: "2026-07-12T22:00:00.000Z",
  });
  await writeUnit(journal, runId, artifacts.changedBridgeUnitId, artifacts.baseChangedTargetBody, {
    qaCallout: true,
  });
  await writeUnit(journal, runId, artifacts.reusedBridgeUnitId, artifacts.baseReusedTargetBody);

  const patch = await finalizer.ensurePatchVersion(actor, {
    runId,
    artifactHashes: artifacts.artifactHashes,
    artifactRefs: artifacts.artifactRefs,
  });
  for (const stage of ["patch_build", "patch_apply", "validation"] as const) {
    await finalizer.upsertPatchStageEvidence(actor, {
      runId,
      stage,
      status: "succeeded",
      evidence: { fixture: "patch-iteration-live-real-kaifuu" },
    });
  }
  await finalizer.enterFinalizing(actor, { runId, lease: driverLease });
  await finalizer.completeSucceededRun(actor, { runId, patchVersionId: patch.patchVersionId });
  return { patchVersionId: patch.patchVersionId, artifactHashes: patch.artifactHashes };
}

function createProductionParentArtifacts(): ProductionParentArtifacts {
  const root = mkdtempSync(join(tmpdir(), "itotori-patch-iteration-live-"));
  const sourceRoot = join(root, "source-game");
  const sourceData = join(sourceRoot, "REALLIVEDATA");
  mkdirSync(join(sourceData, "g00"), { recursive: true });
  copyFileSync(join(fixtureRoot, "SEEN.TXT"), join(sourceData, "Seen.txt"));
  writeFileSync(join(sourceRoot, "Gameexe.ini"), runtimeGameexeIni, "utf8");

  const extractedBridgePath = join(root, "extracted-bridge.json");
  runKaifuuRealliveExtract({
    gameRoot: sourceRoot,
    gameId: "fixture",
    gameVersion: "1",
    sourceProfileId: "fixture-profile",
    sourceLocale: "ja-JP",
    scene: 1,
    bundleOutputPath: extractedBridgePath,
  });
  const translatedBridge = JSON.parse(readFileSync(extractedBridgePath, "utf8")) as {
    units: Array<{
      bridgeUnitId: string;
      sourceText: string;
      surfaceKind: string;
      target?: { locale: string; text: string };
    }>;
  };
  const changed = translatedBridge.units.find((unit) => unit.surfaceKind === "dialogue");
  const reused = translatedBridge.units.find(
    (unit) => unit.bridgeUnitId !== changed?.bridgeUnitId && unit.sourceText.trim().length > 0,
  );
  const broadened = translatedBridge.units.find(
    (unit) =>
      unit.bridgeUnitId !== changed?.bridgeUnitId &&
      unit.bridgeUnitId !== reused?.bridgeUnitId &&
      unit.sourceText.trim().length > 0,
  );
  if (changed === undefined || reused === undefined || broadened === undefined) {
    throw new Error("public RealLive fixture needs three non-blank units for the iteration proof");
  }
  const baseChangedTargetBody = "Patch v1 feedback target";
  const baseReusedTargetBody = "Patch v1 untouched target";
  for (const unit of translatedBridge.units) {
    unit.target = {
      locale: "en-US",
      text:
        unit.bridgeUnitId === changed.bridgeUnitId
          ? bracketWrapForRealLive(baseChangedTargetBody)
          : unit.sourceText,
    };
  }
  const translatedBridgePath = join(root, "translated-bridge.json");
  writeFileSync(translatedBridgePath, `${JSON.stringify(translatedBridge, null, 2)}\n`, "utf8");
  const parentPatchTarget = join(root, "parent-patch-target");
  const apply = applyKaifuuRealLivePatch({
    sourceRoot,
    targetRoot: parentPatchTarget,
    translatedBundlePath: translatedBridgePath,
    translationScope: "dialogue-and-choices",
    force: false,
  });
  const patchApply = join(root, "patch-apply.json");
  writeFileSync(patchApply, `${JSON.stringify(apply, null, 2)}\n`, "utf8");
  const artifactRefs = {
    translatedBridge: translatedBridgePath,
    patchApply,
    patchTarget: parentPatchTarget,
  };
  return {
    root,
    sourceRoot,
    parentPatchTarget,
    changedBridgeUnitId: changed.bridgeUnitId,
    reusedBridgeUnitId: reused.bridgeUnitId,
    broadenedBridgeUnitId: broadened.bridgeUnitId,
    baseChangedTargetBody,
    baseReusedTargetBody,
    artifactRefs,
    artifactHashes: Object.fromEntries(
      Object.entries(artifactRefs).map(([key, path]) => [key, hashLocalizationArtifact(path)]),
    ),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function reextractPatchedUnit(input: {
  artifacts: ProductionParentArtifacts;
  bridgeUnitId: string;
  seenBytes: Buffer;
  label: string;
}): string {
  const verificationRoot = join(input.artifacts.root, input.label);
  rmSync(verificationRoot, { recursive: true, force: true });
  cpSync(input.artifacts.sourceRoot, verificationRoot, { recursive: true });
  writeFileSync(join(verificationRoot, "REALLIVEDATA", "Seen.txt"), input.seenBytes);
  const verificationBridgePath = join(input.artifacts.root, `${input.label}-bridge.json`);
  runKaifuuRealliveExtract({
    gameRoot: verificationRoot,
    gameId: "fixture",
    gameVersion: "1",
    sourceProfileId: "fixture-profile",
    sourceLocale: "ja-JP",
    scene: 1,
    bundleOutputPath: verificationBridgePath,
  });
  const verificationBridge = JSON.parse(readFileSync(verificationBridgePath, "utf8")) as {
    units: Array<{ bridgeUnitId: string; sourceText: string }>;
  };
  const unit = verificationBridge.units.find(
    (candidate) => candidate.bridgeUnitId === input.bridgeUnitId,
  );
  if (unit === undefined) {
    throw new Error(`refined output did not re-extract ${input.bridgeUnitId}`);
  }
  return unit.sourceText;
}

async function writeUnit(
  journal: ItotoriLocalizationJournalRepository,
  runId: string,
  bridgeUnitId: string,
  body: string,
  options: { qaCallout?: boolean } = {},
): Promise<void> {
  const attemptId = `patch-iteration-live-attempt:${runId}:${bridgeUnitId}`;
  await journal.beginAttempt(actor, {
    attemptId,
    runId,
    bridgeUnitId,
    stage: "translation",
    agentLabel: "patch-iteration-live",
    logicalCallId: `patch-iteration-live-logical:${runId}:${bridgeUnitId}`,
    attemptIndex: 1,
    requestedModelId: "model-patch-iteration",
    requestedProviderId: "provider-patch-iteration",
    zdr: true,
    artifactRef: `provider-run:${attemptId}`,
    startedAt: "2026-07-12T22:00:01.000Z",
    lease: driverLease,
  });
  await journal.completeAttempt(actor, {
    attemptId,
    runId,
    bridgeUnitId,
    modelId: "model-patch-iteration",
    providerId: "provider-patch-iteration",
    costUsd: "0",
    costKind: "zero",
    tokensIn: 1,
    tokensOut: 1,
    tokenCountSource: "fixture",
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheDiscountMicrosUsd: 0,
    fallbackUsed: false,
    fallbackPlan: [],
    zdr: true,
    finishState: "stop",
    refusalState: null,
    validationResult: "accepted",
    failureClass: null,
    retryDecision: "write",
    retryDelayMs: null,
    artifactRef: `provider-run:${attemptId}`,
    errorClasses: [],
    completedAt: "2026-07-12T22:00:02.000Z",
    lease: driverLease,
  });
  const outcomeId = `patch-iteration-live-outcome:${runId}:${bridgeUnitId}`;
  const candidateId = `patch-iteration-live-candidate:${runId}:${bridgeUnitId}`;
  const findingId = `patch-iteration-live-finding:${runId}:${bridgeUnitId}`;
  const outcome: WrittenUnitOutcome = {
    id: outcomeId,
    status: "written",
    unitId: bridgeUnitId,
    targetLocale: scope.targetLocale,
    selectedCandidateId: candidateId,
    candidates: [
      {
        id: candidateId,
        outcomeId,
        body: asNonBlankTargetText(body),
        producedBy: { modelId: "model-patch-iteration", providerId: "provider-patch-iteration" },
        attemptId,
        kind: "primary",
      },
    ],
    findings: options.qaCallout
      ? [
          {
            id: findingId,
            outcomeId,
            candidateId,
            severity: "minor",
            category: "consistency",
            note: "Informational QA callout must not gate the iteration.",
            contested: true,
            confidence: 0.2,
          },
        ]
      : [],
    qualityFlags: [],
    provenance: { origin: "patch-iteration-live" },
    writtenAt: "2026-07-12T22:00:03.000Z",
  };
  await journal.persistUnit(actor, {
    runId,
    bridgeUnitId,
    sourceUnitKey: `scene.patch-iteration.${bridgeUnitId}`,
    outcome,
    attempts: [],
    contextPacket: { fixture: "patch-iteration-live" },
    contextRefs: [],
    speakerLabels: [],
    qaDetails: options.qaCallout
      ? {
          [findingId]: {
            recommendation: "Show this as an informational play-session callout.",
            agentRationale: "Synthetic contested finding for the North-Star proof.",
            evidenceRefs: ["fixture:patch-iteration-live"],
          },
        }
      : {},
    lease: driverLease,
  });
}

async function seedScope(
  context: Awaited<ReturnType<typeof isolatedMigratedContext>>,
): Promise<void> {
  await context.pool.query(`
    insert into itotori_workspaces (workspace_id, name)
    values ('workspace-patch-iteration-live', 'Patch Iteration Live Workspace')
  `);
  await context.pool.query(
    `
      insert into itotori_projects (
        project_id, workspace_id, project_key, name, source_locale, status
      ) values ($1, 'workspace-patch-iteration-live', 'patch-iteration-live',
        'Patch Iteration Live Project', 'ja-JP', 'imported')
    `,
    [scope.projectId],
  );
  await context.pool.query(
    `
      insert into itotori_source_revisions (source_revision_id, project_id, revision_kind, value)
      values ($1, $2, 'bridge_revision', 'patch-iteration-live-v1')
    `,
    [scope.sourceRevisionId, scope.projectId],
  );
  await context.pool.query(
    `
      insert into itotori_source_bundles (
        source_bundle_id, project_id, source_bundle_revision_id, bridge_id,
        schema_version, source_bundle_hash, source_locale,
        extractor_name, extractor_version, unit_count, asset_count
      ) values (
        'source-bundle-patch-iteration-live', $1, $2,
        'bridge-patch-iteration-live', '0.2.0', 'hash:patch-iteration-live', 'ja-JP',
        'fixture-extractor', '1.0.0', 0, 0
      )
    `,
    [scope.projectId, scope.sourceRevisionId],
  );
  await context.pool.query(
    `
      insert into itotori_locale_branches (
        locale_branch_id, project_id, source_bundle_id, target_locale, branch_name, status
      ) values (
        $1, $2, 'source-bundle-patch-iteration-live',
        $3, 'Patch Iteration Live branch', 'active'
      )
    `,
    [scope.localeBranchId, scope.projectId, scope.targetLocale],
  );
}

/** Add one current bundle member so the canonical-context repository can cite it. */
async function seedCurrentSourceUnit(
  context: Awaited<ReturnType<typeof isolatedMigratedContext>>,
  bridgeUnitId: string,
): Promise<void> {
  const assetId = `asset-patch-iteration-live-${bridgeUnitId}`;
  await context.pool.query(
    `
      insert into itotori_assets (
        asset_id, project_id, source_bundle_id, source_revision_id,
        asset_key, asset_kind, source_hash
      ) values ($1, $2, 'source-bundle-patch-iteration-live', $3, $4, 'text', 'hash:live-unit')
    `,
    [assetId, scope.projectId, scope.sourceRevisionId, `fixture:${bridgeUnitId}`],
  );
  await context.pool.query(
    `
      insert into itotori_source_units (
        bridge_unit_id, project_id, source_bundle_id, source_asset_id, source_revision_id,
        surface_id, surface_kind, source_unit_key, occurrence_id, source_locale,
        source_text, source_hash, source_location, speaker, context, policy,
        spans, patch_ref, runtime_expectation
      ) values (
        $1, $2, 'source-bundle-patch-iteration-live', $3, $4,
        $5, 'dialogue', $6, $7, 'ja-JP',
        'fixture source', 'hash:live-unit', '{}'::jsonb, null, '{}'::jsonb, null,
        '[]'::jsonb, '{}'::jsonb, '{}'::jsonb
      )
    `,
    [
      bridgeUnitId,
      scope.projectId,
      assetId,
      scope.sourceRevisionId,
      `surface:${bridgeUnitId}`,
      `fixture:${bridgeUnitId}`,
      `occurrence:${bridgeUnitId}`,
    ],
  );
}
