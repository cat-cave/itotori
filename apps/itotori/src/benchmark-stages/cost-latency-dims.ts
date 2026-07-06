// benchmark-cost-latency-dims (§11.1) — cost + latency as FIRST-CLASS benchmark
// dimensions (the "car" metrics: fuel-efficient + fast + luxury-quality).
//
// Methodology §11.1 (docs/itotori-translation-benchmark-methodology.md). Cost
// and latency are reported ALONGSIDE the quality vector so improvements are
// judged on the quality/cost/speed frontier, not a single vanity score.
//
// This stage CONSUMES the contestant harness output (contestant-harness.ts). It
// owns NO cost arithmetic of its own — cost comes ONLY from the real OpenRouter
// `usage.cost` the harness already copied VERBATIM into the de-anonymization key
// (`ContestantCandidateProvenance.cost*`), and the headline per-system aggregate
// is SINGLE-SOURCED through the schema's authoritative
// `computeBenchmarkCostLedgerV02` — the same ledger arithmetic the benchmark
// report renderer uses — so the dimensions' headline can never disagree with the
// ledger (no re-rounding, no rounded-mirror divergence). `audit-no-hardcoded-cost`
// stays clean: there is not a single cost literal here.
//
// Two §11.1 invariants enforced IN CODE:
//
//   1. COST TRACES TO REAL `usage.cost`. Per-unit cost is surfaced verbatim from
//      the harness's per-candidate cost rows (the full-precision `amountUsd`
//      string is authoritative; `amountMicrosUsd` is its integer mirror). The
//      per-system total is READ FROM `computeBenchmarkCostLedgerV02`, and a
//      fail-closed cross-check asserts it equals the harness's own per-system
//      roll-up (`assertCostSingleSourced`) — one number, two independent
//      derivations that MUST agree.
//
//   2. CORPUS TIERS ARE N/A (null), NOT ZERO. The fixed corpus-input contestants
//      (fan-TL, official-EN) have no generation runtime, so their cost + latency
//      are `null` (N/A), never a zero-approximation (§11.1).

import {
  TRIAGE_TASK_KINDS,
  computeBenchmarkCostLedgerV02,
  type BenchmarkCostLedgerV02,
  type BenchmarkProviderRunV02,
  type TriageTaskKindV02,
} from "@itotori/localization-bridge-schema";
import {
  CONTESTANT_KINDS,
  GENERATIVE_CONTESTANT_KINDS,
  type ContestantHarnessResult,
  type ContestantKind,
} from "./contestant-harness.js";
import type { ProviderRunRecord } from "../providers/index.js";

/** Raised when the cost/latency dimensions are internally inconsistent — most
 * importantly when the single-sourced ledger total disagrees with the harness's
 * own per-system cost roll-up (the "no rounded-mirror divergence" guard). */
export class CostLatencyDimensionsError extends Error {
  constructor(detail: string) {
    super(`benchmark-cost-latency-dims refused: ${detail}`);
    this.name = "CostLatencyDimensionsError";
  }
}

/**
 * Per-unit, per-contestant cost + latency — reported ALONGSIDE the per-unit
 * quality vector. Values are surfaced VERBATIM from the harness's per-candidate
 * cost rows (real `usage.cost`); the corpus tiers carry `null` (N/A §11.1).
 * This is the DE-ANONYMIZED view (real `contestantKind`), for our own
 * diagnostic reporting — distinct from the blind judge feed.
 */
export type ContestantUnitCostLatency = {
  contestantKind: ContestantKind;
  unitId: string;
  isGenerative: boolean;
  /** Authoritative full-precision billed cost (decimal USD) — null for corpus. */
  costAmountUsd: string | null;
  /** Integer-micros mirror of the billed cost — null for corpus. */
  costMicrosUsd: number | null;
  /** Real per-unit latency — null for corpus (N/A §11.1). */
  latencyMs: number | null;
  /** The provider-run this cost came from — null for corpus. */
  providerRunId: string | null;
};

/**
 * Per-contestant/config cost + latency aggregate (total + per-unit). The cost
 * TOTAL is single-sourced from `computeBenchmarkCostLedgerV02`; the per-unit
 * values are that total divided by the unit count (an average, clearly labelled,
 * never a re-rounded parallel sum). Corpus tiers are `null` throughout (N/A).
 */
export type ContestantAggregateCostLatency = {
  contestantKind: ContestantKind;
  isGenerative: boolean;
  unitCount: number;
  /** Ledger-sourced total billed cost (integer micros) — null for corpus. */
  totalCostMicrosUsd: number | null;
  /** Total billed cost in USD (`micros / 1e6`) — null for corpus. */
  totalCostUsd: number | null;
  /** Mean per-unit cost (micros) = total / unitCount — null for corpus. */
  perUnitCostMicrosUsd: number | null;
  /** Mean per-unit cost (USD) — null for corpus. */
  perUnitCostUsd: number | null;
  /** Total measured latency (ms) — null for corpus. */
  totalLatencyMs: number | null;
  /** Mean per-unit latency (ms) = total / unitCount — null for corpus. */
  perUnitLatencyMs: number | null;
  providerRunIds: string[];
};

