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
    amountMicrosUsd: number;
    pricingSnapshotId?: string;
  };
  /**
   * ITOTORI-230 — the OpenRouter routing posture sent on the wire for
   * this call. Required (non-null) at the storage layer post-migration
   * 0040; the corresponding typed shape in app code is
   * `OpenRouterRoutingPosture`. The structural assertion is "JSON
   * object"; the app layer guarantees the full posture shape.
   */
  routingPosture: LedgerJsonRecord;
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
  // ITOTORI-225 — non-null after migration 0039: every row in the
  // narrowed `'billed' | 'zero'` enum carries a real amount (zero entries
  // store 0 explicitly). Read paths can rely on this without a null check.
  amountMicrosUsd: number;
  tokenCountSource: string;
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  cachedInputTokens: number | null;
  totalTokens: number | null;
  // ITOTORI-230 — captured OpenRouter routing posture for THIS run.
  // Always present post-migration 0040: pre-migration rows carry the
  // sentinel `{"_pre_itotori_230": true}` so downstream consumers can
  // tell them apart from real captured postures.
  routingPosture: LedgerJsonRecord;
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

/**
 * ITOTORI-225 — `estimatedMicrosUsd`, `unknownRunCount`, and
 * `includesUnknownCost` are deleted. The narrowed cost enum has only
 * billed-or-zero, so estimated/unknown buckets are meaningless. Cost-cap
 * + audit consumers that previously read `estimatedMicrosUsd` should read
 * `billedMicrosUsd` directly.
 */
export type ProjectCostReport = {
  projectId: string;
  currency: "USD";
  runCount: number;
  billedMicrosUsd: number;
  zeroRunCount: number;
  totalsByCostKind: CostKindBreakdown[];
  recentRuns: ProviderRunCostSummary[];
  translationMemoryReuse: TranslationMemoryReuseCostReport;
};

/**
 * ITOTORI-230 — per-(modelId, providerId) counts split by whether the
 * captured routing posture had `zdr = true` on the wire. The query
 * filters on `routing_posture->>'zdr' = 'true'` so the
 * pre-ITOTORI-230 sentinel rows
 * (`routing_posture = '{"_pre_itotori_230": true}'`) do NOT count as
 * ZDR-enforced — which is correct: there is no evidence for those.
 */
export type ProviderRunZdrCountRow = {
  modelId: string;
  providerId: string;
  invocationCount: number;
  zdrEnforcedCount: number;
};

export type ProviderRunZdrCountWindow = {
  readonly from: Date;
  readonly to: Date;
};

export type ProviderRunCostKindCountRow = {
  modelId: string;
  providerId: string;
  costKind: ProviderCostKind;
  invocationCount: number;
  amountMicrosUsd: number;
};

export type ProviderRunCostKindCountWindow = {
  readonly from: Date;
  readonly to: Date;
};

/**
 * ITOTORI-053 — cost-drilldown query filters. Every axis is optional and
 * ANDed together. `projectId` defaults to the latest project when omitted
 * (same posture as the project cost report). `systemId` scopes to a single
 * engine/system id (`provider_runs.system_id`). `from`/`to` bound the
 * `started_at` window (inclusive). `limit`/`offset` drive DETERMINISTIC
 * offset pagination; the row order is a stable `(started_at desc,
 * provider_run_id desc)` so a given (filter, limit, offset) always returns
 * the same page.
 */
export type CostDrilldownFilter = {
  projectId?: string;
  systemId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
};

