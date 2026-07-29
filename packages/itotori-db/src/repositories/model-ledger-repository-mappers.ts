import { providerCostKindValues, type ProviderCostKind } from "../schema.js";
import type {
  CostDrilldownRow,
  CostDrilldownRowCost,
  CostKindBreakdown,
  LedgerJsonRecord,
  ProviderRunCostSummary,
  TranslationMemoryReuseCostSummary,
} from "./model-ledger-repository-types.js";
import {
  COST_DRILLDOWN_DEFAULT_LIMIT,
  COST_DRILLDOWN_MAX_LIMIT,
} from "./model-ledger-repository-types.js";

const costKinds = Object.values(providerCostKindValues) as ProviderCostKind[];

export function asCostKind(value: unknown): ProviderCostKind {
  if (typeof value === "string" && costKinds.includes(value as ProviderCostKind)) {
    return value as ProviderCostKind;
  }
  throw new Error(`unknown cost kind in ledger: ${String(value)}`);
}

export function clampDrilldownLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return COST_DRILLDOWN_DEFAULT_LIMIT;
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("getCostLedgerDrilldown limit must be a positive integer");
  }
  return Math.min(limit, COST_DRILLDOWN_MAX_LIMIT);
}

export function clampDrilldownOffset(offset: number | undefined): number {
  if (offset === undefined) {
    return 0;
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error("getCostLedgerDrilldown offset must be a non-negative integer");
  }
  return offset;
}

/**
 * Losslessly re-express integer micros-USD as a canonical decimal-USD
 * string (trailing-zero-trimmed): `2180 -> "0.00218"`, `1500000 -> "1.5"`,
 * `0 -> "0"`. This is the FAITHFUL decimal form of the value the cost
 * ledger actually stores (integer micros); it never adds precision beyond
 * the stored micros. Not a hardcoded literal — it is computed from the
 * ledger row. Surfaced as `displayAmountUsd` (NOT `amountUsd`) on the
 * drilldown row so it does not masquerade as the authoritative
 * full-precision `ProviderCost.amountUsd`.
 */
function microsToDecimalUsd(micros: number): string {
  const whole = Math.trunc(micros / 1_000_000);
  const fractional = String(Math.abs(micros % 1_000_000))
    .padStart(6, "0")
    .replace(/0+$/u, "");
  return fractional.length > 0 ? `${whole}.${fractional}` : `${whole}`;
}

/**
 * Privacy HARD boundary for the cost drilldown: adapter metadata was
 * recorded VERBATIM from the provider adapter — the retired workflow
 * persisted whatever the adapter captured, and the OpenRouter adapter
 * mirrors the raw `openrouter_metadata` response fragment into
 * `adapterMetadata.openrouterMetadata`. A KEY-ALLOWLIST — even
 * case-insensitive and applied at every depth — is NOT a privacy boundary:
 * it FILTERS an untrusted object, so (a) any raw scalar sitting under a
 * generic allowlisted key (`source`, `summary`) at ANY depth leaks, and
 * (b) any raw body reachable through an allowlisted wrapper leaks.
 *
 * This sanitizer is default-deny BY CONSTRUCTION: it never filters the
 * untrusted object — it PROJECTS a fixed set of known-safe fields into a NEW
 * object, CONTEXT-AWARE by parent. A field is only surfaced under the parent it
 * genuinely belongs to: `source` / `routeSettingsHash` / `generationId` are
 * top-level only; the routing-posture fields only under `providerRouting`;
 * `summary` only under `openrouterRouting`. There is no global key allowlist,
 * so a raw-payload key (`choices`, `messages`, `response`, `body`, a renamed
 * wrapper) can never surface at any depth — it is simply never projected.
 *
 * `openrouterMetadata` is NEVER mirrored wholesale: only its known-safe scalar
 * observability fields are projected (requested model, strategy, attempt(s),
 * summary, cost, and the SELECTED endpoint's scalar provider/model). The raw
 * `endpoints.available[]` / `choices` / `messages` / body fragments are dropped
 * by construction.
 */
type SafeScalar = string | number | boolean;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeScalar(value: unknown): SafeScalar | undefined {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : undefined;
}

function safeScalarArray(value: unknown): SafeScalar[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out = value.map(safeScalar).filter((entry): entry is SafeScalar => entry !== undefined);
  return out.length > 0 ? out : undefined;
}

