// ITOTORI-100 — Provider route reliability and cost report public surface.

import type { LocalizationJournalAttemptRecord } from "@itotori/db";
import type { JsonObject } from "../providers/types.js";
import type { ProviderLedgerEntry } from "./report.js";

export {
  CostAggregateDivergenceError,
  PROVIDER_ROUTE_REPORT_SCHEMA_VERSION,
  RouteReportReconciliationError,
  assertCostAggregateReconciled,
  assertRouteReportReconciled,
  microsToUsdDecimalString,
  reconcileRouteCost,
  renderProviderRouteReport,
  renderRouteReliability,
  renderStructuredOutputSupport,
  servedRouteKey,
  usdDecimalStringToMicros,
  type ProviderLedgerEntry,
  type ProviderRouteReliabilityReport,
  type ProviderRouteReliabilityRow,
  type ProviderRouteReliabilityTotals,
  type ProviderRouteReport,
  type ProviderRouteReportInput,
  type ProviderRouteServedKey,
  type ProviderRunStatus,
  type RouteCostReconciliationInput,
  type RouteCostReconciliationReport,
  type RouteCostReconciliationRow,
  type RouteReportFinding,
  type RouteReportFindingKind,
  type StructuredOutputModeOrNone,
  type StructuredOutputSupportReport,
  type StructuredOutputSupportReportRow,
  type StructuredOutputSupportRow,
} from "./report.js";

/**
 * Strip the `live:` / `recorded:` scheme prefix off a provider-proof id to
 * recover the run-id join key. This remains useful for recorded proof
 * fixtures; durable production reconciliation reads physical attempts from
 * the localization journal directly.
 */
export function ledgerRunIdFromProofId(providerProofId: string): string {
  const sep = providerProofId.indexOf(":");
  return sep >= 0 ? providerProofId.slice(sep + 1) : providerProofId;
}

/**
 * Adapt one durable localization-journal physical attempt into the
 * source-agnostic {@link ProviderLedgerEntry} the route-cost reconciler
 * consumes. Persisted token/cost facts are carried through untouched, so
 * reconciliation remains a cross-check of independent artifact and journal
 * records rather than a restatement of either one.
 *
 * The journal's `attemptId` is a physical-call identity, not the experiment
 * artifact's `ledgerId`, so `ledgerId` is left empty and `providerRunId` is
 * the sole join key. An empty `costUsd` is treated as a missing field so the
 * reconciler can name it.
 */
export function providerLedgerEntryFromJournalAttempt(
  entry: LocalizationJournalAttemptRecord,
): ProviderLedgerEntry {
  return {
    runId: entry.providerRunId,
    ledgerId: "",
    tokensIn: entry.tokensIn,
    tokensOut: entry.tokensOut,
    costAmountUsd:
      typeof entry.costUsd === "string" && entry.costUsd.length > 0 ? entry.costUsd : null,
    usageResponseJson: journalUsageResponseJson(entry.usageResponseJson),
  };
}

function journalUsageResponseJson(value: unknown | null): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as JsonObject;
}
