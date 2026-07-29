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
  type CatalogRecordedPlatformFixture,
  type CatalogRecordedPlatformResponse,
  type CatalogRecordedStorefrontFixture,
  type ParsedStorefrontFact,
} from "./catalog-recorded-importers-01.js";
import {
  type CatalogRecordedLanguageStatusFact,
  type CatalogRecordedReleaseFact,
} from "./catalog-recorded-importers-02.js";
import { originalLanguageFromLanguageStatuses } from "./catalog-recorded-importers-04.js";
import {
  wikidataExternalIds,
  wikidataLanguageStatusFacts,
} from "./catalog-recorded-importers-06.js";
import { firstString } from "./catalog-recorded-importers-09.js";
import {
  catalogRecordedConfidenceForSourceFact,
  confidenceOptions,
  igdbLanguageStatus,
  optionalArray,
  optionalRecord,
  optionalString,
  yearFromDate,
} from "./catalog-recorded-importers-10.js";
import {
  conflictFactsFromPayload,
  platformArray,
  platformLabel,
  platformRecord,
  platformUnixDate,
} from "./catalog-recorded-importers-11.js";
import {
  labelValue,
  platformRecordFromUnknown,
  platformSemanticError,
  platformString,
} from "./catalog-recorded-importers-12.js";
import { compactJson } from "./catalog-recorded-importers-15.js";
import { requiredString } from "./catalog-recorded-importers-16.js";

export function parseWikidataPlatformResponse(
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
  const originalLanguage = originalLanguageFromLanguageStatuses(languageStatuses);

  return {
    diagnostics: [],
    fact: {
      sourceId,
      canonicalTitle: title,
      ...(originalLanguage === undefined ? {} : { originalLanguage }),
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

export function validateStorefrontFixture(fixture: CatalogRecordedStorefrontFixture): void {
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

export function validatePlatformFixture(fixture: CatalogRecordedPlatformFixture): void {
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

export function igdbReleaseFacts(
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

export function igdbLanguageStatusFacts(
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