function assignDefined(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

function undefinedIfEmpty(record: Record<string, unknown>): Record<string, unknown> | undefined {
  return Object.keys(record).length > 0 ? record : undefined;
}

// Known-safe OpenRouter provider-routing posture fields (the wire routing
// preferences captured on the ledger). All are routing posture — never a
// provider payload — so each is projected as a scalar or an array of scalars.
const SAFE_ROUTING_SCALAR_KEYS = [
  "allowFallbacks",
  "allow_fallbacks",
  "data_collection",
  "zdr",
  "require_parameters",
  "sort",
  "enforce_distillable_text",
] as const;
const SAFE_ROUTING_ARRAY_KEYS = ["order", "only", "ignore", "quantizations"] as const;
const SAFE_MAX_PRICE_KEYS = ["prompt", "completion", "request", "image"] as const;
// Known-safe per-attempt fallback-observability fields (openrouter_metadata
// `attempts[]`). Scalar only — never a nested body.
const SAFE_ATTEMPT_KEYS = [
  "provider",
  "model",
  "endpoint",
  "status",
  "reason",
  "attempt",
  "cost",
] as const;

function projectMaxPrice(value: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const key of SAFE_MAX_PRICE_KEYS) {
    assignDefined(out, key, safeScalar(value[key]));
  }
  return undefinedIfEmpty(out);
}

function projectProviderRouting(value: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const key of SAFE_ROUTING_SCALAR_KEYS) {
    assignDefined(out, key, safeScalar(value[key]));
  }
  for (const key of SAFE_ROUTING_ARRAY_KEYS) {
    assignDefined(out, key, safeScalarArray(value[key]));
  }
  assignDefined(out, "max_price", projectMaxPrice(value.max_price));
  return undefinedIfEmpty(out);
}

function projectAttempts(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out = value
    .map((entry): unknown => {
      const scalar = safeScalar(entry);
      if (scalar !== undefined) {
        return scalar;
      }
      if (isPlainObject(entry)) {
        const projected: Record<string, unknown> = {};
        for (const key of SAFE_ATTEMPT_KEYS) {
          assignDefined(projected, key, safeScalar(entry[key]));
        }
        return undefinedIfEmpty(projected);
      }
      return undefined;
    })
    .filter((entry): entry is unknown => entry !== undefined);
  return out.length > 0 ? out : undefined;
}

function projectOpenrouterRouting(value: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  assignDefined(out, "summary", safeScalar(value.summary));
  assignDefined(out, "strategy", safeScalar(value.strategy));
  assignDefined(out, "attempt", safeScalar(value.attempt));
  assignDefined(out, "attempts", projectAttempts(value.attempts));
  return undefinedIfEmpty(out);
}

function projectSelectedEndpoint(value: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(value) || !Array.isArray(value.available)) {
    return undefined;
  }
  const selected = value.available.find(
    (endpoint) => isPlainObject(endpoint) && endpoint.selected === true,
  );
  if (!isPlainObject(selected)) {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  assignDefined(out, "provider", safeScalar(selected.provider));
  assignDefined(out, "model", safeScalar(selected.model));
  return undefinedIfEmpty(out);
}

function projectOpenrouterMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  assignDefined(out, "requested", safeScalar(value.requested));
  assignDefined(out, "strategy", safeScalar(value.strategy));
  assignDefined(out, "attempt", safeScalar(value.attempt));
  assignDefined(out, "summary", safeScalar(value.summary));
  assignDefined(out, "cost", safeScalar(value.cost));
  assignDefined(out, "id", safeScalar(value.id));
  assignDefined(out, "attempts", projectAttempts(value.attempts));
  // Served route identity — ONLY the selected endpoint's scalar provider/model,
  // never the raw `endpoints.available[]` structure.
  assignDefined(out, "servedRoute", projectSelectedEndpoint(value.endpoints));
  return undefinedIfEmpty(out);
}

/**
 * Build the drilldown adapter-metadata view by PROJECTING known-safe
 * fields into a NEW object (default-deny), context-aware by parent.
 * Nothing from the untrusted stored metadata is passed through by key
 * match: only the fields enumerated by the projectors above can appear,
 * so a raw provider body — under `openrouterMetadata`, under a generic
 * `source`/`summary`, or under any nested/renamed wrapper — can never
 * reach the drilldown surface.
 */
