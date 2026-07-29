import { createHash } from "node:crypto";
import { BENCHMARK_TOKEN_COUNT_SOURCES } from "@itotori/localization-bridge-schema";
import { sql } from "drizzle-orm";
import {
  costLedgerEntries,
  modelProviders,
  modelRegistry,
  promptPresets,
  providerCostKindValues,
  providerRuns,
  type ProviderCostKind,
} from "../schema.js";
import type {
  ItotoriLedgerTransaction,
  LedgerJsonRecord,
  PromptPresetLedgerInput,
  ProviderRunLedgerInput,
} from "./model-ledger-repository-types.js";

const costKinds = Object.values(providerCostKindValues) as ProviderCostKind[];
const tokenCountSources = [...BENCHMARK_TOKEN_COUNT_SOURCES];

export async function insertProviderRunLedgerRows(
  tx: ItotoriLedgerTransaction,
  input: ProviderRunLedgerInput,
): Promise<void> {
  assertProviderRunLedgerInput(input);

  const providerId = modelProviderId(input.provider);
  const requestedModelRegistryId = modelRegistryId(providerId, input.provider.requestedModelId);
  const actualModelRegistryId = modelRegistryId(providerId, input.provider.actualModelId);
  const costLedgerEntryId = `${input.providerRunId}:cost`;
  const amountMicrosUsd = amountForCost(input.cost);
  const pricing = input.cost.pricingSnapshotId
    ? { pricingSnapshotId: input.cost.pricingSnapshotId }
    : {};
  const presetSchemaVersion = input.prompt.presetSchemaVersion ?? "itotori.prompt-preset.v0";
  const presetConfigSnapshot = input.prompt.configSnapshot ?? {};

  await tx
    .insert(modelProviders)
    .values({
      providerId,
      providerFamily: input.provider.providerFamily,
      endpointFamily: input.provider.endpointFamily,
      providerName: input.provider.providerName,
      metadata: {},
    })
    .onConflictDoUpdate({
      target: modelProviders.providerId,
      set: {
        providerFamily: input.provider.providerFamily,
        endpointFamily: input.provider.endpointFamily,
        providerName: input.provider.providerName,
        updatedAt: sql`now()`,
      },
    });

  for (const [registryId, modelId] of [
    [requestedModelRegistryId, input.provider.requestedModelId],
    [actualModelRegistryId, input.provider.actualModelId],
  ] as const) {
    await tx
      .insert(modelRegistry)
      .values({
        modelRegistryId: registryId,
        providerId,
        modelId,
        capabilities: {},
        pricing,
      })
      .onConflictDoUpdate({
        target: modelRegistry.modelRegistryId,
        set: {
          modelId,
          pricing,
          updatedAt: sql`now()`,
        },
      });
  }

  const existingPresetResult = await tx.execute(sql`
    select preset_schema_version, prompt_hash, config_snapshot
    from ${promptPresets}
    where prompt_preset_id = ${input.prompt.promptPresetId}
      and prompt_template_version = ${input.prompt.promptTemplateVersion}
    limit 1
  `);
  const existingPreset = existingPresetResult.rows[0] as Record<string, unknown> | undefined;
  if (existingPreset) {
    assertPromptPresetMatches(input.prompt, presetSchemaVersion, presetConfigSnapshot, {
      presetSchemaVersion: String(existingPreset.preset_schema_version),
      promptHash: String(existingPreset.prompt_hash),
      configSnapshot: existingPreset.config_snapshot,
    });
  } else {
    await tx.insert(promptPresets).values({
      promptPresetId: input.prompt.promptPresetId,
      promptTemplateVersion: input.prompt.promptTemplateVersion,
      presetSchemaVersion,
      promptHash: input.prompt.promptHash,
      configSnapshot: presetConfigSnapshot,
    });
  }

  await tx.insert(providerRuns).values({
    providerRunId: input.providerRunId,
    projectId: input.projectId,
    localeBranchId: input.localeBranchId ?? null,
    jobId: input.jobId ?? null,
    systemId: input.systemId ?? null,
    taskKind: input.taskKind,
    status: input.status,
    startedAt: new Date(input.startedAt),
    completedAt: input.completedAt === undefined ? null : new Date(input.completedAt),
    latencyMs: input.latencyMs ?? null,
    providerId,
    requestedModelRegistryId,
    actualModelRegistryId,
    requestedModelId: input.provider.requestedModelId,
    actualModelId: input.provider.actualModelId,
    upstreamProvider: input.provider.upstreamProvider ?? null,
    routeSettingsHash: input.provider.routeSettingsHash ?? null,
    promptPresetId: input.prompt.promptPresetId,
    promptTemplateVersion: input.prompt.promptTemplateVersion,
    promptHash: input.prompt.promptHash,
    providerPreset: input.providerPreset ?? null,
    structuredOutputMode: input.structuredOutputMode,
    retryCount: input.retryCount,
    errorClasses: input.errorClasses,
    fallbackUsed: input.fallbackUsed,
    fallbackPlan: input.fallbackPlan,
    tokenCountSource: input.tokenUsage.tokenCountSource,
    promptTokens: input.tokenUsage.promptTokens ?? null,
    completionTokens: input.tokenUsage.completionTokens ?? null,
    reasoningTokens: input.tokenUsage.reasoningTokens ?? null,
    cachedInputTokens: input.tokenUsage.cachedInputTokens ?? null,
    totalTokens: input.tokenUsage.totalTokens ?? null,
    routingPosture: input.routingPosture,
    adapterMetadata: input.adapterMetadata ?? {},
  });

  await tx.insert(costLedgerEntries).values({
    costLedgerEntryId,
    providerRunId: input.providerRunId,
    projectId: input.projectId,
    localeBranchId: input.localeBranchId ?? null,
    costKind: input.cost.costKind,
    currency: input.cost.currency,
    amountMicrosUsd,
    pricingSnapshotId: input.cost.pricingSnapshotId ?? null,
    tokenCountSource: input.tokenUsage.tokenCountSource,
    promptTokens: input.tokenUsage.promptTokens ?? null,
    completionTokens: input.tokenUsage.completionTokens ?? null,
    reasoningTokens: input.tokenUsage.reasoningTokens ?? null,
    cachedInputTokens: input.tokenUsage.cachedInputTokens ?? null,
    totalTokens: input.tokenUsage.totalTokens ?? null,
  });
}

