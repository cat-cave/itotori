import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { asNonBlankTargetText, type WrittenUnitOutcome } from "@itotori/localization-bridge-schema";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import { hashLocalizationArtifact } from "../src/localization-artifact-integrity.js";
import { ItotoriLocalizationIterationRepository } from "../src/repositories/localization-iteration-repository.js";
import {
  ItotoriLocalizationJournalRepository,
  type LocalizationJournalRunLeaseIdentity,
} from "../src/repositories/localization-journal-repository.js";
import { ItotoriLocalizationRunFinalizerRepository } from "../src/repositories/localization-run-finalizer-repository.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const actor: AuthorizationActor = { userId: localUserId };
const scope = {
  projectId: "project-iteration-repository",
  localeBranchId: "locale-branch-iteration-repository",
  sourceRevisionId: "source-revision-iteration-repository",
  targetLocale: "en-US",
} as const;
const lease: LocalizationJournalRunLeaseIdentity = {
  ownerId: "iteration-repository-driver",
  fenceToken: 1,
};

describe.skipIf(!process.env.DATABASE_URL)("ItotoriLocalizationIterationRepository", () => {
  it("freezes exact feedback and reuses unaffected base revisions in a playable refinement patch", async () => {
    const context = await isolatedMigratedContext();
    const artifactV1 = artifact("v1");
    const artifactV2 = artifact("v2");
    try {
      await seedScope(context);
      const journal = new ItotoriLocalizationJournalRepository(context.db);
      const finalizer = new ItotoriLocalizationRunFinalizerRepository(context.db);
      const iteration = new ItotoriLocalizationIterationRepository(context.db);
      const v1RunId = "iteration-v1-run";
      const v2RunId = "iteration-v2-run";
      const changedUnit = "iteration-unit-changed";
      const reusedUnit = "iteration-unit-reused";

      await journal.seedRun(actor, seedInput(v1RunId, [changedUnit, reusedUnit]));
      await writeUnit(journal, v1RunId, changedUnit, "v1 changed", { callout: true });
      await writeUnit(journal, v1RunId, reusedUnit, "v1 reused");
      const v1Patch = await finalizer.ensurePatchVersion(actor, {
        runId: v1RunId,
        artifactRefs: artifactV1.artifactRefs,
        artifactHashes: artifactV1.artifactHashes,
      });
      await succeedPatchWorkers(finalizer, v1RunId);
      await finalizer.enterFinalizing(actor, { runId: v1RunId, lease });
      await finalizer.completeSucceededRun(actor, {
        runId: v1RunId,
        patchVersionId: v1Patch.patchVersionId,
      });

      const session = await iteration.startPlaySession(actor, {
        observedPatchVersionId: v1Patch.patchVersionId,
        launchDescriptor: { mode: "fixture" },
      });
      expect(session.qaCallouts).toHaveLength(1);
      const addedContextHead = {
        contextArtifactId: "iteration-added-context",
        contextEntryVersionId: "iteration-added-context-v1",
      };
      const wikiEditHead = {
        contextArtifactId: "iteration-wiki-edit",
        contextEntryVersionId: "iteration-wiki-edit-v2",
      };
      await seedContextHead(context, {
        ...addedContextHead,
        affectedUnitIds: [changedUnit],
        title: "Play-test route note",
      });
      await seedContextHead(context, {
        ...wikiEditHead,
        affectedUnitIds: [changedUnit],
        title: "Existing wiki route note",
      });
      const feedbackBatch = await iteration.createFeedbackBatch(actor, {
        observedPatchVersionId: v1Patch.patchVersionId,
        label: "mixed selection fixture",
      });
      const feedback = await iteration.recordFeedbackEvent(actor, {
        observedPatchVersionId: v1Patch.patchVersionId,
        feedbackBatchId: feedbackBatch.feedbackBatchId,
        playSessionId: session.playSessionId,
        eventKind: "result_edit",
        resultRevisionId: `run-result:${v1RunId}:${changedUnit}`,
        body: "Please redraw this target line.",
        affectedBridgeUnitIds: [changedUnit],
      });
      const unselectedSibling = await iteration.recordFeedbackEvent(actor, {
        observedPatchVersionId: v1Patch.patchVersionId,
        feedbackBatchId: feedbackBatch.feedbackBatchId,
        eventKind: "comment",
        body: "This sibling must not be pulled into an individual selection.",
      });
      const addedContext = await iteration.recordFeedbackEvent(actor, {
        observedPatchVersionId: v1Patch.patchVersionId,
        playSessionId: session.playSessionId,
        eventKind: "added_context",
        body: "The route lock only opens after the station scene.",
        contextArtifactId: addedContextHead.contextArtifactId,
        contextEntryVersionId: addedContextHead.contextEntryVersionId,
        affectedBridgeUnitIds: [changedUnit],
      });
      const wikiEdit = await iteration.recordFeedbackEvent(actor, {
        observedPatchVersionId: v1Patch.patchVersionId,
        playSessionId: session.playSessionId,
        eventKind: "wiki_edit",
        body: "Correct the canonical route note before the next pass.",
        contextArtifactId: wikiEditHead.contextArtifactId,
        contextEntryVersionId: wikiEditHead.contextEntryVersionId,
        affectedBridgeUnitIds: [changedUnit],
      });
      const inbox = await iteration.loadFeedbackInbox(actor, v1Patch.patchVersionId);
      expect(inbox.batches).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            feedbackBatchId: feedback.feedbackBatchId,
            events: expect.arrayContaining([
              expect.objectContaining({ feedbackEventId: feedback.feedbackEventId }),
              expect.objectContaining({ feedbackEventId: unselectedSibling.feedbackEventId }),
            ]),
          }),
          expect.objectContaining({
            events: [
              expect.objectContaining({
                feedbackEventId: addedContext.feedbackEventId,
                eventKind: "added_context",
                contextEntryVersionId: addedContextHead.contextEntryVersionId,
              }),
            ],
          }),
          expect.objectContaining({
            events: [
              expect.objectContaining({
                feedbackEventId: wikiEdit.feedbackEventId,
                eventKind: "wiki_edit",
                contextEntryVersionId: wikiEditHead.contextEntryVersionId,
              }),
            ],
          }),
        ]),
      );

      const refinement = await iteration.createRefinementRun(actor, {
        ...seedInput(v2RunId, [changedUnit, reusedUnit]),
        basePatchVersionId: v1Patch.patchVersionId,
        feedbackBatchIds: [],
        feedbackEventIds: [
          feedback.feedbackEventId,
          addedContext.feedbackEventId,
          wikiEdit.feedbackEventId,
        ],
      });
      expect(refinement).toMatchObject({
        basePatchVersionId: v1Patch.patchVersionId,
        feedbackBatches: expect.arrayContaining([
          expect.objectContaining({
            feedbackBatchId: feedbackBatch.feedbackBatchId,
            eventIds: [feedback.feedbackEventId],
          }),
          expect.objectContaining({ eventIds: [addedContext.feedbackEventId] }),
          expect.objectContaining({ eventIds: [wikiEdit.feedbackEventId] }),
        ]),
        members: [
          { bridgeUnitId: changedUnit, strategy: "redraft" },
          {
            bridgeUnitId: reusedUnit,
            strategy: "reuse",
            baseResultRevisionId: `run-result:${v1RunId}:${reusedUnit}`,
          },
        ],
      });
      expect(refinement.feedbackBatches[0]?.eventIds).not.toContain(
        unselectedSibling.feedbackEventId,
      );

      await writeUnit(journal, v2RunId, changedUnit, "v2 changed from feedback");
      const v2Patch = await finalizer.ensurePatchVersion(actor, {
        runId: v2RunId,
        artifactRefs: artifactV2.artifactRefs,
        artifactHashes: artifactV2.artifactHashes,
      });
      await succeedPatchWorkers(finalizer, v2RunId);
      await finalizer.enterFinalizing(actor, { runId: v2RunId, lease });
      await finalizer.completeSucceededRun(actor, {
        runId: v2RunId,
        patchVersionId: v2Patch.patchVersionId,
      });

      const playSurface = await iteration.loadPatchPlaySurface(actor, v2Patch.patchVersionId);
      expect(playSurface).toMatchObject({
        parentPatchVersionId: v1Patch.patchVersionId,
        origin: "refinement_run",
        status: "playable",
      });
      expect(playSurface?.units).toEqual([
        expect.objectContaining({
          bridgeUnitId: changedUnit,
          sourceRunId: v2RunId,
          targetBody: "v2 changed from feedback",
          memberOrigin: "run_written_outcome",
        }),
        expect.objectContaining({
          bridgeUnitId: reusedUnit,
          sourceRunId: v1RunId,
          resultRevisionId: `run-result:${v1RunId}:${reusedUnit}`,
          memberOrigin: "reused_from_base",
          reusedFromPatchVersionId: v1Patch.patchVersionId,
        }),
      ]);

      // The selected/default child must retain visibility of the immutable
      // observation made on its parent. The returned event remains truthfully
      // anchored to v1, while the inbox itself is addressed to the v2 child.
      const inheritedInbox = await iteration.loadFeedbackInbox(actor, v2Patch.patchVersionId);
      expect(inheritedInbox).toMatchObject({
        observedPatchVersionId: v2Patch.patchVersionId,
        batches: expect.arrayContaining([
          expect.objectContaining({
            feedbackBatchId: feedbackBatch.feedbackBatchId,
            observedPatchVersionId: v1Patch.patchVersionId,
            events: expect.arrayContaining([
              expect.objectContaining({
                feedbackEventId: feedback.feedbackEventId,
                observedPatchVersionId: v1Patch.patchVersionId,
              }),
            ]),
          }),
        ]),
      });

      // Selection from that inherited inbox is accepted for the current
      // child: the durable refinement snapshot keeps the v1 observation but
      // uses v2 as its base patch, so the dashboard never needs to reopen v1.
      const v3RunId = "iteration-v3-inherited-feedback-run";
      const inheritedRefinement = await iteration.createRefinementRun(actor, {
        ...seedInput(v3RunId, [changedUnit, reusedUnit]),
        basePatchVersionId: v2Patch.patchVersionId,
        feedbackBatchIds: [],
        feedbackEventIds: [feedback.feedbackEventId],
        wikiHeads: [],
      });
      expect(inheritedRefinement).toMatchObject({
        basePatchVersionId: v2Patch.patchVersionId,
        feedbackBatches: [
          {
            feedbackBatchId: feedbackBatch.feedbackBatchId,
            observedPatchVersionId: v1Patch.patchVersionId,
            eventIds: [feedback.feedbackEventId],
          },
        ],
        members: expect.arrayContaining([
          expect.objectContaining({ bridgeUnitId: changedUnit, strategy: "redraft" }),
        ]),
      });
      await finalizer.terminalize(actor, {
        runId: v3RunId,
        terminalStatus: "failed",
        lease: {
          ownerId: lease.ownerId,
          fenceToken: inheritedRefinement.run.fenceToken,
        },
        rootCause: {
          kind: "itotori_defect",
          stage: "persistence",
          code: "lineage_fixture_complete",
          message: "The lineage-inbox fixture intentionally stops before patch materialization.",
        },
      });
    } finally {
      try {
        await context.close();
      } finally {
        artifactV1.cleanup();
        artifactV2.cleanup();
      }
    }
  }, 180_000);

  it("rejects context feedback from another source revision", async () => {
    const context = await isolatedMigratedContext();
    const artifactV1 = artifact("reference-scope");
    try {
      await seedScope(context);
      const journal = new ItotoriLocalizationJournalRepository(context.db);
      const finalizer = new ItotoriLocalizationRunFinalizerRepository(context.db);
      const iteration = new ItotoriLocalizationIterationRepository(context.db);
      const runId = "iteration-reference-scope-run";
      const unitId = "iteration-reference-scope-unit";

      await journal.seedRun(actor, seedInput(runId, [unitId]));
      await writeUnit(journal, runId, unitId, "reference scope target");
      const patch = await finalizer.ensurePatchVersion(actor, {
        runId,
        artifactRefs: artifactV1.artifactRefs,
        artifactHashes: artifactV1.artifactHashes,
      });
      await succeedPatchWorkers(finalizer, runId);
      await finalizer.enterFinalizing(actor, { runId, lease });
      await finalizer.completeSucceededRun(actor, {
        runId,
        patchVersionId: patch.patchVersionId,
      });

      await expect(
        iteration.recordFeedbackEvent(actor, {
          observedPatchVersionId: patch.patchVersionId,
          eventKind: "wiki_edit",
          body: "A wiki reference without an immutable head is not feedback provenance.",
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });

      const foreignSourceRevisionId = "source-revision-iteration-foreign";
      await context.db.execute(sql`
        insert into itotori_source_revisions (source_revision_id, project_id, revision_kind, value)
        values (${foreignSourceRevisionId}, ${scope.projectId}, 'bridge_revision', 'iteration-foreign')
      `);
      await seedContextHead(context, {
        contextArtifactId: "iteration-foreign-context",
        contextEntryVersionId: "iteration-foreign-context-v1",
        affectedUnitIds: [unitId],
        title: "Foreign source context",
        contextScope: { ...scope, sourceRevisionId: foreignSourceRevisionId },
      });

      await expect(
        iteration.recordFeedbackEvent(actor, {
          observedPatchVersionId: patch.patchVersionId,
          eventKind: "wiki_edit",
          body: "Must not attach cross-source context.",
          contextArtifactId: "iteration-foreign-context",
          contextEntryVersionId: "iteration-foreign-context-v1",
          affectedBridgeUnitIds: [unitId],
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect((await iteration.loadFeedbackInbox(actor, patch.patchVersionId)).batches).toEqual([]);
    } finally {
      try {
        await context.close();
      } finally {
        artifactV1.cleanup();
      }
    }
  }, 180_000);
});

function seedInput(runId: string, unitIds: readonly string[]) {
  return {
    runId,
    ...scope,
    frozenScope: { kind: "explicit_units", unitIds: [...unitIds] },
    routingPolicy: { routes: ["model-iteration/provider-iteration"] },
    costPolicy: { kind: "iteration-fixture", capUsd: "1.00" },
    units: unitIds.map((bridgeUnitId) => ({
      bridgeUnitId,
      sourceUnitKey: `scene.${bridgeUnitId}`,
      nextAction: { kind: "drive_unit", stage: "translation" },
    })),
    lease: { ownerId: lease.ownerId },
    createdAt: "2026-07-12T12:00:00.000Z",
  };
}

async function writeUnit(
  journal: ItotoriLocalizationJournalRepository,
  runId: string,
  bridgeUnitId: string,
  body: string,
  options: { callout?: boolean } = {},
): Promise<void> {
  const attemptId = `iteration-attempt:${runId}:${bridgeUnitId}`;
  await journal.beginAttempt(actor, {
    attemptId,
    runId,
    bridgeUnitId,
    stage: "translation",
    agentLabel: "iteration-fixture",
    logicalCallId: `iteration-logical:${runId}:${bridgeUnitId}`,
    attemptIndex: 1,
    requestedModelId: "model-iteration",
    requestedProviderId: "provider-iteration",
    zdr: true,
    artifactRef: `provider-run:${attemptId}`,
    startedAt: "2026-07-12T12:00:01.000Z",
    lease,
  });
  await journal.completeAttempt(actor, {
    attemptId,
    runId,
    bridgeUnitId,
    modelId: "model-iteration",
    providerId: "provider-iteration",
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
    completedAt: "2026-07-12T12:00:02.000Z",
    lease,
  });
  const outcomeId = `iteration-outcome:${runId}:${bridgeUnitId}`;
  const candidateId = `iteration-candidate:${runId}:${bridgeUnitId}`;
  const findingId = `iteration-finding:${runId}:${bridgeUnitId}`;
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
        producedBy: { modelId: "model-iteration", providerId: "provider-iteration" },
        attemptId,
        kind: "primary",
      },
    ],
    findings: options.callout
      ? [
          {
            id: findingId,
            outcomeId,
            candidateId,
            severity: "minor",
            category: "consistency",
            note: "Informational contested fixture callout.",
            contested: true,
            confidence: 0.2,
          },
        ]
      : [],
    qualityFlags: [],
    provenance: { origin: "iteration-fixture" },
    writtenAt: "2026-07-12T12:00:03.000Z",
  };
  await journal.persistUnit(actor, {
    runId,
    bridgeUnitId,
    sourceUnitKey: `scene.${bridgeUnitId}`,
    outcome,
    attempts: [],
    contextPacket: { fixture: "iteration" },
    contextRefs: [],
    speakerLabels: [],
    qaDetails: options.callout
      ? {
          [findingId]: {
            recommendation: "Inspect after play launch.",
            agentRationale: "Fixture QA annotation.",
            evidenceRefs: ["fixture:iteration"],
          },
        }
      : {},
    lease,
  });
}

