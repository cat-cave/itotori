import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";

import { type ItotoriCatalogRepositoryPort } from "../src/repositories/catalog-repository.js";

import {
  createCatalogRecordedImporterVerifier,
  createIgdbRecordedPlatformAdapter,
  type CatalogRecordedImporterFact,
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
  runStorefrontFixture,
  storefrontSteps,
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
  it("omits originalLanguage when IGDB and Wikidata payloads carry no language evidence", async () => {
    const igdbNoLanguage = structuredClone(igdbFixture);
    const igdbResponse = required(igdbNoLanguage.responses[0], "IGDB response");
    igdbResponse.payload = { ...igdbResponse.payload };
    delete igdbResponse.payload.language_supports;
    const igdbStep = required(
      (await storefrontSteps(createIgdbRecordedPlatformAdapter(igdbNoLanguage)))[0],
      "IGDB step",
    );
    const igdbFact = required(igdbStep.facts[0], "IGDB fact");
    expect(igdbFact.languageStatuses ?? []).toHaveLength(0);
    expect(igdbFact.originalLanguage).toBeUndefined();

    const wikidataNoLanguage = structuredClone(wikidataFixture);
    const wikidataResponse = required(wikidataNoLanguage.responses[0], "Wikidata response");
    const claims = record(wikidataResponse.payload.claims, "Wikidata claims");
    delete claims.language_statements;
    wikidataResponse.payload = { ...wikidataResponse.payload, claims };
    const wikidataStep = required(
      (await storefrontSteps(createWikidataRecordedPlatformAdapter(wikidataNoLanguage)))[0],
      "Wikidata step",
    );
    const wikidataFact = required(wikidataStep.facts[0], "Wikidata fact");
    expect(wikidataFact.languageStatuses ?? []).toHaveLength(0);
    expect(wikidataFact.originalLanguage).toBeUndefined();

    // Evidence-bearing payloads still carry the genuinely-known original language.
    const igdbWithLanguage = required(
      (await storefrontSteps(createIgdbRecordedPlatformAdapter(igdbFixture)))[0],
      "IGDB step",
    );
    expect(igdbWithLanguage.facts[0]?.originalLanguage).toBe("ja-JP");
  });

  it("verifies persisted fact identities reconstructed from data read back from the repository", async () => {
    const expectedFactIdentities = ["catalogSource=igdb|sourceId=252001"];
    const stableImportKey = "stable-import-key";
    const importTransactionId = "import-txn-1";
    const facts: CatalogRecordedImporterFact[] = [
      { sourceId: "252001", canonicalTitle: "Promise Under Starlight" },
    ];

    const buildVerifier = (persistedSourceId: string) =>
      createCatalogRecordedImporterVerifier({
        actor,
        catalogRepository: {
          getWorkByExternalId: () =>
            Promise.resolve({
              externalIds: [
                {
                  externalIdId: "ext-1",
                  workId: "work-1",
                  catalogSource: "igdb",
                  sourceId: persistedSourceId,
                  externalIdKind: catalogExternalIdKindValues.sourceRecord,
                  sourceProvenanceId: "prov-1",
                  confidence: catalogConfidenceValues.high,
                  discoveredAt: new Date(),
                  metadata: { stableImportKey, importTransactionId },
                },
              ],
            }),
        } as unknown as ItotoriCatalogRepositoryPort,
      });

    const context = {
      adapter: { catalogSource: "igdb" },
      stableImportKey,
      importTransactionId,
      expectedFactIdentities,
      facts,
      proof: {
        stableImportKey,
        strategy: "upsert",
        factCount: facts.length,
        factIdentities: expectedFactIdentities,
      },
    } as unknown as Parameters<ReturnType<typeof createCatalogRecordedImporterVerifier>>[0];

    // Persisted identity matches expectation -> evidence asserts persisted import.
    await expect(buildVerifier("252001")(context)).resolves.toMatchObject({ persisted: true });
    // Persisted sourceId diverges -> the now-genuine comparison can fail.
    expect(await buildVerifier("999999")(context)).toBeNull();
  });

  it("records untyped generic conflicts with a neutral conflict kind instead of languageStatus", async () => {
    const context = await isolatedMigratedContext();
    try {
      const services = servicesFor(context.db);
      const igdbWithGenericConflict = structuredClone(igdbFixture);
      const igdbResponse = required(igdbWithGenericConflict.responses[0], "IGDB response");
      const conflicts = requiredArray(igdbResponse.payload.conflicts, "IGDB conflicts");
      conflicts.push({
        summary: "Untyped catalog disagreement requires manual review",
        reason_code: "manual_review",
        severity: "warning",
      });
      igdbResponse.payload = { ...igdbResponse.payload, conflicts };

      await runStorefrontFixture(
        services,
        createIgdbRecordedPlatformAdapter(igdbWithGenericConflict),
        "worker-igdb-generic-conflict",
      );

      const work = await services.catalogRepository.getWorkByExternalId(actor, "igdb", "252001");
      const generic = required(
        work?.conflicts.find((conflict) =>
          conflict.summary.includes("Untyped catalog disagreement"),
        ),
        "generic conflict",
      );
      expect(generic.conflictKind).toBe(catalogConflictKindValues.unknown);
      expect(generic.conflictKind).not.toBe(catalogConflictKindValues.languageStatus);
    } finally {
      await context.close();
    }
  });
});
