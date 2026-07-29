import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";

import { catalogCompletenessPoolValues } from "../src/repositories/catalog-repository.js";

import { createWikidataRecordedPlatformAdapter } from "../src/services/catalog-recorded-importers.js";
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
