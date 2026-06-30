// UTSUSHI-231 (second blocker) — telemetry-summary sourced from the
// per-run `provider-run.json` artifacts the localize-project stage
// writes, instead of the DB draft-attempt provider ledger.
//
// WHY a second source instead of wiring DB persistence into the stage:
// the localize-project pipeline is intentionally DB-free — the agentic
// loop is "pure of persistence side effects"
// (apps/itotori/src/orchestrator/agentic-loop.ts) and the live stage
// builds its OpenRouter provider with ONLY a file-artifact recorder
// (LocalProviderRunArtifactRecorder). Every datum telemetry needs is
// already captured verbatim in each `provider-run.json`: the served
// response's billed `usage.cost`, token counts, latency, ZDR routing
// posture, and cost kind. Re-deriving those rows from the artifacts is
// the single, real-evidence source for this path — no DB, no dual
// plumbing.
//
// PAIR IDENTITY: the per-pair key is the canonical PINNED
// (requestedModelId, requestedProviderId) — exactly the pair the DB
// ledger persists (draft-attempt-recorder.ts records `profile.modelId`
// + `identity.requestedProviderId`), the agentic-loop bundle's
// `invocation.pair` carries, and `verify-artifacts.mjs` cross-checks.
// The served upstream provider/model (`run.provider.upstreamProvider` /
// `actualModelId`) and the verbatim `usage.cost` ARE the proof that the
// pinned pair was actually served + billed — that evidence rides along
// in the artifact and is asserted by the verifier's ZDR + billed-cost
// checks. The COST/tokens/latency/cache/ZDR numbers below are sourced
// verbatim from the served response; only the aggregation KEY is the
// pinned identity, so a single (model, providerId) identity stays
// consistent across the whole pipeline.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ProviderRunArtifact, ProviderRunRecord } from "../providers/types.js";
import { assembleTelemetrySummaryOutput, type TelemetrySummaryCliOutput } from "./cli.js";
import {
  buildPairKey,
  type TelemetryCostKindRow,
  type TelemetryPairKey,
  type TelemetryPairSummary,
  type TelemetryServedProviderBreakdown,
  type TelemetryServedProviderRow,
  type TelemetrySummaryByPair,
  type TelemetryZdrEnforcedRow,
} from "./queries.js";

export type ProviderRunArtifactAggregate = {
  readonly summary: TelemetrySummaryByPair;
  readonly zdrRows: TelemetryZdrEnforcedRow[];
  readonly costKindRows: TelemetryCostKindRow[];
  /**
   * telemetry-served-provider-breakdown — real served-provider cost
   * split (additive to `summary.byPair`, which keys on the requested
   * pair). Keyed by canonical served-provider id.
   */
  readonly servedProviderBreakdown: TelemetryServedProviderBreakdown;
  readonly window: { readonly from: Date; readonly to: Date };
};

/**
 * Sentinel served-provider id for invocations whose artifact carries no
 * `run.provider.upstreamProvider` (e.g. a record produced before the
 * served provider was captured). Deterministic and documented — never a
 * silent merge into a real provider's bucket — so the served breakdown
 * still sums to the total billed cost.
 */
export const SERVED_PROVIDER_UNKNOWN_SENTINEL = "unknown-served-provider" as const;

/**
 * Canonicalize a served upstream-provider string to a stable id. OR
 * returns served strings that differ only cosmetically by case and
 * spacing (e.g. "Fireworks" vs "fireworks", "Digital Ocean" vs
 * "DigitalOcean"); collapsing those to one canonical id is what lets a
 * single OR-fallback run that was served across the SAME upstream under
 * two spellings show as one bucket. An absent/blank served string maps
 * to {@link SERVED_PROVIDER_UNKNOWN_SENTINEL}.
 */
export function canonicalServedProviderId(raw: string | undefined | null): string {
  if (raw === undefined || raw === null) return SERVED_PROVIDER_UNKNOWN_SENTINEL;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return SERVED_PROVIDER_UNKNOWN_SENTINEL;
  return trimmed.toLowerCase().replace(/\s+/g, "");
}

type MutableServedAccumulator = {
  invocationCount: number;
  costUsd: number;
};

type MutablePairAccumulator = {
  invocationCount: number;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  latencies: number[];
  cacheHitCount: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheDiscountMicrosUsd: number;
  zdrEnforcedCount: number;
  costKinds: Map<"billed" | "zero", { invocationCount: number; amountMicrosUsd: number }>;
};

/**
 * Read every `<runId>/provider-run.json` under `dir`. Mirrors the
 * layout `LocalProviderRunArtifactRecorder` writes and that
 * verify-artifacts.mjs reads, so the telemetry source and the offline
 * verifier observe an identical artifact set.
 */
