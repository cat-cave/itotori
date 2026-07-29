import { sql } from "drizzle-orm";

import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import {
  ItotoriModelLedgerRepository,
  type ProviderRunLedgerInput,
} from "../src/repositories/model-ledger-repository.js";
import { type ItotoriProjectRecord } from "../src/repositories/project-repository.js";
import { costLedgerEntries } from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };

export function runInput(
  providerRunId: string,
  costKind: ProviderRunLedgerInput["cost"]["costKind"],
  amountMicrosUsd: number,
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
      amountMicrosUsd,
      pricingSnapshotId: "fixture-pricing-2026-06-17",
    },
    // Captured OR routing posture for THIS run. The default fixture uses
    // the canonical alpha posture
    // (only=[deepseek-v3.2-exp@fireworks-style], zdr=true). Individual test
    // cases override via the `overrides` spread when they need to exercise
    // a different posture (e.g. a public-input call).
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

export function projectFixture(): ItotoriProjectRecord {
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
          sourceText: "こんにちは、{player}。",
          textSurface: "dialogue",
          protectedSpans: [
            { kind: "placeholder", raw: "{player}", start: 18, end: 26, preserveMode: "exact" },
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

export async function seedDrilldownRuns(
  context: Awaited<ReturnType<typeof isolatedMigratedContext>>,
): Promise<void> {
  const ledger = new ItotoriModelLedgerRepository(context.db);
  // Earliest → latest so `started_at desc` orders [a, b, c, d].
  await ledger.recordProviderRun(
    localActor,
    runInput("run-d-unknown", "billed", 300, {
      systemId: "system-a",
      startedAt: "2026-06-17T00:00:00.000Z",
      completedAt: "2026-06-17T00:00:10.000Z",
    }),
  );
  await ledger.recordProviderRun(
    localActor,
    runInput("run-c-billed", "billed", 500, {
      systemId: "system-b",
      startedAt: "2026-06-17T00:01:00.000Z",
      completedAt: "2026-06-17T00:01:10.000Z",
    }),
  );
  await ledger.recordProviderRun(
    localActor,
    runInput("run-b-zero", "zero", 0, {
      systemId: "system-a",
      startedAt: "2026-06-17T00:02:00.000Z",
      completedAt: "2026-06-17T00:02:10.000Z",
    }),
  );
  await ledger.recordProviderRun(
    localActor,
    runInput("run-a-billed", "billed", 1200, {
      systemId: "system-a",
      startedAt: "2026-06-17T00:03:00.000Z",
      completedAt: "2026-06-17T00:03:10.000Z",
      adapterMetadata: {
        providerRouting: { order: ["fixture-upstream"], allowFallbacks: false },
        rawResponse: { choices: [{ message: { content: "leaked body" } }] },
      },
    }),
  );
  await context.db.execute(
    sql`delete from ${costLedgerEntries} where provider_run_id = 'run-d-unknown'`,
  );
}
