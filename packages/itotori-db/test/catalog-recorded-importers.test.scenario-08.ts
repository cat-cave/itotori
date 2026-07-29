import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";

import { catalogCompletenessPoolValues } from "../src/repositories/catalog-repository.js";

import {
  type CatalogRecordedStorefrontDiagnostic,
  type CatalogRecordedStorefrontDiagnosticCode,
  type CatalogRecordedStorefrontFixture,
  CatalogRecordedStorefrontSemanticError,
  createWikidataRecordedPlatformAdapter,
} from "../src/services/catalog-recorded-importers.js";
import {
  catalogConfidenceValues,
  catalogConflictKindValues,
  catalogExternalIdKindValues,
  catalogLanguageStatusValues,
  catalogSourceRecordKindValues,
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
  servicesFor,
  runFixture,
  runStorefrontFixture,
} from "./catalog-recorded-importers.test.shared-01.js";
import {
  readFixture,
  readStorefrontFixture,
  readPlatformFixture,
  record,
  requiredArray,
  required,
} from "./catalog-recorded-importers.test.shared-02.js";
describe("catalog recorded source importers", () => {
  it("imports Wikidata entity links, qualifier-backed language statements, and reviewable conflicts", async () => {
    const context = await isolatedMigratedContext();
    try {
      const services = servicesFor(context.db);
      await runFixture(services, vndbFixture, "worker-vndb-before-wikidata");
      const vndbBefore = await services.catalogRepository.getWorkByExternalId(
        actor,
        "vndb",
        "v1002",
      );

      const result = await runStorefrontFixture(
        services,
        createWikidataRecordedPlatformAdapter(wikidataFixture),
        "worker-wikidata",
      );
      expect(result).toMatchObject({
        fetchedSteps: 1,
        importedSteps: 1,
        skippedSteps: 0,
      });

      const moon = await services.catalogRepository.getWorkByExternalId(
        actor,
        "wikidata",
        "Q130099",
      );
      expect(moon).toMatchObject({
        canonicalTitle: "Moonlit Glass Journey",
        originalLanguage: "ja-JP",
        firstReleaseYear: 2022,
      });
      expect(moon?.externalIds).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            catalogSource: "wikidata",
            sourceId: "Q130099",
            externalIdKind: catalogExternalIdKindValues.sourceRecord,
          }),
          expect.objectContaining({
            catalogSource: "igdb",
            sourceId: "252099",
            externalIdKind: catalogExternalIdKindValues.knowledgeBaseEntity,
          }),
          expect.objectContaining({
            catalogSource: "steam",
            sourceId: "2100998",
            externalIdKind: catalogExternalIdKindValues.storeProduct,
          }),
        ]),
      );
      expect(
        moon?.externalIds.some(
          (externalId) => externalId.catalogSource === "vndb" && externalId.sourceId === "v1002",
        ),
      ).toBe(false);
      await expect(
        services.catalogRepository.getWorkByExternalId(actor, "vndb", "v1002"),
      ).resolves.toMatchObject({ workId: vndbBefore?.workId });

      expect(moon?.languageStatuses).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            language: "en-US",
            status: catalogLanguageStatusValues.officialFull,
            platform: "nintendo_switch",
            confidence: catalogConfidenceValues.medium,
            metadata: expect.objectContaining({
              qualifiers: expect.objectContaining({
                basis: "official platform language statement with platform qualifier",
              }),
            }),
          }),
        ]),
      );
      expect(moon?.conflicts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            conflictKind: catalogConflictKindValues.languageStatus,
            summary: expect.stringContaining("Wikidata reports official English"),
          }),
          expect.objectContaining({
            conflictKind: catalogConflictKindValues.externalId,
            summary: expect.stringContaining("links vndb v1002"),
            metadata: expect.objectContaining({
              reasonCode: "external_id_already_attached",
              linkedCatalogSource: "vndb",
            }),
          }),
        ]),
      );

      const conflictRows = await services.catalogRepository.catalogConflictReview(actor, {
        catalogRecordId: required(moon?.workId, "Wikidata work id"),
      });
      expect(conflictRows.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            conflictKind: catalogConflictKindValues.languageStatus,
            reasonCode: "official_english_platform_disagreement",
            sourceIds: expect.arrayContaining([{ catalogSource: "wikidata", sourceId: "Q130099" }]),
          }),
          expect.objectContaining({
            conflictKind: catalogConflictKindValues.externalId,
            reasonCode: "external_id_already_attached",
          }),
        ]),
      );

      // Public explanation surface: the conflict-review provenance carries the
      // source RECORD KIND. Because both facts were imported by replaying a
      // recorded fixture (not a live crawl), every provenance entry must be
      // labelled `recorded_fixture` and NOT `raw_cache` — so a reviewer reading
      // the public explanation can tell replayed fixture evidence apart from
      // live raw-cache evidence.
      const conflictProvenanceKinds = conflictRows.rows.flatMap((row) =>
        row.provenance.map((entry) => entry.sourceRecordKind),
      );
      expect(conflictProvenanceKinds.length).toBeGreaterThan(0);
      expect(conflictProvenanceKinds).toContain(catalogSourceRecordKindValues.recordedFixture);
      expect(conflictProvenanceKinds).not.toContain(catalogSourceRecordKindValues.rawCache);

      const pools = await services.catalogRepository.catalogCompletenessBenchmarkPools(actor, {
        targetLanguage: "en-US",
      });
      expect(
        pools.pools[catalogCompletenessPoolValues.noEnglish].map((work) => work.workId),
      ).toEqual(expect.not.arrayContaining([moon?.workId]));
      expect(
        pools.pools[catalogCompletenessPoolValues.conflict].map((work) => work.workId),
      ).toEqual(expect.arrayContaining([required(moon?.workId, "Wikidata work id")]));
    } finally {
      await context.close();
    }
  });
});
