import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";

import { catalogCompletenessPoolValues } from "../src/repositories/catalog-repository.js";

import {
  createIgdbRecordedPlatformAdapter,
  createWikidataRecordedPlatformAdapter,
} from "../src/services/catalog-recorded-importers.js";

import { isolatedMigratedContext } from "./db-test-context.js";

const actor: AuthorizationActor = { userId: localUserId };

const vndbFixture = readFixture("vndb-dump-replay.json");

const igdbFixture = readPlatformFixture("igdb-platform-replay.json");
const wikidataFixture = readPlatformFixture("wikidata-platform-replay.json");

// Each DLsite parse-drift / unsupported-shape case: a synthetic mutation of the
// recorded fixture that drives one diagnostic, plus the COMPLETE diagnostic
// metadata (fixtureId/sourceRevision/stepKey/sourceId/sourceField) it must emit.

// Each Steam parse-drift / unsupported-shape case, with the complete diagnostic
// metadata the appdetails envelope parser must emit.

import {
  servicesFor,
  runFixture,
  runStorefrontFixture,
} from "./catalog-recorded-importers.test.shared-01.js";
import {
  readFixture,
  readPlatformFixture,
  required,
} from "./catalog-recorded-importers.test.shared-02.js";
describe("catalog recorded source importers", () => {
  it("demotes recorded IGDB and Wikidata platform-language conflicts from alpha benchmark seeds", async () => {
    const context = await isolatedMigratedContext();
    try {
      const services = servicesFor(context.db);
      await runFixture(services, vndbFixture, "worker-vndb-before-platform-ranking");
      const vndbNoEnglish = await services.catalogRepository.getWorkByExternalId(
        actor,
        "vndb",
        "v1002",
      );

      const before = await services.catalogRepository.catalogAlphaBenchmarkOpportunityRanking(
        actor,
        { targetLanguage: "en-US" },
      );
      const beforeNoEnglish = required(
        before.rows.find((row) => row.workId === vndbNoEnglish?.workId),
        "VNDB no-English ranking row before platform imports",
      );
      expect(beforeNoEnglish).toMatchObject({
        candidatePool: catalogCompletenessPoolValues.noEnglish,
        decision: "seed",
        seedRank: 1,
        demotions: [],
      });

      await runStorefrontFixture(
        services,
        createIgdbRecordedPlatformAdapter(igdbFixture),
        "worker-igdb-platform-ranking",
      );
      await runStorefrontFixture(
        services,
        createWikidataRecordedPlatformAdapter(wikidataFixture),
        "worker-wikidata-platform-ranking",
      );

      const after = await services.catalogRepository.catalogAlphaBenchmarkOpportunityRanking(
        actor,
        { targetLanguage: "en-US" },
      );
      const afterNoEnglish = required(
        after.rows.find((row) => row.workId === vndbNoEnglish?.workId),
        "VNDB no-English ranking row after platform imports",
      );
      expect(afterNoEnglish).toMatchObject({
        candidatePool: catalogCompletenessPoolValues.noEnglish,
        decision: "demoted",
        seedRank: null,
        explanation: expect.stringContaining("official_english_platform_disagreement"),
      });
      expect(afterNoEnglish.score).toBeLessThan(beforeNoEnglish.score);
      expect(afterNoEnglish.demotions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            reasonCode: "official_english_platform_disagreement",
            reasonDetail: expect.stringContaining("IGDB reports official English"),
            sourceIds: expect.arrayContaining([
              { catalogSource: "igdb", sourceId: "252001" },
              { catalogSource: "vndb", sourceId: "v1002" },
            ]),
            // CATALOG-089: demotion provenance names the ORIGINAL evidence source
            // for each evidence row (official IGDB + candidate VNDB), not collapsed
            // to the single importer-payload (IGDB) provenance.
            provenance: expect.arrayContaining([
              expect.objectContaining({ catalogSource: "igdb", sourceId: "252001" }),
              expect.objectContaining({ catalogSource: "vndb", sourceId: "v1002" }),
            ]),
          }),
          expect.objectContaining({
            reasonCode: "official_english_platform_disagreement",
            reasonDetail: expect.stringContaining("Wikidata reports official English"),
            sourceIds: expect.arrayContaining([
              { catalogSource: "wikidata", sourceId: "Q130099" },
              { catalogSource: "vndb", sourceId: "v1002" },
            ]),
            provenance: expect.arrayContaining([
              expect.objectContaining({ catalogSource: "wikidata", sourceId: "Q130099" }),
              expect.objectContaining({ catalogSource: "vndb", sourceId: "v1002" }),
            ]),
          }),
        ]),
      );

      const seedOnly = await services.catalogRepository.catalogAlphaBenchmarkOpportunityRanking(
        actor,
        { targetLanguage: "en-US", includeDemoted: false },
      );
      expect(seedOnly.rows.map((row) => row.workId)).toEqual(
        expect.not.arrayContaining([required(vndbNoEnglish?.workId, "VNDB no-English work id")]),
      );
    } finally {
      await context.close();
    }
  });
});
