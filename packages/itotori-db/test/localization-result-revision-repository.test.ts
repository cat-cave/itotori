import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { asNonBlankTargetText, type WrittenUnitOutcome } from "@itotori/localization-bridge-schema";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import { hashLocalizationArtifact } from "../src/localization-artifact-integrity.js";
import {
  ItotoriLocalizationJournalRepository,
  type LocalizationJournalRunLeaseIdentity,
} from "../src/repositories/localization-journal-repository.js";
import { ItotoriLocalizationRunFinalizerRepository } from "../src/repositories/localization-run-finalizer-repository.js";
import {
  ItotoriLocalizationResultRevisionRepository,
  LocalizationResultRevisionRepositoryError,
  type ApplyPlayTesterTargetEditWithFeedbackInput,
  type PlayTesterPatchArtifactMaterializer,
} from "../src/repositories/localization-result-revision-repository.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };
const playTesterActor: AuthorizationActor = { userId: "play-tester-alice" };

const scope = {
  projectId: "project-play-tester-result-revision",
  localeBranchId: "locale-branch-play-tester-result-revision",
  sourceRevisionId: "source-revision-play-tester-result-revision",
  targetLocale: "en-US",
} as const;

const driverLease: LocalizationJournalRunLeaseIdentity = {
  ownerId: "play-tester-result-revision-driver",
  fenceToken: 1,
};

