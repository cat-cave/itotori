// ITOTORI-223 — live cost / token / latency telemetry per
// (modelId, providerId) pair.
//
// This module declares the typed surface that the dashboard widget,
// the `itotori:telemetry-summary` CLI command, and any cost-budgeting
// caller use to read the draft-attempt provider ledger as per-pair
// summaries. The aggregation key is exactly (modelId, providerId) per
// the standing model+provider pair rule (KAIFUU-176 / ITOTORI-220);
// collapsing back to model alone is an MPP violation and is rejected
// by a contract test in `apps/itotori/test/telemetry-queries.test.ts`.
//
// The interface is intentionally separated from its implementation
// (queries-impl.ts) so callers can mock the surface in unit tests
// without reaching the live database. The implementation is a thin
// wrapper around
// `ItotoriDraftAttemptProviderLedgerRepository.sumByPairAndDay`.

import type { AuthorizationActor } from "@itotori/db";

/**
 * Window over which telemetry is aggregated. Both bounds are inclusive
 * at the ledger row's `created_at` column. The query layer rejects a
 * window where `from` is after `to` (delegating that validation to the
 * repository).
 */
export type TelemetryWindow = {
  readonly from: Date;
  readonly to: Date;
};

/**
 * Per-(model, providerId) summary row. The fields cover the three
 * surfaces the spec calls out for alpha:
 *   - cost: total cost over the window, in the ledger's USD-equivalent
 *     decimal string (no rounding; the column is numeric(20,8))
 *   - tokens: total prompt + completion tokens, useful for cost / token
 *     pair ranking
 *   - latency: avg + p95, the two values the dashboard renders
 *   - invocationCount: row count in the bucket
 *
 * Latency stats are 0 when EVERY ledger row in the bucket has NULL
 * latency. This is the "no measurement" case (e.g. fixture-only rows);
 * we do NOT silently coerce some-NULL+some-real to a partial average —
 * the repository's SQL aggregates over non-NULL rows only, and the
 * count of measured rows IS the invocation count by construction
 * (every live ITOTORI-221 OpenRouter row carries latencyMs).
 */
export type TelemetryPairSummary = {
  readonly totalCostUsd: string;
  readonly totalTokensIn: number;
  readonly totalTokensOut: number;
  readonly avgLatencyMs: number;
  readonly p95LatencyMs: number;
  readonly invocationCount: number;
  /**
   * ITOTORI-233 — number of invocations in the bucket that landed at
   * least one prompt token from cache (i.e. `cache_read_tokens > 0`).
   * The miss case (no cache hit) is `invocationCount - cacheHitCount`.
   */
  readonly cacheHitCount: number;
  /**
   * ITOTORI-233 — SUM of `cache_read_tokens` / `cache_write_tokens`
   * over the bucket. Sourced verbatim from the ledger columns which
   * mirror `usage.prompt_tokens_details` on the originating OR
   * response.
   */
  readonly totalCacheReadTokens: number;
  readonly totalCacheWriteTokens: number;
  /**
   * ITOTORI-233 — SUM of `cache_discount_micros_usd / 1_000_000` over
   * the bucket, formatted as a decimal-USD string for parity with
   * `totalCostUsd`. Real cost only — sourced verbatim from
   * `usage.cost_details.cache_discount`, never derived from token
   * counts × pricing. This is the "how much did caching save us" line
   * the audit's §3 N7 deliverable asked for.
   */
  readonly cacheSavingsUsd: string;
};

/**
 * Key shape for the by-pair record: `${modelId}:${providerId}`. The
 * literal-template type is load-bearing — the contract test asserts
 * that no consumer collapses the key back to model alone.
 *
 * `modelId` is the literal column value when present; the typed
 * sentinel `unknown-model` is used when the row's `model_id` is NULL
 * (legacy / pre-077 entries). The sentinel is deterministic and
 * documented; it is NEVER a silent fallback for a known-but-mismatched
 * pair.
 */
export type TelemetryPairKey = `${string}:${string}`;

export const TELEMETRY_UNKNOWN_MODEL_SENTINEL = "unknown-model" as const;

/**
 * Result of {@link TelemetryQuery.sumByPair}. When `groupByDay` is not
 * requested, `byDay` is undefined.
 */
