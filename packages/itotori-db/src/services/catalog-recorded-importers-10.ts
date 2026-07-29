import { createHash } from "node:crypto";
import type { AuthorizationActor } from "../authorization.js";
import type {
  CatalogConflictEvidenceInput,
  CatalogConflictInput,
  CatalogDemandFactInput,
  CatalogExternalIdInput,
  CatalogExternalIdRecord,
  CatalogJsonRecord,
  CatalogLanguageStatusInput,
  CatalogReleaseInput,
  CatalogReleaseMappingInput,
  CatalogSeedTargetInput,
  CatalogWorkInput,
  ItotoriCatalogRepositoryPort,
} from "../repositories/catalog-repository.js";
import {
  catalogConfidenceValues,
  catalogConflictKindValues,
  catalogConflictStatusValues,
  catalogConflictSubjectKindValues,
  catalogDemandFactKindValues,
  catalogExternalIdKindValues,
  catalogLanguageStatusScopeValues,
  catalogLanguageStatusValues,
  catalogRawContentRedactionClassValues,
  catalogReleaseKindValues,
  catalogReleaseMappingKindValues,
  catalogReleasePackageKindValues,
  catalogSeedOriginValues,
  catalogSeedStatusValues,
  catalogSourceRecordKindValues,
  catalogSourceValues,
  catalogTranslationPortabilityValues,
  type CatalogConfidence,
  type CatalogConflictKind,
  type CatalogConflictStatus,
  type CatalogConflictSubjectKind,
  type CatalogDemandFactKind,
  type CatalogExternalIdKind,
  type CatalogLanguageStatus,
  type CatalogLanguageStatusScope,
  type CatalogRawContentRedactionClass,
  type CatalogReleaseKind,
  type CatalogReleaseMappingKind,
  type CatalogReleasePackageKind,
  type CatalogSource,
  type CatalogTranslationPortability,
} from "../schema.js";
import {
  catalogCrawlerFactImportStrategyValues,
  catalogCrawlerIdempotentFactImportContractId,
  createRecordedCatalogCrawlerAdapter,
  type CatalogCrawlerFactImportEvidence,
  type CatalogCrawlerFactImportContract,
  type CatalogCrawlerFactImportProof,
  type CatalogCrawlerIngestContext,
  type CatalogCrawlerIngestStep,
  type CatalogCrawlerRateLimitMetadata,
  type CatalogCrawlerSourceAdapter,
  type CatalogCrawlerVerifyFactImportStep,
  type RecordedCatalogCrawlerFixture,
} from "./catalog-crawler-runner.js";
import {
  augmentCatalogPlatformLanguageConflicts,
  catalogPlatformLanguageConflictReasonCode,
  type CatalogPlatformLanguageConflictEvidence,
  type CatalogPlatformLanguageConflictRequest,
} from "./catalog-platform-language-conflicts.js";

import {
  type CatalogRecordedPlatformSource,
  type CatalogRecordedSourceFactKind,
  catalogRecordedStorefrontDiagnosticCodeValues,
  type CatalogRecordedStorefrontFixture,
  type CatalogRecordedStorefrontResponse,
} from "./catalog-recorded-importers-01.js";
import { storefrontSemanticError } from "./catalog-recorded-importers-09.js";

export function stringField(
  record: CatalogJsonRecord,
  field: string,
  fixture: CatalogRecordedStorefrontFixture,
  response: CatalogRecordedStorefrontResponse,
): string {
  const value = record[field];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  throw storefrontSemanticError(
    catalogRecordedStorefrontDiagnosticCodeValues.parseDrift,
    `recorded storefront response is missing required string field ${field}`,
    fixture,
    response,
    field,
  );
}

