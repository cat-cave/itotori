import { readFileSync } from "node:fs";
import {
  catalogCrawlerJobStatusValues,
  catalogCrawlerStepStatusValues,
  createRecordedCatalogCrawlerAdapter,
  InMemoryCatalogCrawlerRepository,
  ItotoriCatalogCrawlerRunner,
  type AuthorizationActor,
  type RecordedCatalogCrawlerFixture,
} from "@itotori/db";
import { describe, expect, it } from "vitest";

const actor: AuthorizationActor = { userId: "fixture-user" };

type FixtureFact = {
  sourceId: string;
  normalizedTitle: string;
};

const fixture = JSON.parse(
  readFileSync(new URL("../../../fixtures/catalog-crawler-vndb/replay.json", import.meta.url), "utf8"),
) as RecordedCatalogCrawlerFixture<FixtureFact>;

describe("Itotori catalog crawler runner", () => {
  it("replays recorded public fixtures, resumes from checkpoints, and skips duplicate imports", async () => {
    const repository = new InMemoryCatalogCrawlerRepository();
    const runner = new ItotoriCatalogCrawlerRunner();
    const adapter = createRecordedCatalogCrawlerAdapter(fixture);
    const importedFacts: FixtureFact[] = [];

    await expect(
      runner.run(adapter, {
        repository,
        actor,
        workerId: "worker-1",
        mode: "recorded_fixture",
        ingestStep: ({ facts }) => {
          if (facts[0]?.sourceId === "v2") {
            throw new Error("simulated importer crash");
          }
          importedFacts.push(...facts);
        },
      }),
    ).rejects.toThrow(/simulated importer crash/u);

    expect(importedFacts.map((fact) => fact.sourceId)).toEqual(["v1"]);
    expect([...repository.jobs.values()].at(-1)?.status).toBe(catalogCrawlerJobStatusValues.failed);
    expect(repository.checkpoints.get("vndb:vndb-recorded-public-fixture:public-fixture")).toMatchObject({
      lastStepKey: "step-001",
      checkpointCursor: { afterStepKey: "step-001", cursor: "page-1" },
    });

    const resumed = await runner.run(adapter, {
      repository,
      actor,
      workerId: "worker-2",
      mode: "recorded_fixture",
      ingestStep: ({ facts }) => {
        importedFacts.push(...facts);
      },
    });

    expect(resumed).toMatchObject({
      fetchedSteps: 1,
      importedSteps: 1,
      skippedSteps: 0,
    });
    expect(importedFacts.map((fact) => fact.sourceId)).toEqual(["v1", "v2"]);
    expect(resumed.checkpoint).toMatchObject({
      lastStepKey: "step-002",
      checkpointCursor: { afterStepKey: "step-002", cursor: "page-2" },
    });

    const noOpReplay = await runner.run(adapter, {
      repository,
      actor,
      workerId: "worker-3",
      mode: "recorded_fixture",
      ingestStep: ({ facts }) => {
        importedFacts.push(...facts);
      },
    });

    expect(noOpReplay).toMatchObject({
      fetchedSteps: 0,
      importedSteps: 0,
      skippedSteps: 0,
    });
    expect(importedFacts.map((fact) => fact.sourceId)).toEqual(["v1", "v2"]);

    const importedStep = [...repository.steps.values()].find(
      (step) => step.stepKey === "step-002" && step.status === catalogCrawlerStepStatusValues.imported,
    );
    expect(importedStep).toMatchObject({
      catalogSource: "vndb",
      adapterName: "vndb-recorded-public-fixture",
      partitionKey: "public-fixture",
      sourceId: "v2",
      requestIdentity: "GET /kana/v2",
      sourceVersion: "vndb-public-snapshot-2026-06-18",
      parserVersion: "parser-contract-v1",
      checkpointCursor: { afterStepKey: "step-002", cursor: "page-2" },
      fetchedAt: new Date("2026-06-18T12:00:05.000Z"),
      status: catalogCrawlerStepStatusValues.imported,
    });
    expect(importedStep?.sourceProvenanceId).toMatch(/^crawler-provenance:/u);
    expect(repository.rateLimits.get("vndb:vndb-recorded-public-fixture:public-fixture")).toMatchObject({
      remaining: 42,
      limit: 60,
      requestIdentity: "GET /kana/v1",
    });
  });

  it("does not duplicate imported facts when a previous job imported before checkpoint save", async () => {
    const repository = new InMemoryCatalogCrawlerRepository();
    const runner = new ItotoriCatalogCrawlerRunner();
    const adapter = createRecordedCatalogCrawlerAdapter(fixture);
    const partitionKey = fixture.partitionKey ?? "default";
    const firstStep = fixture.steps[0];
    if (firstStep === undefined) {
      throw new Error("fixture must contain at least one step");
    }

    const interruptedJob = await repository.startCrawlerJob(actor, "worker-interrupted", {
      catalogSource: fixture.catalogSource,
      adapterName: fixture.adapterName,
      adapterVersion: fixture.adapterVersion,
      sourceVersion: fixture.sourceVersion,
      parserVersion: fixture.parserVersion,
      partitionKey,
    });
    const recorded = await repository.recordFetchedStep(actor, {
      crawlerJobId: interruptedJob.crawlerJobId,
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
    await repository.markStepImported(actor, recorded.step.crawlerJobStepId);
    await repository.failCrawlerJob(
      actor,
      interruptedJob.crawlerJobId,
      "worker-interrupted",
      new Error("interrupted before checkpoint save"),
    );

    const importedFacts: FixtureFact[] = [];
    const resumed = await runner.run(adapter, {
      repository,
      actor,
      workerId: "worker-resumed",
      mode: "recorded_fixture",
      ingestStep: ({ facts }) => {
        importedFacts.push(...facts);
      },
    });

    expect(resumed).toMatchObject({
      fetchedSteps: 2,
      importedSteps: 1,
      skippedSteps: 1,
    });
    expect(importedFacts.map((fact) => fact.sourceId)).toEqual(["v2"]);
    expect(repository.checkpoints.get("vndb:vndb-recorded-public-fixture:public-fixture")).toMatchObject({
      lastStepKey: "step-002",
      checkpointCursor: { afterStepKey: "step-002", cursor: "page-2" },
    });
  });

  it("rejects two active writers for the same source adapter partition", async () => {
    const repository = new InMemoryCatalogCrawlerRepository();
    await repository.startCrawlerJob(actor, "worker-1", {
      catalogSource: "steam",
      adapterName: "steam-fixture",
      adapterVersion: "adapter-fixture-v1",
      sourceVersion: "steam-public-fixture",
      parserVersion: "parser-contract-v1",
      partitionKey: "default",
    });

    await expect(
      repository.startCrawlerJob(actor, "worker-2", {
        catalogSource: "steam",
        adapterName: "steam-fixture",
        adapterVersion: "adapter-fixture-v1",
        sourceVersion: "steam-public-fixture",
        parserVersion: "parser-contract-v1",
        partitionKey: "default",
      }),
    ).rejects.toThrow(/already running/u);
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
