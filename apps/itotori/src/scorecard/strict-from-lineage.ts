// Strict scorecard generator — content-free qualifying lineage → totals.
//
// Consumes the persisted qualifying artifact-lineage ledger (one immutable
// row per physical attempt) and projects a deterministic scorecard: overall
// totals plus attempts / cost / latency / tokens / memo-hit per stage+role.
//
// Cost aggregation preserves the tagged unknown settlement: a single
// unknown-cost attempt flips the bucket (and the overall total) to
// `state: "unknown"` rather than silently treating the amount as zero.
// Token and latency aggregates are null when any contributing attempt lacks
// a measured value — null is not a fabricated zero.
//
// This module is pure and model-free. The scorecard over a real terminal
// run (live provider receipts) is a downstream live-lane input; see
// `LIVE_TERMINAL_RUN_SCORECARD_FOLLOW_UP`.

import {
  AcceptanceAttemptStageSchema,
  QualifyingScorecardTelemetrySchema,
  RoleIdSchema,
  type AcceptanceAttemptStage,
  type QualifyingArtifactAttemptTelemetry,
  type QualifyingScorecardTelemetry,
  type RoleId,
} from "../contracts/index.js";
import { addDecimalUsd } from "../llm/decimal-usd.js";
import type { QualifyingAttemptTelemetryStore } from "../telemetry/qualifying-lineage.js";

export const STRICT_SCORECARD_SCHEMA_VERSION = "itotori.strict-scorecard.v1" as const;

/** Real-run scorecard inputs land after a live terminal run; this core is offline. */
export const LIVE_TERMINAL_RUN_SCORECARD_FOLLOW_UP = "downstream-live-lane" as const;

export type StrictScorecardCostTotal =
  | { readonly state: "confirmed"; readonly amountUsd: string }
  | {
      readonly state: "unknown";
      readonly confirmedAmountUsd: string;
      readonly unknownAttemptCount: number;
    };

export type StrictScorecardTokenTotal = {
  readonly input: number | null;
  readonly output: number | null;
  readonly cacheRead: number | null;
  readonly cacheWrite: number | null;
};

/** Totals for one (stage, role) bucket or the overall scorecard. */
export type StrictScorecardTotals = {
  readonly attempts: number;
  readonly memoHitCount: number;
  readonly latencyMs: number | null;
  readonly tokens: StrictScorecardTokenTotal;
  readonly cost: StrictScorecardCostTotal;
};

export type StrictScorecardStageRoleBucket = StrictScorecardTotals & {
  readonly stage: AcceptanceAttemptStage;
  readonly role: RoleId;
};

/**
 * Deterministic strict scorecard projection of a qualifying lineage.
 * Buckets are sorted by stage then role; empty stage+role pairs are omitted.
 */
export type StrictScorecard = {
  readonly schemaVersion: typeof STRICT_SCORECARD_SCHEMA_VERSION;
  readonly lineage: "qualifying";
  readonly totals: StrictScorecardTotals;
  readonly byStageRole: readonly StrictScorecardStageRoleBucket[];
  /** The real terminal-run scorecard is a live-lane follow-up, not this core. */
  readonly liveTerminalRunScorecard: typeof LIVE_TERMINAL_RUN_SCORECARD_FOLLOW_UP;
};

type MutableCost = {
  confirmedAmountUsd: string;
  unknownAttemptCount: number;
};

type MutableTokens = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  inputComplete: boolean;
  outputComplete: boolean;
  cacheReadComplete: boolean;
  cacheWriteComplete: boolean;
};

type MutableBucket = {
  attempts: number;
  memoHitCount: number;
  latencyMs: number;
  latencyComplete: boolean;
  tokens: MutableTokens;
  cost: MutableCost;
};

/**
 * Build the strict scorecard from a qualifying artifact-lineage ledger.
 * Input is validated against the content-free scorecard telemetry contract;
 * output is a pure function of the rows (stable sort, lossless cost sum).
 */
export function buildStrictScorecardFromLineage(
  telemetry: QualifyingScorecardTelemetry | QualifyingScorecardTelemetry["attempts"],
): StrictScorecard {
  const parsed = normalizeLineage(telemetry);
  const overall = emptyBucket();
  const buckets = new Map<string, MutableBucket>();

  for (const row of parsed.attempts) {
    accumulate(overall, row);
    const key = stageRoleKey(row.stage, row.role);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = emptyBucket();
      buckets.set(key, bucket);
    }
    accumulate(bucket, row);
  }

  const byStageRole = [...buckets.entries()]
    .map(([key, bucket]) => {
      const [stage, role] = splitStageRoleKey(key);
      return {
        stage,
        role,
        ...freezeTotals(bucket),
      };
    })
    .sort(compareStageRole);

  return {
    schemaVersion: STRICT_SCORECARD_SCHEMA_VERSION,
    lineage: "qualifying",
    totals: freezeTotals(overall),
    byStageRole,
    liveTerminalRunScorecard: LIVE_TERMINAL_RUN_SCORECARD_FOLLOW_UP,
  };
}

