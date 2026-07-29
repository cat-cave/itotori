import type { CatalogJsonRecord } from "../repositories/catalog-repository.js";
import {
  type CatalogConfidence,
  type CatalogLanguageStatus,
  type CatalogLanguageStatusScope,
  type CatalogRawContentRedactionClass,
  type CatalogSource,
} from "../schema.js";
import {
  catalogCrawlerFactImportStrategyValues,
  catalogCrawlerIdempotentFactImportContractId,
  type CatalogCrawlerFactImportContract,
  type CatalogCrawlerRateLimitMetadata,
  type CatalogCrawlerSourceAdapter,
} from "./catalog-crawler-runner.js";

import {
  type CatalogRecordedLanguageStatusFact,
  type CatalogRecordedReleaseFact,
  type CatalogRecordedReleaseMappingFact,
  createRecordedStorefrontAdapter,
} from "./catalog-recorded-importers-02.js";
import {
  type CatalogRecordedImporterFact,
  parseDlsiteStorefrontResponse,
} from "./catalog-recorded-importers-03.js";

export const catalogRecordedImporterVersion = "catalog-recorded-importers.v0.1" as const;

export const catalogRecordedStorefrontDiagnosticCodeValues = {
  missingDemandField: "missing_demand_field",
  parseDrift: "parse_drift",
  unsupportedResponseShape: "unsupported_response_shape",
} as const;

export type CatalogRecordedStorefrontDiagnosticCode =
  (typeof catalogRecordedStorefrontDiagnosticCodeValues)[keyof typeof catalogRecordedStorefrontDiagnosticCodeValues];

export type CatalogRecordedStorefrontSource = Extract<CatalogSource, "dlsite" | "steam">;
export type CatalogRecordedPlatformSource = Extract<CatalogSource, "igdb" | "wikidata">;

export type CatalogRecordedStorefrontDiagnostic = {
  code: CatalogRecordedStorefrontDiagnosticCode;
  severity: "info" | "warning" | "error";
  fixtureId: string;
  sourceRevision: string;
  stepKey: string;
  sourceId: string;
  sourceField?: string;
  message: string;
};

// Thrown when a recorded storefront response has an unsupported/unexpected
// shape (parse drift). The error carries the FULL structured semantic
// diagnostic (fixtureId/sourceRevision/stepKey/sourceId/sourceField), so
// callers and tests can assert on the metadata directly instead of scraping
// the formatted message string.
export class CatalogRecordedStorefrontSemanticError extends Error {
  readonly diagnostic: CatalogRecordedStorefrontDiagnostic;
  constructor(diagnostic: CatalogRecordedStorefrontDiagnostic, message: string) {
    super(message);
    this.name = "CatalogRecordedStorefrontSemanticError";
    this.diagnostic = diagnostic;
  }
}

export type CatalogRecordedStorefrontResponse = {
  stepKey: string;
  sourceId: string;
  requestIdentity: string;
  fetchedAt: string;
  checkpointCursor: unknown | null;
  httpStatus?: number;
  ok?: boolean;
  payloadHash?: string;
  payload: CatalogJsonRecord;
  metadata?: CatalogJsonRecord;
  rateLimit?: CatalogCrawlerRateLimitMetadata;
};

export type CatalogRecordedStorefrontFixture = {
  fixtureId: string;
  fixtureName: string;
  catalogSource: CatalogRecordedStorefrontSource;
  adapterName: string;
  adapterVersion: string;
  sourceVersion: string;
  parserVersion: string;
  partitionKey?: string;
  responses: readonly CatalogRecordedStorefrontResponse[];
};

export type ParsedStorefrontFact = {
  fact: CatalogRecordedImporterFact;
  diagnostics: readonly CatalogRecordedStorefrontDiagnostic[];
};

