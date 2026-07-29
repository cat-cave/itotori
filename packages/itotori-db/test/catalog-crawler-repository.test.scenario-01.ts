import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import { ItotoriCatalogCrawlerRepository } from "../src/repositories/catalog-crawler-repository.js";
import {
  catalogCrawlerIdempotentFactImportContractId,
  catalogCrawlerFactImportStrategyValues,
  createRecordedCatalogCrawlerAdapter,
  ItotoriCatalogCrawlerRunner,
  type CatalogCrawlerFactImportEvidence,
  type CatalogCrawlerIngestContext,
  type CatalogCrawlerSourceAdapter,
  type CatalogCrawlerVerifyFactImportStep,
  type RecordedCatalogCrawlerFixture,
} from "../src/services/catalog-crawler-runner.js";
import {
  catalogCrawlerJobs,
  catalogCrawlerJobSteps,
  catalogCrawlerStepStatusValues,
} from "../src/schema.js";
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

import {
  createCatalogFactImportsTable,
  createCatalogDurableMarkersTable,
  durableMarkerAdapter,
  upsertFactImports,
  upsertFactImportsRebindingStep,
  verifyPersistedFactImports,
  verifyPersistedDurableMarkers,
  persistedEvidence,
  persistDurableMarker,
  importProof,
  crawlerJobInput,
  crawlerStepInput,
  checkpointInput,
} from "./catalog-crawler-repository.test.shared-01.js";

