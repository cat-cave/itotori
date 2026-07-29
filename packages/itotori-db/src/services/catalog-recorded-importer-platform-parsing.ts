import type { AuthorizationActor } from "../authorization.js";
import type {
  CatalogJsonRecord,
  ItotoriCatalogRepositoryPort,
} from "../repositories/catalog-repository.js";
import { catalogExternalIdKindValues } from "../schema.js";
import {
  type CatalogCrawlerFactImportEvidence,
  type CatalogCrawlerIngestStep,
  type CatalogCrawlerVerifyFactImportStep,
} from "./catalog-crawler-runner.js";

import {
  type CatalogRecordedPlatformDiagnosticCode,
  type CatalogRecordedPlatformFixture,
  type CatalogRecordedPlatformResponse,
  catalogRecordedStorefrontDiagnosticCodeValues,
  type CatalogRecordedStorefrontFixture,
  type CatalogRecordedStorefrontResponse,
} from "./catalog-recorded-importer-types.js";
import { type CatalogRecordedImporterFact } from "./catalog-recorded-importer-dlsite.js";
import { storefrontSemanticError } from "./catalog-recorded-importer-demand-parsing.js";
import { optionalString } from "./catalog-recorded-importer-payload-parsing.js";
import { importRecordedCatalogFact } from "./catalog-recorded-importer-ingest-wiring.js";
import {
  factImportProof,
  metadataString,
  persistedFactIdentity,
  sameStringList,
} from "./catalog-recorded-importer-utils.js";

export function platformRecordFromUnknown(
  value: unknown,
  label: string,
  fixture: CatalogRecordedPlatformFixture,
  response: CatalogRecordedPlatformResponse,
): CatalogJsonRecord {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as CatalogJsonRecord;
  }
  throw platformSemanticError(
    "parse_drift",
    `${label} must be a JSON object`,
    fixture,
    response,
    label,
  );
}

export function platformString(
  record: CatalogJsonRecord,
  field: string,
  fixture: CatalogRecordedPlatformFixture,
  response: CatalogRecordedPlatformResponse,
): string {
  const value = record[field];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  throw platformSemanticError(
    "parse_drift",
    `recorded platform response is missing required string field ${field}`,
    fixture,
    response,
    field,
  );
}

export function platformNumberOrString(
  record: CatalogJsonRecord,
  field: string,
  fixture: CatalogRecordedPlatformFixture,
  response: CatalogRecordedPlatformResponse,
): string | number {
  const value = record[field];
  if (
    (typeof value === "string" && value.length > 0) ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  throw platformSemanticError(
    "parse_drift",
    `recorded platform response is missing required string/number field ${field}`,
    fixture,
    response,
    field,
  );
}

export function labelValue(labels: CatalogJsonRecord, locale: string): string | undefined {
  const label = labels[locale];
  if (typeof label === "string" && label.length > 0) {
    return label;
  }
  if (label !== null && typeof label === "object" && !Array.isArray(label)) {
    return optionalString(label as CatalogJsonRecord, "value");
  }
  return undefined;
}

export function platformEnumStringField<TValue extends string>(
  value: unknown,
  allowed: readonly TValue[],
  label: string,
  fixture: CatalogRecordedPlatformFixture,
  response: CatalogRecordedPlatformResponse,
): TValue {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as TValue;
  }
  throw platformSemanticError(
    "parse_drift",
    `${label} must be one of ${allowed.join(", ")}`,
    fixture,
    response,
    label,
  );
}

export function platformSemanticError(
  code: CatalogRecordedPlatformDiagnosticCode,
  message: string,
  fixture: CatalogRecordedPlatformFixture,
  response: CatalogRecordedPlatformResponse,
  sourceField?: string,
): Error {
  const field = sourceField === undefined ? "" : ` sourceField=${sourceField}`;
  return new Error(
    `CATALOG-013 semantic diagnostic ${code} fixtureId=${fixture.fixtureId} sourceRevision=${fixture.sourceVersion} stepKey=${response.stepKey} sourceId=${response.sourceId}${field}: ${message}`,
  );
}

export function requiredStringFromUnknown(
  value: unknown,
  label: string,
  fixture: CatalogRecordedStorefrontFixture,
  response: CatalogRecordedStorefrontResponse,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw storefrontSemanticError(
      catalogRecordedStorefrontDiagnosticCodeValues.parseDrift,
      `${label} is required`,
      fixture,
      response,
      label,
    );
  }
  return value;
}

export function enumStringField<TValue extends string>(
  value: unknown,
  allowed: readonly TValue[],
  label: string,
  fixture: CatalogRecordedStorefrontFixture,
  response: CatalogRecordedStorefrontResponse,
): TValue {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as TValue;
  }
  throw storefrontSemanticError(
    catalogRecordedStorefrontDiagnosticCodeValues.parseDrift,
    `${label} must be one of ${allowed.join(", ")}`,
    fixture,
    response,
    label,
  );
}

export function optionalEnumStringField<TValue extends string>(
  value: unknown,
  allowed: readonly TValue[],
  label: string,
  fixture: CatalogRecordedStorefrontFixture,
  response: CatalogRecordedStorefrontResponse,
): TValue | undefined {
  if (value === undefined) {
    return undefined;
  }
  return enumStringField(value, allowed, label, fixture, response);
}

export type CatalogRecordedImporterOptions = {
  catalogRepository: ItotoriCatalogRepositoryPort;
  actor: AuthorizationActor;
};

export function createCatalogRecordedImporterIngestStep(
  options: CatalogRecordedImporterOptions,
): CatalogCrawlerIngestStep<CatalogRecordedImporterFact> {
  return async (context) => {
    for (const fact of context.facts) {
      await importRecordedCatalogFact(options.catalogRepository, options.actor, context, fact);
    }
    return factImportProof(context);
  };
}

export function createCatalogRecordedImporterVerifier(
  options: CatalogRecordedImporterOptions,
): CatalogCrawlerVerifyFactImportStep<CatalogRecordedImporterFact> {
  return async (context) => {
    const persistedIdentities: string[] = [];
    for (const fact of context.facts) {
      const snapshot = await options.catalogRepository.getWorkByExternalId(
        options.actor,
        context.adapter.catalogSource,
        fact.sourceId,
        catalogExternalIdKindValues.sourceRecord,
      );
      // Locate the source record this import actually persisted via its import
      // provenance metadata — NOT by filtering on the expected sourceId — so the
      // identity reconstructed below reflects what is stored in the repository
      // and the comparison against expectedFactIdentities can genuinely diverge.
      const sourceRecord = snapshot?.externalIds.find(
        (externalId) =>
          externalId.catalogSource === context.adapter.catalogSource &&
          externalId.externalIdKind === catalogExternalIdKindValues.sourceRecord &&
          metadataString(externalId.metadata, "stableImportKey") === context.stableImportKey &&
          metadataString(externalId.metadata, "importTransactionId") ===
            context.importTransactionId,
      );
      if (snapshot === null || snapshot === undefined || sourceRecord === undefined) {
        return null;
      }
      persistedIdentities.push(persistedFactIdentity(sourceRecord));
    }

    if (!sameStringList(persistedIdentities, context.expectedFactIdentities)) {
      return null;
    }

    return {
      ...factImportProof(context),
      persisted: true,
    } satisfies CatalogCrawlerFactImportEvidence;
  };
}
