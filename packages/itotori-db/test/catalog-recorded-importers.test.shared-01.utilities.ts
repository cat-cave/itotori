import { readFileSync } from "node:fs";
import { eq, inArray } from "drizzle-orm";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import { ItotoriCatalogCrawlerRepository } from "../src/repositories/catalog-crawler-repository.js";
import { ItotoriCatalogRepository } from "../src/repositories/catalog-repository.js";
import {
  createRecordedCatalogCrawlerAdapter,
  ItotoriCatalogCrawlerRunner,
  type CatalogCrawlerAdapterStep,
  type CatalogCrawlerSourceAdapter,
  type RecordedCatalogCrawlerFixture,
} from "../src/services/catalog-crawler-runner.js";
import {
  createCatalogRecordedImporterIngestStep,
  createCatalogRecordedImporterVerifier,
  type CatalogRecordedImporterFact,
  type CatalogRecordedPlatformFixture,
  type CatalogRecordedStorefrontFixture,
} from "../src/services/catalog-recorded-importers.js";
import { catalogSourceProvenance } from "../src/schema.js";

const actor: AuthorizationActor = { userId: localUserId };

export function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a record`);
  }
  return value as Record<string, unknown>;
}

export type Services = ReturnType<typeof servicesFor>;

export function servicesFor(db: Parameters<typeof ItotoriCatalogRepository>[0]): {
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

export async function runFixture(
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

export async function runStorefrontFixture(
  services: Services,
  adapter: CatalogCrawlerSourceAdapter<CatalogRecordedImporterFact>,
  workerId: string,
) {
  return services.runner.run(adapter, {
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

export async function storefrontSteps(
  adapter: CatalogCrawlerSourceAdapter<CatalogRecordedImporterFact>,
): Promise<CatalogCrawlerAdapterStep<CatalogRecordedImporterFact>[]> {
  const steps: CatalogCrawlerAdapterStep<CatalogRecordedImporterFact>[] = [];
  for await (const step of adapter.steps({ checkpointCursor: null, mode: "recorded_fixture" })) {
    steps.push(step);
  }
  return steps;
}

export async function sourceProvenanceById(
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

export async function provenanceBySourceId(
  db: Parameters<typeof ItotoriCatalogRepository>[0],
  sourceId: string,
) {
  const rows = await db
    .select()
    .from(catalogSourceProvenance)
    .where(eq(catalogSourceProvenance.sourceId, sourceId))
    .limit(1);
  return required(rows[0], `source provenance for sourceId ${sourceId}`);
}

export async function provenanceCatalogSourcesByIds(
  db: Parameters<typeof ItotoriCatalogRepository>[0],
  ids: readonly string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({
      sourceProvenanceId: catalogSourceProvenance.sourceProvenanceId,
      catalogSource: catalogSourceProvenance.catalogSource,
    })
    .from(catalogSourceProvenance)
    .where(inArray(catalogSourceProvenance.sourceProvenanceId, [...new Set(ids)]));
  return new Map(rows.map((row) => [row.sourceProvenanceId, row.catalogSource]));
}

export function liveLikeCrawlAdapter(
  sourceId: string,
  catalogSource: "igdb" | "dlsite" | "steam" = "igdb",
): CatalogCrawlerSourceAdapter<CatalogRecordedImporterFact> {
  return {
    catalogSource,
    adapterName: `live-demo-${catalogSource}-${sourceId}`,
    adapterVersion: "v0.1",
    sourceVersion: `live-demo-source-${catalogSource}-2026-07-07`,
    parserVersion: `live-demo-parser-${catalogSource}-2026-07-07`,
    *steps() {
      yield {
        stepKey: `step-${catalogSource}-${sourceId}`,
        sourceId,
        requestIdentity: `https://${catalogSource}.example/${sourceId}`,
        fetchedAt: "2026-07-07T00:00:00.000Z",
        checkpointCursor: null,
        payload: { id: sourceId, name: `Live demo ${sourceId}` },
        facts: [],
      };
    },
  };
}

export function requiredArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

export function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`${label} is required`);
  }
  return value;
}

export function readFixture(
  name: string,
): RecordedCatalogCrawlerFixture<CatalogRecordedImporterFact> {
  return JSON.parse(
    readFixtureText(name),
  ) as RecordedCatalogCrawlerFixture<CatalogRecordedImporterFact>;
}

export function readFixtureText(name: string): string {
  return readFileSync(
    new URL(`../../../fixtures/catalog-recorded-importers/${name}`, import.meta.url),
    "utf8",
  );
}

export function readStorefrontFixture(name: string): CatalogRecordedStorefrontFixture {
  return JSON.parse(
    readFileSync(
      new URL(`../../../fixtures/catalog-recorded-importers/${name}`, import.meta.url),
      "utf8",
    ),
  ) as CatalogRecordedStorefrontFixture;
}

export function readPlatformFixture(name: string): CatalogRecordedPlatformFixture {
  return JSON.parse(
    readFileSync(
      new URL(`../../../fixtures/catalog-recorded-importers/${name}`, import.meta.url),
      "utf8",
    ),
  ) as CatalogRecordedPlatformFixture;
}
