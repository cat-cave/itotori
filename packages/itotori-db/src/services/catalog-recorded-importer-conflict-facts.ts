import type { CatalogJsonRecord } from "../repositories/catalog-repository.js";
import {
  catalogExternalIdKindValues,
  catalogLanguageStatusScopeValues,
  catalogLanguageStatusValues,
  catalogSourceValues,
  type CatalogExternalIdKind,
  type CatalogLanguageStatus,
  type CatalogLanguageStatusScope,
  type CatalogSource,
} from "../schema.js";

import {
  augmentCatalogPlatformLanguageConflicts,
  catalogPlatformLanguageConflictReasonCode,
  type CatalogPlatformLanguageConflictEvidence,
  type CatalogPlatformLanguageConflictRequest,
} from "./catalog-platform-language-conflicts.js";

import {
  type CatalogRecordedConflictEvidenceFact,
  type CatalogRecordedConflictFact,
} from "./catalog-recorded-importer-dlsite.js";
import { optionalArray, optionalString } from "./catalog-recorded-importer-payload-parsing.js";
import { compactJson } from "./catalog-recorded-importer-utils.js";

export function conflictFactsFromPayload(
  payload: CatalogJsonRecord,
): CatalogRecordedConflictFact[] {
  return platformArray(payload, "conflicts")
    .map((entry): CatalogRecordedConflictFact | null => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        return null;
      }
      const record = entry as CatalogJsonRecord;
      const summary = optionalString(record, "summary");
      if (summary === undefined) {
        return null;
      }
      const reasonCode =
        optionalString(record, "reason_code") ?? optionalString(record, "reasonCode");
      if (reasonCode === catalogPlatformLanguageConflictReasonCode) {
        return platformLanguageConflictFactFromRecord(record);
      }
      const conflict: CatalogRecordedConflictFact = {
        summary,
        severity: conflictSeverityValue(optionalString(record, "severity")),
        metadata: compactJson({
          sourceField: "conflicts",
          sources: optionalArray(record, "sources"),
          disputedLanguage: optionalString(record, "language"),
          disputedStatus: optionalString(record, "status"),
        }),
      };
      if (reasonCode !== undefined) {
        conflict.reasonCode = reasonCode;
      }
      return conflict;
    })
    .filter((conflict): conflict is CatalogRecordedConflictFact => conflict !== null);
}

export function platformLanguageConflictFactFromRecord(
  record: CatalogJsonRecord,
): CatalogRecordedConflictFact | null {
  const summary = optionalString(record, "summary");
  const targetLanguage = optionalString(record, "language") ?? "en-US";
  const sourceField = optionalString(record, "source_field") ?? "conflicts";
  const sources = platformArray(record, "sources")
    .map((source, index) => platformLanguageEvidenceFromSource(source, targetLanguage, index))
    .filter((source): source is CatalogPlatformLanguageConflictEvidence => source !== null);
  const officialEvidence =
    sources.find(
      (source) =>
        (source.catalogSource === "igdb" || source.catalogSource === "wikidata") &&
        source.status === catalogLanguageStatusValues.officialFull,
    ) ?? sources.find((source) => source.status === catalogLanguageStatusValues.officialFull);
  if (officialEvidence === undefined) {
    return null;
  }
  const request = compactJson({
    targetLanguage,
    officialEvidence,
    candidateEvidence: sources.filter((source) => source !== officialEvidence),
    summary,
    sourceField,
  }) as CatalogPlatformLanguageConflictRequest;
  const result = augmentCatalogPlatformLanguageConflicts(request);
  return result.conflicts[0] === undefined
    ? null
    : {
        conflictKind: result.conflicts[0].conflictKind,
        status: result.conflicts[0].status,
        summary: result.conflicts[0].summary,
        reasonCode: result.conflicts[0].reasonCode,
        severity: result.conflicts[0].severity,
        evidence: result.conflicts[0].evidence.map(
          (evidence) =>
            compactJson({
              subjectKind: evidence.subjectKind,
              subjectId: evidence.subjectId,
              evidencePosition: evidence.evidencePosition,
              sourceProvenanceId: evidence.sourceProvenanceId,
              metadata: evidence.metadata,
            }) as CatalogRecordedConflictEvidenceFact,
        ),
        metadata: {
          ...result.conflicts[0].metadata,
          augmentationDiagnostics: result.diagnostics,
        },
      };
}

export function platformLanguageEvidenceFromSource(
  input: unknown,
  targetLanguage: string,
  index: number,
): CatalogPlatformLanguageConflictEvidence | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const source = input as CatalogJsonRecord;
  const catalogSource = optionalString(source, "catalogSource");
  const sourceId = optionalString(source, "sourceId");
  const status = optionalString(source, "status");
  if (
    catalogSource === undefined ||
    sourceId === undefined ||
    status === undefined ||
    !(Object.values(catalogSourceValues) as string[]).includes(catalogSource) ||
    !(Object.values(catalogLanguageStatusValues) as string[]).includes(status)
  ) {
    return null;
  }
  const externalIdKind = optionalString(source, "externalIdKind");
  const statusScope = optionalString(source, "statusScope");
  return compactJson({
    catalogSource: catalogSource as CatalogSource,
    sourceId,
    externalIdKind:
      externalIdKind !== undefined &&
      (Object.values(catalogExternalIdKindValues) as string[]).includes(externalIdKind)
        ? (externalIdKind as CatalogExternalIdKind)
        : catalogExternalIdKindValues.sourceRecord,
    language: optionalString(source, "language") ?? targetLanguage,
    status: status as CatalogLanguageStatus,
    statusScope:
      statusScope !== undefined &&
      (Object.values(catalogLanguageStatusScopeValues) as string[]).includes(statusScope)
        ? (statusScope as CatalogLanguageStatusScope)
        : catalogLanguageStatusScopeValues.platform,
    platform: optionalString(source, "platform") ?? null,
    sourceProvenanceId: optionalString(source, "sourceProvenanceId"),
    languageStatusId: optionalString(source, "languageStatusId"),
    evidenceRef: optionalString(source, "evidenceRef") ?? `conflicts.sources[${index}]`,
    metadata: compactJson({ sourceField: `conflicts.sources[${index}]` }),
  }) as CatalogPlatformLanguageConflictEvidence;
}

export function conflictSeverityValue(value: string | undefined): "info" | "warning" | "critical" {
  return value === "info" || value === "critical" ? value : "warning";
}

export function platformLabel(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) {
    return normalizePlatformLabel(value);
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as CatalogJsonRecord;
    const raw =
      optionalString(record, "catalog_platform") ??
      optionalString(record, "slug") ??
      optionalString(record, "name") ??
      optionalString(record, "id");
    return raw === undefined ? null : normalizePlatformLabel(raw);
  }
  return null;
}

export function normalizePlatformLabel(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_|_$/gu, "");
  const map: Record<string, string> = {
    pc_microsoft_windows: "pc",
    microsoft_windows: "pc",
    windows: "pc",
    win: "pc",
    steam: "steam",
    epic_games_store: "egs",
    nintendo_switch: "nintendo_switch",
  };
  return map[normalized] ?? normalized;
}

export function platformUnixDate(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return new Date(value * 1000).toISOString().slice(0, 10);
}

export function platformArray(record: CatalogJsonRecord, field: string): unknown[] {
  const value = record[field];
  return Array.isArray(value) ? value : [];
}

export function platformRecord(record: CatalogJsonRecord, field: string): CatalogJsonRecord {
  const value = record[field];
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as CatalogJsonRecord)
    : {};
}
