import { readFileSync } from "node:fs";
import { eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import { ItotoriCatalogCrawlerRepository } from "../src/repositories/catalog-crawler-repository.js";
import {
  catalogCompletenessPoolValues,
  catalogSeedReadinessExplanationMetadataKey,
  ItotoriCatalogRepository,
  type ItotoriCatalogRepositoryPort,
} from "../src/repositories/catalog-repository.js";
import {
  createRecordedCatalogCrawlerAdapter,
  ItotoriCatalogCrawlerRunner,
  type CatalogCrawlerAdapterStep,
  type CatalogCrawlerSourceAdapter,
  type RecordedCatalogCrawlerFixture,
} from "../src/services/catalog-crawler-runner.js";
import {
  catalogRecordedConfidenceForSourceFact,
  createCatalogRecordedImporterIngestStep,
  createCatalogRecordedImporterVerifier,
  createDlsiteRecordedStorefrontAdapter,
  createIgdbRecordedPlatformAdapter,
  type CatalogRecordedImporterFact,
  type CatalogRecordedPlatformFixture,
  createSteamRecordedStorefrontAdapter,
  type CatalogRecordedStorefrontDiagnostic,
  type CatalogRecordedStorefrontDiagnosticCode,
  type CatalogRecordedStorefrontFixture,
  CatalogRecordedStorefrontSemanticError,
  createWikidataRecordedPlatformAdapter,
  mapDlsiteReleaseMappingsForRecordedResponse,
} from "../src/services/catalog-recorded-importers.js";
import {
  catalogConfidenceValues,
  catalogConflictKindValues,
  catalogConflictSubjectKindValues,
  catalogConflicts,
  catalogConflictEvidence,
  catalogDemandFactKindValues,
  catalogExternalIdKindValues,
  catalogLanguageStatusValues,
  catalogReleaseKindValues,
  catalogReleaseMappingKindValues,
  catalogReleasePackageKindValues,
  catalogSeedOriginValues,
  catalogSeedStatusValues,
  catalogSourceProvenance,
  catalogSourceRecordKindValues,
  catalogTranslationPortabilityValues,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const actor: AuthorizationActor = { userId: localUserId };

const vndbFixture = readFixture("vndb-dump-replay.json");
const egsFixture = readFixture("egs-recorded-replay.json");
const dlsiteFixture = readStorefrontFixture("dlsite-storefront-replay.json");
const steamFixture = readStorefrontFixture("steam-storefront-replay.json");
const igdbFixture = readPlatformFixture("igdb-platform-replay.json");
const wikidataFixture = readPlatformFixture("wikidata-platform-replay.json");

const DLSITE_FIXTURE_ID = "catalog-recorded-importer-dlsite-storefront-v0.1";
const DLSITE_SOURCE_REVISION = "dlsite-storefront-synthetic-2026-06-18";
const STEAM_FIXTURE_ID = "catalog-recorded-importer-steam-storefront-v0.1";
const STEAM_SOURCE_REVISION = "steam-storefront-synthetic-2026-06-18";

type StorefrontDriftExpectation = {
  code: CatalogRecordedStorefrontDiagnosticCode;
  fixtureId: string;
  sourceRevision: string;
  stepKey: string;
  sourceId: string;
  sourceField: string;
};

type StorefrontDriftCase = {
  name: string;
  mutate: (fixture: CatalogRecordedStorefrontFixture) => CatalogRecordedStorefrontFixture;
  expected: StorefrontDriftExpectation;
};

// Each DLsite parse-drift / unsupported-shape case: a synthetic mutation of the
// recorded fixture that drives one diagnostic, plus the COMPLETE diagnostic
// metadata (fixtureId/sourceRevision/stepKey/sourceId/sourceField) it must emit.
const dlsiteUnsupportedShapeMatrix: readonly StorefrontDriftCase[] = [
  {
    name: "missing required title field",
    mutate: (fixture) => {
      const response = required(fixture.responses[0], "DLsite response");
      delete response.payload.title;
      return fixture;
    },
    expected: dlsiteExpectation("parse_drift", 0, "title"),
  },
  {
    name: "missing workno identity",
    mutate: (fixture) => {
      const response = required(fixture.responses[0], "DLsite response");
      delete response.payload.workno;
      delete response.payload.product_id;
      delete response.payload.id;
      return fixture;
    },
    expected: dlsiteExpectation("parse_drift", 0, "workno"),
  },
  {
    name: "workno mismatched against fixture source id",
    mutate: (fixture) => {
      const response = required(fixture.responses[0], "DLsite response");
      response.payload.workno = "RJ09999999";
      return fixture;
    },
    expected: dlsiteExpectation("parse_drift", 0, "workno"),
  },
  {
    name: "missing translation_info tree",
    mutate: (fixture) => {
      const response = required(fixture.responses[0], "DLsite response");
      delete response.payload.translation_info;
      return fixture;
    },
    expected: dlsiteExpectation("unsupported_response_shape", 0, "translation_info"),
  },
  {
    name: "language_editions is not an array",
    mutate: (fixture) => {
      const response = required(fixture.responses[0], "DLsite response");
      record(response.payload.translation_info, "translation_info").language_editions =
        "not-an-array";
      return fixture;
    },
    expected: dlsiteExpectation("parse_drift", 0, "translation_info.language_editions"),
  },
  {
    name: "language edition entry is not an object",
    mutate: (fixture) => {
      const response = required(fixture.responses[0], "DLsite response");
      const editions = dlsiteLanguageEditions(response.payload);
      editions[0] = "not-an-object";
      return fixture;
    },
    expected: dlsiteExpectation("parse_drift", 0, "translation_info.language_editions[0]"),
  },
  {
    name: "language edition status enum drift",
    mutate: (fixture) => {
      const response = required(fixture.responses[0], "DLsite response");
      const editions = dlsiteLanguageEditions(response.payload);
      record(editions[0], "language edition").status = "official-ish";
      return fixture;
    },
    expected: dlsiteExpectation("parse_drift", 0, "translation_info.language_editions[0].status"),
  },
  {
    name: "language edition confidence enum drift",
    mutate: (fixture) => {
      const response = required(fixture.responses[1], "DLsite response");
      const editions = dlsiteLanguageEditions(response.payload);
      record(editions[1], "language edition").confidence = "pretty_sure";
      return fixture;
    },
    expected: dlsiteExpectation(
      "parse_drift",
      1,
      "translation_info.language_editions[1].confidence",
    ),
  },
];

// Each Steam parse-drift / unsupported-shape case, with the complete diagnostic
// metadata the appdetails envelope parser must emit.
const steamUnsupportedShapeMatrix: readonly StorefrontDriftCase[] = [
  {
    name: "unsuccessful response without delisted status",
    mutate: (fixture) => {
      const response = required(fixture.responses[1], "Steam response");
      delete record(response.payload["2100099"], "appdetails envelope").delisting_status;
      return fixture;
    },
    expected: steamExpectation("unsupported_response_shape", 1, "2100099.success"),
  },
  {
    name: "delisted response app id mismatch",
    mutate: (fixture) => {
      const response = required(fixture.responses[1], "Steam response");
      record(response.payload["2100099"], "appdetails envelope").steam_appid = "9999999";
      return fixture;
    },
    expected: steamExpectation("parse_drift", 1, "2100099.steam_appid"),
  },
  {
    name: "successful response missing data object",
    mutate: (fixture) => {
      const response = required(fixture.responses[0], "Steam response");
      response.payload = { "2100010": { success: true } };
      return fixture;
    },
    expected: steamExpectation("unsupported_response_shape", 0, "2100010.data"),
  },
  {
    name: "multi-key appdetails envelope",
    mutate: (fixture) => {
      const response = required(fixture.responses[0], "Steam response");
      response.payload = {
        "2100010": { success: true, data: { steam_appid: 2100010, name: "Promise" } },
        "2100011": { success: false, delisting_status: "delisted" },
      };
      return fixture;
    },
    expected: steamExpectation("unsupported_response_shape", 0, "appdetails"),
  },
  {
    name: "envelope value is not an object",
    mutate: (fixture) => {
      const response = required(fixture.responses[0], "Steam response");
      response.payload = { "2100010": "not-an-object" };
      return fixture;
    },
    expected: steamExpectation("unsupported_response_shape", 0, "2100010"),
  },
  {
    name: "envelope key mismatched against fixture source id",
    mutate: (fixture) => {
      const response = required(fixture.responses[0], "Steam response");
      response.payload = { "2100011": { success: true, data: { steam_appid: 2100011 } } };
      return fixture;
    },
    expected: steamExpectation("parse_drift", 0, "2100011"),
  },
  {
    name: "data.steam_appid mismatched against fixture source id",
    mutate: (fixture) => {
      const response = required(fixture.responses[0], "Steam response");
      response.payload = {
        "2100010": { success: true, data: { steam_appid: 2100011, name: "Drifted" } },
      };
      return fixture;
    },
    expected: steamExpectation("parse_drift", 0, "data.steam_appid"),
  },
  {
    name: "successful response missing name field",
    mutate: (fixture) => {
      const response = required(fixture.responses[0], "Steam response");
      response.payload = { "2100010": { success: true, data: { steam_appid: 2100010 } } };
      return fixture;
    },
    expected: steamExpectation("parse_drift", 0, "name"),
  },
];

function dlsiteExpectation(
  code: CatalogRecordedStorefrontDiagnosticCode,
  responseIndex: number,
  sourceField: string,
): StorefrontDriftExpectation {
  const response = required(dlsiteFixture.responses[responseIndex], "DLsite response");
  return {
    code,
    fixtureId: DLSITE_FIXTURE_ID,
    sourceRevision: DLSITE_SOURCE_REVISION,
    stepKey: response.stepKey,
    sourceId: response.sourceId,
    sourceField,
  };
}

function steamExpectation(
  code: CatalogRecordedStorefrontDiagnosticCode,
  responseIndex: number,
  sourceField: string,
): StorefrontDriftExpectation {
  const response = required(steamFixture.responses[responseIndex], "Steam response");
  return {
    code,
    fixtureId: STEAM_FIXTURE_ID,
    sourceRevision: STEAM_SOURCE_REVISION,
    stepKey: response.stepKey,
    sourceId: response.sourceId,
    sourceField,
  };
}

function dlsiteLanguageEditions(payload: Record<string, unknown>): unknown[] {
  const translationInfo = record(payload.translation_info, "translation_info");
  return requiredArray(translationInfo.language_editions, "language_editions");
}

function captureStorefrontSemanticDiagnostic(
  build: () => unknown,
): CatalogRecordedStorefrontDiagnostic {
  try {
    build();
  } catch (error) {
    if (error instanceof CatalogRecordedStorefrontSemanticError) {
      return error.diagnostic;
    }
    throw error;
  }
  throw new Error("expected a CatalogRecordedStorefrontSemanticError to be thrown");
}

function assertCompleteStorefrontDiagnostic(
  diagnostic: CatalogRecordedStorefrontDiagnostic,
  expected: StorefrontDriftExpectation,
): void {
  expect(diagnostic.code).toBe(expected.code);
  expect(diagnostic.fixtureId).toBe(expected.fixtureId);
  expect(diagnostic.sourceRevision).toBe(expected.sourceRevision);
  expect(diagnostic.stepKey).toBe(expected.stepKey);
  expect(diagnostic.sourceId).toBe(expected.sourceId);
  expect(diagnostic.sourceField).toBe(expected.sourceField);
  expect(diagnostic.severity).toBe("error");
  // Every parse-drift case must carry the COMPLETE semantic metadata: a
  // diagnostic missing any of the five fields (empty/undefined) fails here.
  for (const field of [
    "fixtureId",
    "sourceRevision",
    "stepKey",
    "sourceId",
    "sourceField",
  ] as const) {
    expect(diagnostic[field], `diagnostic.${field} must be present`).toBeTruthy();
  }
}

import {
  type Services,
  servicesFor,
  runFixture,
  runStorefrontFixture,
  storefrontSteps,
  sourceProvenanceById,
  provenanceBySourceId,
  provenanceCatalogSourcesByIds,
  liveLikeCrawlAdapter,
} from "./catalog-recorded-importers.test.shared-01.js";
import {
  catalogCounts,
  rateLimitByAdapter,
  readFixture,
  readFixtureText,
  readStorefrontFixture,
  readPlatformFixture,
  withUpdatedFact,
  record,
  requiredArray,
  required,
} from "./catalog-recorded-importers.test.shared-02.js";
describe("catalog recorded source importers", () => {
  it("imports Steam recorded storefront responses with locale metadata, package status, delisting status, and rate limits", async () => {
    const context = await isolatedMigratedContext();
    try {
      const services = servicesFor(context.db);
      const result = await runStorefrontFixture(
        services,
        createSteamRecordedStorefrontAdapter(steamFixture),
        "worker-steam",
      );

      expect(result).toMatchObject({
        fetchedSteps: 2,
        importedSteps: 2,
        skippedSteps: 0,
      });

      const starlight = await services.catalogRepository.getWorkByExternalId(
        actor,
        "steam",
        "2100010",
        catalogExternalIdKindValues.storeProduct,
      );
      expect(starlight).toMatchObject({
        canonicalTitle: "Promise Under Starlight",
        firstReleaseYear: 2021,
      });
      expect(starlight?.metadata).toMatchObject({
        storefront: "steam",
        appId: "2100010",
        packageStatus: "packages_recorded",
        packages: [710001, 710002],
        delistingStatus: "listed",
        localeMetadata: {
          parsedLocales: ["en-US", "ja-JP", "zh-Hans"],
        },
      });
      expect(starlight?.languageStatuses).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ language: "en-US", platform: "steam" }),
          expect.objectContaining({ language: "ja-JP", platform: "steam" }),
          expect.objectContaining({ language: "zh-Hans", platform: "steam" }),
        ]),
      );

      const delisted = await services.catalogRepository.getWorkByExternalId(
        actor,
        "steam",
        "2100099",
        catalogExternalIdKindValues.storeProduct,
      );
      expect(delisted).toMatchObject({
        canonicalTitle: "Moonlit Glass Journey",
        metadata: {
          storefront: "steam",
          appId: "2100099",
          packageStatus: "delisted",
          delistingStatus: "delisted",
        },
      });

      await expect(
        rateLimitByAdapter(context.pool, "steam-recorded-storefront-importer"),
      ).resolves.toMatchObject({
        catalog_source: "steam",
        remaining: 199,
        limit: 200,
        request_identity: "GET /api/appdetails?appids=2100010&cc=us&l=english",
        metadata: { policy: "recorded-fixture", source: "steam" },
      });
      const sourceExternalId = starlight?.externalIds.find(
        (externalId) => externalId.externalIdKind === catalogExternalIdKindValues.sourceRecord,
      );
      const provenance = await sourceProvenanceById(
        context.db,
        required(sourceExternalId?.sourceProvenanceId, "source provenance id"),
      );
      // A recorded Steam storefront REPLAY must persist its source provenance record kind as
      // `recorded_fixture`, NOT `raw_cache`, so fixture-replay evidence is distinguishable from
      // live raw-cache evidence on the public explanation surface.
      expect(provenance).toMatchObject({
        catalogSource: "steam",
        sourceRecordKind: catalogSourceRecordKindValues.recordedFixture,
        sourceId: "2100010",
        requestId: "GET /api/appdetails?appids=2100010&cc=us&l=english",
      });
      expect(provenance.sourceRecordKind).not.toBe(catalogSourceRecordKindValues.rawCache);
      // The fixture-mode provenance marker is also stamped onto the persisted fact metadata.
      expect(starlight?.metadata).toMatchObject({
        sourceRecordKind: catalogSourceRecordKindValues.recordedFixture,
      });
      // Even the delisted-Steam fixture path carries the fixture-mode marker, so a delisted
      // fixture fact is never mistaken for a live raw-cache capture.
      expect(delisted?.metadata).toMatchObject({
        sourceRecordKind: catalogSourceRecordKindValues.recordedFixture,
      });
      await expect(services.catalogRepository.listSeedTargets(actor)).resolves.toEqual([]);
    } finally {
      await context.close();
    }
  });
});