// The @itotori/db test runner always supplies DATABASE_URL (fail-loud when missing).
describe("ItotoriLocalizationResultRevisionRepository", () => {
  it("atomically creates a play-tester result revision + child delivered patch with provenance", async () => {
    const context = await isolatedMigratedContext();
    const artifact = createRealArtifact("parent");
    const childRoot = mkdtempSync(join(tmpdir(), "itotori-play-tester-child-"));
    try {
      await seedScope(context);
      await grantDraftWrite(context, playTesterActor.userId);
      const journal = new ItotoriLocalizationJournalRepository(context.db);
      const finalizer = new ItotoriLocalizationRunFinalizerRepository(context.db);
      const materializer = createTestPatchArtifactMaterializer(childRoot);
      const revisions = new ItotoriLocalizationResultRevisionRepository(
        context.db,
        materializer.materializer,
      );
      const runId = "play-tester-edit-atomic";
      const unitIds = ["unit-a", "unit-b"];

      const parentPatch = await seedPlayablePatch({
        journal,
        finalizer,
        runId,
        unitIds,
        artifact,
      });

      const editedBody = "Edited target for unit-a — play tester only.";
      const result = await revisions.applyPlayTesterTargetEdit(playTesterActor, {
        parentPatchVersionId: parentPatch.patchVersionId,
        bridgeUnitId: "unit-a",
        targetBody: editedBody,
      });

      expect(result.idempotentReplay).toBe(false);
      expect(result.resultRevision).toMatchObject({
        origin: "play_tester_edit",
        bridgeUnitId: "unit-a",
        targetBody: editedBody,
        actorUserId: playTesterActor.userId,
        parentRevisionId: "run-result:play-tester-edit-atomic:unit-a",
        createdForPatchVersionId: result.patchVersion.patchVersionId,
      });
      expect(result.patchVersion).toMatchObject({
        parentPatchVersionId: parentPatch.patchVersionId,
        origin: "play_tester_edit",
        status: "playable",
        actorUserId: playTesterActor.userId,
      });
      expect(result.patchVersion.selectedAt).toBeInstanceOf(Date);
      expect(Object.keys(result.patchVersion.artifactHashes).length).toBeGreaterThan(0);
      expect(Object.keys(result.patchVersion.artifactRefs).length).toBeGreaterThan(0);

      // The injected materializer owns a patch tree; its hash-bound output is
      // what the repository persists. There is no repository-authored
      // delivered-units sidecar here.
      for (const [key, ref] of Object.entries(result.patchVersion.artifactRefs)) {
        expect(hashLocalizationArtifact(ref)).toBe(result.patchVersion.artifactHashes[key]);
      }
      const childPatchTarget = result.patchVersion.artifactRefs.patchTarget;
      expect(childPatchTarget).toBeDefined();
      expect(readFileSync(join(childPatchTarget!, "patched-game.bin"), "utf8")).toContain(
        editedBody,
      );

      // Unit-b is inherited from the parent revision membership.
      expect(result.patchVersion.units).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            bridgeUnitId: "unit-a",
            resultRevisionId: result.resultRevision.resultRevisionId,
            targetBody: editedBody,
          }),
          expect.objectContaining({
            bridgeUnitId: "unit-b",
            resultRevisionId: "run-result:play-tester-edit-atomic:unit-b",
          }),
        ]),
      );

      const exportView = await revisions.loadSelectedPatchExport(localActor, { runId });
      expect(exportView).not.toBeNull();
      expect(exportView!.patchVersionId).toBe(result.patchVersion.patchVersionId);
      expect(exportView!.units.find((unit) => unit.bridgeUnitId === "unit-a")?.targetBody).toBe(
        editedBody,
      );
      // No approval / reviewer state involved — selection moved with the edit.
      expect(exportView!.origin).toBe("play_tester_edit");
      expect(exportView!.actorUserId).toBe(playTesterActor.userId);

      // Parent remains playable history but is no longer selected for export.
      const parentRow = await context.pool.query<{ selected_at: Date | null; status: string }>(
        `
          select selected_at, status
          from itotori_localization_patch_versions
          where patch_version_id = $1
        `,
        [parentPatch.patchVersionId],
      );
      expect(parentRow.rows[0]).toMatchObject({ status: "playable", selected_at: null });

      // The run now selects the child, but the immutable parent must remain
      // exportable by exact version id for historical play sessions.
      const historicalParent = await revisions.loadPlayablePatchExport(localActor, {
        patchVersionId: parentPatch.patchVersionId,
      });
      expect(historicalParent).toMatchObject({
        patchVersionId: parentPatch.patchVersionId,
        status: "playable",
        selectedAt: null,
        artifactHashes: artifact.artifactHashes,
      });
      expect(historicalParent?.artifactRefs).toEqual(artifact.artifactRefs);

      // Idempotent replay of the same edit.
      const replay = await revisions.applyPlayTesterTargetEdit(playTesterActor, {
        parentPatchVersionId: parentPatch.patchVersionId,
        bridgeUnitId: "unit-a",
        targetBody: editedBody,
      });
      expect(replay.idempotentReplay).toBe(true);
      expect(replay.patchVersion.patchVersionId).toBe(result.patchVersion.patchVersionId);
      expect(replay.resultRevision.resultRevisionId).toBe(result.resultRevision.resultRevisionId);
    } finally {
      try {
        await context.close();
      } finally {
        artifact.cleanup();
        rmSync(childRoot, { recursive: true, force: true });
      }
    }
  });

  it("rolls back a selected child when its linked feedback fails validation", async () => {
    const context = await isolatedMigratedContext();
    const artifact = createRealArtifact("atomic-feedback-fail");
    const childRoot = mkdtempSync(join(tmpdir(), "itotori-play-tester-feedback-fail-"));
    try {
      await seedScope(context);
      await grantDraftWrite(context, playTesterActor.userId);
      const journal = new ItotoriLocalizationJournalRepository(context.db);
      const finalizer = new ItotoriLocalizationRunFinalizerRepository(context.db);
      const materializer = createTestPatchArtifactMaterializer(childRoot);
      const revisions = new ItotoriLocalizationResultRevisionRepository(
        context.db,
        materializer.materializer,
      );
      const runId = "play-tester-edit-atomic-feedback-fail";
      const parentPatch = await seedPlayablePatch({
        journal,
        finalizer,
        runId,
        unitIds: ["unit-only"],
        artifact,
      });

      // This is deliberately checked by feedback persistence after the child
      // result revision/patch selection work has started. The one shared DB
      // transaction must roll every child write back rather than leaving the
      // dashboard's current version ahead of its feedback inbox.
      await expect(
        revisions.applyPlayTesterTargetEditWithFeedback(playTesterActor, {
          parentPatchVersionId: parentPatch.patchVersionId,
          bridgeUnitId: "unit-only",
          targetBody: "An invalid linked feedback session must not select this child.",
          feedback: {
            playSessionId: "missing-play-session-for-atomic-feedback-test",
            body: "Record this only if its observed play session is valid.",
          },
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });

      const persisted = await context.pool.query<{
        child_revisions: string;
        child_patches: string;
        feedback_events: string;
        selected_patch: string;
      }>(
        `
          select
            (
              select count(*)
              from itotori_localization_result_revisions
              where run_id = $1 and origin = 'play_tester_edit'
            )::text as child_revisions,
            (
              select count(*)
              from itotori_localization_patch_versions
              where run_id = $1 and origin = 'play_tester_edit'
            )::text as child_patches,
            (
              select count(*)
              from itotori_play_test_feedback_events
              where observed_patch_version_id = $2
            )::text as feedback_events,
            (
              select patch_version_id
              from itotori_localization_patch_versions
              where run_id = $1 and selected_at is not null
            ) as selected_patch
        `,
        [runId, parentPatch.patchVersionId],
      );
      expect(persisted.rows[0]).toEqual({
        child_revisions: "0",
        child_patches: "0",
        feedback_events: "0",
        selected_patch: parentPatch.patchVersionId,
      });
      expect(materializer.cleanupCallCount()).toBe(1);
      expect(materializer.materializedRoots).toHaveLength(1);
      expect(existsSync(materializer.materializedRoots[0]!)).toBe(false);
    } finally {
      try {
        await context.close();
      } finally {
        artifact.cleanup();
        rmSync(childRoot, { recursive: true, force: true });
      }
    }
  }, 180_000);

  it("rejects a missing linked feedback object before it selects a child", async () => {
    const context = await isolatedMigratedContext();
    const artifact = createRealArtifact("atomic-feedback-missing");
    const childRoot = mkdtempSync(join(tmpdir(), "itotori-play-tester-feedback-missing-"));
    try {
      await seedScope(context);
      await grantDraftWrite(context, playTesterActor.userId);
      const journal = new ItotoriLocalizationJournalRepository(context.db);
      const finalizer = new ItotoriLocalizationRunFinalizerRepository(context.db);
      const materializer = createTestPatchArtifactMaterializer(childRoot);
      const revisions = new ItotoriLocalizationResultRevisionRepository(
        context.db,
        materializer.materializer,
      );
      const runId = "play-tester-edit-atomic-feedback-missing";
      const parentPatch = await seedPlayablePatch({
        journal,
        finalizer,
        runId,
        unitIds: ["unit-only"],
        artifact,
      });

      // The TypeScript field is required, but this repository is also a
      // JavaScript boundary. A malformed caller must fail before the patcher
      // can create/select a child that has no immutable feedback event.
      const malformedInput = {
        parentPatchVersionId: parentPatch.patchVersionId,
        bridgeUnitId: "unit-only",
        targetBody: "This target must not materialize without linked feedback.",
        feedback: undefined,
      } as unknown as ApplyPlayTesterTargetEditWithFeedbackInput;
      await expect(
        revisions.applyPlayTesterTargetEditWithFeedback(playTesterActor, malformedInput),
      ).rejects.toMatchObject({ code: "invalid_input" });

      const persisted = await context.pool.query<{
        child_revisions: string;
        child_patches: string;
        feedback_events: string;
        selected_patch: string;
      }>(
        `
          select
            (
              select count(*)
              from itotori_localization_result_revisions
              where run_id = $1 and origin = 'play_tester_edit'
            )::text as child_revisions,
            (
              select count(*)
              from itotori_localization_patch_versions
              where run_id = $1 and origin = 'play_tester_edit'
            )::text as child_patches,
            (
              select count(*)
              from itotori_play_test_feedback_events
              where observed_patch_version_id = $2
            )::text as feedback_events,
            (
              select patch_version_id
              from itotori_localization_patch_versions
              where run_id = $1 and selected_at is not null
            ) as selected_patch
        `,
        [runId, parentPatch.patchVersionId],
      );
      expect(persisted.rows[0]).toEqual({
        child_revisions: "0",
        child_patches: "0",
        feedback_events: "0",
        selected_patch: parentPatch.patchVersionId,
      });
      expect(materializer.cleanupCallCount()).toBe(0);
      expect(materializer.materializedRoots).toEqual([]);
    } finally {
      try {
        await context.close();
      } finally {
        artifact.cleanup();
        rmSync(childRoot, { recursive: true, force: true });
      }
    }
  }, 180_000);

  it("keeps an edit of a reused refinement member bound to its source outcome run", async () => {
    const context = await isolatedMigratedContext();
    const artifactV1 = createRealArtifact("reused-source-v1");
    const artifactV2 = createRealArtifact("reused-source-v2");
    const childRoot = mkdtempSync(join(tmpdir(), "itotori-play-tester-reused-source-"));
    try {
      await seedScope(context);
      await grantDraftWrite(context, playTesterActor.userId);
      const journal = new ItotoriLocalizationJournalRepository(context.db);
      const finalizer = new ItotoriLocalizationRunFinalizerRepository(context.db);
      const materializer = createTestPatchArtifactMaterializer(childRoot);
      const revisions = new ItotoriLocalizationResultRevisionRepository(
        context.db,
        materializer.materializer,
      );
      const v1RunId = "play-tester-reused-source-v1";
      const v2RunId = "play-tester-reused-source-v2";
      const bridgeUnitId = "reused-unit";
      const v1Patch = await seedPlayablePatch({
        journal,
        finalizer,
        runId: v1RunId,
        unitIds: [bridgeUnitId],
        artifact: artifactV1,
      });

      await journal.seedRun(localActor, {
        runId: v2RunId,
        ...scope,
        frozenScope: { kind: "explicit_units", unitIds: [bridgeUnitId] },
        routingPolicy: { routes: ["model-play-tester/provider-play-tester"] },
        // itotori-225-audit-allow: deterministic synthetic ceiling for fixture attempts.
        costPolicy: { kind: "play-tester-reused-source-fixture", capUsd: "1.00" },
        units: [
          {
            bridgeUnitId,
            sourceUnitKey: `scene.${bridgeUnitId}`,
            nextAction: { kind: "reuse_from_base" },
          },
        ],
        refinement: {
          basePatchVersionId: v1Patch.patchVersionId,
          feedbackBatchIds: [],
        },
        lease: { ownerId: driverLease.ownerId },
        createdAt: "2026-07-12T18:10:00.000Z",
      });
      const v2Patch = await finalizer.ensurePatchVersion(localActor, {
        runId: v2RunId,
        artifactHashes: artifactV2.artifactHashes,
        artifactRefs: artifactV2.artifactRefs,
      });
      for (const stage of ["patch_build", "patch_apply", "validation"] as const) {
        await finalizer.upsertPatchStageEvidence(localActor, {
          runId: v2RunId,
          stage,
          status: "succeeded",
          evidence: { fixture: "play-tester-reused-source" },
        });
      }
      await finalizer.enterFinalizing(localActor, { runId: v2RunId, lease: driverLease });
      await finalizer.completeSucceededRun(localActor, {
        runId: v2RunId,
        patchVersionId: v2Patch.patchVersionId,
        lease: driverLease,
      });

      const result = await revisions.applyPlayTesterTargetEdit(playTesterActor, {
        parentPatchVersionId: v2Patch.patchVersionId,
        bridgeUnitId,
        targetBody: "A play tester revised the inherited v1 result.",
      });

      expect(result.resultRevision).toMatchObject({
        runId: v1RunId,
        journalOutcomeId: expect.stringContaining(`:${v1RunId}:`),
        parentRevisionId: `run-result:${v1RunId}:${bridgeUnitId}`,
      });
      expect(result.patchVersion).toMatchObject({
        runId: v2RunId,
        parentPatchVersionId: v2Patch.patchVersionId,
      });
      expect(result.patchVersion.units).toEqual([
        expect.objectContaining({
          bridgeUnitId,
          sourceRunId: v1RunId,
          resultRevisionId: result.resultRevision.resultRevisionId,
          memberOrigin: "play_tester_edit",
          reusedFromPatchVersionId: v2Patch.patchVersionId,
        }),
      ]);
    } finally {
      try {
        await context.close();
      } finally {
        artifactV1.cleanup();
        artifactV2.cleanup();
        rmSync(childRoot, { recursive: true, force: true });
      }
    }
  }, 180_000);

  it("leaves no partial revision when the atomic write fails mid-flight", async () => {
    const context = await isolatedMigratedContext();
    const artifact = createRealArtifact("atomic-fail");
    const childRoot = mkdtempSync(join(tmpdir(), "itotori-play-tester-atomic-fail-"));
    try {
      await seedScope(context);
      await grantDraftWrite(context, playTesterActor.userId);
      const journal = new ItotoriLocalizationJournalRepository(context.db);
      const finalizer = new ItotoriLocalizationRunFinalizerRepository(context.db);
      const materializer = createTestPatchArtifactMaterializer(childRoot);
      const revisions = new ItotoriLocalizationResultRevisionRepository(
        context.db,
        materializer.materializer,
      );
      const runId = "play-tester-edit-atomic-fail";
      const unitIds = ["unit-only"];

      const parentPatch = await seedPlayablePatch({
        journal,
        finalizer,
        runId,
        unitIds,
        artifact,
      });

      // A real database trigger fires AFTER the child membership row is
      // inserted. This is deliberately after the materializer has written its
      // owned tree and after the result-revision + patch-version inserts, so
      // rollback/cleanup is exercised at the actual transaction boundary.
      await context.pool.query(`
        create function itotori_test_fail_play_tester_patch_unit_insert()
        returns trigger
        language plpgsql
        as $$
        begin
          raise exception 'test injected child patch unit insert failure';
        end;
        $$
      `);
      await context.pool.query(`
        create trigger itotori_test_fail_play_tester_patch_unit_insert
        after insert on itotori_localization_patch_version_units
        for each row
        execute function itotori_test_fail_play_tester_patch_unit_insert()
      `);

      await expect(
        revisions.applyPlayTesterTargetEdit(playTesterActor, {
          parentPatchVersionId: parentPatch.patchVersionId,
          bridgeUnitId: "unit-only",
          targetBody: "A real mid-transaction failure must roll this back.",
        }),
      ).rejects.toMatchObject({
        cause: { message: "test injected child patch unit insert failure" },
      });

      const residualRows = await context.pool.query<{
        result_revisions: string;
        patch_versions: string;
        patch_units: string;
      }>(
        `
          select
            (
              select count(*)
              from itotori_localization_result_revisions
              where run_id = $1 and origin = 'play_tester_edit'
            )::text as result_revisions,
            (
              select count(*)
              from itotori_localization_patch_versions
              where run_id = $1 and origin = 'play_tester_edit'
            )::text as patch_versions,
            (
              select count(*)
              from itotori_localization_patch_version_units units
              join itotori_localization_patch_versions patches
                on patches.patch_version_id = units.patch_version_id
              where patches.run_id = $1 and patches.origin = 'play_tester_edit'
            )::text as patch_units
        `,
        [runId],
      );
      expect(residualRows.rows[0]).toMatchObject({
        result_revisions: "0",
        patch_versions: "0",
        patch_units: "0",
      });

      // The materializer really ran, then its owned output was removed when
      // the database transaction rejected the membership insert.
      expect(materializer.materializedRoots).toHaveLength(1);
      expect(materializer.cleanupCallCount()).toBe(1);
      expect(existsSync(materializer.materializedRoots[0]!)).toBe(false);
      expect(readdirSync(childRoot)).toEqual([]);

      const selected = await revisions.loadSelectedPatchExport(localActor, { runId });
      expect(selected?.patchVersionId).toBe(parentPatch.patchVersionId);
      const parentRow = await context.pool.query<{ selected_at: Date | null; status: string }>(
        `
          select selected_at, status
          from itotori_localization_patch_versions
          where patch_version_id = $1
        `,
        [parentPatch.patchVersionId],
      );
      expect(parentRow.rows[0]).toMatchObject({ status: "playable" });
      expect(parentRow.rows[0]?.selected_at).toBeInstanceOf(Date);
    } finally {
      try {
        await context.close();
      } finally {
        artifact.cleanup();
        rmSync(childRoot, { recursive: true, force: true });
      }
    }
  });

  it("refuses a tampered idempotent child before changing the current selection", async () => {
    const context = await isolatedMigratedContext();
    const artifact = createRealArtifact("idempotent-integrity");
    const childRoot = mkdtempSync(join(tmpdir(), "itotori-play-tester-idempotent-integrity-"));
    try {
      await seedScope(context);
      await grantDraftWrite(context, playTesterActor.userId);
      const journal = new ItotoriLocalizationJournalRepository(context.db);
      const finalizer = new ItotoriLocalizationRunFinalizerRepository(context.db);
      const materializer = createTestPatchArtifactMaterializer(childRoot);
      const revisions = new ItotoriLocalizationResultRevisionRepository(
        context.db,
        materializer.materializer,
      );
      const runId = "play-tester-idempotent-integrity";
      const parentPatch = await seedPlayablePatch({
        journal,
        finalizer,
        runId,
        unitIds: ["unit-only"],
        artifact,
      });

      const first = await revisions.applyPlayTesterTargetEdit(playTesterActor, {
        parentPatchVersionId: parentPatch.patchVersionId,
        bridgeUnitId: "unit-only",
        targetBody: "First deliverable edit.",
      });
      const current = await revisions.applyPlayTesterTargetEdit(playTesterActor, {
        parentPatchVersionId: parentPatch.patchVersionId,
        bridgeUnitId: "unit-only",
        targetBody: "Second deliverable edit remains selected.",
      });
      expect(current.patchVersion.patchVersionId).not.toBe(first.patchVersion.patchVersionId);

      // The first child remains a durable history row, but its actual bytes no
      // longer match the stored manifest. A retry of that same content-addressed
      // edit must fail before it can replace the currently selected delivery.
      writeFileSync(
        join(first.patchVersion.artifactRefs.patchTarget, "patched-game.bin"),
        "tampered child bytes\n",
        "utf8",
      );
      await expect(
        revisions.applyPlayTesterTargetEdit(playTesterActor, {
          parentPatchVersionId: parentPatch.patchVersionId,
          bridgeUnitId: "unit-only",
          targetBody: "First deliverable edit.",
        }),
      ).rejects.toMatchObject({ code: "artifact_fault" });

      const selected = await revisions.loadSelectedPatchExport(localActor, { runId });
      expect(selected?.patchVersionId).toBe(current.patchVersion.patchVersionId);
      const selection = await context.pool.query<{
        patch_version_id: string;
        selected_at: Date | null;
      }>(
        `
          select patch_version_id, selected_at
          from itotori_localization_patch_versions
          where patch_version_id = any($1::text[])
          order by patch_version_id
        `,
        [[first.patchVersion.patchVersionId, current.patchVersion.patchVersionId]],
      );
      expect(
        selection.rows.find((row) => row.patch_version_id === first.patchVersion.patchVersionId)
          ?.selected_at,
      ).toBeNull();
      expect(
        selection.rows.find((row) => row.patch_version_id === current.patchVersion.patchVersionId)
          ?.selected_at,
      ).toBeInstanceOf(Date);
    } finally {
      try {
        await context.close();
      } finally {
        artifact.cleanup();
        rmSync(childRoot, { recursive: true, force: true });
      }
    }
  });

  it("requires only target text (non-source-speaker path) and rejects unknown units", async () => {
    const context = await isolatedMigratedContext();
    const artifact = createRealArtifact("target-only");
    const childRoot = mkdtempSync(join(tmpdir(), "itotori-play-tester-target-only-"));
    try {
      await seedScope(context);
      await grantDraftWrite(context, playTesterActor.userId);
      const journal = new ItotoriLocalizationJournalRepository(context.db);
      const finalizer = new ItotoriLocalizationRunFinalizerRepository(context.db);
      const materializer = createTestPatchArtifactMaterializer(childRoot);
      const revisions = new ItotoriLocalizationResultRevisionRepository(
        context.db,
        materializer.materializer,
      );
      const runId = "play-tester-target-only";
      const parentPatch = await seedPlayablePatch({
        journal,
        finalizer,
        runId,
        unitIds: ["spoken-line"],
        artifact,
      });

      // API surface is target-only: no source text parameter exists on the input.
      const inputKeys = Object.keys({
        parentPatchVersionId: parentPatch.patchVersionId,
        bridgeUnitId: "spoken-line",
        targetBody: "Just the target language rewrite.",
      }).sort();
      expect(inputKeys).toEqual(["bridgeUnitId", "parentPatchVersionId", "targetBody"]);
      expect(inputKeys).not.toContain("sourceText");
      expect(inputKeys).not.toContain("sourceBody");
      expect(inputKeys).not.toContain("artifactRootDir");

      await expect(
        revisions.applyPlayTesterTargetEdit(playTesterActor, {
          parentPatchVersionId: parentPatch.patchVersionId,
          bridgeUnitId: "missing-unit",
          targetBody: "orphan edit",
        }),
      ).rejects.toBeInstanceOf(LocalizationResultRevisionRepositoryError);
    } finally {
      try {
        await context.close();
      } finally {
        artifact.cleanup();
        rmSync(childRoot, { recursive: true, force: true });
      }
    }
  });
});