/**
 * ITOTORI-053 — the DISTINCT cost display states for a drilldown row. This
 * deliberately does NOT reuse a `costKind` field with an `"unknown"` value:
 * `"unknown"` is the deleted legacy ledger enum (ITOTORI-225,
 * audit-no-hardcoded-cost.mjs forbids reviving it). Here `state` is a
 * SEPARATE display axis:
 *   - `billed` — a real cost ledger entry tagged `billed`; `amountMicrosUsd`
 *     is the ledger-stored micros (the SOURCE OF TRUTH for this row) and
 *     `displayAmountUsd` a micros-DERIVED decimal display string.
 *   - `zero` — a real cost ledger entry tagged `zero` (an explicit $0.00
 *     billed record: `amountMicrosUsd === 0`, `displayAmountUsd === "0"`).
 *   - `unknown` — the provider run has NO recorded cost (no cost ledger
 *     entry, or an entry whose amount is NULL): the cost is UNRECORDED.
 *     This is structurally distinct from `zero` and is NEVER collapsed to 0.
 *
 * COST-FIDELITY NOTE (codex-audit-fix): the provider-run cost ledger
 * (`itotori_cost_ledger_entries`) persists INTEGER MICROS ONLY; the
 * full-precision `ProviderCost.amountUsd` decimal lives on the recording
 * path (`itotori_draft_attempt_provider_ledger.cost_amount`), NOT on the
 * rows this drilldown reads. `displayAmountUsd` here is therefore NOT the
 * canonical `amountUsd` — it is a LOSSY micros-derived display field
 * (`microsToDecimalUsd(amountMicrosUsd)`). It MUST NOT be named `amountUsd`
 * (which the rest of the codebase reserves for the authoritative
 * full-precision decimal): presenting a micros-rounded value under the
 * canonical name would imply a fidelity the ledger does not have (e.g. a
 * true `0.00000602` cost shows `0.000006` here — micros-rounded). The
 * integer `amountMicrosUsd` is the honest source of truth for this row.
 */
export type CostDrilldownRowCost =
  | { state: "billed"; amountMicrosUsd: number; displayAmountUsd: string }
  | { state: "zero"; amountMicrosUsd: 0; displayAmountUsd: "0" }
  | { state: "unknown" };

/**
 * ITOTORI-053 — the provider/adapter identity + adapter metadata exposed for
 * a drilldown row. This surfaces the (model, provider) pair and the curated
 * adapter metadata, but the raw adapter metadata is run through
 * {@link sanitizeAdapterMetadata} first (an ALLOWLIST, not a denylist) so only
 * known-safe adapter fields surface — a raw provider request/response payload
 * or any unknown key can never leak through the drilldown (privacy).
 */
export type CostDrilldownProviderMetadata = {
  providerId: string;
  providerFamily: string;
  endpointFamily: string;
  providerName: string;
  requestedModelId: string;
  actualModelId: string;
  upstreamProvider: string | null;
  routeSettingsHash: string | null;
  adapterMetadata: LedgerJsonRecord;
};

export type CostDrilldownRow = {
  providerRunId: string;
  projectId: string;
  systemId: string | null;
  taskKind: string;
  status: string;
  startedAt: string;
  cost: CostDrilldownRowCost;
  provider: CostDrilldownProviderMetadata;
};

export type CostDrilldownPagination = {
  total: number;
  limit: number;
  offset: number;
  /** 1-based page index derived from offset/limit. */
  page: number;
  /** total number of pages for `total` at `limit`. */
  pageCount: number;
  hasMore: boolean;
  /** the offset of the next page, or null when there is no next page. */
  nextOffset: number | null;
};

export type CostDrilldownAppliedFilter = {
  projectId: string;
  systemId: string | null;
  from: string | null;
  to: string | null;
};

export type CostDrilldownPage = {
  filter: CostDrilldownAppliedFilter;
  pagination: CostDrilldownPagination;
  rows: CostDrilldownRow[];
};

export const COST_DRILLDOWN_DEFAULT_LIMIT = 20;
export const COST_DRILLDOWN_MAX_LIMIT = 100;

