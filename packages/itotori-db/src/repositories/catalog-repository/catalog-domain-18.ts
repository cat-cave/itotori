import {
  CatalogConfidence,
  CatalogConflictKind,
  CatalogConflictStatus,
  CatalogConflictSubjectKind,
  CatalogDemandFactKind,
  CatalogLanguageStatus,
  CatalogLanguageStatusScope,
  CatalogRawContentRedactionClass,
  CatalogSource,
  ItotoriDatabase,
  catalogConfidenceValues,
  catalogLocalScanEntries,
  catalogReleases,
  createUuid7,
  inArray,
} from "./dependencies.js";
import { CatalogArtifactMappingError, CatalogJsonRecord } from "./catalog-domain-01.js";
import { CatalogWorkInput } from "./catalog-domain-02.js";
import { catalogConfidences, catalogEngineSources } from "./catalog-domain-04.js";
import { NormalizedCatalogEngineInput, NormalizedCatalogWorkInput } from "./catalog-domain-17.js";
import { assertReleaseBelongsToWork } from "./catalog-domain-19.js";
import {
  assertConflictInput,
  assertDemandFactInput,
  assertExternalIdInput,
  assertLanguageStatusInput,
  assertReleaseInput,
  assertReleaseInstallStateInput,
  assertReleaseMappingInput,
} from "./catalog-domain-20.js";
import { jsonRecord, optionalString, optionalYear, requiredString } from "./catalog-domain-22.js";
import { assertEnumValue } from "./catalog-domain-23.js";

export type NormalizedLanguageStatusInput = {
  languageStatusId: string;
  language: string;
  status: CatalogLanguageStatus;
  statusScope: CatalogLanguageStatusScope;
  platform: string | null;
  releaseId: string | null;
  sourceProvenanceId: string | null;
  confidence: CatalogConfidence;
  isCurrent: boolean;
  observedAt: Date;
  importedAt: Date;
  parserVersion: string;
  rawContentRedactionClass: CatalogRawContentRedactionClass;
  metadata: CatalogJsonRecord;
};

export type NormalizedDemandFactInput = {
  demandFactId: string;
  catalogSource: CatalogSource;
  sourceId: string;
  factKind: CatalogDemandFactKind;
  factValue: CatalogJsonRecord;
  observedAt: Date;
  sourceProvenanceId: string | null;
  parserVersion: string;
  metadata: CatalogJsonRecord;
};

export type NormalizedConflictInput = {
  conflictId: string;
  conflictKind: CatalogConflictKind;
  status: CatalogConflictStatus;
  summary: string;
  detectedAt: Date;
  metadata: CatalogJsonRecord;
  evidence: NormalizedConflictEvidenceInput[];
};

export type NormalizedConflictEvidenceInput = {
  conflictEvidenceId: string;
  subjectKind: CatalogConflictSubjectKind;
  subjectId: string;
  sourceProvenanceId: string | null;
  evidencePosition: number;
  metadata: CatalogJsonRecord;
};

export function assertCatalogWorkInput(input: CatalogWorkInput): NormalizedCatalogWorkInput {
  const firstReleaseYear = optionalYear(input.firstReleaseYear, "firstReleaseYear");
  let engine: NormalizedCatalogEngineInput | null = null;
  if (input.engine !== undefined) {
    assertEnumValue(input.engine.engineSource, catalogEngineSources, "engine.engineSource");
    if (input.engine.engineConfidence !== undefined) {
      assertEnumValue(input.engine.engineConfidence, catalogConfidences, "engine.engineConfidence");
    }
    engine = {
      engineName: requiredString(input.engine.engineName, "engine.engineName"),
      engineSource: input.engine.engineSource,
      engineConfidence: input.engine.engineConfidence ?? catalogConfidenceValues.unknown,
      engineProvenanceId: input.engine.engineProvenanceId ?? null,
    };
  }

  return {
    workId: input.workId ?? createUuid7(),
    canonicalTitle: requiredString(input.canonicalTitle, "canonicalTitle"),
    originalLanguage: optionalString(input.originalLanguage, "originalLanguage"),
    firstReleaseYear,
    workKind: input.workKind === undefined ? "game" : requiredString(input.workKind, "workKind"),
    engine,
    metadata: jsonRecord(input.metadata ?? {}, "metadata"),
    externalIds: (input.externalIds ?? []).map(assertExternalIdInput),
    releases: (input.releases ?? []).map(assertReleaseInput),
    releaseMappings: (input.releaseMappings ?? []).map(assertReleaseMappingInput),
    installStates: (input.installStates ?? []).map(assertReleaseInstallStateInput),
    languageStatuses: (input.languageStatuses ?? []).map(assertLanguageStatusInput),
    demandFacts: (input.demandFacts ?? []).map(assertDemandFactInput),
    conflicts: (input.conflicts ?? []).map(assertConflictInput),
  };
}