/**
 * Project the strict scorecard from a persisted qualifying-lineage store
 * (content-free ledger). Same pure totals as
 * {@link buildStrictScorecardFromLineage}; the store is the durable input.
 */
export async function buildStrictScorecardFromPersistedLineage(
  store: QualifyingAttemptTelemetryStore,
): Promise<StrictScorecard> {
  return buildStrictScorecardFromLineage({
    lineage: "qualifying",
    attempts: [...(await store.list())],
  });
}

function normalizeLineage(
  telemetry: QualifyingScorecardTelemetry | QualifyingScorecardTelemetry["attempts"],
): QualifyingScorecardTelemetry {
  if (Array.isArray(telemetry)) {
    return QualifyingScorecardTelemetrySchema.parse({
      lineage: "qualifying",
      attempts: telemetry,
    });
  }
  return QualifyingScorecardTelemetrySchema.parse(telemetry);
}

function emptyBucket(): MutableBucket {
  return {
    attempts: 0,
    memoHitCount: 0,
    latencyMs: 0,
    latencyComplete: true,
    tokens: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      inputComplete: true,
      outputComplete: true,
      cacheReadComplete: true,
      cacheWriteComplete: true,
    },
    cost: { confirmedAmountUsd: "0", unknownAttemptCount: 0 },
  };
}

function accumulate(bucket: MutableBucket, row: QualifyingArtifactAttemptTelemetry): void {
  bucket.attempts += 1;
  bucket.memoHitCount += row.memoHit ? 1 : 0;
  if (row.cost.state === "confirmed") {
    bucket.cost.confirmedAmountUsd = addDecimalUsd(
      bucket.cost.confirmedAmountUsd,
      row.cost.amountUsd,
    );
  } else {
    bucket.cost.unknownAttemptCount += 1;
  }
  if (row.latencyMs === null) {
    bucket.latencyComplete = false;
  } else {
    bucket.latencyMs += row.latencyMs;
  }
  addToken(bucket.tokens, "input", row.tokens.input);
  addToken(bucket.tokens, "output", row.tokens.output);
  addToken(bucket.tokens, "cacheRead", row.tokens.cacheRead);
  addToken(bucket.tokens, "cacheWrite", row.tokens.cacheWrite);
}

function addToken(
  tokens: MutableTokens,
  field: "input" | "output" | "cacheRead" | "cacheWrite",
  value: number | null,
): void {
  const completeKey = `${field}Complete` as const;
  if (value === null) {
    tokens[completeKey] = false;
    return;
  }
  tokens[field] += value;
}

function freezeTotals(bucket: MutableBucket): StrictScorecardTotals {
  const { cost, tokens } = bucket;
  return {
    attempts: bucket.attempts,
    memoHitCount: bucket.memoHitCount,
    latencyMs: bucket.latencyComplete ? bucket.latencyMs : null,
    tokens: {
      input: tokens.inputComplete ? tokens.input : null,
      output: tokens.outputComplete ? tokens.output : null,
      cacheRead: tokens.cacheReadComplete ? tokens.cacheRead : null,
      cacheWrite: tokens.cacheWriteComplete ? tokens.cacheWrite : null,
    },
    cost:
      cost.unknownAttemptCount === 0
        ? { state: "confirmed", amountUsd: cost.confirmedAmountUsd }
        : {
            state: "unknown",
            confirmedAmountUsd: cost.confirmedAmountUsd,
            unknownAttemptCount: cost.unknownAttemptCount,
          },
  };
}

function stageRoleKey(stage: AcceptanceAttemptStage, role: RoleId): string {
  return `${stage}\0${role}`;
}

function splitStageRoleKey(key: string): [AcceptanceAttemptStage, RoleId] {
  const sep = key.indexOf("\0");
  const stage = AcceptanceAttemptStageSchema.parse(key.slice(0, sep));
  const role = RoleIdSchema.parse(key.slice(sep + 1));
  return [stage, role];
}

const STAGE_ORDER = new Map(
  AcceptanceAttemptStageSchema.options.map((stage, index) => [stage, index] as const),
);
const ROLE_ORDER = new Map(RoleIdSchema.options.map((role, index) => [role, index] as const));

function compareStageRole(
  left: StrictScorecardStageRoleBucket,
  right: StrictScorecardStageRoleBucket,
): number {
  const stageDelta = (STAGE_ORDER.get(left.stage) ?? 0) - (STAGE_ORDER.get(right.stage) ?? 0);
  if (stageDelta !== 0) return stageDelta;
  return (ROLE_ORDER.get(left.role) ?? 0) - (ROLE_ORDER.get(right.role) ?? 0);
}