function assertPromptPresetMatches(
  input: PromptPresetLedgerInput,
  presetSchemaVersion: string,
  configSnapshot: LedgerJsonRecord,
  existing: {
    presetSchemaVersion: string;
    promptHash: string;
    configSnapshot: unknown;
  },
): void {
  if (
    existing.presetSchemaVersion === presetSchemaVersion &&
    existing.promptHash === input.promptHash &&
    jsonEqual(existing.configSnapshot, configSnapshot)
  ) {
    return;
  }
  throw new Error(
    `prompt preset ${input.promptPresetId}@${input.promptTemplateVersion} is immutable; create a new template version for prompt or config changes`,
  );
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return stableJsonString(left) === stableJsonString(right);
}

function stableJsonString(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalizeJson(entry)]),
    );
  }
  return value;
}

export function assertProviderRunLedgerInput(input: ProviderRunLedgerInput): void {
  assertNonEmpty(input.providerRunId, "providerRunId");
  assertNonEmpty(input.projectId, "projectId");
  assertNonEmpty(input.provider.providerFamily, "provider.providerFamily");
  assertNonEmpty(input.provider.endpointFamily, "provider.endpointFamily");
  assertNonEmpty(input.provider.providerName, "provider.providerName");
  assertNonEmpty(input.provider.requestedModelId, "provider.requestedModelId");
  assertNonEmpty(input.provider.actualModelId, "provider.actualModelId");
  assertNonEmpty(input.prompt.promptPresetId, "prompt.promptPresetId");
  assertNonEmpty(input.prompt.promptTemplateVersion, "prompt.promptTemplateVersion");
  assertHash(input.prompt.promptHash, "prompt.promptHash");
  if (
    input.completedAt !== undefined &&
    Date.parse(String(input.completedAt)) < Date.parse(String(input.startedAt))
  ) {
    throw new Error("completedAt must not be before startedAt");
  }
  if (input.latencyMs !== undefined) {
    assertNonNegativeInteger(input.latencyMs, "latencyMs");
  }
  assertNonNegativeInteger(input.retryCount, "retryCount");
  assertStringArray(input.errorClasses, "errorClasses");
  assertFallbackPlan(input);
  assertTokenUsage(input.tokenUsage);
  assertJsonRecord(input.routingPosture, "routingPosture");
  if (!costKinds.includes(input.cost.costKind)) {
    throw new Error(`unsupported cost kind: ${input.cost.costKind}`);
  }
  if (input.cost.currency !== "USD") {
    throw new Error(`unsupported cost currency: ${input.cost.currency}`);
  }
  amountForCost(input.cost);
}

