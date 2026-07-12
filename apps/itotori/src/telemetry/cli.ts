// ITOTORI-223 — `itotori:telemetry-summary` CLI handler.
//
// Two output modes:
//   - `--format json` (default): writes a TelemetrySummaryByPair as
//     JSON to `--output <path>`.
//   - `--format text`: writes a human-readable table to stdout AND
//     still writes the JSON to `--output <path>` so artifact paths
//     stay consistent. The text table is intended for `just`-style
//     interactive runs (e.g. operator looking at the daily cost
//     breakdown); the JSON file is the durable artifact.

import type { AuthorizationActor } from "@itotori/db";
import type {
  TelemetryCostKindRow,
  TelemetryPairKey,
  TelemetryPairSummary,
  TelemetryQuery,
  TelemetryServedProviderBreakdown,
  TelemetrySummaryByPair,
  TelemetryZdrEnforcedRow,
} from "./queries.js";

export type TelemetrySummaryCliArgs = {
  readonly actor: AuthorizationActor;
  readonly projectId: string;
  readonly from: Date;
  readonly to: Date;
  readonly outputPath: string;
  readonly groupByDay: boolean;
  readonly format: "json" | "text";
};

export type TelemetrySummaryCliDeps = {
  readonly telemetry: TelemetryQuery;
  readonly writeJson: (path: string, value: unknown) => void;
  readonly stdoutWrite: (line: string) => void;
};

export type TelemetrySummaryPostRunEvidence = {
  readonly zdr: {
    readonly invocationCount: number;
    readonly zdrEnforcedCount: number;
    readonly unenforcedCount: number;
    readonly allInvocationsZdrEnforced: boolean;
    readonly byPair: Record<
      TelemetryPairKey,
      {
        readonly invocationCount: number;
        readonly zdrEnforcedCount: number;
        readonly unenforcedCount: number;
      }
    >;
    readonly rows: TelemetryZdrEnforcedRow[];
  };
  readonly costKind: {
    readonly invocationCount: number;
    readonly billedCount: number;
    readonly nonBilledCount: number;
    readonly allInvocationsBilled: boolean;
    readonly byPair: Record<
      TelemetryPairKey,
      {
        readonly billed: number;
        readonly zero: number;
        readonly amountMicrosUsd: number;
      }
    >;
    readonly rows: TelemetryCostKindRow[];
  };
};

export type TelemetrySummaryCliOutput = TelemetrySummaryByPair & {
  readonly metadata: {
    readonly projectId: string;
    readonly window: {
      readonly from: string;
      readonly to: string;
    };
    readonly generatedAt: string;
  };
  readonly postRunEvidence: TelemetrySummaryPostRunEvidence;
  /**
   * telemetry-served-provider-breakdown — real served-provider cost
   * split, ADDITIVE to the requested-pair `byPair` (which the verifier
   * depends on). Present only when sourced from provider-run artifacts
   * (the served upstream provider is captured per invocation there); the
   * DB-backed CLI path omits it because the ledger keys on the requested
   * pair and has no served-provider column.
   */
  readonly servedProviderBreakdown?: TelemetryServedProviderBreakdown;
};

/**
 * Assemble the final `TelemetrySummaryCliOutput` from already-aggregated
 * per-pair rows. The DB-backed CLI path and the provider-run-artifact
 * path (UTSUSHI-231) both funnel through here so the output shape — the
 * metadata envelope + `postRunEvidence` — is produced in exactly ONE
 * place regardless of where the rows were sourced.
 */
export function assembleTelemetrySummaryOutput(input: {
  readonly projectId: string;
  readonly from: Date;
  readonly to: Date;
  readonly generatedAt: Date;
  readonly summary: TelemetrySummaryByPair;
  readonly zdrRows: ReadonlyArray<TelemetryZdrEnforcedRow>;
  readonly costKindRows: ReadonlyArray<TelemetryCostKindRow>;
  readonly servedProviderBreakdown?: TelemetryServedProviderBreakdown;
}): TelemetrySummaryCliOutput {
  return {
    metadata: {
      projectId: input.projectId,
      window: {
        from: input.from.toISOString(),
        to: input.to.toISOString(),
      },
      generatedAt: input.generatedAt.toISOString(),
    },
    ...input.summary,
    postRunEvidence: buildPostRunEvidence(input.zdrRows, input.costKindRows),
    ...(input.servedProviderBreakdown === undefined
      ? {}
      : { servedProviderBreakdown: input.servedProviderBreakdown }),
  };
}

