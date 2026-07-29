import { readFileSync } from "node:fs";

import { localUserId, type AuthorizationActor } from "../src/authorization.js";

import {
  catalogCrawlerIdempotentFactImportContractId,
  catalogCrawlerFactImportStrategyValues,
  createRecordedCatalogCrawlerAdapter,
  type CatalogCrawlerFactImportEvidence,
  type CatalogCrawlerIngestContext,
  type CatalogCrawlerSourceAdapter,
  type CatalogCrawlerVerifyFactImportStep,
  type RecordedCatalogCrawlerFixture,
} from "../src/services/catalog-crawler-runner.js";

import { isolatedMigratedContext } from "./db-test-context.js";

const actor: AuthorizationActor = { userId: localUserId };

type FixtureFact = {
  sourceId: string;
  normalizedTitle: string;
};

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/catalog-crawler-vndb/replay.json", import.meta.url),
    "utf8",
  ),
) as RecordedCatalogCrawlerFixture<FixtureFact>;

// CATALOG-073: a single crawler step carrying MULTIPLE facts (three distinct
// source-fact identities). The base `replay.json` only ever has one fact per
// step, so deterministic multi-fact counts, per-fact identities, and exactly-
// once persistence are otherwise untested.
const multiFactFixture = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/catalog-crawler-vndb/replay-multi-fact.json", import.meta.url),
    "utf8",
  ),
) as RecordedCatalogCrawlerFixture<FixtureFact>;

// CATALOG-073: two multi-fact steps whose fact sets OVERLAP (pagination re-
// surfaces the same source-fact identity `v201` in step-002). The idempotent
// import must dedupe by fact identity (source_id primary key) so the shared
// fact is not double-persisted and its first-import provenance is preserved.
const duplicateFactsFixture = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/catalog-crawler-vndb/replay-duplicate-facts.json", import.meta.url),
    "utf8",
  ),
) as RecordedCatalogCrawlerFixture<FixtureFact>;

export async function createCatalogFactImportsTable(
  context: Awaited<ReturnType<typeof isolatedMigratedContext>>,
) {
  await context.pool.query(`
    create table catalog_fact_imports (
      source_id text primary key,
      fixture_id text not null,
      stable_import_key text not null,
      first_import_transaction_id text not null,
      fact_identity text not null,
      deterministic_fact_count integer not null,
      normalized_title text not null
    )
  `);
}

export async function createCatalogDurableMarkersTable(
  context: Awaited<ReturnType<typeof isolatedMigratedContext>>,
) {
  await context.pool.query(`
    create table catalog_durable_import_markers (
      stable_import_key text primary key,
      durable_marker_id text not null,
      deterministic_fact_count integer not null
    )
  `);
  await context.pool.query(`
    create table catalog_durable_import_marker_facts (
      stable_import_key text not null,
      fact_identity text not null,
      primary key (stable_import_key, fact_identity)
    )
  `);
}

export function durableMarkerAdapter(): CatalogCrawlerSourceAdapter<FixtureFact> {
  return {
    ...createRecordedCatalogCrawlerAdapter(fixture),
    adapterName: "vndb-durable-marker-fixture",
    factImportContract: {
      contractId: catalogCrawlerIdempotentFactImportContractId,
      strategy: catalogCrawlerFactImportStrategyValues.durableImportMarker,
      factIdentity: ["catalogSource", "sourceId"],
      replayValidation: [
        "sourceId",
        "fixtureId",
        "stableImportKey",
        "importTransactionId",
        "factCount",
        "factIdentities",
      ],
    },
  };
}

export function upsertFactImports(
  context: Awaited<ReturnType<typeof isolatedMigratedContext>>,
  fixtureId: string = fixture.fixtureId,
): (
  ingestContext: CatalogCrawlerIngestContext<FixtureFact>,
) => Promise<ReturnType<typeof importProof>> {
  return async (ingestContext) => {
    for (const [index, fact] of ingestContext.facts.entries()) {
      await context.pool.query(
        `insert into catalog_fact_imports (
          source_id,
          fixture_id,
          stable_import_key,
          first_import_transaction_id,
          fact_identity,
          deterministic_fact_count,
          normalized_title
        ) values ($1, $2, $3, $4, $5, $6, $7)
        on conflict (source_id) do update set
          deterministic_fact_count = excluded.deterministic_fact_count,
          fact_identity = excluded.fact_identity,
          normalized_title = excluded.normalized_title`,
        [
          fact.sourceId,
          fixtureId,
          ingestContext.stableImportKey,
          ingestContext.importTransactionId,
          ingestContext.expectedFactIdentities[index],
          ingestContext.facts.length,
          fact.normalizedTitle,
        ],
      );
    }
    return importProof(ingestContext);
  };
}

export function upsertFactImportsRebindingStep(
  context: Awaited<ReturnType<typeof isolatedMigratedContext>>,
  fixtureId: string,
): (
  ingestContext: CatalogCrawlerIngestContext<FixtureFact>,
) => Promise<ReturnType<typeof importProof>> {
  return async (ingestContext) => {
    for (const [index, fact] of ingestContext.facts.entries()) {
      await context.pool.query(
        `insert into catalog_fact_imports (
          source_id,
          fixture_id,
          stable_import_key,
          first_import_transaction_id,
          fact_identity,
          deterministic_fact_count,
          normalized_title
        ) values ($1, $2, $3, $4, $5, $6, $7)
        on conflict (source_id) do update set
          stable_import_key = excluded.stable_import_key,
          deterministic_fact_count = excluded.deterministic_fact_count,
          fact_identity = excluded.fact_identity,
          normalized_title = excluded.normalized_title`,
        [
          fact.sourceId,
          fixtureId,
          ingestContext.stableImportKey,
          ingestContext.importTransactionId,
          ingestContext.expectedFactIdentities[index],
          ingestContext.facts.length,
          fact.normalizedTitle,
        ],
      );
    }
    return importProof(ingestContext);
  };
}

