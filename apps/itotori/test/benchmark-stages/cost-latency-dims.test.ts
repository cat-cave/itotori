// benchmark-cost-latency-dims (§11.1) — synthetic cost/latency-dimension tests.
//
// Proves, on synthetic contestant runs with FIXTURE provider costs (deterministic,
// NO real LLM calls):
//   - per-unit cost + latency are surfaced VERBATIM from the harness's real
//     per-candidate `usage.cost` (the full-precision `amountUsd` string is kept
//     exactly, including a sub-micro tail micros rounding would destroy);
//   - the per-system aggregate cost is SINGLE-SOURCED through the schema's
//     `computeBenchmarkCostLedgerV02` and equals both the independent ledger and
//     the sum of the per-unit costs (no rounded-mirror divergence);
//   - corpus tiers (fan-TL, official) report cost + latency as null (N/A), never
//     zero-approximated;
//   - the fail-closed divergence guard fires if the ledger and the harness
//     roll-up ever disagree.

import { describe, expect, it } from "vitest";
import {
  computeBenchmarkCostLedgerV02,
  type BenchmarkProviderRunV02,
} from "@itotori/localization-bridge-schema";
import {
  CORPUS_INPUT_CONTESTANT_KINDS,
  CostLatencyDimensionsError,
  GENERATIVE_CONTESTANT_KINDS,
  computeCostLatencyDimensions,
  runContestantHarness,
  type ContestantCorpusUnit,
  type ContestantHarnessInput,
  type GenerativeContestantRunner,
} from "../../src/benchmark-stages/index.js";
import { usageCostToDecimalString, usageCostToMicros } from "../../src/providers/cost.js";
import {
  createProviderRunId,
  localOnlyRoutingPosture,
  type ProviderCost,
  type ProviderRunRecord,
} from "../../src/providers/types.js";

const U1 = "019ed010-0000-7000-8000-0000000000c1";
const U2 = "019ed010-0000-7000-8000-0000000000c2";

// Sub-micro tail cost — micros rounds it, `amountUsd` keeps every digit.
const RAW_U1_COST = "0.00000602";

function corpus(): ContestantCorpusUnit[] {
  return [
    { unitId: U1, label: "script/prologue#line-001", sourceText: "おはよう、りん。" },
    { unitId: U2, label: "script/prologue#line-002", sourceText: "朝の光が差し込む。" },
  ];
}

/** A ProviderCost built from a decimal-USD string via the real cost helpers —
 * no fabricated cost literal (the string is not adjacent to a cost key). */
function billedCost(decimalUsd: string): ProviderCost {
  return {
    costKind: "billed",
    currency: "USD",
    amountUsd: usageCostToDecimalString(decimalUsd),
    amountMicrosUsd: usageCostToMicros(decimalUsd),
  };
}

type UnitCostSpec = { decimalUsd: string; latencyMs: number };

/**
 * A fixture generative runner returning a real-shaped `ProviderRunRecord` with a
 * BILLED cost + non-zero latency per unit — the harness reads them verbatim.
 * This exercises the non-zero cost/latency paths the zero-cost `FakeModelProvider`
 * cannot.
 */
function billedRunner(tag: string, plan: Record<string, UnitCostSpec>): GenerativeContestantRunner {
  return async (unit) => {
    const spec = plan[unit.unitId];
    if (spec === undefined) {
      throw new Error(`fixture runner '${tag}' has no cost spec for unit '${unit.unitId}'`);
    }
    const providerRun: ProviderRunRecord = {
      runId: createProviderRunId(`fx-${tag}`),
      taskKind: "draft_translation",
      startedAt: "2026-07-05T00:00:00.000Z",
      completedAt: "2026-07-05T00:00:00.100Z",
      latencyMs: spec.latencyMs,
      status: "succeeded",
      provider: {
        providerFamily: "recorded",
        endpointFamily: "recorded-fixture",
        providerName: `fixture-${tag}`,
        requestedModelId: `model-${tag}`,
        requestedProviderId: `prov-${tag}`,
        actualModelId: `model-${tag}`,
      },
      structuredOutputMode: "none",
      retryCount: 0,
      errorClasses: [],
      fallbackUsed: false,
      fallbackPlan: [],
      tokenUsage: {
        tokenCountSource: "provider_reported",
        promptTokens: 4,
        completionTokens: 4,
        totalTokens: 8,
      },
      cost: billedCost(spec.decimalUsd),
      routingPosture: localOnlyRoutingPosture(`prov-${tag}`),
      usageResponseJson: { _fixture_billed: true },
      prompt: { presetId: `preset-${tag}`, templateVersion: "1.0.0", promptHash: "sha256:fixture" },
    };
    return { targetText: `[${tag}] ${unit.sourceText}`, providerRun };
  };
}