export type TelemetrySummaryByPair = {
  readonly byPair: Record<TelemetryPairKey, TelemetryPairSummary>;
  readonly totalCostUsd: string;
  /**
   * ITOTORI-233 — total of `cacheSavingsUsd` across every pair in the
   * window. Surfaced as a single line in the CLI dashboard
   * (`cache_savings_usd=<real>`), satisfying the acceptance criterion
   * "apps/itotori/src/telemetry/cli.ts prints cache_savings_usd=<real>
   * for the window".
   */
  readonly cacheSavingsUsd: string;
  readonly byDay?: Record<string, TelemetrySummaryByPair>;
};

/**
 * telemetry-served-provider-breakdown — one row of the served-provider
 * cost split. `servedProvider` is the canonical id (case/whitespace
 * normalized; see `canonicalServedProviderId`) of the REAL upstream
 * provider that OpenRouter served the invocation through
 * (`run.provider.upstreamProvider`), NOT the requested/pinned provider
 * the {@link TelemetrySummaryByPair} byPair keys on. `totalCostUsd` is
 * the SUM of the verbatim real billed `usage.cost` over the invocations
 * served by this provider — never approximated.
 */
export type TelemetryServedProviderRow = {
  readonly servedProvider: string;
  readonly totalCostUsd: string;
  readonly invocationCount: number;
};

/**
 * telemetry-served-provider-breakdown — the served-provider cost split,
 * ADDITIVE to (never a replacement for) {@link TelemetrySummaryByPair}'s
 * requested-pair byPair (which `verify-artifacts.mjs` depends on for its
 * `startsWith` compat). Per the model-provider-pair law ("providers are
 * not equivalent") + the record-the-real-served-provider decision, this
 * surfaces what a single OR-fallback run actually cost per upstream
 * provider when it was served across several (e.g.
 * DigitalOcean + Fireworks). `byServedProvider[k].totalCostUsd` sums to
 * `totalCostUsd` by construction (every invocation contributes to
 * exactly one canonical served-provider bucket).
 */
export type TelemetryServedProviderBreakdown = {
  readonly byServedProvider: Record<string, TelemetryServedProviderRow>;
  readonly totalCostUsd: string;
};

/**
 * Top-k-by-cost result row. `share` is the fraction of total cost
 * over the window, in [0, 1]. When `totalCostUsd` is "0", every
 * `share` value is 0 (we do not divide by zero).
 */
export type TelemetryTopPairRow = {
  readonly pair: TelemetryPairKey;
  readonly totalCostUsd: string;
  readonly share: number;
};

/**
 * Ranking row for provider comparisons. `rankByCost` / `rankByLatency`
 * are 1-indexed dense rankings ordered ascending (cheapest = 1,
 * fastest = 1). `costPerToken` is total cost / total tokens
 * (prompt + completion); `costPerInvocation` is total cost / invocation
 * count. Both fall to 0 when the denominator is 0 — the resulting
 * "rank by 0" is documented as "no measurable cost over the window"
 * and the consumer should display it as such rather than as a
 * sentinel-bearing string.
 */
export type TelemetryPairRanking = {
  readonly pair: TelemetryPairKey;
  readonly costPerToken: number;
  readonly costPerInvocation: number;
  readonly avgLatencyMs: number;
  readonly rankByCost: number;
  readonly rankByLatency: number;
};

/**
 * ITOTORI-230 — per-(modelId, providerId) row split by ZDR-enforcement.
 * `zdrEnforcedCount` is the number of provider runs whose captured
 * routing posture had `zdr=true` on the wire; `invocationCount` is the
 * total over the window. For a healthy alpha pair, the two are equal —
 * the dashboard surfaces the delta so silent partial-coverage anomalies
 * are visible. Pre-migration sentinel rows
 * (`routing_posture = '{"_pre_itotori_230": true}'`) count toward
 * `invocationCount` but NOT `zdrEnforcedCount`: there is no captured
 * evidence, and we refuse to synthesise one.
 */
export type TelemetryZdrEnforcedRow = {
  readonly pair: TelemetryPairKey;
  readonly invocationCount: number;
  readonly zdrEnforcedCount: number;
};

export type TelemetryCostKindRow = {
  readonly pair: TelemetryPairKey;
  readonly costKind: "billed" | "zero";
  readonly invocationCount: number;
  readonly amountMicrosUsd: number;
};

