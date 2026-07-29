import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import type { ItotoriDatabase } from "../connection.js";
import { verifyLocalizationArtifactManifest } from "../localization-artifact-integrity.js";
import {
  localizationPatchVersionUnits,
  localizationPatchVersions,
  patchOutputRevisions,
  playTestFeedbackBatches,
  playTestFeedbackEvents,
} from "../schema.js";
import {
  LocalizationResultRevisionRepositoryError,
  type ApplyPlayTesterTargetEditInput,
  type ApplyPlayTesterTargetEditResult,
  type ApplyPlayTesterTargetEditWithFeedbackInput,
  type ApplyPlayTesterTargetEditWithFeedbackResult,
  type ItotoriLocalizationResultRevisionRepositoryPort,
  type MaterializedPlayTesterPatchArtifact,
  type PlayablePatchExport,
  type PlayTesterPatchArtifactMaterializer,
  type SelectedPatchExport,
} from "./localization-result-revision-repository-contracts.js";
import {
  childResult,
  loadPatch,
  loadSelectedByScope,
  requireText,
  selectedExport,
  selectPatch,
} from "./localization-result-revision-repository-persistence.js";

export { LocalizationResultRevisionRepositoryError };
export type {
  ApplyPlayTesterTargetEditInput,
  ApplyPlayTesterTargetEditResult,
  ApplyPlayTesterTargetEditWithFeedbackInput,
  ApplyPlayTesterTargetEditWithFeedbackResult,
  ItotoriLocalizationResultRevisionRepositoryPort,
  MaterializedPlayTesterPatchArtifact,
  PlayablePatchExport,
  PlayTestFeedbackEventRecord,
  PlayTesterChildPatchVersionRecord,
  PlayTesterPatchArtifactMaterializationInput,
  PlayTesterPatchArtifactMaterializer,
  PlayTesterResultRevisionRecord,
  RecordPlayTestFeedbackEventInput,
  SelectedPatchExport,
  SelectedPatchExportUnit,
} from "./localization-result-revision-repository-contracts.js";

/**
 * The retained delivery reader/editor is intentionally independent of the
 * retired journal. A delivery owns branch scope and immutable target-output
 * revisions directly, so a forward migration can preserve selected patches.
 */
export class ItotoriLocalizationResultRevisionRepository implements ItotoriLocalizationResultRevisionRepositoryPort {
  constructor(
    private readonly db: ItotoriDatabase,
    private readonly patchArtifactMaterializer: PlayTesterPatchArtifactMaterializer,
  ) {}

