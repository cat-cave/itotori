import { and, asc, eq, isNotNull } from "drizzle-orm";
import type { ItotoriDatabase } from "../connection.js";
import {
  localizationPatchVersionUnits,
  localizationPatchVersions,
  patchOutputRevisions,
} from "../schema.js";
import {
  LocalizationResultRevisionRepositoryError,
  type ApplyPlayTesterTargetEditResult,
  type SelectedPatchExport,
  type SelectedPatchExportUnit,
} from "./localization-result-revision-repository-contracts.js";

export type Tx = Parameters<Parameters<ItotoriDatabase["transaction"]>[0]>[0];

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

export async function loadPatch(
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

export async function loadSelectedByScope(
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

export async function selectPatch(
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

export function selectedExport(patch: LoadedPatch): SelectedPatchExport {
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

export function childResult(
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

export function requireText(value: string | undefined, field: string): string {
  if (value === undefined || value.trim().length === 0)
    throw new LocalizationResultRevisionRepositoryError(
      "invalid_input",
      `${field} must be non-blank`,
    );
  return value;
}
