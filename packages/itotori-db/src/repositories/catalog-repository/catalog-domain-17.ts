import {
  CatalogConfidence,
  CatalogEngineSource,
  CatalogExternalIdKind,
  CatalogInstallState,
  CatalogRawContentRedactionClass,
  CatalogReleaseKind,
  CatalogReleaseMappingKind,
  CatalogReleasePackageKind,
  CatalogSource,
  CatalogSourceRecordKind,
  CatalogTranslationPortability,
  ItotoriDatabase,
  catalogConflictEvidence,
  catalogConflicts,
  catalogDemandFacts,
  catalogExternalIds,
  catalogLanguageStatuses,
  catalogLocalScanEntries,
  catalogLocalScanExternalIds,
  catalogLocalScans,
  catalogRawContentRedactionClassValues,
  catalogReleaseInstallStates,
  catalogReleaseMappings,
  catalogReleases,
  catalogSeedTargets,
  catalogWorks,
  createUuid7,
  eq,
  inArray,
} from "./dependencies.js";
import { CatalogJsonRecord, CatalogSourceProvenanceInput } from "./catalog-domain-01.js";
import {
  CatalogConflictEvidenceRecord,
  CatalogLocalScanEntryRecord,
  CatalogLocalScanRecord,
  CatalogWorkSnapshot,
} from "./catalog-domain-02.js";
import {
  catalogRawContentRedactionClasses,
  catalogSourceRecordKinds,
  catalogSources,
} from "./catalog-domain-04.js";
import {
  NormalizedConflictInput,
  NormalizedDemandFactInput,
  NormalizedLanguageStatusInput,
} from "./catalog-domain-18.js";
import { externalIdFromRow, releaseFromRow, workFromRow } from "./catalog-domain-21.js";
import {
  assertSha256,
  conflictEvidenceFromRow,
  conflictFromRow,
  dateInput,
  demandFactFromRow,
  jsonRecord,
  languageStatusFromRow,
  localScanDetectedExternalIdFromRow,
  localScanEntryFromRow,
  localScanFromRow,
  optionalString,
  releaseInstallStateFromRow,
  releaseMappingFromRow,
  requiredString,
  seedTargetFromRow,
} from "./catalog-domain-22.js";
import { assertEnumValue } from "./catalog-domain-23.js";

export async function readWorkSnapshot(
  db: ItotoriDatabase,
  workId: string,
): Promise<CatalogWorkSnapshot | null> {
  const workRows = await db
    .select()
    .from(catalogWorks)
    .where(eq(catalogWorks.workId, workId))
    .limit(1);
  const workRow = workRows[0];
  if (workRow === undefined) {
    return null;
  }

  const [
    externalIdRows,
    releaseRows,
    releaseMappingRows,
    installStateRows,
    languageStatusRows,
    demandFactRows,
    conflictRows,
    localScanEntryRows,
  ] = await Promise.all([
    db.select().from(catalogExternalIds).where(eq(catalogExternalIds.workId, workId)),
    db.select().from(catalogReleases).where(eq(catalogReleases.workId, workId)),
    db.select().from(catalogReleaseMappings).where(eq(catalogReleaseMappings.workId, workId)),
    db
      .select()
      .from(catalogReleaseInstallStates)
      .where(eq(catalogReleaseInstallStates.workId, workId)),
    db.select().from(catalogLanguageStatuses).where(eq(catalogLanguageStatuses.workId, workId)),
    db.select().from(catalogDemandFacts).where(eq(catalogDemandFacts.workId, workId)),
    db.select().from(catalogConflicts).where(eq(catalogConflicts.workId, workId)),
    db.select().from(catalogLocalScanEntries).where(eq(catalogLocalScanEntries.workId, workId)),
  ]);
  const localScanEntryIds = localScanEntryRows.map((row) => row.localScanEntryId);
  const seedTargetRows =
    localScanEntryIds.length === 0
      ? []
      : await db
          .select()
          .from(catalogSeedTargets)
          .where(inArray(catalogSeedTargets.localScanEntryId, localScanEntryIds));

  const conflictEvidenceRows =
    conflictRows.length === 0
      ? []
      : await db
          .select()
          .from(catalogConflictEvidence)
          .where(
            inArray(
              catalogConflictEvidence.conflictId,
              conflictRows.map((row) => row.conflictId),
            ),
          );
  const evidenceByConflict = new Map<string, CatalogConflictEvidenceRecord[]>();
  for (const row of conflictEvidenceRows) {
    const evidence = conflictEvidenceFromRow(row);
    const existing = evidenceByConflict.get(evidence.conflictId) ?? [];
    existing.push(evidence);
    evidenceByConflict.set(evidence.conflictId, existing);
  }

  const localScanEntries = await localScanEntriesWithChildren(db, localScanEntryRows);

  return {
    ...workFromRow(workRow),
    externalIds: externalIdRows.map(externalIdFromRow),
    releases: releaseRows.map(releaseFromRow),
    releaseMappings: releaseMappingRows.map(releaseMappingFromRow),
    installStates: installStateRows.map(releaseInstallStateFromRow),
    languageStatuses: languageStatusRows.map(languageStatusFromRow),
    demandFacts: demandFactRows.map(demandFactFromRow),
    conflicts: conflictRows.map((row) => ({
      ...conflictFromRow(row),
      evidence: evidenceByConflict.get(row.conflictId) ?? [],
    })),
    localScanEntries,
    seedTargets: seedTargetRows.map(seedTargetFromRow),
  };
}