async function succeedPatchWorkers(
  finalizer: ItotoriLocalizationRunFinalizerRepository,
  runId: string,
): Promise<void> {
  for (const stage of ["patch_build", "patch_apply", "validation"] as const) {
    await finalizer.upsertPatchStageEvidence(actor, {
      runId,
      stage,
      status: "succeeded",
      evidence: { fixture: "iteration" },
    });
  }
}

async function seedScope(
  context: Awaited<ReturnType<typeof isolatedMigratedContext>>,
): Promise<void> {
  await context.db.execute(sql`
    insert into itotori_workspaces (workspace_id, name)
    values ('workspace-iteration-repository', 'Iteration Repository Workspace')
  `);
  await context.db.execute(sql`
    insert into itotori_projects (project_id, workspace_id, project_key, name, source_locale, status)
    values (${scope.projectId}, 'workspace-iteration-repository', 'iteration-repository', 'Iteration Repository Project', 'ja-JP', 'imported')
  `);
  await context.db.execute(sql`
    insert into itotori_source_revisions (source_revision_id, project_id, revision_kind, value)
    values (${scope.sourceRevisionId}, ${scope.projectId}, 'bridge_revision', 'iteration-v1')
  `);
  await context.db.execute(sql`
    insert into itotori_source_bundles (
      source_bundle_id, project_id, source_bundle_revision_id, bridge_id, schema_version,
      source_bundle_hash, source_locale, extractor_name, extractor_version, unit_count, asset_count
    ) values (
      'source-bundle-iteration-repository', ${scope.projectId}, ${scope.sourceRevisionId},
      'bridge-iteration-repository', '0.2.0', 'hash:iteration', 'ja-JP', 'fixture', '1.0.0', 0, 0
    )
  `);
  await context.db.execute(sql`
    insert into itotori_locale_branches (
      locale_branch_id, project_id, source_bundle_id, target_locale, branch_name, status
    ) values (
      ${scope.localeBranchId}, ${scope.projectId}, 'source-bundle-iteration-repository',
      ${scope.targetLocale}, 'Iteration branch', 'active'
    )
  `);
}