async function seedPlayablePatch(input: {
  journal: ItotoriLocalizationJournalRepository;
  finalizer: ItotoriLocalizationRunFinalizerRepository;
  runId: string;
  unitIds: readonly string[];
  artifact: ReturnType<typeof createRealArtifact>;
}): Promise<{ patchVersionId: string }> {
  await input.journal.seedRun(localActor, {
    runId: input.runId,
    ...scope,
    frozenScope: { kind: "explicit_units", unitIds: [...input.unitIds] },
    routingPolicy: { routes: ["model-play-tester/provider-play-tester"] },
    // itotori-225-audit-allow: deterministic synthetic ceiling for fixture attempts.
    costPolicy: { kind: "play-tester-result-revision-fixture", capUsd: "1.00" },
    units: input.unitIds.map((bridgeUnitId) => ({
      bridgeUnitId,
      sourceUnitKey: `scene.${bridgeUnitId}`,
      nextAction: { kind: "drive_unit", stage: "translation" },
    })),
    lease: { ownerId: driverLease.ownerId },
    createdAt: "2026-07-12T18:00:00.000Z",
  });
  for (const unitId of input.unitIds) {
    await writeUnit(input.journal, input.runId, unitId);
  }
  const patch = await input.finalizer.ensurePatchVersion(localActor, {
    runId: input.runId,
    artifactHashes: input.artifact.artifactHashes,
    artifactRefs: input.artifact.artifactRefs,
  });
  for (const stage of ["patch_build", "patch_apply", "validation"] as const) {
    await input.finalizer.upsertPatchStageEvidence(localActor, {
      runId: input.runId,
      stage,
      status: "succeeded",
      evidence: { fixture: "play-tester-result-revision" },
    });
  }
  await input.finalizer.enterFinalizing(localActor, {
    runId: input.runId,
    lease: driverLease,
  });
  await input.finalizer.completeSucceededRun(localActor, {
    runId: input.runId,
    patchVersionId: patch.patchVersionId,
  });
  return { patchVersionId: patch.patchVersionId };
}

