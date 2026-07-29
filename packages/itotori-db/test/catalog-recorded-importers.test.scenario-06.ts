import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";

import { createSteamRecordedStorefrontAdapter } from "../src/services/catalog-recorded-importers.js";
import { catalogExternalIdKindValues, catalogSourceRecordKindValues } from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const actor: AuthorizationActor = { userId: localUserId };

const steamFixture = readStorefrontFixture("steam-storefront-replay.json");

// Each DLsite parse-drift / unsupported-shape case: a synthetic mutation of the
// recorded fixture that drives one diagnostic, plus the COMPLETE diagnostic
// metadata (fixtureId/sourceRevision/stepKey/sourceId/sourceField) it must emit.

// Each Steam parse-drift / unsupported-shape case, with the complete diagnostic
// metadata the appdetails envelope parser must emit.

import {
  servicesFor,
  runStorefrontFixture,
  sourceProvenanceById,
} from "./catalog-recorded-importers.test.shared-01.js";
import {
  rateLimitByAdapter,
  readStorefrontFixture,
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
