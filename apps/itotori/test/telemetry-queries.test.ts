// ITOTORI-223 — telemetry queries-impl unit tests.
//
// We stub the ItotoriDraftAttemptProviderLedgerRepositoryPort so the
// suite never touches the database. The stub answers `sumByPairAndDay`
// by computing aggregates over an in-memory ledger seed; this lets us
// assert the queries-impl shape transforms (sumByPair, topPairsByCost,
// pairRanking, groupByDay grouping) against deterministic data.
//
// 10 seed entries span 3 distinct (model, provider) pairs over 5 days,
// matching the seed plan in the spec.

import { describe, expect, it } from "vitest";
import type {
  AuthorizationActor,
  DraftAttemptProviderLedgerEntry,
  ItotoriDraftAttemptProviderLedgerRepositoryPort,
  LedgerPairAggregateRow,
  RecordLedgerEntryInput,
  SumByPairAndDayOptions,
  SumCostByProjectOptions,
  SumCostByProjectResult,
  SumCostByProjectWindow,
} from "@itotori/db";
import { LedgerTelemetryQuery, TelemetryQueryError } from "../src/telemetry/queries-impl.js";
import { renderTextSummary } from "../src/telemetry/cli.js";
import {
  TELEMETRY_UNKNOWN_MODEL_SENTINEL,
  buildPairKey,
  type TelemetryPairKey,
} from "../src/telemetry/queries.js";

const FIXED_ACTOR: AuthorizationActor = { userId: "local-user" };
const PROJECT_ID = "project-telemetry-test";

type SeedRow = {
  modelId: string;
  providerId: string;
  costAmount: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  createdAt: Date;
  // ITOTORI-233 — optional cache fields. Default to 0 when omitted so
  // existing seed rows continue to express "no cache hit / no
  // discount" without explicit zeros at every call site.
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheDiscountMicrosUsd?: number;
};

const PAIR_A_MODEL = "anthropic/claude-3.5-sonnet";
const PAIR_A_PROVIDER = "anthropic";
const PAIR_B_MODEL = "openai/gpt-4o-mini";
const PAIR_B_PROVIDER = "openai";
const PAIR_C_MODEL = "deepseek/deepseek-v4-flash";
const PAIR_C_PROVIDER = "fireworks";

function utcDay(year: number, month: number, day: number, hour = 12): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, 0, 0, 0));
}

/**
 * 10 ledger entries:
 *   - pair A (anthropic/claude-3.5-sonnet, anthropic): 4 rows across
 *     days 1, 2, 3, 5 (days = 2026-06-{01,02,03,05}). Cost totals:
 *     0.01 + 0.02 + 0.04 + 0.03 = 0.10 USD. Latencies 1000/2000/3000/
 *     4000 — p95 of [1000,2000,3000,4000] = 3850.
 *   - pair B (openai/gpt-4o-mini, openai): 3 rows across days 1, 4, 5.
 *     Cost totals: 0.005 + 0.005 + 0.005 = 0.015 USD. Latencies
 *     500/600/700 — p95 of [500,600,700] = 690.
 *   - pair C (deepseek/deepseek-v4-flash, fireworks): 3 rows across
 *     days 2, 3, 4. Cost totals: 0.001 + 0.002 + 0.003 = 0.006 USD.
 *     Latencies 100/200/300 — p95 of [100,200,300] = 290.
 *
 * Total cost = 0.10 + 0.015 + 0.006 = 0.121 USD.
 */
