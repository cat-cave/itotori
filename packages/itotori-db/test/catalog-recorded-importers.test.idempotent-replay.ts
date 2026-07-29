import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";

import {
  createDlsiteRecordedStorefrontAdapter,
  createIgdbRecordedPlatformAdapter,
  createSteamRecordedStorefrontAdapter,
  createWikidataRecordedPlatformAdapter,
} from "../src/services/catalog-recorded-importers.js";

import { isolatedMigratedContext } from "./db-test-context.js";

const actor: AuthorizationActor = { userId: localUserId };

const vndbFixture = readFixture("vndb-dump-replay.json");
const egsFixture = readFixture("egs-recorded-replay.json");
const dlsiteFixture = readStorefrontFixture("dlsite-storefront-replay.json");
const steamFixture = readStorefrontFixture("steam-storefront-replay.json");
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
} from "./catalog-recorded-importers.test.support.js";
import {
  catalogCounts,
  readFixture,
  readStorefrontFixture,
  readPlatformFixture,
  withUpdatedFact,
} from "./catalog-recorded-importers.test.fixture-support.js";
describe("catalog recorded source importers", () => {
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
      const updatedEgs = withUpdatedFact(egsFixture, "101001", {
        sourceVersion: "egs-erogamescape-sql-synthetic-2026-06-18-revision-2",
        canonicalTitle: "星影の約束 改訂版",
        releaseTitle: "星影の約束 改訂版",
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
        services.catalogRepository.getWorkByExternalId(actor, "egs", "101001"),
      ).resolves.toMatchObject({
        canonicalTitle: "星影の約束 改訂版",
        releases: expect.arrayContaining([
          expect.objectContaining({ releaseTitle: "星影の約束 改訂版" }),
        ]),
        metadata: expect.objectContaining({
          sourceVersion: "egs-erogamescape-sql-synthetic-2026-06-18-revision-2",
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

  it("reruns IGDB and Wikidata platform adapters idempotently without duplicate facts", async () => {
    const context = await isolatedMigratedContext();
    try {
      const services = servicesFor(context.db);
      await runStorefrontFixture(
        services,
        createIgdbRecordedPlatformAdapter(igdbFixture),
        "worker-igdb-initial",
      );
      await runStorefrontFixture(
        services,
        createWikidataRecordedPlatformAdapter(wikidataFixture),
        "worker-wikidata-initial",
      );
      const initialCounts = await catalogCounts(context.pool);

      await expect(
        runStorefrontFixture(
          services,
          createIgdbRecordedPlatformAdapter(igdbFixture),
          "worker-igdb-noop",
        ),
      ).resolves.toMatchObject({ fetchedSteps: 0, importedSteps: 0, skippedSteps: 0 });
      await expect(
        runStorefrontFixture(
          services,
          createWikidataRecordedPlatformAdapter(wikidataFixture),
          "worker-wikidata-noop",
        ),
      ).resolves.toMatchObject({ fetchedSteps: 0, importedSteps: 0, skippedSteps: 0 });
      await expect(catalogCounts(context.pool)).resolves.toEqual(initialCounts);
    } finally {
      await context.close();
    }
  });
});
