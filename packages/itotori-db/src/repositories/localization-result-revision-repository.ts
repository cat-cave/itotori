// p0-core-result-revision-hitl — play-tester target edit → result revision +
// child delivered patch revision, atomically, with real actor provenance.
//
// A play tester (no source-language knowledge required) edits one delivered
// TARGET line. This repository:
//   1. creates a play_tester_edit LocalizedResultRevision (parent-linked)
//   2. creates a child delivered PatchVersion whose membership is the parent
//      membership with that unit swapped to the new revision
//   3. receives real patch artifact bytes + hashes from the production patcher
//   4. marks the child playable and CURRENT SELECTED for export
// all in ONE transaction. A failure leaves no partial revision or selection.
//
// Export reads the currently selected patch. There is no approval/reviewer
// state gate — selection moves with the edit.

import { createHash } from "node:crypto";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import type { ItotoriDatabase } from "../connection.js";
import { verifyLocalizationArtifactManifest } from "../localization-artifact-integrity.js";
import {
  localizationPatchVersionUnits,
  localizationPatchVersions,
  localizationResultRevisions,
} from "../schema.js";
import {
  ItotoriLocalizationIterationRepository,
  type PlayTestFeedbackEventRecord,
  type RecordPlayTestFeedbackEventInput,
} from "./localization-iteration-repository.js";

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
  units: Array<{
    bridgeUnitId: string;
    sourceRunId: string;
    journalOutcomeId: string;
    resultRevisionId: string;
    memberOrigin: string;
    reusedFromPatchVersionId: string | null;
    unitOrdinal: number;
    targetBody: string;
  }>;
};

export type ApplyPlayTesterTargetEditInput = {
  /** Parent delivered (playable) patch the play tester is editing. */
  parentPatchVersionId: string;
  bridgeUnitId: string;
  /** Non-blank target-language text only — no source text required. */
  targetBody: string;
};

/**
 * The feedback fact that must commit with a play-tester target edit.  The
 * parent patch, edited unit, result revision, event kind, and affected unit
 * are derived from the edit itself so callers cannot split the two facts or
 * accidentally attach the event to a different observation.
 */
export type ApplyPlayTesterTargetEditWithFeedbackInput = ApplyPlayTesterTargetEditInput & {
  feedback: Omit<
    RecordPlayTestFeedbackEventInput,
    "observedPatchVersionId" | "eventKind" | "resultRevisionId" | "affectedBridgeUnitIds"
  >;
};

/**
 * Input supplied to the production patch materializer after the parent lineage
 * has been locked. The DB repository owns revision membership and selection;
 * the application-owned materializer owns engine-specific bytes.
 */
export type PlayTesterPatchArtifactMaterializationInput = {
  childPatchVersionId: string;
  parentPatchVersionId: string;
  runId: string;
  bridgeUnitId: string;
  targetBody: string;
  parentArtifactRefs: Record<string, string>;
  parentArtifactHashes: Record<string, string>;
};

/**
 * A materialized, hash-bound patch artifact tree. `cleanup` must remove every
 * owned output if the surrounding DB transaction does not commit.
 */
export type MaterializedPlayTesterPatchArtifact = {
  artifactRefs: Record<string, string>;
  artifactHashes: Record<string, string>;
  cleanup(): Promise<void> | void;
};

/**
 * Application boundary for producing a genuine child game patch. This is
 * intentionally injected: @itotori/db must not imitate an engine patcher or
 * write a pretend delivery bundle itself.
 */
export interface PlayTesterPatchArtifactMaterializer {
  materialize(
    input: PlayTesterPatchArtifactMaterializationInput,
  ): Promise<MaterializedPlayTesterPatchArtifact>;
}

export type ApplyPlayTesterTargetEditResult = {
  resultRevision: PlayTesterResultRevisionRecord;
  patchVersion: PlayTesterChildPatchVersionRecord;
  /** True when the same edit was already committed (content-addressed id). */
  idempotentReplay: boolean;
};