function buildSeed(): SeedRow[] {
  return [
    {
      modelId: PAIR_A_MODEL,
      providerId: PAIR_A_PROVIDER,
      costAmount: "0.01000000",
      tokensIn: 100,
      tokensOut: 50,
      latencyMs: 1000,
      createdAt: utcDay(2026, 6, 1),
    },
    {
      modelId: PAIR_A_MODEL,
      providerId: PAIR_A_PROVIDER,
      costAmount: "0.02000000",
      tokensIn: 200,
      tokensOut: 100,
      latencyMs: 2000,
      createdAt: utcDay(2026, 6, 2),
    },
    {
      modelId: PAIR_A_MODEL,
      providerId: PAIR_A_PROVIDER,
      costAmount: "0.04000000",
      tokensIn: 400,
      tokensOut: 200,
      latencyMs: 3000,
      createdAt: utcDay(2026, 6, 3),
    },
    {
      modelId: PAIR_A_MODEL,
      providerId: PAIR_A_PROVIDER,
      costAmount: "0.03000000",
      tokensIn: 300,
      tokensOut: 150,
      latencyMs: 4000,
      createdAt: utcDay(2026, 6, 5),
    },
    {
      modelId: PAIR_B_MODEL,
      providerId: PAIR_B_PROVIDER,
      costAmount: "0.00500000",
      tokensIn: 80,
      tokensOut: 40,
      latencyMs: 500,
      createdAt: utcDay(2026, 6, 1),
    },
    {
      modelId: PAIR_B_MODEL,
      providerId: PAIR_B_PROVIDER,
      costAmount: "0.00500000",
      tokensIn: 80,
      tokensOut: 40,
      latencyMs: 600,
      createdAt: utcDay(2026, 6, 4),
    },
    {
      modelId: PAIR_B_MODEL,
      providerId: PAIR_B_PROVIDER,
      costAmount: "0.00500000",
      tokensIn: 80,
      tokensOut: 40,
      latencyMs: 700,
      createdAt: utcDay(2026, 6, 5),
    },
    {
      modelId: PAIR_C_MODEL,
      providerId: PAIR_C_PROVIDER,
      costAmount: "0.00100000",
      tokensIn: 50,
      tokensOut: 25,
      latencyMs: 100,
      createdAt: utcDay(2026, 6, 2),
    },
    {
      modelId: PAIR_C_MODEL,
      providerId: PAIR_C_PROVIDER,
      costAmount: "0.00200000",
      tokensIn: 60,
      tokensOut: 30,
      latencyMs: 200,
      createdAt: utcDay(2026, 6, 3),
    },
    {
      modelId: PAIR_C_MODEL,
      providerId: PAIR_C_PROVIDER,
      costAmount: "0.00300000",
      tokensIn: 70,
      tokensOut: 35,
      latencyMs: 300,
      createdAt: utcDay(2026, 6, 4),
    },
  ];
}

/**
 * In-memory port that answers `sumByPairAndDay` by computing
 * aggregates over a seed list. We use linear interpolation for p95 to
 * match Postgres's `percentile_cont(0.95)` semantics.
 */
class StubLedgerPort implements ItotoriDraftAttemptProviderLedgerRepositoryPort {
  constructor(private readonly seed: ReadonlyArray<SeedRow>) {}

  async recordLedgerEntry(
    _actor: AuthorizationActor,
    _input: RecordLedgerEntryInput,
  ): Promise<DraftAttemptProviderLedgerEntry> {
    throw new Error("recordLedgerEntry not used by telemetry queries");
  }

  async loadEntriesByAttempt(): Promise<DraftAttemptProviderLedgerEntry[]> {
    throw new Error("loadEntriesByAttempt not used by telemetry queries");
  }

  async loadEntriesByProviderProof(): Promise<DraftAttemptProviderLedgerEntry | null> {
    throw new Error("loadEntriesByProviderProof not used by telemetry queries");
  }

  async sumCostByProject(
    _actor: AuthorizationActor,
    _projectId: string,
    _window: SumCostByProjectWindow,
    _opts?: SumCostByProjectOptions,
  ): Promise<SumCostByProjectResult> {
    throw new Error("sumCostByProject not used by telemetry queries");
  }

