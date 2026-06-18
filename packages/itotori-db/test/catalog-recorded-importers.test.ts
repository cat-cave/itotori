import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import { ItotoriCatalogCrawlerRepository } from "../src/repositories/catalog-crawler-repository.js";
import { ItotoriCatalogRepository } from "../src/repositories/catalog-repository.js";
import {
  createRecordedCatalogCrawlerAdapter,
  ItotoriCatalogCrawlerRunner,
  type CatalogCrawlerAdapterStep,
  type CatalogCrawlerSourceAdapter,
  type RecordedCatalogCrawlerFixture,
} from "../src/services/catalog-crawler-runner.js";
import {
  createDlsiteRecordedStorefrontAdapter,
  createCatalogRecordedImporterIngestStep,
  createCatalogRecordedImporterVerifier,
  type CatalogRecordedImporterFact,
  createSteamRecordedStorefrontAdapter,
  type CatalogRecordedStorefrontFixture,
} from "../src/services/catalog-recorded-importers.js";
import {
  catalogExternalIdKindValues,
  catalogLanguageStatusValues,
  catalogSeedOriginValues,
  catalogSourceProvenance,
  catalogSourceRecordKindValues,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const actor: AuthorizationActor = { userId: localUserId };

const vndbFixture = readFixture("vndb-dump-replay.json");
const egsFixture = readFixture("egs-recorded-replay.json");
const dlsiteFixture = readStorefrontFixture("dlsite-storefront-replay.json");
const steamFixture = readStorefrontFixture("steam-storefront-replay.json");

describe("catalog recorded source importers", () => {
  it("imports VNDB dump facts with releases, language facts, source ids, and source-version provenance", async () => {
    const context = await isolatedMigratedContext();
    try {
      const services = servicesFor(context.db);
      const result = await runFixture(services, vndbFixture, "worker-vndb");

      expect(result).toMatchObject({
        fetchedSteps: 2,
        importedSteps: 2,
        skippedSteps: 0,
        replayValidation: [
          {
            sourceId: "v1001",
            fixtureId: "catalog-recorded-importer-vndb-dump-v0.1",
            factCount: 1,
            factIdentities: ["catalogSource=vndb|sourceId=v1001"],
            alreadyImported: false,
          },
          {
            sourceId: "v1002",
            fixtureId: "catalog-recorded-importer-vndb-dump-v0.1",
            factCount: 1,
            factIdentities: ["catalogSource=vndb|sourceId=v1002"],
            alreadyImported: false,
          },
        ],
      });

      const starlight = await services.catalogRepository.getWorkByExternalId(
        actor,
        "vndb",
        "v1001",
      );
      expect(starlight).toMatchObject({
        canonicalTitle: "Promise Under Starlight",
        originalLanguage: "ja-JP",
        firstReleaseYear: 2019,
      });
      expect(starlight?.releases).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sourceReleaseId: "r5001",
            releaseTitle: "星影の約束",
            language: "ja-JP",
          }),
          expect.objectContaining({
            sourceReleaseId: "r5002",
            releaseTitle: "Promise Under Starlight",
            releaseKind: "official_translation",
            language: "en-US",
          }),
        ]),
      );
      expect(starlight?.languageStatuses).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            language: "ja-JP",
            status: catalogLanguageStatusValues.officialFull,
            parserVersion: "catalog-recorded-importers.v0.1",
          }),
          expect.objectContaining({
            language: "en-US",
            status: catalogLanguageStatusValues.officialFull,
            parserVersion: "catalog-recorded-importers.v0.1",
          }),
        ]),
      );
      expect(starlight?.metadata).toMatchObject({
        sourceId: "v1001",
        sourceVersion: "vndb-dump-synthetic-2026-06-18",
        fixtureId: "catalog-recorded-importer-vndb-dump-v0.1",
        alternateTitles: ["星影の約束", "Promise Under Starlight"],
      });

      const sourceExternalId = starlight?.externalIds.find(
        (externalId) => externalId.externalIdKind === catalogExternalIdKindValues.sourceRecord,
      );
      expect(sourceExternalId).toMatchObject({
        catalogSource: "vndb",
        sourceId: "v1001",
      });
      expect(sourceExternalId?.metadata).toMatchObject({
        stableImportKey: result.replayValidation[0]?.stableImportKey,
        importTransactionId: result.replayValidation[0]?.stableImportKey,
      });

      const provenance = await sourceProvenanceById(
        context.db,
        required(sourceExternalId?.sourceProvenanceId, "source provenance id"),
      );
      expect(provenance).toMatchObject({
        catalogSource: "vndb",
        sourceRecordKind: catalogSourceRecordKindValues.rawCache,
        sourceId: "v1001",
        sourceVersion: "vndb-dump-synthetic-2026-06-18",
        requestId: "dump://vndb/vn+releases/v1001",
        ok: true,
      });

      const seedTargets = await services.catalogRepository.listSeedTargets(actor);
      expect(seedTargets).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            catalogSource: "vndb",
            sourceId: "v1001",
            seedOrigin: catalogSeedOriginValues.importer,
            sourceProvenanceId: sourceExternalId?.sourceProvenanceId,
          }),
        ]),
      );
    } finally {
      await context.close();
    }
  });

  it("imports EGS recorded responses with product ids, store metadata, locale facts, and request provenance", async () => {
    const context = await isolatedMigratedContext();
    try {
      const services = servicesFor(context.db);
      const result = await runFixture(services, egsFixture, "worker-egs");

      expect(result).toMatchObject({
        fetchedSteps: 2,
        importedSteps: 2,
        skippedSteps: 0,
      });

      const starlight = await services.catalogRepository.getWorkByExternalId(
        actor,
        "egs",
        "prod-starlight-001",
        catalogExternalIdKindValues.storeProduct,
      );
      expect(starlight).toMatchObject({
        canonicalTitle: "Promise Under Starlight",
        originalLanguage: "ja-JP",
        firstReleaseYear: 2021,
      });
      expect(starlight?.metadata).toMatchObject({
        sourceId: "prod-starlight-001",
        sourceVersion: "egs-recorded-synthetic-2026-06-18",
        requestIdentity: "GET /storefront/products/prod-starlight-001?locale=en-US",
        store: {
          namespace: "fixture-starlight",
          catalogItemId: "9c3f4ad2fixture",
          slug: "promise-under-starlight",
          developer: "Fixture Circle",
          publisher: "Fixture Works",
        },
      });
      expect(starlight?.externalIds).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            catalogSource: "egs",
            sourceId: "prod-starlight-001",
            externalIdKind: catalogExternalIdKindValues.sourceRecord,
          }),
          expect.objectContaining({
            catalogSource: "egs",
            sourceId: "prod-starlight-001",
            externalIdKind: catalogExternalIdKindValues.storeProduct,
            metadata: expect.objectContaining({
              namespace: "fixture-starlight",
              catalogItemId: "9c3f4ad2fixture",
              slug: "promise-under-starlight",
            }),
          }),
        ]),
      );
      expect(starlight?.languageStatuses).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            language: "en-US",
            status: catalogLanguageStatusValues.officialFull,
            platform: "egs",
          }),
          expect.objectContaining({
            language: "ja-JP",
            status: catalogLanguageStatusValues.officialFull,
            platform: "egs",
          }),
        ]),
      );

      const sourceExternalId = starlight?.externalIds.find(
        (externalId) => externalId.externalIdKind === catalogExternalIdKindValues.sourceRecord,
      );
      const provenance = await sourceProvenanceById(
        context.db,
        required(sourceExternalId?.sourceProvenanceId, "source provenance id"),
      );
      expect(provenance).toMatchObject({
        catalogSource: "egs",
        sourceId: "prod-starlight-001",
        sourceVersion: "egs-recorded-synthetic-2026-06-18",
        requestId: "GET /storefront/products/prod-starlight-001?locale=en-US",
        fetchedAt: new Date("2026-06-18T13:05:00.000Z"),
      });
    } finally {
      await context.close();
    }
  });

  it("imports DLsite recorded storefront responses with demand facts, translation metadata, and provenance diagnostics", async () => {
    const context = await isolatedMigratedContext();
    try {
      const services = servicesFor(context.db);
      const result = await runStorefrontFixture(
        services,
        createDlsiteRecordedStorefrontAdapter(dlsiteFixture),
        "worker-dlsite",
      );

      expect(result).toMatchObject({
        fetchedSteps: 2,
        importedSteps: 2,
        skippedSteps: 0,
        replayValidation: [
          {
            sourceId: "RJ01111111",
            fixtureId: "catalog-recorded-importer-dlsite-storefront-v0.1",
            factCount: 1,
            factIdentities: ["catalogSource=dlsite|sourceId=RJ01111111"],
            alreadyImported: false,
          },
          {
            sourceId: "RJ02222222",
            fixtureId: "catalog-recorded-importer-dlsite-storefront-v0.1",
            factCount: 1,
            factIdentities: ["catalogSource=dlsite|sourceId=RJ02222222"],
            alreadyImported: false,
          },
        ],
      });

      const starlight = await services.catalogRepository.getWorkByExternalId(
        actor,
        "dlsite",
        "RJ01111111",
        catalogExternalIdKindValues.storeProduct,
      );
      expect(starlight).toMatchObject({
        canonicalTitle: "Promise Under Starlight",
        originalLanguage: "ja-JP",
        firstReleaseYear: 2021,
        workKind: "ADV",
      });
      expect(starlight?.metadata).toMatchObject({
        storefront: "dlsite",
        workno: "RJ01111111",
        workType: "ADV",
        translationInfo: {
          original_workno: "RJ00001001",
          child_worknos: ["RJ01111111"],
        },
        demand: {
          dlCount: 18420,
          ratingSummary: { average: 4.72, count: 512 },
          ratingHistogram: { "5": 401 },
          wishlistCount: 9321,
          rankFacts: [{ scope: "daily", category: "ADV", rank: 8 }],
        },
        translationTree: {
          original: { workno: "RJ00001001", locale: "ja-JP" },
          translations: [{ workno: "RJ01111111", locale: "en-US" }],
        },
      });
      expect(starlight?.languageStatuses).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            language: "ja-JP",
            status: catalogLanguageStatusValues.officialFull,
            platform: "dlsite",
          }),
          expect.objectContaining({
            language: "en-US",
            status: catalogLanguageStatusValues.officialFull,
            platform: "dlsite",
          }),
        ]),
      );

      const glass = await services.catalogRepository.getWorkByExternalId(
        actor,
        "dlsite",
        "RJ02222222",
        catalogExternalIdKindValues.storeProduct,
      );
      expect(glass?.metadata).toMatchObject({
        storefront: "dlsite",
        demand: {
          dlCount: 640,
          ratingSummary: { average: 4.1, count: 27 },
          ratingHistogram: { "5": 13 },
        },
        diagnostics: [
          expect.objectContaining({
            code: "missing_demand_field",
            fixtureId: "catalog-recorded-importer-dlsite-storefront-v0.1",
            sourceRevision: "dlsite-storefront-synthetic-2026-06-18",
            sourceField: "demand.wishlist_count",
          }),
          expect.objectContaining({
            code: "missing_demand_field",
            sourceField: "demand.rank_facts",
          }),
        ],
      });

      const sourceExternalId = starlight?.externalIds.find(
        (externalId) => externalId.externalIdKind === catalogExternalIdKindValues.sourceRecord,
      );
      const provenance = await sourceProvenanceById(
        context.db,
        required(sourceExternalId?.sourceProvenanceId, "source provenance id"),
      );
      expect(provenance).toMatchObject({
        catalogSource: "dlsite",
        sourceId: "RJ01111111",
        requestId: "GET /maniax/work/=/product_id/RJ01111111.html?locale=en_US",
        sourceVersion: "dlsite-storefront-synthetic-2026-06-18",
        metadata: expect.objectContaining({
          fixtureId: "catalog-recorded-importer-dlsite-storefront-v0.1",
          sourceRevision: "dlsite-storefront-synthetic-2026-06-18",
          diagnostics: [],
        }),
      });
      expect(
        await services.crawlerRepository.getCheckpoint(actor, {
          catalogSource: "dlsite",
          adapterName: "dlsite-recorded-storefront-importer",
          partitionKey: "public-dlsite-storefront",
        }),
      ).toMatchObject({ lastStepKey: "dlsite-rj02222222" });
      await expect(
        rateLimitByAdapter(context.pool, "dlsite-recorded-storefront-importer"),
      ).resolves.toMatchObject({
        catalog_source: "dlsite",
        remaining: 18,
        limit: 20,
        request_identity: "GET /maniax/work/=/product_id/RJ01111111.html?locale=en_US",
        metadata: { policy: "recorded-fixture", source: "dlsite" },
      });
      await expect(services.catalogRepository.listSeedTargets(actor)).resolves.toEqual([]);
    } finally {
      await context.close();
    }
  });

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
      expect(provenance).toMatchObject({
        catalogSource: "steam",
        sourceId: "2100010",
        requestId: "GET /api/appdetails?appids=2100010&cc=us&l=english",
      });
      await expect(services.catalogRepository.listSeedTargets(actor)).resolves.toEqual([]);
    } finally {
      await context.close();
    }
  });

  it("reruns updated VNDB and EGS fixtures idempotently without duplicate facts", async () => {
    const context = await isolatedMigratedContext();
    try {
      const services = servicesFor(context.db);
      await runFixture(services, vndbFixture, "worker-vndb-initial");
      await runFixture(services, egsFixture, "worker-egs-initial");
      const initialCounts = await catalogCounts(context.pool);

      const noOp = await runFixture(services, vndbFixture, "worker-vndb-noop");
      expect(noOp).toMatchObject({ fetchedSteps: 0, importedSteps: 0, skippedSteps: 0 });
      await expect(catalogCounts(context.pool)).resolves.toEqual(initialCounts);

      const updatedVndb = withUpdatedFact(vndbFixture, "v1001", {
        sourceVersion: "vndb-dump-synthetic-2026-06-18-revision-2",
        canonicalTitle: "Promise Under Starlight HD",
        releaseTitle: "Promise Under Starlight HD",
      });
      const updatedEgs = withUpdatedFact(egsFixture, "prod-starlight-001", {
        sourceVersion: "egs-recorded-synthetic-2026-06-18-revision-2",
        canonicalTitle: "Promise Under Starlight Complete",
        releaseTitle: "Promise Under Starlight Complete",
      });

      await expect(runFixture(services, updatedVndb, "worker-vndb-update")).resolves.toMatchObject({
        fetchedSteps: 2,
        importedSteps: 2,
        skippedSteps: 0,
      });
      await expect(runFixture(services, updatedEgs, "worker-egs-update")).resolves.toMatchObject({
        fetchedSteps: 2,
        importedSteps: 2,
        skippedSteps: 0,
      });
      await expect(catalogCounts(context.pool)).resolves.toEqual(initialCounts);

      await expect(
        services.catalogRepository.getWorkByExternalId(actor, "vndb", "v1001"),
      ).resolves.toMatchObject({
        canonicalTitle: "Promise Under Starlight HD",
        releases: expect.arrayContaining([
          expect.objectContaining({ releaseTitle: "Promise Under Starlight HD" }),
        ]),
        metadata: expect.objectContaining({
          sourceVersion: "vndb-dump-synthetic-2026-06-18-revision-2",
        }),
      });
      await expect(
        services.catalogRepository.getWorkByExternalId(
          actor,
          "egs",
          "prod-starlight-001",
          catalogExternalIdKindValues.storeProduct,
        ),
      ).resolves.toMatchObject({
        canonicalTitle: "Promise Under Starlight Complete",
        releases: expect.arrayContaining([
          expect.objectContaining({ releaseTitle: "Promise Under Starlight Complete" }),
        ]),
        metadata: expect.objectContaining({
          sourceVersion: "egs-recorded-synthetic-2026-06-18-revision-2",
        }),
      });
    } finally {
      await context.close();
    }
  });

  it("reruns DLsite and Steam storefront adapters idempotently without duplicate facts", async () => {
    const context = await isolatedMigratedContext();
    try {
      const services = servicesFor(context.db);
      await runStorefrontFixture(
        services,
        createDlsiteRecordedStorefrontAdapter(dlsiteFixture),
        "worker-dlsite-initial",
      );
      await runStorefrontFixture(
        services,
        createSteamRecordedStorefrontAdapter(steamFixture),
        "worker-steam-initial",
      );
      const initialCounts = await catalogCounts(context.pool);

      await expect(
        runStorefrontFixture(
          services,
          createDlsiteRecordedStorefrontAdapter(dlsiteFixture),
          "worker-dlsite-noop",
        ),
      ).resolves.toMatchObject({ fetchedSteps: 0, importedSteps: 0, skippedSteps: 0 });
      await expect(
        runStorefrontFixture(
          services,
          createSteamRecordedStorefrontAdapter(steamFixture),
          "worker-steam-noop",
        ),
      ).resolves.toMatchObject({ fetchedSteps: 0, importedSteps: 0, skippedSteps: 0 });
      await expect(catalogCounts(context.pool)).resolves.toEqual(initialCounts);
    } finally {
      await context.close();
    }
  });

  it("reports parser drift and unsupported storefront response shapes as semantic diagnostics", () => {
    const badDlsite = structuredClone(dlsiteFixture);
    const dlsiteResponse = required(badDlsite.responses[0], "DLsite response");
    dlsiteResponse.payload = { ...dlsiteResponse.payload };
    delete dlsiteResponse.payload.title;
    expect(() => createDlsiteRecordedStorefrontAdapter(badDlsite)).toThrow(
      /CATALOG-012 semantic diagnostic parse_drift fixtureId=catalog-recorded-importer-dlsite-storefront-v0\.1 sourceRevision=dlsite-storefront-synthetic-2026-06-18/u,
    );

    const missingTranslationInfo = structuredClone(dlsiteFixture);
    const missingTranslationInfoResponse = required(
      missingTranslationInfo.responses[0],
      "DLsite response",
    );
    missingTranslationInfoResponse.payload = { ...missingTranslationInfoResponse.payload };
    delete missingTranslationInfoResponse.payload.translation_info;
    expect(() => createDlsiteRecordedStorefrontAdapter(missingTranslationInfo)).toThrow(
      /CATALOG-012 semantic diagnostic unsupported_response_shape fixtureId=catalog-recorded-importer-dlsite-storefront-v0\.1 sourceRevision=dlsite-storefront-synthetic-2026-06-18 stepKey=dlsite-rj01111111 sourceId=RJ01111111 sourceField=translation_info/u,
    );

    const badSteam = structuredClone(steamFixture);
    const steamResponse = required(badSteam.responses[1], "Steam response");
    steamResponse.payload = {
      "2100099": { success: false, steam_appid: "2100099" },
    };
    expect(() => createSteamRecordedStorefrontAdapter(badSteam)).toThrow(
      /CATALOG-012 semantic diagnostic unsupported_response_shape fixtureId=catalog-recorded-importer-steam-storefront-v0\.1 sourceRevision=steam-storefront-synthetic-2026-06-18/u,
    );

    const missingData = structuredClone(steamFixture);
    const missingDataResponse = required(missingData.responses[0], "Steam response");
    missingDataResponse.payload = { "2100010": { success: true } };
    expect(() => createSteamRecordedStorefrontAdapter(missingData)).toThrow(
      /CATALOG-012 semantic diagnostic unsupported_response_shape fixtureId=catalog-recorded-importer-steam-storefront-v0\.1 sourceRevision=steam-storefront-synthetic-2026-06-18 stepKey=steam-2100010 sourceId=2100010 sourceField=2100010\.data/u,
    );

    const appIdMismatch = structuredClone(steamFixture);
    const appIdMismatchResponse = required(appIdMismatch.responses[0], "Steam response");
    appIdMismatchResponse.payload = {
      "2100011": { success: true, data: { steam_appid: 2100011 } },
    };
    expect(() => createSteamRecordedStorefrontAdapter(appIdMismatch)).toThrow(
      /CATALOG-012 semantic diagnostic parse_drift fixtureId=catalog-recorded-importer-steam-storefront-v0\.1 sourceRevision=steam-storefront-synthetic-2026-06-18 stepKey=steam-2100010 sourceId=2100010 sourceField=2100011/u,
    );

    const unexpectedEnvelope = structuredClone(steamFixture);
    const unexpectedEnvelopeResponse = required(unexpectedEnvelope.responses[0], "Steam response");
    unexpectedEnvelopeResponse.payload = {
      "2100010": { success: true, data: { steam_appid: 2100010 } },
      "2100011": { success: false, delisting_status: "delisted" },
    };
    expect(() => createSteamRecordedStorefrontAdapter(unexpectedEnvelope)).toThrow(
      /CATALOG-012 semantic diagnostic unsupported_response_shape fixtureId=catalog-recorded-importer-steam-storefront-v0\.1 sourceRevision=steam-storefront-synthetic-2026-06-18 stepKey=steam-2100010 sourceId=2100010 sourceField=appdetails/u,
    );
  });

  it("validates DLsite enum drift and preserves unmapped Steam locale diagnostics", async () => {
    const badStatus = structuredClone(dlsiteFixture);
    const badStatusResponse = required(badStatus.responses[0], "DLsite response");
    const badStatusTranslationInfo = record(
      badStatusResponse.payload.translation_info,
      "translation_info",
    );
    const badStatusEditions = requiredArray(
      badStatusTranslationInfo.language_editions,
      "language_editions",
    );
    record(badStatusEditions[0], "language edition").status = "official-ish";
    expect(() => createDlsiteRecordedStorefrontAdapter(badStatus)).toThrow(
      /CATALOG-012 semantic diagnostic parse_drift fixtureId=catalog-recorded-importer-dlsite-storefront-v0\.1 sourceRevision=dlsite-storefront-synthetic-2026-06-18 stepKey=dlsite-rj01111111 sourceId=RJ01111111 sourceField=translation_info\.language_editions\[0\]\.status/u,
    );

    const badConfidence = structuredClone(dlsiteFixture);
    const badConfidenceResponse = required(badConfidence.responses[1], "DLsite response");
    const badConfidenceTranslationInfo = record(
      badConfidenceResponse.payload.translation_info,
      "translation_info",
    );
    const badConfidenceEditions = requiredArray(
      badConfidenceTranslationInfo.language_editions,
      "language_editions",
    );
    record(badConfidenceEditions[1], "language edition").confidence = "pretty_sure";
    expect(() => createDlsiteRecordedStorefrontAdapter(badConfidence)).toThrow(
      /CATALOG-012 semantic diagnostic parse_drift fixtureId=catalog-recorded-importer-dlsite-storefront-v0\.1 sourceRevision=dlsite-storefront-synthetic-2026-06-18 stepKey=dlsite-rj02222222 sourceId=RJ02222222 sourceField=translation_info\.language_editions\[1\]\.confidence/u,
    );

    const unknownSteamLocale = structuredClone(steamFixture);
    const unknownSteamLocaleResponse = required(unknownSteamLocale.responses[0], "Steam response");
    const appdetails = record(
      unknownSteamLocaleResponse.payload["2100010"],
      "Steam appdetails envelope",
    );
    const data = record(appdetails.data, "Steam appdetails data");
    data.supported_languages = "English<strong>*</strong>, Martian";
    const steps = await storefrontSteps(createSteamRecordedStorefrontAdapter(unknownSteamLocale));
    const step = required(steps[0], "Steam step");
    expect(step.metadata).toMatchObject({
      diagnostics: [
        expect.objectContaining({
          code: "parse_drift",
          fixtureId: "catalog-recorded-importer-steam-storefront-v0.1",
          sourceRevision: "steam-storefront-synthetic-2026-06-18",
          sourceField: "data.supported_languages",
        }),
      ],
    });
    expect(step.facts[0]?.metadata).toMatchObject({
      localeMetadata: {
        parsedLocales: ["en-US"],
        unknownLocaleLabels: ["Martian"],
      },
    });
  });
});

