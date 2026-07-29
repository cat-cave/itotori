import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";

import {
  catalogExternalIdKindValues,
  catalogLanguageStatusValues,
  catalogReleaseMappingKindValues,
  catalogReleasePackageKindValues,
  catalogSeedOriginValues,
  catalogSourceRecordKindValues,
  catalogTranslationPortabilityValues,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const actor: AuthorizationActor = { userId: localUserId };

const vndbFixture = readFixture("vndb-dump-replay.json");

// Each DLsite parse-drift / unsupported-shape case: a synthetic mutation of the
// recorded fixture that drives one diagnostic, plus the COMPLETE diagnostic
// metadata (fixtureId/sourceRevision/stepKey/sourceId/sourceField) it must emit.

// Each Steam parse-drift / unsupported-shape case, with the complete diagnostic
// metadata the appdetails envelope parser must emit.

import {
  servicesFor,
  runFixture,
  sourceProvenanceById,
} from "./catalog-recorded-importers.test.support.js";
import { readFixture, required } from "./catalog-recorded-importers.test.fixture-support.js";
import { recordedImporterExpectation01 } from "./catalog-recorded-importers.test.vndb-expectations.js";
describe("catalog recorded source importers", () => {
  it("imports VNDB dump facts with releases, language facts, source ids, and source-version provenance", async () => {
    const context = await isolatedMigratedContext();
    try {
      const services = servicesFor(context.db);
      const result = await runFixture(services, vndbFixture, "worker-vndb");

      expect(result).toMatchObject(recordedImporterExpectation01);

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
            editionName: "Japanese complete edition",
            milestone: "v1001",
            packageKind: catalogReleasePackageKindValues.installer,
          }),
          expect.objectContaining({
            sourceReleaseId: "r5002",
            releaseTitle: "Promise Under Starlight",
            releaseKind: "official_translation",
            language: "en-US",
            editionName: "English complete edition",
            milestone: "v1001",
            packageKind: catalogReleasePackageKindValues.installer,
          }),
        ]),
      );

      // VNDB milestone-like evidence is promoted to first-class release mappings
      // (same-milestone + translation parent-child), not left in a metadata blob.
      const r5001Id = starlight?.releases.find(
        (release) => release.sourceReleaseId === "r5001",
      )?.releaseId;
      const r5002Id = starlight?.releases.find(
        (release) => release.sourceReleaseId === "r5002",
      )?.releaseId;
      expect(starlight?.releaseMappings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sourceReleaseId: r5002Id,
            targetReleaseId: r5001Id,
            relationKind: catalogReleaseMappingKindValues.sameMilestoneAs,
          }),
          expect.objectContaining({
            sourceReleaseId: r5002Id,
            targetReleaseId: r5001Id,
            relationKind: catalogReleaseMappingKindValues.translationOf,
            portability: catalogTranslationPortabilityValues.likelyPortable,
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
      // A recorded-fixture REPLAY (this import runs the crawler in
      // `recorded_fixture` mode) must persist its source provenance as
      // `recorded_fixture`, NOT `raw_cache`: fixture-replay evidence must never
      // masquerade as a live raw-cache crawl on the public explanation surface.
      expect(provenance).toMatchObject({
        catalogSource: "vndb",
        sourceRecordKind: catalogSourceRecordKindValues.recordedFixture,
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
});
