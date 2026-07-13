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
  ItotoriLocalizationIterationRepository,
  ItotoriLocalizationJournalRepository,
  ItotoriLocalizationResultRevisionRepository,
  ItotoriLocalizationRunFinalizerRepository,
  localUserId,
  type AuthorizationActor,
  type LocalizationJournalRunLeaseIdentity,
} from "@itotori/db";
import { describe, expect, it } from "vitest";
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

describe.skipIf(!process.env.DATABASE_URL)("PatchIterationService live Postgres", () => {
  it("takes a real Kaifuu v1 through play feedback into a lineage-linked v2 with exact reuse", async () => {
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

      const session = await service.play({
        patchVersionId: v1.patchVersionId,
        launchDescriptor: { surface: "live-postgres-fixture" },
      });
      expect(session.qaCallouts).toEqual([
        expect.objectContaining({
          bridgeUnitId: artifacts.changedBridgeUnitId,
          contested: true,
          informational: true,
        }),
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
      // produce a complete next patch: inherited v2 members are reused and
      // only the newly admitted choice unit is written/materialized.
      const broaderBatch = await service.createFeedbackBatch({
        observedPatchVersionId: v2.patch.patchVersionId,
        label: "Broaden this scoped patch",
      });
      await service.feedback({
        observedPatchVersionId: v2.patch.patchVersionId,
        feedbackBatchId: broaderBatch.feedbackBatchId,
        eventKind: "comment",
        body: "Include this route choice in the next complete scoped patch.",
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
            strategy: "reuse",
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
});

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
  mkdirSync(sourceData, { recursive: true });
  copyFileSync(join(fixtureRoot, "SEEN.TXT"), join(sourceData, "Seen.txt"));
  copyFileSync(join(fixtureRoot, "Gameexe.ini"), join(sourceRoot, "Gameexe.ini"));

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
