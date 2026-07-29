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
  type CatalogRecordedStorefrontDiagnostic,
  type CatalogRecordedStorefrontDiagnosticCode,
  catalogRecordedStorefrontDiagnosticCodeValues,
  type CatalogRecordedStorefrontFixture,
  type CatalogRecordedStorefrontResponse,
  CatalogRecordedStorefrontSemanticError,
} from "./catalog-recorded-importers-01.js";

export function optionalDemandNumber(
  record: CatalogJsonRecord,
  field: string,
  fixture: CatalogRecordedStorefrontFixture,
  response: CatalogRecordedStorefrontResponse,
): number | undefined {
  if (!(field in record)) {
    return undefined;
  }
  const value = record[field];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  throw storefrontSemanticError(
    catalogRecordedStorefrontDiagnosticCodeValues.parseDrift,
    `DLsite demand.${field} must be a finite number when present`,
    fixture,
    response,
    field,
  );
}

export function requireDemandString(
  record: CatalogJsonRecord,
  field: string,
  fixture: CatalogRecordedStorefrontFixture,
  response: CatalogRecordedStorefrontResponse,
  sourceField: string,
): string {
  const value = record[field];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  throw storefrontSemanticError(
    catalogRecordedStorefrontDiagnosticCodeValues.parseDrift,
    `DLsite demand.${sourceField} must be a non-empty string`,
    fixture,
    response,
    sourceField,
  );
}

export function requireDemandObservedAt(
  record: CatalogJsonRecord,
  field: string,
  fixture: CatalogRecordedStorefrontFixture,
  response: CatalogRecordedStorefrontResponse,
  sourceField: string,
): string {
  const value = requireDemandString(record, field, fixture, response, sourceField);
  if (isValidObservedAtInput(value)) {
    return value;
  }
  throw storefrontSemanticError(
    catalogRecordedStorefrontDiagnosticCodeValues.parseDrift,
    `DLsite demand.${sourceField} must be a valid date string`,
    fixture,
    response,
    sourceField,
  );
}

export function isValidObservedAtInput(value: string): boolean {
  const observedAtShape =
    /^\d{4}-\d{2}-\d{2}(?:$|T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?$)/u;
  if (!observedAtShape.test(value)) {
    return false;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return false;
  }
  return hasValidCalendarDatePrefix(value);
}

export function hasValidCalendarDatePrefix(value: string): boolean {
  const datePrefix = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/u.exec(value);
  if (datePrefix === null) {
    return false;
  }
  const [, year, month, day] = datePrefix;
  const calendarDate = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return (
    calendarDate.getUTCFullYear() === Number(year) &&
    calendarDate.getUTCMonth() + 1 === Number(month) &&
    calendarDate.getUTCDate() === Number(day)
  );
}

export function requireDemandPositiveInteger(
  record: CatalogJsonRecord,
  field: string,
  fixture: CatalogRecordedStorefrontFixture,
  response: CatalogRecordedStorefrontResponse,
  sourceField: string,
): number {
  const value = record[field];
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  throw storefrontSemanticError(
    catalogRecordedStorefrontDiagnosticCodeValues.parseDrift,
    `DLsite demand.${sourceField} must be a positive integer`,
    fixture,
    response,
    sourceField,
  );
}

export function optionalDemandRecord(
  record: CatalogJsonRecord,
  field: string,
  fixture: CatalogRecordedStorefrontFixture,
  response: CatalogRecordedStorefrontResponse,
): CatalogJsonRecord | undefined {
  if (!(field in record)) {
    return undefined;
  }
  const value = record[field];
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as CatalogJsonRecord;
  }
  throw storefrontSemanticError(
    catalogRecordedStorefrontDiagnosticCodeValues.parseDrift,
    `DLsite demand.${field} must be a JSON object when present`,
    fixture,
    response,
    field,
  );
}

export function optionalDemandArray(
  record: CatalogJsonRecord,
  field: string,
  fixture: CatalogRecordedStorefrontFixture,
  response: CatalogRecordedStorefrontResponse,
): unknown[] | undefined {
  if (!(field in record)) {
    return undefined;
  }
  const value = record[field];
  if (Array.isArray(value)) {
    return value;
  }
  throw storefrontSemanticError(
    catalogRecordedStorefrontDiagnosticCodeValues.parseDrift,
    `DLsite demand.${field} must be an array when present`,
    fixture,
    response,
    field,
  );
}

export function storefrontSemanticError(
  code: CatalogRecordedStorefrontDiagnosticCode,
  message: string,
  fixture: CatalogRecordedStorefrontFixture,
  response: CatalogRecordedStorefrontResponse,
  sourceField: string,
): CatalogRecordedStorefrontSemanticError {
  const diagnostic: CatalogRecordedStorefrontDiagnostic = {
    code,
    severity: "error",
    fixtureId: fixture.fixtureId,
    sourceRevision: fixture.sourceVersion,
    stepKey: response.stepKey,
    sourceId: response.sourceId,
    sourceField,
    message,
  };
  return new CatalogRecordedStorefrontSemanticError(
    diagnostic,
    `CATALOG-012 semantic diagnostic ${code} fixtureId=${fixture.fixtureId} sourceRevision=${fixture.sourceVersion} stepKey=${response.stepKey} sourceId=${response.sourceId} sourceField=${sourceField}: ${message}`,
  );
}

export function firstString(record: CatalogJsonRecord, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return null;
}
