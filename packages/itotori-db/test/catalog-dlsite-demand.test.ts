import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import { ItotoriCatalogCrawlerRepository } from "../src/repositories/catalog-crawler-repository.js";
import { ItotoriCatalogRepository } from "../src/repositories/catalog-repository.js";
import {
  createCatalogRecordedImporterIngestStep,
  createCatalogRecordedImporterVerifier,
  createDlsiteRecordedStorefrontAdapter,
  type CatalogRecordedStorefrontFixture,
} from "../src/services/catalog-recorded-importers.js";
import { ItotoriCatalogCrawlerRunner } from "../src/services/catalog-crawler-runner.js";
import {
  catalogDemandFactKindValues,
  catalogExternalIdKindValues,
  catalogLanguageStatusValues,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const actor: AuthorizationActor = { userId: localUserId };
const dlsiteFixture = readStorefrontFixture("dlsite-storefront-replay.json");
const parseDriftFixture = readStorefrontFixture("dlsite-demand-parse-drift-replay.json");

describe("dlsite-demand recorded importer", () => {
  it("imports typed DLsite demand facts and does not create zero-valued missing facts", async () => {
    const context = await isolatedMigratedContext();
    try {
      const services = {
        catalogRepository: new ItotoriCatalogRepository(context.db),
        crawlerRepository: new ItotoriCatalogCrawlerRepository(context.db),
        runner: new ItotoriCatalogCrawlerRunner(),
      };

      await services.runner.run(createDlsiteRecordedStorefrontAdapter(dlsiteFixture), {
        repository: services.crawlerRepository,
        actor,
        workerId: "worker-dlsite-demand",
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

      const normal = await services.catalogRepository.getWorkByExternalId(
        actor,
        "dlsite",
        "RJ01111111",
        catalogExternalIdKindValues.storeProduct,
      );
      expect(normal?.demandFacts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            factKind: catalogDemandFactKindValues.dlCount,
            factValue: { count: 18420 },
            sourceProvenanceId: expect.any(String),
            parserVersion: "catalog-recorded-importers.v0.1",
            metadata: expect.objectContaining({ sourceField: "dl_count" }),
          }),
          expect.objectContaining({
            factKind: catalogDemandFactKindValues.ratingSummary,
            factValue: { average: 4.72, count: 512 },
          }),
          expect.objectContaining({
            factKind: catalogDemandFactKindValues.ratingHistogram,
            factValue: expect.objectContaining({ "5": 401, "1": 2 }),
          }),
          expect.objectContaining({
            factKind: catalogDemandFactKindValues.wishlistCount,
            factValue: { count: 9321 },
          }),
          expect.objectContaining({
            factKind: catalogDemandFactKindValues.rank,
            factValue: expect.objectContaining({ scope: "daily", category: "ADV", rank: 8 }),
          }),
          expect.objectContaining({
            factKind: catalogDemandFactKindValues.workType,
            factValue: { workType: "ADV" },
          }),
          expect.objectContaining({
            factKind: catalogDemandFactKindValues.translationTree,
            factValue: expect.objectContaining({
              original_workno: "RJ00001001",
              child_worknos: ["RJ01111111"],
            }),
          }),
        ]),
      );

      const recovered = await services.catalogRepository.getWorkByExternalId(
        actor,
        "dlsite",
        "RJ03333333",
        catalogExternalIdKindValues.storeProduct,
      );
      expect(recovered).toMatchObject({
        canonicalTitle: "Recovered Lantern Labyrinth",
        workKind: "RPG",
        languageStatuses: expect.arrayContaining([
          expect.objectContaining({
            language: "zh-Hans",
            status: catalogLanguageStatusValues.officialFull,
            platform: "dlsite",
          }),
        ]),
        metadata: expect.objectContaining({
          geoRecovery: {
            status: "japan_locked_recovered",
            originalHttpStatusOutsideJapan: 404,
            recoveredFrom: "recorded-jp-cache",
          },
        }),
      });
      expect(
        recovered?.demandFacts.filter((fact) => fact.factKind === catalogDemandFactKindValues.rank),
      ).toHaveLength(2);

      const missing = await services.catalogRepository.getWorkByExternalId(
        actor,
        "dlsite",
        "RJ02222222",
        catalogExternalIdKindValues.storeProduct,
      );
      expect(missing?.metadata).toMatchObject({
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ sourceField: "demand.wishlist_count" }),
          expect.objectContaining({ sourceField: "demand.rank_facts" }),
        ]),
      });
      expect(missing?.demandFacts.map((fact) => fact.factKind)).toEqual(
        expect.not.arrayContaining([
          catalogDemandFactKindValues.wishlistCount,
          catalogDemandFactKindValues.rank,
        ]),
      );
    } finally {
      await context.close();
    }
  });

  it("replays DLsite demand imports idempotently without duplicate demand facts", async () => {
    const context = await isolatedMigratedContext();
    try {
      const services = {
        catalogRepository: new ItotoriCatalogRepository(context.db),
        crawlerRepository: new ItotoriCatalogCrawlerRepository(context.db),
        runner: new ItotoriCatalogCrawlerRunner(),
      };
      const run = (workerId: string) =>
        services.runner.run(createDlsiteRecordedStorefrontAdapter(dlsiteFixture), {
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

      await run("worker-dlsite-demand-initial");
      const initialCount = await demandFactCount(context.pool);
      expect(initialCount).toBe("20");

      await expect(run("worker-dlsite-demand-noop")).resolves.toMatchObject({
        fetchedSteps: 0,
        importedSteps: 0,
        skippedSteps: 0,
      });
      await expect(demandFactCount(context.pool)).resolves.toBe(initialCount);
    } finally {
      await context.close();
    }
  });

  it("reports present malformed demand fields as DLsite parse drift", () => {
    expect(() => createDlsiteRecordedStorefrontAdapter(parseDriftFixture)).toThrow(
      /CATALOG-012 semantic diagnostic parse_drift .*sourceId=RJ09999999 sourceField=dl_count/u,
    );
  });

  it("reports malformed rank facts as DLsite parse drift", () => {
    expect(() =>
      createDlsiteRecordedStorefrontAdapter(
        fixtureWithResponseBySourceId(parseDriftFixture, "RJ09999990"),
      ),
    ).toThrow(
      /CATALOG-012 semantic diagnostic parse_drift .*sourceId=RJ09999990 sourceField=rank_facts\[0\]/u,
    );
    expect(() =>
      createDlsiteRecordedStorefrontAdapter(
        fixtureWithResponseBySourceId(parseDriftFixture, "RJ09999991"),
      ),
    ).toThrow(
      /CATALOG-012 semantic diagnostic parse_drift .*sourceId=RJ09999991 sourceField=rank_facts\[0\]\.category/u,
    );
    expect(() =>
      createDlsiteRecordedStorefrontAdapter(
        fixtureWithResponseBySourceId(parseDriftFixture, "RJ09999992"),
      ),
    ).toThrow(
      /CATALOG-012 semantic diagnostic parse_drift .*sourceId=RJ09999992 sourceField=rank_facts\[0\]\.rank/u,
    );
    expect(() =>
      createDlsiteRecordedStorefrontAdapter(
        fixtureWithResponseBySourceId(parseDriftFixture, "RJ09999993"),
      ),
    ).toThrow(
      /CATALOG-012 semantic diagnostic parse_drift .*sourceId=RJ09999993 sourceField=rank_facts\[0\]\.observed_at/u,
    );
    expect(() =>
      createDlsiteRecordedStorefrontAdapter(
        fixtureWithResponseBySourceId(parseDriftFixture, "RJ09999994"),
      ),
    ).toThrow(
      /CATALOG-012 semantic diagnostic parse_drift .*sourceId=RJ09999994 sourceField=rank_facts\[0\]\.observed_at/u,
    );
    expect(() =>
      createDlsiteRecordedStorefrontAdapter(
        fixtureWithResponseBySourceId(parseDriftFixture, "RJ09999995"),
      ),
    ).toThrow(
      /CATALOG-012 semantic diagnostic parse_drift .*sourceId=RJ09999995 sourceField=rank_facts\[0\]\.observed_at/u,
    );
  });
});

async function demandFactCount(pool: {
  query<T extends object = object>(sql: string): Promise<{ rows: T[] }>;
}): Promise<string> {
  const result = await pool.query<{ count: string }>(
    "select count(*)::text as count from itotori_catalog_demand_facts",
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("demand fact count query returned no rows");
  }
  return row.count;
}

function readStorefrontFixture(name: string): CatalogRecordedStorefrontFixture {
  return JSON.parse(
    readFileSync(
      new URL(`../../../fixtures/catalog-recorded-importers/${name}`, import.meta.url),
      "utf8",
    ),
  ) as CatalogRecordedStorefrontFixture;
}

function fixtureWithResponseBySourceId(
  fixture: CatalogRecordedStorefrontFixture,
  sourceId: string,
): CatalogRecordedStorefrontFixture {
  const response = fixture.responses.find((entry) => entry.sourceId === sourceId);
  if (response === undefined) {
    throw new Error(`missing fixture response ${sourceId}`);
  }
  return { ...fixture, responses: [response] };
}
