import { readFileSync } from "node:fs";

import { type RecordedCatalogCrawlerFixture } from "../src/services/catalog-crawler-runner.js";
import {
  type CatalogRecordedImporterFact,
  type CatalogRecordedPlatformFixture,
  type CatalogRecordedStorefrontFixture,
} from "../src/services/catalog-recorded-importers.js";

export { record } from "./catalog-recorded-importers.test.support.js";

// Each DLsite parse-drift / unsupported-shape case: a synthetic mutation of the
// recorded fixture that drives one diagnostic, plus the COMPLETE diagnostic
// metadata (fixtureId/sourceRevision/stepKey/sourceId/sourceField) it must emit.

// Each Steam parse-drift / unsupported-shape case, with the complete diagnostic
// metadata the appdetails envelope parser must emit.

export async function catalogCounts(pool: {
  query<T extends object = object>(sql: string): Promise<{ rows: T[] }>;
}) {
  const result = await pool.query<{
    works: string;
    external_ids: string;
    releases: string;
    language_statuses: string;
    demand_facts: string;
    seed_targets: string;
  }>(`
    select
      (select count(*) from itotori_catalog_works)::text as works,
      (select count(*) from itotori_catalog_external_ids)::text as external_ids,
      (select count(*) from itotori_catalog_releases)::text as releases,
      (select count(*) from itotori_catalog_language_statuses)::text as language_statuses,
      (select count(*) from itotori_catalog_demand_facts)::text as demand_facts,
      (select count(*) from itotori_catalog_seed_targets)::text as seed_targets
  `);
  return result.rows[0];
}

export async function rateLimitByAdapter(
  pool: {
    query<T extends object = object>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
  },
  adapterName: string,
) {
  const result = await pool.query<{
    catalog_source: string;
    remaining: number | null;
    limit: number | null;
    request_identity: string | null;
    metadata: Record<string, unknown>;
  }>(
    `
      select catalog_source, remaining, "limit", request_identity, metadata
      from itotori_catalog_crawler_rate_limits
      where adapter_name = $1
      limit 1
    `,
    [adapterName],
  );
  return required(result.rows[0], `rate limit for ${adapterName}`);
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

export function withUpdatedFact(
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