  async sumByPairAndDay(
    _actor: AuthorizationActor,
    _projectId: string,
    window: SumCostByProjectWindow,
    opts?: SumByPairAndDayOptions,
  ): Promise<LedgerPairAggregateRow[]> {
    const filtered = this.seed.filter(
      (row) =>
        row.createdAt.getTime() >= window.from.getTime() &&
        row.createdAt.getTime() <= window.to.getTime(),
    );
    const groupByDay = opts?.groupByDay === true;

    const buckets = new Map<string, SeedRow[]>();
    for (const row of filtered) {
      const day = groupByDay ? row.createdAt.toISOString().slice(0, 10) : "__all__";
      const key = `${row.modelId}|${row.providerId}|${day}`;
      const existing = buckets.get(key);
      if (existing === undefined) {
        buckets.set(key, [row]);
      } else {
        existing.push(row);
      }
    }

    const result: LedgerPairAggregateRow[] = [];
    for (const [key, rows] of buckets) {
      const parts = key.split("|");
      const modelId = parts[0]!;
      const providerId = parts[1]!;
      const day = parts[2]!;
      const cost = rows.reduce((acc, r) => acc + Number(r.costAmount), 0);
      const tokensIn = rows.reduce((acc, r) => acc + r.tokensIn, 0);
      const tokensOut = rows.reduce((acc, r) => acc + r.tokensOut, 0);
      const latencies = rows.map((r) => r.latencyMs).sort((a, b) => a - b);
      const avgLatency =
        latencies.length === 0 ? null : latencies.reduce((acc, l) => acc + l, 0) / latencies.length;
      const p95 = latencies.length === 0 ? null : computeP95LinearInterp(latencies);
      // ITOTORI-233 — cache aggregates parallel the SQL aggregates in
      // the real repository. cacheHitCount counts rows with
      // cacheReadTokens > 0; cacheSavingsUsd is the SUM of
      // cacheDiscountMicrosUsd / 1_000_000.
      const cacheHitCount = rows.reduce(
        (acc, r) => acc + ((r.cacheReadTokens ?? 0) > 0 ? 1 : 0),
        0,
      );
      const totalCacheReadTokens = rows.reduce((acc, r) => acc + (r.cacheReadTokens ?? 0), 0);
      const totalCacheWriteTokens = rows.reduce((acc, r) => acc + (r.cacheWriteTokens ?? 0), 0);
      const cacheSavingsMicros = rows.reduce((acc, r) => acc + (r.cacheDiscountMicrosUsd ?? 0), 0);
      result.push({
        modelId,
        providerId,
        bucketDay: groupByDay ? day : null,
        totalCostUsd: cost.toFixed(8),
        totalTokensIn: tokensIn,
        totalTokensOut: tokensOut,
        invocationCount: rows.length,
        avgLatencyMs: avgLatency,
        p95LatencyMs: p95,
        cacheHitCount,
        totalCacheReadTokens,
        totalCacheWriteTokens,
        cacheSavingsUsd: (cacheSavingsMicros / 1_000_000).toFixed(8),
      });
    }
    // Sort: model asc, provider asc, day asc
    result.sort((a, b) => {
      if (a.modelId !== b.modelId) {
        if (a.modelId === null) return -1;
        if (b.modelId === null) return 1;
        return a.modelId.localeCompare(b.modelId);
      }
      if (a.providerId !== b.providerId) return a.providerId.localeCompare(b.providerId);
      if (a.bucketDay === b.bucketDay) return 0;
      if (a.bucketDay === null) return -1;
      if (b.bucketDay === null) return 1;
      return a.bucketDay.localeCompare(b.bucketDay);
    });
    return result;
  }
}

// percentile_cont(0.95) per Postgres semantics: linear interp.
function computeP95LinearInterp(sorted: ReadonlyArray<number>): number {
  if (sorted.length === 0) {
    throw new Error("empty array passed to p95 helper");
  }
  if (sorted.length === 1) {
    return sorted[0]!;
  }
  const rank = 0.95 * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) {
    return sorted[lower]!;
  }
  const frac = rank - lower;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * frac;
}

const FULL_WINDOW = {
  from: new Date("2026-06-01T00:00:00Z"),
  to: new Date("2026-06-30T23:59:59Z"),
};

