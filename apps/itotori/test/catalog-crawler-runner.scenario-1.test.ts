import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  catalogCrawlerJobStatusValues,
  catalogCrawlerStepStatusValues,
  catalogCrawlerIdempotentFactImportContractId,
  catalogCrawlerFactImportStrategyValues,
  createRecordedCatalogCrawlerAdapter,
  InMemoryCatalogCrawlerRepository,
  ItotoriCatalogCrawlerRunner,
  type AuthorizationActor,
  type CatalogCrawlerFactImportEvidence,
  type CatalogCrawlerIngestContext,
  type CatalogCrawlerSourceAdapter,
  type CatalogCrawlerVerifyFactImportStep,
  type RecordedCatalogCrawlerFixture,
} from "@itotori/db";
import { describe, expect, it } from "vitest";

import {
  actor,
  FixtureFact,
  fixture,
  PersistedImport,
  durableMarkerAdapter,
  persistFacts,
  persistDurableMarker,
  verifyPersistedImport,
  importProof,
  stableImportKeyForStep,
  sha256,
  stableJsonStringify,
} from "./catalog-crawler-runner.support.js";

describe("Itotori catalog crawler runner", () => {
  it("uses a stable persisted import key for durable marker importers across crash replay jobs", async () => {
    const repository = new InMemoryCatalogCrawlerRepository();
    const runner = new ItotoriCatalogCrawlerRunner();
    const adapter = durableMarkerAdapter();
    const observedKeys: string[] = [];
    const persistedImports = new Map<string, PersistedImport>();

    await expect(
      runner.run(adapter, {
        repository,
        actor,
        workerId: "worker-durable-crash",
        mode: "recorded_fixture",
        ingestStep: (context) => {
          observedKeys.push(context.stableImportKey);
          persistDurableMarker(context, persistedImports);
          throw new Error("crash after durable marker");
        },
        verifyFactImport: verifyPersistedImport(persistedImports),
      }),
    ).rejects.toThrow(/crash after durable marker/u);

    await runner.run(adapter, {
      repository,
      actor,
      workerId: "worker-durable-replay",
      mode: "recorded_fixture",
      ingestStep: (context) => {
        observedKeys.push(context.stableImportKey);
        persistDurableMarker(context, persistedImports);
        return importProof(context);
      },
      verifyFactImport: verifyPersistedImport(persistedImports),
    });

    expect(observedKeys[0]).toBe(observedKeys[1]);
    expect(observedKeys[0]).toMatch(/^catalog-import:/u);
  });

  it("refuses recorded fixtures in live mode so public CI never needs network credentials", async () => {
    const repository = new InMemoryCatalogCrawlerRepository();
    const runner = new ItotoriCatalogCrawlerRunner();

    await expect(
      runner.run(createRecordedCatalogCrawlerAdapter(fixture), {
        repository,
        actor,
        workerId: "worker-live",
      }),
    ).rejects.toThrow(/recorded_fixture mode/u);
  });
});
