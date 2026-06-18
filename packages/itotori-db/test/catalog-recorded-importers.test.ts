import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import { ItotoriCatalogCrawlerRepository } from "../src/repositories/catalog-crawler-repository.js";
import { ItotoriCatalogRepository } from "../src/repositories/catalog-repository.js";
import {
  createRecordedCatalogCrawlerAdapter,
  ItotoriCatalogCrawlerRunner,
  type RecordedCatalogCrawlerFixture,
} from "../src/services/catalog-crawler-runner.js";
import {
  createCatalogRecordedImporterIngestStep,
  createCatalogRecordedImporterVerifier,
  type CatalogRecordedImporterFact,
} from "../src/services/catalog-recorded-importers.js";
import {
  catalogExternalIdKindValues,
  catalogLanguageStatusValues,
  catalogSeedOriginValues,
  catalogSourceProvenance,
  catalogSourceRecordKindValues,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const actor: AuthorizationActor = { userId: localUserId };

const vndbFixture = readFixture("vndb-dump-replay.json");
const egsFixture = readFixture("egs-recorded-replay.json");

describe("catalog recorded source importers", () => {
  it("imports VNDB dump facts with releases, language facts, source ids, and source-version provenance", async () => {
    const context = await isolatedMigratedContext();
    try {
      const services = servicesFor(context.db);
      const result = await runFixture(services, vndbFixture, "worker-vndb");

      expect(result).toMatchObject({
        fetchedSteps: 2,
        importedSteps: 2,
        skippedSteps: 0,
        replayValidation: [
          {
            sourceId: "v1001",
            fixtureId: "catalog-recorded-importer-vndb-dump-v0.1",
            factCount: 1,
            factIdentities: ["catalogSource=vndb|sourceId=v1001"],
            alreadyImported: false,
          },
          {
            sourceId: "v1002",
            fixtureId: "catalog-recorded-importer-vndb-dump-v0.1",
            factCount: 1,
            factIdentities: ["catalogSource=vndb|sourceId=v1002"],
            alreadyImported: false,
          },
        ],
      });

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
          }),
          expect.objectContaining({
            sourceReleaseId: "r5002",
            releaseTitle: "Promise Under Starlight",
            releaseKind: "official_translation",
            language: "en-US",
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
      expect(provenance).toMatchObject({
        catalogSource: "vndb",
        sourceRecordKind: catalogSourceRecordKindValues.rawCache,
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

  it("imports EGS recorded responses with product ids, store metadata, locale facts, and request provenance", async () => {
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
        "prod-starlight-001",
        catalogExternalIdKindValues.storeProduct,
      );
      expect(starlight).toMatchObject({
        canonicalTitle: "Promise Under Starlight",
        originalLanguage: "ja-JP",
        firstReleaseYear: 2021,
      });
      expect(starlight?.metadata).toMatchObject({
        sourceId: "prod-starlight-001",
        sourceVersion: "egs-recorded-synthetic-2026-06-18",
        requestIdentity: "GET /storefront/products/prod-starlight-001?locale=en-US",
        store: {
          namespace: "fixture-starlight",
          catalogItemId: "9c3f4ad2fixture",
          slug: "promise-under-starlight",
          developer: "Fixture Circle",
          publisher: "Fixture Works",
        },
      });
      expect(starlight?.externalIds).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            catalogSource: "egs",
            sourceId: "prod-starlight-001",
            externalIdKind: catalogExternalIdKindValues.sourceRecord,
          }),
          expect.objectContaining({
            catalogSource: "egs",
            sourceId: "prod-starlight-001",
            externalIdKind: catalogExternalIdKindValues.storeProduct,
            metadata: expect.objectContaining({
              namespace: "fixture-starlight",
              catalogItemId: "9c3f4ad2fixture",
              slug: "promise-under-starlight",
            }),
          }),
        ]),
      );
      expect(starlight?.languageStatuses).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            language: "en-US",
            status: catalogLanguageStatusValues.officialFull,
            platform: "egs",
          }),
          expect.objectContaining({
            language: "ja-JP",
            status: catalogLanguageStatusValues.officialFull,
            platform: "egs",
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
        sourceId: "prod-starlight-001",
        sourceVersion: "egs-recorded-synthetic-2026-06-18",
        requestId: "GET /storefront/products/prod-starlight-001?locale=en-US",
        fetchedAt: new Date("2026-06-18T13:05:00.000Z"),
      });
    } finally {
      await context.close();
    }
  });

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
      const updatedEgs = withUpdatedFact(egsFixture, "prod-starlight-001", {
        sourceVersion: "egs-recorded-synthetic-2026-06-18-revision-2",
        canonicalTitle: "Promise Under Starlight Complete",
        releaseTitle: "Promise Under Starlight Complete",
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
        services.catalogRepository.getWorkByExternalId(
          actor,
          "egs",
          "prod-starlight-001",
          catalogExternalIdKindValues.storeProduct,
        ),
      ).resolves.toMatchObject({
        canonicalTitle: "Promise Under Starlight Complete",
        releases: expect.arrayContaining([
          expect.objectContaining({ releaseTitle: "Promise Under Starlight Complete" }),
        ]),
        metadata: expect.objectContaining({
          sourceVersion: "egs-recorded-synthetic-2026-06-18-revision-2",
        }),
      });
    } finally {
      await context.close();
    }
  });
});