describe("LedgerTelemetryQuery.sumByPair", () => {
  it("returns per-pair totals + p95 latencies", async () => {
    const port = new StubLedgerPort(buildSeed());
    const query = new LedgerTelemetryQuery(port);
    const summary = await query.sumByPair(FIXED_ACTOR, PROJECT_ID, FULL_WINDOW);

    expect(summary.totalCostUsd).toBe("0.12100000");
    expect(Object.keys(summary.byPair).sort()).toEqual(
      [
        buildPairKey(PAIR_A_MODEL, PAIR_A_PROVIDER),
        buildPairKey(PAIR_C_MODEL, PAIR_C_PROVIDER),
        buildPairKey(PAIR_B_MODEL, PAIR_B_PROVIDER),
      ].sort(),
    );

    const pairA = summary.byPair[buildPairKey(PAIR_A_MODEL, PAIR_A_PROVIDER)];
    expect(pairA).toBeDefined();
    expect(pairA!.totalCostUsd).toBe("0.10000000");
    expect(pairA!.invocationCount).toBe(4);
    expect(pairA!.totalTokensIn).toBe(1000);
    expect(pairA!.totalTokensOut).toBe(500);
    expect(pairA!.avgLatencyMs).toBe(2500);
    // p95 of [1000,2000,3000,4000] via linear interp at rank
    // 0.95 * 3 = 2.85 -> 3000 + 0.85 * (4000 - 3000) = 3850
    expect(pairA!.p95LatencyMs).toBeCloseTo(3850, 6);

    const pairB = summary.byPair[buildPairKey(PAIR_B_MODEL, PAIR_B_PROVIDER)];
    expect(pairB).toBeDefined();
    expect(pairB!.totalCostUsd).toBe("0.01500000");
    expect(pairB!.invocationCount).toBe(3);
    // p95 of [500,600,700] via linear interp at rank 0.95*2 = 1.9
    // -> 600 + 0.9 * (700 - 600) = 690
    expect(pairB!.p95LatencyMs).toBeCloseTo(690, 6);

    const pairC = summary.byPair[buildPairKey(PAIR_C_MODEL, PAIR_C_PROVIDER)];
    expect(pairC).toBeDefined();
    expect(pairC!.totalCostUsd).toBe("0.00600000");
    expect(pairC!.invocationCount).toBe(3);
    expect(pairC!.p95LatencyMs).toBeCloseTo(290, 6);

    expect(summary.byDay).toBeUndefined();
  });

  it("with groupByDay: true returns per-day breakdowns", async () => {
    const port = new StubLedgerPort(buildSeed());
    const query = new LedgerTelemetryQuery(port);
    const summary = await query.sumByPair(FIXED_ACTOR, PROJECT_ID, FULL_WINDOW, {
      groupByDay: true,
    });

    expect(summary.byDay).toBeDefined();
    const days = Object.keys(summary.byDay!).sort();
    // Days 1-5 of June 2026 appear (no entries on day 6+).
    expect(days).toEqual(["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05"]);

    // Day 1: pair A 0.01 + pair B 0.005 = 0.015
    const day1 = summary.byDay!["2026-06-01"];
    expect(day1).toBeDefined();
    expect(day1!.totalCostUsd).toBe("0.01500000");
    expect(Object.keys(day1!.byPair)).toHaveLength(2);

    // Day 5: pair A 0.03 + pair B 0.005 = 0.035
    const day5 = summary.byDay!["2026-06-05"];
    expect(day5).toBeDefined();
    expect(day5!.totalCostUsd).toBe("0.03500000");

    // The aggregated (no-byDay) totals still match.
    expect(summary.totalCostUsd).toBe("0.12100000");
  });

  it("empty window returns byPair:{} and totalCostUsd:'0'", async () => {
    const port = new StubLedgerPort(buildSeed());
    const query = new LedgerTelemetryQuery(port);
    const summary = await query.sumByPair(FIXED_ACTOR, PROJECT_ID, {
      from: new Date("1990-01-01T00:00:00Z"),
      to: new Date("1990-01-02T00:00:00Z"),
    });
    expect(summary.byPair).toEqual({});
    expect(summary.totalCostUsd).toBe("0.00000000");
    expect(parseFloat(summary.totalCostUsd)).toBe(0);
  });
});

