import { createHash } from "node:crypto";
import {
  BENCHMARK_TOKEN_COUNT_SOURCES,
  type BenchmarkTokenCountSourceV02,
} from "@itotori/localization-bridge-schema";
import { sql } from "drizzle-orm";
import type { ItotoriDatabase } from "../connection.js";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import {
  costLedgerEntries,
  modelProviders,
  modelRegistry,
  promptPresets,
  providerCostKindValues,
  providerRuns,
  projects,
  translationMemoryReuseEvents,
  type ProviderCostKind,
  type ProviderRunStatus,
} from "../schema.js";

export type LedgerJsonRecord = Record<string, unknown>;

export type PromptPresetLedgerInput = {
  promptPresetId: string;
  promptTemplateVersion: string;
  promptHash: string;
  presetSchemaVersion?: string;
  configSnapshot?: LedgerJsonRecord;
};

export type ProviderRunLedgerInput = {
  providerRunId: string;
  projectId: string;
  localeBranchId?: string;
  jobId?: string;
  systemId?: string;
  taskKind: string;
  startedAt: string | Date;
  completedAt?: string | Date;
  latencyMs?: number;
  status: ProviderRunStatus;
  provider: {
    providerFamily: string;
    endpointFamily: string;
    providerName: string;
    requestedModelId: string;
    actualModelId: string;
    upstreamProvider?: string;
    routeSettingsHash?: string;
  };
  prompt: PromptPresetLedgerInput;
  providerPreset?: LedgerJsonRecord;
  structuredOutputMode: string;
  retryCount: number;
  errorClasses: string[];
  fallbackUsed: boolean;
  fallbackPlan: string[];
  tokenUsage: {
    tokenCountSource: BenchmarkTokenCountSourceV02;
    promptTokens?: number;
    completionTokens?: number;
    reasoningTokens?: number;
    cachedInputTokens?: number;
    totalTokens?: number;
  };
  cost: {
    costKind: ProviderCostKind;
    currency: "USD";
    amountMicrosUsd?: number;
    pricingSnapshotId?: string;
  };
  dataHandling: LedgerJsonRecord;
  accountPrivacy?: LedgerJsonRecord;
  adapterMetadata?: LedgerJsonRecord;
};