  async applyPlayTesterTargetEdit(
    actor: AuthorizationActor,
    input: ApplyPlayTesterTargetEditInput,
  ): Promise<ApplyPlayTesterTargetEditResult> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);
    return this.edit(actor, input);
  }

  async applyPlayTesterTargetEditWithFeedback(
    actor: AuthorizationActor,
    input: ApplyPlayTesterTargetEditWithFeedbackInput,
  ): Promise<ApplyPlayTesterTargetEditWithFeedbackResult> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);
    const edit = await this.edit(actor, input);
    const feedbackBatchId =
      input.feedback.feedbackBatchId ?? `feedback:${edit.patchVersion.patchVersionId}`;
    const feedbackEventId = `feedback-event:${edit.patchVersion.patchVersionId}:${edit.resultRevision.resultRevisionId}`;
    const createdAt = new Date();
    await this.db.transaction(async (tx) => {
      await tx
        .insert(playTestFeedbackBatches)
        .values({
          feedbackBatchId,
          observedPatchVersionId: input.parentPatchVersionId,
          actorUserId: actor.userId,
          selectionKind: "individual",
          label: null,
          createdAt,
          updatedAt: createdAt,
        })
        .onConflictDoNothing();
      await tx
        .insert(playTestFeedbackEvents)
        .values({
          feedbackEventId,
          feedbackBatchId,
          observedPatchVersionId: input.parentPatchVersionId,
          actorUserId: actor.userId,
          eventKind: "result_edit",
          body: input.feedback.body ?? null,
          metadata: { ...input.feedback.metadata },
          outputRevisionId: edit.resultRevision.resultRevisionId,
          subjectRef: null,
          createdAt,
        })
        .onConflictDoNothing();
    });
    return {
      edit,
      feedback: {
        feedbackEventId,
        feedbackBatchId,
        observedPatchVersionId: input.parentPatchVersionId,
        resultRevisionId: edit.resultRevision.resultRevisionId,
        createdAt,
      },
    };
  }

  async loadSelectedPatchExport(
    actor: AuthorizationActor,
    input: { runId?: string; patchVersionId?: string },
  ): Promise<SelectedPatchExport | null> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    const patch =
      input.patchVersionId === undefined
        ? await loadSelectedByScope(this.db, requireText(input.runId, "runId"))
        : await loadPatch(this.db, requireText(input.patchVersionId, "patchVersionId"));
    return patch === null || patch.selectedAt === null ? null : selectedExport(patch);
  }

  async loadPlayablePatchExport(
    actor: AuthorizationActor,
    input: { patchVersionId: string },
  ): Promise<PlayablePatchExport | null> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    const patch = await loadPatch(this.db, requireText(input.patchVersionId, "patchVersionId"));
    if (patch === null || patch.status !== "playable" || patch.playableAt === null) return null;
    return { ...selectedExport(patch), selectedAt: patch.selectedAt };
  }

  private async edit(
    actor: AuthorizationActor,
    input: ApplyPlayTesterTargetEditInput,
  ): Promise<ApplyPlayTesterTargetEditResult> {
    requireText(input.parentPatchVersionId, "parentPatchVersionId");
    requireText(input.bridgeUnitId, "bridgeUnitId");
    if (input.targetBody.trim().length === 0) {
      throw new LocalizationResultRevisionRepositoryError(
        "blank_target",
        "targetBody must be non-blank",
      );
    }
    let artifact: MaterializedPlayTesterPatchArtifact | undefined;
    let committed = false;
    try {
      const result = await this.db.transaction(async (tx) => {
        await tx.execute(sql`
          select patch_version_id from itotori_localization_patch_versions
          where patch_version_id = ${input.parentPatchVersionId} for update
        `);
        const parent = await loadPatch(tx, input.parentPatchVersionId);
        if (parent === null)
          throw new LocalizationResultRevisionRepositoryError(
            "patch_not_found",
            "parent patch was not found",
          );
        if (parent.status !== "playable")
          throw new LocalizationResultRevisionRepositoryError(
            "patch_not_playable",
            "parent patch is not playable",
          );
        const parentUnit = parent.units.find((unit) => unit.bridgeUnitId === input.bridgeUnitId);
        if (parentUnit === undefined)
          throw new LocalizationResultRevisionRepositoryError(
            "unit_not_in_patch",
            "unit is not in parent patch",
          );

        const digest = createHash("sha256").update(input.targetBody).digest("hex").slice(0, 16);
        const patchVersionId = playTesterChildPatchVersionId(
          parent.patchVersionId,
          input.bridgeUnitId,
          digest,
        );
        const outputRevisionId = playTesterResultRevisionId(parentUnit.resultRevisionId, digest);
        const existing = await loadPatch(tx, patchVersionId);
        if (existing !== null) {
          verifyLocalizationArtifactManifest(existing.artifactRefs, existing.artifactHashes);
          await selectPatch(tx, existing.deliveryScopeId, existing.patchVersionId);
          const selected = await loadPatch(tx, patchVersionId);
          if (selected === null)
            throw new LocalizationResultRevisionRepositoryError(
              "artifact_fault",
              "selected child disappeared",
            );
          return childResult(selected, outputRevisionId, actor.userId, true);
        }

        artifact = await this.patchArtifactMaterializer.materialize({
          childPatchVersionId: patchVersionId,
          parentPatchVersionId: parent.patchVersionId,
          runId: parent.deliveryScopeId,
          bridgeUnitId: input.bridgeUnitId,
          targetBody: input.targetBody,
          parentArtifactRefs: { ...parent.artifactRefs },
          parentArtifactHashes: { ...parent.artifactHashes },
        });
        verifyLocalizationArtifactManifest(artifact.artifactRefs, artifact.artifactHashes);
        const now = new Date();
        await tx.insert(patchOutputRevisions).values({
          outputRevisionId,
          bridgeUnitId: input.bridgeUnitId,
          targetBody: input.targetBody,
          origin: "play_tester_edit",
          parentOutputRevisionId: parentUnit.resultRevisionId,
          actorUserId: actor.userId,
          createdForPatchVersionId: patchVersionId,
          createdAt: now,
        });
        await tx.insert(localizationPatchVersions).values({
          patchVersionId,
          projectId: parent.projectId,
          localeBranchId: parent.localeBranchId,
          sourceRevisionId: parent.sourceRevisionId,
          deliveryScopeId: parent.deliveryScopeId,
          status: "building",
          artifactHashes: artifact.artifactHashes,
          artifactRefs: artifact.artifactRefs,
          playableAt: null,
          parentPatchVersionId: parent.patchVersionId,
          origin: "play_tester_edit",
          actorUserId: actor.userId,
          selectedAt: null,
          createdAt: now,
          updatedAt: now,
        });
        await tx.insert(localizationPatchVersionUnits).values(
          parent.units.map((unit) => ({
            patchVersionId,
            bridgeUnitId: unit.bridgeUnitId,
            outputRevisionId:
              unit.bridgeUnitId === input.bridgeUnitId ? outputRevisionId : unit.resultRevisionId,
            memberOrigin: (unit.bridgeUnitId === input.bridgeUnitId
              ? "play_tester_edit"
              : unit.memberOrigin) as typeof localizationPatchVersionUnits.$inferInsert.memberOrigin,
            reusedFromPatchVersionId:
              unit.bridgeUnitId === input.bridgeUnitId
                ? parent.patchVersionId
                : unit.reusedFromPatchVersionId,
            unitOrdinal: unit.unitOrdinal,
            createdAt: now,
          })),
        );
        await selectPatch(tx, parent.deliveryScopeId, patchVersionId, now);
        const selected = await loadPatch(tx, patchVersionId);
        if (selected === null)
          throw new LocalizationResultRevisionRepositoryError(
            "artifact_fault",
            "child patch was not persisted",
          );
        return childResult(selected, outputRevisionId, actor.userId, false);
      });
      committed = true;
      return result;
    } finally {
      if (!committed && artifact !== undefined) await artifact.cleanup();
    }
  }
}

export function playTesterChildPatchVersionId(
  parentPatchVersionId: string,
  bridgeUnitId: string,
  bodyDigest: string,
): string {
  return `patch:play-tester:${parentPatchVersionId}:${bridgeUnitId}:${bodyDigest}`;
}

export function playTesterResultRevisionId(parentRevisionId: string, bodyDigest: string): string {
  return `output-revision:play-tester:${parentRevisionId}:${bodyDigest}`;
}