type Services = ReturnType<typeof servicesFor>;

function servicesFor(db: Parameters<typeof ItotoriCatalogRepository>[0]): {
  catalogRepository: ItotoriCatalogRepository;
  crawlerRepository: ItotoriCatalogCrawlerRepository;
  runner: ItotoriCatalogCrawlerRunner;
} {
  return {
    catalogRepository: new ItotoriCatalogRepository(db),
    crawlerRepository: new ItotoriCatalogCrawlerRepository(db),
    runner: new ItotoriCatalogCrawlerRunner(),
  };
}

async function runFixture(
  services: Services,
  fixture: RecordedCatalogCrawlerFixture<CatalogRecordedImporterFact>,
  workerId: string,
) {
  return services.runner.run(createRecordedCatalogCrawlerAdapter(fixture), {
    repository: services.crawlerRepository,
    actor,
    workerId,
    mode: "recorded_fixture",
    ingestStep: createCatalogRecordedImporterIngestStep({
      catalogRepository: services.catalogRepository,
      actor,
    }),
    verifyFactImport: createCatalogRecordedImporterVerifier({
      catalogRepository: services.catalogRepository,
      actor,
    }),
  });
}

async function runStorefrontFixture(
  services: Services,
  adapter: CatalogCrawlerSourceAdapter<CatalogRecordedImporterFact>,
  workerId: string,
) {
  return services.runner.run(adapter, {
    repository: services.crawlerRepository,
    actor,
    workerId,
    mode: "recorded_fixture",
    ingestStep: createCatalogRecordedImporterIngestStep({
      catalogRepository: services.catalogRepository,
      actor,
    }),
    verifyFactImport: createCatalogRecordedImporterVerifier({
      catalogRepository: services.catalogRepository,
      actor,
    }),
  });
}