export async function readLocalScan(
  db: ItotoriDatabase,
  localScanId: string,
): Promise<CatalogLocalScanRecord | null> {
  const scanRows = await db
    .select()
    .from(catalogLocalScans)
    .where(eq(catalogLocalScans.localScanId, localScanId))
    .limit(1);
  const scanRow = scanRows[0];
  if (scanRow === undefined) {
    return null;
  }

  const entryRows = await db
    .select()
    .from(catalogLocalScanEntries)
    .where(eq(catalogLocalScanEntries.localScanId, localScanId));
  return {
    ...localScanFromRow(scanRow),
    entries: await localScanEntriesWithChildren(db, entryRows),
  };
}

export async function localScanEntriesWithChildren(
  db: ItotoriDatabase,
  entries: (typeof catalogLocalScanEntries.$inferSelect)[],
): Promise<CatalogLocalScanEntryRecord[]> {
  const records: CatalogLocalScanEntryRecord[] = [];
  for (const entry of entries) {
    const [detectedExternalIdRows, seedTargetRows] = await Promise.all([
      db
        .select()
        .from(catalogLocalScanExternalIds)
        .where(eq(catalogLocalScanExternalIds.localScanEntryId, entry.localScanEntryId)),
      db
        .select()
        .from(catalogSeedTargets)
        .where(eq(catalogSeedTargets.localScanEntryId, entry.localScanEntryId)),
    ]);
    records.push({
      ...localScanEntryFromRow(entry),
      detectedExternalIds: detectedExternalIdRows.map(localScanDetectedExternalIdFromRow),
      seedTargets: seedTargetRows.map(seedTargetFromRow),
    });
  }
  return records;
}

export type NormalizedSourceProvenanceInput = {
  sourceProvenanceId: string;
  catalogSource: CatalogSource;
  sourceRecordKind: CatalogSourceRecordKind;
  sourceId: string;
  sourceVersion: string | null;
  requestId: string | null;
  httpStatus: number | null;
  ok: boolean;
  payloadHash: string | null;
  rawContentRedactionClass: CatalogRawContentRedactionClass;
  payload: CatalogJsonRecord;
  fetchedAt: Date;
  metadata: CatalogJsonRecord;
};