export function numberOrStringField(
  record: CatalogJsonRecord,
  field: string,
  fixture: CatalogRecordedStorefrontFixture,
  response: CatalogRecordedStorefrontResponse,
): string | number {
  const value = record[field];
  if (
    (typeof value === "string" && value.length > 0) ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  throw storefrontSemanticError(
    catalogRecordedStorefrontDiagnosticCodeValues.parseDrift,
    `recorded storefront response is missing required string/number field ${field}`,
    fixture,
    response,
    field,
  );
}

export function optionalString(
  record: CatalogJsonRecord | undefined,
  field: string,
): string | undefined {
  const value = record?.[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function optionalRecord(
  record: CatalogJsonRecord,
  field: string,
): CatalogJsonRecord | undefined {
  const value = record[field];
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as CatalogJsonRecord)
    : undefined;
}

export function requiredArray(
  record: CatalogJsonRecord,
  field: string,
  fixture: CatalogRecordedStorefrontFixture,
  response: CatalogRecordedStorefrontResponse,
  sourceField: string = field,
): unknown[] {
  const value = record[field];
  if (Array.isArray(value)) {
    return value;
  }
  throw storefrontSemanticError(
    catalogRecordedStorefrontDiagnosticCodeValues.parseDrift,
    `recorded storefront response is missing required array field ${field}`,
    fixture,
    response,
    sourceField,
  );
}

export function optionalArray(record: CatalogJsonRecord, field: string): unknown[] | undefined {
  const value = record[field];
  return Array.isArray(value) ? value : undefined;
}

export function stringArray(record: CatalogJsonRecord, field: string): string[] {
  return (optionalArray(record, field) ?? []).filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

export function titlesFromPayload(payload: CatalogJsonRecord, canonicalTitle: string): string[] {
  const rawTitles = optionalArray(payload, "titles") ?? [];
  const titles = rawTitles
    .map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }
      if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
        return optionalString(entry as CatalogJsonRecord, "title");
      }
      return undefined;
    })
    .filter((title): title is string => title !== undefined);
  return [...new Set([canonicalTitle, ...titles])];
}

export function yearFromDate(date: string): number | undefined {
  const match = /^(\d{4})/u.exec(date);
  return match === null ? undefined : Number(match[1]);
}

export function demandNumber(record: CatalogJsonRecord, field: string): number | undefined {
  const value = record[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function steamReleaseDate(releaseDate: CatalogJsonRecord | undefined): string | undefined {
  const date = optionalString(releaseDate, "date");
  if (date === undefined || optionalString(releaseDate, "coming_soon") === "true") {
    return undefined;
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})/u.exec(date);
  if (iso !== null) {
    return `${iso[1]}-${iso[2]}-${iso[3]}`;
  }
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString().slice(0, 10);
}

export function steamLocaleFromLabel(label: string): string | null {
  const normalized = label
    .toLowerCase()
    .replace(/\s*\*+\s*$/u, "")
    .trim();
  const map: Record<string, string> = {
    english: "en-US",
    japanese: "ja-JP",
    "simplified chinese": "zh-Hans",
    "traditional chinese": "zh-Hant",
    korean: "ko-KR",
    french: "fr-FR",
    german: "de-DE",
    spanish: "es-ES",
  };
  return map[normalized] ?? (normalized.includes("japanese") ? "ja-JP" : null);
}

export function catalogRecordedConfidenceForSourceFact(
  catalogSource: CatalogRecordedPlatformSource,
  factKind: CatalogRecordedSourceFactKind,
  options: { qualifierProvenance?: string } = {},
): CatalogConfidence {
  if (catalogSource === "igdb") {
    return catalogConfidenceValues.high;
  }
  if (factKind === "external_id" || factKind === "entity_link") {
    return catalogConfidenceValues.high;
  }
  if (options.qualifierProvenance === undefined || options.qualifierProvenance.length === 0) {
    return catalogConfidenceValues.low;
  }
  return catalogConfidenceValues.medium;
}

export function confidenceOptions(value: string | undefined): { qualifierProvenance?: string } {
  return value === undefined ? {} : { qualifierProvenance: value };
}

export function igdbLanguageStatus(record: CatalogJsonRecord): CatalogLanguageStatus {
  const explicit = record.status;
  if (
    typeof explicit === "string" &&
    (Object.values(catalogLanguageStatusValues) as string[]).includes(explicit)
  ) {
    return explicit as CatalogLanguageStatus;
  }
  const supportType = optionalString(record, "support_type")?.toLowerCase() ?? "";
  if (supportType.includes("interface") || supportType.includes("subtitle")) {
    return catalogLanguageStatusValues.officialFull;
  }
  if (supportType.includes("audio")) {
    return catalogLanguageStatusValues.interfaceOnly;
  }
  return catalogLanguageStatusValues.unknown;
}

export function externalGameCatalogSource(
  category: string | undefined,
): { catalogSource: CatalogSource; externalIdKind: CatalogExternalIdKind } | null {
  switch (category) {
    case "steam":
      return {
        catalogSource: "steam",
        externalIdKind: catalogExternalIdKindValues.storeProduct,
      };
    case "wikidata":
      return {
        catalogSource: "wikidata",
        externalIdKind: catalogExternalIdKindValues.knowledgeBaseEntity,
      };
    default:
      return null;
  }
}
