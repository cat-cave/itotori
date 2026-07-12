// p0-core-result-revision-hitl — play-tester target edit → result revision +
// child delivered patch revision, atomically, with real actor provenance.
//
// A play tester (no source-language knowledge required) edits one delivered
// TARGET line. This repository:
//   1. creates a play_tester_edit LocalizedResultRevision (parent-linked)
//   2. creates a child delivered PatchVersion whose membership is the parent
//      membership with that unit swapped to the new revision
//   3. writes real patch artifact bytes + hashes
//   4. marks the child playable and CURRENT SELECTED for export
// all in ONE transaction. A failure leaves no partial revision or selection.
//
// Export reads the currently selected patch. There is no approval/reviewer
// state gate — selection moves with the edit.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import type { ItotoriDatabase } from "../connection.js";
import {
  hashLocalizationArtifact,
  verifyLocalizationArtifactManifest,
} from "../localization-artifact-integrity.js";
import {
  localizationPatchVersionUnits,
  localizationPatchVersions,
  localizationResultRevisions,
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
  units: Array<{
    bridgeUnitId: string;
    journalOutcomeId: string;
    resultRevisionId: string;
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
  /**
   * Directory that will own the delivered patch artifact tree for this child.
   * The repository writes real bytes here and stores their hashes on the
   * patch version row.
   */
  artifactRootDir: string;
};

export type ApplyPlayTesterTargetEditResult = {
  resultRevision: PlayTesterResultRevisionRecord;
  patchVersion: PlayTesterChildPatchVersionRecord;
  /** True when the same edit was already committed (content-addressed id). */
  idempotentReplay: boolean;
};

export type SelectedPatchExportUnit = {
  bridgeUnitId: string;
  journalOutcomeId: string;
  resultRevisionId: string;
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
  loadSelectedPatchExport(
    actor: AuthorizationActor,
    input: { runId?: string; patchVersionId?: string },
  ): Promise<SelectedPatchExport | null>;
}

type Tx = Parameters<Parameters<ItotoriDatabase["transaction"]>[0]>[0];

/**
 * Durable play-tester result-revision + child patch-revision mutation seam.
 * Writes require draft.write; export reads require catalog.read.
 */
export class ItotoriLocalizationResultRevisionRepository implements ItotoriLocalizationResultRevisionRepositoryPort {
  constructor(private readonly db: ItotoriDatabase) {}

  async applyPlayTesterTargetEdit(
    actor: AuthorizationActor,
    input: ApplyPlayTesterTargetEditInput,
  ): Promise<ApplyPlayTesterTargetEditResult> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);
    assertNonBlank(input.bridgeUnitId, "bridgeUnitId");
    assertNonBlank(input.artifactRootDir, "artifactRootDir");
    const targetBody = input.targetBody;
    if (targetBody.trim().length === 0) {
      throw new LocalizationResultRevisionRepositoryError(
        "blank_target",
        "play-tester target edit requires non-blank target text",
      );
    }
    const actorUserId = actor.userId;
    assertNonBlank(actorUserId, "actor.userId");

    // Resolve parent + materialize delivered bytes OUTSIDE the transaction so
    // a failed DB write never leaves a partial revision, and so the transaction
    // only commits after real patch bytes + hashes exist.
    assertNonBlank(input.parentPatchVersionId, "parentPatchVersionId");
    const parent = await this.resolveParentPatch(input.parentPatchVersionId);
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
    const resultRevisionId = playTesterResultRevisionId(parentUnit.resultRevisionId, bodyDigest);

    const childUnits = parent.units.map((unit) =>
      unit.bridgeUnitId === input.bridgeUnitId
        ? {
            ...unit,
            resultRevisionId,
            targetBody,
          }
        : unit,
    );
    const artifact = writeDeliveredPatchArtifact({
      artifactRootDir: input.artifactRootDir,
      patchVersionId: childPatchVersionId,
      parentPatchVersionId: parent.patchVersionId,
      runId: parent.runId,
      actorUserId,
      units: childUnits.map((unit) => ({
        bridgeUnitId: unit.bridgeUnitId,
        resultRevisionId: unit.resultRevisionId,
        unitOrdinal: unit.unitOrdinal,
        targetBody: unit.targetBody,
      })),
    });

    return this.db.transaction(async (tx) => {
      // Serialize against concurrent edits on the same parent lineage.
      await tx.execute(sql`
        select patch_version_id
        from itotori_localization_patch_versions
        where patch_version_id = ${parent.patchVersionId}
        for update
      `);

      const existingChild = await loadPatchWithUnitsInTx(tx, childPatchVersionId);
      if (existingChild !== null) {
        const existingRevision = await loadRevisionInTx(tx, resultRevisionId);
        if (existingRevision === null) {
          throw new LocalizationResultRevisionRepositoryError(
            "artifact_fault",
            `child patch ${childPatchVersionId} exists without its result revision ${resultRevisionId}`,
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
        return {
          resultRevision: revisionRecordFromRow(existingRevision),
          patchVersion: childPatchRecordFromLoaded(reloaded, actorUserId),
          idempotentReplay: true,
        };
      }

      const parentFresh = await loadPatchWithUnitsInTx(tx, parent.patchVersionId);
      if (parentFresh === null || parentFresh.status !== "playable") {
        throw new LocalizationResultRevisionRepositoryError(
          "patch_not_playable",
          `parent patch ${parent.patchVersionId} is not playable`,
        );
      }

      const now = new Date();
      await tx.insert(localizationResultRevisions).values({
        resultRevisionId,
        journalOutcomeId: parentUnit.journalOutcomeId,
        runId: parent.runId,
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
        artifactHashes: artifact.artifactHashes,
        artifactRefs: artifact.artifactRefs,
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
          bridgeUnitId: unit.bridgeUnitId,
          journalOutcomeId: unit.journalOutcomeId,
          resultRevisionId: unit.resultRevisionId,
          unitOrdinal: unit.unitOrdinal,
          createdAt: now,
        })),
      );

      try {
        verifyLocalizationArtifactManifest(artifact.artifactRefs, artifact.artifactHashes);
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

      return {
        resultRevision: revisionRecordFromRow(committedRevision),
        patchVersion: childPatchRecordFromLoaded(committedPatch, actorUserId),
        idempotentReplay: false,
      };
    });
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
      return exportFromLoaded(loaded);
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
    return loaded === null ? null : exportFromLoaded(loaded);
  }

  private async resolveParentPatch(parentPatchVersionId: string): Promise<LoadedPatch> {
    const loaded = await loadPatchWithUnitsInTx(this.db, parentPatchVersionId);
    if (loaded === null) {
      throw new LocalizationResultRevisionRepositoryError(
        "patch_not_found",
        `parent patch ${parentPatchVersionId} does not exist`,
      );
    }
    if (loaded.status !== "playable") {
      throw new LocalizationResultRevisionRepositoryError(
        "patch_not_playable",
        `parent patch ${parentPatchVersionId} is not playable`,
      );
    }
    return loaded;
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
    journalOutcomeId: string;
    resultRevisionId: string;
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
      journalOutcomeId: localizationPatchVersionUnits.journalOutcomeId,
      resultRevisionId: localizationPatchVersionUnits.resultRevisionId,
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
        eq(localizationResultRevisions.runId, localizationPatchVersionUnits.runId),
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
      journalOutcomeId: row.journalOutcomeId,
      resultRevisionId: row.resultRevisionId,
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
      journalOutcomeId: unit.journalOutcomeId,
      resultRevisionId: unit.resultRevisionId,
      unitOrdinal: unit.unitOrdinal,
      targetBody: unit.targetBody,
    })),
  };
}

