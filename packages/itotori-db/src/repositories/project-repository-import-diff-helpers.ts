import * as deps from "./project-repository-dependencies.js";
import * as api from "./project-repository-types.js";
import * as helpers from "./project-repository-helpers.js";

export function assertUniqueNormalizedUnitIds(units: deps.LocalizationUnitV02[]): void {
  const bridgeUnitIds = new Set<string>();
  const sourceUnitKeys = new Set<string>();
  for (const unit of units) {
    if (bridgeUnitIds.has(unit.bridgeUnitId)) {
      throw new Error(`bridgeUnitId ${unit.bridgeUnitId} must be unique within the import`);
    }
    bridgeUnitIds.add(unit.bridgeUnitId);
    if (sourceUnitKeys.has(unit.sourceUnitKey)) {
      throw new Error(`sourceUnitKey ${unit.sourceUnitKey} must be unique within the import`);
    }
    sourceUnitKeys.add(unit.sourceUnitKey);
  }
}

export async function assertStableSourceUnitKeys(
  tx: helpers.ItotoriTransaction,
  normalized: helpers.NormalizedSourceBundle,
): Promise<void> {
  const incomingBySourceUnitKey = new Map(
    normalized.units.map((unit) => [unit.sourceUnitKey, unit]),
  );
  const sourceUnitKeys = [...incomingBySourceUnitKey.keys()];
  if (sourceUnitKeys.length === 0) {
    return;
  }

  for (const sourceUnitKeyBatch of helpers.inArrayBatches(sourceUnitKeys)) {
    const unitRows = await tx
      .select({
        bridgeUnitId: deps.sourceUnits.bridgeUnitId,
        sourceUnitKey: deps.sourceUnits.sourceUnitKey,
      })
      .from(deps.sourceUnits)
      .where(
        deps.and(
          deps.eq(deps.sourceUnits.sourceBundleId, normalized.sourceBundleId),
          deps.inArray(deps.sourceUnits.sourceUnitKey, sourceUnitKeyBatch),
        ),
      );

    for (const row of unitRows) {
      const incoming = incomingBySourceUnitKey.get(row.sourceUnitKey);
      if (incoming !== undefined && incoming.bridgeUnitId !== row.bridgeUnitId) {
        throw new Error(
          `sourceUnitKey ${row.sourceUnitKey} is already linked to bridgeUnitId ${row.bridgeUnitId}; reimport cannot change it to ${incoming.bridgeUnitId}`,
        );
      }
    }
  }
}

const POSTGRES_IN_ARRAY_BATCH_SIZE = 10_000;

export function* inArrayBatches<T>(values: readonly T[]): Generator<readonly T[]> {
  for (let start = 0; start < values.length; start += POSTGRES_IN_ARRAY_BATCH_SIZE) {
    yield values.slice(start, start + POSTGRES_IN_ARRAY_BATCH_SIZE);
  }
}

