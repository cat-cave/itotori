import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";

import { createDlsiteRecordedStorefrontAdapter } from "../src/services/catalog-recorded-importers.js";
import {
  catalogExternalIdKindValues,
  catalogLanguageStatusValues,
  catalogSourceRecordKindValues,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const actor: AuthorizationActor = { userId: localUserId };

const dlsiteFixture = readStorefrontFixture("dlsite-storefront-replay.json");

// Each DLsite parse-drift / unsupported-shape case: a synthetic mutation of the
// recorded fixture that drives one diagnostic, plus the COMPLETE diagnostic
// metadata (fixtureId/sourceRevision/stepKey/sourceId/sourceField) it must emit.

// Each Steam parse-drift / unsupported-shape case, with the complete diagnostic
// metadata the appdetails envelope parser must emit.

import {
  servicesFor,
  runStorefrontFixture,
  sourceProvenanceById,
} from "./catalog-recorded-importers.test.support.js";
import {
  rateLimitByAdapter,
  readStorefrontFixture,
  required,
} from "./catalog-recorded-importers.test.fixture-support.js";
import { recordedImporterExpectation05 } from "./catalog-recorded-importers.test.dlsite-expectations.js";
describe("catalog recorded source importers", () => {
  it("imports DLsite recorded storefront responses with demand facts, translation metadata, and provenance diagnostics", async () => {
    const context = await isolatedMigratedContext();
    try {
      const services = servicesFor(context.db);
      const result = await runStorefrontFixture(
        services,
        createDlsiteRecordedStorefrontAdapter(dlsiteFixture),
        "worker-dlsite",
      );

      expect(result).toMatchObject(recordedImporterExpectation05);

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
            sourceField: "wishlist_count",
          }),
          expect.objectContaining({
            code: "missing_demand_field",
            sourceField: "rank_facts",
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
      // A recorded DLsite storefront REPLAY must persist its source provenance record kind as
      // `recorded_fixture`, NOT `raw_cache`: fixture-replay evidence must never
      // masquerade as a live raw-cache crawl on the public explanation surface.
      expect(provenance).toMatchObject({
        catalogSource: "dlsite",
        sourceRecordKind: catalogSourceRecordKindValues.recordedFixture,
        sourceId: "RJ01111111",
        requestId: "GET /maniax/work/=/product_id/RJ01111111.html?locale=en_US",
        sourceVersion: "dlsite-storefront-synthetic-2026-06-18",
        metadata: expect.objectContaining({
          fixtureId: "catalog-recorded-importer-dlsite-storefront-v0.1",
          sourceRevision: "dlsite-storefront-synthetic-2026-06-18",
          diagnostics: [],
        }),
      });
      expect(provenance.sourceRecordKind).not.toBe(catalogSourceRecordKindValues.rawCache);
      // The fixture-mode provenance marker is ALSO stamped onto the persisted fact metadata, so a
      // consumer reading only the work metadata (not the provenance row) can still tell
      // replayed fixture evidence apart from live raw-cache evidence.
      expect(starlight?.metadata).toMatchObject({
        sourceRecordKind: catalogSourceRecordKindValues.recordedFixture,
      });
      expect(
        await services.crawlerRepository.getCheckpoint(actor, {
          catalogSource: "dlsite",
          adapterName: "dlsite-recorded-storefront-importer",
          partitionKey: "public-dlsite-storefront",
        }),
      ).toMatchObject({ lastStepKey: "dlsite-rj03333333-jp-recovered" });
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
});
