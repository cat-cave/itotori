import { createHash } from "node:crypto";
import type { AuthorizationActor } from "../authorization.js";
import type {
  CatalogExternalIdInput,
  CatalogJsonRecord,
  CatalogLanguageStatusInput,
  CatalogReleaseInput,
  CatalogSeedTargetInput,
  CatalogWorkInput,
  ItotoriCatalogRepositoryPort,
} from "../repositories/catalog-repository.js";
import {
  catalogConfidenceValues,
  catalogExternalIdKindValues,
  catalogLanguageStatusScopeValues,
  catalogLanguageStatusValues,
  catalogRawContentRedactionClassValues,
  catalogReleaseKindValues,
  catalogSeedOriginValues,
  catalogSeedStatusValues,
  type CatalogConfidence,
  type CatalogExternalIdKind,
  type CatalogLanguageStatus,
  type CatalogLanguageStatusScope,
  type CatalogRawContentRedactionClass,
  type CatalogReleaseKind,
  type CatalogSource,
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

export const catalogRecordedImporterVersion = "catalog-recorded-importers.v0.1" as const;

export const catalogRecordedStorefrontDiagnosticCodeValues = {
  missingDemandField: "missing_demand_field",
  parseDrift: "parse_drift",
  unsupportedResponseShape: "unsupported_response_shape",
} as const;

export type CatalogRecordedStorefrontDiagnosticCode =
  (typeof catalogRecordedStorefrontDiagnosticCodeValues)[keyof typeof catalogRecordedStorefrontDiagnosticCodeValues];

export type CatalogRecordedStorefrontSource = Extract<CatalogSource, "dlsite" | "steam">;

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

type ParsedStorefrontFact = {
  fact: CatalogRecordedImporterFact;
  diagnostics: readonly CatalogRecordedStorefrontDiagnostic[];
};

type StorefrontParser = (
  fixture: CatalogRecordedStorefrontFixture,
  response: CatalogRecordedStorefrontResponse,
) => ParsedStorefrontFact;

const storefrontFactImportContract = {
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

export function createSteamRecordedStorefrontAdapter(
  fixture: CatalogRecordedStorefrontFixture,
): CatalogCrawlerSourceAdapter<CatalogRecordedImporterFact> {
  if (fixture.catalogSource !== "steam") {
    throw new Error(`Steam recorded storefront adapter received ${fixture.catalogSource} fixture`);
  }
  return createRecordedStorefrontAdapter(fixture, parseSteamStorefrontResponse);
}

function createRecordedStorefrontAdapter(
  fixture: CatalogRecordedStorefrontFixture,
  parser: StorefrontParser,
): CatalogCrawlerSourceAdapter<CatalogRecordedImporterFact> {
  validateStorefrontFixture(fixture);
  const steps = fixture.responses.map((response) => {
    const parsed = parser(fixture, response);
    return {
      stepKey: response.stepKey,
      sourceId: response.sourceId,
      requestIdentity: response.requestIdentity,
      fetchedAt: response.fetchedAt,
      checkpointCursor: response.checkpointCursor,
      payload: response.payload,
      facts: [parsed.fact],
      ...(response.httpStatus === undefined ? {} : { httpStatus: response.httpStatus }),
      ...(response.ok === undefined ? {} : { ok: response.ok }),
      ...(response.payloadHash === undefined ? {} : { payloadHash: response.payloadHash }),
      metadata: compactJson({
        ...response.metadata,
        fixtureId: fixture.fixtureId,
        sourceRevision: fixture.sourceVersion,
        parserVersion: fixture.parserVersion,
        diagnostics: parsed.diagnostics,
      }),
      ...(response.rateLimit === undefined ? {} : { rateLimit: response.rateLimit }),
    };
  });
  const replay: RecordedCatalogCrawlerFixture<CatalogRecordedImporterFact> = {
    fixtureId: fixture.fixtureId,
    fixtureName: fixture.fixtureName,
    catalogSource: fixture.catalogSource,
    adapterName: fixture.adapterName,
    adapterVersion: fixture.adapterVersion,
    sourceVersion: fixture.sourceVersion,
    parserVersion: fixture.parserVersion,
    readiness: "alpha_ready",
    factImportContract: storefrontFactImportContract,
    steps,
  };
  if (fixture.partitionKey !== undefined) {
    replay.partitionKey = fixture.partitionKey;
  }
  return createRecordedCatalogCrawlerAdapter(replay);
}

export type CatalogRecordedExternalIdFact = {
  catalogSource?: CatalogSource;
  sourceId: string;
  externalIdKind?: CatalogExternalIdKind;
  confidence?: CatalogConfidence;
  metadata?: CatalogJsonRecord;
};

export type CatalogRecordedReleaseFact = {
  sourceReleaseId?: string;
  releaseTitle: string;
  releaseKind?: CatalogReleaseKind;
  platform?: string;
  language?: string;
  releaseDate?: string;
  releaseYear?: number;
  isOfficial?: boolean;
  metadata?: CatalogJsonRecord;
};

export type CatalogRecordedLanguageStatusFact = {
  language: string;
  status: CatalogLanguageStatus;
  statusScope?: CatalogLanguageStatusScope;
  platform?: string;
  releaseSourceId?: string;
  confidence?: CatalogConfidence;
  isCurrent?: boolean;
  observedAt?: string;
  rawContentRedactionClass?: CatalogRawContentRedactionClass;
  metadata?: CatalogJsonRecord;
};

export type CatalogRecordedSeedTargetFact = {
  originRef?: string;
  status?: CatalogSeedTargetInput["status"];
  priority?: number;
  metadata?: CatalogJsonRecord;
};

export type CatalogRecordedImporterFact = {
  sourceId: string;
  canonicalTitle: string;
  originalLanguage?: string;
  firstReleaseYear?: number;
  workKind?: string;
  titles?: readonly string[];
  externalIds?: readonly CatalogRecordedExternalIdFact[];
  releases?: readonly CatalogRecordedReleaseFact[];
  languageStatuses?: readonly CatalogRecordedLanguageStatusFact[];
  seedTarget?: CatalogRecordedSeedTargetFact | false;
  metadata?: CatalogJsonRecord;
};

function parseDlsiteStorefrontResponse(
  fixture: CatalogRecordedStorefrontFixture,
  response: CatalogRecordedStorefrontResponse,
): ParsedStorefrontFact {
  const payload = response.payload;
  const sourceId = firstString(payload, ["workno", "product_id", "id"]);
  if (sourceId === null) {
    throw storefrontSemanticError(
      catalogRecordedStorefrontDiagnosticCodeValues.parseDrift,
      "DLsite response is missing workno/product_id identity",
      fixture,
      response,
      "workno",
    );
  }
  if (sourceId !== response.sourceId) {
    throw storefrontSemanticError(
      catalogRecordedStorefrontDiagnosticCodeValues.parseDrift,
      `DLsite response source id ${sourceId} does not match fixture source id ${response.sourceId}`,
      fixture,
      response,
      "workno",
    );
  }
  const title = stringField(payload, "title", fixture, response);
  const releaseDate = optionalString(payload, "release_date");
  const releaseYear = releaseDate === undefined ? undefined : yearFromDate(releaseDate);
  const workType = optionalString(payload, "work_type");
  const maker = optionalRecord(payload, "maker");
  const makerName = optionalString(payload, "maker_name") ?? optionalString(maker, "name");
  const translationTree = optionalRecord(payload, "translation_tree");
  const languageIndicators = requiredArray(payload, "language_indicators", fixture, response);
  const demand = optionalRecord(payload, "demand") ?? {};
  const diagnostics = demandDiagnostics(
    fixture,
    response,
    demand,
    ["dl_count", "rating_summary", "rating_histogram", "wishlist_count", "rank_facts"],
    "DLsite",
  );
  const languages = languageIndicators.map((entry, index) =>
    dlsiteLanguageStatus(entry, index, sourceId),
  );
  const primaryLanguage = languages[0]?.language ?? "ja-JP";

  return {
    diagnostics,
    fact: {
      sourceId,
      canonicalTitle: title,
      originalLanguage: primaryLanguage,
      titles: titlesFromPayload(payload, title),
      ...(releaseYear === undefined ? {} : { firstReleaseYear: releaseYear }),
      ...(workType === undefined ? {} : { workKind: workType }),
      externalIds: [
        {
          sourceId,
          externalIdKind: catalogExternalIdKindValues.storeProduct,
          metadata: compactJson({ workno: sourceId, makerName, workType }),
        },
      ],
      releases: [
        compactJson({
          sourceReleaseId: `${sourceId}:dlsite`,
          releaseTitle: title,
          releaseKind: catalogReleaseKindValues.original,
          platform: "dlsite",
          language: primaryLanguage,
          releaseDate,
          releaseYear,
          isOfficial: true,
          metadata: compactJson({
            workno: sourceId,
            makerName,
            workType,
            ageCategory: optionalString(payload, "age_category"),
            translationTree,
          }),
        }) as CatalogRecordedReleaseFact,
      ],
      languageStatuses: languages,
      seedTarget: {
        priority: demandNumber(demand, "dl_count") === undefined ? 15 : 35,
        metadata: compactJson({ demandScope: "dlsite-recorded", dlCount: demandNumber(demand, "dl_count") }),
      },
      metadata: compactJson({
        storefront: "dlsite",
        workno: sourceId,
        releaseMetadata: compactJson({ releaseDate, releaseYear, makerName }),
        workType,
        translationTree,
        demand: compactJson({
          dlCount: demandNumber(demand, "dl_count"),
          ratingSummary: optionalRecord(demand, "rating_summary"),
          ratingHistogram: optionalRecord(demand, "rating_histogram"),
          wishlistCount: demandNumber(demand, "wishlist_count"),
          rankFacts: optionalArray(demand, "rank_facts"),
        }),
        diagnostics,
      }),
    },
  };
}

function parseSteamStorefrontResponse(
  fixture: CatalogRecordedStorefrontFixture,
  response: CatalogRecordedStorefrontResponse,
): ParsedStorefrontFact {
  const payload = response.payload;
  if (payload.success === false) {
    if (payload.delisting_status !== "delisted") {
      throw storefrontSemanticError(
        catalogRecordedStorefrontDiagnosticCodeValues.unsupportedResponseShape,
        "Steam unsuccessful response must declare delisting_status=delisted in recorded fixtures",
        fixture,
        response,
        "success",
      );
    }
    const appId = firstString(payload, ["steam_appid", "appid", "app_id"]) ?? response.sourceId;
    return {
      diagnostics: [],
      fact: {
        sourceId: appId,
        canonicalTitle: optionalString(payload, "name") ?? `Steam app ${appId}`,
        externalIds: [
          {
            sourceId: appId,
            externalIdKind: catalogExternalIdKindValues.storeProduct,
            metadata: { appId, delistingStatus: "delisted" },
          },
        ],
        seedTarget: false,
        metadata: {
          storefront: "steam",
          appId,
          packageStatus: "delisted",
          delistingStatus: "delisted",
          diagnostics: [],
        },
      },
    };
  }

  const data = optionalRecord(payload, "data");
  if (data === undefined || payload.success !== true) {
    throw storefrontSemanticError(
      catalogRecordedStorefrontDiagnosticCodeValues.unsupportedResponseShape,
      "Steam recorded fixture must use appdetails { success: true, data: object } or explicit delisted response",
      fixture,
      response,
      "data",
    );
  }
  const appId = String(numberOrStringField(data, "steam_appid", fixture, response));
  if (appId !== response.sourceId) {
    throw storefrontSemanticError(
      catalogRecordedStorefrontDiagnosticCodeValues.parseDrift,
      `Steam app id ${appId} does not match fixture source id ${response.sourceId}`,
      fixture,
      response,
      "data.steam_appid",
    );
  }
  const title = stringField(data, "name", fixture, response);
  const releaseDate = steamReleaseDate(optionalRecord(data, "release_date"));
  const releaseYear = releaseDate === undefined ? undefined : yearFromDate(releaseDate);
  const languages = steamLanguageStatuses(data, appId);
  const originalLanguage = languages.find((status) => status.language === "ja-JP")?.language ?? languages[0]?.language;
  const packages = optionalArray(data, "packages") ?? [];
  const packageStatus = packages.length === 0 ? "no_packages_recorded" : "packages_recorded";
  const developers = stringArray(data, "developers");
  const publishers = stringArray(data, "publishers");

  return {
    diagnostics: [],
    fact: {
      sourceId: appId,
      canonicalTitle: title,
      ...(originalLanguage === undefined ? {} : { originalLanguage }),
      ...(releaseYear === undefined ? {} : { firstReleaseYear: releaseYear }),
      externalIds: [
        {
          sourceId: appId,
          externalIdKind: catalogExternalIdKindValues.storeProduct,
          metadata: compactJson({ appId, packageStatus, packages }),
        },
      ],
      releases: [
        compactJson({
          sourceReleaseId: `${appId}:steam`,
          releaseTitle: title,
          releaseKind:
            originalLanguage === "ja-JP"
              ? catalogReleaseKindValues.original
              : catalogReleaseKindValues.officialTranslation,
          platform: "steam",
          language: originalLanguage,
          releaseDate,
          releaseYear,
          isOfficial: true,
          metadata: compactJson({ appId, packageStatus, packages, developers, publishers }),
        }) as CatalogRecordedReleaseFact,
      ],
      languageStatuses: languages,
      seedTarget: {
        priority: packageStatus === "packages_recorded" ? 30 : 10,
        metadata: compactJson({ packageStatus, packages }),
      },
      metadata: compactJson({
        storefront: "steam",
        appId,
        releaseMetadata: compactJson({ releaseDate, releaseYear, developers, publishers }),
        localeMetadata: compactJson({
          supportedLanguages: data.supported_languages,
          parsedLocales: languages.map((status) => status.language),
        }),
        packageStatus,
        packages,
        delistingStatus: "listed",
        diagnostics: [],
      }),
    },
  };
}

function validateStorefrontFixture(fixture: CatalogRecordedStorefrontFixture): void {
  requiredString(fixture.fixtureId, "fixture.fixtureId");
  requiredString(fixture.fixtureName, "fixture.fixtureName");
  requiredString(fixture.adapterName, "fixture.adapterName");
  requiredString(fixture.adapterVersion, "fixture.adapterVersion");
  requiredString(fixture.sourceVersion, "fixture.sourceVersion");
  requiredString(fixture.parserVersion, "fixture.parserVersion");
  if (fixture.catalogSource !== "dlsite" && fixture.catalogSource !== "steam") {
    throw new Error(`unsupported recorded storefront source ${String(fixture.catalogSource)}`);
  }
  if (!Array.isArray(fixture.responses) || fixture.responses.length === 0) {
    throw new Error("recorded storefront fixture responses must be a nonempty array");
  }
  for (const [index, response] of fixture.responses.entries()) {
    requiredString(response.stepKey, `fixture.responses[${index}].stepKey`);
    requiredString(response.sourceId, `fixture.responses[${index}].sourceId`);
    requiredString(response.requestIdentity, `fixture.responses[${index}].requestIdentity`);
    requiredString(response.fetchedAt, `fixture.responses[${index}].fetchedAt`);
    if (response.payload === null || typeof response.payload !== "object" || Array.isArray(response.payload)) {
      throw new Error(`fixture.responses[${index}].payload must be a JSON object`);
    }
  }
}

function dlsiteLanguageStatus(
  input: unknown,
  index: number,
  sourceId: string,
): CatalogRecordedLanguageStatusFact {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`DLsite language_indicators[${index}] must be a JSON object`);
  }
  const record = input as CatalogJsonRecord;
  const language = stringFromUnknown(record.locale ?? record.language, `language_indicators[${index}].locale`);
  const status = stringFromUnknown(record.status, `language_indicators[${index}].status`) as CatalogLanguageStatus;
  const statusFact: CatalogRecordedLanguageStatusFact = {
    language,
    status,
    statusScope: catalogLanguageStatusScopeValues.platform,
    platform: "dlsite",
    releaseSourceId: `${sourceId}:dlsite`,
    metadata: compactJson({
      sourceField: "language_indicators",
      localeLabel: optionalString(record, "label"),
      translationRole: optionalString(record, "translation_role"),
    }),
  };
  const confidence = optionalString(record, "confidence");
  if (confidence !== undefined) {
    return {
      ...statusFact,
      confidence: confidence as CatalogConfidence,
    };
  }
  return statusFact;
}

