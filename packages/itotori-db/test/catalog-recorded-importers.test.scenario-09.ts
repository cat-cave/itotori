import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";

import {
  createCatalogRecordedImporterIngestStep,
  createDlsiteRecordedStorefrontAdapter,
  createSteamRecordedStorefrontAdapter,
} from "../src/services/catalog-recorded-importers.js";
import { catalogExternalIdKindValues, catalogSourceRecordKindValues } from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const actor: AuthorizationActor = { userId: localUserId };

const dlsiteFixture = readStorefrontFixture("dlsite-storefront-replay.json");
const steamFixture = readStorefrontFixture("steam-storefront-replay.json");

// Each DLsite parse-drift / unsupported-shape case: a synthetic mutation of the
// recorded fixture that drives one diagnostic, plus the COMPLETE diagnostic
// metadata (fixtureId/sourceRevision/stepKey/sourceId/sourceField) it must emit.

// Each Steam parse-drift / unsupported-shape case, with the complete diagnostic
// metadata the appdetails envelope parser must emit.

import {
  servicesFor,
  runStorefrontFixture,
  provenanceBySourceId,
  liveLikeCrawlAdapter,
} from "./catalog-recorded-importers.test.shared-01.js";
import { readStorefrontFixture } from "./catalog-recorded-importers.test.shared-02.js";
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
