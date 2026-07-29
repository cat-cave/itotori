import { expect } from "vitest";

import {
  type CatalogExternalIdRecord,
  type CatalogLanguageStatusRecord,
  type CatalogWorkSnapshot,
} from "../src/repositories/catalog-repository.js";

import { type CatalogRepositoryDerivedConflictReader } from "../src/services/catalog-repository-derived-platform-language-conflicts.js";
import {
  catalogConfidenceValues,
  catalogLanguageStatusScopeValues,
  catalogRawContentRedactionClassValues,
  type CatalogExternalIdKind,
  type CatalogLanguageStatus,
  type CatalogLanguageStatusScope,
  type CatalogSource,
} from "../src/schema.js";

const now = new Date("2026-06-18T13:00:00.000Z");

export function externalIdIdentity(record: CatalogExternalIdRecord) {
  return {
    externalIdId: record.externalIdId,
    catalogSource: record.catalogSource,
    sourceId: record.sourceId,
    externalIdKind: record.externalIdKind,
    sourceProvenanceId: record.sourceProvenanceId,
  };
}

export function uuid(seed: number): string {
  return `019ed071-0000-7000-8000-${String(seed).padStart(12, "0")}`;
}

export function readerFor(snapshot: CatalogWorkSnapshot): CatalogRepositoryDerivedConflictReader {
  return { getWorkByExternalId: async () => snapshot };
}

export function row(
  catalogSource: CatalogSource,
  sourceId: string,
  externalIdKind: CatalogExternalIdKind,
  languageStatusId: string,
  sourceProvenanceId: string,
) {
  return expect.objectContaining({
    catalogSource,
    sourceId,
    externalIdKind,
    languageStatusId,
    sourceProvenanceId,
    language: "en-US",
  });
}

export function buildSnapshot(parts: {
  externalIds: CatalogExternalIdRecord[];
  languageStatuses: CatalogLanguageStatusRecord[];
}): CatalogWorkSnapshot {
  return {
    workId: "work-derived",
    canonicalTitle: "Moonlit Glass Journey",
    originalLanguage: "ja-JP",
    firstReleaseYear: 2020,
    workKind: "visual_novel",
    engineName: null,
    engineSource: null,
    engineConfidence: null,
    engineProvenanceId: null,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    externalIds: parts.externalIds,
    releases: [],
    releaseMappings: [],
    installStates: [],
    languageStatuses: parts.languageStatuses,
    demandFacts: [],
    conflicts: [],
    localScanEntries: [],
    seedTargets: [],
  };
}

export function externalId(
  catalogSource: CatalogSource,
  sourceId: string,
  sourceProvenanceId: string,
  externalIdKind: CatalogExternalIdKind,
): CatalogExternalIdRecord {
  return {
    externalIdId: `ext-${sourceProvenanceId}`,
    workId: "work-derived",
    catalogSource,
    sourceId,
    externalIdKind,
    sourceProvenanceId,
    confidence: catalogConfidenceValues.high,
    discoveredAt: now,
    metadata: {},
  };
}

export function languageStatus(
  languageStatusId: string,
  sourceProvenanceId: string,
  status: CatalogLanguageStatus,
  statusScope: CatalogLanguageStatusScope = catalogLanguageStatusScopeValues.work,
): CatalogLanguageStatusRecord {
  return {
    languageStatusId,
    workId: "work-derived",
    language: "en-US",
    status,
    statusScope,
    platform: null,
    releaseId: null,
    sourceProvenanceId,
    confidence: catalogConfidenceValues.high,
    isCurrent: true,
    observedAt: now,
    importedAt: now,
    parserVersion: "test",
    rawContentRedactionClass: catalogRawContentRedactionClassValues.publicMetadata,
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };
}