describe("LedgerTelemetryQuery.topPairsByCost", () => {
  it("returns top-3 pairs by cost with correct shares", async () => {
    const port = new StubLedgerPort(buildSeed());
    const query = new LedgerTelemetryQuery(port);
    const top = await query.topPairsByCost(FIXED_ACTOR, PROJECT_ID, FULL_WINDOW, 3);
    expect(top).toHaveLength(3);

    expect(top[0]!.pair).toBe(buildPairKey(PAIR_A_MODEL, PAIR_A_PROVIDER));
    expect(top[0]!.totalCostUsd).toBe("0.10000000");
    expect(top[0]!.share).toBeCloseTo(0.1 / 0.121, 6);

    expect(top[1]!.pair).toBe(buildPairKey(PAIR_B_MODEL, PAIR_B_PROVIDER));
    expect(top[1]!.totalCostUsd).toBe("0.01500000");
    expect(top[1]!.share).toBeCloseTo(0.015 / 0.121, 6);

    expect(top[2]!.pair).toBe(buildPairKey(PAIR_C_MODEL, PAIR_C_PROVIDER));
    expect(top[2]!.totalCostUsd).toBe("0.00600000");
    expect(top[2]!.share).toBeCloseTo(0.006 / 0.121, 6);

    const shareSum = top.reduce((acc, row) => acc + row.share, 0);
    expect(shareSum).toBeCloseTo(1.0, 6);
  });

  it("top-1 returns only the highest-cost pair", async () => {
    const port = new StubLedgerPort(buildSeed());
    const query = new LedgerTelemetryQuery(port);
    const top = await query.topPairsByCost(FIXED_ACTOR, PROJECT_ID, FULL_WINDOW, 1);
    expect(top).toHaveLength(1);
    expect(top[0]!.pair).toBe(buildPairKey(PAIR_A_MODEL, PAIR_A_PROVIDER));
  });

  it("rejects non-positive k", async () => {
    const port = new StubLedgerPort(buildSeed());
    const query = new LedgerTelemetryQuery(port);
    await expect(
      query.topPairsByCost(FIXED_ACTOR, PROJECT_ID, FULL_WINDOW, 0),
    ).rejects.toBeInstanceOf(TelemetryQueryError);
  });

  it("returns empty list with zero shares when window has no entries", async () => {
    const port = new StubLedgerPort(buildSeed());
    const query = new LedgerTelemetryQuery(port);
    const top = await query.topPairsByCost(
      FIXED_ACTOR,
      PROJECT_ID,
      {
        from: new Date("1990-01-01T00:00:00Z"),
        to: new Date("1990-01-02T00:00:00Z"),
      },
      3,
    );
    expect(top).toEqual([]);
  });
});

describe("LedgerTelemetryQuery.pairRanking", () => {
  it("orders correctly by cost-per-token (ascending)", async () => {
    const port = new StubLedgerPort(buildSeed());
    const query = new LedgerTelemetryQuery(port);
    const ranking = await query.pairRanking(FIXED_ACTOR, PROJECT_ID, FULL_WINDOW);
    expect(ranking).toHaveLength(3);

    // Pair A: 0.10 / (1000 + 500) = 6.67e-5 per token
    // Pair B: 0.015 / (240 + 120) = 4.17e-5 per token
    // Pair C: 0.006 / (180 + 90) = 2.22e-5 per token
    // Ascending by cost-per-token: C (rank 1), B (rank 2), A (rank 3)
    expect(ranking[0]!.pair).toBe(buildPairKey(PAIR_C_MODEL, PAIR_C_PROVIDER));
    expect(ranking[0]!.rankByCost).toBe(1);
    expect(ranking[1]!.pair).toBe(buildPairKey(PAIR_B_MODEL, PAIR_B_PROVIDER));
    expect(ranking[1]!.rankByCost).toBe(2);
    expect(ranking[2]!.pair).toBe(buildPairKey(PAIR_A_MODEL, PAIR_A_PROVIDER));
    expect(ranking[2]!.rankByCost).toBe(3);

    // Latency ranking: ascending avg latency
    // Pair C avg = 200; Pair B avg = 600; Pair A avg = 2500.
    expect(ranking[0]!.rankByLatency).toBe(1);
    expect(ranking[1]!.rankByLatency).toBe(2);
    expect(ranking[2]!.rankByLatency).toBe(3);
  });

  it("includes costPerInvocation", async () => {
    const port = new StubLedgerPort(buildSeed());
    const query = new LedgerTelemetryQuery(port);
    const ranking = await query.pairRanking(FIXED_ACTOR, PROJECT_ID, FULL_WINDOW);
    const pairA = ranking.find((r) => r.pair === buildPairKey(PAIR_A_MODEL, PAIR_A_PROVIDER));
    expect(pairA).toBeDefined();
    // 0.10 / 4 invocations = 0.025
    expect(pairA!.costPerInvocation).toBeCloseTo(0.025, 8);
  });

  it("returns empty list when window has no entries", async () => {
    const port = new StubLedgerPort(buildSeed());
    const query = new LedgerTelemetryQuery(port);
    const ranking = await query.pairRanking(FIXED_ACTOR, PROJECT_ID, {
      from: new Date("1990-01-01T00:00:00Z"),
      to: new Date("1990-01-02T00:00:00Z"),
    });
    expect(ranking).toEqual([]);
  });
});

