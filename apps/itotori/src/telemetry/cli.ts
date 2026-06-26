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
  TelemetryPairKey,
  TelemetryPairSummary,
  TelemetryQuery,
  TelemetrySummaryByPair,
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

  deps.writeJson(args.outputPath, summary);

  if (args.format === "text") {
    for (const line of renderTextSummary(summary, {
      projectId: args.projectId,
      from: args.from,
      to: args.to,
    })) {
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
  // The line is always emitted (zero when no caching hit landed in the
  // window) so the dashboard can render a deterministic row.
  lines.push(`cache_savings_usd=${summary.cacheSavingsUsd}`);
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
          row.cacheHitCount.toString(),
          row.cacheSavingsUsd,
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
