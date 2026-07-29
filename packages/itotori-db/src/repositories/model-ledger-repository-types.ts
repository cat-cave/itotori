import type { BenchmarkTokenCountSourceV02 } from "@itotori/localization-bridge-schema";
import type { AuthorizationActor } from "../authorization.js";
import type { ItotoriDatabase } from "../connection.js";
import type { ProviderCostKind, ProviderRunStatus } from "../schema.js";
import type { TranslationMemoryDiagnostic } from "./translation-memory-repository.js";

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
   * OpenRouter routing posture sent on the wire for this call. Required
   * (non-null) at the storage layer post-migration 0040; the corresponding
   * typed shape in app code is `OpenRouterRoutingPosture`. The structural
   * assertion is "JSON object"; the app layer guarantees the full posture
   * shape.
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
  // Non-null after migration 0039: every row in the narrowed
  // `'billed' | 'zero'` enum carries a real amount (zero entries store 0
  // explicitly). Read paths can rely on this without a null check.
  amountMicrosUsd: number;
  tokenCountSource: string;
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  cachedInputTokens: number | null;
  totalTokens: number | null;
  // Captured OpenRouter routing posture for THIS run. Always present
  // post-migration 0040: pre-migration rows carry the sentinel
  // `{"_pre_itotori_230": true}` so downstream consumers can tell them
  // apart from real captured postures.
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
  /**
   * True when this row's stored `cost_impact` JSON does not match the
   * well-formed shape the aggregation reads. The numeric / boolean fields
   * above are defensively coerced to zero / false in that case so the row
   * never blows up downstream consumers; consumers can use this flag to
   * render a "malformed cost_impact" hint instead of the zeroed numbers.
   */
  malformedCostImpact: boolean;
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
  /**
   * Number of reuse events for this project whose stored `cost_impact`
   * JSON does NOT match the well-formed shape the aggregation reads
   * (`providerCallAvoided` boolean, `estimated*TokensSaved` /
   * `estimatedCostUsdSaved` numeric). The repository API only ever writes
   * well-formed rows, so any non-zero count here means a row was inserted
   * OUTSIDE the repository (e.g. a raw SQL backfill, a historical pre-fix
   * row). The aggregation MUST remain available — the malformed rows are
   * skipped from the numeric sums and counted here so callers can surface
   * a diagnostic and choose to repair them.
   */
  malformedCostImpactCount: number;
  /**
   * Diagnostics describing the malformed rows so callers can surface a
   * clear, actionable message without re-running the read. Empty when
   * `malformedCostImpactCount === 0`.
   */
  diagnostics: TranslationMemoryDiagnostic[];
};

/**
 * `estimatedMicrosUsd`, `unknownRunCount`, and `includesUnknownCost` are
 * deleted. The narrowed cost enum has only billed-or-zero, so estimated/
 * unknown buckets are meaningless. Cost-cap + audit consumers that
 * previously read `estimatedMicrosUsd` should read `billedMicrosUsd`
 * directly.
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

export type ProjectTelemetryTimeseriesBucket = {
  bucketStart: string;
  runCount: number;
  billedMicrosUsd: number;
  costPerRunMicrosUsd: number;
};

export type ProjectTelemetryTimeseries = {
  projectId: string;
  bucket: "day";
  rows: ProjectTelemetryTimeseriesBucket[];
  throughputSeries: number[];
  costPerRunSeries: number[];
};

/**
 * Per-(modelId, providerId) counts split by whether the captured routing
 * posture had `zdr = true` on the wire. The query filters on
 * `routing_posture->>'zdr' = 'true'` so the pre-migration sentinel rows
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
 * Cost-drilldown query filters. Every axis is optional and ANDed together.
 * `projectId` defaults to the latest project when omitted (same posture as
 * the project cost report). `systemId` scopes to a single engine/system id
 * (`provider_runs.system_id`). `from`/`to` bound the `started_at` window
 * (inclusive). `limit`/`offset` drive DETERMINISTIC offset pagination; the
 * row order is a stable `(started_at desc, provider_run_id desc)` so a
 * given (filter, limit, offset) always returns the same page.
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
 * The DISTINCT cost display states for a drilldown row. This deliberately
 * does NOT reuse a `costKind` field with an `"unknown"` value: `"unknown"`
 * is the deleted legacy ledger enum (audit-no-hardcoded-cost.mjs forbids
 * reviving it). Here `state` is a SEPARATE display axis:
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
 * path (`itotori_llm_attempts.cost_usd`), NOT on the
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
 * Provider/adapter identity + adapter metadata exposed for a drilldown
 * row. This surfaces the (model, provider) pair and the curated adapter
 * metadata, but the raw adapter metadata is run through
 * {@link sanitizeAdapterMetadata} first (a default-deny PROJECTION of
 * known-safe fields into a new object, context-aware by parent) so only
 * known-safe adapter fields surface — a raw provider request/response
 * payload or any unknown key can never leak through the drilldown
 * (privacy).
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
   * Paginated cost-drilldown read. Same privilege gate as
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
   * ovw-telemetry-sparklines — day-bucketed provider-run throughput and
   * cost-per-run telemetry sourced from provider_runs + cost_ledger_entries.
   * Uses the same privileged ledger-read permission as the cost report because
   * it exposes model-call volume and spend trends.
   */
  getProjectTelemetryTimeseries(
    actor: AuthorizationActor,
    projectId?: string,
  ): Promise<ProjectTelemetryTimeseries>;
  /**
   * Count provider runs per (modelId, providerId) over the window, split
   * by whether the captured routing posture has `zdr = true`. Used by
   * `apps/itotori/src/telemetry/queries.ts countZdrEnforcedCallsByPair`
   * to surface the ZDR-enforcement axis.
   */
  countZdrEnforcedByPair(
    actor: AuthorizationActor,
    projectId: string,
    window: ProviderRunZdrCountWindow,
  ): Promise<ProviderRunZdrCountRow[]>;
  /**
   * Count provider runs per (modelId, providerId, costKind) over the same
   * post-run telemetry window. The alpha closer must prove every live
   * invocation was billed, so the telemetry-summary artifact needs the raw
   * cost-kind split rather than only the rolled-up USD total.
   */
  countCostKindsByPair(
    actor: AuthorizationActor,
    projectId: string,
    window: ProviderRunCostKindCountWindow,
  ): Promise<ProviderRunCostKindCountRow[]>;
}

export type ItotoriLedgerTransaction = Parameters<Parameters<ItotoriDatabase["transaction"]>[0]>[0];