export type ApplyPlayTesterTargetEditWithFeedbackResult = {
  edit: ApplyPlayTesterTargetEditResult;
  feedback: PlayTestFeedbackEventRecord;
};

type AppliedPlayTesterTargetEdit = {
  edit: ApplyPlayTesterTargetEditResult;
  feedback: PlayTestFeedbackEventRecord | null;
};

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

/**
 * A durable, playable patch addressed by its immutable version id. Unlike a
 * run-selected export, historical delivery deliberately remains available
 * after a newer sibling becomes the run's current selection.
 */
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
  /**
   * Atomically creates/selects a play-tester child and writes its linked
   * result-edit feedback event.  Any feedback validation failure rolls back
   * the child selection, revision, patch rows, and owned patch artifacts.
   */
  applyPlayTesterTargetEditWithFeedback(
    actor: AuthorizationActor,
    input: ApplyPlayTesterTargetEditWithFeedbackInput,
  ): Promise<ApplyPlayTesterTargetEditWithFeedbackResult>;
  loadSelectedPatchExport(
    actor: AuthorizationActor,
    input: { runId?: string; patchVersionId?: string },
  ): Promise<SelectedPatchExport | null>;
  /** Load one immutable playable patch version, regardless of current run selection. */
  loadPlayablePatchExport(
    actor: AuthorizationActor,
    input: { patchVersionId: string },
  ): Promise<PlayablePatchExport | null>;
}

type Tx = Parameters<Parameters<ItotoriDatabase["transaction"]>[0]>[0];

/**
 * Durable play-tester result-revision + child patch-revision mutation seam.
 * Writes require draft.write; export reads require catalog.read.
 */
export class ItotoriLocalizationResultRevisionRepository implements ItotoriLocalizationResultRevisionRepositoryPort {
  private readonly feedbackEvents: ItotoriLocalizationIterationRepository;

  constructor(
    private readonly db: ItotoriDatabase,
    private readonly patchArtifactMaterializer: PlayTesterPatchArtifactMaterializer,
  ) {
    this.feedbackEvents = new ItotoriLocalizationIterationRepository(db);
  }