export function readProviderRunArtifactsFromDir(dir: string): ProviderRunArtifact[] {
  if (!existsSync(dir)) {
    throw new Error(`provider-run artifacts directory does not exist: ${dir}`);
  }
  const artifacts: ProviderRunArtifact[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const artifactPath = join(dir, entry.name, "provider-run.json");
    if (!existsSync(artifactPath)) continue;
    const parsed = JSON.parse(readFileSync(artifactPath, "utf8")) as ProviderRunArtifact;
    if (parsed.schemaVersion !== "itotori.provider-run.v0") {
      throw new Error(
        `provider-run artifact ${artifactPath} has unsupported schemaVersion ${String(parsed.schemaVersion)}`,
      );
    }
    artifacts.push(parsed);
  }
  return artifacts;
}

/**
 * Real billed cost, sourced verbatim from the served response. Prefers
 * the authoritative full-precision `run.cost.amountUsd` (the verbatim
 * `usage.cost` the ledger persists), falling back to the verbatim
 * `usageResponseJson.cost` when an older artifact omits `amountUsd`.
 * Never derived from token counts × pricing.
 */
function billedAmountUsd(run: ProviderRunRecord): number {
  const cost = run.cost;
  if (typeof cost.amountUsd === "string" && cost.amountUsd.length > 0) {
    return Number(cost.amountUsd);
  }
  const usageCost = (run.usageResponseJson as { cost?: unknown } | undefined)?.cost;
  if (typeof usageCost === "number") {
    return usageCost;
  }
  if (typeof usageCost === "string" && usageCost.length > 0) {
    return Number(usageCost);
  }
  // Final fallback: the rounded micros mirror (only reachable for the
  // 'zero' cost kind, where amountMicrosUsd is exactly 0).
  return cost.amountMicrosUsd / 1_000_000;
}

function emptyAccumulator(): MutablePairAccumulator {
  return {
    invocationCount: 0,
    // Running-sum accumulator zero-init, not a model cost: real billed costs are
    // summed from billedAmountUsd(run) below, read verbatim from usage.cost.
    costUsd: 0, // itotori-225-audit-allow: accumulator zero-init, never a fabricated cost
    tokensIn: 0,
    tokensOut: 0,
    latencies: [],
    cacheHitCount: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheDiscountMicrosUsd: 0,
    zdrEnforcedCount: 0,
    costKinds: new Map(),
  };
}

// percentile_cont(0.95) via linear interpolation — identical semantics
// to the Postgres aggregate the DB-backed telemetry path uses, so both
// telemetry sources report p95 the same way.
function computeP95LinearInterp(latencies: ReadonlyArray<number>): number {
  if (latencies.length === 0) return 0;
  const sorted = [...latencies].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;
  const rank = 0.95 * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower]!;
  const frac = rank - lower;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * frac;
}

/**
 * Aggregate a set of provider-run artifacts into the same per-pair row
 * shapes the DB-backed `TelemetryQuery` returns, keyed by the pinned
 * (requestedModelId, requestedProviderId) pair.
 */
