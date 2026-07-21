import { testProjectEngineFamilyRegistry } from "./project-engine-family-registry.js";
import { describe, expect, it } from "vitest";
import { AuthorizationError, localUserId, type AuthorizationActor } from "../src/authorization.js";
import {
  ItotoriModelLedgerRepository,
  type ProviderRunLedgerInput,
} from "../src/repositories/model-ledger-repository.js";
import { ItotoriModelRoutingSettingsRepository } from "../src/repositories/model-routing-settings-repository.js";
import {
  ItotoriProjectRepository,
  type ItotoriProjectRecord,
} from "../src/repositories/project-repository.js";
import { modelProviders } from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };

describe("ItotoriModelRoutingSettingsRepository", () => {
  it("loads registry choices and persists a project task route", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(
        context.db,
        testProjectEngineFamilyRegistry,
      );
      await projectRepository.importSourceBundle(localActor, projectFixture());
      const ledger = new ItotoriModelLedgerRepository(context.db);
      await ledger.recordProviderRun(
        localActor,
        runInput("run-routing-seed", {
          provider: {
            providerFamily: "recorded",
            endpointFamily: "recorded-fixture",
            providerName: "recorded-provider",
            requestedModelId: "fixture-model-v1",
            actualModelId: "fixture-model-v2",
          },
          fallbackUsed: true,
          fallbackPlan: ["fixture-model-v1", "fixture-model-v2"],
        }),
      );
      const provider = (await context.db.select().from(modelProviders))[0];
      expect(provider).toBeDefined();
      const repository = new ItotoriModelRoutingSettingsRepository(context.db);

      const saved = await repository.saveRoute(localActor, {
        projectId: "project-test",
        taskKind: "draft_translation",
        providerId: provider!.providerId,
        modelId: "fixture-model-v1",
        fallbackModelIds: ["fixture-model-v2"],
        promptPresetId: "itotori-test-preset",
        promptTemplateVersion: "1.0.0",
      });
      const loaded = await repository.loadSettings(localActor, "project-test");

      expect(saved.providers).toEqual(
        expect.arrayContaining([expect.objectContaining({ providerId: provider!.providerId })]),
      );
      expect(saved.models).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            providerId: provider!.providerId,
            modelId: "fixture-model-v1",
          }),
          expect.objectContaining({
            providerId: provider!.providerId,
            modelId: "fixture-model-v2",
          }),
        ]),
      );
      expect(saved.promptPresets).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            promptPresetId: "itotori-test-preset",
            promptTemplateVersion: "1.0.0",
          }),
        ]),
      );
      expect(loaded.routes).toEqual([
        expect.objectContaining({
          projectId: "project-test",
          taskKind: "draft_translation",
          providerId: provider!.providerId,
          modelId: "fixture-model-v1",
          fallbackModelIds: ["fixture-model-v2"],
          promptPresetId: "itotori-test-preset",
          promptTemplateVersion: "1.0.0",
        }),
      ]);
    } finally {
      await context.close();
    }
  });

  it("denies writes without draft.write", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repository = new ItotoriModelRoutingSettingsRepository(context.db);
      const actor = { userId: "user-without-required-permission" };

      await expect(
        repository.saveRoute(actor, {
          projectId: "project-test",
          taskKind: "draft_translation",
          providerId: "provider",
          modelId: "model",
          fallbackModelIds: [],
          promptPresetId: "preset",
          promptTemplateVersion: "1.0.0",
        }),
      ).rejects.toMatchObject(new AuthorizationError(actor, "draft.write"));
    } finally {
      await context.close();
    }
  });
});

function runInput(
  providerRunId: string,
  overrides: Partial<ProviderRunLedgerInput> = {},
): ProviderRunLedgerInput {
  const input: ProviderRunLedgerInput = {
    providerRunId,
    projectId: "project-test",
    localeBranchId: "locale-en-us",
    taskKind: "draft_translation",
    startedAt: "2026-06-17T00:00:00.000Z",
    completedAt: "2026-06-17T00:00:10.000Z",
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
      costKind: "billed",
      currency: "USD",
      amountMicrosUsd: 0,
      pricingSnapshotId: "fixture-pricing-2026-06-17",
    },
    routingPosture: {
      only: ["itotori-fixture"],
      allow_fallbacks: false,
      data_collection: "deny",
      zdr: true,
      require_parameters: true,
    },
    adapterMetadata: {},
  };
  return { ...input, ...overrides };
}

function projectFixture(): ItotoriProjectRecord {
  return {
    projectId: "project-test",
    engineFamily: "synthetic_fixture",
    sourceRoot: "/workspace/source",
    buildRoot: "/workspace/build",
    extractProfile: { adapter: "fixture" },
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
          sourceText: "Hello, {player}.",
          textSurface: "dialogue",
          protectedSpans: [
            { kind: "placeholder", raw: "{player}", start: 7, end: 15, preserveMode: "exact" },
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
