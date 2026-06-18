import { createHash } from "node:crypto";
import type { AuthorizationActor } from "../authorization.js";
import type {
  CatalogConflictInput,
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
  catalogConflictKindValues,
  catalogConflictStatusValues,
  catalogConflictSubjectKindValues,
  catalogExternalIdKindValues,
  catalogLanguageStatusScopeValues,
  catalogLanguageStatusValues,
  catalogRawContentRedactionClassValues,
  catalogReleaseKindValues,
  catalogSeedOriginValues,
  catalogSeedStatusValues,
  type CatalogConfidence,
  type CatalogConflictKind,
  type CatalogConflictStatus,
  type CatalogConflictSubjectKind,
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

type NormalizedDlsiteStorefrontPayload = {
  sourceId: string;
  title: string;
  releaseDate?: string;
  workType?: string;
  makerName?: string;
  translationInfo: CatalogJsonRecord;
  languageStatuses: CatalogRecordedLanguageStatusFact[];
  demand: CatalogJsonRecord;
};

type SteamLanguageStatusParseResult = {
  statuses: CatalogRecordedLanguageStatusFact[];
  diagnostics: CatalogRecordedStorefrontDiagnostic[];
  unknownLocaleLabels: string[];
};

type StorefrontParser = (
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

type PlatformParser = (
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

export function createIgdbRecordedPlatformAdapter(
  fixture: CatalogRecordedPlatformFixture,
): CatalogCrawlerSourceAdapter<CatalogRecordedImporterFact> {
  if (fixture.catalogSource !== "igdb") {
    throw new Error(`IGDB recorded platform adapter received ${fixture.catalogSource} fixture`);
  }
  return createRecordedPlatformAdapter(fixture, parseIgdbPlatformResponse);
}

export function createWikidataRecordedPlatformAdapter(
  fixture: CatalogRecordedPlatformFixture,
): CatalogCrawlerSourceAdapter<CatalogRecordedImporterFact> {
  if (fixture.catalogSource !== "wikidata") {
    throw new Error(`Wikidata recorded platform adapter received ${fixture.catalogSource} fixture`);
  }
  return createRecordedPlatformAdapter(fixture, parseWikidataPlatformResponse);
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

function createRecordedPlatformAdapter(
  fixture: CatalogRecordedPlatformFixture,
  parser: PlatformParser,
): CatalogCrawlerSourceAdapter<CatalogRecordedImporterFact> {
  validatePlatformFixture(fixture);
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

export type CatalogRecordedConflictEvidenceFact = {
  subjectKind?: CatalogConflictSubjectKind;
  subjectId?: string;
  evidencePosition?: number;
  metadata?: CatalogJsonRecord;
};

export type CatalogRecordedConflictFact = {
  conflictId?: string;
  conflictKind?: CatalogConflictKind;
  status?: CatalogConflictStatus;
  summary: string;
  reasonCode?: string;
  severity?: "info" | "warning" | "critical";
  detectedAt?: string;
  metadata?: CatalogJsonRecord;
  evidence?: readonly CatalogRecordedConflictEvidenceFact[];
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
  conflicts?: readonly CatalogRecordedConflictFact[];
  seedTarget?: CatalogRecordedSeedTargetFact | false;
  metadata?: CatalogJsonRecord;
};

function parseDlsiteStorefrontResponse(
  fixture: CatalogRecordedStorefrontFixture,
  response: CatalogRecordedStorefrontResponse,
): ParsedStorefrontFact {
  const normalized = normalizeDlsiteStorefrontPayload(fixture, response);
  const sourceId = normalized.sourceId;
  const title = normalized.title;
  const releaseDate = normalized.releaseDate;
  const releaseYear = releaseDate === undefined ? undefined : yearFromDate(releaseDate);
  const workType = normalized.workType;
  const makerName = normalized.makerName;
  const translationInfo = normalized.translationInfo;
  const demand = normalized.demand;
  const diagnostics = demandDiagnostics(
    fixture,
    response,
    demand,
    ["dl_count", "rating_summary", "rating_histogram", "wishlist_count", "rank_facts"],
    "DLsite",
  );
  const languages = normalized.languageStatuses;
  const primaryLanguage = languages[0]?.language ?? "ja-JP";

  return {
    diagnostics,
    fact: {
      sourceId,
      canonicalTitle: title,
      originalLanguage: primaryLanguage,
      titles: titlesFromPayload(response.payload, title),
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
            ageCategory: optionalString(response.payload, "age_category"),
            translationInfo,
          }),
        }) as CatalogRecordedReleaseFact,
      ],
      languageStatuses: languages,
      seedTarget: false,
      metadata: compactJson({
        storefront: "dlsite",
        workno: sourceId,
        releaseMetadata: compactJson({ releaseDate, releaseYear, makerName }),
        workType,
        translationInfo,
        translationTree: translationInfo,
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
  const { envelopeKey, appdetails } = unwrapSteamAppdetailsEnvelope(fixture, response);
  if (appdetails.success === false) {
    if (appdetails.delisting_status !== "delisted") {
      throw storefrontSemanticError(
        catalogRecordedStorefrontDiagnosticCodeValues.unsupportedResponseShape,
        "Steam unsuccessful response must declare delisting_status=delisted in recorded fixtures",
        fixture,
        response,
        `${envelopeKey}.success`,
      );
    }
    const appId = firstString(appdetails, ["steam_appid", "appid", "app_id"]) ?? envelopeKey;
    if (appId !== response.sourceId) {
      throw storefrontSemanticError(
        catalogRecordedStorefrontDiagnosticCodeValues.parseDrift,
        `Steam unsuccessful app id ${appId} does not match fixture source id ${response.sourceId}`,
        fixture,
        response,
        `${envelopeKey}.steam_appid`,
      );
    }
    return {
      diagnostics: [],
      fact: {
        sourceId: appId,
        canonicalTitle: optionalString(appdetails, "name") ?? `Steam app ${appId}`,
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

  const data = optionalRecord(appdetails, "data");
  if (data === undefined || appdetails.success !== true) {
    throw storefrontSemanticError(
      catalogRecordedStorefrontDiagnosticCodeValues.unsupportedResponseShape,
      "Steam recorded fixture must use appdetails envelope { [appId]: { success: true, data: object } } or explicit delisted response",
      fixture,
      response,
      `${envelopeKey}.data`,
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
  const languageParse = steamLanguageStatuses(data, appId, fixture, response);
  const languages = languageParse.statuses;
  const originalLanguage =
    languages.find((status) => status.language === "ja-JP")?.language ?? languages[0]?.language;
  const packages = optionalArray(data, "packages") ?? [];
  const packageStatus = packages.length === 0 ? "no_packages_recorded" : "packages_recorded";
  const developers = stringArray(data, "developers");
  const publishers = stringArray(data, "publishers");

  return {
    diagnostics: languageParse.diagnostics,
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
      seedTarget: false,
      metadata: compactJson({
        storefront: "steam",
        appId,
        releaseMetadata: compactJson({ releaseDate, releaseYear, developers, publishers }),
        localeMetadata: compactJson({
          supportedLanguages: data.supported_languages,
          parsedLocales: languages.map((status) => status.language),
          unknownLocaleLabels: languageParse.unknownLocaleLabels,
        }),
        packageStatus,
        packages,
        delistingStatus: "listed",
        diagnostics: languageParse.diagnostics,
      }),
    },
  };
}

function parseIgdbPlatformResponse(
  fixture: CatalogRecordedPlatformFixture,
  response: CatalogRecordedPlatformResponse,
): ParsedStorefrontFact {
  const payload = response.payload;
  const sourceId = String(platformNumberOrString(payload, "id", fixture, response));
  if (sourceId !== response.sourceId) {
    throw platformSemanticError(
      "parse_drift",
      `IGDB game id ${sourceId} does not match fixture source id ${response.sourceId}`,
      fixture,
      response,
      "id",
    );
  }
  const title = platformString(payload, "name", fixture, response);
  const firstReleaseDate = platformUnixDate(payload.first_release_date);
  const firstReleaseYear =
    firstReleaseDate === undefined ? undefined : yearFromDate(firstReleaseDate);
  const platforms = platformArray(payload, "platforms")
    .map((entry) => platformLabel(entry))
    .filter((platform): platform is string => platform !== null);
  const releases = igdbReleaseFacts(fixture, response, title);
  const languageStatuses = igdbLanguageStatusFacts(fixture, response);
  const externalIds = igdbExternalIds(fixture, response);

  return {
    diagnostics: [],
    fact: {
      sourceId,
      canonicalTitle: title,
      originalLanguage: "ja-JP",
      ...(firstReleaseYear === undefined ? {} : { firstReleaseYear }),
      externalIds,
      releases,
      languageStatuses,
      conflicts: conflictFactsFromPayload(payload),
      seedTarget: false,
      metadata: compactJson({
        platformCatalog: "igdb",
        igdbId: sourceId,
        firstReleaseDate,
        platforms,
        releaseCount: releases.length,
        languageSupportCount: languageStatuses.length,
      }),
    },
  };
}

function parseWikidataPlatformResponse(
  fixture: CatalogRecordedPlatformFixture,
  response: CatalogRecordedPlatformResponse,
): ParsedStorefrontFact {
  const payload = response.payload;
  const sourceId = platformString(payload, "id", fixture, response);
  if (sourceId !== response.sourceId) {
    throw platformSemanticError(
      "parse_drift",
      `Wikidata entity id ${sourceId} does not match fixture source id ${response.sourceId}`,
      fixture,
      response,
      "id",
    );
  }
  const labels = platformRecord(payload, "labels");
  const title = labelValue(labels, "en") ?? labelValue(labels, "ja") ?? sourceId;
  const publicationDate = optionalString(payload, "publication_date");
  const releaseYear = publicationDate === undefined ? undefined : yearFromDate(publicationDate);
  const claims = platformRecord(payload, "claims");
  const platforms = platformArray(claims, "platforms")
    .map((entry) => platformLabel(entry))
    .filter((platform): platform is string => platform !== null);
  const languageStatuses = wikidataLanguageStatusFacts(fixture, response, claims);
  const externalIds = wikidataExternalIds(fixture, response, payload);

  return {
    diagnostics: [],
    fact: {
      sourceId,
      canonicalTitle: title,
      originalLanguage: "ja-JP",
      ...(releaseYear === undefined ? {} : { firstReleaseYear: releaseYear }),
      titles: [
        ...new Set(
          [title, labelValue(labels, "ja")].filter((value): value is string => value !== undefined),
        ),
      ],
      externalIds,
      releases: platforms.map(
        (platform) =>
          compactJson({
            sourceReleaseId: `${sourceId}:${platform}`,
            releaseTitle: title,
            releaseKind: catalogReleaseKindValues.unknown,
            platform,
            releaseDate: publicationDate,
            releaseYear,
            isOfficial: true,
            metadata: compactJson({ sourceField: "claims.platforms", wikidataEntity: sourceId }),
          }) as CatalogRecordedReleaseFact,
      ),
      languageStatuses,
      conflicts: conflictFactsFromPayload(payload),
      seedTarget: false,
      metadata: compactJson({
        platformCatalog: "wikidata",
        wikidataEntity: sourceId,
        statementProvenance: optionalArray(payload, "references"),
        platforms,
        languageStatementCount: languageStatuses.length,
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
    if (
      response.payload === null ||
      typeof response.payload !== "object" ||
      Array.isArray(response.payload)
    ) {
      throw new Error(`fixture.responses[${index}].payload must be a JSON object`);
    }
  }
}

function validatePlatformFixture(fixture: CatalogRecordedPlatformFixture): void {
  requiredString(fixture.fixtureId, "fixture.fixtureId");
  requiredString(fixture.fixtureName, "fixture.fixtureName");
  requiredString(fixture.adapterName, "fixture.adapterName");
  requiredString(fixture.adapterVersion, "fixture.adapterVersion");
  requiredString(fixture.sourceVersion, "fixture.sourceVersion");
  requiredString(fixture.parserVersion, "fixture.parserVersion");
  if (fixture.catalogSource !== "igdb" && fixture.catalogSource !== "wikidata") {
    throw new Error(`unsupported recorded platform source ${String(fixture.catalogSource)}`);
  }
  if (!Array.isArray(fixture.responses) || fixture.responses.length === 0) {
    throw new Error("recorded platform fixture responses must be a nonempty array");
  }
  for (const [index, response] of fixture.responses.entries()) {
    requiredString(response.stepKey, `fixture.responses[${index}].stepKey`);
    requiredString(response.sourceId, `fixture.responses[${index}].sourceId`);
    requiredString(response.requestIdentity, `fixture.responses[${index}].requestIdentity`);
    requiredString(response.fetchedAt, `fixture.responses[${index}].fetchedAt`);
    if (
      response.payload === null ||
      typeof response.payload !== "object" ||
      Array.isArray(response.payload)
    ) {
      throw new Error(`fixture.responses[${index}].payload must be a JSON object`);
    }
  }
}

function igdbReleaseFacts(
  fixture: CatalogRecordedPlatformFixture,
  response: CatalogRecordedPlatformResponse,
  title: string,
): CatalogRecordedReleaseFact[] {
  return platformArray(response.payload, "release_dates").map((entry, index) => {
    const record = platformRecordFromUnknown(entry, `release_dates[${index}]`, fixture, response);
    const releaseId = firstString(record, ["id"]) ?? `${response.sourceId}:release:${index}`;
    const date = optionalString(record, "date") ?? platformUnixDate(record.date_unix);
    const platform = platformLabel(record.platform) ?? platformLabel(record);
    return compactJson({
      sourceReleaseId: String(releaseId),
      releaseTitle: optionalString(record, "name") ?? title,
      releaseKind: catalogReleaseKindValues.unknown,
      platform,
      releaseDate: date,
      releaseYear: date === undefined ? undefined : yearFromDate(date),
      isOfficial: true,
      metadata: compactJson({
        sourceField: `release_dates[${index}]`,
        region: optionalString(record, "region"),
        confidence: catalogRecordedConfidenceForSourceFact("igdb", "release"),
      }),
    }) as CatalogRecordedReleaseFact;
  });
}

function igdbLanguageStatusFacts(
  fixture: CatalogRecordedPlatformFixture,
  response: CatalogRecordedPlatformResponse,
): CatalogRecordedLanguageStatusFact[] {
  return platformArray(response.payload, "language_supports").map((entry, index) => {
    const record = platformRecordFromUnknown(
      entry,
      `language_supports[${index}]`,
      fixture,
      response,
    );
    const languageRecord = optionalRecord(record, "language");
    const language = optionalString(record, "locale") ?? optionalString(languageRecord, "locale");
    if (language === undefined) {
      throw platformSemanticError(
        "parse_drift",
        `IGDB language_supports[${index}] is missing locale`,
        fixture,
        response,
        `language_supports[${index}].language.locale`,
      );
    }
    const supportType = optionalString(record, "support_type");
    const platform = platformLabel(record.platform);
    const confidence = catalogRecordedConfidenceForSourceFact(
      "igdb",
      "language_status",
      confidenceOptions(supportType),
    );
    return compactJson({
      language,
      status: igdbLanguageStatus(record),
      statusScope: catalogLanguageStatusScopeValues.platform,
      platform,
      confidence,
      metadata: compactJson({
        sourceField: `language_supports[${index}]`,
        supportType,
        languageName: optionalString(languageRecord, "name"),
      }),
    }) as CatalogRecordedLanguageStatusFact;
  });
}

function igdbExternalIds(
  fixture: CatalogRecordedPlatformFixture,
  response: CatalogRecordedPlatformResponse,
): CatalogRecordedExternalIdFact[] {
  const ids: CatalogRecordedExternalIdFact[] = [
    {
      sourceId: response.sourceId,
      externalIdKind: catalogExternalIdKindValues.sourceRecord,
      confidence: catalogRecordedConfidenceForSourceFact("igdb", "external_id"),
      metadata: { sourceField: "id" },
    },
  ];
  for (const [index, entry] of platformArray(response.payload, "external_games").entries()) {
    const record = platformRecordFromUnknown(entry, `external_games[${index}]`, fixture, response);
    const mapped = externalGameCatalogSource(optionalString(record, "category"));
    const sourceId = firstString(record, ["uid", "id"]);
    if (mapped === null || sourceId === null) {
      continue;
    }
    ids.push({
      catalogSource: mapped.catalogSource,
      sourceId,
      externalIdKind: mapped.externalIdKind,
      confidence: catalogRecordedConfidenceForSourceFact("igdb", "external_id"),
      metadata: compactJson({
        sourceField: `external_games[${index}]`,
        category: optionalString(record, "category"),
        url: optionalString(record, "url"),
      }),
    });
  }
  return ids;
}

function wikidataLanguageStatusFacts(
  fixture: CatalogRecordedPlatformFixture,
  response: CatalogRecordedPlatformResponse,
  claims: CatalogJsonRecord,
): CatalogRecordedLanguageStatusFact[] {
  return platformArray(claims, "language_statements").map((entry, index) => {
    const record = platformRecordFromUnknown(
      entry,
      `claims.language_statements[${index}]`,
      fixture,
      response,
    );
    const language = platformString(record, "locale", fixture, response);
    const status = platformEnumStringField(
      record.status,
      Object.values(catalogLanguageStatusValues),
      `claims.language_statements[${index}].status`,
      fixture,
      response,
    );
    const platform = platformLabel(record.platform);
    const qualifiers = optionalRecord(record, "qualifiers");
    const confidence = catalogRecordedConfidenceForSourceFact(
      "wikidata",
      "language_status",
      confidenceOptions(optionalString(qualifiers, "basis")),
    );
    return compactJson({
      language,
      status,
      statusScope:
        platform === undefined
          ? catalogLanguageStatusScopeValues.work
          : catalogLanguageStatusScopeValues.platform,
      platform,
      confidence,
      metadata: compactJson({
        sourceField: `claims.language_statements[${index}]`,
        statementId: optionalString(record, "statement_id"),
        property: optionalString(record, "property"),
        qualifiers,
        references: optionalArray(record, "references"),
      }),
    }) as CatalogRecordedLanguageStatusFact;
  });
}

function wikidataExternalIds(
  fixture: CatalogRecordedPlatformFixture,
  response: CatalogRecordedPlatformResponse,
  payload: CatalogJsonRecord,
): CatalogRecordedExternalIdFact[] {
  const ids: CatalogRecordedExternalIdFact[] = [
    {
      sourceId: response.sourceId,
      externalIdKind: catalogExternalIdKindValues.sourceRecord,
      confidence: catalogRecordedConfidenceForSourceFact("wikidata", "entity_link"),
      metadata: { sourceField: "id" },
    },
  ];
  const external: CatalogJsonRecord = optionalRecord(payload, "external_ids") ?? {};
  const mapped: Array<{
    key: string;
    catalogSource: CatalogSource;
    externalIdKind: CatalogExternalIdKind;
  }> = [
    {
      key: "igdb",
      catalogSource: "igdb",
      externalIdKind: catalogExternalIdKindValues.knowledgeBaseEntity,
    },
    {
      key: "steam",
      catalogSource: "steam",
      externalIdKind: catalogExternalIdKindValues.storeProduct,
    },
    {
      key: "vndb",
      catalogSource: "vndb",
      externalIdKind: catalogExternalIdKindValues.sourceRecord,
    },
  ];
  for (const entry of mapped) {
    const value = external[entry.key];
    if (typeof value !== "string" || value.length === 0) {
      continue;
    }
    ids.push({
      catalogSource: entry.catalogSource,
      sourceId: value,
      externalIdKind: entry.externalIdKind,
      confidence: catalogRecordedConfidenceForSourceFact("wikidata", "external_id", {
        qualifierProvenance: entry.key,
      }),
      metadata: {
        sourceField: `external_ids.${entry.key}`,
        wikidataEntity: response.sourceId,
      },
    });
  }
  return ids;
}

function normalizeDlsiteStorefrontPayload(
  fixture: CatalogRecordedStorefrontFixture,
  response: CatalogRecordedStorefrontResponse,
): NormalizedDlsiteStorefrontPayload {
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

  const translationInfo = optionalRecord(payload, "translation_info");
  if (translationInfo === undefined) {
    throw storefrontSemanticError(
      catalogRecordedStorefrontDiagnosticCodeValues.unsupportedResponseShape,
      "DLsite recorded fixture must preserve source translation_info tree",
      fixture,
      response,
      "translation_info",
    );
  }
  const languageEditions = requiredArray(
    translationInfo,
    "language_editions",
    fixture,
    response,
    "translation_info.language_editions",
  );
  const maker = optionalRecord(payload, "maker");
  const demand = compactJson({
    dl_count: demandNumber(payload, "dl_count"),
    rating_summary: optionalRecord(payload, "rating_summary"),
    rating_histogram: optionalRecord(payload, "rating_histogram"),
    wishlist_count: demandNumber(payload, "wishlist_count"),
    rank_facts: optionalArray(payload, "rank_facts"),
  });

  return compactJson({
    sourceId,
    title: stringField(payload, "title", fixture, response),
    releaseDate: optionalString(payload, "release_date"),
    workType: optionalString(payload, "work_type"),
    makerName: optionalString(payload, "maker_name") ?? optionalString(maker, "name"),
    translationInfo,
    languageStatuses: languageEditions.map((entry, index) =>
      dlsiteLanguageStatus(entry, index, sourceId, fixture, response),
    ),
    demand,
  }) as NormalizedDlsiteStorefrontPayload;
}

function unwrapSteamAppdetailsEnvelope(
  fixture: CatalogRecordedStorefrontFixture,
  response: CatalogRecordedStorefrontResponse,
): { envelopeKey: string; appdetails: CatalogJsonRecord } {
  const keys = Object.keys(response.payload);
  if (keys.length !== 1) {
    throw storefrontSemanticError(
      catalogRecordedStorefrontDiagnosticCodeValues.unsupportedResponseShape,
      "Steam appdetails recorded fixture must contain exactly one app-id keyed envelope",
      fixture,
      response,
      "appdetails",
    );
  }
  const envelopeKey = keys[0] ?? "";
  if (envelopeKey !== response.sourceId) {
    throw storefrontSemanticError(
      catalogRecordedStorefrontDiagnosticCodeValues.parseDrift,
      `Steam appdetails envelope key ${envelopeKey} does not match fixture source id ${response.sourceId}`,
      fixture,
      response,
      envelopeKey,
    );
  }
  const appdetails = response.payload[envelopeKey];
  if (appdetails === null || typeof appdetails !== "object" || Array.isArray(appdetails)) {
    throw storefrontSemanticError(
      catalogRecordedStorefrontDiagnosticCodeValues.unsupportedResponseShape,
      "Steam appdetails envelope value must be an object",
      fixture,
      response,
      envelopeKey,
    );
  }
  return { envelopeKey, appdetails: appdetails as CatalogJsonRecord };
}

function dlsiteLanguageStatus(
  input: unknown,
  index: number,
  sourceId: string,
  fixture: CatalogRecordedStorefrontFixture,
  response: CatalogRecordedStorefrontResponse,
): CatalogRecordedLanguageStatusFact {
  const sourceField = `translation_info.language_editions[${index}]`;
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw storefrontSemanticError(
      catalogRecordedStorefrontDiagnosticCodeValues.parseDrift,
      `DLsite ${sourceField} must be a JSON object`,
      fixture,
      response,
      sourceField,
    );
  }
  const record = input as CatalogJsonRecord;
  const language = requiredStringFromUnknown(
    record.locale ?? record.language,
    `${sourceField}.locale`,
    fixture,
    response,
  );
  const status = enumStringField(
    record.status,
    Object.values(catalogLanguageStatusValues),
    `${sourceField}.status`,
    fixture,
    response,
  );
  const statusScope = optionalEnumStringField(
    record.status_scope ?? record.scope,
    Object.values(catalogLanguageStatusScopeValues),
    `${sourceField}.status_scope`,
    fixture,
    response,
  );
  const statusFact: CatalogRecordedLanguageStatusFact = {
    language,
    status,
    statusScope: statusScope ?? catalogLanguageStatusScopeValues.platform,
    platform: "dlsite",
    releaseSourceId: `${sourceId}:dlsite`,
    metadata: compactJson({
      sourceField: "translation_info.language_editions",
      localeLabel: optionalString(record, "label"),
      translationRole: optionalString(record, "translation_role"),
    }),
  };
  const confidence = optionalEnumStringField(
    record.confidence,
    Object.values(catalogConfidenceValues),
    `${sourceField}.confidence`,
    fixture,
    response,
  );
  const rawContentRedactionClass = optionalEnumStringField(
    record.raw_content_redaction_class,
    Object.values(catalogRawContentRedactionClassValues),
    `${sourceField}.raw_content_redaction_class`,
    fixture,
    response,
  );
  if (confidence !== undefined) {
    statusFact.confidence = confidence;
  }
  if (rawContentRedactionClass !== undefined) {
    statusFact.rawContentRedactionClass = rawContentRedactionClass;
  }
  return statusFact;
}

function steamLanguageStatuses(
  data: CatalogJsonRecord,
  appId: string,
  fixture: CatalogRecordedStorefrontFixture,
  response: CatalogRecordedStorefrontResponse,
): SteamLanguageStatusParseResult {
  const raw = data.supported_languages;
  const labels =
    typeof raw === "string"
      ? raw
          .replace(/<[^>]*>/gu, "")
          .split(/[,;]/u)
          .map((value) => value.trim())
          .filter((value) => value.length > 0)
      : stringArray(data, "supported_language_codes");
  const mapped = labels.map((label) => ({ label, locale: steamLocaleFromLabel(label) }));
  const unknownLocaleLabels = mapped
    .filter((entry) => entry.locale === null)
    .map((entry) => entry.label);
  const diagnostics = unknownLocaleLabels.map((label) => ({
    code: catalogRecordedStorefrontDiagnosticCodeValues.parseDrift,
    severity: "warning" as const,
    fixtureId: fixture.fixtureId,
    sourceRevision: fixture.sourceVersion,
    stepKey: response.stepKey,
    sourceId: response.sourceId,
    sourceField: "data.supported_languages",
    message: `Steam supported_languages label ${label} could not be mapped to a catalog locale`,
  }));
  const locales = mapped
    .map((entry) => entry.locale)
    .filter((value): value is string => value !== null);
  const uniqueLocales = [...new Set(locales)];
  return {
    diagnostics,
    unknownLocaleLabels,
    statuses: uniqueLocales.map((language) => ({
      language,
      status: catalogLanguageStatusValues.officialFull,
      statusScope: catalogLanguageStatusScopeValues.platform,
      platform: "steam",
      releaseSourceId: `${appId}:steam`,
      metadata: { sourceField: "supported_languages" },
    })),
  };
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

function confidenceOptions(value: string | undefined): { qualifierProvenance?: string } {
  return value === undefined ? {} : { qualifierProvenance: value };
}

function igdbLanguageStatus(record: CatalogJsonRecord): CatalogLanguageStatus {
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

function externalGameCatalogSource(
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

function conflictFactsFromPayload(payload: CatalogJsonRecord): CatalogRecordedConflictFact[] {
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

function conflictSeverityValue(value: string | undefined): "info" | "warning" | "critical" {
  return value === "info" || value === "critical" ? value : "warning";
}

function platformLabel(value: unknown): string | null {
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

function normalizePlatformLabel(value: string): string {
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

function platformUnixDate(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return new Date(value * 1000).toISOString().slice(0, 10);
}

function platformArray(record: CatalogJsonRecord, field: string): unknown[] {
  const value = record[field];
  return Array.isArray(value) ? value : [];
}

function platformRecord(record: CatalogJsonRecord, field: string): CatalogJsonRecord {
  const value = record[field];
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as CatalogJsonRecord)
    : {};
}

function platformRecordFromUnknown(
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

function platformString(
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

function platformNumberOrString(
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

function labelValue(labels: CatalogJsonRecord, locale: string): string | undefined {
  const label = labels[locale];
  if (typeof label === "string" && label.length > 0) {
    return label;
  }
  if (label !== null && typeof label === "object" && !Array.isArray(label)) {
    return optionalString(label as CatalogJsonRecord, "value");
  }
  return undefined;
}

function platformEnumStringField<TValue extends string>(
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

function platformSemanticError(
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

function requiredStringFromUnknown(
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

function enumStringField<TValue extends string>(
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

function optionalEnumStringField<TValue extends string>(
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
  const workId = stableCatalogId("catalog-work", [context.adapter.catalogSource, fact.sourceId]);
  const generatedConflicts: CatalogRecordedConflictFact[] = [];
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
    workId,
    canonicalTitle: fact.canonicalTitle,
    metadata: compactJson({
      ...fact.metadata,
      ...importMetadata,
      alternateTitles: fact.titles ?? [],
    }),
    externalIds: await externalIdInputs(
      catalogRepository,
      actor,
      context,
      fact,
      importMetadata,
      sourceProvenanceId,
      workId,
      generatedConflicts,
    ),
    releases: releaseInputs(context, fact, importMetadata, sourceProvenanceId),
    languageStatuses: languageStatusInputs(
      context,
      fact,
      importMetadata,
      sourceProvenanceId,
      releaseIdsBySourceId,
    ),
    conflicts: conflictInputs(
      context,
      {
        ...fact,
        conflicts: [...(fact.conflicts ?? []), ...generatedConflicts],
      },
      importMetadata,
      sourceProvenanceId,
      workId,
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

async function externalIdInputs(
  catalogRepository: ItotoriCatalogRepositoryPort,
  actor: AuthorizationActor,
  context: CatalogCrawlerIngestContext<CatalogRecordedImporterFact>,
  fact: CatalogRecordedImporterFact,
  importMetadata: CatalogJsonRecord,
  sourceProvenanceId: string,
  workId: string,
  generatedConflicts: CatalogRecordedConflictFact[],
): Promise<CatalogExternalIdInput[]> {
  const inputs = new Map<string, CatalogExternalIdInput>();
  const add = (input: CatalogExternalIdInput) => {
    inputs.set(
      `${input.catalogSource}:${input.sourceId}:${
        input.externalIdKind ?? catalogExternalIdKindValues.sourceRecord
      }`,
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
    const existing = await catalogRepository.getWorkByExternalId(
      actor,
      catalogSource,
      externalId.sourceId,
      externalIdKind,
    );
    if (existing !== null && existing.workId !== workId) {
      generatedConflicts.push({
        conflictKind: catalogConflictKindValues.externalId,
        summary:
          `${context.adapter.catalogSource} ${fact.sourceId} links ` +
          `${catalogSource} ${externalId.sourceId}, but that external id is already attached ` +
          `to ${existing.canonicalTitle}.`,
        reasonCode: "external_id_already_attached",
        severity: "warning",
        metadata: compactJson({
          linkedCatalogSource: catalogSource,
          linkedSourceId: externalId.sourceId,
          linkedExternalIdKind: externalIdKind,
          existingWorkId: existing.workId,
          existingCanonicalTitle: existing.canonicalTitle,
          sourceField: externalId.metadata?.sourceField,
        }),
      });
      continue;
    }
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

function conflictInputs(
  context: CatalogCrawlerIngestContext<CatalogRecordedImporterFact>,
  fact: CatalogRecordedImporterFact,
  importMetadata: CatalogJsonRecord,
  sourceProvenanceId: string,
  workId: string,
): CatalogConflictInput[] {
  return (fact.conflicts ?? []).map((conflict, index) => {
    const conflictId =
      conflict.conflictId ??
      stableCatalogId("catalog-conflict", [
        context.adapter.catalogSource,
        fact.sourceId,
        conflict.reasonCode ?? "",
        conflict.summary,
        String(index),
      ]);
    return {
      conflictId,
      conflictKind: conflict.conflictKind ?? catalogConflictKindValues.languageStatus,
      status: conflict.status ?? catalogConflictStatusValues.open,
      summary: conflict.summary,
      detectedAt: conflict.detectedAt ?? context.step.fetchedAt,
      metadata: compactJson({
        reasonCode: conflict.reasonCode ?? "source_disagreement",
        severity: conflict.severity ?? "warning",
        ...conflict.metadata,
        ...importMetadata,
      }),
      evidence: conflict.evidence?.map((evidence, evidenceIndex) => ({
        conflictEvidenceId: stableCatalogId("catalog-conflict-evidence", [
          conflictId,
          String(evidenceIndex),
          evidence.subjectKind ?? catalogConflictSubjectKindValues.sourceProvenance,
          evidence.subjectId ?? sourceProvenanceId,
        ]),
        subjectKind: evidence.subjectKind ?? catalogConflictSubjectKindValues.sourceProvenance,
        subjectId: evidence.subjectId ?? sourceProvenanceId,
        sourceProvenanceId,
        evidencePosition: evidence.evidencePosition ?? evidenceIndex,
        metadata: compactJson({ ...evidence.metadata, ...importMetadata }),
      })) ?? [
        {
          conflictEvidenceId: stableCatalogId("catalog-conflict-evidence", [
            conflictId,
            "0",
            catalogConflictSubjectKindValues.sourceProvenance,
            sourceProvenanceId,
          ]),
          subjectKind: catalogConflictSubjectKindValues.sourceProvenance,
          subjectId: sourceProvenanceId,
          sourceProvenanceId,
          evidencePosition: 0,
          metadata: importMetadata,
        },
        {
          conflictEvidenceId: stableCatalogId("catalog-conflict-evidence", [
            conflictId,
            "1",
            catalogConflictSubjectKindValues.work,
            workId,
          ]),
          subjectKind: catalogConflictSubjectKindValues.work,
          subjectId: workId,
          sourceProvenanceId,
          evidencePosition: 1,
          metadata: compactJson({ role: "imported_work", ...importMetadata }),
        },
      ],
    };
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