function steamLanguageStatuses(
  data: CatalogJsonRecord,
  appId: string,
): CatalogRecordedLanguageStatusFact[] {
  const raw = data.supported_languages;
  const labels =
    typeof raw === "string"
      ? raw
          .replace(/<[^>]*>/gu, "")
          .split(/[,;]/u)
          .map((value) => value.trim())
          .filter((value) => value.length > 0)
      : stringArray(data, "supported_language_codes");
  const locales = labels.map(steamLocaleFromLabel).filter((value): value is string => value !== null);
  const uniqueLocales = [...new Set(locales)];
  return uniqueLocales.map((language) => ({
    language,
    status: catalogLanguageStatusValues.officialFull,
    statusScope: catalogLanguageStatusScopeValues.platform,
    platform: "steam",
    releaseSourceId: `${appId}:steam`,
    metadata: { sourceField: "supported_languages" },
  }));
}

function demandDiagnostics(
  fixture: CatalogRecordedStorefrontFixture,
  response: CatalogRecordedStorefrontResponse,
  demand: CatalogJsonRecord,
  fields: readonly string[],
  sourceLabel: string,
): CatalogRecordedStorefrontDiagnostic[] {
  return fields
    .filter((field) => demand[field] === undefined)
    .map((field) => ({
      code: catalogRecordedStorefrontDiagnosticCodeValues.missingDemandField,
      severity: "warning",
      fixtureId: fixture.fixtureId,
      sourceRevision: fixture.sourceVersion,
      stepKey: response.stepKey,
      sourceId: response.sourceId,
      sourceField: `demand.${field}`,
      message: `${sourceLabel} recorded response did not include demand.${field}`,
    }));
}

