import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";

import {
  catalogConfidenceValues,
  catalogDemandFactKindValues,
  catalogExternalIdKindValues,
  catalogLanguageStatusValues,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const actor: AuthorizationActor = { userId: localUserId };

const egsFixture = readFixture("egs-recorded-replay.json");

// Each DLsite parse-drift / unsupported-shape case: a synthetic mutation of the
// recorded fixture that drives one diagnostic, plus the COMPLETE diagnostic
// metadata (fixtureId/sourceRevision/stepKey/sourceId/sourceField) it must emit.

// Each Steam parse-drift / unsupported-shape case, with the complete diagnostic
// metadata the appdetails envelope parser must emit.

import {
  servicesFor,
  runFixture,
  sourceProvenanceById,
} from "./catalog-recorded-importers.test.shared-01.js";
import { readFixture, required } from "./catalog-recorded-importers.test.shared-02.js";
describe("catalog recorded source importers", () => {
  it("imports EGS (ErogameScape) SQL rows with game ids, JP score facts, DLsite links, and request provenance", async () => {
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
        "101001",
      );
      expect(starlight).toMatchObject({
        canonicalTitle: "星影の約束",
        originalLanguage: "ja-JP",
        firstReleaseYear: 2021,
      });
      expect(starlight?.metadata).toMatchObject({
        sourceId: "101001",
        sourceVersion: "egs-erogamescape-sql-synthetic-2026-06-18",
        requestIdentity:
          "POST /~ap2/ero/toukei_kaiseki/sql_for_erogamer_form.php sql=gamelist_by_id id=101001",
        erogamescape: {
          gameId: "101001",
          gamename: "星影の約束",
          brandname: "Fixture Circle",
          sellday: "2021-09-10",
          median: 82,
          count2: 64,
          dlsiteId: "RJ01111111",
        },
      });
      expect(starlight?.externalIds).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            catalogSource: "egs",
            sourceId: "101001",
            externalIdKind: catalogExternalIdKindValues.sourceRecord,
          }),
          expect.objectContaining({
            catalogSource: "dlsite",
            sourceId: "RJ01111111",
            externalIdKind: catalogExternalIdKindValues.storeProduct,
            metadata: expect.objectContaining({
              sourceField: "gamelist.dlsite_id",
              linkedFrom: "egs:101001",
            }),
          }),
        ]),
      );
      expect(
        starlight?.externalIds.filter(
          (externalId) =>
            externalId.catalogSource === "egs" &&
            externalId.externalIdKind === catalogExternalIdKindValues.storeProduct,
        ),
      ).toEqual([]);
      await expect(
        services.catalogRepository.getWorkByExternalId(
          actor,
          "dlsite",
          "RJ01111111",
          catalogExternalIdKindValues.storeProduct,
        ),
      ).resolves.toMatchObject({ workId: starlight?.workId });
      expect(starlight?.languageStatuses).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            language: "ja-JP",
            status: catalogLanguageStatusValues.officialFull,
            metadata: expect.objectContaining({
              assumption: "ErogameScape catalog row is Japanese-market source metadata",
            }),
          }),
          expect.objectContaining({
            language: "en-US",
            status: catalogLanguageStatusValues.unknown,
            confidence: catalogConfidenceValues.low,
          }),
        ]),
      );
      expect(starlight?.demandFacts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            catalogSource: "egs",
            sourceId: "101001",
            factKind: catalogDemandFactKindValues.ratingSummary,
            factValue: {
              median: 82,
              count2: 64,
              audience: "ja-JP",
              scoreScale: "0-100",
            },
            metadata: expect.objectContaining({
              sourceField: "gamelist.median,count2",
              provenance: "ErogameScape Japanese-audience score",
            }),
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
        sourceId: "101001",
        sourceVersion: "egs-erogamescape-sql-synthetic-2026-06-18",
        requestId:
          "POST /~ap2/ero/toukei_kaiseki/sql_for_erogamer_form.php sql=gamelist_by_id id=101001",
        fetchedAt: new Date("2026-06-18T13:05:00.000Z"),
      });
    } finally {
      await context.close();
    }
  });
});