type Services = ReturnType<typeof servicesFor>;

function servicesFor(db: Parameters<typeof ItotoriCatalogRepository>[0]): {
  catalogRepository: ItotoriCatalogRepository;
  crawlerRepository: ItotoriCatalogCrawlerRepository;
  runner: ItotoriCatalogCrawlerRunner;
} {
  return {
    catalogRepository: new ItotoriCatalogRepository(db),
    crawlerRepository: new ItotoriCatalogCrawlerRepository(db),
    runner: new ItotoriCatalogCrawlerRunner(),
  };
}

async function runFixture(
  services: Services,
  fixture: RecordedCatalogCrawlerFixture<CatalogRecordedImporterFact>,
  workerId: string,
) {
  return services.runner.run(createRecordedCatalogCrawlerAdapter(fixture), {
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
}

async function sourceProvenanceById(
  db: Parameters<typeof ItotoriCatalogRepository>[0],
  id: string,
) {
  const rows = await db
    .select()
    .from(catalogSourceProvenance)
    .where(eq(catalogSourceProvenance.sourceProvenanceId, id))
    .limit(1);
  return required(rows[0], `source provenance ${id}`);
}

async function catalogCounts(pool: {
  query<T extends object = object>(sql: string): Promise<{ rows: T[] }>;
}) {
  const result = await pool.query<{
    works: string;
    external_ids: string;
    releases: string;
    language_statuses: string;
    seed_targets: string;
  }>(`
    select
      (select count(*) from itotori_catalog_works)::text as works,
      (select count(*) from itotori_catalog_external_ids)::text as external_ids,
      (select count(*) from itotori_catalog_releases)::text as releases,
      (select count(*) from itotori_catalog_language_statuses)::text as language_statuses,
      (select count(*) from itotori_catalog_seed_targets)::text as seed_targets
  `);
  return result.rows[0];
}

function readFixture(name: string): RecordedCatalogCrawlerFixture<CatalogRecordedImporterFact> {
  return JSON.parse(
    readFileSync(
      new URL(`../../../fixtures/catalog-recorded-importers/${name}`, import.meta.url),
      "utf8",
    ),
  ) as RecordedCatalogCrawlerFixture<CatalogRecordedImporterFact>;
}

function withUpdatedFact(
  fixture: RecordedCatalogCrawlerFixture<CatalogRecordedImporterFact>,
  sourceId: string,
  update: { sourceVersion: string; canonicalTitle: string; releaseTitle: string },
): RecordedCatalogCrawlerFixture<CatalogRecordedImporterFact> {
  const copy = structuredClone(fixture);
  copy.sourceVersion = update.sourceVersion;
  for (const step of copy.steps) {
    if (step.sourceId !== sourceId) {
      continue;
    }
    step.payload = { ...step.payload, updateRevision: update.sourceVersion };
    const fact = step.facts[0];
    if (fact === undefined) {
      throw new Error(`fixture step ${step.stepKey} has no fact`);
    }
    fact.canonicalTitle = update.canonicalTitle;
    const release = fact.releases?.at(-1);
    if (release === undefined) {
      throw new Error(`fixture step ${step.stepKey} has no release`);
    }
    release.releaseTitle = update.releaseTitle;
  }
  return copy;
}

function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`${label} is required`);
  }
  return value;
}
