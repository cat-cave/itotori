import { createHash } from "node:crypto";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
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

export type PlayTesterResultRevisionRecord = {
  resultRevisionId: string;
  journalOutcomeId: string;
  runId: string;
  bridgeUnitId: string;
  selectedCandidateId: string;
  targetBody: string;
  origin: "play_tester_edit";
  parentRevisionId: string;
  actorUserId: string;
  createdForPatchVersionId: string;
  createdAt: Date;
};

export type PlayTesterChildPatchVersionRecord = {
  patchVersionId: string;
  runId: string;
  parentPatchVersionId: string;
  status: "playable";
  origin: "play_tester_edit";
  actorUserId: string;
  artifactHashes: Record<string, string>;
  artifactRefs: Record<string, string>;
  playableAt: Date;
  selectedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  units: SelectedPatchExportUnit[];
};

export type ApplyPlayTesterTargetEditInput = {
  parentPatchVersionId: string;
  bridgeUnitId: string;
  targetBody: string;
};

export type RecordPlayTestFeedbackEventInput = {
  feedbackBatchId?: string;
  body?: string;
  metadata: Record<string, unknown>;
};

export type ApplyPlayTesterTargetEditWithFeedbackInput = ApplyPlayTesterTargetEditInput & {
  feedback: RecordPlayTestFeedbackEventInput;
};

export type PlayTestFeedbackEventRecord = {
  feedbackEventId: string;
  feedbackBatchId: string;
  observedPatchVersionId: string;
  resultRevisionId: string;
  createdAt: Date;
};

export type ApplyPlayTesterTargetEditResult = {
  resultRevision: PlayTesterResultRevisionRecord;
  patchVersion: PlayTesterChildPatchVersionRecord;
  idempotentReplay: boolean;
};

export type ApplyPlayTesterTargetEditWithFeedbackResult = {
  edit: ApplyPlayTesterTargetEditResult;
  feedback: PlayTestFeedbackEventRecord;
};

export type PlayTesterPatchArtifactMaterializationInput = {
  childPatchVersionId: string;
  parentPatchVersionId: string;
  runId: string;
  bridgeUnitId: string;
  targetBody: string;
  parentArtifactRefs: Record<string, string>;
  parentArtifactHashes: Record<string, string>;
};

export type MaterializedPlayTesterPatchArtifact = {
  artifactRefs: Record<string, string>;
  artifactHashes: Record<string, string>;
  cleanup(): Promise<void> | void;
};

export interface PlayTesterPatchArtifactMaterializer {
  materialize(
    input: PlayTesterPatchArtifactMaterializationInput,
  ): Promise<MaterializedPlayTesterPatchArtifact>;
}

export type SelectedPatchExportUnit = {
  bridgeUnitId: string;
  sourceRunId: string;
  journalOutcomeId: string;
  resultRevisionId: string;
  memberOrigin: string;
  reusedFromPatchVersionId: string | null;
  unitOrdinal: number;
  targetBody: string;
  origin: string;
  actorUserId: string | null;
  selectedCandidateId: string;
};

export type SelectedPatchExport = {
  patchVersionId: string;
  runId: string;
  parentPatchVersionId: string | null;
  origin: string;
  actorUserId: string | null;
  status: string;
  selectedAt: Date;
  playableAt: Date | null;
  artifactHashes: Record<string, string>;
  artifactRefs: Record<string, string>;
  units: SelectedPatchExportUnit[];
};

export type PlayablePatchExport = Omit<SelectedPatchExport, "selectedAt"> & {
  selectedAt: Date | null;
};

export class LocalizationResultRevisionRepositoryError extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "patch_not_found"
      | "unit_not_in_patch"
      | "patch_not_playable"
      | "blank_target"
      | "artifact_fault",
    message: string,
  ) {
    super(message);
    this.name = "LocalizationResultRevisionRepositoryError";
  }
}

