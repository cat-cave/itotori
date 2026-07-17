// Qualifying artifact-lineage telemetry.
//
// The workflow owns the physical-attempt lineage and the ablation policy owns
// lineage classification. This module composes those two substrates into the
// content-free scorecard ledger: one immutable row per physical attempt, keyed
// to the qualifying artifact it served. It intentionally accepts no request or
// output body, so neither can be persisted or returned by this projection.

import { AblationLineageIsolationError, lineageClassOf } from "../ablation/index.js";
import {
  QualifyingArtifactAttemptTelemetrySchema,
  QualifyingScorecardTelemetrySchema,
  type AcceptanceAttemptStage,
  type RoleId,
} from "../contracts/index.js";
import { addDecimalUsd } from "../providers/cost.js";
import type { ResolvedRunPolicy } from "../run-policy/index.js";
import type { AttemptLineageEntry } from "../workflow/index.js";
import type { z } from "zod";

export type QualifyingAttemptTelemetryRow = z.infer<
  typeof QualifyingArtifactAttemptTelemetrySchema
>;
export type QualifyingScorecardTelemetry = z.infer<typeof QualifyingScorecardTelemetrySchema>;

type TelemetryPair = QualifyingAttemptTelemetryRow["requested"];
type TelemetryTokens = QualifyingAttemptTelemetryRow["tokens"];
type TelemetryCost = QualifyingAttemptTelemetryRow["cost"];

/**
 * Metrics observed at the dispatch boundary. This shape is intentionally
 * content-free: no request body, source body, output body, or free-form detail
 * can be supplied to the persistence path.
 */
export interface QualifyingAttemptMetrics {
  readonly requested: TelemetryPair;
  readonly served: TelemetryPair;
  readonly generationId: string | null;
  readonly memoHit: boolean;
  readonly stage: AcceptanceAttemptStage;
  readonly role: RoleId;
  readonly latencyMs: number | null;
  readonly tokens: TelemetryTokens;
  readonly cost: TelemetryCost;
  readonly quarantine: boolean;
  readonly correction: boolean;
}

/** The workflow attempt plus the artifact it served and its observed metrics. */
export interface QualifyingArtifactAttemptInput {
  readonly qualifyingArtifactId: string;
  readonly workflowAttempt: AttemptLineageEntry;
  readonly metrics: QualifyingAttemptMetrics;
}

/**
 * Durable sink for qualifying attempt telemetry. A production adapter persists
 * the composite memo-key/ordinal identity; the in-memory implementation exists
 * only for deterministic proofs.
 */
export interface QualifyingAttemptTelemetryStore {
  append(row: QualifyingAttemptTelemetryRow): Promise<void> | void;
  list():
    | Promise<readonly QualifyingAttemptTelemetryRow[]>
    | readonly QualifyingAttemptTelemetryRow[];
}

/** A deterministic store that models the persistence port for fixture proofs. */
export class InMemoryQualifyingAttemptTelemetryStore implements QualifyingAttemptTelemetryStore {
  readonly #rows: QualifyingAttemptTelemetryRow[] = [];
  readonly #attemptKeys = new Set<string>();

  append(row: QualifyingAttemptTelemetryRow): void {
    const parsed = QualifyingArtifactAttemptTelemetrySchema.parse(row);
    const key = attemptKey(parsed);
    if (this.#attemptKeys.has(key)) {
      throw new Error(`qualifying attempt telemetry already contains ${key}`);
    }
    this.#attemptKeys.add(key);
    this.#rows.push(parsed);
  }