function amountForCost(cost: ProviderRunLedgerInput["cost"]): number {
  // costKind is `'billed' | 'zero'` and amountMicrosUsd is required.
  // Zero rows must carry exactly 0; billed rows must carry a non-negative
  // finite number. The migration's CHECK constraint enforces the same
  // shape at the storage layer.
  if (!Number.isFinite(cost.amountMicrosUsd) || cost.amountMicrosUsd < 0) {
    throw new Error("amountMicrosUsd must be a non-negative finite number");
  }
  if (cost.costKind === providerCostKindValues.zero && cost.amountMicrosUsd !== 0) {
    throw new Error("zero cost entries must use amountMicrosUsd 0");
  }
  return cost.amountMicrosUsd;
}

function modelProviderId(provider: ProviderRunLedgerInput["provider"]): string {
  return stableId("provider", [
    provider.providerFamily,
    provider.endpointFamily,
    provider.providerName,
  ]);
}

function modelRegistryId(providerId: string, modelId: string): string {
  return stableId("model", [providerId, modelId]);
}

function stableId(prefix: string, parts: string[]): string {
  const hash = createHash("sha256").update(parts.join("\u001f")).digest("hex").slice(0, 32);
  return `${prefix}-${hash}`;
}

function assertNonEmpty(value: string, label: string): void {
  if (value.length === 0) {
    throw new Error(`${label} must be non-empty`);
  }
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
}

function assertHash(value: string, label: string): void {
  assertNonEmpty(value, label);
  if (!value.startsWith("sha256:")) {
    throw new Error(`${label} must be a sha256 hash`);
  }
}

function assertStringArray(value: string[], label: string): void {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
}

function assertFallbackPlan(input: ProviderRunLedgerInput): void {
  assertStringArray(input.fallbackPlan, "fallbackPlan");
  if (input.fallbackPlan.length === 0) {
    throw new Error("fallbackPlan must include at least the requested model");
  }
  if (!input.fallbackPlan.includes(input.provider.requestedModelId)) {
    throw new Error("fallbackPlan must include the requested model");
  }
  if (input.fallbackUsed && input.fallbackPlan.length < 2) {
    throw new Error("fallbackUsed provider runs must include a fallback chain");
  }
  if (input.fallbackUsed && !input.fallbackPlan.includes(input.provider.actualModelId)) {
    throw new Error("fallbackPlan must include the actual routed model when fallback is used");
  }
}

function assertTokenUsage(tokenUsage: ProviderRunLedgerInput["tokenUsage"]): void {
  assertEnumValue(tokenUsage.tokenCountSource, tokenCountSources, "tokenUsage.tokenCountSource");
  const tokenFields = [
    ["promptTokens", tokenUsage.promptTokens],
    ["completionTokens", tokenUsage.completionTokens],
    ["reasoningTokens", tokenUsage.reasoningTokens],
    ["cachedInputTokens", tokenUsage.cachedInputTokens],
    ["totalTokens", tokenUsage.totalTokens],
  ] as const;
  for (const [field, value] of tokenFields) {
    if (value !== undefined) {
      assertNonNegativeInteger(value, `tokenUsage.${field}`);
    }
  }
  if (tokenUsage.tokenCountSource === "unknown" && tokenUsage.totalTokens !== undefined) {
    throw new Error("unknown tokenCountSource entries must not include totalTokens");
  }
  const subtotal =
    (tokenUsage.promptTokens ?? 0) +
    (tokenUsage.completionTokens ?? 0) +
    (tokenUsage.reasoningTokens ?? 0);
  if (tokenUsage.totalTokens !== undefined && tokenUsage.totalTokens < subtotal) {
    throw new Error(
      "tokenUsage.totalTokens must cover promptTokens, completionTokens, and reasoningTokens",
    );
  }
}

function assertJsonRecord(value: LedgerJsonRecord, label: string): void {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${label} must be a JSON object`);
  }
}

function assertEnumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): asserts value is T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${label} must be one of ${allowed.join(", ")}`);
  }
}