export function sanitizeAdapterMetadata(value: unknown): LedgerJsonRecord {
  const raw = recordOrEmpty(value);
  const out: Record<string, unknown> = {};
  assignDefined(out, "providerRouting", projectProviderRouting(raw.providerRouting));
  assignDefined(out, "openrouterRouting", projectOpenrouterRouting(raw.openrouterRouting));
  assignDefined(out, "openrouterMetadata", projectOpenrouterMetadata(raw.openrouterMetadata));
  assignDefined(out, "generationId", safeScalar(raw.generationId));
  assignDefined(out, "source", safeScalar(raw.source));
  assignDefined(out, "routeSettingsHash", safeScalar(raw.routeSettingsHash));
  return out as LedgerJsonRecord;
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

export function drilldownRowFromRow(row: Record<string, unknown>): CostDrilldownRow {
  return {
    providerRunId: String(row.provider_run_id),
    projectId: String(row.project_id),
    systemId: nullableString(row.system_id),
    taskKind: String(row.task_kind),
    status: String(row.status),
    startedAt: timestampToIso(row.started_at),
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

export function runFromRow(row: Record<string, unknown>): ProviderRunCostSummary {
  return {
    providerRunId: String(row.provider_run_id),
    taskKind: String(row.task_kind),
    status: String(row.status),
    startedAt: timestampToIso(row.started_at),
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
    // Post-migration the column is always populated.
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

export function timestampToIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

export function translationMemoryReuseFromRow(
  row: Record<string, unknown>,
): TranslationMemoryReuseCostSummary {
  // Defensive read. `cost_impact` may be a malformed JSON value
  // (non-object, missing keys, wrong scalar type) if the row was inserted
  // OUTSIDE the repository API. We never let a wrong-type numeric (e.g.
  // `"abc"`) leak through as NaN — instead we coerce defensively and mark
  // the row so the caller can render a "malformed" hint instead of a
  // misleading zero. Missing keys are tolerated (coerced to zero / null),
  // matching the SQL-side well-formed predicate.
  const rawCostImpact = row.cost_impact;
  const isCostImpactObject =
    rawCostImpact !== null &&
    rawCostImpact !== undefined &&
    !Array.isArray(rawCostImpact) &&
    typeof rawCostImpact === "object";
  const costImpact = isCostImpactObject ? (rawCostImpact as Record<string, unknown>) : {};
  const malformedByType = (value: unknown, kind: "bool" | "int" | "number"): boolean => {
    if (value === null || value === undefined) return false;
    if (kind === "bool") return typeof value !== "boolean";
    if (kind === "int") {
      return typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value);
    }
    return typeof value !== "number" || !Number.isFinite(value);
  };
  const promptValue = costImpact.estimatedPromptTokensSaved;
  const completionValue = costImpact.estimatedCompletionTokensSaved;
  const totalValue = costImpact.estimatedTotalTokensSaved;
  const usdSavedValue = costImpact.estimatedCostUsdSaved;
  const providerCallValue = costImpact.providerCallAvoided;
  const hasMalformedField =
    !isCostImpactObject ||
    malformedByType(promptValue, "int") ||
    malformedByType(completionValue, "int") ||
    malformedByType(totalValue, "int") ||
    (usdSavedValue !== null &&
      usdSavedValue !== undefined &&
      (typeof usdSavedValue !== "string" || !/^-?\d+(\.\d+)?$/.test(usdSavedValue))) ||
    malformedByType(providerCallValue, "bool");

  const coerceInt = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) ? value : 0;
  const coerceNumber = (value: unknown): number | null => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
    return null;
  };
  const coerceBool = (value: unknown): boolean => value === true;

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
    providerCallAvoided: coerceBool(providerCallValue),
    estimatedPromptTokensSaved: coerceInt(promptValue),
    estimatedCompletionTokensSaved: coerceInt(completionValue),
    estimatedTotalTokensSaved: coerceInt(totalValue),
    estimatedCostUsdSaved: coerceNumber(usdSavedValue),
    calculation: String(costImpact.calculation ?? "unknown"),
    provenance: recordOrEmpty(row.provenance),
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    malformedCostImpact: hasMalformedField,
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

export function zeroBreakdown(costKind: ProviderCostKind): CostKindBreakdown {
  return {
    costKind,
    runCount: 0,
    amountMicrosUsd: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
}