export async function runTelemetrySummaryCli(
  args: TelemetrySummaryCliArgs,
  deps: TelemetrySummaryCliDeps,
): Promise<void> {
  const summary = await deps.telemetry.sumByPair(
    args.actor,
    args.projectId,
    { from: args.from, to: args.to },
    { groupByDay: args.groupByDay },
  );
  const [zdrRows, costKindRows] = await Promise.all([
    deps.telemetry.countZdrEnforcedCallsByPair(args.actor, args.projectId, {
      from: args.from,
      to: args.to,
    }),
    deps.telemetry.countCostKindsByPair(args.actor, args.projectId, {
      from: args.from,
      to: args.to,
    }),
  ]);
  const output = assembleTelemetrySummaryOutput({
    projectId: args.projectId,
    from: args.from,
    to: args.to,
    generatedAt: new Date(),
    summary,
    zdrRows,
    costKindRows,
  });

  deps.writeJson(args.outputPath, output);

  if (args.format === "text") {
    for (const line of renderTextSummary(
      summary,
      {
        projectId: args.projectId,
        from: args.from,
        to: args.to,
      },
      output.postRunEvidence,
    )) {
      deps.stdoutWrite(`${line}\n`);
    }
  }
}

export type TextSummaryHeader = {
  readonly projectId: string;
  readonly from: Date;
  readonly to: Date;
};

export function renderTextSummary(
  summary: TelemetrySummaryByPair,
  header: TextSummaryHeader,
  evidence?: TelemetrySummaryPostRunEvidence,
): string[] {
  const lines: string[] = [];
  lines.push(
    `telemetry-summary project=${header.projectId} from=${header.from.toISOString()} to=${header.to.toISOString()}`,
  );
  lines.push(`total_cost_usd=${summary.totalCostUsd}`);
  // ITOTORI-233 — cache_savings_usd is the SUM of
  // `cache_discount_micros_usd / 1_000_000` across every pair in the
  // window, sourced verbatim from `usage.cost_details.cache_discount`
  // (never derived from token counts × pricing). Satisfies the
  // acceptance criterion:
  //   "apps/itotori/src/telemetry/cli.ts prints cache_savings_usd=<real>
  //    for the window"
  // A pre-0078 row has no cache facts. Do not render its captured-only sum
  // as proof that the unobserved call had zero cache activity.
  lines.push(
    summary.cacheFactsAvailability === "complete"
      ? `cache_savings_usd=${summary.cacheSavingsUsd}`
      : `cache_savings_usd=unavailable captured_invocations=${summary.cacheFactsCapturedInvocationCount}`,
  );
  if (evidence !== undefined) {
    lines.push(
      `zdr_enforced_count=${evidence.zdr.zdrEnforcedCount} invocation_count=${evidence.zdr.invocationCount} all_zdr_enforced=${evidence.zdr.allInvocationsZdrEnforced}`,
    );
    lines.push(
      `billed_cost_kind_count=${evidence.costKind.billedCount} non_billed_cost_kind_count=${evidence.costKind.nonBilledCount} all_cost_kinds_billed=${evidence.costKind.allInvocationsBilled}`,
    );
  }
  lines.push("");
  lines.push(
    "pair | invocations | cost_usd | cache_hits | cache_savings_usd | tokens_in | tokens_out | avg_latency_ms | p95_latency_ms",
  );
  lines.push("---");
  const entries = Object.entries(summary.byPair) as Array<[TelemetryPairKey, TelemetryPairSummary]>;
  if (entries.length === 0) {
    lines.push("(no entries in window)");
  } else {
    for (const [pair, row] of entries) {
      lines.push(
        [
          pair,
          row.invocationCount.toString(),
          row.totalCostUsd,
          row.cacheFactsAvailability === "complete"
            ? row.cacheHitCount.toString()
            : `unavailable/${row.cacheFactsCapturedInvocationCount}`,
          row.cacheFactsAvailability === "complete" ? row.cacheSavingsUsd : "unavailable",
          row.totalTokensIn.toString(),
          row.totalTokensOut.toString(),
          row.avgLatencyMs.toFixed(2),
          row.p95LatencyMs.toFixed(2),
        ].join(" | "),
      );
    }
  }
  if (summary.byDay !== undefined) {
    lines.push("");
    lines.push("by_day:");
    const days = Object.keys(summary.byDay).sort();
    for (const day of days) {
      const dayEntry = summary.byDay[day];
      if (dayEntry === undefined) continue;
      lines.push(`  ${day} total_cost_usd=${dayEntry.totalCostUsd}`);
      const dayEntries = Object.entries(dayEntry.byPair) as Array<
        [TelemetryPairKey, TelemetryPairSummary]
      >;
      for (const [pair, row] of dayEntries) {
        lines.push(`    ${pair} invocations=${row.invocationCount} cost_usd=${row.totalCostUsd}`);
      }
    }
  }
  return lines;
}

