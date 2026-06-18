import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import { ItotoriCatalogCrawlerRepository } from "../src/repositories/catalog-crawler-repository.js";
import {
  catalogCrawlerIdempotentFactImportContractId,
  createRecordedCatalogCrawlerAdapter,
  ItotoriCatalogCrawlerRunner,
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
          first_import_transaction_id text not null,
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
        ingestStep: async ({ facts }) => {
          for (const fact of facts) {
            importedFacts.push(fact.sourceId);
            await context.pool.query(
              `insert into catalog_fact_imports (
                source_id,
                fixture_id,
                first_import_transaction_id,
                deterministic_fact_count,
                normalized_title
              ) values ($1, $2, $3, $4, $5)`,
              [
                fact.sourceId,
                fixture.fixtureId,
                "fetch-only-replay-import",
                facts.length,
                fact.normalizedTitle,
              ],
            );
          }
        },
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
          importTransactionId: expect.any(String),
          stepKey: "step-001",
          factCount: 1,
          alreadyImported: false,
        },
        {
          contractId: catalogCrawlerIdempotentFactImportContractId,
          catalogSource: "vndb",
          sourceId: "v2",
          fixtureId: "catalog-crawler-vndb-replay-v0.1",
          importTransactionId: expect.any(String),
          stepKey: "step-002",
          factCount: 1,
          alreadyImported: false,
        },
      ]);
      const factRows = await context.pool.query<{
        source_id: string;
        fixture_id: string;
        deterministic_fact_count: number;
      }>(
        "select source_id, fixture_id, deterministic_fact_count from catalog_fact_imports order by source_id",
      );
      expect(factRows.rows).toEqual([
        {
          source_id: "v1",
          fixture_id: "catalog-crawler-vndb-replay-v0.1",
          deterministic_fact_count: 1,
        },
        {
          source_id: "v2",
          fixture_id: "catalog-crawler-vndb-replay-v0.1",
          deterministic_fact_count: 1,
        },
      ]);
    } finally {
      await context.close();
    }
  });

  it("resumes idempotently when a crash happens after fact ingest but before the imported marker", async () => {
    const context = await isolatedMigratedContext();
    try {
      await context.pool.query(`
        create table catalog_fact_imports (
          source_id text primary key,
          fixture_id text not null,
          first_import_transaction_id text not null,
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

      const interrupted = await repository.startCrawlerJob(actor, "worker-interrupted", {
        catalogSource: fixture.catalogSource,
        adapterName: fixture.adapterName,
        adapterVersion: fixture.adapterVersion,
        sourceVersion: fixture.sourceVersion,
        parserVersion: fixture.parserVersion,
        partitionKey,
      });
      await repository.recordFetchedStep(actor, {
        crawlerJobId: interrupted.crawlerJobId,
        workerId: "worker-interrupted",
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
      await context.pool.query(
        `insert into catalog_fact_imports (
          source_id,
          fixture_id,
          first_import_transaction_id,
          deterministic_fact_count,
          normalized_title
        ) values ($1, $2, $3, $4, $5)`,
        [
          firstStep.sourceId,
          fixture.fixtureId,
          "interrupted-before-step-commit",
          firstStep.facts.length,
          firstStep.facts[0]?.normalizedTitle ?? "unknown",
        ],
      );
      await repository.failCrawlerJob(
        actor,
        interrupted.crawlerJobId,
        "worker-interrupted",
        new Error("crash after ingest before imported marker"),
      );

      const runner = new ItotoriCatalogCrawlerRunner();
      const resumed = await runner.run(createRecordedCatalogCrawlerAdapter(fixture), {
        repository,
        actor,
        workerId: "worker-resumed",
        mode: "recorded_fixture",
        ingestStep: async ({ facts, importTransactionId }) => {
          for (const fact of facts) {
            await context.pool.query(
              `insert into catalog_fact_imports (
                source_id,
                fixture_id,
                first_import_transaction_id,
                deterministic_fact_count,
                normalized_title
              ) values ($1, $2, $3, $4, $5)
              on conflict (source_id) do update set
                deterministic_fact_count = excluded.deterministic_fact_count,
                normalized_title = excluded.normalized_title`,
              [
                fact.sourceId,
                fixture.fixtureId,
                importTransactionId,
                facts.length,
                fact.normalizedTitle,
              ],
            );
          }
        },
      });

      expect(resumed).toMatchObject({
        fetchedSteps: 2,
        importedSteps: 2,
        skippedSteps: 0,
      });
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
          importTransactionId: expect.any(String),
          stepKey: "step-001",
          factCount: 1,
          alreadyImported: false,
        },
        {
          contractId: catalogCrawlerIdempotentFactImportContractId,
          catalogSource: "vndb",
          sourceId: "v2",
          fixtureId: "catalog-crawler-vndb-replay-v0.1",
          importTransactionId: expect.any(String),
          stepKey: "step-002",
          factCount: 1,
          alreadyImported: false,
        },
      ]);
      const factRows = await context.pool.query<{
        source_id: string;
        fixture_id: string;
        first_import_transaction_id: string;
        deterministic_fact_count: number;
      }>(
        "select source_id, fixture_id, first_import_transaction_id, deterministic_fact_count from catalog_fact_imports order by source_id",
      );
      expect(factRows.rows).toEqual([
        {
          source_id: "v1",
          fixture_id: "catalog-crawler-vndb-replay-v0.1",
          first_import_transaction_id: "interrupted-before-step-commit",
          deterministic_fact_count: 1,
        },
        {
          source_id: "v2",
          fixture_id: "catalog-crawler-vndb-replay-v0.1",
          first_import_transaction_id: expect.any(String),
          deterministic_fact_count: 1,
        },
      ]);
    } finally {
      await context.close();
    }
  });
});

function crawlerJobInput() {
  return {
    catalogSource: "vndb" as const,
    adapterName: "vndb-recorded-public-fixture",
    adapterVersion: "adapter-fixture-v1",
    sourceVersion: "vndb-public-snapshot-2026-06-18",
    parserVersion: "parser-contract-v1",
    partitionKey: "public-fixture",
  };
}

function crawlerStepInput(crawlerJobId: string) {
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

function checkpointInput(crawlerJobId: string) {
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
