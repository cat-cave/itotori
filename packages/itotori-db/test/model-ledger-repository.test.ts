import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import {
  ItotoriModelLedgerRepository,
  type ProviderRunLedgerInput,
} from "../src/repositories/model-ledger-repository.js";
import {
  ItotoriProjectRepository,
  type ItotoriProjectRecord,
} from "../src/repositories/project-repository.js";
import {
  costLedgerEntries,
  modelProviders,
  modelRegistry,
  promptPresets,
  providerRuns,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };

describe("ItotoriModelLedgerRepository", () => {
  it("persists provider identity, prompt presets, separated costs, and fallback metadata", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(context.db);
      await projectRepository.importSourceBundle(localActor, projectFixture());
      const ledger = new ItotoriModelLedgerRepository(context.db);

      await ledger.recordProviderRun(localActor, runInput("run-billed", "billed", 1200));
      await ledger.recordProviderRun(
        localActor,
        runInput("run-estimated-fallback", "provider_estimate", 2500, {
          provider: {
            providerFamily: "recorded",
            endpointFamily: "recorded-fixture",
            providerName: "recorded-provider",
            requestedModelId: "fixture-model-v1",
            actualModelId: "fixture-model-v2",
            upstreamProvider: "fixture-upstream",
            routeSettingsHash:
              "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          },
          fallbackUsed: true,
          fallbackPlan: ["fixture-model-v1", "fixture-model-v2"],
          providerPreset: {
            slug: "openrouter/fixture-draft",
            version: "2026-06-17",
            configHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            configSnapshot: {
              providerRouting: {
                order: ["fixture-upstream"],
              },
            },
          },
          adapterMetadata: {
            providerRouting: {
              allowFallbacks: true,
              order: ["fixture-upstream"],
            },
          },
        }),
      );
      await ledger.recordProviderRun(localActor, runInput("run-zero", "zero", 0));
      await ledger.recordProviderRun(localActor, runInput("run-unknown", "unknown"));

      const report = await ledger.getProjectCostReport("project-test");

      expect(report).toMatchObject({
        projectId: "project-test",
        runCount: 4,
        billedMicrosUsd: 1200,
        estimatedMicrosUsd: 2500,
        zeroRunCount: 1,
        unknownRunCount: 1,
        includesUnknownCost: true,
      });
      expect(report.totalsByCostKind).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ costKind: "billed", runCount: 1, amountMicrosUsd: 1200 }),
          expect.objectContaining({
            costKind: "provider_estimate",
            runCount: 1,
            amountMicrosUsd: 2500,
          }),
          expect.objectContaining({ costKind: "zero", runCount: 1, amountMicrosUsd: 0 }),
          expect.objectContaining({ costKind: "unknown", runCount: 1, amountMicrosUsd: 0 }),
        ]),
      );

      const fallbackRun = report.recentRuns.find(
        (run) => run.providerRunId === "run-estimated-fallback",
      );
      expect(fallbackRun).toMatchObject({
        providerFamily: "recorded",
        requestedModelId: "fixture-model-v1",
        actualModelId: "fixture-model-v2",
        upstreamProvider: "fixture-upstream",
        routeSettingsHash:
          "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        promptPresetId: "itotori-test-preset",
        promptTemplateVersion: "1.0.0",
        fallbackUsed: true,
        fallbackPlan: ["fixture-model-v1", "fixture-model-v2"],
        costKind: "provider_estimate",
      });

      const counts = await context.db.execute(sql`
        select
          (select count(*)::int from ${modelProviders}) as provider_count,
          (select count(*)::int from ${modelRegistry}) as model_count,
          (select count(*)::int from ${promptPresets}) as preset_count,
          (select count(*)::int from ${providerRuns}) as provider_run_count,
          (select count(*)::int from ${costLedgerEntries}) as cost_entry_count
      `);
      expect(counts.rows[0]).toMatchObject({
        provider_count: 2,
        model_count: 3,
        preset_count: 1,
        provider_run_count: 4,
        cost_entry_count: 4,
      });
      const providerPreset = await context.db.execute(sql`
        select provider_preset
        from ${providerRuns}
        where provider_run_id = 'run-estimated-fallback'
      `);
      expect(providerPreset.rows[0]).toMatchObject({
        provider_preset: expect.objectContaining({
          slug: "openrouter/fixture-draft",
          configSnapshot: expect.objectContaining({
            providerRouting: { order: ["fixture-upstream"] },
          }),
        }),
      });
    } finally {
      await context.close();
    }
  });

  it("records failed provider runs with unknown cost in the ledger", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(context.db);
      await projectRepository.importSourceBundle(localActor, projectFixture());
      const ledger = new ItotoriModelLedgerRepository(context.db);

      await ledger.recordProviderRun(
        localActor,
        runInput("run-failed-http", "unknown", undefined, {
          status: "failed",
          errorClasses: ["provider_http_error", "http_500"],
          tokenUsage: { tokenCountSource: "unknown" },
        }),
      );

      const report = await ledger.getProjectCostReport("project-test");
      expect(report).toMatchObject({
        runCount: 1,
        unknownRunCount: 1,
        includesUnknownCost: true,
      });
      expect(report.recentRuns[0]).toMatchObject({
        providerRunId: "run-failed-http",
        status: "failed",
        costKind: "unknown",
        amountMicrosUsd: null,
        tokenCountSource: "unknown",
      });
    } finally {
      await context.close();
    }
  });

  it("keeps provider run and cost rows append-only for duplicate run ids", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(context.db);
      await projectRepository.importSourceBundle(localActor, projectFixture());
      const ledger = new ItotoriModelLedgerRepository(context.db);

      await ledger.recordProviderRun(localActor, runInput("run-append-only", "billed", 100));
      await expect(
        ledger.recordProviderRun(localActor, runInput("run-append-only", "billed", 999)),
      ).rejects.toThrow();

      const report = await ledger.getProjectCostReport("project-test");
      expect(report).toMatchObject({
        runCount: 1,
        billedMicrosUsd: 100,
      });
      expect(report.recentRuns[0]).toMatchObject({
        providerRunId: "run-append-only",
        amountMicrosUsd: 100,
      });
    } finally {
      await context.close();
    }
  });

  it("rejects prompt preset drift for an existing preset id and version", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(context.db);
      await projectRepository.importSourceBundle(localActor, projectFixture());
      const ledger = new ItotoriModelLedgerRepository(context.db);

      await ledger.recordProviderRun(localActor, runInput("run-preset-original", "zero", 0));
      await expect(
        ledger.recordProviderRun(
          localActor,
          runInput("run-preset-drift", "zero", 0, {
            prompt: {
              promptPresetId: "itotori-test-preset",
              promptTemplateVersion: "1.0.0",
              promptHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              presetSchemaVersion: "itotori.prompt-preset.v0",
              configSnapshot: { template: "changed prompt" },
            },
          }),
        ),
      ).rejects.toThrow(/immutable/u);

      const rows = await context.db.execute(sql`
        select
          (select count(*)::int from ${promptPresets}) as preset_count,
          (select prompt_hash from ${promptPresets} limit 1) as prompt_hash,
          (select count(*)::int from ${providerRuns}) as provider_run_count
      `);
      expect(rows.rows[0]).toMatchObject({
        preset_count: 1,
        prompt_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        provider_run_count: 1,
      });
    } finally {
      await context.close();
    }
  });
});