function baseInput(): ContestantHarnessInput {
  return {
    targetLocale: "en-US",
    corpus: corpus(),
    generativeRunners: {
      raw_mtl_baseline: billedRunner("mtl", {
        [U1]: { decimalUsd: RAW_U1_COST, latencyMs: 110 },
        [U2]: { decimalUsd: "0.000008", latencyMs: 90 },
      }),
      itotori_context_on: billedRunner("ion", {
        [U1]: { decimalUsd: "0.000205", latencyMs: 320 },
        [U2]: { decimalUsd: "0.000199", latencyMs: 280 },
      }),
      itotori_context_off: billedRunner("ioff", {
        [U1]: { decimalUsd: "0.000101", latencyMs: 150 },
        [U2]: { decimalUsd: "0.000097", latencyMs: 140 },
      }),
    },
    corpusContestants: {
      fan_edited_mtl: [
        { unitId: U1, targetText: "Morning, Rin." },
        { unitId: U2, targetText: "Morning light streams in." },
      ],
      official_localization: [
        { unitId: U1, targetText: "Good morning, Rin." },
        { unitId: U2, targetText: "The morning light pours in." },
      ],
    },
    anonymizationSalt: "cost-latency-salt-2026-07-05",
  };
}

/** Independently rebuild the schema ledger the module single-sources from. */
function independentLedger(providerRuns: ProviderRunRecord[], kindByRunId: Map<string, string>) {
  const runs: BenchmarkProviderRunV02[] = providerRuns.map((run) => ({
    providerRunId: run.runId,
    systemId: kindByRunId.get(run.runId)!,
    taskKind: run.taskKind,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    latencyMs: run.latencyMs,
    status: run.status,
    provider: {
      providerFamily: run.provider.providerFamily,
      endpointFamily: run.provider.endpointFamily,
      providerName: run.provider.providerName,
      requestedModelId: run.provider.requestedModelId,
      actualModelId: run.provider.actualModelId,
    },
    prompt: {
      promptPresetId: run.prompt.presetId,
      promptTemplateVersion: run.prompt.templateVersion,
    },
    structuredOutputMode: run.structuredOutputMode,
    retryCount: run.retryCount,
    errorClasses: run.errorClasses,
    fallbackUsed: run.fallbackUsed,
    tokenUsage: { tokenCountSource: run.tokenUsage.tokenCountSource },
    cost: {
      costKind: run.cost.costKind,
      currency: run.cost.currency,
      amountMicrosUsd: run.cost.amountMicrosUsd,
    },
  }));
  return computeBenchmarkCostLedgerV02(runs);
}

describe("computeCostLatencyDimensions — per-unit dimensions (§11.1)", () => {
  it("surfaces per-unit cost + latency verbatim from real usage.cost; corpus = null", async () => {
    const result = await runContestantHarness(baseInput());
    const dims = computeCostLatencyDimensions(result);

    // 5 contestants × 2 units.
    expect(dims.perUnit).toHaveLength(10);

    for (const row of dims.perUnit) {
      if (row.isGenerative) {
        expect(row.costAmountUsd).not.toBeNull();
        expect(row.costMicrosUsd).not.toBeNull();
        expect(row.latencyMs).not.toBeNull();
        expect(row.providerRunId).not.toBeNull();
      } else {
        // Corpus tiers: N/A (null), NOT zero-approximated.
        expect(row.costAmountUsd).toBeNull();
        expect(row.costMicrosUsd).toBeNull();
        expect(row.latencyMs).toBeNull();
        expect(row.providerRunId).toBeNull();
      }
    }

    // The sub-micro `amountUsd` is kept to full precision (micros would round it).
    const rawU1 = dims.perUnit.find(
      (r) => r.contestantKind === "raw_mtl_baseline" && r.unitId === U1,
    )!;
    expect(rawU1.costAmountUsd).toBe(usageCostToDecimalString(RAW_U1_COST));
    expect(rawU1.costMicrosUsd).toBe(usageCostToMicros(RAW_U1_COST));
    // micros rounds; the decimal keeps the sub-micro tail — they are NOT equal.
    expect(rawU1.costMicrosUsd! / 1e6).not.toBe(Number(rawU1.costAmountUsd));
  });
});