async function writeUnit(
  journal: ItotoriLocalizationJournalRepository,
  runId: string,
  bridgeUnitId: string,
): Promise<void> {
  const attemptId = `play-tester-attempt:${runId}:${bridgeUnitId}`;
  await journal.beginAttempt(localActor, {
    attemptId,
    runId,
    bridgeUnitId,
    stage: "translation",
    agentLabel: "play-tester-fixture",
    logicalCallId: `play-tester-logical:${runId}:${bridgeUnitId}`,
    attemptIndex: 1,
    requestedModelId: "model-play-tester",
    requestedProviderId: "provider-play-tester",
    zdr: true,
    artifactRef: `provider-run:${attemptId}`,
    startedAt: "2026-07-12T18:00:01.000Z",
    lease: driverLease,
  });
  await journal.completeAttempt(localActor, {
    attemptId,
    runId,
    bridgeUnitId,
    modelId: "model-play-tester",
    providerId: "provider-play-tester",
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
    completedAt: "2026-07-12T18:00:02.000Z",
    lease: driverLease,
  });

  const outcomeId = `play-tester-outcome:${runId}:${bridgeUnitId}`;
  const candidateId = `play-tester-candidate:${runId}:${bridgeUnitId}`;
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
        body: asNonBlankTargetText(`Translated ${bridgeUnitId}.`),
        producedBy: {
          modelId: "model-play-tester",
          providerId: "provider-play-tester",
        },
        attemptId,
        kind: "primary",
      },
    ],
    findings: [],
    qualityFlags: [],
    provenance: { origin: "play-tester-fixture" },
    writtenAt: "2026-07-12T18:00:03.000Z",
  };
  await journal.persistUnit(localActor, {
    runId,
    bridgeUnitId,
    sourceUnitKey: `scene.${bridgeUnitId}`,
    outcome,
    attempts: [],
    contextPacket: { fixture: "play-tester-result-revision" },
    contextRefs: [],
    speakerLabels: [],
    qaDetails: {},
    lease: driverLease,
  });
}