function runInput(
  providerRunId: string,
  costKind: ProviderRunLedgerInput["cost"]["costKind"],
  amountMicrosUsd?: number,
  overrides: Partial<ProviderRunLedgerInput> = {},
): ProviderRunLedgerInput {
  const input: ProviderRunLedgerInput = {
    providerRunId,
    projectId: "project-test",
    localeBranchId: "locale-en-us",
    taskKind: "draft_translation",
    startedAt: `2026-06-17T00:00:0${Math.min(providerRunId.length, 9)}.000Z`,
    completedAt: `2026-06-17T00:00:1${Math.min(providerRunId.length, 9)}.000Z`,
    latencyMs: 1000,
    status: "succeeded",
    provider: {
      providerFamily: "fake",
      endpointFamily: "chat-completions",
      providerName: "itotori-fixture",
      requestedModelId: "itotori-fake-draft-v0",
      actualModelId: "itotori-fake-draft-v0",
    },
    prompt: {
      promptPresetId: "itotori-test-preset",
      promptTemplateVersion: "1.0.0",
      promptHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      presetSchemaVersion: "itotori.prompt-preset.v0",
      configSnapshot: { template: "test prompt" },
    },
    structuredOutputMode: "json_schema",
    retryCount: 0,
    errorClasses: [],
    fallbackUsed: false,
    fallbackPlan: ["itotori-fake-draft-v0"],
    tokenUsage: {
      tokenCountSource: "provider_reported",
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    },
    cost: {
      costKind,
      currency: "USD",
      ...(amountMicrosUsd === undefined ? {} : { amountMicrosUsd }),
      pricingSnapshotId: "fixture-pricing-2026-06-17",
    },
    dataHandling: {
      costTier: "local",
      promptLogging: "not_applicable",
      completionLogging: "not_applicable",
      retention: "not_applicable",
      trainingUse: "not_applicable",
      dataCollection: "not_applicable",
      rawCaptureDefault: "disabled",
    },
    adapterMetadata: {},
  };
  return { ...input, ...overrides };
}

function projectFixture(): ItotoriProjectRecord {
  return {
    projectId: "project-test",
    localeBranchId: "locale-en-us",
    targetLocale: "en-US",
    drafts: {},
    bridge: {
      schemaVersion: "0.1.0",
      bridgeId: "bridge-test",
      sourceBundleHash: "hash-test",
      sourceLocale: "ja-JP",
      extractorName: "kaifuu-fixture",
      extractorVersion: "0.0.0",
      units: [
        {
          bridgeUnitId: "bridge-unit-test",
          sourceUnitKey: "hello.scene.001.line.001",
          occurrenceId: "occurrence-1",
          sourceHash: "source-hash",
          sourceLocale: "ja-JP",
          sourceText: "こんにちは、{player}。",
          textSurface: "dialogue",
          protectedSpans: [
            { kind: "placeholder", raw: "{player}", start: 6, end: 14, preserveMode: "exact" },
          ],
          patchRef: {
            assetId: "source.json",
            writeMode: "replace",
            sourceUnitKey: "hello.scene.001.line.001",
          },
        },
      ],
    },
  };
}