describe("LedgerTelemetryQuery.countZdrEnforcedCallsByPair (ITOTORI-230)", () => {
  // ITOTORI-230 acceptance criterion #3 — schema-level test (no live OR
  // call required). Stub the model-ledger port with fixture rows and
  // assert the telemetry surface relays them with deterministic ordering.

  type ZdrCountRow = {
    modelId: string;
    providerId: string;
    invocationCount: number;
    zdrEnforcedCount: number;
  };

  class StubModelLedgerPort {
    constructor(private readonly rows: ZdrCountRow[]) {}
    // Type-erased: we only use countZdrEnforcedByPair on this port.
    async recordProviderRun(): Promise<never> {
      throw new Error("stub does not implement recordProviderRun");
    }
    async getProjectCostReport(): Promise<never> {
      throw new Error("stub does not implement getProjectCostReport");
    }
    async countZdrEnforcedByPair(): Promise<ZdrCountRow[]> {
      return this.rows;
    }
  }

  const WINDOW = {
    from: new Date("2026-06-01T00:00:00Z"),
    to: new Date("2026-06-30T23:59:59Z"),
  };

  it("returns ZDR-enforced counts per pair from the model-ledger port", async () => {
    const modelLedger = new StubModelLedgerPort([
      {
        modelId: "deepseek-ai/deepseek-v3.2-exp",
        providerId: "fireworks",
        invocationCount: 3,
        zdrEnforcedCount: 2,
      },
    ]);
    const query = new LedgerTelemetryQuery(
      new StubLedgerPort(buildSeed()),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      modelLedger as any,
    );
    const rows = await query.countZdrEnforcedCallsByPair(FIXED_ACTOR, PROJECT_ID, WINDOW);
    expect(rows).toEqual([
      {
        pair: buildPairKey("deepseek-ai/deepseek-v3.2-exp", "fireworks"),
        invocationCount: 3,
        zdrEnforcedCount: 2,
      },
    ]);
  });

  it("orders rows deterministically by pair key for stable JSON output", async () => {
    const modelLedger = new StubModelLedgerPort([
      // Insert in non-sorted order to assert the surface re-sorts.
      {
        modelId: "model-z",
        providerId: "provider-z",
        invocationCount: 5,
        zdrEnforcedCount: 5,
      },
      {
        modelId: "model-a",
        providerId: "provider-a",
        invocationCount: 1,
        zdrEnforcedCount: 1,
      },
    ]);
    const query = new LedgerTelemetryQuery(
      new StubLedgerPort(buildSeed()),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      modelLedger as any,
    );
    const rows = await query.countZdrEnforcedCallsByPair(FIXED_ACTOR, PROJECT_ID, WINDOW);
    expect(rows.map((row) => row.pair)).toEqual([
      buildPairKey("model-a", "provider-a"),
      buildPairKey("model-z", "provider-z"),
    ]);
  });

  it("throws TelemetryQueryError when constructor was not given a model-ledger port", async () => {
    // Constructor wired only with the draft-attempt port — calling
    // countZdrEnforcedCallsByPair must surface a typed error rather
    // than silently returning empty.
    const query = new LedgerTelemetryQuery(new StubLedgerPort(buildSeed()));
    await expect(
      query.countZdrEnforcedCallsByPair(FIXED_ACTOR, PROJECT_ID, WINDOW),
    ).rejects.toThrow(TelemetryQueryError);
  });
});

