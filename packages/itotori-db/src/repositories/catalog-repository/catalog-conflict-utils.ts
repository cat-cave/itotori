import {
  CatalogSource,
  ItotoriDatabase,
  catalogRawContentRedactionClassValues,
  catalogSeedTargets,
  catalogSourceProvenance,
  catalogSourceRecordKindValues,
  catalogSourceValues,
  sql,
} from "./dependencies.js";
import { CatalogJsonRecord, CatalogSourceProvenanceRecord } from "./catalog-record-types.js";
import {
  CatalogConflictReviewExactLinkRef,
  CatalogConflictReviewFuzzyScore,
  CatalogConflictReviewProvenance,
  CatalogConflictReviewSeverity,
  CatalogConflictReviewSourceId,
  CatalogSeedTargetRecord,
} from "./catalog-work-scan-types.js";
import { CatalogConflictReviewRow } from "./catalog-read-model-types.js";
import { catalogSources } from "./catalog-repository-port-and-enums.js";
import { sourceIdKey } from "./catalog-benchmark-helpers.js";
import { NormalizedSourceProvenanceInput } from "./catalog-input-normalization.js";
import { NormalizedSeedTargetInput } from "./catalog-record-input-validation.js";
import { sourceProvenanceFromRow } from "./catalog-scan-input-validation.js";
import { requiredRow, seedTargetFromRow } from "./catalog-row-mapping.js";

export function uniqueSourceIds(
  sourceIds: CatalogConflictReviewSourceId[],
): CatalogConflictReviewSourceId[] {
  const byKey = new Map<string, CatalogConflictReviewSourceId>();
  for (const sourceId of sourceIds) {
    byKey.set(`${sourceId.catalogSource}:${sourceId.sourceId}`, sourceId);
  }
  return Array.from(byKey.values()).sort((left, right) =>
    `${left.catalogSource}:${left.sourceId}`.localeCompare(
      `${right.catalogSource}:${right.sourceId}`,
    ),
  );
}

export function isPublicSourceId(sourceId: CatalogConflictReviewSourceId): boolean {
  return (
    sourceId.catalogSource !== catalogSourceValues.localCorpus &&
    !catalogPrivateSourceIdentityPatterns.some((pattern) => pattern.test(sourceId.sourceId))
  );
}

export function isPrivateSourceProvenance(
  record: CatalogSourceProvenanceRecord | typeof catalogSourceProvenance.$inferSelect,
): boolean {
  return (
    record.catalogSource === catalogSourceValues.localCorpus ||
    record.sourceRecordKind === catalogSourceRecordKindValues.localScan ||
    record.rawContentRedactionClass === catalogRawContentRedactionClassValues.privateCorpus ||
    !isPublicSourceId({
      catalogSource: record.catalogSource as CatalogSource,
      sourceId: record.sourceId,
    })
  );
}

