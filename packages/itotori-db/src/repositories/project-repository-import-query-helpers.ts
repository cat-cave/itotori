import * as deps from "./project-repository-dependencies.js";
import * as api from "./project-repository-types.js";
import * as helpers from "./project-repository-helpers.js";

export type ItotoriTransaction = Parameters<Parameters<deps.ItotoriDatabase["transaction"]>[0]>[0];
export type ExistingSourceRevision = typeof deps.sourceRevisions.$inferSelect;
export type ExistingAsset = typeof deps.assets.$inferSelect;
export type ExistingSourceUnit = typeof deps.sourceUnits.$inferSelect;

export type IndexedImportDiff = api.BridgeImportDiffCounts & {
  removedIds: string[];
};

export type SourceBundleImportDiff = {
  sourceRevisions: api.BridgeImportRevisionDiffCounts;
  assets: helpers.IndexedImportDiff;
  units: helpers.IndexedImportDiff;
};

export type NormalizedSourceBundle = {
  sourceBundleId: string;
  bridgeId: string;
  schemaVersion: string;
  sourceBundleHash: string;
  sourceBundleRevision: deps.SourceRevisionV02;
  sourceLocale: string;
  sourceGame: {
    gameId: string | null;
    gameVersion: string | null;
    sourceProfileId: string | null;
  };
  extractor: { name: string; version: string };
  revisions: deps.SourceRevisionV02[];
  assets: deps.BridgeAssetV02[];
  units: deps.LocalizationUnitV02[];
};

export async function resolveSourceBundleImportTarget(
  tx: helpers.ItotoriTransaction,
  projectId: string,
  normalized: helpers.NormalizedSourceBundle,
): Promise<helpers.NormalizedSourceBundle> {
  const [sourceBundleMatch] = await tx
    .select({
      sourceBundleId: deps.sourceBundles.sourceBundleId,
      projectId: deps.sourceBundles.projectId,
      bridgeId: deps.sourceBundles.bridgeId,
    })
    .from(deps.sourceBundles)
    .where(deps.eq(deps.sourceBundles.sourceBundleId, normalized.sourceBundleId))
    .limit(1);

  if (sourceBundleMatch !== undefined) {
    if (sourceBundleMatch.projectId !== projectId) {
      throw new Error(
        `source bundle ${normalized.sourceBundleId} already belongs to project ${sourceBundleMatch.projectId}`,
      );
    }
    if (sourceBundleMatch.bridgeId !== normalized.bridgeId) {
      throw new Error(
        `source bundle ${normalized.sourceBundleId} already belongs to bridge ${sourceBundleMatch.bridgeId}`,
      );
    }
  }

  const [bridgeMatch] = await tx
    .select({
      sourceBundleId: deps.sourceBundles.sourceBundleId,
      projectId: deps.sourceBundles.projectId,
      bridgeId: deps.sourceBundles.bridgeId,
    })
    .from(deps.sourceBundles)
    .where(deps.eq(deps.sourceBundles.bridgeId, normalized.bridgeId))
    .limit(1);

  if (bridgeMatch === undefined) {
    return normalized;
  }
  if (bridgeMatch.projectId !== projectId) {
    throw new Error(
      `bridge ${normalized.bridgeId} already belongs to project ${bridgeMatch.projectId}`,
    );
  }
  if (
    sourceBundleMatch !== undefined &&
    sourceBundleMatch.sourceBundleId !== bridgeMatch.sourceBundleId
  ) {
    throw new Error(
      `bridge ${normalized.bridgeId} is already linked to source bundle ${bridgeMatch.sourceBundleId}`,
    );
  }
  if (bridgeMatch.sourceBundleId === normalized.sourceBundleId) {
    return normalized;
  }
  return { ...normalized, sourceBundleId: bridgeMatch.sourceBundleId };
}

export async function assertImportOwnership(
  tx: helpers.ItotoriTransaction,
  projectId: string,
  normalized: helpers.NormalizedSourceBundle,
): Promise<void> {
  helpers.assertUniqueNormalizedUnitIds(normalized.units);
  await helpers.assertStableSourceUnitKeys(tx, normalized);

  const revisionIds = normalized.revisions.map((revisionRecord) => revisionRecord.revisionId);
  if (revisionIds.length > 0) {
    for (const revisionIdBatch of helpers.inArrayBatches(revisionIds)) {
      const revisionRows = await tx
        .select({
          sourceRevisionId: deps.sourceRevisions.sourceRevisionId,
          projectId: deps.sourceRevisions.projectId,
        })
        .from(deps.sourceRevisions)
        .where(deps.inArray(deps.sourceRevisions.sourceRevisionId, revisionIdBatch));
      for (const row of revisionRows) {
        if (row.projectId !== projectId) {
          throw new Error(
            `source helpers.revision ${row.sourceRevisionId} already belongs to project ${row.projectId}`,
          );
        }
      }
    }
  }

  const assetIds = normalized.assets.map((asset) => asset.assetId);
  if (assetIds.length > 0) {
    for (const assetIdBatch of helpers.inArrayBatches(assetIds)) {
      const assetRows = await tx
        .select({
          assetId: deps.assets.assetId,
          projectId: deps.assets.projectId,
          sourceBundleId: deps.assets.sourceBundleId,
        })
        .from(deps.assets)
        .where(deps.inArray(deps.assets.assetId, assetIdBatch));
      for (const row of assetRows) {
        if (row.projectId !== projectId || row.sourceBundleId !== normalized.sourceBundleId) {
          throw new Error(
            `asset ${row.assetId} already belongs to project ${row.projectId} source bundle ${row.sourceBundleId}`,
          );
        }
      }
    }
  }

  const bridgeUnitIds = normalized.units.map((unit) => unit.bridgeUnitId);
  if (bridgeUnitIds.length > 0) {
    for (const bridgeUnitIdBatch of helpers.inArrayBatches(bridgeUnitIds)) {
      const unitRows = await tx
        .select({
          bridgeUnitId: deps.sourceUnits.bridgeUnitId,
          projectId: deps.sourceUnits.projectId,
          sourceBundleId: deps.sourceUnits.sourceBundleId,
        })
        .from(deps.sourceUnits)
        .where(deps.inArray(deps.sourceUnits.bridgeUnitId, bridgeUnitIdBatch));
      for (const row of unitRows) {
        if (row.projectId !== projectId || row.sourceBundleId !== normalized.sourceBundleId) {
          throw new Error(
            `bridge unit ${row.bridgeUnitId} already belongs to project ${row.projectId} source bundle ${row.sourceBundleId}`,
          );
        }
      }
    }
  }
}