export interface ItotoriModelLedgerRepositoryPort {
  recordProviderRun(
    actor: AuthorizationActor,
    input: ProviderRunLedgerInput,
  ): Promise<ProviderRunCostSummary>;
  /**
   * gate-project-status-and-cost-reads — the privileged cost report read.
   * Requires the actor to hold the project/ledger read permission
   * (`catalog.read`, the same gate the sibling `count*ByPair` ledger reads
   * use). The report exposes provider/model/routing internals, the run
   * ledger, and translation-memory targetText, so it is never returned to
   * an unprivileged caller.
   */
  getProjectCostReport(actor: AuthorizationActor, projectId?: string): Promise<ProjectCostReport>;
  /**
   * ITOTORI-053 — the paginated cost-drilldown read. Same privilege gate as
   * {@link getProjectCostReport} (`catalog.read`): the rows expose the run
   * ledger + provider/adapter metadata. Filters by project, system, and time
   * with DETERMINISTIC offset pagination (stable ordering + total/page
   * metadata). Provider-run rows with no recorded cost surface as
   * `cost.state === "unknown"` (never collapsed to zero), and each row's
   * adapter metadata is sanitized so no raw provider payload leaks.
   */
  getCostLedgerDrilldown(
    actor: AuthorizationActor,
    filter?: CostDrilldownFilter,
  ): Promise<CostDrilldownPage>;
  /**
   * ITOTORI-230 — count provider runs per (modelId, providerId) over
   * the window, split by whether the captured routing posture has
   * `zdr = true`. Used by `apps/itotori/src/telemetry/queries.ts
   * countZdrEnforcedCallsByPair` to surface the ZDR-enforcement axis
   * the 2026-06-25 wiring audit asked for.
   */
  countZdrEnforcedByPair(
    actor: AuthorizationActor,
    projectId: string,
    window: ProviderRunZdrCountWindow,
  ): Promise<ProviderRunZdrCountRow[]>;
  /**
   * UTSUSHI-231 — count provider runs per (modelId, providerId,
   * costKind) over the same post-run telemetry window. The alpha
   * closer must prove every live invocation was billed, so the
   * telemetry-summary artifact needs the raw cost-kind split rather
   * than only the rolled-up USD total.
   */
  countCostKindsByPair(
    actor: AuthorizationActor,
    projectId: string,
    window: ProviderRunCostKindCountWindow,
  ): Promise<ProviderRunCostKindCountRow[]>;
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