export type CostKindBreakdown = {
  costKind: ProviderCostKind;
  runCount: number;
  amountMicrosUsd: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type ProviderRunCostSummary = {
  providerRunId: string;
  taskKind: string;
  status: string;
  startedAt: string;
  structuredOutputMode: string;
  retryCount: number;
  errorClasses: string[];
  providerFamily: string;
  endpointFamily: string;
  providerName: string;
  requestedModelId: string;
  actualModelId: string;
  upstreamProvider: string | null;
  routeSettingsHash: string | null;
  promptPresetId: string;
  promptTemplateVersion: string;
  promptHash: string;
  fallbackUsed: boolean;
  fallbackPlan: string[];
  costKind: ProviderCostKind;
  amountMicrosUsd: number | null;
  tokenCountSource: string;
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  cachedInputTokens: number | null;
  totalTokens: number | null;
  dataHandling: LedgerJsonRecord;
  accountPrivacy: LedgerJsonRecord | null;
};

export type TranslationMemoryReuseCostSummary = {
  reuseEventId: string;
  localeBranchId: string;
  targetBridgeUnitId: string;
  memorySegmentId: string;
  matchKind: string;
  matchScore: number;
  reuseStatus: string;
  sourceHash: string;
  candidateSourceHash: string;
  targetText: string;
  providerCallAvoided: boolean;
  estimatedPromptTokensSaved: number;
  estimatedCompletionTokensSaved: number;
  estimatedTotalTokensSaved: number;
  estimatedCostUsdSaved: number | null;
  calculation: string;
  provenance: LedgerJsonRecord;
  createdAt: string;
};

export type TranslationMemoryReuseCostReport = {
  reuseEventCount: number;
  appliedCount: number;
  suggestedCount: number;
  providerCallAvoidedCount: number;
  estimatedPromptTokensSaved: number;
  estimatedCompletionTokensSaved: number;
  estimatedTotalTokensSaved: number;
  estimatedCostUsdSaved: number | null;
  recentEvents: TranslationMemoryReuseCostSummary[];
};

export type ProjectCostReport = {
  projectId: string;
  currency: "USD";
  runCount: number;
  billedMicrosUsd: number;
  estimatedMicrosUsd: number;
  zeroRunCount: number;
  unknownRunCount: number;
  includesUnknownCost: boolean;
  totalsByCostKind: CostKindBreakdown[];
  recentRuns: ProviderRunCostSummary[];
  translationMemoryReuse: TranslationMemoryReuseCostReport;
};

export interface ItotoriModelLedgerRepositoryPort {
  recordProviderRun(
    actor: AuthorizationActor,
    input: ProviderRunLedgerInput,
  ): Promise<ProviderRunCostSummary>;
  getProjectCostReport(projectId?: string): Promise<ProjectCostReport>;
}

const costKinds = Object.values(providerCostKindValues) as ProviderCostKind[];
const tokenCountSources = [...BENCHMARK_TOKEN_COUNT_SOURCES];
export type ItotoriLedgerTransaction = Parameters<Parameters<ItotoriDatabase["transaction"]>[0]>[0];

export class ItotoriModelLedgerRepository implements ItotoriModelLedgerRepositoryPort {
  constructor(private readonly db: ItotoriDatabase) {}

  async recordProviderRun(
    actor: AuthorizationActor,
    input: ProviderRunLedgerInput,
  ): Promise<ProviderRunCostSummary> {
    await requirePermission(this.db, actor, permissionValues.runtimeIngest);
    assertProviderRunLedgerInput(input);
    await this.db.transaction(async (tx) => {
      await insertProviderRunLedgerRows(tx, input);
    });

    const run = await this.getProviderRunCostSummary(input.projectId, input.providerRunId);
    if (!run) {
      throw new Error(`provider run ${input.providerRunId} was not recorded`);
    }
    return run;
  }

  async getProjectCostReport(projectId?: string): Promise<ProjectCostReport> {
    const targetProjectId = projectId ?? (await this.latestProjectId());
    const totalsResult = await this.db.execute(sql`
      select
        cost_kind,
        count(*)::int as run_count,
        coalesce(sum(amount_micros_usd), 0)::text as amount_micros_usd,
        coalesce(sum(prompt_tokens), 0)::int as prompt_tokens,
        coalesce(sum(completion_tokens), 0)::int as completion_tokens,
        coalesce(sum(total_tokens), 0)::int as total_tokens
      from ${costLedgerEntries}
      where project_id = ${targetProjectId}
      group by cost_kind
    `);

    const byKind = new Map<ProviderCostKind, CostKindBreakdown>();
    for (const costKind of costKinds) {
      byKind.set(costKind, {
        costKind,
        runCount: 0,
        amountMicrosUsd: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      });
    }
    for (const row of totalsResult.rows as Array<Record<string, unknown>>) {
      const costKind = asCostKind(row.cost_kind);
      byKind.set(costKind, {
        costKind,
        runCount: Number(row.run_count ?? 0),
        amountMicrosUsd: Number(row.amount_micros_usd ?? 0),
        promptTokens: Number(row.prompt_tokens ?? 0),
        completionTokens: Number(row.completion_tokens ?? 0),
        totalTokens: Number(row.total_tokens ?? 0),
      });
    }

    const recentRunsResult = await this.db.execute(sql`
      select
        pr.provider_run_id,
        pr.task_kind,
        pr.status,
        pr.started_at,
        pr.structured_output_mode,
        pr.retry_count,
        pr.error_classes,
        mp.provider_family,
        mp.endpoint_family,
        mp.provider_name,
        pr.requested_model_id,
        pr.actual_model_id,
        pr.upstream_provider,
        pr.route_settings_hash,
        pr.prompt_preset_id,
        pr.prompt_template_version,
        pr.prompt_hash,
        pr.fallback_used,
        pr.fallback_plan,
        cle.cost_kind,
        cle.amount_micros_usd::text as amount_micros_usd,
        cle.token_count_source,
        cle.prompt_tokens,
        cle.completion_tokens,
        cle.reasoning_tokens,
        cle.cached_input_tokens,
        cle.total_tokens,
        pr.data_handling,
        pr.account_privacy
      from ${providerRuns} pr
      join ${modelProviders} mp on mp.provider_id = pr.provider_id
      join ${costLedgerEntries} cle on cle.provider_run_id = pr.provider_run_id
      where pr.project_id = ${targetProjectId}
      order by pr.started_at desc, pr.provider_run_id desc
      limit 20
    `);

    const recentRuns = (recentRunsResult.rows as Array<Record<string, unknown>>).map(runFromRow);
    const translationMemoryReuse = await this.getTranslationMemoryReuseCostReport(targetProjectId);
    const billed = byKind.get(providerCostKindValues.billed)?.amountMicrosUsd ?? 0;
    const providerEstimate =
      byKind.get(providerCostKindValues.providerEstimate)?.amountMicrosUsd ?? 0;
    const localEstimate = byKind.get(providerCostKindValues.localEstimate)?.amountMicrosUsd ?? 0;
    const unknownRunCount = byKind.get(providerCostKindValues.unknown)?.runCount ?? 0;

    return {
      projectId: targetProjectId,
      currency: "USD",
      runCount: [...byKind.values()].reduce((sum, row) => sum + row.runCount, 0),
      billedMicrosUsd: billed,
      estimatedMicrosUsd: providerEstimate + localEstimate,
      zeroRunCount: byKind.get(providerCostKindValues.zero)?.runCount ?? 0,
      unknownRunCount,
      includesUnknownCost: unknownRunCount > 0,
      totalsByCostKind: costKinds.map(
        (costKind) => byKind.get(costKind) ?? zeroBreakdown(costKind),
      ),
      recentRuns,
      translationMemoryReuse,
    };
  }

  private async getTranslationMemoryReuseCostReport(
    projectId: string,
  ): Promise<TranslationMemoryReuseCostReport> {
    const totalsResult = await this.db.execute(sql`
      select
        count(*)::int as reuse_event_count,
        count(*) filter (where reuse_status = 'applied')::int as applied_count,
        count(*) filter (where reuse_status = 'suggested')::int as suggested_count,
        count(*) filter (where (cost_impact->>'providerCallAvoided')::boolean is true)::int
          as provider_call_avoided_count,
        coalesce(sum((cost_impact->>'estimatedPromptTokensSaved')::int), 0)::int
          as estimated_prompt_tokens_saved,
        coalesce(sum((cost_impact->>'estimatedCompletionTokensSaved')::int), 0)::int
          as estimated_completion_tokens_saved,
        coalesce(sum((cost_impact->>'estimatedTotalTokensSaved')::int), 0)::int
          as estimated_total_tokens_saved,
        sum((cost_impact->>'estimatedCostUsdSaved')::numeric)::text
          as estimated_cost_usd_saved
      from ${translationMemoryReuseEvents}
      where project_id = ${projectId}
    `);
    const totals = (totalsResult.rows[0] ?? {}) as Record<string, unknown>;

    const recentEventsResult = await this.db.execute(sql`
      select
        reuse_event_id,
        locale_branch_id,
        target_bridge_unit_id,
        memory_segment_id,
        match_kind,
        match_score,
        reuse_status,
        source_hash,
        candidate_source_hash,
        target_text,
        cost_impact,
        provenance,
        created_at
      from ${translationMemoryReuseEvents}
      where project_id = ${projectId}
      order by created_at desc, reuse_event_id desc
      limit 20
    `);

    return {
      reuseEventCount: Number(totals.reuse_event_count ?? 0),
      appliedCount: Number(totals.applied_count ?? 0),
      suggestedCount: Number(totals.suggested_count ?? 0),
      providerCallAvoidedCount: Number(totals.provider_call_avoided_count ?? 0),
      estimatedPromptTokensSaved: Number(totals.estimated_prompt_tokens_saved ?? 0),
      estimatedCompletionTokensSaved: Number(totals.estimated_completion_tokens_saved ?? 0),
      estimatedTotalTokensSaved: Number(totals.estimated_total_tokens_saved ?? 0),
      estimatedCostUsdSaved:
        totals.estimated_cost_usd_saved === null || totals.estimated_cost_usd_saved === undefined
          ? null
          : Number(totals.estimated_cost_usd_saved),
      recentEvents: (recentEventsResult.rows as Array<Record<string, unknown>>).map(
        translationMemoryReuseFromRow,
      ),
    };
  }

  private async getProviderRunCostSummary(
    projectId: string,
    providerRunId: string,
  ): Promise<ProviderRunCostSummary | undefined> {
    const result = await this.db.execute(sql`
      select
        pr.provider_run_id,
        pr.task_kind,
        pr.status,
        pr.started_at,
        pr.structured_output_mode,
        pr.retry_count,
        pr.error_classes,
        mp.provider_family,
        mp.endpoint_family,
        mp.provider_name,
        pr.requested_model_id,
        pr.actual_model_id,
        pr.upstream_provider,
        pr.route_settings_hash,
        pr.prompt_preset_id,
        pr.prompt_template_version,
        pr.prompt_hash,
        pr.fallback_used,
        pr.fallback_plan,
        cle.cost_kind,
        cle.amount_micros_usd::text as amount_micros_usd,
        cle.token_count_source,
        cle.prompt_tokens,
        cle.completion_tokens,
        cle.reasoning_tokens,
        cle.cached_input_tokens,
        cle.total_tokens,
        pr.data_handling,
        pr.account_privacy
      from ${providerRuns} pr
      join ${modelProviders} mp on mp.provider_id = pr.provider_id
      join ${costLedgerEntries} cle on cle.provider_run_id = pr.provider_run_id
      where pr.project_id = ${projectId}
        and pr.provider_run_id = ${providerRunId}
      limit 1
    `);
    const first = result.rows[0] as Record<string, unknown> | undefined;
    return first ? runFromRow(first) : undefined;
  }

  private async latestProjectId(): Promise<string> {
    const result = await this.db.execute(sql`
      select project_id
      from ${projects}
      order by updated_at desc
      limit 1
    `);
    const first = result.rows[0] as Record<string, unknown> | undefined;
    if (!first) {
      throw new Error("no Itotori project state found");
    }
    return String(first.project_id);
  }
}

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
      dataHandling: input.dataHandling,
      accountPrivacy: input.accountPrivacy ?? null,
      metadata: {},
    })
    .onConflictDoUpdate({
      target: modelProviders.providerId,
      set: {
        providerFamily: input.provider.providerFamily,
        endpointFamily: input.provider.endpointFamily,
        providerName: input.provider.providerName,
        dataHandling: input.dataHandling,
        accountPrivacy: input.accountPrivacy ?? null,
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
    dataHandling: input.dataHandling,
    accountPrivacy: input.accountPrivacy ?? null,
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

function assertProviderRunLedgerInput(input: ProviderRunLedgerInput): void {
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
  assertJsonRecord(input.dataHandling, "dataHandling");
  if (input.accountPrivacy !== undefined) {
    assertJsonRecord(input.accountPrivacy, "accountPrivacy");
  }
  if (!costKinds.includes(input.cost.costKind)) {
    throw new Error(`unsupported cost kind: ${input.cost.costKind}`);
  }
  if (input.cost.currency !== "USD") {
    throw new Error(`unsupported cost currency: ${input.cost.currency}`);
  }
  amountForCost(input.cost);
}

function amountForCost(cost: ProviderRunLedgerInput["cost"]): number | null {
  if (cost.costKind === providerCostKindValues.unknown) {
    if (cost.amountMicrosUsd !== undefined) {
      throw new Error("unknown cost entries must not include amountMicrosUsd");
    }
    return null;
  }
  if (cost.costKind === providerCostKindValues.zero) {
    if (cost.amountMicrosUsd !== undefined && cost.amountMicrosUsd !== 0) {
      throw new Error("zero cost entries must use amountMicrosUsd 0");
    }
    return 0;
  }
  if (cost.amountMicrosUsd === undefined) {
    throw new Error(`${cost.costKind} cost entries require amountMicrosUsd`);
  }
  if (!Number.isFinite(cost.amountMicrosUsd) || cost.amountMicrosUsd < 0) {
    throw new Error("amountMicrosUsd must be a non-negative finite number");
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

function asCostKind(value: unknown): ProviderCostKind {
  if (typeof value === "string" && costKinds.includes(value as ProviderCostKind)) {
    return value as ProviderCostKind;
  }
  throw new Error(`unknown cost kind in ledger: ${String(value)}`);
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

function runFromRow(row: Record<string, unknown>): ProviderRunCostSummary {
  return {
    providerRunId: String(row.provider_run_id),
    taskKind: String(row.task_kind),
    status: String(row.status),
    startedAt:
      row.started_at instanceof Date ? row.started_at.toISOString() : String(row.started_at),
    structuredOutputMode: String(row.structured_output_mode),
    retryCount: Number(row.retry_count ?? 0),
    errorClasses: stringArray(row.error_classes),
    providerFamily: String(row.provider_family),
    endpointFamily: String(row.endpoint_family),
    providerName: String(row.provider_name),
    requestedModelId: String(row.requested_model_id),
    actualModelId: String(row.actual_model_id),
    upstreamProvider: nullableString(row.upstream_provider),
    routeSettingsHash: nullableString(row.route_settings_hash),
    promptPresetId: String(row.prompt_preset_id),
    promptTemplateVersion: String(row.prompt_template_version),
    promptHash: String(row.prompt_hash),
    fallbackUsed: row.fallback_used === true,
    fallbackPlan: stringArray(row.fallback_plan),
    costKind: asCostKind(row.cost_kind),
    amountMicrosUsd: nullableNumber(row.amount_micros_usd),
    tokenCountSource: String(row.token_count_source),
    promptTokens: nullableNumber(row.prompt_tokens),
    completionTokens: nullableNumber(row.completion_tokens),
    reasoningTokens: nullableNumber(row.reasoning_tokens),
    cachedInputTokens: nullableNumber(row.cached_input_tokens),
    totalTokens: nullableNumber(row.total_tokens),
    dataHandling: recordOrEmpty(row.data_handling),
    accountPrivacy: nullableRecord(row.account_privacy),
  };
}

function translationMemoryReuseFromRow(
  row: Record<string, unknown>,
): TranslationMemoryReuseCostSummary {
  const costImpact = recordOrEmpty(row.cost_impact);
  return {
    reuseEventId: String(row.reuse_event_id),
    localeBranchId: String(row.locale_branch_id),
    targetBridgeUnitId: String(row.target_bridge_unit_id),
    memorySegmentId: String(row.memory_segment_id),
    matchKind: String(row.match_kind),
    matchScore: Number(row.match_score),
    reuseStatus: String(row.reuse_status),
    sourceHash: String(row.source_hash),
    candidateSourceHash: String(row.candidate_source_hash),
    targetText: String(row.target_text),
    providerCallAvoided: costImpact.providerCallAvoided === true,
    estimatedPromptTokensSaved: Number(costImpact.estimatedPromptTokensSaved ?? 0),
    estimatedCompletionTokensSaved: Number(costImpact.estimatedCompletionTokensSaved ?? 0),
    estimatedTotalTokensSaved: Number(costImpact.estimatedTotalTokensSaved ?? 0),
    estimatedCostUsdSaved: nullableNumber(costImpact.estimatedCostUsdSaved),
    calculation: String(costImpact.calculation ?? "unknown"),
    provenance: recordOrEmpty(row.provenance),
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(String);
}

function recordOrEmpty(value: unknown): LedgerJsonRecord {
  if (value === null || value === undefined || Array.isArray(value) || typeof value !== "object") {
    return {};
  }
  return value as LedgerJsonRecord;
}

function nullableRecord(value: unknown): LedgerJsonRecord | null {
  if (value === null || value === undefined) {
    return null;
  }
  return recordOrEmpty(value);
}

function zeroBreakdown(costKind: ProviderCostKind): CostKindBreakdown {
  return {
    costKind,
    runCount: 0,
    amountMicrosUsd: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
}