async function seedContextHead(
  context: Awaited<ReturnType<typeof isolatedMigratedContext>>,
  input: {
    contextArtifactId: string;
    contextEntryVersionId: string;
    affectedUnitIds: readonly string[];
    title: string;
    contextScope?: Pick<typeof scope, "projectId" | "localeBranchId" | "sourceRevisionId">;
  },
): Promise<void> {
  const contextScope = input.contextScope ?? scope;
  const normalizedTitle = input.title.toLocaleLowerCase("und");
  await context.db.execute(sql`
    insert into itotori_context_artifacts (
      context_artifact_id, project_id, locale_branch_id, source_revision_id,
      category, status, title, normalized_title, body, data, content_hash,
      produced_by_tool, producer_version, provenance, head_version_id
    ) values (
      ${input.contextArtifactId}, ${contextScope.projectId}, ${contextScope.localeBranchId}, ${contextScope.sourceRevisionId},
      'context_note', 'active', ${input.title}, ${normalizedTitle}, ${input.title}, '{}'::jsonb,
      ${`hash:${input.contextArtifactId}`}, 'iteration-fixture', 'iteration-fixture', '{}'::jsonb, null
    )
  `);
  await context.db.execute(sql`
    insert into itotori_context_entry_versions (
      context_entry_version_id, context_artifact_id, project_id, locale_branch_id,
      source_revision_id, category, status, title, normalized_title, body, data,
      content_hash, produced_by_tool, producer_version, provenance, citations, affected_unit_ids
    ) values (
      ${input.contextEntryVersionId}, ${input.contextArtifactId}, ${contextScope.projectId}, ${contextScope.localeBranchId},
      ${contextScope.sourceRevisionId}, 'context_note', 'active', ${input.title}, ${normalizedTitle}, ${input.title},
      '{}'::jsonb, ${`hash:${input.contextEntryVersionId}`}, 'iteration-fixture', 'iteration-fixture', '{}'::jsonb,
      '[]'::jsonb, ${JSON.stringify(input.affectedUnitIds)}::jsonb
    )
  `);
  await context.db.execute(sql`
    update itotori_context_artifacts
    set head_version_id = ${input.contextEntryVersionId}
    where context_artifact_id = ${input.contextArtifactId}
  `);
}

function artifact(label: string): {
  artifactRefs: Record<string, string>;
  artifactHashes: Record<string, string>;
  cleanup(): void;
} {
  const root = mkdtempSync(join(tmpdir(), `itotori-iteration-${label}-`));
  const path = join(root, "patch.bin");
  writeFileSync(path, `iteration artifact ${label}\n`, "utf8");
  return {
    artifactRefs: { patch: path },
    artifactHashes: { patch: hashLocalizationArtifact(path) },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