async function storefrontSteps(
  adapter: CatalogCrawlerSourceAdapter<CatalogRecordedImporterFact>,
): Promise<CatalogCrawlerAdapterStep<CatalogRecordedImporterFact>[]> {
  const steps: CatalogCrawlerAdapterStep<CatalogRecordedImporterFact>[] = [];
  for await (const step of adapter.steps({ checkpointCursor: null, mode: "recorded_fixture" })) {
    steps.push(step);
  }
  return steps;
}

async function sourceProvenanceById(
  db: Parameters<typeof ItotoriCatalogRepository>[0],
  id: string,
) {
  const rows = await db
    .select()
    .from(catalogSourceProvenance)
    .where(eq(catalogSourceProvenance.sourceProvenanceId, id))
    .limit(1);
  return required(rows[0], `source provenance ${id}`);
}

async function catalogCounts(pool: {
  query<T extends object = object>(sql: string): Promise<{ rows: T[] }>;
}) {
  const result = await pool.query<{
    works: string;
    external_ids: string;
    releases: string;
    language_statuses: string;
    seed_targets: string;
  }>(`
    select
      (select count(*) from itotori_catalog_works)::text as works,
      (select count(*) from itotori_catalog_external_ids)::text as external_ids,
      (select count(*) from itotori_catalog_releases)::text as releases,
      (select count(*) from itotori_catalog_language_statuses)::text as language_statuses,
      (select count(*) from itotori_catalog_seed_targets)::text as seed_targets
  `);
  return result.rows[0];
}