function storefrontSemanticError(
  code: CatalogRecordedStorefrontDiagnosticCode,
  message: string,
  fixture: CatalogRecordedStorefrontFixture,
  response: CatalogRecordedStorefrontResponse,
  sourceField?: string,
): Error {
  const field = sourceField === undefined ? "" : ` sourceField=${sourceField}`;
  return new Error(
    `CATALOG-012 semantic diagnostic ${code} fixtureId=${fixture.fixtureId} sourceRevision=${fixture.sourceVersion} stepKey=${response.stepKey} sourceId=${response.sourceId}${field}: ${message}`,
  );
}

function firstString(record: CatalogJsonRecord, keys: readonly string[]): string | null {
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

function stringField(
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

function numberOrStringField(
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

function optionalString(record: CatalogJsonRecord | undefined, field: string): string | undefined {
  const value = record?.[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalRecord(record: CatalogJsonRecord, field: string): CatalogJsonRecord | undefined {
  const value = record[field];
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as CatalogJsonRecord)
    : undefined;
}

function requiredArray(
  record: CatalogJsonRecord,
  field: string,
  fixture: CatalogRecordedStorefrontFixture,
  response: CatalogRecordedStorefrontResponse,
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
    field,
  );
}

function optionalArray(record: CatalogJsonRecord, field: string): unknown[] | undefined {
  const value = record[field];
  return Array.isArray(value) ? value : undefined;
}

function stringArray(record: CatalogJsonRecord, field: string): string[] {
  return (optionalArray(record, field) ?? []).filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

function titlesFromPayload(payload: CatalogJsonRecord, canonicalTitle: string): string[] {
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

function yearFromDate(date: string): number | undefined {
  const match = /^(\d{4})/u.exec(date);
  return match === null ? undefined : Number(match[1]);
}

function demandNumber(record: CatalogJsonRecord, field: string): number | undefined {
  const value = record[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function steamReleaseDate(releaseDate: CatalogJsonRecord | undefined): string | undefined {
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

function steamLocaleFromLabel(label: string): string | null {
  const normalized = label.toLowerCase().replace(/\s*\*+\s*$/u, "").trim();
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

function stringFromUnknown(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
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
    for (const [index, fact] of context.facts.entries()) {
      const snapshot = await options.catalogRepository.getWorkByExternalId(
        options.actor,
        context.adapter.catalogSource,
        fact.sourceId,
        catalogExternalIdKindValues.sourceRecord,
      );
      const sourceRecord = snapshot?.externalIds.find(
        (externalId) =>
          externalId.catalogSource === context.adapter.catalogSource &&
          externalId.sourceId === fact.sourceId &&
          externalId.externalIdKind === catalogExternalIdKindValues.sourceRecord,
      );
      if (
        snapshot === null ||
        snapshot === undefined ||
        sourceRecord === undefined ||
        metadataString(sourceRecord.metadata, "stableImportKey") !== context.stableImportKey ||
        metadataString(sourceRecord.metadata, "importTransactionId") !== context.importTransactionId
      ) {
        return null;
      }
      persistedIdentities.push(context.expectedFactIdentities[index] ?? "");
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

async function importRecordedCatalogFact(
  catalogRepository: ItotoriCatalogRepositoryPort,
  actor: AuthorizationActor,
  context: CatalogCrawlerIngestContext<CatalogRecordedImporterFact>,
  fact: CatalogRecordedImporterFact,
): Promise<void> {
  assertFact(fact);
  const sourceProvenanceId = context.step.sourceProvenanceId;
  const importMetadata = importerMetadata(context, fact);
  const releaseIdsBySourceId = new Map<string, string>();
  for (const release of fact.releases ?? []) {
    if (release.sourceReleaseId !== undefined) {
      releaseIdsBySourceId.set(
        release.sourceReleaseId,
        stableCatalogId("catalog-release", [
          context.adapter.catalogSource,
          fact.sourceId,
          release.sourceReleaseId,
        ]),
      );
    }
  }

  const workInput: CatalogWorkInput = {
    workId: stableCatalogId("catalog-work", [context.adapter.catalogSource, fact.sourceId]),
    canonicalTitle: fact.canonicalTitle,
    metadata: compactJson({
      ...fact.metadata,
      ...importMetadata,
      alternateTitles: fact.titles ?? [],
    }),
    externalIds: externalIdInputs(context, fact, importMetadata, sourceProvenanceId),
    releases: releaseInputs(context, fact, importMetadata, sourceProvenanceId),
    languageStatuses: languageStatusInputs(
      context,
      fact,
      importMetadata,
      sourceProvenanceId,
      releaseIdsBySourceId,
    ),
  };
  if (fact.originalLanguage !== undefined) {
    workInput.originalLanguage = fact.originalLanguage;
  }
  if (fact.firstReleaseYear !== undefined) {
    workInput.firstReleaseYear = fact.firstReleaseYear;
  }
  if (fact.workKind !== undefined) {
    workInput.workKind = fact.workKind;
  }

  await catalogRepository.upsertWork(actor, workInput);

  if (fact.seedTarget !== false) {
    await catalogRepository.recordSeedTarget(actor, seedTargetInput(context, fact, importMetadata));
  }
}

function externalIdInputs(
  context: CatalogCrawlerIngestContext<CatalogRecordedImporterFact>,
  fact: CatalogRecordedImporterFact,
  importMetadata: CatalogJsonRecord,
  sourceProvenanceId: string,
): CatalogExternalIdInput[] {
  const inputs = new Map<string, CatalogExternalIdInput>();
  const add = (input: CatalogExternalIdInput) => {
    inputs.set(
      `${input.catalogSource}:${input.sourceId}:${input.externalIdKind ?? catalogExternalIdKindValues.sourceRecord}`,
      input,
    );
  };

  add({
    externalIdId: stableCatalogId("catalog-external-id", [
      context.adapter.catalogSource,
      fact.sourceId,
      catalogExternalIdKindValues.sourceRecord,
    ]),
    catalogSource: context.adapter.catalogSource,
    sourceId: fact.sourceId,
    externalIdKind: catalogExternalIdKindValues.sourceRecord,
    sourceProvenanceId,
    discoveredAt: context.step.fetchedAt,
    metadata: importMetadata,
  });

  for (const externalId of fact.externalIds ?? []) {
    const externalIdKind = externalId.externalIdKind ?? catalogExternalIdKindValues.sourceRecord;
    const catalogSource = externalId.catalogSource ?? context.adapter.catalogSource;
    const input: CatalogExternalIdInput = {
      externalIdId: stableCatalogId("catalog-external-id", [
        catalogSource,
        externalId.sourceId,
        externalIdKind,
      ]),
      catalogSource,
      sourceId: externalId.sourceId,
      externalIdKind,
      sourceProvenanceId,
      discoveredAt: context.step.fetchedAt,
      metadata: compactJson({ ...externalId.metadata, ...importMetadata }),
    };
    if (externalId.confidence !== undefined) {
      input.confidence = externalId.confidence;
    }
    add(input);
  }
  return [...inputs.values()];
}

function releaseInputs(
  context: CatalogCrawlerIngestContext<CatalogRecordedImporterFact>,
  fact: CatalogRecordedImporterFact,
  importMetadata: CatalogJsonRecord,
  sourceProvenanceId: string,
): CatalogReleaseInput[] {
  return (fact.releases ?? []).map((release, index) => {
    const sourceReleaseId = release.sourceReleaseId ?? `${fact.sourceId}:release:${index}`;
    const input: CatalogReleaseInput = {
      releaseId: stableCatalogId("catalog-release", [
        context.adapter.catalogSource,
        fact.sourceId,
        sourceReleaseId,
      ]),
      catalogSource: context.adapter.catalogSource,
      sourceReleaseId,
      releaseTitle: release.releaseTitle,
      releaseKind: release.releaseKind ?? catalogReleaseKindValues.unknown,
      sourceProvenanceId,
      metadata: compactJson({ ...release.metadata, ...importMetadata }),
    };
    if (release.platform !== undefined) {
      input.platform = release.platform;
    }
    if (release.language !== undefined) {
      input.language = release.language;
    }
    if (release.releaseDate !== undefined) {
      input.releaseDate = release.releaseDate;
    }
    if (release.releaseYear !== undefined) {
      input.releaseYear = release.releaseYear;
    }
    if (release.isOfficial !== undefined) {
      input.isOfficial = release.isOfficial;
    }
    return input;
  });
}

function languageStatusInputs(
  context: CatalogCrawlerIngestContext<CatalogRecordedImporterFact>,
  fact: CatalogRecordedImporterFact,
  importMetadata: CatalogJsonRecord,
  sourceProvenanceId: string,
  releaseIdsBySourceId: ReadonlyMap<string, string>,
): CatalogLanguageStatusInput[] {
  return (fact.languageStatuses ?? []).map((status) => {
    const input: CatalogLanguageStatusInput = {
      languageStatusId: stableCatalogId("catalog-language-status", [
        context.adapter.catalogSource,
        fact.sourceId,
        status.language,
        status.statusScope ?? catalogLanguageStatusScopeValues.work,
        status.platform ?? "",
        status.releaseSourceId ?? "",
      ]),
      language: status.language,
      status: status.status,
      statusScope: status.statusScope ?? catalogLanguageStatusScopeValues.work,
      sourceProvenanceId,
      confidence: status.confidence ?? catalogConfidenceValues.high,
      observedAt: status.observedAt ?? context.step.fetchedAt,
      importedAt: context.step.fetchedAt,
      parserVersion: context.adapter.parserVersion,
      rawContentRedactionClass:
        status.rawContentRedactionClass ?? catalogRawContentRedactionClassValues.publicMetadata,
      metadata: compactJson({ ...status.metadata, ...importMetadata }),
    };
    if (status.platform !== undefined) {
      input.platform = status.platform;
    }
    if (status.releaseSourceId !== undefined) {
      const releaseId = releaseIdsBySourceId.get(status.releaseSourceId);
      if (releaseId !== undefined) {
        input.releaseId = releaseId;
      }
    }
    if (status.isCurrent !== undefined) {
      input.isCurrent = status.isCurrent;
    }
    return input;
  });
}

function seedTargetInput(
  context: CatalogCrawlerIngestContext<CatalogRecordedImporterFact>,
  fact: CatalogRecordedImporterFact,
  importMetadata: CatalogJsonRecord,
): CatalogSeedTargetInput {
  const seedTarget = fact.seedTarget === false ? undefined : fact.seedTarget;
  return {
    seedTargetId: stableCatalogId("catalog-seed-target", [
      context.adapter.catalogSource,
      fact.sourceId,
      catalogSeedOriginValues.importer,
      seedTarget?.originRef ?? context.adapter.fixtureId ?? context.adapter.adapterName,
    ]),
    catalogSource: context.adapter.catalogSource,
    sourceId: fact.sourceId,
    seedOrigin: catalogSeedOriginValues.importer,
    originRef: seedTarget?.originRef ?? context.adapter.fixtureId ?? context.adapter.adapterName,
    sourceProvenanceId: context.step.sourceProvenanceId,
    status: seedTarget?.status ?? catalogSeedStatusValues.pending,
    priority: seedTarget?.priority ?? 0,
    addedAt: context.step.fetchedAt,
    metadata: compactJson({ ...seedTarget?.metadata, ...importMetadata }),
  };
}

function factImportProof(
  context: CatalogCrawlerIngestContext<CatalogRecordedImporterFact>,
): CatalogCrawlerFactImportProof {
  return {
    stableImportKey: context.stableImportKey,
    strategy: catalogCrawlerFactImportStrategyValues.upsert,
    factCount: context.facts.length,
    factIdentities: context.expectedFactIdentities,
  };
}

function importerMetadata(
  context: CatalogCrawlerIngestContext<CatalogRecordedImporterFact>,
  fact: CatalogRecordedImporterFact,
): CatalogJsonRecord {
  return compactJson({
    catalogSource: context.adapter.catalogSource,
    sourceId: fact.sourceId,
    sourceVersion: context.adapter.sourceVersion,
    parserVersion: context.adapter.parserVersion,
    importerVersion: catalogRecordedImporterVersion,
    adapterName: context.adapter.adapterName,
    fixtureId: context.adapter.fixtureId,
    stableImportKey: context.stableImportKey,
    importTransactionId: context.importTransactionId,
    requestIdentity: context.step.requestIdentity,
    fetchedAt: context.step.fetchedAt.toISOString(),
    sourceProvenanceId: context.step.sourceProvenanceId,
  });
}

function stableCatalogId(namespace: string, parts: readonly string[]): string {
  return `${namespace}:${sha256(stableJsonStringify(parts)).slice(0, 32)}`;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function stableJsonStringify(input: unknown): string {
  if (input === undefined) {
    return "undefined";
  }
  if (input === null || typeof input !== "object") {
    return JSON.stringify(input) ?? "undefined";
  }
  if (Array.isArray(input)) {
    return `[${input.map((value) => stableJsonStringify(value)).join(",")}]`;
  }
  const entries = Object.entries(input as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return `{${entries
    .map(([key, value]) => `${JSON.stringify(key)}:${stableJsonStringify(value)}`)
    .join(",")}}`;
}

function compactJson(input: CatalogJsonRecord): CatalogJsonRecord {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function metadataString(metadata: CatalogJsonRecord, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertFact(fact: CatalogRecordedImporterFact): void {
  requiredString(fact.sourceId, "fact.sourceId");
  requiredString(fact.canonicalTitle, "fact.canonicalTitle");
  for (const externalId of fact.externalIds ?? []) {
    requiredString(externalId.sourceId, "fact.externalIds[].sourceId");
  }
  for (const release of fact.releases ?? []) {
    requiredString(release.releaseTitle, "fact.releases[].releaseTitle");
  }
  for (const status of fact.languageStatuses ?? []) {
    requiredString(status.language, "fact.languageStatuses[].language");
  }
}

function requiredString(value: string | undefined, fieldName: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${fieldName} is required`);
  }
  return value;
}
