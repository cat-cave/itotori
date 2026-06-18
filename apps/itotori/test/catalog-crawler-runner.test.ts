import { readFileSync } from "node:fs";
import {
  catalogCrawlerJobStatusValues,
  catalogCrawlerStepStatusValues,
  catalogCrawlerIdempotentFactImportContractId,
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
  readFileSync(
    new URL("../../../fixtures/catalog-crawler-vndb/replay.json", import.meta.url),
    "utf8",
  ),
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
    expect(
      repository.checkpoints.get("vndb:vndb-recorded-public-fixture:public-fixture"),
    ).toMatchObject({
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
      replayValidation: [
        {
          contractId: catalogCrawlerIdempotentFactImportContractId,
          catalogSource: "vndb",
          sourceId: "v2",
          fixtureId: "catalog-crawler-vndb-replay-v0.1",
          stepKey: "step-002",
          factCount: 1,
          alreadyImported: false,
        },
      ],
    });
    expect(resumed.replayValidation[0]?.importTransactionId).toMatch(/^crawler-step:/u);
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
      replayValidation: [],
    });
    expect(importedFacts.map((fact) => fact.sourceId)).toEqual(["v1", "v2"]);

    const importedStep = [...repository.steps.values()].find(
      (step) =>
        step.stepKey === "step-002" && step.status === catalogCrawlerStepStatusValues.imported,
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
    expect(
      repository.rateLimits.get("vndb:vndb-recorded-public-fixture:public-fixture"),
    ).toMatchObject({
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
    await repository.markStepImported(actor, recorded.step.crawlerJobStepId, "worker-interrupted");
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
      replayValidation: [
        {
          contractId: catalogCrawlerIdempotentFactImportContractId,
          catalogSource: "vndb",
          sourceId: "v1",
          fixtureId: "catalog-crawler-vndb-replay-v0.1",
          stepKey: "step-001",
          factCount: 1,
          alreadyImported: true,
        },
        {
          contractId: catalogCrawlerIdempotentFactImportContractId,
          catalogSource: "vndb",
          sourceId: "v2",
          fixtureId: "catalog-crawler-vndb-replay-v0.1",
          stepKey: "step-002",
          factCount: 1,
          alreadyImported: false,
        },
      ],
    });
    expect(resumed.replayValidation.map((record) => record.importTransactionId)).toEqual([
      expect.stringMatching(/^crawler-step:/u),
      expect.stringMatching(/^crawler-step:/u),
    ]);
    expect(importedFacts.map((fact) => fact.sourceId)).toEqual(["v2"]);
    expect(
      repository.checkpoints.get("vndb:vndb-recorded-public-fixture:public-fixture"),
    ).toMatchObject({
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

  it("requires alpha-ready adapters to cite an idempotent fact import strategy", async () => {
    const repository = new InMemoryCatalogCrawlerRepository();
    const runner = new ItotoriCatalogCrawlerRunner();

    await expect(
      runner.run(
        {
          catalogSource: "steam",
          adapterName: "steam-alpha-without-contract",
          adapterVersion: "adapter-fixture-v1",
          sourceVersion: "steam-public-fixture",
          parserVersion: "parser-contract-v1",
          readiness: "alpha_ready",
          *steps() {
            yield {
              stepKey: "step-001",
              sourceId: "steam-1",
              requestIdentity: "GET /api/appdetails?appids=1",
              fetchedAt: "2026-06-18T12:00:00.000Z",
              checkpointCursor: { afterStepKey: "step-001" },
              payload: { steam_appid: 1 },
              facts: [],
            };
          },
        },
        {
          repository,
          actor,
          workerId: "worker-alpha-contract",
          mode: "recorded_fixture",
        },
      ),
    ).rejects.toThrow(/CATALOG-065 idempotent fact import contract/u);
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