  /**
   * gate-project-status-and-cost-reads — the privileged cost report read.
   * Actor-checked HERE (repository layer, where the data is read) so an
   * internal caller with an unprivileged actor cannot bypass the gate.
   * The unchecked assembly lives in `assembleProjectCostReport`, which is
   * NOT part of the port contract and is only consumed same-package by the
   * dashboard-status assembly — whose sensitive fields (recentRuns +
   * translation-memory targetText) are redacted at the API boundary for
   * unprivileged callers.
   */
  async getProjectCostReport(
    actor: AuthorizationActor,
    projectId?: string,
  ): Promise<ProjectCostReport> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    return this.assembleProjectCostReport(projectId);
  }

  async assembleProjectCostReport(projectId?: string): Promise<ProjectCostReport> {
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
        pr.routing_posture
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

    return {
      projectId: targetProjectId,
      currency: "USD",
      runCount: [...byKind.values()].reduce((sum, row) => sum + row.runCount, 0),
      billedMicrosUsd: billed,
      zeroRunCount: byKind.get(providerCostKindValues.zero)?.runCount ?? 0,
      totalsByCostKind: costKinds.map(
        (costKind) => byKind.get(costKind) ?? zeroBreakdown(costKind),
      ),
      recentRuns,
      translationMemoryReuse,
    };
  }

  async getCostLedgerDrilldown(
    actor: AuthorizationActor,
    filter: CostDrilldownFilter = {},
  ): Promise<CostDrilldownPage> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    if (filter.from && filter.to && filter.from.getTime() > filter.to.getTime()) {
      throw new Error("getCostLedgerDrilldown filter.from must not be after filter.to");
    }
    const limit = clampDrilldownLimit(filter.limit);
    const offset = clampDrilldownOffset(filter.offset);
    const targetProjectId = filter.projectId ?? (await this.latestProjectId());
    const systemId = filter.systemId ?? null;
    const from = filter.from ?? null;
    const to = filter.to ?? null;

    const conditions = [sql`pr.project_id = ${targetProjectId}`];
    if (systemId !== null) {
      conditions.push(sql`pr.system_id = ${systemId}`);
    }
    if (from !== null) {
      conditions.push(sql`pr.started_at >= ${from}`);
    }
    if (to !== null) {
      conditions.push(sql`pr.started_at <= ${to}`);
    }
    const whereClause = sql.join(conditions, sql` and `);

    const totalResult = await this.db.execute(sql`
      select count(*)::int as total
      from ${providerRuns} pr
      where ${whereClause}
    `);
    const total = Number((totalResult.rows[0] as Record<string, unknown> | undefined)?.total ?? 0);

    const rowsResult = await this.db.execute(sql`
      select
        pr.provider_run_id,
        pr.project_id,
        pr.system_id,
        pr.task_kind,
        pr.status,
        pr.started_at,
        pr.provider_id,
        pr.requested_model_id,
        pr.actual_model_id,
        pr.upstream_provider,
        pr.route_settings_hash,
        pr.adapter_metadata,
        mp.provider_family,
        mp.endpoint_family,
        mp.provider_name,
        cle.cost_ledger_entry_id,
        cle.cost_kind,
        cle.amount_micros_usd::text as amount_micros_usd
      from ${providerRuns} pr
      join ${modelProviders} mp on mp.provider_id = pr.provider_id
      left join ${costLedgerEntries} cle on cle.provider_run_id = pr.provider_run_id
      where ${whereClause}
      order by pr.started_at desc, pr.provider_run_id desc
      limit ${limit}
      offset ${offset}
    `);

    const rows = (rowsResult.rows as Array<Record<string, unknown>>).map(drilldownRowFromRow);
    const pageCount = total === 0 ? 0 : Math.ceil(total / limit);
    const hasMore = offset + rows.length < total;
    return {
      filter: {
        projectId: targetProjectId,
        systemId,
        from: from === null ? null : from.toISOString(),
        to: to === null ? null : to.toISOString(),
      },
      pagination: {
        total,
        limit,
        offset,
        page: Math.floor(offset / limit) + 1,
        pageCount,
        hasMore,
        nextOffset: hasMore ? offset + limit : null,
      },
      rows,
    };
  }

  /**
   * ITOTORI-230 — count provider runs grouped by
   * (requested_model_id, provider_id), split by whether the captured
   * routing posture has `zdr = true` on the wire. The filter is
   * `routing_posture->>'zdr' = 'true'`; pre-migration sentinel rows
   * (`{"_pre_itotori_230": true}`) do NOT match and are correctly
   * excluded from the ZDR-enforced count.
   */
  async countZdrEnforcedByPair(
    actor: AuthorizationActor,
    projectId: string,
    window: ProviderRunZdrCountWindow,
  ): Promise<ProviderRunZdrCountRow[]> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    if (window.from.getTime() > window.to.getTime()) {
      throw new Error("countZdrEnforcedByPair window.from must not be after window.to");
    }
    const result = await this.db.execute(sql`
      select
        pr.requested_model_id as model_id,
        pr.provider_id,
        count(*)::int as invocation_count,
        count(*) filter (where pr.routing_posture->>'zdr' = 'true')::int as zdr_enforced_count
      from ${providerRuns} pr
      where pr.project_id = ${projectId}
        and pr.started_at >= ${window.from}
        and pr.started_at <= ${window.to}
      group by pr.requested_model_id, pr.provider_id
      order by pr.requested_model_id asc, pr.provider_id asc
    `);
    return (result.rows as Array<Record<string, unknown>>).map((row) => ({
      modelId: String(row.model_id),
      providerId: String(row.provider_id),
      invocationCount: Number(row.invocation_count ?? 0),
      zdrEnforcedCount: Number(row.zdr_enforced_count ?? 0),
    }));
  }

  async countCostKindsByPair(
    actor: AuthorizationActor,
    projectId: string,
    window: ProviderRunCostKindCountWindow,
  ): Promise<ProviderRunCostKindCountRow[]> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    if (window.from.getTime() > window.to.getTime()) {
      throw new Error("countCostKindsByPair window.from must not be after window.to");
    }
    const result = await this.db.execute(sql`
      select
        pr.requested_model_id as model_id,
        pr.provider_id,
        cle.cost_kind,
        count(*)::int as invocation_count,
        coalesce(sum(cle.amount_micros_usd), 0)::text as amount_micros_usd
      from ${providerRuns} pr
      join ${costLedgerEntries} cle on cle.provider_run_id = pr.provider_run_id
      where pr.project_id = ${projectId}
        and pr.started_at >= ${window.from}
        and pr.started_at <= ${window.to}
      group by pr.requested_model_id, pr.provider_id, cle.cost_kind
      order by pr.requested_model_id asc, pr.provider_id asc, cle.cost_kind asc
    `);
    return (result.rows as Array<Record<string, unknown>>).map((row) => ({
      modelId: String(row.model_id),
      providerId: String(row.provider_id),
      costKind: asCostKind(row.cost_kind),
      invocationCount: Number(row.invocation_count ?? 0),
      amountMicrosUsd: Number(row.amount_micros_usd ?? 0),
    }));
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
        pr.routing_posture
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
  // ITOTORI-225 — costKind is `'billed' | 'zero'` and amountMicrosUsd is
  // required. Zero rows must carry exactly 0; billed rows must carry a
  // non-negative finite number. The migration's CHECK constraint enforces
  // the same shape at the storage layer.
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

function clampDrilldownLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return COST_DRILLDOWN_DEFAULT_LIMIT;
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("getCostLedgerDrilldown limit must be a positive integer");
  }
  return Math.min(limit, COST_DRILLDOWN_MAX_LIMIT);
}

function clampDrilldownOffset(offset: number | undefined): number {
  if (offset === undefined) {
    return 0;
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error("getCostLedgerDrilldown offset must be a non-negative integer");
  }
  return offset;
}

/**
 * ITOTORI-053 — losslessly re-express integer micros-USD as a canonical
 * decimal-USD string (trailing-zero-trimmed): `2180 -> "0.00218"`,
 * `1500000 -> "1.5"`, `0 -> "0"`. This is the FAITHFUL decimal form of the
 * value the cost ledger actually stores (integer micros); it never adds
 * precision beyond the stored micros. Not a hardcoded literal — it is
 * computed from the ledger row. Surfaced as `displayAmountUsd` (NOT
 * `amountUsd`) on the drilldown row so it does not masquerade as the
 * authoritative full-precision `ProviderCost.amountUsd`.
 */
function microsToDecimalUsd(micros: number): string {
  const whole = Math.trunc(micros / 1_000_000);
  const fractional = String(Math.abs(micros % 1_000_000))
    .padStart(6, "0")
    .replace(/0+$/u, "");
  return fractional.length > 0 ? `${whole}.${fractional}` : `${whole}`;
}

/**
 * ITOTORI-053 (codex-audit-fix) — the ALLOWLIST of adapter-metadata keys that
 * may surface in the cost drilldown. Arbitrary adapter metadata is stored
 * (project-workflow.ts persists whatever the provider adapter captures), so a
 * DENYLIST of raw-payload keys is the wrong default for a privacy boundary:
 * any raw-payload key NOT in the denylist (`raw_response`, `responseText`,
 * `providerOutput`, `output`, `result`, future wrappers) would leak through.
 * The correct default is an ALLOWLIST: only known-safe adapter/(model,provider)
 * metadata fields surface; everything else is dropped. The allowlist is matched
 * case-insensitively at every nesting depth so a raw body nested inside an
 * otherwise-safe wrapper is still excluded.
 *
 * Curated safe set (populated by the OR adapter + benchmark ingest):
 *   - Top-level adapter metadata: `providerRouting`, `generationId`,
 *     `openrouterMetadata`, `openrouterRouting`, `source`, `routeSettingsHash`.
 *   - Known-safe nested routing keys (providerRouting / openrouterRouting /
 *     routing posture): `order`, `allowFallbacks`, `allow_fallbacks`, `only`,
 *     `data_collection`, `zdr`, `require_parameters`.
 *   - Known-safe openrouterRouting keys: `summary`, `attempt`, `attempts`,
 *     `strategy`.
 */
