import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";

import {
  createCatalogRecordedImporterIngestStep,
  createDlsiteRecordedStorefrontAdapter,
  createSteamRecordedStorefrontAdapter,
  type CatalogRecordedStorefrontDiagnostic,
  type CatalogRecordedStorefrontDiagnosticCode,
  type CatalogRecordedStorefrontFixture,
  CatalogRecordedStorefrontSemanticError,
} from "../src/services/catalog-recorded-importers.js";
import { catalogExternalIdKindValues, catalogSourceRecordKindValues } from "../src/schema.js";
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
  provenanceBySourceId,
  liveLikeCrawlAdapter,
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
  it("labels a live crawl as raw_cache and a recorded-fixture replay as recorded_fixture", async () => {
    const context = await isolatedMigratedContext();
    try {
      const services = servicesFor(context.db);

      // A LIVE crawl (default/live mode) persists its fetched cache as
      // `raw_cache` — genuine live raw-cache evidence.
      await services.runner.run(liveLikeCrawlAdapter("900001"), {
        repository: services.crawlerRepository,
        actor,
        workerId: "worker-live-crawl",
        mode: "live",
      });
      // The SAME adapter run in `recorded_fixture` mode is a fixture replay and
      // must be marked `recorded_fixture`, not raw_cache.
      await services.runner.run(liveLikeCrawlAdapter("900002"), {
        repository: services.crawlerRepository,
        actor,
        workerId: "worker-fixture-replay",
        mode: "recorded_fixture",
      });

      const live = await provenanceBySourceId(context.db, "900001");
      const replay = await provenanceBySourceId(context.db, "900002");
      // Same public `sourceProvenanceFromRow` projection reads both rows; the
      // live crawl is NOT mislabeled and the fixture replay is clearly distinct.
      expect(live.sourceRecordKind).toBe(catalogSourceRecordKindValues.rawCache);
      expect(replay.sourceRecordKind).toBe(catalogSourceRecordKindValues.recordedFixture);
      expect(live.sourceRecordKind).not.toBe(replay.sourceRecordKind);
    } finally {
      await context.close();
    }
  });

  it("distinguishes recorded DLsite/Steam storefront fixture evidence from live raw-cache evidence (CATALOG-084)", async () => {
    const context = await isolatedMigratedContext();
    try {
      const services = servicesFor(context.db);

      // A recorded DLsite storefront REPLAY persists its source provenance record kind as
      // `recorded_fixture`, and stamps the fixture-mode marker onto the persisted fact metadata.
      await runStorefrontFixture(
        services,
        createDlsiteRecordedStorefrontAdapter(dlsiteFixture),
        "worker-dlsite-storefront-provenance",
      );
      // A LIVE crawl for the SAME storefront catalog source (a real on-demand
      // raw-cache capture, distinct sourceId so its provenance row is
      // independently addressable) persists `raw_cache` — genuine live raw-cache evidence.
      await services.runner.run(liveLikeCrawlAdapter("RJ99000001", "dlsite"), {
        repository: services.crawlerRepository,
        actor,
        workerId: "worker-dlsite-live-crawl",
        mode: "live",
      });

      const fixtureReplay = await provenanceBySourceId(context.db, "RJ01111111");
      const liveCrawl = await provenanceBySourceId(context.db, "RJ99000001");
      // Both provenance rows share the SAME catalogSource (`dlsite`); the only way for a
      // reviewer to tell recorded-fixture evidence apart from a live raw-cache capture is the
      // source record kind. The recorded storefront replay MUST be `recorded_fixture` and the
      // live crawl MUST be `raw_cache` — and the two MUST differ.
      expect(fixtureReplay.catalogSource).toBe("dlsite");
      expect(liveCrawl.catalogSource).toBe("dlsite");
      expect(fixtureReplay.sourceRecordKind).toBe(catalogSourceRecordKindValues.recordedFixture);
      expect(liveCrawl.sourceRecordKind).toBe(catalogSourceRecordKindValues.rawCache);
      expect(fixtureReplay.sourceRecordKind).not.toBe(liveCrawl.sourceRecordKind);

      const replayWork = await services.catalogRepository.getWorkByExternalId(
        actor,
        "dlsite",
        "RJ01111111",
        catalogExternalIdKindValues.storeProduct,
      );
      expect(replayWork?.metadata).toMatchObject({
        sourceRecordKind: catalogSourceRecordKindValues.recordedFixture,
      });

      // A recorded storefront adapter CANNOT be driven in `live` mode — its steps
      // generator refuses any mode other than `recorded_fixture`, so a recorded
      // storefront fixture can never masquerade as a live raw-cache crawl and never
      // persists the `raw_cache` marker. Driving it through the runner in `live`
      // mode must reject before any step is persisted.
      await expect(
        services.runner.run(createDlsiteRecordedStorefrontAdapter(dlsiteFixture), {
          repository: services.crawlerRepository,
          actor,
          workerId: "worker-dlsite-storefront-live-refusal",
          mode: "live",
          ingestStep: createCatalogRecordedImporterIngestStep({
            catalogRepository: services.catalogRepository,
            actor,
          }),
        }),
      ).rejects.toThrow(/recorded_fixture mode/u);
      // No live-cache provenance was persisted for the storefront source ids by the refused run.
      const refusedProvenance = await provenanceBySourceId(context.db, "RJ01111111");
      expect(refusedProvenance.sourceRecordKind).toBe(
        catalogSourceRecordKindValues.recordedFixture,
      );

      // The same distinction holds for the recorded Steam storefront adapter: it
      // also persists `recorded_fixture`, never `raw_cache`.
      await runStorefrontFixture(
        services,
        createSteamRecordedStorefrontAdapter(steamFixture),
        "worker-steam-storefront-provenance",
      );
      const steamReplay = await provenanceBySourceId(context.db, "2100010");
      expect(steamReplay.sourceRecordKind).toBe(catalogSourceRecordKindValues.recordedFixture);
      expect(steamReplay.sourceRecordKind).not.toBe(catalogSourceRecordKindValues.rawCache);
    } finally {
      await context.close();
    }
  });
});