export interface ItotoriLocalizationResultRevisionRepositoryPort {
  applyPlayTesterTargetEdit(
    actor: AuthorizationActor,
    input: ApplyPlayTesterTargetEditInput,
  ): Promise<ApplyPlayTesterTargetEditResult>;
  applyPlayTesterTargetEditWithFeedback(
    actor: AuthorizationActor,
    input: ApplyPlayTesterTargetEditWithFeedbackInput,
  ): Promise<ApplyPlayTesterTargetEditWithFeedbackResult>;
  loadSelectedPatchExport(
    actor: AuthorizationActor,
    input: { runId?: string; patchVersionId?: string },
  ): Promise<SelectedPatchExport | null>;
  loadPlayablePatchExport(
    actor: AuthorizationActor,
    input: { patchVersionId: string },
  ): Promise<PlayablePatchExport | null>;
}

type Tx = Parameters<Parameters<ItotoriDatabase["transaction"]>[0]>[0];

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

type LoadedPatch = {
  patchVersionId: string;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  deliveryScopeId: string;
  status: string;
  origin: string;
  actorUserId: string | null;
  parentPatchVersionId: string | null;
  artifactHashes: Record<string, string>;
  artifactRefs: Record<string, string>;
  playableAt: Date | null;
  selectedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  units: SelectedPatchExportUnit[];
};

async function loadPatch(
  db: Pick<ItotoriDatabase, "select"> | Tx,
  patchVersionId: string,
): Promise<LoadedPatch | null> {
  const [patch] = await db
    .select()
    .from(localizationPatchVersions)
    .where(eq(localizationPatchVersions.patchVersionId, patchVersionId))
    .limit(1);
  if (patch === undefined) return null;
  const rows = await db
    .select({
      bridgeUnitId: localizationPatchVersionUnits.bridgeUnitId,
      resultRevisionId: patchOutputRevisions.outputRevisionId,
      memberOrigin: localizationPatchVersionUnits.memberOrigin,
      reusedFromPatchVersionId: localizationPatchVersionUnits.reusedFromPatchVersionId,
      unitOrdinal: localizationPatchVersionUnits.unitOrdinal,
      targetBody: patchOutputRevisions.targetBody,
      origin: patchOutputRevisions.origin,
      actorUserId: patchOutputRevisions.actorUserId,
    })
    .from(localizationPatchVersionUnits)
    .innerJoin(
      patchOutputRevisions,
      eq(localizationPatchVersionUnits.outputRevisionId, patchOutputRevisions.outputRevisionId),
    )
    .where(eq(localizationPatchVersionUnits.patchVersionId, patchVersionId))
    .orderBy(asc(localizationPatchVersionUnits.unitOrdinal));
  return {
    patchVersionId: patch.patchVersionId,
    projectId: patch.projectId,
    localeBranchId: patch.localeBranchId,
    sourceRevisionId: patch.sourceRevisionId,
    deliveryScopeId: patch.deliveryScopeId,
    status: patch.status,
    origin: patch.origin,
    actorUserId: patch.actorUserId ?? null,
    parentPatchVersionId: patch.parentPatchVersionId ?? null,
    artifactHashes: { ...patch.artifactHashes },
    artifactRefs: { ...patch.artifactRefs },
    playableAt: patch.playableAt,
    selectedAt: patch.selectedAt,
    createdAt: patch.createdAt,
    updatedAt: patch.updatedAt,
    units: rows.map((row) => ({
      bridgeUnitId: row.bridgeUnitId,
      sourceRunId: patch.deliveryScopeId,
      journalOutcomeId: row.resultRevisionId,
      resultRevisionId: row.resultRevisionId,
      selectedCandidateId: row.resultRevisionId,
      memberOrigin: row.memberOrigin,
      reusedFromPatchVersionId: row.reusedFromPatchVersionId ?? null,
      unitOrdinal: row.unitOrdinal,
      targetBody: row.targetBody,
      origin: row.origin,
      actorUserId: row.actorUserId ?? null,
    })),
  };
}