const ALLOWED_ADAPTER_METADATA_KEYS = new Set(
  [
    "providerRouting",
    "generationId",
    "openrouterMetadata",
    "openrouterRouting",
    "source",
    "routeSettingsHash",
    "order",
    "allowFallbacks",
    "allow_fallbacks",
    "only",
    "data_collection",
    "zdr",
    "require_parameters",
    "summary",
    "attempt",
    "attempts",
    "strategy",
  ].map((key) => key.toLowerCase()),
);

/**
 * ITOTORI-053 (codex-audit-fix) — recursively KEEP only allowlisted
 * adapter-metadata keys so the drilldown exposes ONLY the curated safe set,
 * never an arbitrary or raw-provider-payload field. Non-object values pass
 * through; the allowlist is matched case-insensitively at every nesting
 * depth. This is an ALLOWLIST (default-deny), NOT a denylist: a new or
 * unknown key is dropped unless explicitly listed above.
 */
export function sanitizeAdapterMetadata(value: unknown): LedgerJsonRecord {
  return sanitizeAdapterMetadataValue(recordOrEmpty(value)) as LedgerJsonRecord;
}

function sanitizeAdapterMetadataValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeAdapterMetadataValue);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (!ALLOWED_ADAPTER_METADATA_KEYS.has(key.toLowerCase())) {
        continue;
      }
      out[key] = sanitizeAdapterMetadataValue(entry);
    }
    return out;
  }
  return value;
}

function drilldownCostFromRow(row: Record<string, unknown>): CostDrilldownRowCost {
  const hasEntry = row.cost_ledger_entry_id !== null && row.cost_ledger_entry_id !== undefined;
  const amountRaw = row.amount_micros_usd;
  if (!hasEntry || amountRaw === null || amountRaw === undefined) {
    // No cost ledger entry / NULL amount — the cost is UNRECORDED. NEVER
    // collapse this to zero: it is a distinct display state.
    return { state: "unknown" };
  }
  const costKind = asCostKind(row.cost_kind);
  if (costKind === providerCostKindValues.zero) {
    return { state: "zero", amountMicrosUsd: 0, displayAmountUsd: "0" };
  }
  const amountMicrosUsd = Number(amountRaw);
  return {
    state: "billed",
    amountMicrosUsd,
    // codex-audit-fix: micros-DERIVED display string, NOT the canonical
    // `ProviderCost.amountUsd` (the ledger row stores integer micros only).
    displayAmountUsd: microsToDecimalUsd(amountMicrosUsd),
  };
}

function drilldownRowFromRow(row: Record<string, unknown>): CostDrilldownRow {
  return {
    providerRunId: String(row.provider_run_id),
    projectId: String(row.project_id),
    systemId: nullableString(row.system_id),
    taskKind: String(row.task_kind),
    status: String(row.status),
    startedAt:
      row.started_at instanceof Date ? row.started_at.toISOString() : String(row.started_at),
    cost: drilldownCostFromRow(row),
    provider: {
      providerId: String(row.provider_id),
      providerFamily: String(row.provider_family),
      endpointFamily: String(row.endpoint_family),
      providerName: String(row.provider_name),
      requestedModelId: String(row.requested_model_id),
      actualModelId: String(row.actual_model_id),
      upstreamProvider: nullableString(row.upstream_provider),
      routeSettingsHash: nullableString(row.route_settings_hash),
      adapterMetadata: sanitizeAdapterMetadata(row.adapter_metadata),
    },
  };
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
    // ITOTORI-225 — post-migration the column is always populated.
    amountMicrosUsd: Number(row.amount_micros_usd ?? 0),
    tokenCountSource: String(row.token_count_source),
    promptTokens: nullableNumber(row.prompt_tokens),
    completionTokens: nullableNumber(row.completion_tokens),
    reasoningTokens: nullableNumber(row.reasoning_tokens),
    cachedInputTokens: nullableNumber(row.cached_input_tokens),
    totalTokens: nullableNumber(row.total_tokens),
    routingPosture: recordOrEmpty(row.routing_posture),
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