export function buildPostRunEvidence(
  zdrRows: ReadonlyArray<TelemetryZdrEnforcedRow>,
  costKindRows: ReadonlyArray<TelemetryCostKindRow>,
): TelemetrySummaryPostRunEvidence {
  const zdrByPair: TelemetrySummaryPostRunEvidence["zdr"]["byPair"] = {};
  let invocationCount = 0;
  let zdrEnforcedCount = 0;
  for (const row of zdrRows) {
    const unenforcedCount = row.invocationCount - row.zdrEnforcedCount;
    zdrByPair[row.pair] = {
      invocationCount: row.invocationCount,
      zdrEnforcedCount: row.zdrEnforcedCount,
      unenforcedCount,
    };
    invocationCount += row.invocationCount;
    zdrEnforcedCount += row.zdrEnforcedCount;
  }

  type MutableCostKindPairSummary = {
    billed: number;
    zero: number;
    amountMicrosUsd: number;
  };
  const costByPair: Record<TelemetryPairKey, MutableCostKindPairSummary> = {};
  let costKindInvocationCount = 0;
  let billedCount = 0;
  let nonBilledCount = 0;
  for (const row of costKindRows) {
    const existing = costByPair[row.pair] ?? {
      billed: 0,
      zero: 0,
      amountMicrosUsd: 0,
    };
    if (row.costKind === "billed") {
      existing.billed += row.invocationCount;
      billedCount += row.invocationCount;
    } else {
      existing.zero += row.invocationCount;
      nonBilledCount += row.invocationCount;
    }
    existing.amountMicrosUsd += row.amountMicrosUsd;
    costByPair[row.pair] = existing;
    costKindInvocationCount += row.invocationCount;
  }

  return {
    zdr: {
      invocationCount,
      zdrEnforcedCount,
      unenforcedCount: invocationCount - zdrEnforcedCount,
      allInvocationsZdrEnforced: invocationCount > 0 && invocationCount === zdrEnforcedCount,
      byPair: zdrByPair,
      rows: [...zdrRows],
    },
    costKind: {
      invocationCount: costKindInvocationCount,
      billedCount,
      nonBilledCount,
      allInvocationsBilled: costKindInvocationCount > 0 && nonBilledCount === 0,
      byPair: costByPair,
      rows: [...costKindRows],
    },
  };
}

export function parseTelemetrySummaryCliFlags(args: ReadonlyArray<string>): {
  projectId: string;
  from: Date;
  to: Date;
  outputPath: string;
  groupByDay: boolean;
  format: "json" | "text";
} {
  const projectId = requireFlag(args, "--project");
  const fromRaw = requireFlag(args, "--from");
  const toRaw = requireFlag(args, "--to");
  const outputPath = requireFlag(args, "--output");
  const groupByDay = args.includes("--group-by-day");
  const formatRaw = optionalFlag(args, "--format") ?? "json";
  if (formatRaw !== "json" && formatRaw !== "text") {
    throw new Error(`unknown --format value: ${formatRaw} (expected json or text)`);
  }
  const from = parseIsoDate(fromRaw, "--from");
  const to = parseIsoDate(toRaw, "--to");
  if (from.getTime() > to.getTime()) {
    throw new Error(`--from (${fromRaw}) must not be after --to (${toRaw})`);
  }
  return { projectId, from, to, outputPath, groupByDay, format: formatRaw };
}

/**
 * UTSUSHI-231 — flags for the provider-run-artifact telemetry source.
 * Distinct from {@link parseTelemetrySummaryCliFlags} (the DB path):
 * `--from`/`--to` are OPTIONAL because the window is derived from the
 * artifacts' own timestamps when omitted. `--provider-runs-dir` selects
 * this source.
 */
export function parseTelemetrySummaryProviderRunFlags(args: ReadonlyArray<string>): {
  projectId: string;
  providerRunsDir: string;
  outputPath: string;
  from?: Date;
  to?: Date;
  format: "json" | "text";
} {
  const projectId = requireFlag(args, "--project");
  const providerRunsDir = requireFlag(args, "--provider-runs-dir");
  const outputPath = requireFlag(args, "--output");
  const fromRaw = optionalFlag(args, "--from");
  const toRaw = optionalFlag(args, "--to");
  const formatRaw = optionalFlag(args, "--format") ?? "json";
  if (formatRaw !== "json" && formatRaw !== "text") {
    throw new Error(`unknown --format value: ${formatRaw} (expected json or text)`);
  }
  const from = fromRaw === undefined ? undefined : parseIsoDate(fromRaw, "--from");
  const to = toRaw === undefined ? undefined : parseIsoDate(toRaw, "--to");
  if (from !== undefined && to !== undefined && from.getTime() > to.getTime()) {
    throw new Error(`--from (${String(fromRaw)}) must not be after --to (${String(toRaw)})`);
  }
  const out: {
    projectId: string;
    providerRunsDir: string;
    outputPath: string;
    from?: Date;
    to?: Date;
    format: "json" | "text";
  } = { projectId, providerRunsDir, outputPath, format: formatRaw };
  if (from !== undefined) out.from = from;
  if (to !== undefined) out.to = to;
  return out;
}

function requireFlag(args: ReadonlyArray<string>, name: string): string {
  const index = args.indexOf(name);
  const value = args[index + 1];
  if (index < 0 || !value) {
    throw new Error(`missing required flag ${name}`);
  }
  return value;
}

function optionalFlag(args: ReadonlyArray<string>, name: string): string | undefined {
  const index = args.indexOf(name);
  const value = args[index + 1];
  return index >= 0 && value ? value : undefined;
}

function parseIsoDate(raw: string, flag: string): Date {
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${flag} value ${raw} is not a valid ISO date string`);
  }
  return parsed;
}