describe("LedgerTelemetryQuery — ITOTORI-233 cache aggregates", () => {
  // ITOTORI-233 acceptance #5: `cache_savings_usd` lands on the
  // summary + per-pair rows. Real cost only — sourced from
  // cache_discount_micros_usd, never derived from token counts × pricing.

  function cacheSeed(): SeedRow[] {
    // Two pairs:
    //  - C (deepseek/deepseek-v4-flash, fireworks): 2 rows, one cache
    //    hit ($0.000003 discount) + one non-hit (0 discount). Hit
    //    rate = 1/2.
    //  - A (anthropic/claude-3.5-sonnet, anthropic): 1 row, no cache
    //    annotations at all. Hit rate = 0/1.
    return [
      {
        modelId: PAIR_C_MODEL,
        providerId: PAIR_C_PROVIDER,
        costAmount: "0.00000500",
        tokensIn: 100,
        tokensOut: 50,
        latencyMs: 100,
        createdAt: utcDay(2026, 6, 1),
        cacheReadTokens: 50,
        cacheWriteTokens: 0,
        cacheDiscountMicrosUsd: 3,
      },
      {
        modelId: PAIR_C_MODEL,
        providerId: PAIR_C_PROVIDER,
        costAmount: "0.00000800",
        tokensIn: 120,
        tokensOut: 60,
        latencyMs: 110,
        createdAt: utcDay(2026, 6, 2),
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheDiscountMicrosUsd: 0,
      },
      {
        modelId: PAIR_A_MODEL,
        providerId: PAIR_A_PROVIDER,
        costAmount: "0.01000000",
        tokensIn: 100,
        tokensOut: 50,
        latencyMs: 1000,
        createdAt: utcDay(2026, 6, 3),
      },
    ];
  }

  it("sumByPair surfaces cacheHitCount + cacheSavingsUsd per pair", async () => {
    const port = new StubLedgerPort(cacheSeed());
    const query = new LedgerTelemetryQuery(port);
    const summary = await query.sumByPair(FIXED_ACTOR, PROJECT_ID, FULL_WINDOW);
    const pairC = summary.byPair[buildPairKey(PAIR_C_MODEL, PAIR_C_PROVIDER)];
    expect(pairC).toBeDefined();
    expect(pairC!.invocationCount).toBe(2);
    expect(pairC!.cacheHitCount).toBe(1);
    expect(pairC!.totalCacheReadTokens).toBe(50);
    expect(pairC!.totalCacheWriteTokens).toBe(0);
    // 3 micros / 1_000_000 = 0.000003 USD
    expect(pairC!.cacheSavingsUsd).toBe("0.00000300");

    const pairA = summary.byPair[buildPairKey(PAIR_A_MODEL, PAIR_A_PROVIDER)];
    expect(pairA).toBeDefined();
    expect(pairA!.cacheHitCount).toBe(0);
    expect(pairA!.cacheSavingsUsd).toBe("0.00000000");
  });

  it("sumByPair surfaces top-level cacheSavingsUsd as the SUM across pairs", async () => {
    const port = new StubLedgerPort(cacheSeed());
    const query = new LedgerTelemetryQuery(port);
    const summary = await query.sumByPair(FIXED_ACTOR, PROJECT_ID, FULL_WINDOW);
    // Pair C: $0.000003; Pair A: $0. Total: $0.000003.
    expect(summary.cacheSavingsUsd).toBe("0.00000300");
  });

  it("countCacheHitsByPair surfaces per-pair hit counts + savings, sorted by pair key", async () => {
    const port = new StubLedgerPort(cacheSeed());
    const query = new LedgerTelemetryQuery(port);
    const rows = await query.countCacheHitsByPair(FIXED_ACTOR, PROJECT_ID, FULL_WINDOW);
    expect(rows).toHaveLength(2);
    // Sorted by pair key lexicographically.
    expect(rows[0]!.pair).toBe(buildPairKey(PAIR_A_MODEL, PAIR_A_PROVIDER));
    expect(rows[0]!.invocationCount).toBe(1);
    expect(rows[0]!.cacheHitCount).toBe(0);
    expect(rows[0]!.cacheSavingsUsd).toBe("0.00000000");

    expect(rows[1]!.pair).toBe(buildPairKey(PAIR_C_MODEL, PAIR_C_PROVIDER));
    expect(rows[1]!.invocationCount).toBe(2);
    expect(rows[1]!.cacheHitCount).toBe(1);
    expect(rows[1]!.totalCacheReadTokens).toBe(50);
    expect(rows[1]!.cacheSavingsUsd).toBe("0.00000300");
  });

  it("countCacheHitsByPair returns empty list for an empty window", async () => {
    const port = new StubLedgerPort(cacheSeed());
    const query = new LedgerTelemetryQuery(port);
    const rows = await query.countCacheHitsByPair(FIXED_ACTOR, PROJECT_ID, {
      from: new Date("1990-01-01T00:00:00Z"),
      to: new Date("1990-01-02T00:00:00Z"),
    });
    expect(rows).toEqual([]);
  });

  it("cacheSavingsUsd from existing non-cache seed remains 0 (backward-compat)", async () => {
    const port = new StubLedgerPort(buildSeed());
    const query = new LedgerTelemetryQuery(port);
    const summary = await query.sumByPair(FIXED_ACTOR, PROJECT_ID, FULL_WINDOW);
    expect(summary.cacheSavingsUsd).toBe("0.00000000");
    for (const pair of Object.values(summary.byPair)) {
      expect(pair.cacheHitCount).toBe(0);
      expect(pair.cacheSavingsUsd).toBe("0.00000000");
    }
  });
});

