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
});