/**
 * The §11.1 cost/latency dimensions: per-unit + per-system, plus the authoritative
 * cost ledger the per-system totals are single-sourced from (keyed by
 * de-anonymized `contestantKind`, so the headline traces straight to the ledger).
 */
export type CostLatencyDimensions = {
  perUnit: ContestantUnitCostLatency[];
  perSystem: ContestantAggregateCostLatency[];
  /** The single authoritative aggregate — `totalsBySystem` keyed by contestant kind. */
  costLedger: BenchmarkCostLedgerV02;
};

/** Narrow the app task-kind union (which carries non-benchmark kinds like
 * `experiment`) to a schema `TriageTaskKindV02`. A contestant provider run is a
 * `draft_translation`; anything else is a wiring error and refuses loudly. */
function narrowTaskKind(taskKind: string, systemId: string): TriageTaskKindV02 {
  if ((TRIAGE_TASK_KINDS as readonly string[]).includes(taskKind)) {
    return taskKind as TriageTaskKindV02;
  }
  throw new CostLatencyDimensionsError(
    `contestant '${systemId}' provider run carries non-benchmark taskKind '${taskKind}'`,
  );
}

function isGenerativeKind(kind: ContestantKind): boolean {
  return (GENERATIVE_CONTESTANT_KINDS as readonly string[]).includes(kind);
}

/** The ONLY permitted cost transform: integer micros-USD → USD. Mirrors the
 * benchmark report renderer's `microsToUsd`; never a hardcoded amount. */
function microsToUsd(micros: number): number {
  return micros / 1e6;
}

/**
 * Project a real contestant provider run into the schema ledger's provider-run
 * shape so the cost aggregate can be single-sourced through
 * `computeBenchmarkCostLedgerV02`. Cost is copied VERBATIM (`costKind` +
 * `amountMicrosUsd`); `systemId` is the DE-ANONYMIZED contestant kind so the
 * ledger's `totalsBySystem` is keyed by contestant/config for reporting.
 */
function toLedgerRun(run: ProviderRunRecord, systemId: string): BenchmarkProviderRunV02 {
  return {
    providerRunId: run.runId,
    systemId,
    taskKind: narrowTaskKind(run.taskKind, systemId),
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
      ...(run.provider.upstreamProvider !== undefined
        ? { upstreamProvider: run.provider.upstreamProvider }
        : {}),
      ...(run.provider.routeSettingsHash !== undefined
        ? { routeSettingsHash: run.provider.routeSettingsHash }
        : {}),
    },
    prompt: {
      promptPresetId: run.prompt.presetId,
      promptTemplateVersion: run.prompt.templateVersion,
      ...(run.prompt.promptHash !== undefined ? { promptHash: run.prompt.promptHash } : {}),
    },
    structuredOutputMode: run.structuredOutputMode,
    retryCount: run.retryCount,
    errorClasses: run.errorClasses,
    fallbackUsed: run.fallbackUsed,
    ...(run.fallbackPlan !== undefined ? { fallbackPlan: run.fallbackPlan } : {}),
    tokenUsage: {
      tokenCountSource: run.tokenUsage.tokenCountSource,
      ...(run.tokenUsage.promptTokens !== undefined
        ? { promptTokens: run.tokenUsage.promptTokens }
        : {}),
      ...(run.tokenUsage.completionTokens !== undefined
        ? { completionTokens: run.tokenUsage.completionTokens }
        : {}),
      ...(run.tokenUsage.reasoningTokens !== undefined
        ? { reasoningTokens: run.tokenUsage.reasoningTokens }
        : {}),
      ...(run.tokenUsage.cachedInputTokens !== undefined
        ? { cachedInputTokens: run.tokenUsage.cachedInputTokens }
        : {}),
      ...(run.tokenUsage.totalTokens !== undefined
        ? { totalTokens: run.tokenUsage.totalTokens }
        : {}),
    },
    cost: {
      costKind: run.cost.costKind,
      currency: run.cost.currency,
      amountMicrosUsd: run.cost.amountMicrosUsd,
      ...(run.cost.pricingSnapshotId !== undefined
        ? { pricingSnapshotId: run.cost.pricingSnapshotId }
        : {}),
    },
  };
}

/**
 * Compute the §11.1 cost + latency dimensions from a contestant-harness result.
 *
 * Cost comes ONLY from real `usage.cost` (verbatim per unit; single-sourced
 * through `computeBenchmarkCostLedgerV02` per system). Corpus tiers are `null`
 * (N/A). A fail-closed cross-check proves the ledger total agrees with the
 * harness's own per-system roll-up, so the headline can never diverge.
 */