describe("ItotoriCatalogCrawlerRepository", () => {
  it("rejects stale worker checkpoint, rate-limit, imported-marker, failure, and completion writes", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repository = new ItotoriCatalogCrawlerRepository(context.db);
      const job = await repository.startCrawlerJob(actor, "worker-stale", crawlerJobInput());
      const step = await repository.recordFetchedStep(actor, {
        ...crawlerStepInput(job.crawlerJobId),
        workerId: "worker-stale",
      });

      await context.db
        .update(catalogCrawlerJobs)
        .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
        .where(eq(catalogCrawlerJobs.crawlerJobId, job.crawlerJobId));

      await expect(
        repository.saveCheckpoint(actor, {
          ...checkpointInput(job.crawlerJobId),
          workerId: "worker-stale",
        }),
      ).rejects.toThrow(/active lease/u);
      await expect(
        repository.saveRateLimit(actor, {
          catalogSource: "vndb",
          adapterName: "vndb-recorded-public-fixture",
          partitionKey: "public-fixture",
          crawlerJobId: job.crawlerJobId,
          workerId: "worker-stale",
          remaining: 10,
        }),
      ).rejects.toThrow(/active lease/u);
      await expect(
        repository.markStepImported(actor, step.step.crawlerJobStepId, "worker-stale"),
      ).rejects.toThrow(/expected row/u);
      await expect(
        repository.failCrawlerJob(
          actor,
          job.crawlerJobId,
          "worker-stale",
          new Error("late failure"),
        ),
      ).rejects.toThrow(/expected row/u);
      await expect(
        repository.completeCrawlerJob(actor, job.crawlerJobId, "worker-stale", {
          afterStepKey: "step-001",
        }),
      ).rejects.toThrow(/expected row/u);
      await expect(
        repository.saveCheckpoint(
          actor,
          checkpointInput(job.crawlerJobId) as unknown as Parameters<
            typeof repository.saveCheckpoint
          >[1],
        ),
      ).rejects.toThrow(/workerId is required/u);
      await expect(
        repository.saveRateLimit(actor, {
          catalogSource: "vndb",
          adapterName: "vndb-recorded-public-fixture",
          partitionKey: "public-fixture",
          crawlerJobId: job.crawlerJobId,
          remaining: 9,
        } as unknown as Parameters<typeof repository.saveRateLimit>[1]),
      ).rejects.toThrow(/workerId is required/u);
      await expect(
        repository.markStepImported(
          actor,
          step.step.crawlerJobStepId,
          undefined as unknown as string,
        ),
      ).rejects.toThrow(/workerId is required/u);
      await expect(
        repository.markStepFailed(
          actor,
          step.step.crawlerJobStepId,
          new Error("late failure"),
          undefined as unknown as string,
        ),
      ).rejects.toThrow(/workerId is required/u);

      await expect(
        repository.getCheckpoint(actor, {
          catalogSource: "vndb",
          adapterName: "vndb-recorded-public-fixture",
          partitionKey: "public-fixture",
        }),
      ).resolves.toBeNull();
      const stepRows = await context.db
        .select({ status: catalogCrawlerJobSteps.status })
        .from(catalogCrawlerJobSteps)
        .where(eq(catalogCrawlerJobSteps.crawlerJobStepId, step.step.crawlerJobStepId));
      expect(stepRows[0]?.status).toBe(catalogCrawlerStepStatusValues.fetched);
    } finally {
      await context.close();
    }
  });

  it("does not advance the checkpoint when rate-limit persistence fails in the step commit", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repository = new ItotoriCatalogCrawlerRepository(context.db);
      const job = await repository.startCrawlerJob(actor, "worker-atomic", crawlerJobInput());
      const step = await repository.recordFetchedStep(actor, {
        ...crawlerStepInput(job.crawlerJobId),
        workerId: "worker-atomic",
      });

      await expect(
        repository.commitStepImport(actor, {
          crawlerJobId: job.crawlerJobId,
          workerId: "worker-atomic",
          crawlerJobStepId: step.step.crawlerJobStepId,
          checkpoint: checkpointInput(job.crawlerJobId),
          rateLimit: {
            catalogSource: "vndb",
            adapterName: "vndb-recorded-public-fixture",
            partitionKey: "public-fixture",
            remaining: -1,
          },
        }),
      ).rejects.toThrow(/remaining must be a nonnegative integer/u);

      await expect(
        repository.getCheckpoint(actor, {
          catalogSource: "vndb",
          adapterName: "vndb-recorded-public-fixture",
          partitionKey: "public-fixture",
        }),
      ).resolves.toBeNull();

      const rows = await context.db
        .select({ status: catalogCrawlerJobSteps.status })
        .from(catalogCrawlerJobSteps)
        .where(eq(catalogCrawlerJobSteps.crawlerJobStepId, step.step.crawlerJobStepId));
      expect(rows[0]?.status).toBe(catalogCrawlerStepStatusValues.fetched);
    } finally {
      await context.close();
    }
  });

  it("replays a fetched-only row when a crash happens before fact ingest", async () => {
    const context = await isolatedMigratedContext();
    try {
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
      const repository = new ItotoriCatalogCrawlerRepository(context.db);
      const partitionKey = fixture.partitionKey ?? "default";
      const firstStep = fixture.steps[0];
      if (firstStep === undefined) {
        throw new Error("fixture must contain at least one step");
      }

      const interrupted = await repository.startCrawlerJob(actor, "worker-fetch-only", {
        catalogSource: fixture.catalogSource,
        adapterName: fixture.adapterName,
        adapterVersion: fixture.adapterVersion,
        sourceVersion: fixture.sourceVersion,
        parserVersion: fixture.parserVersion,
        partitionKey,
      });
      await repository.recordFetchedStep(actor, {
        crawlerJobId: interrupted.crawlerJobId,
        workerId: "worker-fetch-only",
        stepKey: firstStep.stepKey,
        catalogSource: fixture.catalogSource,
        adapterName: fixture.adapterName,
        adapterVersion: fixture.adapterVersion,
        partitionKey,
        sourceId: firstStep.sourceId,
        requestIdentity: firstStep.requestIdentity,
        sourceVersion: fixture.sourceVersion,
        parserVersion: fixture.parserVersion,
        checkpointCursor: firstStep.checkpointCursor,
        fetchedAt: firstStep.fetchedAt,
        payload: firstStep.payload,
      });
      await repository.failCrawlerJob(
        actor,
        interrupted.crawlerJobId,
        "worker-fetch-only",
        new Error("crash after fetch before ingest"),
      );

      const runner = new ItotoriCatalogCrawlerRunner();
      const importedFacts: string[] = [];
      const resumed = await runner.run(createRecordedCatalogCrawlerAdapter(fixture), {
        repository,
        actor,
        workerId: "worker-resumed",
        mode: "recorded_fixture",
        ingestStep: async (ingestContext) => {
          for (const [index, fact] of ingestContext.facts.entries()) {
            importedFacts.push(fact.sourceId);
            await context.pool.query(
              `insert into catalog_fact_imports (
                source_id,
                fixture_id,
                stable_import_key,
                first_import_transaction_id,
                fact_identity,
                deterministic_fact_count,
                normalized_title
              ) values ($1, $2, $3, $4, $5, $6, $7)`,
              [
                fact.sourceId,
                fixture.fixtureId,
                ingestContext.stableImportKey,
                ingestContext.importTransactionId,
                ingestContext.expectedFactIdentities[index],
                ingestContext.facts.length,
                fact.normalizedTitle,
              ],
            );
          }
          return importProof(ingestContext);
        },
        verifyFactImport: verifyPersistedFactImports(context),
      });

      expect(resumed).toMatchObject({
        fetchedSteps: 2,
        importedSteps: 2,
        skippedSteps: 0,
      });
      expect(importedFacts).toEqual(["v1", "v2"]);
      expect(resumed.checkpoint).toMatchObject({
        lastStepKey: "step-002",
        checkpointCursor: { afterStepKey: "step-002", cursor: "page-2" },
      });
      expect(resumed.replayValidation).toEqual([
        {
          contractId: catalogCrawlerIdempotentFactImportContractId,
          catalogSource: "vndb",
          sourceId: "v1",
          fixtureId: "catalog-crawler-vndb-replay-v0.1",
          stableImportKey: expect.stringMatching(/^catalog-import:/u),
          importTransactionId: expect.stringMatching(/^catalog-import:/u),
          stepKey: "step-001",
          factCount: 1,
          factIdentities: ["catalogSource=vndb|sourceId=v1"],
          alreadyImported: false,
        },
        {
          contractId: catalogCrawlerIdempotentFactImportContractId,
          catalogSource: "vndb",
          sourceId: "v2",
          fixtureId: "catalog-crawler-vndb-replay-v0.1",
          stableImportKey: expect.stringMatching(/^catalog-import:/u),
          importTransactionId: expect.stringMatching(/^catalog-import:/u),
          stepKey: "step-002",
          factCount: 1,
          factIdentities: ["catalogSource=vndb|sourceId=v2"],
          alreadyImported: false,
        },
      ]);
      const factRows = await context.pool.query<{
        source_id: string;
        fixture_id: string;
        stable_import_key: string;
        first_import_transaction_id: string;
        fact_identity: string;
        deterministic_fact_count: number;
      }>(
        "select source_id, fixture_id, stable_import_key, first_import_transaction_id, fact_identity, deterministic_fact_count from catalog_fact_imports order by source_id",
      );
      expect(factRows.rows).toEqual([
        {
          source_id: "v1",
          fixture_id: "catalog-crawler-vndb-replay-v0.1",
          stable_import_key: resumed.replayValidation[0]?.stableImportKey,
          first_import_transaction_id: resumed.replayValidation[0]?.stableImportKey,
          fact_identity: "catalogSource=vndb|sourceId=v1",
          deterministic_fact_count: 1,
        },
        {
          source_id: "v2",
          fixture_id: "catalog-crawler-vndb-replay-v0.1",
          stable_import_key: resumed.replayValidation[1]?.stableImportKey,
          first_import_transaction_id: resumed.replayValidation[1]?.stableImportKey,
          fact_identity: "catalogSource=vndb|sourceId=v2",
          deterministic_fact_count: 1,
        },
      ]);
    } finally {
      await context.close();
    }
  });
});
