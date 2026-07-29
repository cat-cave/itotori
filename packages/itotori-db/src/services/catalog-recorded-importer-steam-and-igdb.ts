import {
  catalogExternalIdKindValues,
  catalogReleaseKindValues,
  catalogSourceRecordKindValues,
} from "../schema.js";

import {
  type CatalogRecordedPlatformFixture,
  type CatalogRecordedPlatformResponse,
  catalogRecordedStorefrontDiagnosticCodeValues,
  type CatalogRecordedStorefrontFixture,
  type CatalogRecordedStorefrontResponse,
  type ParsedStorefrontFact,
} from "./catalog-recorded-importer-types.js";
import {
  type CatalogRecordedLanguageStatusFact,
  type CatalogRecordedReleaseFact,
} from "./catalog-recorded-importer-adapters-and-facts.js";
import { igdbLanguageStatusFacts, igdbReleaseFacts } from "./catalog-recorded-importer-wikidata.js";
import { igdbExternalIds } from "./catalog-recorded-importer-platform-facts.js";
import { unwrapSteamAppdetailsEnvelope } from "./catalog-recorded-importer-storefront-parsing.js";
import { steamLanguageStatuses } from "./catalog-recorded-importer-demand-facts.js";
import {
  firstString,
  storefrontSemanticError,
} from "./catalog-recorded-importer-demand-parsing.js";
import {
  numberOrStringField,
  optionalArray,
  optionalRecord,
  optionalString,
  steamReleaseDate,
  stringArray,
  stringField,
  yearFromDate,
} from "./catalog-recorded-importer-payload-parsing.js";
import {
  conflictFactsFromPayload,
  platformArray,
  platformLabel,
  platformUnixDate,
} from "./catalog-recorded-importer-conflict-facts.js";
import {
  platformNumberOrString,
  platformSemanticError,
  platformString,
} from "./catalog-recorded-importer-platform-parsing.js";
import { compactJson } from "./catalog-recorded-importer-utils.js";

export function parseSteamStorefrontResponse(
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
          // Delisted Steam fixture responses are still recorded-fixture
          // evidence (the parser only consumes recorded fixtures).
          sourceRecordKind: catalogSourceRecordKindValues.recordedFixture,
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
  const originalLanguage = originalLanguageFromLanguageStatuses(languages);
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
        // Recorded Steam storefront parser only ever consumes recorded-fixture
        // responses (its adapter refuses non-recorded_fixture mode), so the
        // persisted fact carries the fixture-mode provenance marker directly.
        sourceRecordKind: catalogSourceRecordKindValues.recordedFixture,
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

// Derive the work's original language from the language evidence the source
// payload actually provides. Returns undefined when the payload carries no
// language statuses so callers omit originalLanguage rather than fabricate one.
export function originalLanguageFromLanguageStatuses(
  languageStatuses: readonly CatalogRecordedLanguageStatusFact[],
): string | undefined {
  return (
    languageStatuses.find((status) => status.language === "ja-JP")?.language ??
    languageStatuses[0]?.language
  );
}

export function parseIgdbPlatformResponse(
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
  const originalLanguage = originalLanguageFromLanguageStatuses(languageStatuses);

  return {
    diagnostics: [],
    fact: {
      sourceId,
      canonicalTitle: title,
      ...(originalLanguage === undefined ? {} : { originalLanguage }),
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
