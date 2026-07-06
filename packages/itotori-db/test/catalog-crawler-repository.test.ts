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

  it("resumes idempotently when a crash happens after fact ingest but before the imported marker", async () => {
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
      const runner = new ItotoriCatalogCrawlerRunner();
      await expect(
        runner.run(createRecordedCatalogCrawlerAdapter(fixture), {
          repository,
          actor,
          workerId: "worker-interrupted",
          mode: "recorded_fixture",
          ingestStep: async (ingestContext) => {
            const fact = ingestContext.facts[0];
            if (fact === undefined) {
              throw new Error("fixture step must contain at least one fact");
            }
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
                ingestContext.expectedFactIdentities[0],
                ingestContext.facts.length,
                fact.normalizedTitle,
              ],
            );
            throw new Error("crash after ingest before imported marker");
          },
        }),
      ).rejects.toThrow(/crash after ingest before imported marker/u);

      const interruptedFactRows = await context.pool.query<{
        stable_import_key: string;
        first_import_transaction_id: string;
      }>(
        "select stable_import_key, first_import_transaction_id from catalog_fact_imports where source_id = 'v1'",
      );
      expect(interruptedFactRows.rows).toEqual([
        {
          stable_import_key: expect.stringMatching(/^catalog-import:/u),
          first_import_transaction_id: expect.stringMatching(/^catalog-import:/u),
        },
      ]);

      const resumed = await runner.run(createRecordedCatalogCrawlerAdapter(fixture), {
        repository,
        actor,
        workerId: "worker-resumed",
        mode: "recorded_fixture",
        ingestStep: async (ingestContext) => {
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
          stable_import_key: interruptedFactRows.rows[0]?.stable_import_key,
          first_import_transaction_id: interruptedFactRows.rows[0]?.first_import_transaction_id,
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

  it("replays without duplicate facts when a runner hook forces a crash before commitStepImport (CATALOG-074)", async () => {
    const context = await isolatedMigratedContext();
    try {
      await createCatalogFactImportsTable(context);
      const repository = new ItotoriCatalogCrawlerRepository(context.db);
      const runner = new ItotoriCatalogCrawlerRunner();
      const firstStep = fixture.steps[0];
      if (firstStep === undefined) {
        throw new Error("fixture must contain at least one step");
      }

      // First run: force a crash via the beforeCommitStepImport RUNNER HOOK
      // exactly in the CATALOG-074 window — after the source facts for step-001
      // are ingested and the proof is verified, but before commitStepImport
      // marks the step imported / advances the checkpoint. No manual DB surgery.
      let hookFiredForStepKey: string | undefined;
      await expect(
        runner.run(createRecordedCatalogCrawlerAdapter(fixture), {
          repository,
          actor,
          workerId: "worker-c074-crash",
          mode: "recorded_fixture",
          ingestStep: upsertFactImports(context),
          verifyFactImport: verifyPersistedFactImports(context),
          beforeCommitStepImport: (hookContext) => {
            hookFiredForStepKey = hookContext.step.stepKey;
            expect(hookContext.alreadyImported).toBe(false);
            expect(hookContext.importProof?.stableImportKey).toBe(hookContext.stableImportKey);
            throw new Error("forced crash before commitStepImport");
          },
        }),
      ).rejects.toThrow(/forced crash before commitStepImport/u);
      expect(hookFiredForStepKey).toBe(firstStep.stepKey);

      // The crash landed in the window: facts for v1 are persisted, but the step
      // never reached the imported marker and the checkpoint never advanced.
      const afterCrash = await context.pool.query<{
        source_id: string;
        first_import_transaction_id: string;
      }>(
        "select source_id, first_import_transaction_id from catalog_fact_imports order by source_id",
      );
      expect(afterCrash.rows).toEqual([
        {
          source_id: "v1",
          first_import_transaction_id: expect.stringMatching(/^catalog-import:/u),
        },
      ]);
      const crashedStepRows = await context.db
        .select({ status: catalogCrawlerJobSteps.status })
        .from(catalogCrawlerJobSteps)
        .where(eq(catalogCrawlerJobSteps.stepKey, firstStep.stepKey));
      expect(crashedStepRows[0]?.status).toBe(catalogCrawlerStepStatusValues.fetched);
      await expect(
        repository.getCheckpoint(actor, {
          catalogSource: "vndb",
          adapterName: "vndb-recorded-public-fixture",
          partitionKey: "public-fixture",
        }),
      ).resolves.toBeNull();
      const firstImportTransactionId = afterCrash.rows[0]?.first_import_transaction_id;

      // Replay: re-run WITHOUT the crash hook. recordFetchedStep sees step-001
      // still `fetched` (the imported marker never committed), so the idempotent
      // upsert re-ingests v1 by primary key without creating a duplicate row and
      // preserving its original first_import_transaction_id.
      const resumed = await runner.run(createRecordedCatalogCrawlerAdapter(fixture), {
        repository,
        actor,
        workerId: "worker-c074-resumed",
        mode: "recorded_fixture",
        ingestStep: upsertFactImports(context),
        verifyFactImport: verifyPersistedFactImports(context),
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

      // No duplicate facts: exactly one row per source_id, and v1 keeps the
      // transaction id from the pre-crash ingest (the replay updated, not doubled).
      const factCount = await context.pool.query<{ count: string }>(
        "select count(*)::text as count from catalog_fact_imports",
      );
      expect(factCount.rows[0]?.count).toBe("2");
      const factRows = await context.pool.query<{
        source_id: string;
        first_import_transaction_id: string;
        fact_identity: string;
        deterministic_fact_count: number;
      }>(
        "select source_id, first_import_transaction_id, fact_identity, deterministic_fact_count from catalog_fact_imports order by source_id",
      );
      expect(factRows.rows).toEqual([
        {
          source_id: "v1",
          first_import_transaction_id: firstImportTransactionId,
          fact_identity: "catalogSource=vndb|sourceId=v1",
          deterministic_fact_count: 1,
        },
        {
          source_id: "v2",
          first_import_transaction_id: resumed.replayValidation[1]?.stableImportKey,
          fact_identity: "catalogSource=vndb|sourceId=v2",
          deterministic_fact_count: 1,
        },
      ]);
    } finally {
      await context.close();
    }
  });

  it("fails a contract-enforced step before commit when the importer proof is missing", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repository = new ItotoriCatalogCrawlerRepository(context.db);
      const runner = new ItotoriCatalogCrawlerRunner();

      await expect(
        runner.run(createRecordedCatalogCrawlerAdapter(fixture), {
          repository,
          actor,
          workerId: "worker-missing-importer",
          mode: "recorded_fixture",
        }),
      ).rejects.toThrow(/ingestStep must write facts or a durable import marker/u);

      await expect(
        repository.getCheckpoint(actor, {
          catalogSource: "vndb",
          adapterName: "vndb-recorded-public-fixture",
          partitionKey: "public-fixture",
        }),
      ).resolves.toBeNull();

      const stepRows = await context.db
        .select({ status: catalogCrawlerJobSteps.status })
        .from(catalogCrawlerJobSteps);
      expect(stepRows).toEqual([{ status: catalogCrawlerStepStatusValues.failed }]);
    } finally {
      await context.close();
    }
  });

  it("fails a contract-enforced step before commit when proof has no persisted fact rows", async () => {
    const context = await isolatedMigratedContext();
    try {
      await createCatalogFactImportsTable(context);
      const repository = new ItotoriCatalogCrawlerRepository(context.db);
      const runner = new ItotoriCatalogCrawlerRunner();

      await expect(
        runner.run(createRecordedCatalogCrawlerAdapter(fixture), {
          repository,
          actor,
          workerId: "worker-self-attested-proof",
          mode: "recorded_fixture",
          ingestStep: (ingestContext) => importProof(ingestContext),
          verifyFactImport: verifyPersistedFactImports(context),
        }),
      ).rejects.toThrow(/persisted import evidence/u);

      await expect(
        repository.getCheckpoint(actor, {
          catalogSource: "vndb",
          adapterName: "vndb-recorded-public-fixture",
          partitionKey: "public-fixture",
        }),
      ).resolves.toBeNull();
    } finally {
      await context.close();
    }
  });

  it("fails an already-imported contract step when persisted evidence is absent", async () => {
    const context = await isolatedMigratedContext();
    try {
      await createCatalogFactImportsTable(context);
      const repository = new ItotoriCatalogCrawlerRepository(context.db);
      const runner = new ItotoriCatalogCrawlerRunner();
      const partitionKey = fixture.partitionKey ?? "default";
      const firstStep = fixture.steps[0];
      if (firstStep === undefined) {
        throw new Error("fixture must contain at least one step");
      }

      const interrupted = await repository.startCrawlerJob(actor, "worker-generic-imported", {
        catalogSource: fixture.catalogSource,
        adapterName: fixture.adapterName,
        adapterVersion: fixture.adapterVersion,
        sourceVersion: fixture.sourceVersion,
        parserVersion: fixture.parserVersion,
        partitionKey,
      });
      const recorded = await repository.recordFetchedStep(actor, {
        crawlerJobId: interrupted.crawlerJobId,
        workerId: "worker-generic-imported",
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
      await repository.markStepImported(
        actor,
        recorded.step.crawlerJobStepId,
        "worker-generic-imported",
      );
      await repository.failCrawlerJob(
        actor,
        interrupted.crawlerJobId,
        "worker-generic-imported",
        new Error("generic imported marker without persisted evidence"),
      );

      await expect(
        runner.run(createRecordedCatalogCrawlerAdapter(fixture), {
          repository,
          actor,
          workerId: "worker-resumed-no-evidence",
          mode: "recorded_fixture",
          ingestStep: async (ingestContext) => {
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
        }),
      ).rejects.toThrow(/persisted import evidence/u);

      await expect(
        repository.getCheckpoint(actor, {
          catalogSource: "vndb",
          adapterName: "vndb-recorded-public-fixture",
          partitionKey: "public-fixture",
        }),
      ).resolves.toBeNull();
    } finally {
      await context.close();
    }
  });

  it("fails durable marker importers before commit when the marker is absent or wrong", async () => {
    const context = await isolatedMigratedContext();
    try {
      await createCatalogDurableMarkersTable(context);
      const repository = new ItotoriCatalogCrawlerRepository(context.db);
      const runner = new ItotoriCatalogCrawlerRunner();
      const adapter = durableMarkerAdapter();

      await expect(
        runner.run(adapter, {
          repository,
          actor,
          workerId: "worker-durable-absent",
          mode: "recorded_fixture",
          ingestStep: (ingestContext) => importProof(ingestContext),
          verifyFactImport: verifyPersistedDurableMarkers(context),
        }),
      ).rejects.toThrow(/persisted import evidence/u);

      await expect(
        repository.getCheckpoint(actor, {
          catalogSource: "vndb",
          adapterName: "vndb-durable-marker-fixture",
          partitionKey: "public-fixture",
        }),
      ).resolves.toBeNull();

      await expect(
        runner.run(adapter, {
          repository,
          actor,
          workerId: "worker-durable-wrong",
          mode: "recorded_fixture",
          ingestStep: async (ingestContext) => {
            await persistDurableMarker(
              context,
              ingestContext,
              `${ingestContext.stableImportKey}:wrong`,
            );
            return importProof(ingestContext);
          },
          verifyFactImport: verifyPersistedDurableMarkers(context),
        }),
      ).rejects.toThrow(/durable marker evidence/u);

      await expect(
        repository.getCheckpoint(actor, {
          catalogSource: "vndb",
          adapterName: "vndb-durable-marker-fixture",
          partitionKey: "public-fixture",
        }),
      ).resolves.toBeNull();
    } finally {
      await context.close();
    }
  });

  it("commits durable marker importers only after the stable marker is persisted", async () => {
    const context = await isolatedMigratedContext();
    try {
      await createCatalogDurableMarkersTable(context);
      const repository = new ItotoriCatalogCrawlerRepository(context.db);
      const runner = new ItotoriCatalogCrawlerRunner();
      const adapter = durableMarkerAdapter();

      const result = await runner.run(adapter, {
        repository,
        actor,
        workerId: "worker-durable-persisted",
        mode: "recorded_fixture",
        ingestStep: async (ingestContext) => {
          await persistDurableMarker(context, ingestContext, ingestContext.stableImportKey);
          return importProof(ingestContext);
        },
        verifyFactImport: verifyPersistedDurableMarkers(context),
      });

      expect(result).toMatchObject({
        fetchedSteps: 2,
        importedSteps: 2,
        skippedSteps: 0,
      });
      expect(result.replayValidation.map((record) => record.stableImportKey)).toEqual([
        expect.stringMatching(/^catalog-import:/u),
        expect.stringMatching(/^catalog-import:/u),
      ]);
      await expect(
        repository.getCheckpoint(actor, {
          catalogSource: "vndb",
          adapterName: "vndb-durable-marker-fixture",
          partitionKey: "public-fixture",
        }),
      ).resolves.toMatchObject({ lastStepKey: "step-002" });
    } finally {
      await context.close();
    }
  });

  it("persists every expected fact identity from a multi-fact step exactly once, even across a crash replay (CATALOG-073)", async () => {
    const context = await isolatedMigratedContext();
    try {
      await createCatalogFactImportsTable(context);
      const repository = new ItotoriCatalogCrawlerRepository(context.db);
      const runner = new ItotoriCatalogCrawlerRunner();
      const step = multiFactFixture.steps[0];
      if (step === undefined || step.facts.length < 2) {
        throw new Error("multi-fact fixture must contain a step with multiple facts");
      }
      const expectedIdentities = step.facts.map(
        (fact) => `catalogSource=vndb|sourceId=${fact.sourceId}`,
      );

      // First run: ingest all three facts, then crash in the CATALOG-074 window
      // (facts written + proof verified, but BEFORE commitStepImport marks the
      // step imported / advances the checkpoint). Models a process crash exactly
      // after a multi-fact step's facts land but before the step is committed.
      await expect(
        runner.run(createRecordedCatalogCrawlerAdapter(multiFactFixture), {
          repository,
          actor,
          workerId: "worker-multi-fact-crash",
          mode: "recorded_fixture",
          ingestStep: upsertFactImports(context, multiFactFixture.fixtureId),
          verifyFactImport: verifyPersistedFactImports(context),
          beforeCommitStepImport: () => {
            throw new Error("forced crash before commitStepImport");
          },
        }),
      ).rejects.toThrow(/forced crash before commitStepImport/u);

      // All three facts landed (one row per identity), but the step never reached
      // the imported marker and the checkpoint never advanced.
      const afterCrash = await context.pool.query<{
        source_id: string;
        first_import_transaction_id: string;
        deterministic_fact_count: number;
      }>(
        "select source_id, first_import_transaction_id, deterministic_fact_count from catalog_fact_imports order by source_id",
      );
      expect(afterCrash.rows.map((row) => row.source_id)).toEqual(
        step.facts.map((fact) => fact.sourceId),
      );
      expect(
        afterCrash.rows.every((row) => row.deterministic_fact_count === step.facts.length),
      ).toBe(true);
      const firstImportTransactionIds = new Map(
        afterCrash.rows.map((row) => [row.source_id, row.first_import_transaction_id]),
      );
      await expect(
        repository.getCheckpoint(actor, {
          catalogSource: "vndb",
          adapterName: "vndb-recorded-multi-fact-fixture",
          partitionKey: "public-fixture",
        }),
      ).resolves.toBeNull();

      // Replay WITHOUT the crash hook: the still-`fetched` step re-ingests the
      // same three facts idempotently (upsert by primary key) — each identity is
      // updated in place, never doubled.
      const resumed = await runner.run(createRecordedCatalogCrawlerAdapter(multiFactFixture), {
        repository,
        actor,
        workerId: "worker-multi-fact-resumed",
        mode: "recorded_fixture",
        ingestStep: upsertFactImports(context, multiFactFixture.fixtureId),
        verifyFactImport: verifyPersistedFactImports(context),
      });

      expect(resumed).toMatchObject({ fetchedSteps: 1, importedSteps: 1, skippedSteps: 0 });
      // Deterministic fact count: the single step reports exactly three facts and
      // all three per-fact identities, in fixture order.
      expect(resumed.replayValidation).toHaveLength(1);
      expect(resumed.replayValidation[0]).toMatchObject({
        stepKey: "step-001",
        factCount: step.facts.length,
        factIdentities: expectedIdentities,
        alreadyImported: false,
      });
      expect(resumed.checkpoint).toMatchObject({ lastStepKey: "step-001" });

      // Exactly one persisted row per expected fact identity — never doubled by
      // the replay.
      const factCount = await context.pool.query<{ count: string }>(
        "select count(*)::text as count from catalog_fact_imports",
      );
      expect(factCount.rows[0]?.count).toBe(String(step.facts.length));
      const factRows = await context.pool.query<{
        source_id: string;
        fact_identity: string;
        deterministic_fact_count: number;
        first_import_transaction_id: string;
      }>(
        "select source_id, fact_identity, deterministic_fact_count, first_import_transaction_id from catalog_fact_imports order by source_id",
      );
      expect(factRows.rows).toEqual(
        step.facts.map((fact) => ({
          source_id: fact.sourceId,
          fact_identity: `catalogSource=vndb|sourceId=${fact.sourceId}`,
          deterministic_fact_count: step.facts.length,
          // Provenance preserved: the resumed upsert kept each row's original
          // pre-crash import transaction id (replay updated, never re-inserted).
          first_import_transaction_id: firstImportTransactionIds.get(fact.sourceId),
        })),
      );
    } finally {
      await context.close();
    }
  });

  it("dedupes duplicate source-fact identities across steps without double-persisting (CATALOG-073)", async () => {
    const context = await isolatedMigratedContext();
    try {
      await createCatalogFactImportsTable(context);
      const repository = new ItotoriCatalogCrawlerRepository(context.db);
      const runner = new ItotoriCatalogCrawlerRunner();

      const result = await runner.run(createRecordedCatalogCrawlerAdapter(duplicateFactsFixture), {
        repository,
        actor,
        workerId: "worker-duplicate-facts",
        mode: "recorded_fixture",
        ingestStep: upsertFactImportsRebindingStep(context, duplicateFactsFixture.fixtureId),
        verifyFactImport: verifyPersistedFactImports(context),
      });

      expect(result).toMatchObject({ fetchedSteps: 2, importedSteps: 2, skippedSteps: 0 });
      const step1Key = result.replayValidation[0]?.stableImportKey;
      expect(result.replayValidation.map((record) => record.factIdentities)).toEqual([
        ["catalogSource=vndb|sourceId=v200", "catalogSource=vndb|sourceId=v201"],
        ["catalogSource=vndb|sourceId=v201", "catalogSource=vndb|sourceId=v202"],
      ]);

      // The shared identity v201 is re-surfaced by step-002 but the source_id
      // primary key dedupes it: THREE distinct rows persist, not four.
      const factCount = await context.pool.query<{ count: string }>(
        "select count(*)::text as count from catalog_fact_imports",
      );
      expect(factCount.rows[0]?.count).toBe("3");

      const factRows = await context.pool.query<{
        source_id: string;
        fact_identity: string;
        first_import_transaction_id: string;
      }>(
        "select source_id, fact_identity, first_import_transaction_id from catalog_fact_imports order by source_id",
      );
      expect(factRows.rows.map((row) => row.source_id)).toEqual(["v200", "v201", "v202"]);
      expect(factRows.rows.map((row) => row.fact_identity)).toEqual([
        "catalogSource=vndb|sourceId=v200",
        "catalogSource=vndb|sourceId=v201",
        "catalogSource=vndb|sourceId=v202",
      ]);
      // v201's first-import provenance is preserved: it belongs to step-001, the
      // step that first imported it, even though step-002 re-encountered it.
      const v201 = factRows.rows.find((row) => row.source_id === "v201");
      expect(v201?.first_import_transaction_id).toBe(step1Key);
    } finally {
      await context.close();
    }
  });

  it("keeps per-fact identities stable across re-imports and catches per-fact identity drift (CATALOG-073)", async () => {
    // A re-import of the SAME fixture must derive byte-identical per-fact
    // identities (the identity model is a stable pure function of the fields),
    // and a proof whose per-fact identity has DRIFTED from that model must be
    // rejected before the step is committed.
    const expectedIdentities = [
      "catalogSource=vndb|sourceId=v100",
      "catalogSource=vndb|sourceId=v101",
      "catalogSource=vndb|sourceId=v102",
    ];

    const identitiesFor = async (workerId: string): Promise<readonly string[]> => {
      const context = await isolatedMigratedContext();
      try {
        await createCatalogFactImportsTable(context);
        const runner = new ItotoriCatalogCrawlerRunner();
        const result = await runner.run(createRecordedCatalogCrawlerAdapter(multiFactFixture), {
          repository: new ItotoriCatalogCrawlerRepository(context.db),
          actor,
          workerId,
          mode: "recorded_fixture",
          ingestStep: upsertFactImports(context, multiFactFixture.fixtureId),
          verifyFactImport: verifyPersistedFactImports(context),
        });
        return result.replayValidation[0]?.factIdentities ?? [];
      } finally {
        await context.close();
      }
    };

    // Stability: two independent imports of the same fixture derive identical
    // per-fact identities.
    const first = await identitiesFor("worker-identity-import-a");
    const second = await identitiesFor("worker-identity-import-b");
    expect(first).toEqual(expectedIdentities);
    expect(second).toEqual(first);

    // Drift is caught: an importer whose returned proof drifts ONE fact identity
    // away from the stable model is rejected before commit, the step is failed,
    // and the checkpoint never advances.
    const context = await isolatedMigratedContext();
    try {
      await createCatalogFactImportsTable(context);
      const repository = new ItotoriCatalogCrawlerRepository(context.db);
      const runner = new ItotoriCatalogCrawlerRunner();

      await expect(
        runner.run(createRecordedCatalogCrawlerAdapter(multiFactFixture), {
          repository,
          actor,
          workerId: "worker-identity-drift",
          mode: "recorded_fixture",
          ingestStep: async (ingestContext) => {
            await upsertFactImports(context, multiFactFixture.fixtureId)(ingestContext);
            const drifted = [...ingestContext.expectedFactIdentities];
            drifted[1] = `${drifted[1]}-drifted`;
            return {
              stableImportKey: ingestContext.stableImportKey,
              strategy: catalogCrawlerFactImportStrategyValues.upsert,
              factCount: ingestContext.facts.length,
              factIdentities: drifted,
            };
          },
          verifyFactImport: verifyPersistedFactImports(context),
        }),
      ).rejects.toThrow(/fact import proof factIdentities mismatch/u);

      const stepRows = await context.db
        .select({ status: catalogCrawlerJobSteps.status })
        .from(catalogCrawlerJobSteps);
      expect(stepRows).toEqual([{ status: catalogCrawlerStepStatusValues.failed }]);
      await expect(
        repository.getCheckpoint(actor, {
          catalogSource: "vndb",
          adapterName: "vndb-recorded-multi-fact-fixture",
          partitionKey: "public-fixture",
        }),
      ).resolves.toBeNull();
    } finally {
      await context.close();
    }
  });
});

async function createCatalogFactImportsTable(
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

async function createCatalogDurableMarkersTable(
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

function durableMarkerAdapter(): CatalogCrawlerSourceAdapter<FixtureFact> {
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

function upsertFactImports(
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

// CATALOG-073: a dedupe-on-conflict importer for cross-step duplicate fact
// identities. The `source_id` primary key means a fact re-surfaced by a later
// step conflicts, so we REBIND the row to the current step's stable import key
// (letting that step's verifier find its facts) while deliberately NOT touching
// `first_import_transaction_id` — the first importer's provenance is preserved
// and the shared fact is never double-persisted.
function upsertFactImportsRebindingStep(
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

function verifyPersistedFactImports(
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

function verifyPersistedDurableMarkers(
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

function persistedEvidence(
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

async function persistDurableMarker(
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

function importProof(context: CatalogCrawlerIngestContext<FixtureFact>) {
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