export function computeCostLatencyDimensions(
  result: ContestantHarnessResult,
): CostLatencyDimensions {
  const key = result.deanonymizationKey;

  // providerRunId → contestant kind (the only join from a run to its system).
  const kindByRunId = new Map<string, ContestantKind>();
  for (const row of key.candidates) {
    if (row.providerRunId !== null) {
      kindByRunId.set(row.providerRunId, row.contestantKind);
    }
  }

  // Single-sourced aggregate: the schema's authoritative ledger arithmetic over
  // the REAL provider runs, keyed by de-anonymized contestant kind.
  const ledgerRuns: BenchmarkProviderRunV02[] = result.providerRuns.map((run) => {
    const kind = kindByRunId.get(run.runId);
    if (kind === undefined) {
      throw new CostLatencyDimensionsError(
        `provider run '${run.runId}' has no contestant in the de-anonymization key`,
      );
    }
    return toLedgerRun(run, kind);
  });
  const costLedger = computeBenchmarkCostLedgerV02(ledgerRuns);
  const ledgerTotalByKind = new Map<string, number>(
    costLedger.totalsBySystem.map((total) => [total.systemId, total.totalMicrosUsd]),
  );

  // Per-unit dimensions — surfaced VERBATIM from the harness's cost rows.
  const perUnit: ContestantUnitCostLatency[] = key.candidates.map((row) => ({
    contestantKind: row.contestantKind,
    unitId: row.unitId,
    isGenerative: isGenerativeKind(row.contestantKind),
    costAmountUsd: row.costAmountUsd,
    costMicrosUsd: row.costMicrosUsd,
    latencyMs: row.latencyMs,
    providerRunId: row.providerRunId,
  }));

  // Per-system aggregate (total + per-unit average).
  const perSystem: ContestantAggregateCostLatency[] = CONTESTANT_KINDS.map((kind) => {
    const generative = isGenerativeKind(kind);
    const rows = key.candidates.filter((row) => row.contestantKind === kind);
    const unitCount = rows.length;
    const providerRunIds = rows
      .map((row) => row.providerRunId)
      .filter((id): id is string => id !== null);

    if (!generative) {
      // Corpus tiers: cost + latency are N/A (null), never zero-approximated.
      return {
        contestantKind: kind,
        isGenerative: false,
        unitCount,
        totalCostMicrosUsd: null,
        totalCostUsd: null,
        perUnitCostMicrosUsd: null,
        perUnitCostUsd: null,
        totalLatencyMs: null,
        perUnitLatencyMs: null,
        providerRunIds,
      };
    }

    // Cost total: SINGLE-SOURCED from the ledger. Every generative kind ran
    // every unit, so it always has a ledger entry (billed or zero).
    const totalCostMicrosUsd = ledgerTotalByKind.get(kind) ?? 0;
    // Latency total: single-sourced from the harness roll-up (no ledger for
    // latency), summed once by the harness — read verbatim.
    const system = key.systems.find((s) => s.contestantKind === kind);
    const totalLatencyMs = system?.totalLatencyMs ?? 0;

    // Cross-check the ledger total against the harness's own per-system cost
    // roll-up (a second, independent derivation). They MUST agree — this is the
    // fail-closed "no rounded-mirror divergence" guard.
    assertCostSingleSourced(kind, system?.totalCostMicrosUsd ?? null, totalCostMicrosUsd);

    const totalCostUsd = microsToUsd(totalCostMicrosUsd);
    return {
      contestantKind: kind,
      isGenerative: true,
      unitCount,
      totalCostMicrosUsd,
      totalCostUsd,
      perUnitCostMicrosUsd: unitCount === 0 ? 0 : totalCostMicrosUsd / unitCount,
      perUnitCostUsd: unitCount === 0 ? 0 : totalCostUsd / unitCount,
      totalLatencyMs,
      perUnitLatencyMs: unitCount === 0 ? 0 : totalLatencyMs / unitCount,
      providerRunIds,
    };
  });

  return { perUnit, perSystem, costLedger };
}

/**
 * Fail-closed: the ledger-sourced per-system cost total MUST equal the harness's
 * own per-system cost roll-up. Both are integer-micros sums of the SAME real
 * `usage.cost`; a mismatch means the aggregate was re-rounded or re-derived
 * divergently, and the run's cost headline cannot be trusted.
 */
function assertCostSingleSourced(
  kind: ContestantKind,
  harnessTotalMicrosUsd: number | null,
  ledgerTotalMicrosUsd: number,
): void {
  if (harnessTotalMicrosUsd === null) {
    throw new CostLatencyDimensionsError(
      `generative contestant '${kind}' is missing its harness cost roll-up`,
    );
  }
  if (harnessTotalMicrosUsd !== ledgerTotalMicrosUsd) {
    throw new CostLatencyDimensionsError(
      `cost aggregate diverged for '${kind}': ledger ${ledgerTotalMicrosUsd} micros != ` +
        `harness roll-up ${harnessTotalMicrosUsd} micros (rounded-mirror divergence)`,
    );
  }
}