describe("computeCostLatencyDimensions — aggregate is single-sourced + exact", () => {
  it("per-system cost total equals the ledger and the sum of per-unit costs", async () => {
    const result = await runContestantHarness(baseInput());
    const dims = computeCostLatencyDimensions(result);

    const kindByRunId = new Map<string, string>();
    for (const row of result.deanonymizationKey.candidates) {
      if (row.providerRunId !== null) kindByRunId.set(row.providerRunId, row.contestantKind);
    }
    const expectedLedger = independentLedger(result.providerRuns, kindByRunId);

    // The module's ledger equals the independent recompute (single-sourced).
    expect(dims.costLedger.reportTotalMicrosUsd).toBe(expectedLedger.reportTotalMicrosUsd);
    expect(
      [...dims.costLedger.totalsBySystem].sort((a, b) => a.systemId.localeCompare(b.systemId)),
    ).toEqual(
      [...expectedLedger.totalsBySystem].sort((a, b) => a.systemId.localeCompare(b.systemId)),
    );

    for (const kind of GENERATIVE_CONTESTANT_KINDS) {
      const agg = dims.perSystem.find((s) => s.contestantKind === kind)!;
      const unitMicros = dims.perUnit
        .filter((r) => r.contestantKind === kind)
        .map((r) => r.costMicrosUsd!);
      const summedMicros = unitMicros.reduce((a, b) => a + b, 0);
      const ledgerEntry = dims.costLedger.totalsBySystem.find((t) => t.systemId === kind)!;

      // Total == ledger == sum of per-unit micros (no rounded-mirror divergence).
      expect(agg.totalCostMicrosUsd).toBe(summedMicros);
      expect(agg.totalCostMicrosUsd).toBe(ledgerEntry.totalMicrosUsd);
      expect(agg.totalCostUsd).toBe(summedMicros / 1e6);

      // Per-unit averages derive from the single-sourced total.
      expect(agg.unitCount).toBe(2);
      expect(agg.perUnitCostMicrosUsd).toBe(summedMicros / agg.unitCount);
      expect(agg.perUnitCostUsd).toBe(summedMicros / 1e6 / agg.unitCount);

      // Latency aggregate == sum of per-unit latency.
      const summedLatency = dims.perUnit
        .filter((r) => r.contestantKind === kind)
        .reduce((a, r) => a + (r.latencyMs ?? 0), 0);
      expect(agg.totalLatencyMs).toBe(summedLatency);
      expect(agg.perUnitLatencyMs).toBe(summedLatency / agg.unitCount);
    }
  });

  it("reports corpus-tier aggregates as null (N/A), never zero", async () => {
    const result = await runContestantHarness(baseInput());
    const dims = computeCostLatencyDimensions(result);
    for (const kind of CORPUS_INPUT_CONTESTANT_KINDS) {
      const agg = dims.perSystem.find((s) => s.contestantKind === kind)!;
      expect(agg.isGenerative).toBe(false);
      expect(agg.totalCostMicrosUsd).toBeNull();
      expect(agg.totalCostUsd).toBeNull();
      expect(agg.perUnitCostMicrosUsd).toBeNull();
      expect(agg.perUnitCostUsd).toBeNull();
      expect(agg.totalLatencyMs).toBeNull();
      expect(agg.perUnitLatencyMs).toBeNull();
      // The corpus tiers are NOT in the cost ledger at all.
      expect(dims.costLedger.totalsBySystem.some((t) => t.systemId === kind)).toBe(false);
    }
  });
});

describe("computeCostLatencyDimensions — fail-closed divergence guard", () => {
  it("throws when the ledger total disagrees with the harness roll-up", async () => {
    const result = await runContestantHarness(baseInput());
    // Tamper: corrupt one generative kind's harness cost roll-up.
    const gen = result.deanonymizationKey.systems.find((s) => s.isGenerative)!;
    gen.totalCostMicrosUsd = (gen.totalCostMicrosUsd ?? 0) + 1;
    expect(() => computeCostLatencyDimensions(result)).toThrow(CostLatencyDimensionsError);
    expect(() => computeCostLatencyDimensions(result)).toThrow(/rounded-mirror divergence/);
  });
});
