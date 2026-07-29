import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";

import { catalogCompletenessPoolValues } from "../src/repositories/catalog-repository.js";

import { createIgdbRecordedPlatformAdapter } from "../src/services/catalog-recorded-importers.js";
import {
  catalogConfidenceValues,
  catalogConflictKindValues,
  catalogExternalIdKindValues,
  catalogLanguageStatusValues,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const actor: AuthorizationActor = { userId: localUserId };

const igdbFixture = readPlatformFixture("igdb-platform-replay.json");

// Each DLsite parse-drift / unsupported-shape case: a synthetic mutation of the
// recorded fixture that drives one diagnostic, plus the COMPLETE diagnostic
// metadata (fixtureId/sourceRevision/stepKey/sourceId/sourceField) it must emit.

// Each Steam parse-drift / unsupported-shape case, with the complete diagnostic
// metadata the appdetails envelope parser must emit.

import { servicesFor, runStorefrontFixture } from "./catalog-recorded-importers.test.support.js";
import {
  readPlatformFixture,
  required,
} from "./catalog-recorded-importers.test.fixture-support.js";
describe("catalog recorded source importers", () => {
  it("imports IGDB recorded platform releases and language facts with source provenance", async () => {
    const context = await isolatedMigratedContext();
    try {
      const services = servicesFor(context.db);
      const result = await runStorefrontFixture(
        services,
        createIgdbRecordedPlatformAdapter(igdbFixture),
        "worker-igdb",
      );

      expect(result).toMatchObject({
        fetchedSteps: 1,
        importedSteps: 1,
        skippedSteps: 0,
        replayValidation: [
          {
            sourceId: "252001",
            fixtureId: "catalog-recorded-importer-igdb-platform-v0.1",
            factCount: 1,
            factIdentities: ["catalogSource=igdb|sourceId=252001"],
            alreadyImported: false,
          },
        ],
      });

      const starlight = await services.catalogRepository.getWorkByExternalId(
        actor,
        "igdb",
        "252001",
      );
      expect(starlight).toMatchObject({
        canonicalTitle: "Promise Under Starlight",
        originalLanguage: "ja-JP",
        firstReleaseYear: 2021,
      });
      expect(starlight?.externalIds).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            catalogSource: "igdb",
            sourceId: "252001",
            externalIdKind: catalogExternalIdKindValues.sourceRecord,
            confidence: catalogConfidenceValues.high,
          }),
          expect.objectContaining({
            catalogSource: "wikidata",
            sourceId: "Q130001",
            externalIdKind: catalogExternalIdKindValues.knowledgeBaseEntity,
          }),
          expect.objectContaining({
            catalogSource: "steam",
            sourceId: "2100011",
            externalIdKind: catalogExternalIdKindValues.storeProduct,
          }),
        ]),
      );
      expect(starlight?.releases).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sourceReleaseId: "770001",
            platform: "pc",
            releaseYear: 2021,
            isOfficial: true,
          }),
        ]),
      );
      expect(starlight?.languageStatuses).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            language: "en-US",
            status: catalogLanguageStatusValues.officialFull,
            statusScope: "platform",
            platform: "pc",
            confidence: catalogConfidenceValues.high,
          }),
        ]),
      );
      expect(starlight?.conflicts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            conflictKind: catalogConflictKindValues.languageStatus,
            summary: expect.stringContaining("IGDB reports official English"),
            metadata: expect.objectContaining({
              reasonCode: "official_english_platform_disagreement",
              severity: "warning",
            }),
          }),
        ]),
      );

      const pools = await services.catalogRepository.catalogCompletenessBenchmarkPools(actor, {
        targetLanguage: "en-US",
      });
      expect(pools.pools[catalogCompletenessPoolValues.noEnglish]).toHaveLength(0);
      expect(
        pools.pools[catalogCompletenessPoolValues.conflict].map((work) => work.workId),
      ).toEqual([required(starlight?.workId, "IGDB work id")]);
      expect(pools.publicReport.statuses).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: catalogLanguageStatusValues.officialFull,
            factCount: 1,
          }),
        ]),
      );
    } finally {
      await context.close();
    }
  });
});