export type NormalizedDlsiteStorefrontPayload = {
  sourceId: string;
  title: string;
  releaseDate?: string;
  workType?: string;
  makerName?: string;
  translationInfo: CatalogJsonRecord;
  originalWorkno: string;
  languageStatuses: CatalogRecordedLanguageStatusFact[];
  editionReleases: CatalogRecordedReleaseFact[];
  releaseMappings: CatalogRecordedReleaseMappingFact[];
  mappingDiagnostics: CatalogRecordedStorefrontDiagnostic[];
  demand: CatalogJsonRecord;
};

export type DlsiteEdition = {
  index: number;
  workno: string;
  language: string;
  label?: string;
  status: CatalogLanguageStatus;
  statusScope: CatalogLanguageStatusScope;
  translationRole?: string;
  confidence?: CatalogConfidence;
  rawContentRedactionClass?: CatalogRawContentRedactionClass;
};

// DLsite translation_info roles that denote a real derived translation (child of
// the original workno) — each maps to a first-class translation_of relation.
export const dlsiteTranslationRoles = new Set([
  "official_translation",
  "fan_translation",
  "translation",
]);
// Roles that denote the original edition or a not-yet-published placeholder — no
// parent-child mapping is emitted for these.
export const dlsiteNonMappingRoles = new Set(["original", "missing_storefront_indicator"]);

export type SteamLanguageStatusParseResult = {
  statuses: CatalogRecordedLanguageStatusFact[];
  diagnostics: CatalogRecordedStorefrontDiagnostic[];
  unknownLocaleLabels: string[];
};

export type StorefrontParser = (
  fixture: CatalogRecordedStorefrontFixture,
  response: CatalogRecordedStorefrontResponse,
) => ParsedStorefrontFact;

export type CatalogRecordedPlatformResponse = {
  stepKey: string;
  sourceId: string;
  requestIdentity: string;
  fetchedAt: string;
  checkpointCursor: unknown | null;
  httpStatus?: number;
  ok?: boolean;
  payloadHash?: string;
  payload: CatalogJsonRecord;
  metadata?: CatalogJsonRecord;
  rateLimit?: CatalogCrawlerRateLimitMetadata;
};

export type CatalogRecordedPlatformFixture = {
  fixtureId: string;
  fixtureName: string;
  catalogSource: CatalogRecordedPlatformSource;
  adapterName: string;
  adapterVersion: string;
  sourceVersion: string;
  parserVersion: string;
  partitionKey?: string;
  responses: readonly CatalogRecordedPlatformResponse[];
};

export type PlatformParser = (
  fixture: CatalogRecordedPlatformFixture,
  response: CatalogRecordedPlatformResponse,
) => ParsedStorefrontFact;

export const catalogRecordedPlatformDiagnosticCodeValues = {
  parseDrift: "parse_drift",
  unsupportedResponseShape: "unsupported_response_shape",
} as const;

export type CatalogRecordedPlatformDiagnosticCode =
  (typeof catalogRecordedPlatformDiagnosticCodeValues)[keyof typeof catalogRecordedPlatformDiagnosticCodeValues];

export type CatalogRecordedSourceFactKind =
  | "platform"
  | "release"
  | "language_status"
  | "external_id"
  | "entity_link";

export const storefrontFactImportContract = {
  contractId: catalogCrawlerIdempotentFactImportContractId,
  strategy: catalogCrawlerFactImportStrategyValues.upsert,
  factIdentity: ["catalogSource", "sourceId"],
  replayValidation: [
    "sourceId",
    "fixtureId",
    "stableImportKey",
    "importTransactionId",
    "factCount",
    "factIdentities",
  ],
} as const satisfies CatalogCrawlerFactImportContract;

export function createDlsiteRecordedStorefrontAdapter(
  fixture: CatalogRecordedStorefrontFixture,
): CatalogCrawlerSourceAdapter<CatalogRecordedImporterFact> {
  if (fixture.catalogSource !== "dlsite") {
    throw new Error(`DLsite recorded storefront adapter received ${fixture.catalogSource} fixture`);
  }
  return createRecordedStorefrontAdapter(fixture, parseDlsiteStorefrontResponse);
}