function exportFromLoaded(loaded: LoadedPatch): SelectedPatchExport {
  if (loaded.selectedAt === null) {
    throw new LocalizationResultRevisionRepositoryError(
      "artifact_fault",
      `patch ${loaded.patchVersionId} is not selected`,
    );
  }
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
      journalOutcomeId: unit.journalOutcomeId,
      resultRevisionId: unit.resultRevisionId,
      unitOrdinal: unit.unitOrdinal,
      targetBody: unit.targetBody,
      origin: unit.origin,
      actorUserId: unit.actorUserId,
    })),
  };
}

function writeDeliveredPatchArtifact(input: {
  artifactRootDir: string;
  patchVersionId: string;
  parentPatchVersionId: string;
  runId: string;
  actorUserId: string;
  units: Array<{
    bridgeUnitId: string;
    resultRevisionId: string;
    unitOrdinal: number;
    targetBody: string;
  }>;
}): { artifactRefs: Record<string, string>; artifactHashes: Record<string, string> } {
  const root = join(input.artifactRootDir, sanitizePathSegment(input.patchVersionId));
  mkdirSync(root, { recursive: true });
  const payloadPath = join(root, "delivered-units.json");
  const payload = {
    schemaVersion: "itotori.play-tester-delivered-patch.v0.1",
    patchVersionId: input.patchVersionId,
    parentPatchVersionId: input.parentPatchVersionId,
    runId: input.runId,
    actorUserId: input.actorUserId,
    units: input.units
      .slice()
      .sort((a, b) => a.unitOrdinal - b.unitOrdinal)
      .map((unit) => ({
        bridgeUnitId: unit.bridgeUnitId,
        resultRevisionId: unit.resultRevisionId,
        unitOrdinal: unit.unitOrdinal,
        targetBody: unit.targetBody,
      })),
  };
  writeFileSync(payloadPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  const unitsDir = join(root, "units");
  mkdirSync(unitsDir, { recursive: true });
  for (const unit of input.units) {
    const unitPath = join(unitsDir, `${sanitizePathSegment(unit.bridgeUnitId)}.txt`);
    mkdirSync(dirname(unitPath), { recursive: true });
    writeFileSync(unitPath, unit.targetBody, "utf8");
  }
  const artifactRefs = {
    delivered_bundle: root,
  };
  const artifactHashes = {
    delivered_bundle: hashLocalizationArtifact(root),
  };
  return { artifactRefs, artifactHashes };
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

function sanitizePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._:-]+/g, "_");
}

function assertNonBlank(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new LocalizationResultRevisionRepositoryError(
      "invalid_input",
      `${label} must be non-blank`,
    );
  }
}
