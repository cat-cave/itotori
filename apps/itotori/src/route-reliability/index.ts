// ITOTORI-100 — Provider route reliability and cost report public surface.

import type { DraftAttemptProviderLedgerEntry } from "@itotori/db";
import type { JsonObject } from "../providers/types.js";
import type { ProviderLedgerEntry } from "./report.js";

export {
  PROVIDER_ROUTE_REPORT_SCHEMA_VERSION,
  RouteReportReconciliationError,
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
 * Strip the `live:` / `recorded:` scheme prefix off a provider-ledger
 * `providerProofId` to recover the join key. For a LIVE row the recorder
 * writes `live:<runId>` (see draft/draft-attempt-recorder.ts), so the
 * recovered value IS the `runId` that {@link ProviderLedgerEntry.runId}
 * reconciles against {@link ExperimentInvocationArtifact.runId}.
 */
export function ledgerRunIdFromProofId(providerProofId: string): string {
  const sep = providerProofId.indexOf(":");
  return sep >= 0 ? providerProofId.slice(sep + 1) : providerProofId;
}

/**
 * Adapt a REAL provider-ledger row (the DB `itotori_draft_attempt_provider_ledger`
 * shape) into the source-agnostic {@link ProviderLedgerEntry} the route
 * cost reconciler consumes. This is how ITOTORI-100 "consumes the provider
 * ledger": the persisted token/cost facts are carried through UNTOUCHED so
 * reconciliation is a genuine cross-check of two independent sources, not a
 * restatement of one.
 *
 * The DB ledger keys on its own `ledgerEntryId`, NOT the experiment
 * `ledgerId`, so `ledgerId` is left `""` and the runId (recovered from
 * `providerProofId`) is the sole join key. `cost_amount` is non-NULL at the
 * schema level; an empty string is treated as a MISSING field so the
 * reconciler can name it.
 */
export function providerLedgerEntryFromDraftAttempt(
  entry: DraftAttemptProviderLedgerEntry,
): ProviderLedgerEntry {
  return {
    runId: ledgerRunIdFromProofId(entry.providerProofId),
    ledgerId: "",
    tokensIn: entry.tokensIn,
    tokensOut: entry.tokensOut,
    costAmountUsd:
      typeof entry.costAmount === "string" && entry.costAmount.length > 0 ? entry.costAmount : null,
    usageResponseJson: entry.usageResponseJson as JsonObject,
  };
}