/**
 * ITOTORI-233 — per-(modelId, providerId) cache hit / savings row.
 * `cacheHitCount` is the number of invocations where the response
 * landed at least one prompt token from cache; the miss case is
 * `invocationCount - cacheHitCount`. `cacheSavingsUsd` is the SUM of
 * `cache_discount_micros_usd / 1_000_000` for the pair over the
 * window, sourced verbatim from `usage.cost_details.cache_discount`
 * (NEVER derived from token counts × pricing — the audit's named
 * anti-pattern).
 */
export type TelemetryCacheRow = {
  readonly pair: TelemetryPairKey;
  readonly invocationCount: number;
  readonly cacheHitCount: number;
  readonly totalCacheReadTokens: number;
  readonly totalCacheWriteTokens: number;
  readonly cacheSavingsUsd: string;
};

export type TelemetryQuerySumByPairOptions = {
  readonly groupByDay?: boolean | undefined;
};

/**
 * The read-only telemetry surface for the per-(modelId, providerId)
 * ledger aggregates. All methods require `catalog.read` (enforced by
 * the underlying repository).
 */
export interface TelemetryQuery {
  sumByPair(
    actor: AuthorizationActor,
    projectId: string,
    window: TelemetryWindow,
    opts?: TelemetryQuerySumByPairOptions,
  ): Promise<TelemetrySummaryByPair>;

  topPairsByCost(
    actor: AuthorizationActor,
    projectId: string,
    window: TelemetryWindow,
    k: number,
  ): Promise<TelemetryTopPairRow[]>;

  pairRanking(
    actor: AuthorizationActor,
    projectId: string,
    window: TelemetryWindow,
  ): Promise<TelemetryPairRanking[]>;

  /**
   * ITOTORI-230 — per-(modelId, providerId) ZDR-enforcement counts over
   * the window. Drives the dashboard's "alpha pair: zdrEnforcedCount /
   * invocationCount" widget the 2026-06-25 wiring audit asked for so a
   * partial-coverage anomaly (e.g. a code path that wrote a ledger row
   * without posture) is immediately visible.
   */
  countZdrEnforcedCallsByPair(
    actor: AuthorizationActor,
    projectId: string,
    window: TelemetryWindow,
  ): Promise<TelemetryZdrEnforcedRow[]>;

  /**
   * UTSUSHI-231 — per-(modelId, providerId, costKind) counts over the
   * window. Post-run acceptance requires proving every live invocation
   * used the real billed-cost path, so this surface exposes the raw
   * cost-kind split from the model ledger.
   */
  countCostKindsByPair(
    actor: AuthorizationActor,
    projectId: string,
    window: TelemetryWindow,
  ): Promise<TelemetryCostKindRow[]>;

  /**
   * ITOTORI-233 — per-(modelId, providerId) cache hit / savings count
   * over the window. `cacheHitCount` is the number of rows with
   * `cache_read_tokens > 0`; `cacheSavingsUsd` is the SUM of the
   * verbatim `cache_discount_micros_usd` column, formatted as a
   * decimal-USD string. Rows are returned sorted by pair key for
   * deterministic JSON output.
   *
   * Drives the dashboard's per-pair "cache hits / savings" widget and
   * the CLI's `cache_savings_usd=<real>` line.
   */
  countCacheHitsByPair(
    actor: AuthorizationActor,
    projectId: string,
    window: TelemetryWindow,
  ): Promise<TelemetryCacheRow[]>;
}

/**
 * Build a `${modelId}:${providerId}` key for the per-pair record.
 *
 * Per the (model, providerId) pair rule, both halves are required at
 * the schema level (providerId is NOT NULL post-ITOTORI-220, modelId
 * was nullable for pre-077 rows). When modelId is null, we use
 * {@link TELEMETRY_UNKNOWN_MODEL_SENTINEL} so the key is still a
 * deterministic string — the consumer can detect "unknown model" by
 * checking against the sentinel. We never collapse to providerId
 * alone; the contract test forbids that.
 */
export function buildPairKey(modelId: string | null, providerId: string): TelemetryPairKey {
  const left = modelId ?? TELEMETRY_UNKNOWN_MODEL_SENTINEL;
  return `${left}:${providerId}`;
}