export async function assertWorkScopedArtifactReferences(
  db: ItotoriDatabase,
  input: NormalizedCatalogWorkInput,
): Promise<void> {
  const inputReleaseIds = new Set(input.releases.map((release) => release.releaseId));
  const referencedReleaseIds = new Set<string>();
  for (const mapping of input.releaseMappings) {
    referencedReleaseIds.add(mapping.sourceReleaseId);
    referencedReleaseIds.add(mapping.targetReleaseId);
  }
  for (const installState of input.installStates) {
    referencedReleaseIds.add(installState.releaseId);
  }

  const releaseIds = new Set([...inputReleaseIds, ...referencedReleaseIds]);
  const existingReleaseWorkIds = new Map<string, string>();
  if (releaseIds.size > 0) {
    const rows = await db
      .select({ releaseId: catalogReleases.releaseId, workId: catalogReleases.workId })
      .from(catalogReleases)
      .where(inArray(catalogReleases.releaseId, [...releaseIds]));
    for (const row of rows) {
      existingReleaseWorkIds.set(row.releaseId, row.workId);
    }
  }

  for (const releaseId of inputReleaseIds) {
    const workId = existingReleaseWorkIds.get(releaseId);
    if (workId !== undefined && workId !== input.workId) {
      throw new CatalogArtifactMappingError(
        "release_belongs_to_other_work",
        "release.releaseId must not already belong to a different work",
      );
    }
  }

  for (const mapping of input.releaseMappings) {
    assertReleaseBelongsToWork(
      mapping.sourceReleaseId,
      "releaseMapping.sourceReleaseId",
      input.workId,
      inputReleaseIds,
      existingReleaseWorkIds,
      "release_mapping_release_belongs_to_other_work",
      "release_mapping_release_not_in_work",
    );
    assertReleaseBelongsToWork(
      mapping.targetReleaseId,
      "releaseMapping.targetReleaseId",
      input.workId,
      inputReleaseIds,
      existingReleaseWorkIds,
      "release_mapping_release_belongs_to_other_work",
      "release_mapping_release_not_in_work",
    );
  }

  for (const installState of input.installStates) {
    assertReleaseBelongsToWork(
      installState.releaseId,
      "installState.releaseId",
      input.workId,
      inputReleaseIds,
      existingReleaseWorkIds,
      "install_state_release_belongs_to_other_work",
      "install_state_release_not_in_work",
    );
  }

  const localScanEntryIds = [
    ...new Set(
      input.installStates
        .map((installState) => installState.localScanEntryId)
        .filter((localScanEntryId): localScanEntryId is string => localScanEntryId !== null),
    ),
  ];
  if (localScanEntryIds.length === 0) {
    return;
  }

  const localScanEntryRows = await db
    .select({
      localScanEntryId: catalogLocalScanEntries.localScanEntryId,
      workId: catalogLocalScanEntries.workId,
    })
    .from(catalogLocalScanEntries)
    .where(inArray(catalogLocalScanEntries.localScanEntryId, localScanEntryIds));
  const localScanEntryWorkIds = new Map(
    localScanEntryRows.map((row) => [row.localScanEntryId, row.workId]),
  );
  for (const localScanEntryId of localScanEntryIds) {
    const workId = localScanEntryWorkIds.get(localScanEntryId);
    if (workId !== input.workId) {
      throw new CatalogArtifactMappingError(
        "install_state_local_scan_entry_belongs_to_other_work",
        "installState.localScanEntryId must belong to the install state work",
      );
    }
  }
}