export async function resolveSourceBundlePersistenceTarget(
  tx: helpers.ItotoriTransaction,
  project: api.ItotoriProjectRecord,
): Promise<{ sourceBundleId: string; sourceBundleRevisionId: string }> {
  if (project.importStatus !== undefined) {
    const [sourceBundle] = await tx
      .select({
        sourceBundleId: deps.sourceBundles.sourceBundleId,
        projectId: deps.sourceBundles.projectId,
        bridgeId: deps.sourceBundles.bridgeId,
      })
      .from(deps.sourceBundles)
      .where(deps.eq(deps.sourceBundles.sourceBundleId, project.importStatus.sourceBundleId))
      .limit(1);
    if (sourceBundle === undefined) {
      throw new Error(
        `source bundle ${project.importStatus.sourceBundleId} has not been imported for project ${project.projectId}`,
      );
    }
    if (sourceBundle.projectId !== project.projectId) {
      throw new Error(
        `source bundle ${sourceBundle.sourceBundleId} belongs to project ${sourceBundle.projectId}`,
      );
    }
    if (sourceBundle.bridgeId !== project.importStatus.bridgeId) {
      throw new Error(
        `source bundle ${sourceBundle.sourceBundleId} belongs to bridge ${sourceBundle.bridgeId}`,
      );
    }
    return {
      sourceBundleId: project.importStatus.sourceBundleId,
      sourceBundleRevisionId: project.importStatus.sourceBundleRevisionId,
    };
  }

  const [sourceBundle] = await tx
    .select({
      sourceBundleId: deps.sourceBundles.sourceBundleId,
      sourceBundleRevisionId: deps.sourceBundles.sourceBundleRevisionId,
    })
    .from(deps.sourceBundles)
    .where(
      deps.and(
        deps.eq(deps.sourceBundles.projectId, project.projectId),
        deps.eq(deps.sourceBundles.bridgeId, helpers.sourceBundleIdFor(project.bridge)),
      ),
    )
    .limit(1);
  if (sourceBundle === undefined) {
    throw new Error(
      `bridge ${project.bridge.bridgeId} has no imported source bundle for project ${project.projectId}`,
    );
  }
  return sourceBundle;
}

export async function diffSourceBundleImport(
  tx: helpers.ItotoriTransaction,
  normalized: helpers.NormalizedSourceBundle,
): Promise<helpers.SourceBundleImportDiff> {
  const revisionRows = [];
  for (const revisionIdBatch of inArrayBatches(
    normalized.revisions.map((revisionRecord) => revisionRecord.revisionId),
  )) {
    revisionRows.push(
      ...(await tx
        .select()
        .from(deps.sourceRevisions)
        .where(deps.inArray(deps.sourceRevisions.sourceRevisionId, revisionIdBatch))),
    );
  }
  const existingRevisions = new Map(
    revisionRows.map((revisionRecord) => [revisionRecord.sourceRevisionId, revisionRecord]),
  );
  const sourceRevisionsDiff = helpers.diffSourceRevisions(normalized.revisions, existingRevisions);

  const assetRows = await tx
    .select()
    .from(deps.assets)
    .where(deps.eq(deps.assets.sourceBundleId, normalized.sourceBundleId));
  const unitRows = await tx
    .select()
    .from(deps.sourceUnits)
    .where(deps.eq(deps.sourceUnits.sourceBundleId, normalized.sourceBundleId));

  return {
    sourceRevisions: sourceRevisionsDiff,
    assets: helpers.diffAssets(normalized.assets, assetRows),
    units: helpers.diffUnits(normalized.units, unitRows),
  };
}

export function diffSourceRevisions(
  revisions: deps.SourceRevisionV02[],
  existingRevisions: ReadonlyMap<string, helpers.ExistingSourceRevision>,
): api.BridgeImportRevisionDiffCounts {
  let added = 0;
  let existing = 0;
  for (const revisionRecord of revisions) {
    const existingRevision = existingRevisions.get(revisionRecord.revisionId);
    if (existingRevision === undefined) {
      added += 1;
      continue;
    }
    if (
      existingRevision.revisionKind !== revisionRecord.revisionKind ||
      existingRevision.value !== revisionRecord.value
    ) {
      throw new Error(
        `source revision ${revisionRecord.revisionId} already exists with different content`,
      );
    }
    existing += 1;
  }
  return { added, existing };
}

export function diffAssets(
  incomingAssets: deps.BridgeAssetV02[],
  existingAssets: helpers.ExistingAsset[],
) {
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  const incomingIds = new Set(incomingAssets.map((asset) => asset.assetId));
  const existingById = new Map(existingAssets.map((asset) => [asset.assetId, asset]));

  for (const asset of incomingAssets) {
    const existingAsset = existingById.get(asset.assetId);
    if (existingAsset === undefined) {
      added += 1;
    } else if (helpers.assetMatchesExisting(asset, existingAsset)) {
      unchanged += 1;
    } else {
      updated += 1;
    }
  }

  // Only currently-active (non-tombstoned) rows can be newly removed by this
  // reimport. Already-tombstoned rows that stay omitted are not re-counted
  // or re-touched.
  const removedIds = existingAssets
    .filter((asset) => asset.removedAt === null && !incomingIds.has(asset.assetId))
    .map((asset) => asset.assetId);
  return { added, updated, removed: removedIds.length, unchanged, removedIds };
}