export function verifyPersistedFactImports(
  context: Awaited<ReturnType<typeof isolatedMigratedContext>>,
): CatalogCrawlerVerifyFactImportStep<FixtureFact> {
  return async ({ proof }) => {
    const rows = await context.pool.query<{
      fact_identity: string;
      deterministic_fact_count: number;
    }>(
      "select fact_identity, deterministic_fact_count from catalog_fact_imports where stable_import_key = $1 order by fact_identity",
      [proof.stableImportKey],
    );
    if (rows.rowCount === 0) {
      return null;
    }
    return persistedEvidence(
      proof,
      rows.rows.map((row) => row.fact_identity),
    );
  };
}

export function verifyPersistedDurableMarkers(
  context: Awaited<ReturnType<typeof isolatedMigratedContext>>,
): CatalogCrawlerVerifyFactImportStep<FixtureFact> {
  return async ({ proof }) => {
    const marker = await context.pool.query<{
      durable_marker_id: string;
      deterministic_fact_count: number;
    }>(
      "select durable_marker_id, deterministic_fact_count from catalog_durable_import_markers where stable_import_key = $1",
      [proof.stableImportKey],
    );
    if (marker.rowCount === 0) {
      return null;
    }
    const facts = await context.pool.query<{ fact_identity: string }>(
      "select fact_identity from catalog_durable_import_marker_facts where stable_import_key = $1 order by fact_identity",
      [proof.stableImportKey],
    );
    return persistedEvidence(
      proof,
      facts.rows.map((row) => row.fact_identity),
      marker.rows[0]?.durable_marker_id,
    );
  };
}

export function persistedEvidence(
  proof: ReturnType<typeof importProof>,
  factIdentities: readonly string[],
  durableMarkerId?: string,
): CatalogCrawlerFactImportEvidence {
  return {
    stableImportKey: proof.stableImportKey,
    strategy: proof.strategy,
    factCount: factIdentities.length,
    factIdentities,
    durableMarkerId,
    persisted: true,
  };
}

export async function persistDurableMarker(
  context: Awaited<ReturnType<typeof isolatedMigratedContext>>,
  ingestContext: CatalogCrawlerIngestContext<FixtureFact>,
  durableMarkerId: string,
) {
  await context.pool.query(
    `insert into catalog_durable_import_markers (
      stable_import_key,
      durable_marker_id,
      deterministic_fact_count
    ) values ($1, $2, $3)`,
    [ingestContext.stableImportKey, durableMarkerId, ingestContext.facts.length],
  );
  for (const factIdentity of ingestContext.expectedFactIdentities) {
    await context.pool.query(
      `insert into catalog_durable_import_marker_facts (
        stable_import_key,
        fact_identity
      ) values ($1, $2)`,
      [ingestContext.stableImportKey, factIdentity],
    );
  }
}

export function importProof(context: CatalogCrawlerIngestContext<FixtureFact>) {
  return {
    stableImportKey: context.stableImportKey,
    strategy:
      context.adapter.factImportContract?.strategy ?? catalogCrawlerFactImportStrategyValues.upsert,
    factCount: context.facts.length,
    factIdentities: context.expectedFactIdentities,
    durableMarkerId:
      context.adapter.factImportContract?.strategy ===
      catalogCrawlerFactImportStrategyValues.durableImportMarker
        ? context.stableImportKey
        : undefined,
  };
}

export function crawlerJobInput() {
  return {
    catalogSource: "vndb" as const,
    adapterName: "vndb-recorded-public-fixture",
    adapterVersion: "adapter-fixture-v1",
    sourceVersion: "vndb-public-snapshot-2026-06-18",
    parserVersion: "parser-contract-v1",
    partitionKey: "public-fixture",
  };
}

export function crawlerStepInput(crawlerJobId: string) {
  return {
    crawlerJobId,
    stepKey: "step-001",
    catalogSource: "vndb" as const,
    adapterName: "vndb-recorded-public-fixture",
    adapterVersion: "adapter-fixture-v1",
    partitionKey: "public-fixture",
    sourceId: "v1",
    requestIdentity: "GET /kana/v1",
    sourceVersion: "vndb-public-snapshot-2026-06-18",
    parserVersion: "parser-contract-v1",
    checkpointCursor: { afterStepKey: "step-001", cursor: "page-1" },
    fetchedAt: "2026-06-18T12:00:00.000Z",
    payload: { id: "v1", title: "Kana Little Sister" },
  };
}

export function checkpointInput(crawlerJobId: string) {
  return {
    catalogSource: "vndb" as const,
    adapterName: "vndb-recorded-public-fixture",
    partitionKey: "public-fixture",
    checkpointCursor: { afterStepKey: "step-001", cursor: "page-1" },
    sourceVersion: "vndb-public-snapshot-2026-06-18",
    parserVersion: "parser-contract-v1",
    lastCrawlerJobId: crawlerJobId,
    lastStepKey: "step-001",
  };
}
