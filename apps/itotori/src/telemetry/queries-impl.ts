// ITOTORI-223 — implementation of the TelemetryQuery surface against
// the draft-attempt provider ledger.
//
// The implementation is a thin shape-translator on top of the
// repository's `sumByPairAndDay` aggregate. All cost / token / latency
// math happens in SQL; the translator here turns rows into the typed
// shapes (TelemetrySummaryByPair, TelemetryTopPairRow,
// TelemetryPairRanking) the dashboard + CLI render.
//
// The translator is deterministic w.r.t. the row order the repository
// returns: rows are sorted (modelId asc, providerId asc) at the SQL
// level, so the resulting record key iteration order is stable for
// snapshot tests.

import type {
  AuthorizationActor,
  ItotoriDraftAttemptProviderLedgerRepositoryPort,
  LedgerPairAggregateRow,
} from "@itotori/db";
import {
  buildPairKey,
  type TelemetryPairKey,
  type TelemetryPairRanking,
  type TelemetryPairSummary,
  type TelemetryQuery,
  type TelemetryQuerySumByPairOptions,
  type TelemetrySummaryByPair,
  type TelemetryTopPairRow,
  type TelemetryWindow,
} from "./queries.js";

export class TelemetryQueryError extends Error {
  constructor(
    readonly code: "telemetry_query_invalid_input",
    message: string,
  ) {
    super(message);
    this.name = "TelemetryQueryError";
  }
}

export class LedgerTelemetryQuery implements TelemetryQuery {
  constructor(private readonly repository: ItotoriDraftAttemptProviderLedgerRepositoryPort) {}

  async sumByPair(
    actor: AuthorizationActor,
    projectId: string,
    window: TelemetryWindow,
    opts?: TelemetryQuerySumByPairOptions,
  ): Promise<TelemetrySummaryByPair> {
    const groupByDay = opts?.groupByDay === true;
    const ungroupedRows = await this.repository.sumByPairAndDay(actor, projectId, window);
    const summary = summariseRows(ungroupedRows);

    if (!groupByDay) {
      return summary;
    }

    const dailyRows = await this.repository.sumByPairAndDay(actor, projectId, window, {
      groupByDay: true,
    });
    const byDay: Record<string, TelemetrySummaryByPair> = {};
    const dayBuckets = new Map<string, LedgerPairAggregateRow[]>();
    for (const row of dailyRows) {
      if (row.bucketDay === null) {
        // Defensive: groupByDay was requested, so the repo MUST set
        // bucketDay. A null here is a contract violation; we surface
        // a typed error rather than silently dropping the row.
        throw new TelemetryQueryError(
          "telemetry_query_invalid_input",
          "sumByPairAndDay with groupByDay returned a row with null bucketDay",
        );
      }
      const existing = dayBuckets.get(row.bucketDay);
      if (existing === undefined) {
        dayBuckets.set(row.bucketDay, [row]);
      } else {
        existing.push(row);
      }
    }
    const sortedDays = Array.from(dayBuckets.keys()).sort();
    for (const day of sortedDays) {
      const rowsForDay = dayBuckets.get(day);
      if (rowsForDay === undefined) {
        continue;
      }
      byDay[day] = summariseRows(rowsForDay);
    }

    return {
      ...summary,
      byDay,
    };
  }

  async topPairsByCost(
    actor: AuthorizationActor,
    projectId: string,
    window: TelemetryWindow,
    k: number,
  ): Promise<TelemetryTopPairRow[]> {
    if (!Number.isInteger(k) || k < 1) {
      throw new TelemetryQueryError(
        "telemetry_query_invalid_input",
        `topPairsByCost k must be a positive integer (got ${k})`,
      );
    }
    const rows = await this.repository.sumByPairAndDay(actor, projectId, window);
    const summary = summariseRows(rows);
    const total = parseCost(summary.totalCostUsd);

    const entries: Array<{ pair: TelemetryPairKey; cost: number; raw: string }> = [];
    for (const [pair, value] of Object.entries(summary.byPair) as Array<
      [TelemetryPairKey, TelemetryPairSummary]
    >) {
      entries.push({ pair, cost: parseCost(value.totalCostUsd), raw: value.totalCostUsd });
    }
    entries.sort((a, b) => {
      if (b.cost !== a.cost) return b.cost - a.cost;
      return a.pair.localeCompare(b.pair);
    });
    const top = entries.slice(0, k);
    return top.map((entry) => ({
      pair: entry.pair,
      totalCostUsd: entry.raw,
      share: total === 0 ? 0 : entry.cost / total,
    }));
  }