/**
 * The DB repository must only persist artifacts a production-owned materializer
 * hands it. This test double owns one child directory per materialization,
 * writes a stand-in patched-game byte payload, returns a hash-bound target
 * tree, and exposes cleanup observation for the rollback proof.
 */
function createTestPatchArtifactMaterializer(artifactRootDir: string): {
  materializer: PlayTesterPatchArtifactMaterializer;
  materializedRoots: string[];
  cleanupCallCount: () => number;
} {
  const materializedRoots: string[] = [];
  let cleanupCalls = 0;
  const materializer: PlayTesterPatchArtifactMaterializer = {
    async materialize(input) {
      const root = join(artifactRootDir, input.childPatchVersionId);
      const patchTarget = join(root, "patch-target");
      rmSync(root, { recursive: true, force: true });
      mkdirSync(patchTarget, { recursive: true });
      writeFileSync(
        join(patchTarget, "patched-game.bin"),
        JSON.stringify(
          {
            childPatchVersionId: input.childPatchVersionId,
            parentPatchVersionId: input.parentPatchVersionId,
            bridgeUnitId: input.bridgeUnitId,
            targetBody: input.targetBody,
          },
          null,
          2,
        ),
        "utf8",
      );
      materializedRoots.push(root);
      const artifactRefs = { patchTarget };
      const artifactHashes = { patchTarget: hashLocalizationArtifact(patchTarget) };
      return {
        artifactRefs,
        artifactHashes,
        cleanup: () => {
          cleanupCalls += 1;
          rmSync(root, { recursive: true, force: true });
        },
      };
    },
  };
  return {
    materializer,
    materializedRoots,
    cleanupCallCount: () => cleanupCalls,
  };
}

