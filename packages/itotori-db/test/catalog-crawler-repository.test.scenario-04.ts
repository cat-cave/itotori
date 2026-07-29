import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import { ItotoriCatalogCrawlerRepository } from "../src/repositories/catalog-crawler-repository.js";
import {
  catalogCrawlerFactImportStrategyValues,
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
  upsertFactImports,
  verifyPersistedFactImports,
} from "./catalog-crawler-repository.test.shared-01.js";

describe("ItotoriCatalogCrawlerRepository", () => {
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