export function aggregateProviderRunArtifacts(
  artifacts: ReadonlyArray<ProviderRunArtifact>,
): ProviderRunArtifactAggregate {
  const byPairAcc = new Map<TelemetryPairKey, MutablePairAccumulator>();
  const byServedAcc = new Map<string, MutableServedAccumulator>();
  let minStartedAt = Number.POSITIVE_INFINITY;
  let maxEndedAt = Number.NEGATIVE_INFINITY;

  for (const artifact of artifacts) {
    const run = artifact.run;
    const provider = run.provider;
    const key = buildPairKey(provider.requestedModelId, provider.requestedProviderId);
    const acc = byPairAcc.get(key) ?? emptyAccumulator();

    const billed = billedAmountUsd(run);

    // telemetry-served-provider-breakdown — bucket the SAME verbatim
    // billed cost by the REAL served upstream provider (canonicalized),
    // additive to the requested-pair byPair below.
    const servedKey = canonicalServedProviderId(provider.upstreamProvider);
    const servedAcc = byServedAcc.get(servedKey) ?? { invocationCount: 0, costUsd: 0 };
    servedAcc.invocationCount += 1;
    servedAcc.costUsd += billed;
    byServedAcc.set(servedKey, servedAcc);

    acc.invocationCount += 1;
    acc.costUsd += billed;
    acc.tokensIn += run.tokenUsage.promptTokens ?? 0;
    acc.tokensOut += run.tokenUsage.completionTokens ?? 0;
    if (typeof run.latencyMs === "number" && Number.isFinite(run.latencyMs)) {
      acc.latencies.push(run.latencyMs);
    }
    const cacheReadTokens = run.tokenUsage.cacheReadTokens ?? 0;
    const cacheWriteTokens = run.tokenUsage.cacheWriteTokens ?? 0;
    if (cacheReadTokens > 0) acc.cacheHitCount += 1;
    acc.cacheReadTokens += cacheReadTokens;
    acc.cacheWriteTokens += cacheWriteTokens;
    acc.cacheDiscountMicrosUsd += run.cost.cacheDiscountMicrosUsd ?? 0;
    if (run.routingPosture.zdr === true) acc.zdrEnforcedCount += 1;

    const costKind = run.cost.costKind;
    const ckBucket = acc.costKinds.get(costKind) ?? { invocationCount: 0, amountMicrosUsd: 0 };
    ckBucket.invocationCount += 1;
    ckBucket.amountMicrosUsd += run.cost.amountMicrosUsd;
    acc.costKinds.set(costKind, ckBucket);

    byPairAcc.set(key, acc);

    const startedMs = Date.parse(run.startedAt);
    if (Number.isFinite(startedMs)) minStartedAt = Math.min(minStartedAt, startedMs);
    const endedMs = Date.parse(run.completedAt);
    if (Number.isFinite(endedMs)) maxEndedAt = Math.max(maxEndedAt, endedMs);
    if (Number.isFinite(startedMs)) maxEndedAt = Math.max(maxEndedAt, startedMs);
  }

  const byPair: Record<TelemetryPairKey, TelemetryPairSummary> = {};
  const zdrRows: TelemetryZdrEnforcedRow[] = [];
  const costKindRows: TelemetryCostKindRow[] = [];
  let totalCostUsd = 0;
  let totalCacheSavingsMicros = 0;

  for (const key of [...byPairAcc.keys()].sort()) {
    const acc = byPairAcc.get(key)!;
    const avgLatencyMs =
      acc.latencies.length === 0
        ? 0
        : acc.latencies.reduce((sum, l) => sum + l, 0) / acc.latencies.length;
    byPair[key] = {
      totalCostUsd: acc.costUsd.toFixed(8),
      totalTokensIn: acc.tokensIn,
      totalTokensOut: acc.tokensOut,
      avgLatencyMs,
      p95LatencyMs: computeP95LinearInterp(acc.latencies),
      invocationCount: acc.invocationCount,
      cacheHitCount: acc.cacheHitCount,
      totalCacheReadTokens: acc.cacheReadTokens,
      totalCacheWriteTokens: acc.cacheWriteTokens,
      cacheSavingsUsd: (acc.cacheDiscountMicrosUsd / 1_000_000).toFixed(8),
    };
    totalCostUsd += acc.costUsd;
    totalCacheSavingsMicros += acc.cacheDiscountMicrosUsd;

    zdrRows.push({
      pair: key,
      invocationCount: acc.invocationCount,
      zdrEnforcedCount: acc.zdrEnforcedCount,
    });
    for (const costKind of [...acc.costKinds.keys()].sort()) {
      const bucket = acc.costKinds.get(costKind)!;
      costKindRows.push({
        pair: key,
        costKind,
        invocationCount: bucket.invocationCount,
        amountMicrosUsd: bucket.amountMicrosUsd,
      });
    }
  }

  const summary: TelemetrySummaryByPair = {
    byPair,
    totalCostUsd: totalCostUsd.toFixed(8),
    cacheSavingsUsd: (totalCacheSavingsMicros / 1_000_000).toFixed(8),
  };

  const byServedProvider: Record<string, TelemetryServedProviderRow> = {};
  let servedTotalCostUsd = 0;
  for (const servedKey of [...byServedAcc.keys()].sort()) {
    const acc = byServedAcc.get(servedKey)!;
    byServedProvider[servedKey] = {
      servedProvider: servedKey,
      totalCostUsd: acc.costUsd.toFixed(8),
      invocationCount: acc.invocationCount,
    };
    servedTotalCostUsd += acc.costUsd;
  }
  const servedProviderBreakdown: TelemetryServedProviderBreakdown = {
    byServedProvider,
    totalCostUsd: servedTotalCostUsd.toFixed(8),
  };

  const fromMs = Number.isFinite(minStartedAt) ? minStartedAt : Date.now();
  const toMs = Number.isFinite(maxEndedAt) ? maxEndedAt : fromMs;
  return {
    summary,
    zdrRows,
    costKindRows,
    servedProviderBreakdown,
    window: { from: new Date(fromMs), to: new Date(toMs) },
  };
}

/**
 * Build the full `TelemetrySummaryCliOutput` (metadata envelope +
 * byPair + postRunEvidence) from a directory of provider-run artifacts.
 * The window defaults to the artifacts' [min startedAt, max completedAt]
 * span so it always covers the recorded invocations; `generatedAt`
 * defaults to now (>= the latest completion), satisfying the verifier's
 * freshness floor.
 */
export function buildTelemetrySummaryFromProviderRunArtifacts(input: {
  readonly projectId: string;
  readonly artifacts: ReadonlyArray<ProviderRunArtifact>;
  readonly from?: Date;
  readonly to?: Date;
  readonly now?: () => Date;
}): TelemetrySummaryCliOutput {
  const aggregate = aggregateProviderRunArtifacts(input.artifacts);
  const from = input.from ?? aggregate.window.from;
  const to = input.to ?? aggregate.window.to;
  const generatedAt = (input.now ?? (() => new Date()))();
  return assembleTelemetrySummaryOutput({
    projectId: input.projectId,
    from,
    to,
    generatedAt,
    summary: aggregate.summary,
    zdrRows: aggregate.zdrRows,
    costKindRows: aggregate.costKindRows,
    servedProviderBreakdown: aggregate.servedProviderBreakdown,
  });
}
