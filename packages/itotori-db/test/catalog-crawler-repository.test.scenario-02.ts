import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import { ItotoriCatalogCrawlerRepository } from "../src/repositories/catalog-crawler-repository.js";
import {
  catalogCrawlerIdempotentFactImportContractId,
  createRecordedCatalogCrawlerAdapter,
  ItotoriCatalogCrawlerRunner,
  type RecordedCatalogCrawlerFixture,
} from "../src/services/catalog-crawler-runner.js";
import { catalogCrawlerJobSteps, catalogCrawlerStepStatusValues } from "../src/schema.js";
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

// CATALOG-073: two multi-fact steps whose fact sets OVERLAP (pagination re-
// surfaces the same source-fact identity `v201` in step-002). The idempotent
// import must dedupe by fact identity (source_id primary key) so the shared
// fact is not double-persisted and its first-import provenance is preserved.

import {
  createCatalogFactImportsTable,
  upsertFactImports,
  verifyPersistedFactImports,
  importProof,
} from "./catalog-crawler-repository.test.shared-01.js";

describe("ItotoriCatalogCrawlerRepository", () => {
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
});
