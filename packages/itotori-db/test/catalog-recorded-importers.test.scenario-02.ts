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
  it("stores recorded importer seed hints as inert and gates them out of benchmark selection until CATALOG-004 consumes them", async () => {
    const context = await isolatedMigratedContext();
    try {
      const services = servicesFor(context.db);
      await runFixture(services, vndbFixture, "worker-vndb-seed-gating");

      // The recorded importer authored a seed HINT for v1001. It is persisted as
      // INERT evidence — carrying its source-fact provenance, but never directly
      // benchmark-selectable.
      const allSeeds = await services.catalogRepository.listSeedTargets(actor);
      const importerSeed = required(
        allSeeds.find(
          (seed) =>
            seed.sourceId === "v1001" && seed.seedOrigin === catalogSeedOriginValues.importer,
        ),
        "importer seed hint for v1001",
      );
      expect(importerSeed.status).toBe(catalogSeedStatusValues.inert);
      expect(importerSeed.sourceProvenanceId).not.toBeNull();

      // A raw importer hint is excluded from both the actionable pending set and
      // the benchmark-selectable candidate query.
      const pendingSeeds = await services.catalogRepository.listSeedTargets(
        actor,
        catalogSeedStatusValues.pending,
      );
      expect(pendingSeeds.map((seed) => seed.sourceId)).not.toContain("v1001");

      const selectableBefore =
        await services.catalogRepository.listBenchmarkSelectableSeedTargets(actor);
      expect(selectableBefore.map((seed) => seed.sourceId)).not.toContain("v1001");

      // CATALOG-004 readiness filtering consumes the inert hint: it promotes the
      // same seed target (natural key preserved) to a selectable status and records
      // a readiness explanation, while preserving the source-fact provenance.
      await services.catalogRepository.recordSeedTarget(actor, {
        seedTargetId: importerSeed.seedTargetId,
        catalogSource: importerSeed.catalogSource,
        sourceId: importerSeed.sourceId,
        seedOrigin: importerSeed.seedOrigin,
        originRef: importerSeed.originRef ?? undefined,
        sourceProvenanceId: importerSeed.sourceProvenanceId ?? undefined,
        status: catalogSeedStatusValues.pending,
        priority: importerSeed.priority,
        metadata: {
          ...importerSeed.metadata,
          [catalogSeedReadinessExplanationMetadataKey]: {
            readiness: "supported",
            explanationCodes: ["readiness_adapter_supported"],
          },
        },
      });

      const selectableAfter =
        await services.catalogRepository.listBenchmarkSelectableSeedTargets(actor);
      const selected = required(
        selectableAfter.find((seed) => seed.sourceId === "v1001"),
        "benchmark-selectable v1001 after CATALOG-004 consumption",
      );
      expect(selected.status).toBe(catalogSeedStatusValues.pending);
      expect(selected.metadata[catalogSeedReadinessExplanationMetadataKey]).toMatchObject({
        readiness: "supported",
      });
      expect(selected.sourceProvenanceId).not.toBeNull();
    } finally {
      await context.close();
    }
  });
});
