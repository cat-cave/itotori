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
    const persistedImports = new Map<string, PersistedImport>();

    await expect(
      runner.run(adapter, {
        repository,
        actor,
        workerId: "worker-1",
        mode: "recorded_fixture",
        ingestStep: (context) => {
          const { facts } = context;
          if (facts[0]?.sourceId === "v2") {
            throw new Error("simulated importer crash");
          }
          importedFacts.push(...facts);
          return persistFacts(context, persistedImports);
        },
        verifyFactImport: verifyPersistedImport(persistedImports),
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
      ingestStep: (context) => {
        const { facts } = context;
        importedFacts.push(...facts);
        return persistFacts(context, persistedImports);
      },
      verifyFactImport: verifyPersistedImport(persistedImports),
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
          stableImportKey: expect.stringMatching(/^catalog-import:/u),
          importTransactionId: expect.stringMatching(/^catalog-import:/u),
          stepKey: "step-002",
          factCount: 1,
          factIdentities: ["catalogSource=vndb|sourceId=v2"],
          alreadyImported: false,
        },
      ],
    });
    expect(resumed.replayValidation[0]?.importTransactionId).toBe(
      resumed.replayValidation[0]?.stableImportKey,
    );
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
      ingestStep: (context) => {
        const { facts } = context;
        importedFacts.push(...facts);
        return persistFacts(context, persistedImports);
      },
      verifyFactImport: verifyPersistedImport(persistedImports),
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
    const persistedImports = new Map<string, PersistedImport>();
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
    persistedImports.set(stableImportKeyForStep(adapter, firstStep), {
      strategy: catalogCrawlerFactImportStrategyValues.upsert,
      factIdentities: ["catalogSource=vndb|sourceId=v1"],
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
      ingestStep: (context) => {
        const { facts } = context;
        importedFacts.push(...facts);
        return persistFacts(context, persistedImports);
      },
      verifyFactImport: verifyPersistedImport(persistedImports),
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
          stableImportKey: expect.stringMatching(/^catalog-import:/u),
          importTransactionId: expect.stringMatching(/^catalog-import:/u),
          stepKey: "step-001",
          factCount: 1,
          factIdentities: ["catalogSource=vndb|sourceId=v1"],
          alreadyImported: true,
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
      ],
    });
    expect(resumed.replayValidation.map((record) => record.importTransactionId)).toEqual(
      resumed.replayValidation.map((record) => record.stableImportKey),
    );
    expect(importedFacts.map((fact) => fact.sourceId)).toEqual(["v2"]);
    expect(
      repository.checkpoints.get("vndb:vndb-recorded-public-fixture:public-fixture"),
    ).toMatchObject({
      lastStepKey: "step-002",
      checkpointCursor: { afterStepKey: "step-002", cursor: "page-2" },
    });
  });

  it("fails already-imported contract steps when persisted evidence is absent", async () => {
    const repository = new InMemoryCatalogCrawlerRepository();
    const runner = new ItotoriCatalogCrawlerRunner();
    const adapter = createRecordedCatalogCrawlerAdapter(fixture);
    const persistedImports = new Map<string, PersistedImport>();
    const partitionKey = fixture.partitionKey ?? "default";
    const firstStep = fixture.steps[0];
    if (firstStep === undefined) {
      throw new Error("fixture must contain at least one step");
    }

    const interruptedJob = await repository.startCrawlerJob(actor, "worker-generic-imported", {
      catalogSource: fixture.catalogSource,
      adapterName: fixture.adapterName,
      adapterVersion: fixture.adapterVersion,
      sourceVersion: fixture.sourceVersion,
      parserVersion: fixture.parserVersion,
      partitionKey,
    });
    const recorded = await repository.recordFetchedStep(actor, {
      crawlerJobId: interruptedJob.crawlerJobId,
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
      interruptedJob.crawlerJobId,
      "worker-generic-imported",
      new Error("generic imported marker without persisted evidence"),
    );

    await expect(
      runner.run(adapter, {
        repository,
        actor,
        workerId: "worker-resumed-no-evidence",
        mode: "recorded_fixture",
        ingestStep: (context) => persistFacts(context, persistedImports),
        verifyFactImport: verifyPersistedImport(persistedImports),
      }),
    ).rejects.toThrow(/persisted import evidence/u);

    expect(
      repository.checkpoints.get("vndb:vndb-recorded-public-fixture:public-fixture"),
    ).toBeUndefined();
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

  it("fails contract-enforced steps before commit when no importer proof is returned", async () => {
    const repository = new InMemoryCatalogCrawlerRepository();
    const runner = new ItotoriCatalogCrawlerRunner();
    const adapter = createRecordedCatalogCrawlerAdapter(fixture);

    await expect(
      runner.run(adapter, {
        repository,
        actor,
        workerId: "worker-missing-proof",
        mode: "recorded_fixture",
        ingestStep: () => undefined,
      }),
    ).rejects.toThrow(/fact import proof/u);

    const step = [...repository.steps.values()].find((row) => row.stepKey === "step-001");
    expect(step).toMatchObject({
      status: catalogCrawlerStepStatusValues.failed,
    });
    expect(
      repository.checkpoints.get("vndb:vndb-recorded-public-fixture:public-fixture"),
    ).toBeUndefined();
  });

  it("fails contract-enforced steps before commit when proof has no persisted evidence", async () => {
    const repository = new InMemoryCatalogCrawlerRepository();
    const runner = new ItotoriCatalogCrawlerRunner();
    const adapter = createRecordedCatalogCrawlerAdapter(fixture);
    const persistedImports = new Map<string, PersistedImport>();

    await expect(
      runner.run(adapter, {
        repository,
        actor,
        workerId: "worker-self-attested-proof",
        mode: "recorded_fixture",
        ingestStep: (context) => importProof(context),
        verifyFactImport: verifyPersistedImport(persistedImports),
      }),
    ).rejects.toThrow(/persisted import evidence/u);

    expect(
      repository.checkpoints.get("vndb:vndb-recorded-public-fixture:public-fixture"),
    ).toBeUndefined();
  });

  it("fails durable marker importers before commit when the persisted marker is absent", async () => {
    const repository = new InMemoryCatalogCrawlerRepository();
    const runner = new ItotoriCatalogCrawlerRunner();
    const adapter = durableMarkerAdapter();
    const persistedImports = new Map<string, PersistedImport>();

    await expect(
      runner.run(adapter, {
        repository,
        actor,
        workerId: "worker-durable-absent-marker",
        mode: "recorded_fixture",
        ingestStep: (context) => importProof(context),
        verifyFactImport: verifyPersistedImport(persistedImports),
      }),
    ).rejects.toThrow(/persisted import evidence/u);

    expect(
      repository.checkpoints.get("vndb:vndb-durable-marker-fixture:public-fixture"),
    ).toBeUndefined();
  });

  it("fails durable marker importers before commit when the marker key is wrong", async () => {
    const repository = new InMemoryCatalogCrawlerRepository();
    const runner = new ItotoriCatalogCrawlerRunner();
    const adapter = durableMarkerAdapter();
    const persistedImports = new Map<string, PersistedImport>();

    await expect(
      runner.run(adapter, {
        repository,
        actor,
        workerId: "worker-durable-wrong-marker",
        mode: "recorded_fixture",
        ingestStep: (context) => {
          persistedImports.set(context.stableImportKey, {
            strategy: catalogCrawlerFactImportStrategyValues.durableImportMarker,
            factIdentities: context.expectedFactIdentities,
            durableMarkerId: `${context.stableImportKey}:wrong`,
          });
          return importProof(context);
        },
        verifyFactImport: verifyPersistedImport(persistedImports),
      }),
    ).rejects.toThrow(/durable marker evidence/u);

    expect(
      repository.checkpoints.get("vndb:vndb-durable-marker-fixture:public-fixture"),
    ).toBeUndefined();
  });

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

type PersistedImport = {
  strategy: CatalogCrawlerFactImportEvidence["strategy"];
  factIdentities: readonly string[];
  durableMarkerId?: string;
};

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

function persistFacts(
  context: CatalogCrawlerIngestContext<FixtureFact>,
  persistedImports: Map<string, PersistedImport>,
) {
  persistedImports.set(context.stableImportKey, {
    strategy: catalogCrawlerFactImportStrategyValues.upsert,
    factIdentities: context.expectedFactIdentities,
  });
  return importProof(context);
}

function persistDurableMarker(
  context: CatalogCrawlerIngestContext<FixtureFact>,
  persistedImports: Map<string, PersistedImport>,
) {
  persistedImports.set(context.stableImportKey, {
    strategy: catalogCrawlerFactImportStrategyValues.durableImportMarker,
    factIdentities: context.expectedFactIdentities,
    durableMarkerId: context.stableImportKey,
  });
}

function verifyPersistedImport(
  persistedImports: Map<string, PersistedImport>,
): CatalogCrawlerVerifyFactImportStep<FixtureFact> {
  return ({ proof }) => {
    const persisted = persistedImports.get(proof.stableImportKey);
    if (persisted === undefined) {
      return null;
    }
    return {
      stableImportKey: proof.stableImportKey,
      strategy: persisted.strategy,
      factCount: persisted.factIdentities.length,
      factIdentities: persisted.factIdentities,
      durableMarkerId: persisted.durableMarkerId,
      persisted: true,
    };
  };
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

function stableImportKeyForStep(
  adapter: CatalogCrawlerSourceAdapter<FixtureFact>,
  step: RecordedCatalogCrawlerFixture<FixtureFact>["steps"][number],
): string {
  const payloadHash = step.payloadHash ?? `sha256:${sha256(stableJsonStringify(step.payload))}`;
  return `catalog-import:${sha256(
    stableJsonStringify({
      catalogSource: adapter.catalogSource,
      adapterName: adapter.adapterName,
      partitionKey: adapter.partitionKey ?? "default",
      sourceVersion: adapter.sourceVersion,
      parserVersion: adapter.parserVersion,
      stepKey: step.stepKey,
      sourceId: step.sourceId,
      requestIdentity: step.requestIdentity,
      payloadHash,
    }),
  )}`;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function stableJsonStringify(input: unknown): string {
  if (input === undefined) {
    return "undefined";
  }
  if (input === null || typeof input !== "object") {
    return JSON.stringify(input) ?? "undefined";
  }
  if (Array.isArray(input)) {
    return `[${input.map((value) => stableJsonStringify(value)).join(",")}]`;
  }
  const entries = Object.entries(input as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return `{${entries
    .map(([key, value]) => `${JSON.stringify(key)}:${stableJsonStringify(value)}`)
    .join(",")}}`;
}