async function rateLimitByAdapter(
  pool: {
    query<T extends object = object>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
  },
  adapterName: string,
) {
  const result = await pool.query<{
    catalog_source: string;
    remaining: number | null;
    limit: number | null;
    request_identity: string | null;
    metadata: Record<string, unknown>;
  }>(
    `
      select catalog_source, remaining, "limit", request_identity, metadata
      from itotori_catalog_crawler_rate_limits
      where adapter_name = $1
      limit 1
    `,
    [adapterName],
  );
  return required(result.rows[0], `rate limit for ${adapterName}`);
}

function readFixture(name: string): RecordedCatalogCrawlerFixture<CatalogRecordedImporterFact> {
  return JSON.parse(
    readFileSync(
      new URL(`../../../fixtures/catalog-recorded-importers/${name}`, import.meta.url),
      "utf8",
    ),
  ) as RecordedCatalogCrawlerFixture<CatalogRecordedImporterFact>;
}

function readStorefrontFixture(name: string): CatalogRecordedStorefrontFixture {
  return JSON.parse(
    readFileSync(
      new URL(`../../../fixtures/catalog-recorded-importers/${name}`, import.meta.url),
      "utf8",
    ),
  ) as CatalogRecordedStorefrontFixture;
}

function withUpdatedFact(
  fixture: RecordedCatalogCrawlerFixture<CatalogRecordedImporterFact>,
  sourceId: string,
  update: { sourceVersion: string; canonicalTitle: string; releaseTitle: string },
): RecordedCatalogCrawlerFixture<CatalogRecordedImporterFact> {
  const copy = structuredClone(fixture);
  copy.sourceVersion = update.sourceVersion;
  for (const step of copy.steps) {
    if (step.sourceId !== sourceId) {
      continue;
    }
    step.payload = { ...step.payload, updateRevision: update.sourceVersion };
    const fact = step.facts[0];
    if (fact === undefined) {
      throw new Error(`fixture step ${step.stepKey} has no fact`);
    }
    fact.canonicalTitle = update.canonicalTitle;
    const release = fact.releases?.at(-1);
    if (release === undefined) {
      throw new Error(`fixture step ${step.stepKey} has no release`);
    }
    release.releaseTitle = update.releaseTitle;
  }
  return copy;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a record`);
  }
  return value as Record<string, unknown>;
}

function requiredArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`${label} is required`);
  }
  return value;
}