  async applyPlayTesterTargetEdit(
    actor: AuthorizationActor,
    input: ApplyPlayTesterTargetEditInput,
  ): Promise<ApplyPlayTesterTargetEditResult> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);
    const committed = await this.applyPlayTesterTargetEditInternal(actor, input, null);
    return committed.edit;
  }

  async applyPlayTesterTargetEditWithFeedback(
    actor: AuthorizationActor,
    input: ApplyPlayTesterTargetEditWithFeedbackInput,
  ): Promise<ApplyPlayTesterTargetEditWithFeedbackResult> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);
    // Types disappear at this public repository boundary. Read the required
    // feedback object once and reject a malformed runtime caller before any
    // child patch/revision work starts; otherwise `undefined` would select a
    // child and only trip the defensive postcondition after commit.
    const feedback = requireAtomicFeedbackInput(input);
    const committed = await this.applyPlayTesterTargetEditInternal(actor, input, feedback);
    if (committed.feedback === null) {
      throw new LocalizationResultRevisionRepositoryError(
        "artifact_fault",
        "atomic play-tester edit committed without its required feedback event",
      );
    }
    return { edit: committed.edit, feedback: committed.feedback };
  }

  private async applyPlayTesterTargetEditInternal(
    actor: AuthorizationActor,
    input: ApplyPlayTesterTargetEditInput,
    feedbackInput: ApplyPlayTesterTargetEditWithFeedbackInput["feedback"] | null,
  ): Promise<AppliedPlayTesterTargetEdit> {
    assertNonBlank(input.bridgeUnitId, "bridgeUnitId");
    const targetBody = input.targetBody;
    if (targetBody.trim().length === 0) {
      throw new LocalizationResultRevisionRepositoryError(
        "blank_target",
        "play-tester target edit requires non-blank target text",
      );
    }
    const actorUserId = actor.userId;
    assertNonBlank(actorUserId, "actor.userId");

    assertNonBlank(input.parentPatchVersionId, "parentPatchVersionId");
    let materialized: MaterializedPlayTesterPatchArtifact | undefined;
    let committed = false;
    try {
      const result = await this.db.transaction(async (tx) => {
        const recordLinkedFeedback = async (
          edit: ApplyPlayTesterTargetEditResult,
        ): Promise<PlayTestFeedbackEventRecord | null> => {
          if (feedbackInput === null) return null;
          return this.feedbackEvents.recordFeedbackEventInTx(tx, actor, {
            ...feedbackInput,
            observedPatchVersionId: input.parentPatchVersionId,
            eventKind: "result_edit",
            resultRevisionId: edit.resultRevision.resultRevisionId,
            affectedBridgeUnitIds: [input.bridgeUnitId],
            // The revision payload is server-derived. A caller cannot use
            // arbitrary metadata to make the immutable feedback disagree with
            // the child patch it commits alongside.
            metadata: {
              ...feedbackInput.metadata,
              targetBody,
              resultRevisionPatchVersionId: edit.patchVersion.patchVersionId,
            },
          });
        };
        // Serialize against concurrent edits on the same parent lineage.
        await tx.execute(sql`
          select patch_version_id
          from itotori_localization_patch_versions
          where patch_version_id = ${input.parentPatchVersionId}
          for update
        `);

        const parent = await loadPatchWithUnitsInTx(tx, input.parentPatchVersionId);
        if (parent === null) {
          throw new LocalizationResultRevisionRepositoryError(
            "patch_not_found",
            `parent patch ${input.parentPatchVersionId} does not exist`,
          );
        }
        if (parent.status !== "playable") {
          throw new LocalizationResultRevisionRepositoryError(
            "patch_not_playable",
            `parent patch ${parent.patchVersionId} is not playable`,
          );
        }
        const parentUnit = parent.units.find((unit) => unit.bridgeUnitId === input.bridgeUnitId);
        if (parentUnit === undefined) {
          throw new LocalizationResultRevisionRepositoryError(
            "unit_not_in_patch",
            `bridge unit ${input.bridgeUnitId} is not a member of patch ${parent.patchVersionId}`,
          );
        }

        const bodyDigest = sha256Hex(targetBody).slice(0, 16);
        const childPatchVersionId = playTesterChildPatchVersionId(
          parent.patchVersionId,
          input.bridgeUnitId,
          bodyDigest,
        );
        const resultRevisionId = playTesterResultRevisionId(
          parentUnit.resultRevisionId,
          bodyDigest,
        );

        const existingChild = await loadPatchWithUnitsInTx(tx, childPatchVersionId);
        if (existingChild !== null) {
          const existingRevision = await loadRevisionInTx(tx, resultRevisionId);
          if (existingRevision === null) {
            throw new LocalizationResultRevisionRepositoryError(
              "artifact_fault",
              `child patch ${childPatchVersionId} exists without its result revision ${resultRevisionId}`,
            );
          }
          try {
            // A content-addressed replay must not make a damaged historical
            // delivery selected again. Verify before changing selection so a
            // missing/tampered artifact leaves the previously selected patch
            // exactly as it was.
            verifyLocalizationArtifactManifest(
              existingChild.artifactRefs,
              existingChild.artifactHashes,
            );
          } catch (error) {
            throw new LocalizationResultRevisionRepositoryError(
              "artifact_fault",
              `existing child patch ${childPatchVersionId} artifact verification failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
          // Re-select the existing child so export always reflects this edit.
          await selectPatchInTx(tx, parent.runId, childPatchVersionId);
          const reloaded = await loadPatchWithUnitsInTx(tx, childPatchVersionId);
          if (reloaded === null || reloaded.status !== "playable" || reloaded.selectedAt === null) {
            throw new LocalizationResultRevisionRepositoryError(
              "artifact_fault",
              `failed to re-select existing child patch ${childPatchVersionId}`,
            );
          }
          const edit = {
            resultRevision: revisionRecordFromRow(existingRevision),
            patchVersion: childPatchRecordFromLoaded(reloaded, actorUserId),
            idempotentReplay: true,
          };
          return { edit, feedback: await recordLinkedFeedback(edit) };
        }

        const childUnits = parent.units.map((unit) =>
          unit.bridgeUnitId === input.bridgeUnitId
            ? {
                ...unit,
                resultRevisionId,
                targetBody,
                memberOrigin: "play_tester_edit" as const,
                reusedFromPatchVersionId: parent.patchVersionId,
              }
            : unit,
        );

        // The native patcher is run while this parent lineage lock is held.
        // The transaction is the commit point: any error after the materializer
        // returns is caught below and removes its owned output tree.
        materialized = await this.patchArtifactMaterializer.materialize({
          childPatchVersionId,
          parentPatchVersionId: parent.patchVersionId,
          runId: parentUnit.sourceRunId,
          bridgeUnitId: input.bridgeUnitId,
          targetBody,
          parentArtifactRefs: { ...parent.artifactRefs },
          parentArtifactHashes: { ...parent.artifactHashes },
        });

        const now = new Date();
        await tx.insert(localizationResultRevisions).values({
          resultRevisionId,
          journalOutcomeId: parentUnit.journalOutcomeId,
          // A refinement patch may carry an immutable result forward from an
          // earlier source run. Result revisions remain bound to the outcome
          // they derive from, rather than the later patch-owning run.
          runId: parentUnit.sourceRunId,
          bridgeUnitId: input.bridgeUnitId,
          selectedCandidateId: parentUnit.selectedCandidateId,
          targetBody,
          origin: "play_tester_edit",
          parentRevisionId: parentUnit.resultRevisionId,
          actorUserId,
          createdForPatchVersionId: childPatchVersionId,
          createdAt: now,
        });

        await tx.insert(localizationPatchVersions).values({
          patchVersionId: childPatchVersionId,
          runId: parent.runId,
          status: "building",
          artifactHashes: materialized.artifactHashes,
          artifactRefs: materialized.artifactRefs,
          playableAt: null,
          parentPatchVersionId: parent.patchVersionId,
          origin: "play_tester_edit",
          actorUserId,
          selectedAt: null,
          createdAt: now,
          updatedAt: now,
        });

        await tx.insert(localizationPatchVersionUnits).values(
          childUnits.map((unit) => ({
            patchVersionId: childPatchVersionId,
            runId: parent.runId,
            sourceRunId: unit.sourceRunId,
            bridgeUnitId: unit.bridgeUnitId,
            journalOutcomeId: unit.journalOutcomeId,
            resultRevisionId: unit.resultRevisionId,
            memberOrigin: unit.memberOrigin,
            reusedFromPatchVersionId: unit.reusedFromPatchVersionId,
            unitOrdinal: unit.unitOrdinal,
            createdAt: now,
          })),
        );

        try {
          verifyLocalizationArtifactManifest(
            materialized.artifactRefs,
            materialized.artifactHashes,
          );
        } catch (error) {
          throw new LocalizationResultRevisionRepositoryError(
            "artifact_fault",
            `child patch ${childPatchVersionId} artifact verification failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }

        await tx
          .update(localizationPatchVersions)
          .set({ selectedAt: null, updatedAt: now })
          .where(
            and(
              eq(localizationPatchVersions.runId, parent.runId),
              isNotNull(localizationPatchVersions.selectedAt),
            ),
          );

        await tx
          .update(localizationPatchVersions)
          .set({
            status: "playable",
            playableAt: now,
            selectedAt: now,
            updatedAt: now,
          })
          .where(eq(localizationPatchVersions.patchVersionId, childPatchVersionId));

        const committedRevision = await loadRevisionInTx(tx, resultRevisionId);
        const committedPatch = await loadPatchWithUnitsInTx(tx, childPatchVersionId);
        if (
          committedRevision === null ||
          committedPatch === null ||
          committedPatch.status !== "playable" ||
          committedPatch.selectedAt === null
        ) {
          throw new LocalizationResultRevisionRepositoryError(
            "artifact_fault",
            `atomic play-tester edit for ${childPatchVersionId} did not leave a playable selected child`,
          );
        }

        const edit = {
          resultRevision: revisionRecordFromRow(committedRevision),
          patchVersion: childPatchRecordFromLoaded(committedPatch, actorUserId),
          idempotentReplay: false,
        };
        return { edit, feedback: await recordLinkedFeedback(edit) };
      });
      committed = true;
      return result;
    } catch (error) {
      if (!committed && materialized !== undefined) {
        try {
          await materialized.cleanup();
        } catch (cleanupError) {
          throw new LocalizationResultRevisionRepositoryError(
            "artifact_fault",
            `play-tester edit rolled back but its patch artifact cleanup failed: ${
              cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
            }`,
          );
        }
      }
      throw error;
    }
  }

  async loadSelectedPatchExport(
    actor: AuthorizationActor,
    input: { runId?: string; patchVersionId?: string },
  ): Promise<SelectedPatchExport | null> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    if (input.patchVersionId !== undefined) {
      assertNonBlank(input.patchVersionId, "patchVersionId");
      const loaded = await loadPatchWithUnitsInTx(this.db, input.patchVersionId);
      if (loaded === null || loaded.selectedAt === null) return null;
      return selectedExportFromLoaded(loaded);
    }
    if (input.runId === undefined || input.runId.trim().length === 0) {
      throw new LocalizationResultRevisionRepositoryError(
        "invalid_input",
        "loadSelectedPatchExport requires runId or patchVersionId",
      );
    }
    const rows = await this.db
      .select()
      .from(localizationPatchVersions)
      .where(
        and(
          eq(localizationPatchVersions.runId, input.runId),
          isNotNull(localizationPatchVersions.selectedAt),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    const loaded = await loadPatchWithUnitsInTx(this.db, row.patchVersionId);
    return loaded === null ? null : selectedExportFromLoaded(loaded);
  }

  async loadPlayablePatchExport(
    actor: AuthorizationActor,
    input: { patchVersionId: string },
  ): Promise<PlayablePatchExport | null> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    assertNonBlank(input.patchVersionId, "patchVersionId");
    const loaded = await loadPatchWithUnitsInTx(this.db, input.patchVersionId);
    if (loaded === null || loaded.status !== "playable" || loaded.playableAt === null) {
      return null;
    }
    return playableExportFromLoaded(loaded);
  }
}

type LoadedPatch = {
  patchVersionId: string;
  runId: string;
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
  units: Array<{
    bridgeUnitId: string;
    sourceRunId: string;
    journalOutcomeId: string;
    resultRevisionId: string;
    memberOrigin: "run_written_outcome" | "reused_from_base" | "play_tester_edit";
    reusedFromPatchVersionId: string | null;
    unitOrdinal: number;
    targetBody: string;
    selectedCandidateId: string;
    origin: string;
    actorUserId: string | null;
  }>;
};

async function loadPatchWithUnitsInTx(
  db: Pick<ItotoriDatabase, "select"> | Tx,
  patchVersionId: string,
): Promise<LoadedPatch | null> {
  const patchRows = await db
    .select()
    .from(localizationPatchVersions)
    .where(eq(localizationPatchVersions.patchVersionId, patchVersionId))
    .limit(1);
  const patch = patchRows[0];
  if (patch === undefined) return null;

  const memberRows = await db
    .select({
      bridgeUnitId: localizationPatchVersionUnits.bridgeUnitId,
      sourceRunId: localizationPatchVersionUnits.sourceRunId,
      journalOutcomeId: localizationPatchVersionUnits.journalOutcomeId,
      resultRevisionId: localizationPatchVersionUnits.resultRevisionId,
      memberOrigin: localizationPatchVersionUnits.memberOrigin,
      reusedFromPatchVersionId: localizationPatchVersionUnits.reusedFromPatchVersionId,
      unitOrdinal: localizationPatchVersionUnits.unitOrdinal,
      targetBody: localizationResultRevisions.targetBody,
      selectedCandidateId: localizationResultRevisions.selectedCandidateId,
      origin: localizationResultRevisions.origin,
      actorUserId: localizationResultRevisions.actorUserId,
    })
    .from(localizationPatchVersionUnits)
    .innerJoin(
      localizationResultRevisions,
      and(
        eq(
          localizationResultRevisions.resultRevisionId,
          localizationPatchVersionUnits.resultRevisionId,
        ),
        eq(
          localizationResultRevisions.journalOutcomeId,
          localizationPatchVersionUnits.journalOutcomeId,
        ),
        eq(localizationResultRevisions.runId, localizationPatchVersionUnits.sourceRunId),
        eq(localizationResultRevisions.bridgeUnitId, localizationPatchVersionUnits.bridgeUnitId),
      ),
    )
    .where(eq(localizationPatchVersionUnits.patchVersionId, patchVersionId))
    .orderBy(asc(localizationPatchVersionUnits.unitOrdinal));

  return {
    patchVersionId: patch.patchVersionId,
    runId: patch.runId,
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
    units: memberRows.map((row) => ({
      bridgeUnitId: row.bridgeUnitId,
      sourceRunId: row.sourceRunId,
      journalOutcomeId: row.journalOutcomeId,
      resultRevisionId: row.resultRevisionId,
      memberOrigin: row.memberOrigin,
      reusedFromPatchVersionId: row.reusedFromPatchVersionId ?? null,
      unitOrdinal: row.unitOrdinal,
      targetBody: row.targetBody,
      selectedCandidateId: row.selectedCandidateId,
      origin: row.origin,
      actorUserId: row.actorUserId ?? null,
    })),
  };
}

async function loadRevisionInTx(
  db: Pick<ItotoriDatabase, "select"> | Tx,
  resultRevisionId: string,
): Promise<typeof localizationResultRevisions.$inferSelect | null> {
  const rows = await db
    .select()
    .from(localizationResultRevisions)
    .where(eq(localizationResultRevisions.resultRevisionId, resultRevisionId))
    .limit(1);
  return rows[0] ?? null;
}

async function selectPatchInTx(tx: Tx, runId: string, patchVersionId: string): Promise<void> {
  const now = new Date();
  await tx
    .update(localizationPatchVersions)
    .set({ selectedAt: null, updatedAt: now })
    .where(
      and(
        eq(localizationPatchVersions.runId, runId),
        isNotNull(localizationPatchVersions.selectedAt),
      ),
    );
  await tx
    .update(localizationPatchVersions)
    .set({ selectedAt: now, updatedAt: now })
    .where(eq(localizationPatchVersions.patchVersionId, patchVersionId));
}

function revisionRecordFromRow(
  row: typeof localizationResultRevisions.$inferSelect,
): PlayTesterResultRevisionRecord {
  if (row.origin !== "play_tester_edit") {
    throw new LocalizationResultRevisionRepositoryError(
      "artifact_fault",
      `expected play_tester_edit revision, got ${row.origin}`,
    );
  }
  if (
    row.parentRevisionId === null ||
    row.actorUserId === null ||
    row.createdForPatchVersionId === null
  ) {
    throw new LocalizationResultRevisionRepositoryError(
      "artifact_fault",
      `play_tester_edit revision ${row.resultRevisionId} missing provenance`,
    );
  }
  return {
    resultRevisionId: row.resultRevisionId,
    journalOutcomeId: row.journalOutcomeId,
    runId: row.runId,
    bridgeUnitId: row.bridgeUnitId,
    selectedCandidateId: row.selectedCandidateId,
    targetBody: row.targetBody,
    origin: "play_tester_edit",
    parentRevisionId: row.parentRevisionId,
    actorUserId: row.actorUserId,
    createdForPatchVersionId: row.createdForPatchVersionId,
    createdAt: row.createdAt,
  };
}

function childPatchRecordFromLoaded(
  loaded: LoadedPatch,
  actorUserId: string,
): PlayTesterChildPatchVersionRecord {
  if (
    loaded.parentPatchVersionId === null ||
    loaded.playableAt === null ||
    loaded.selectedAt === null
  ) {
    throw new LocalizationResultRevisionRepositoryError(
      "artifact_fault",
      `child patch ${loaded.patchVersionId} missing playable/selected/parent fields`,
    );
  }
  return {
    patchVersionId: loaded.patchVersionId,
    runId: loaded.runId,
    parentPatchVersionId: loaded.parentPatchVersionId,
    status: "playable",
    origin: "play_tester_edit",
    actorUserId: loaded.actorUserId ?? actorUserId,
    artifactHashes: loaded.artifactHashes,
    artifactRefs: loaded.artifactRefs,
    playableAt: loaded.playableAt,
    selectedAt: loaded.selectedAt,
    createdAt: loaded.createdAt,
    updatedAt: loaded.updatedAt,
    units: loaded.units.map((unit) => ({
      bridgeUnitId: unit.bridgeUnitId,
      sourceRunId: unit.sourceRunId,
      journalOutcomeId: unit.journalOutcomeId,
      resultRevisionId: unit.resultRevisionId,
      memberOrigin: unit.memberOrigin,
      reusedFromPatchVersionId: unit.reusedFromPatchVersionId,
      unitOrdinal: unit.unitOrdinal,
      targetBody: unit.targetBody,
    })),
  };
}

function selectedExportFromLoaded(loaded: LoadedPatch): SelectedPatchExport {
  if (loaded.selectedAt === null) {
    throw new LocalizationResultRevisionRepositoryError(
      "artifact_fault",
      `patch ${loaded.patchVersionId} is not selected`,
    );
  }
  return {
    ...playableExportFromLoaded(loaded),
    selectedAt: loaded.selectedAt,
  };
}

function playableExportFromLoaded(loaded: LoadedPatch): PlayablePatchExport {
  return {
    patchVersionId: loaded.patchVersionId,
    runId: loaded.runId,
    parentPatchVersionId: loaded.parentPatchVersionId,
    origin: loaded.origin,
    actorUserId: loaded.actorUserId,
    status: loaded.status,
    selectedAt: loaded.selectedAt,
    playableAt: loaded.playableAt,
    artifactHashes: loaded.artifactHashes,
    artifactRefs: loaded.artifactRefs,
    units: loaded.units.map((unit) => ({
      bridgeUnitId: unit.bridgeUnitId,
      sourceRunId: unit.sourceRunId,
      journalOutcomeId: unit.journalOutcomeId,
      resultRevisionId: unit.resultRevisionId,
      memberOrigin: unit.memberOrigin,
      reusedFromPatchVersionId: unit.reusedFromPatchVersionId,
      unitOrdinal: unit.unitOrdinal,
      targetBody: unit.targetBody,
      origin: unit.origin,
      actorUserId: unit.actorUserId,
    })),
  };
}

export function playTesterChildPatchVersionId(
  parentPatchVersionId: string,
  bridgeUnitId: string,
  bodyDigest: string,
): string {
  return `patch-version:${parentPatchVersionId}:edit:${bridgeUnitId}:${bodyDigest}`;
}

export function playTesterResultRevisionId(parentRevisionId: string, bodyDigest: string): string {
  return `play-tester-result:${parentRevisionId}:${bodyDigest}`;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Keep the atomic mutation safe for JavaScript/untyped callers as well as
 * typed service callers. The feedback object is mandatory: a missing value
 * must fail before the transaction can select a child patch.
 */
function requireAtomicFeedbackInput(
  input: ApplyPlayTesterTargetEditWithFeedbackInput,
): ApplyPlayTesterTargetEditWithFeedbackInput["feedback"] {
  const feedback = (input as { feedback?: unknown }).feedback;
  if (typeof feedback !== "object" || feedback === null || Array.isArray(feedback)) {
    throw new LocalizationResultRevisionRepositoryError(
      "invalid_input",
      "atomic play-tester target edit requires a feedback object",
    );
  }
  return feedback as ApplyPlayTesterTargetEditWithFeedbackInput["feedback"];
}

function assertNonBlank(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new LocalizationResultRevisionRepositoryError(
      "invalid_input",
      `${label} must be non-blank`,
    );
  }
}