function createRealArtifact(label: string): {
  path: string;
  artifactRefs: Record<string, string>;
  artifactHashes: Record<string, string>;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), `itotori-play-tester-parent-${label}-`));
  const path = join(root, "patch-artifact.bin");
  writeFileSync(path, `play tester parent artifact: ${label}\n`, "utf8");
  return {
    path,
    artifactRefs: { patch: path },
    artifactHashes: { patch: hashLocalizationArtifact(path) },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

async function seedScope(
  context: Awaited<ReturnType<typeof isolatedMigratedContext>>,
): Promise<void> {
  await context.db.execute(sql`
    insert into itotori_workspaces (workspace_id, name)
    values ('workspace-play-tester-result-revision', 'Play Tester Result Revision Workspace')
  `);
  await context.db.execute(sql`
    insert into itotori_projects (
      project_id, workspace_id, project_key, name, source_locale, status
    ) values (
      ${scope.projectId}, 'workspace-play-tester-result-revision', 'play-tester-result-revision',
      'Play Tester Result Revision Project', 'ja-JP', 'imported'
    )
  `);
  await context.db.execute(sql`
    insert into itotori_source_revisions (source_revision_id, project_id, revision_kind, value)
    values (${scope.sourceRevisionId}, ${scope.projectId}, 'bridge_revision', 'play-tester-v1')
  `);
  await context.db.execute(sql`
    insert into itotori_source_bundles (
      source_bundle_id, project_id, source_bundle_revision_id, bridge_id,
      schema_version, source_bundle_hash, source_locale,
      extractor_name, extractor_version, unit_count, asset_count
    ) values (
      'source-bundle-play-tester-result-revision', ${scope.projectId}, ${scope.sourceRevisionId},
      'bridge-play-tester-result-revision', '0.2.0', 'hash:play-tester', 'ja-JP',
      'fixture-extractor', '1.0.0', 0, 0
    )
  `);
  await context.db.execute(sql`
    insert into itotori_locale_branches (
      locale_branch_id, project_id, source_bundle_id, target_locale, branch_name, status
    ) values (
      ${scope.localeBranchId}, ${scope.projectId}, 'source-bundle-play-tester-result-revision',
      ${scope.targetLocale}, 'Play Tester branch', 'active'
    )
  `);
}

async function grantDraftWrite(
  context: Awaited<ReturnType<typeof isolatedMigratedContext>>,
  userId: string,
): Promise<void> {
  await context.db.execute(sql`
    insert into itotori_users (user_id, display_name)
    values (${userId}, ${`Play tester ${userId}`})
    on conflict (user_id) do nothing
  `);
  await context.db.execute(sql`
    insert into itotori_user_permission_grants (user_id, permission)
    values
      (${userId}, 'draft.write'),
      (${userId}, 'catalog.read')
    on conflict do nothing
  `);
}