export const catalogPrivateSourceIdentityPatterns = [
  /(?:^|[ "'=])file:/iu,
  /(?:^|[ "'=])\/(?:home|tmp|var|scratch|private)(?:\/|$)/iu,
  /[A-Z]:\\/u,
  /\.(?:zip|7z|rar|tar|gz|ks|xp3|wolf|rvdata2|rpgmvp|rpgmvm|rpgmvo)(?:$|[\\/!?#:])/iu,
  /private[-_ ](?:title|path|corpus)/iu,
  /(?:rawPayloadSecret|local-scan-entry-secret|private-story-title|private_path_hash|path_hash)/iu,
] as const;

export function countPrivateSourceIds(sourceIds: CatalogConflictReviewSourceId[]): number {
  const privateKeys = new Set<string>();
  for (const sourceId of sourceIds) {
    if (!isPublicSourceId(sourceId)) {
      privateKeys.add(sourceIdKey(sourceId));
    }
  }
  return privateKeys.size;
}

export function countPrivateSourceIdentities(
  ...sourceGroups: Array<Array<CatalogConflictReviewSourceId | CatalogSourceProvenanceRecord>>
): number {
  const privateKeys = new Set<string>();
  for (const group of sourceGroups) {
    if (Array.isArray(group)) {
      for (const entry of group) {
        if ("sourceRecordKind" in entry) {
          if (isPrivateSourceProvenance(entry)) {
            privateKeys.add(`${entry.catalogSource}:${entry.sourceRecordKind}:${entry.sourceId}`);
          }
        } else if (!isPublicSourceId(entry)) {
          privateKeys.add(sourceIdKey(entry));
        }
      }
    } else if (!isPublicSourceId(group)) {
      privateKeys.add(sourceIdKey(group));
    }
  }
  return privateKeys.size;
}

export function uniqueProvenance(
  provenance: CatalogConflictReviewProvenance[],
): CatalogConflictReviewProvenance[] {
  const byId = new Map<string, CatalogConflictReviewProvenance>();
  for (const entry of provenance) {
    byId.set(entry.sourceProvenanceId, entry);
  }
  return Array.from(byId.values()).sort((left, right) =>
    left.sourceProvenanceId.localeCompare(right.sourceProvenanceId),
  );
}

export function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

export function stringMetadata(metadata: CatalogJsonRecord, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function stringArrayMetadata(metadata: CatalogJsonRecord, key: string): string[] {
  const value = metadata[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

export function metadataSourceIds(metadata: CatalogJsonRecord): CatalogConflictReviewSourceId[] {
  const sources = metadata.sources;
  if (!Array.isArray(sources)) {
    return [];
  }
  return sources
    .map((source): CatalogConflictReviewSourceId | null => {
      if (source === null || typeof source !== "object" || Array.isArray(source)) {
        return null;
      }
      const sourceRecord = source as Record<string, unknown>;
      const catalogSource = sourceRecord.catalogSource;
      const sourceId = sourceRecord.sourceId;
      if (
        typeof catalogSource !== "string" ||
        typeof sourceId !== "string" ||
        !catalogSources.includes(catalogSource as CatalogSource)
      ) {
        return null;
      }
      return { catalogSource: catalogSource as CatalogSource, sourceId };
    })
    .filter((sourceId): sourceId is CatalogConflictReviewSourceId => sourceId !== null);
}

export function compareCatalogConflictReviewRows(
  left: CatalogConflictReviewRow,
  right: CatalogConflictReviewRow,
): number {
  return (
    severityRank(left.severity) - severityRank(right.severity) ||
    left.status.localeCompare(right.status) ||
    left.reasonCode.localeCompare(right.reasonCode) ||
    left.reviewId.localeCompare(right.reviewId)
  );
}

export function severityRank(severity: CatalogConflictReviewSeverity): number {
  switch (severity) {
    case "error":
      return 0;
    case "warning":
      return 1;
    case "info":
      return 2;
  }
}

export function compareExactLinkRefs(
  left: CatalogConflictReviewExactLinkRef,
  right: CatalogConflictReviewExactLinkRef,
): number {
  return left.externalIdId.localeCompare(right.externalIdId);
}

export function compareFuzzyScores(
  left: CatalogConflictReviewFuzzyScore,
  right: CatalogConflictReviewFuzzyScore,
): number {
  return right.score - left.score || left.candidateId.localeCompare(right.candidateId);
}

export async function recordSourceProvenanceUnchecked(
  db: ItotoriDatabase,
  input: NormalizedSourceProvenanceInput,
): Promise<CatalogSourceProvenanceRecord> {
  const rows = await db
    .insert(catalogSourceProvenance)
    .values(input)
    .onConflictDoUpdate({
      target: catalogSourceProvenance.sourceProvenanceId,
      set: {
        catalogSource: input.catalogSource,
        sourceRecordKind: input.sourceRecordKind,
        sourceId: input.sourceId,
        sourceVersion: input.sourceVersion,
        requestId: input.requestId,
        httpStatus: input.httpStatus,
        ok: input.ok,
        payloadHash: input.payloadHash,
        rawContentRedactionClass: input.rawContentRedactionClass,
        payload: input.payload,
        fetchedAt: input.fetchedAt,
        metadata: input.metadata,
      },
    })
    .returning();
  return sourceProvenanceFromRow(requiredRow(rows, input.sourceProvenanceId));
}

export async function recordSeedTargetUnchecked(
  db: ItotoriDatabase,
  input: NormalizedSeedTargetInput,
): Promise<CatalogSeedTargetRecord> {
  const result = await db.execute<typeof catalogSeedTargets.$inferSelect>(sql`
    insert into ${catalogSeedTargets} (
      seed_target_id,
      catalog_source,
      source_id,
      seed_origin,
      origin_ref,
      local_scan_entry_id,
      source_provenance_id,
      status,
      priority,
      added_at,
      metadata
    )
    values (
      ${input.seedTargetId},
      ${input.catalogSource},
      ${input.sourceId},
      ${input.seedOrigin},
      ${input.originRef},
      ${input.localScanEntryId},
      ${input.sourceProvenanceId},
      ${input.status},
      ${input.priority},
      ${input.addedAt},
      ${input.metadata}::jsonb
    )
    on conflict (catalog_source, source_id, seed_origin, coalesce(origin_ref, ''))
    do update set
      catalog_source = excluded.catalog_source,
      source_id = excluded.source_id,
      seed_origin = excluded.seed_origin,
      origin_ref = excluded.origin_ref,
      local_scan_entry_id = excluded.local_scan_entry_id,
      source_provenance_id = excluded.source_provenance_id,
      status = excluded.status,
      priority = excluded.priority,
      added_at = excluded.added_at,
      metadata = excluded.metadata,
      updated_at = now()
    returning
      seed_target_id as "seedTargetId",
      catalog_source as "catalogSource",
      source_id as "sourceId",
      seed_origin as "seedOrigin",
      origin_ref as "originRef",
      local_scan_entry_id as "localScanEntryId",
      source_provenance_id as "sourceProvenanceId",
      status,
      priority,
      added_at as "addedAt",
      metadata,
      updated_at as "updatedAt"
  `);
  return seedTargetFromRow(requiredRow(result.rows, input.seedTargetId));
}