async function loadSelectedByScope(
  db: Pick<ItotoriDatabase, "select"> | Tx,
  deliveryScopeId: string,
) {
  const [row] = await db
    .select()
    .from(localizationPatchVersions)
    .where(
      and(
        eq(localizationPatchVersions.deliveryScopeId, deliveryScopeId),
        isNotNull(localizationPatchVersions.selectedAt),
      ),
    )
    .limit(1);
  return row === undefined ? null : loadPatch(db, row.patchVersionId);
}

async function selectPatch(
  tx: Tx,
  deliveryScopeId: string,
  patchVersionId: string,
  now = new Date(),
) {
  await tx
    .update(localizationPatchVersions)
    .set({ selectedAt: null, updatedAt: now })
    .where(
      and(
        eq(localizationPatchVersions.deliveryScopeId, deliveryScopeId),
        isNotNull(localizationPatchVersions.selectedAt),
      ),
    );
  await tx
    .update(localizationPatchVersions)
    .set({ status: "playable", playableAt: now, selectedAt: now, updatedAt: now })
    .where(eq(localizationPatchVersions.patchVersionId, patchVersionId));
}

function selectedExport(patch: LoadedPatch): SelectedPatchExport {
  if (patch.selectedAt === null)
    throw new LocalizationResultRevisionRepositoryError(
      "artifact_fault",
      "selected patch has no selectedAt",
    );
  return {
    patchVersionId: patch.patchVersionId,
    runId: patch.deliveryScopeId,
    parentPatchVersionId: patch.parentPatchVersionId,
    origin: patch.origin,
    actorUserId: patch.actorUserId,
    status: patch.status,
    selectedAt: patch.selectedAt,
    playableAt: patch.playableAt,
    artifactHashes: patch.artifactHashes,
    artifactRefs: patch.artifactRefs,
    units: patch.units,
  };
}

function childResult(
  patch: LoadedPatch,
  outputRevisionId: string,
  actorUserId: string,
  idempotentReplay: boolean,
): ApplyPlayTesterTargetEditResult {
  const revision = patch.units.find((unit) => unit.resultRevisionId === outputRevisionId);
  if (
    revision === undefined ||
    patch.playableAt === null ||
    patch.selectedAt === null ||
    patch.parentPatchVersionId === null
  ) {
    throw new LocalizationResultRevisionRepositoryError(
      "artifact_fault",
      "child patch is incomplete",
    );
  }
  return {
    resultRevision: {
      resultRevisionId: outputRevisionId,
      journalOutcomeId: outputRevisionId,
      runId: patch.deliveryScopeId,
      bridgeUnitId: revision.bridgeUnitId,
      selectedCandidateId: outputRevisionId,
      targetBody: revision.targetBody,
      origin: "play_tester_edit",
      parentRevisionId: revision.reusedFromPatchVersionId ?? outputRevisionId,
      actorUserId,
      createdForPatchVersionId: patch.patchVersionId,
      createdAt: patch.createdAt,
    },
    patchVersion: {
      patchVersionId: patch.patchVersionId,
      runId: patch.deliveryScopeId,
      parentPatchVersionId: patch.parentPatchVersionId,
      status: "playable",
      origin: "play_tester_edit",
      actorUserId,
      artifactHashes: patch.artifactHashes,
      artifactRefs: patch.artifactRefs,
      playableAt: patch.playableAt,
      selectedAt: patch.selectedAt,
      createdAt: patch.createdAt,
      updatedAt: patch.updatedAt,
      units: patch.units,
    },
    idempotentReplay,
  };
}

function requireText(value: string | undefined, field: string): string {
  if (value === undefined || value.trim().length === 0)
    throw new LocalizationResultRevisionRepositoryError(
      "invalid_input",
      `${field} must be non-blank`,
    );
  return value;
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