export function assertSourceProvenanceInput(
  input: CatalogSourceProvenanceInput,
): NormalizedSourceProvenanceInput {
  assertEnumValue(input.catalogSource, catalogSources, "catalogSource");
  assertEnumValue(input.sourceRecordKind, catalogSourceRecordKinds, "sourceRecordKind");
  const httpStatus = input.httpStatus ?? null;
  if (
    httpStatus !== null &&
    (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599)
  ) {
    throw new Error("httpStatus must be a valid HTTP status code");
  }
  if (input.payloadHash !== undefined) {
    assertSha256(input.payloadHash, "payloadHash");
  }
  if (input.rawContentRedactionClass !== undefined) {
    assertEnumValue(
      input.rawContentRedactionClass,
      catalogRawContentRedactionClasses,
      "rawContentRedactionClass",
    );
  }
  return {
    sourceProvenanceId: input.sourceProvenanceId ?? createUuid7(),
    catalogSource: input.catalogSource,
    sourceRecordKind: input.sourceRecordKind,
    sourceId: requiredString(input.sourceId, "sourceId"),
    sourceVersion: optionalString(input.sourceVersion, "sourceVersion"),
    requestId: optionalString(input.requestId, "requestId"),
    httpStatus,
    ok: input.ok ?? true,
    payloadHash: input.payloadHash ?? null,
    rawContentRedactionClass:
      input.rawContentRedactionClass ?? catalogRawContentRedactionClassValues.publicMetadata,
    payload: jsonRecord(input.payload ?? {}, "payload"),
    fetchedAt: dateInput(input.fetchedAt, "fetchedAt"),
    metadata: jsonRecord(input.metadata ?? {}, "metadata"),
  };
}

export type NormalizedCatalogWorkInput = {
  workId: string;
  canonicalTitle: string;
  originalLanguage: string | null;
  firstReleaseYear: number | null;
  workKind: string;
  engine: NormalizedCatalogEngineInput | null;
  metadata: CatalogJsonRecord;
  externalIds: NormalizedExternalIdInput[];
  releases: NormalizedReleaseInput[];
  releaseMappings: NormalizedReleaseMappingInput[];
  installStates: NormalizedReleaseInstallStateInput[];
  languageStatuses: NormalizedLanguageStatusInput[];
  demandFacts: NormalizedDemandFactInput[];
  conflicts: NormalizedConflictInput[];
};

export type NormalizedCatalogEngineInput = {
  engineName: string;
  engineSource: CatalogEngineSource;
  engineConfidence: CatalogConfidence;
  engineProvenanceId: string | null;
};

export type NormalizedExternalIdInput = {
  externalIdId: string;
  catalogSource: CatalogSource;
  sourceId: string;
  externalIdKind: CatalogExternalIdKind;
  sourceProvenanceId: string | null;
  confidence: CatalogConfidence;
  discoveredAt: Date;
  metadata: CatalogJsonRecord;
};

export type NormalizedReleaseInput = {
  releaseId: string;
  catalogSource: CatalogSource;
  sourceReleaseId: string | null;
  releaseTitle: string;
  releaseKind: CatalogReleaseKind;
  editionName: string | null;
  milestone: string | null;
  packageKind: CatalogReleasePackageKind;
  engine: NormalizedCatalogEngineInput | null;
  platform: string | null;
  language: string | null;
  releaseDate: string | null;
  releaseYear: number | null;
  isOfficial: boolean;
  sourceProvenanceId: string | null;
  metadata: CatalogJsonRecord;
};

export type NormalizedReleaseMappingInput = {
  releaseMappingId: string;
  sourceReleaseId: string;
  targetReleaseId: string;
  relationKind: CatalogReleaseMappingKind;
  portability: CatalogTranslationPortability;
  sourceProvenanceId: string | null;
  confidence: CatalogConfidence;
  observedAt: Date;
  metadata: CatalogJsonRecord;
};

export type NormalizedReleaseInstallStateInput = {
  installStateId: string;
  releaseId: string;
  localScanEntryId: string | null;
  installState: CatalogInstallState;
  targetArtifactLabel: string | null;
  sourceProvenanceId: string | null;
  confidence: CatalogConfidence;
  observedAt: Date;
  metadata: CatalogJsonRecord;
};