describe("telemetry CLI renderTextSummary — ITOTORI-233", () => {
  // Acceptance criterion #5: "apps/itotori/src/telemetry/cli.ts prints
  // cache_savings_usd=<real> for the window."

  it("prints a cache_savings_usd=<real> line at the top of the text summary", async () => {
    const port = new StubLedgerPort([
      {
        modelId: PAIR_C_MODEL,
        providerId: PAIR_C_PROVIDER,
        costAmount: "0.00000500",
        tokensIn: 100,
        tokensOut: 50,
        latencyMs: 100,
        createdAt: utcDay(2026, 6, 1),
        cacheReadTokens: 50,
        cacheWriteTokens: 0,
        cacheDiscountMicrosUsd: 3,
      },
    ]);
    const query = new LedgerTelemetryQuery(port);
    const summary = await query.sumByPair(FIXED_ACTOR, PROJECT_ID, FULL_WINDOW);
    const lines = renderTextSummary(summary, {
      projectId: PROJECT_ID,
      from: FULL_WINDOW.from,
      to: FULL_WINDOW.to,
    });
    // The CLI prints `cache_savings_usd=<real>` exactly once near the
    // top; the real value mirrors summary.cacheSavingsUsd byte-for-byte.
    const cacheSavingsLines = lines.filter((line) => line.startsWith("cache_savings_usd="));
    expect(cacheSavingsLines).toHaveLength(1);
    expect(cacheSavingsLines[0]).toBe("cache_savings_usd=0.00000300");
  });

  it("prints cache_savings_usd=0.00000000 for an empty window", async () => {
    const port = new StubLedgerPort(buildSeed());
    const query = new LedgerTelemetryQuery(port);
    const summary = await query.sumByPair(FIXED_ACTOR, PROJECT_ID, {
      from: new Date("1990-01-01T00:00:00Z"),
      to: new Date("1990-01-02T00:00:00Z"),
    });
    const lines = renderTextSummary(summary, {
      projectId: PROJECT_ID,
      from: new Date("1990-01-01T00:00:00Z"),
      to: new Date("1990-01-02T00:00:00Z"),
    });
    expect(lines).toContain("cache_savings_usd=0.00000000");
  });
});

describe("TelemetryPairKey contract", () => {
  it("buildPairKey uses ${modelId}:${providerId} byte-for-byte", () => {
    const key = buildPairKey(PAIR_A_MODEL, PAIR_A_PROVIDER);
    expect(key).toBe(`${PAIR_A_MODEL}:${PAIR_A_PROVIDER}`);
  });

  it("null modelId is surfaced via the typed sentinel, not collapsed to provider alone", () => {
    const key: TelemetryPairKey = buildPairKey(null, PAIR_A_PROVIDER);
    expect(key).toBe(`${TELEMETRY_UNKNOWN_MODEL_SENTINEL}:${PAIR_A_PROVIDER}`);
    expect(key.includes(":")).toBe(true);
    expect(key.startsWith(":")).toBe(false);
  });
});