  list(): readonly QualifyingAttemptTelemetryRow[] {
    return [...this.#rows];
  }
}

/**
 * Project one workflow physical attempt into its qualifying artifact lineage.
 * The lineage class comes from the resolved run policy; a caller cannot label
 * an ablation row as qualifying through an input flag.
 */
export function projectQualifyingArtifactAttempt(
  policy: ResolvedRunPolicy,
  input: QualifyingArtifactAttemptInput,
): QualifyingAttemptTelemetryRow {
  const lineageClass = lineageClassOf(policy);
  if (lineageClass !== "qualifying") {
    throw new AblationLineageIsolationError(lineageClass);
  }
  const { workflowAttempt, metrics } = input;
  return QualifyingArtifactAttemptTelemetrySchema.parse({
    qualifyingArtifactId: input.qualifyingArtifactId,
    memoKey: workflowAttempt.memoKey,
    attemptOrdinal: workflowAttempt.ordinal,
    requested: metrics.requested,
    served: metrics.served,
    generationId: metrics.generationId,
    memoHit: metrics.memoHit,
    stage: metrics.stage,
    role: metrics.role,
    latencyMs: metrics.latencyMs,
    tokens: metrics.tokens,
    cost: metrics.cost,
    quarantine: metrics.quarantine,
    correction: metrics.correction || metrics.stage === "correction",
    retry:
      workflowAttempt.ordinal > 1 ||
      workflowAttempt.outcome === "transient-retry" ||
      metrics.stage === "retry",
  });
}

/**
 * Persist a complete artifact lineage. Each supplied workflow attempt produces
 * exactly one row, and duplicate physical identities are rejected before any
 * store write so callers cannot accidentally double-count retries.
 */
export async function persistQualifyingArtifactLineage(
  store: QualifyingAttemptTelemetryStore,
  policy: ResolvedRunPolicy,
  inputs: readonly QualifyingArtifactAttemptInput[],
): Promise<readonly QualifyingAttemptTelemetryRow[]> {
  const rows = inputs.map((input) => projectQualifyingArtifactAttempt(policy, input));
  const keys = rows.map(attemptKey);
  if (new Set(keys).size !== keys.length) {
    throw new Error("qualifying artifact lineage repeats a physical attempt");
  }
  for (const row of rows) await store.append(row);
  return rows;
}

export type QualifyingTelemetryCostTotal =
  | { readonly state: "confirmed"; readonly amountUsd: string }
  | {
      readonly state: "unknown";
      readonly confirmedAmountUsd: string;
      readonly unknownAttemptCount: number;
    };

export interface QualifyingTelemetryTotals {
  readonly physicalAttemptCount: number;
  readonly memoHitCount: number;
  readonly quarantineCount: number;
  readonly correctionCount: number;
  readonly retryCount: number;
  /** Null when any physical attempt lacks a measured latency. */
  readonly latencyMs: number | null;
  readonly tokens: {
    readonly input: number | null;
    readonly output: number | null;
    readonly cacheRead: number | null;
    readonly cacheWrite: number | null;
  };
  readonly cost: QualifyingTelemetryCostTotal;
  readonly byStage: Readonly<Record<AcceptanceAttemptStage, number>>;
}

/** The dashboard/JSON projection of persisted qualifying telemetry. */
export interface QualifyingTelemetryDashboard {
  readonly lineage: "qualifying";
  readonly attempts: readonly QualifyingAttemptTelemetryRow[];
  readonly totals: QualifyingTelemetryTotals;
}

/**
 * Build a content-free dashboard/JSON report. Every row participates in every
 * count; no stage, correction, retry, or repair path is filtered out. A single
 * unknown settlement changes the total's tagged state to `unknown` rather than
 * adding a fabricated zero.
 */
export function buildQualifyingTelemetryDashboard(
  telemetry: QualifyingScorecardTelemetry,
): QualifyingTelemetryDashboard {
  const parsed = QualifyingScorecardTelemetrySchema.parse(telemetry);
  let confirmedAmountUsd = "0";
  let unknownAttemptCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let latencyTotal = 0;
  let inputComplete = true;
  let outputComplete = true;
  let cacheReadComplete = true;
  let cacheWriteComplete = true;
  let latencyComplete = true;
  let memoHitCount = 0;
  let quarantineCount = 0;
  let correctionCount = 0;
  let retryCount = 0;
  const byStage = emptyStageTotals();

  for (const row of parsed.attempts) {
    byStage[row.stage] += 1;
    memoHitCount += row.memoHit ? 1 : 0;
    quarantineCount += row.quarantine ? 1 : 0;
    correctionCount += row.correction ? 1 : 0;
    retryCount += row.retry ? 1 : 0;
    if (row.cost.state === "confirmed") {
      confirmedAmountUsd = addDecimalUsd(confirmedAmountUsd, row.cost.amountUsd);
    } else {
      unknownAttemptCount += 1;
    }
    ({ total: inputTokens, complete: inputComplete } = addKnownToken(
      inputTokens,
      inputComplete,
      row.tokens.input,
    ));
    ({ total: outputTokens, complete: outputComplete } = addKnownToken(
      outputTokens,
      outputComplete,
      row.tokens.output,
    ));
    ({ total: cacheReadTokens, complete: cacheReadComplete } = addKnownToken(
      cacheReadTokens,
      cacheReadComplete,
      row.tokens.cacheRead,
    ));
    ({ total: cacheWriteTokens, complete: cacheWriteComplete } = addKnownToken(
      cacheWriteTokens,
      cacheWriteComplete,
      row.tokens.cacheWrite,
    ));
    ({ total: latencyTotal, complete: latencyComplete } = addKnownToken(
      latencyTotal,
      latencyComplete,
      row.latencyMs,
    ));
  }

  return {
    lineage: "qualifying",
    attempts: parsed.attempts,
    totals: {
      physicalAttemptCount: parsed.attempts.length,
      memoHitCount,
      quarantineCount,
      correctionCount,
      retryCount,
      latencyMs: latencyComplete ? latencyTotal : null,
      tokens: {
        input: inputComplete ? inputTokens : null,
        output: outputComplete ? outputTokens : null,
        cacheRead: cacheReadComplete ? cacheReadTokens : null,
        cacheWrite: cacheWriteComplete ? cacheWriteTokens : null,
      },
      cost:
        unknownAttemptCount === 0
          ? { state: "confirmed", amountUsd: confirmedAmountUsd }
          : { state: "unknown", confirmedAmountUsd, unknownAttemptCount },
      byStage,
    },
  };
}

/** Read and report the same rows that were persisted through the store port. */
export async function reportPersistedQualifyingTelemetry(
  store: QualifyingAttemptTelemetryStore,
): Promise<QualifyingTelemetryDashboard> {
  return buildQualifyingTelemetryDashboard({
    lineage: "qualifying",
    attempts: [...(await store.list())],
  });
}

function attemptKey(row: QualifyingAttemptTelemetryRow): string {
  return `${row.memoKey}:${row.attemptOrdinal}`;
}

function addKnownToken(
  total: number,
  complete: boolean,
  value: number | null,
): { total: number; complete: boolean } {
  return value === null ? { total, complete: false } : { total: total + value, complete };
}

function emptyStageTotals(): Record<AcceptanceAttemptStage, number> {
  return {
    "source-wiki": 0,
    "localized-bible": 0,
    draft: 0,
    review: 0,
    correction: 0,
    retry: 0,
    repair: 0,
    "build-lqa": 0,
    "feedback-enhancement": 0,
  };
}