export function diffUnits(
  incomingUnits: deps.LocalizationUnitV02[],
  existingUnits: helpers.ExistingSourceUnit[],
) {
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  const incomingIds = new Set(incomingUnits.map((unit) => unit.bridgeUnitId));
  const existingById = new Map(existingUnits.map((unit) => [unit.bridgeUnitId, unit]));

  for (const unit of incomingUnits) {
    const existingUnit = existingById.get(unit.bridgeUnitId);
    if (existingUnit === undefined) {
      added += 1;
    } else if (helpers.unitMatchesExisting(unit, existingUnit)) {
      unchanged += 1;
    } else {
      updated += 1;
    }
  }

  // Only currently-active (non-tombstoned) rows can be newly removed by this
  // reimport. Already-tombstoned rows that stay omitted are not re-counted
  // or re-touched.
  const removedIds = existingUnits
    .filter((unit) => unit.removedAt === null && !incomingIds.has(unit.bridgeUnitId))
    .map((unit) => unit.bridgeUnitId);
  return { added, updated, removed: removedIds.length, unchanged, removedIds };
}

export function assetMatchesExisting(
  asset: deps.BridgeAssetV02,
  existingAsset: helpers.ExistingAsset,
): boolean {
  return (
    // A tombstoned row being re-added is a state change (revive), never
    // "unchanged".
    existingAsset.removedAt === null &&
    existingAsset.sourceRevisionId === asset.sourceRevision.revisionId &&
    existingAsset.assetKey === asset.assetKey &&
    existingAsset.assetKind === asset.assetKind &&
    existingAsset.sourceHash === asset.sourceHash &&
    existingAsset.path === (asset.path ?? null)
  );
}

export function unitMatchesExisting(
  unit: deps.LocalizationUnitV02,
  existingUnit: helpers.ExistingSourceUnit,
): boolean {
  return (
    // A tombstoned row being re-added is a state change (revive), never
    // "unchanged".
    existingUnit.removedAt === null &&
    existingUnit.sourceAssetId === unit.sourceAssetRef.assetId &&
    existingUnit.sourceRevisionId === unit.sourceRevision.revisionId &&
    existingUnit.surfaceId === unit.surfaceId &&
    existingUnit.surfaceKind === unit.surfaceKind &&
    existingUnit.sourceUnitKey === unit.sourceUnitKey &&
    existingUnit.occurrenceId === unit.occurrenceId &&
    existingUnit.sourceLocale === unit.sourceLocale &&
    existingUnit.sourceText === unit.sourceText &&
    existingUnit.sourceHash === unit.sourceHash &&
    helpers.jsonEquals(existingUnit.sourceLocation, unit.sourceLocation) &&
    helpers.jsonEquals(existingUnit.speaker, unit.speaker ?? null) &&
    helpers.jsonEquals(existingUnit.context, unit.context) &&
    helpers.jsonEquals(existingUnit.policy, unit.policy ?? null) &&
    helpers.jsonEquals(existingUnit.spans, unit.spans) &&
    helpers.jsonEquals(existingUnit.patchRef, unit.patchRef) &&
    helpers.jsonEquals(existingUnit.runtimeExpectation, unit.runtimeExpectation)
  );
}