  async pairRanking(
    actor: AuthorizationActor,
    projectId: string,
    window: TelemetryWindow,
  ): Promise<TelemetryPairRanking[]> {
    const rows = await this.repository.sumByPairAndDay(actor, projectId, window);
    const summary = summariseRows(rows);
    const entries: Array<{
      pair: TelemetryPairKey;
      cost: number;
      tokens: number;
      invocations: number;
      avgLatencyMs: number;
    }> = [];
    for (const [pair, value] of Object.entries(summary.byPair) as Array<
      [TelemetryPairKey, TelemetryPairSummary]
    >) {
      entries.push({
        pair,
        cost: parseCost(value.totalCostUsd),
        tokens: value.totalTokensIn + value.totalTokensOut,
        invocations: value.invocationCount,
        avgLatencyMs: value.avgLatencyMs,
      });
    }

    // Stable deterministic ranking: ascending cost-per-token; ties
    // broken by pair name (lexicographic). Same for latency ranking.
    const byCost = [...entries].sort((a, b) => {
      const cpta = a.tokens === 0 ? 0 : a.cost / a.tokens;
      const cptb = b.tokens === 0 ? 0 : b.cost / b.tokens;
      if (cpta !== cptb) return cpta - cptb;
      return a.pair.localeCompare(b.pair);
    });
    const byLatency = [...entries].sort((a, b) => {
      if (a.avgLatencyMs !== b.avgLatencyMs) return a.avgLatencyMs - b.avgLatencyMs;
      return a.pair.localeCompare(b.pair);
    });
    const rankByCost = new Map<TelemetryPairKey, number>();
    byCost.forEach((entry, idx) => rankByCost.set(entry.pair, idx + 1));
    const rankByLatency = new Map<TelemetryPairKey, number>();
    byLatency.forEach((entry, idx) => rankByLatency.set(entry.pair, idx + 1));

    return byCost.map((entry) => {
      const cpt = entry.tokens === 0 ? 0 : entry.cost / entry.tokens;
      const cpi = entry.invocations === 0 ? 0 : entry.cost / entry.invocations;
      const costRank = rankByCost.get(entry.pair);
      const latencyRank = rankByLatency.get(entry.pair);
      if (costRank === undefined || latencyRank === undefined) {
        // Defensive: every entry was inserted into both rank maps;
        // a miss here would be a bug in this method, not a data
        // problem. Surface it as a typed error.
        throw new TelemetryQueryError(
          "telemetry_query_invalid_input",
          `pairRanking lost rank for pair ${entry.pair}`,
        );
      }
      return {
        pair: entry.pair,
        costPerToken: cpt,
        costPerInvocation: cpi,
        avgLatencyMs: entry.avgLatencyMs,
        rankByCost: costRank,
        rankByLatency: latencyRank,
      };
    });
  }
}

/**
 * Collapse an array of repository aggregate rows into a
 * TelemetrySummaryByPair. When multiple rows share the same (model,
 * provider) pair (e.g. per-day rows being summed back up), the cost /
 * token / count fields are added; latency stats are weighted by
 * invocation count (avg) and dropped to the max-observed bucket value
 * (p95). Mixing buckets at p95 is approximate; the contract is that
 * the per-day p95 is exact, and the rolled-up p95 is the "worst p95
 * across buckets" — a documented conservative upper bound.
 */
function summariseRows(rows: ReadonlyArray<LedgerPairAggregateRow>): TelemetrySummaryByPair {
  const aggregated = new Map<
    TelemetryPairKey,
    {
      cost: number;
      tokensIn: number;
      tokensOut: number;
      invocations: number;
      latencyWeightedSum: number;
      latencyCount: number;
      p95Max: number;
    }
  >();

  for (const row of rows) {
    const key = buildPairKey(row.modelId, row.providerId);
    const cost = parseCost(row.totalCostUsd);
    const existing = aggregated.get(key);
    const avgLatency = row.avgLatencyMs ?? 0;
    const p95Latency = row.p95LatencyMs ?? 0;
    if (existing === undefined) {
      aggregated.set(key, {
        cost,
        tokensIn: row.totalTokensIn,
        tokensOut: row.totalTokensOut,
        invocations: row.invocationCount,
        latencyWeightedSum: avgLatency * row.invocationCount,
        latencyCount: row.invocationCount,
        p95Max: p95Latency,
      });
    } else {
      existing.cost += cost;
      existing.tokensIn += row.totalTokensIn;
      existing.tokensOut += row.totalTokensOut;
      existing.invocations += row.invocationCount;
      existing.latencyWeightedSum += avgLatency * row.invocationCount;
      existing.latencyCount += row.invocationCount;
      existing.p95Max = Math.max(existing.p95Max, p95Latency);
    }
  }

  const byPair: Record<TelemetryPairKey, TelemetryPairSummary> = {};
  let totalCost = 0;
  // Iterate sorted by pair key for deterministic JSON key order.
  const sortedKeys = Array.from(aggregated.keys()).sort();
  for (const key of sortedKeys) {
    const entry = aggregated.get(key);
    if (entry === undefined) {
      continue;
    }
    byPair[key] = {
      totalCostUsd: entry.cost.toFixed(8),
      totalTokensIn: entry.tokensIn,
      totalTokensOut: entry.tokensOut,
      avgLatencyMs: entry.latencyCount === 0 ? 0 : entry.latencyWeightedSum / entry.latencyCount,
      p95LatencyMs: entry.p95Max,
      invocationCount: entry.invocations,
    };
    totalCost += entry.cost;
  }

  return {
    byPair,
    totalCostUsd: totalCost.toFixed(8),
  };
}

function parseCost(raw: string): number {
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) {
    throw new TelemetryQueryError(
      "telemetry_query_invalid_input",
      `cost amount ${raw} is not a finite number`,
    );
  }
  return value;
}