export function bridgeImportStatusFor(
  projectId: string,
  normalized: helpers.NormalizedSourceBundle,
  diff: helpers.SourceBundleImportDiff,
  importedAt: Date,
): api.BridgeImportStatus {
  return {
    bridgeImportId: helpers.bridgeImportIdFor(projectId, normalized),
    projectId,
    bridgeId: normalized.bridgeId,
    sourceBundleId: normalized.sourceBundleId,
    sourceBundleHash: normalized.sourceBundleHash,
    sourceBundleRevisionId: normalized.sourceBundleRevision.revisionId,
    schemaVersion: normalized.schemaVersion,
    sourceLocale: normalized.sourceLocale,
    importedAt: importedAt.toISOString(),
    unitCount: normalized.units.length,
    assetCount: normalized.assets.length,
    sourceRevisionCount: normalized.revisions.length,
    validationFailureCount: 0,
    units: helpers.countsOnly(diff.units),
    assets: helpers.countsOnly(diff.assets),
    sourceRevisions: diff.sourceRevisions,
    futureReferences: helpers.emptyFutureReferences(),
  };
}

export function bridgeImportStatusFromRow(row: Record<string, unknown>): api.BridgeImportStatus {
  return {
    bridgeImportId: String(row.bridge_import_id),
    projectId: String(row.project_id),
    bridgeId: String(row.bridge_id),
    sourceBundleId: String(row.import_source_bundle_id),
    sourceBundleHash: String(row.import_source_bundle_hash),
    sourceBundleRevisionId: String(row.import_source_bundle_revision_id),
    schemaVersion: String(row.import_schema_version),
    sourceLocale: String(row.import_source_locale),
    importedAt: helpers.timestampString(row.imported_at),
    unitCount: Number(row.import_unit_count),
    assetCount: Number(row.import_asset_count),
    sourceRevisionCount: Number(row.import_source_revision_count),
    validationFailureCount: Number(row.import_validation_failure_count),
    units: {
      added: Number(row.import_added_unit_count),
      updated: Number(row.import_updated_unit_count),
      removed: Number(row.import_removed_unit_count),
      unchanged: Number(row.import_unchanged_unit_count),
    },
    assets: {
      added: Number(row.import_added_asset_count),
      updated: Number(row.import_updated_asset_count),
      removed: Number(row.import_removed_asset_count),
      unchanged: Number(row.import_unchanged_asset_count),
    },
    sourceRevisions: {
      added: Number(row.import_added_source_revision_count),
      existing: Number(row.import_existing_source_revision_count),
    },
    futureReferences: {
      catalogWorkId: helpers.nullableString(row.import_catalog_work_id),
      localCorpusEntryId: helpers.nullableString(row.import_local_corpus_entry_id),
      readinessProfileId: helpers.nullableString(row.import_readiness_profile_id),
      completenessStatusId: helpers.nullableString(row.import_completeness_status_id),
    },
  };
}

export function bridgeImportIdFor(
  projectId: string,
  normalized: helpers.NormalizedSourceBundle,
): string {
  return [
    "bridge-import",
    projectId,
    normalized.sourceBundleId,
    normalized.sourceBundleRevision.revisionId,
  ].join(":");
}

export function bridgeImportMetadata(
  normalized: helpers.NormalizedSourceBundle,
): Record<string, unknown> {
  return {
    importKind: "validated_bridge_import_foundation",
    sourceGame: normalized.sourceGame,
    extractor: normalized.extractor,
    futureReferenceFields: [
      "catalogWorkId",
      "localCorpusEntryId",
      "readinessProfileId",
      "completenessStatusId",
    ],
  };
}

export function countsOnly(diff: helpers.IndexedImportDiff): api.BridgeImportDiffCounts {
  return {
    added: diff.added,
    updated: diff.updated,
    removed: diff.removed,
    unchanged: diff.unchanged,
  };
}

export function emptyFutureReferences(): api.BridgeImportFutureReferences {
  return {
    catalogWorkId: null,
    localCorpusEntryId: null,
    readinessProfileId: null,
    completenessStatusId: null,
  };
}
