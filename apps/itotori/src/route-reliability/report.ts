// ITOTORI-100 — Provider route reliability and cost report renderer.
//
// CONSUMES the ITOTORI-099 experiment matrix artifacts
// (`ExperimentInvocationArtifact`, each carrying runId / ledgerId / a
// `providerRun` block of reliability + cost facts + routingPosture) and
// localization journal's physical-attempt records (adapted via
// {@link providerLedgerEntryFromJournalAttempt}). It renders four things the
// ITOTORI-100 acceptance requires:
//
//   1. PROVIDER ROUTE RELIABILITY — success / failure / retry / fallback /
//      structured-output support aggregated BY THE REAL SERVED (provider,
//      model) route, NOT the requested pair. OpenRouter-side automatic
//      fallback (ITOTORI-241/243) means the served upstream provider may
//      differ from the one the request preferred; we record the TRUTH —
//      `providerRun.upstreamProvider` (the served upstream) + `actualModelId`
//      (the served model) — and keep the requested pair alongside so a
//      served≠requested divergence is visible rather than pinned away. A
//      ZDR-confined fallback serve is DATA, never an error.
//
//   2. FALLBACK + RETRY SUMMARY — per served route: how many invocations
//      retried (and the total retry count), how many used OR-side fallback,
//      and the distinct fallback plans observed.
//
//   3. STRUCTURED-OUTPUT SUPPORT — per (served route, structured-output
//      mode): how many invocations requested the mode and how many the
//      served route actually completed, so a route that cannot honour a
//      structured-output mode is visible as a sub-100% support rate.
//
//   4. COST RECONCILIATION — every artifact's REAL captured cost
//      (`providerRun.cost`, sourced verbatim from the replayed/served
//      response) is CROSS-CHECKED against the provider ledger's
//      independently-persisted token/cost facts for the same runId. The
//      report restates neither side blindly: it asserts the artifact cost,
//      the ledger `cost_amount`, and the ledger `usage.cost` all AGREE
//      within 1e-9 USD, and that token counts match. A missing ledger field
//      or a mismatch is a STRUCTURED FINDING naming the run id and field —
//      never a silent skip (PROJECT LAW).
//
// COST/TOKENS come ONLY from the real artifacts + ledger. The only
// arithmetic is integer micros↔USD (`/1e6`); no cost is ever fabricated,
// hardcoded, or approximated. `node scripts/audit-no-hardcoded-cost.mjs`
// stays exit 0.
//
// The renderer reads ONLY ids / hashes / counts / statuses / modes /
// provider names / verbatim cost+token numbers — never raw prompt or
// response text or credentials (the artifacts carry none by construction;
// see ExperimentArtifactRedaction). Reports are safe for public fixtures.

import type { ExperimentInvocationArtifact } from "../experiment-matrix/runner.js";
import type { JsonObject, StructuredOutputMode } from "../providers/types.js";
import { canonicalServedProviderId } from "../telemetry/provider-run-artifact-source.js";

export const PROVIDER_ROUTE_REPORT_SCHEMA_VERSION = "itotori.provider_route_report.v0.1" as const;

/** Two billed-cost values agree when they differ by less than this (USD). */
const COST_EPSILON_USD = 1e-9;

export type ProviderRunStatus = "succeeded" | "failed" | "partial" | "skipped";
export type StructuredOutputModeOrNone = StructuredOutputMode | "none";

/**
 * Stable key for the REAL SERVED route: `${servedProvider}::${servedModel}`.
 * `servedProvider` is the canonicalized `providerRun.upstreamProvider`
 * (the upstream OR actually served through), falling to the
 * `unknown-served-provider` sentinel when the artifact captured no
 * upstream; `servedModel` is `providerRun.actualModelId`. This is the truth
 * of where the call landed — NOT the requested pin.
 */
export type ProviderRouteServedKey = `${string}::${string}`;

export function servedRouteKey(artifact: ExperimentInvocationArtifact): ProviderRouteServedKey {
  const provider = canonicalServedProviderId(artifact.providerRun.upstreamProvider);
  const model = artifact.providerRun.actualModelId;
  return `${provider}::${model}`;
}

/** The requested (model:provider) pair the artifact pinned, for divergence. */
function requestedPairLabel(artifact: ExperimentInvocationArtifact): string {
  return `${artifact.providerRun.requestedModelId}:${artifact.providerRun.requestedProviderId}`;
}

// ─────────────────────────────────────────────────────────────────────────
// 1 + 2. Reliability + fallback/retry, keyed by served route.
// ─────────────────────────────────────────────────────────────────────────

export type StructuredOutputSupportRow = {
  readonly mode: StructuredOutputModeOrNone;
  readonly requestedCount: number;
  readonly succeededCount: number;
};

export type ProviderRouteReliabilityRow = {
  readonly servedProvider: string;
  readonly servedModel: string;
  /**
   * Distinct requested (model:provider) pairs that ROUTED to this served
   * route, sorted. When this lists a pair whose provider differs from
   * `servedProvider`, OR-side fallback served a different upstream — the
   * report SHOWS that divergence instead of pinning it away.
   */
  readonly requestedPairs: readonly string[];
  readonly servedDivergesFromRequested: boolean;
  readonly invocationCount: number;
  readonly succeededCount: number;
  readonly failedCount: number;
  readonly partialCount: number;
  readonly skippedCount: number;
  /** Invocations with `retryCount > 0`. */
  readonly retriedInvocationCount: number;
  /** SUM of `retryCount` over the route. */
  readonly totalRetryCount: number;
  /** Invocations with `fallbackUsed === true` (OR-side resilience, DATA not error). */
  readonly fallbackInvocationCount: number;
  /** Distinct non-empty `fallbackPlan` chains observed, sorted, as `a>b>c`. */
  readonly fallbackPlans: readonly string[];
  /** Invocations whose captured routing posture had `zdr === true`. */
  readonly zdrEnforcedCount: number;
  /** Per-mode structured-output support, sorted by mode. */
  readonly structuredOutputSupport: readonly StructuredOutputSupportRow[];
};

export type ProviderRouteReliabilityTotals = {
  readonly invocationCount: number;
  readonly succeededCount: number;
  readonly failedCount: number;
  readonly partialCount: number;
  readonly skippedCount: number;
  readonly retriedInvocationCount: number;
  readonly totalRetryCount: number;
  readonly fallbackInvocationCount: number;
  readonly zdrEnforcedCount: number;
};

export type ProviderRouteReliabilityReport = {
  readonly schemaVersion: typeof PROVIDER_ROUTE_REPORT_SCHEMA_VERSION;
  readonly section: "reliability";
  readonly experimentId: string;
  readonly generatedAt: string;
  readonly byServedRoute: Record<ProviderRouteServedKey, ProviderRouteReliabilityRow>;
  readonly totals: ProviderRouteReliabilityTotals;
};

type MutableReliabilityAcc = {
  servedProvider: string;
  servedModel: string;
  requestedPairs: Set<string>;
  invocationCount: number;
  succeededCount: number;
  failedCount: number;
  partialCount: number;
  skippedCount: number;
  retriedInvocationCount: number;
  totalRetryCount: number;
  fallbackInvocationCount: number;
  fallbackPlans: Set<string>;
  zdrEnforcedCount: number;
  // mode -> { requested, succeeded }
  structuredOutput: Map<StructuredOutputModeOrNone, { requested: number; succeeded: number }>;
};

export type ProviderRouteReportInput = {
  readonly experimentId: string;
  /** Caller-supplied for determinism — the renderer never reads the clock. */
  readonly generatedAt: string;
  readonly artifacts: readonly ExperimentInvocationArtifact[];
};

export function renderRouteReliability(
  input: ProviderRouteReportInput,
): ProviderRouteReliabilityReport {
  const accByKey = new Map<ProviderRouteServedKey, MutableReliabilityAcc>();

  for (const artifact of input.artifacts) {
    const run = artifact.providerRun;
    const key = servedRouteKey(artifact);
    const acc =
      accByKey.get(key) ??
      ({
        servedProvider: canonicalServedProviderId(run.upstreamProvider),
        servedModel: run.actualModelId,
        requestedPairs: new Set<string>(),
        invocationCount: 0,
        succeededCount: 0,
        failedCount: 0,
        partialCount: 0,
        skippedCount: 0,
        retriedInvocationCount: 0,
        totalRetryCount: 0,
        fallbackInvocationCount: 0,
        fallbackPlans: new Set<string>(),
        zdrEnforcedCount: 0,
        structuredOutput: new Map(),
      } satisfies MutableReliabilityAcc);

    acc.requestedPairs.add(requestedPairLabel(artifact));
    acc.invocationCount += 1;
    switch (run.status) {
      case "succeeded":
        acc.succeededCount += 1;
        break;
      case "failed":
        acc.failedCount += 1;
        break;
      case "partial":
        acc.partialCount += 1;
        break;
      case "skipped":
        acc.skippedCount += 1;
        break;
    }
    if (run.retryCount > 0) acc.retriedInvocationCount += 1;
    acc.totalRetryCount += run.retryCount;
    if (run.fallbackUsed) acc.fallbackInvocationCount += 1;
    if (run.fallbackPlan.length > 0) acc.fallbackPlans.add(run.fallbackPlan.join(">"));
    if (run.routingPosture.zdr === true) acc.zdrEnforcedCount += 1;

    const mode = run.structuredOutputMode;
    const so = acc.structuredOutput.get(mode) ?? { requested: 0, succeeded: 0 };
    so.requested += 1;
    if (run.status === "succeeded") so.succeeded += 1;
    acc.structuredOutput.set(mode, so);

    accByKey.set(key, acc);
  }

  const byServedRoute: Record<ProviderRouteServedKey, ProviderRouteReliabilityRow> = {};
  const totals: {
    invocationCount: number;
    succeededCount: number;
    failedCount: number;
    partialCount: number;
    skippedCount: number;
    retriedInvocationCount: number;
    totalRetryCount: number;
    fallbackInvocationCount: number;
    zdrEnforcedCount: number;
  } = {
    invocationCount: 0,
    succeededCount: 0,
    failedCount: 0,
    partialCount: 0,
    skippedCount: 0,
    retriedInvocationCount: 0,
    totalRetryCount: 0,
    fallbackInvocationCount: 0,
    zdrEnforcedCount: 0,
  };

  for (const key of [...accByKey.keys()].sort()) {
    const acc = accByKey.get(key)!;
    const requestedPairs = [...acc.requestedPairs].sort();
    const servedDivergesFromRequested = requestedPairs.some(
      (pair) => providerOfPair(pair) !== acc.servedProvider,
    );
    byServedRoute[key] = {
      servedProvider: acc.servedProvider,
      servedModel: acc.servedModel,
      requestedPairs,
      servedDivergesFromRequested,
      invocationCount: acc.invocationCount,
      succeededCount: acc.succeededCount,
      failedCount: acc.failedCount,
      partialCount: acc.partialCount,
      skippedCount: acc.skippedCount,
      retriedInvocationCount: acc.retriedInvocationCount,
      totalRetryCount: acc.totalRetryCount,
      fallbackInvocationCount: acc.fallbackInvocationCount,
      fallbackPlans: [...acc.fallbackPlans].sort(),
      zdrEnforcedCount: acc.zdrEnforcedCount,
      structuredOutputSupport: [...acc.structuredOutput.keys()].sort().map((mode) => {
        const so = acc.structuredOutput.get(mode)!;
        return { mode, requestedCount: so.requested, succeededCount: so.succeeded };
      }),
    };
    totals.invocationCount += acc.invocationCount;
    totals.succeededCount += acc.succeededCount;
    totals.failedCount += acc.failedCount;
    totals.partialCount += acc.partialCount;
    totals.skippedCount += acc.skippedCount;
    totals.retriedInvocationCount += acc.retriedInvocationCount;
    totals.totalRetryCount += acc.totalRetryCount;
    totals.fallbackInvocationCount += acc.fallbackInvocationCount;
    totals.zdrEnforcedCount += acc.zdrEnforcedCount;
  }

  return {
    schemaVersion: PROVIDER_ROUTE_REPORT_SCHEMA_VERSION,
    section: "reliability",
    experimentId: input.experimentId,
    generatedAt: input.generatedAt,
    byServedRoute,
    totals,
  };
}

/** The provider half of a `model:provider` requested-pair label. */
function providerOfPair(pairLabel: string): string {
  const idx = pairLabel.indexOf(":");
  return idx >= 0 ? canonicalServedProviderId(pairLabel.slice(idx + 1)) : pairLabel;
}

// ─────────────────────────────────────────────────────────────────────────
// 3. Structured-output support report (dedicated section).
// ─────────────────────────────────────────────────────────────────────────

export type StructuredOutputSupportReportRow = {
  readonly servedProvider: string;
  readonly servedModel: string;
  readonly mode: StructuredOutputModeOrNone;
  readonly requestedCount: number;
  readonly succeededCount: number;
  /** `succeededCount / requestedCount`, in [0, 1]; `requestedCount` is never 0 here. */
  readonly supportRate: number;
  /** `true` iff every requested invocation of this mode on this route succeeded. */
  readonly fullySupported: boolean;
};

export type StructuredOutputSupportReport = {
  readonly schemaVersion: typeof PROVIDER_ROUTE_REPORT_SCHEMA_VERSION;
  readonly section: "structured_output_support";
  readonly experimentId: string;
  readonly generatedAt: string;
  /** One row per (served route, mode), sorted by `${route}::${mode}`. */
  readonly rows: readonly StructuredOutputSupportReportRow[];
};

export function renderStructuredOutputSupport(
  input: ProviderRouteReportInput,
): StructuredOutputSupportReport {
  const reliability = renderRouteReliability(input);
  const rows: StructuredOutputSupportReportRow[] = [];
  for (const key of Object.keys(reliability.byServedRoute).sort()) {
    const route = reliability.byServedRoute[key as ProviderRouteServedKey]!;
    for (const support of route.structuredOutputSupport) {
      rows.push({
        servedProvider: route.servedProvider,
        servedModel: route.servedModel,
        mode: support.mode,
        requestedCount: support.requestedCount,
        succeededCount: support.succeededCount,
        supportRate:
          support.requestedCount === 0 ? 0 : support.succeededCount / support.requestedCount,
        fullySupported:
          support.requestedCount > 0 && support.succeededCount === support.requestedCount,
      });
    }
  }
  return {
    schemaVersion: PROVIDER_ROUTE_REPORT_SCHEMA_VERSION,
    section: "structured_output_support",
    experimentId: input.experimentId,
    generatedAt: input.generatedAt,
    rows,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 4. Cost reconciliation against the provider ledger.
// ─────────────────────────────────────────────────────────────────────────

/**
 * A normalized provider-ledger row for reconciliation, keyed by `runId`
 * (the join to {@link ExperimentInvocationArtifact.runId}). Source-agnostic
 * so a public fixture can build it directly; a durable journal physical
 * attempt adapts into this shape via {@link providerLedgerEntryFromJournalAttempt}.
 *
 * Every cost/token field is INDEPENDENTLY persisted (it is NOT a copy of the
 * artifact) — reconciliation cross-checks the two sources, so a `null` here
 * is a genuine MISSING ledger field and surfaces as a finding naming the
 * run id and field, never a silent 0.
 */
export type ProviderLedgerEntry = {
  readonly runId: string;
  /**
   * The experiment ledger id, when the ledger source carries it (the
   * deterministic `ExperimentInvocationArtifact.ledgerId`). Cross-checked
   * against the artifact's `ledgerId` when non-empty; localization-journal
   * attempts have their own physical `attemptId` and supply `""` here, in
   * which case the runId join is the sole key.
   */
  readonly ledgerId: string;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  /**
   * Authoritative full-precision billed cost, decimal-USD string (the journal
   * `costUsd` / verbatim `usage.cost`). `null` = the ledger row is
   * missing the field.
   */
  readonly costAmountUsd: string | null;
  /** Verbatim `usage` block; reconciliation reads only its `cost` field. */
  readonly usageResponseJson: JsonObject;
};

export type RouteReportFindingKind =
  | "ledger_entry_missing"
  | "ledger_id_mismatch"
  | "missing_ledger_field"
  | "cost_mismatch"
  | "token_mismatch";

/**
 * A structured reconciliation failure. EVERY finding names the `runId`; a
 * field-level finding also names the `field`. This is the
 * "fail with diagnostics naming the run id and field" contract — never a
 * silent skip.
 */
export type RouteReportFinding = {
  readonly kind: RouteReportFindingKind;
  readonly runId: string;
  readonly field: string | null;
  readonly servedProvider: string;
  readonly servedModel: string;
  readonly message: string;
};

export type RouteCostReconciliationRow = {
  readonly servedProvider: string;
  readonly servedModel: string;
  readonly reconciledInvocationCount: number;
  readonly billedInvocationCount: number;
  readonly zeroCostInvocationCount: number;
  /** SUM over reconciled runs of the authoritative decimal `usage.cost` (`run.cost.amountUsd`) in exact truncated micros — the SAME arithmetic as the ledger side, NOT the rounded `amountMicrosUsd` mirror. */
  readonly artifactMicrosUsd: number;
  /** SUM of ledger `cost_amount` over reconciled runs, in micros (×1e6 of the real ledger value). */
  readonly ledgerMicrosUsd: number;
  /** `artifactMicrosUsd` as a USD decimal string (`/1e6`, exact integer division). */
  readonly artifactUsd: string;
  readonly ledgerUsd: string;
};

export type RouteCostReconciliationReport = {
  readonly schemaVersion: typeof PROVIDER_ROUTE_REPORT_SCHEMA_VERSION;
  readonly section: "cost_reconciliation";
  readonly experimentId: string;
  readonly generatedAt: string;
  readonly currency: "USD";
  readonly artifactInvocationCount: number;
  readonly ledgerEntryCount: number;
  readonly reconciledInvocationCount: number;
  /** SUM over reconciled runs of the authoritative decimal `usage.cost` in exact truncated micros. Enforced EXACTLY equal to {@link ledgerMicrosUsd} (assertCostAggregateReconciled). */
  readonly artifactMicrosUsd: number;
  /** SUM of every reconciled ledger row's `cost_amount`, in exact truncated micros. Provably equal to {@link artifactMicrosUsd} — same authoritative decimal, same arithmetic. */
  readonly ledgerMicrosUsd: number;
  readonly artifactUsd: string;
  readonly ledgerUsd: string;
  readonly byServedRoute: Record<ProviderRouteServedKey, RouteCostReconciliationRow>;
  readonly findings: readonly RouteReportFinding[];
};

export type RouteCostReconciliationInput = ProviderRouteReportInput & {
  readonly ledgerEntries: readonly ProviderLedgerEntry[];
};

type MutableCostAcc = {
  servedProvider: string;
  servedModel: string;
  reconciledInvocationCount: number;
  billedInvocationCount: number;
  zeroCostInvocationCount: number;
  artifactMicrosUsd: number;
  ledgerMicrosUsd: number;
};

export function reconcileRouteCost(
  input: RouteCostReconciliationInput,
): RouteCostReconciliationReport {
  const ledgerByRunId = new Map<string, ProviderLedgerEntry>();
  for (const entry of input.ledgerEntries) {
    ledgerByRunId.set(entry.runId, entry);
  }

  const findings: RouteReportFinding[] = [];
  const accByKey = new Map<ProviderRouteServedKey, MutableCostAcc>();

  for (const artifact of input.artifacts) {
    const run = artifact.providerRun;
    const key = servedRouteKey(artifact);
    const servedProvider = canonicalServedProviderId(run.upstreamProvider);
    const servedModel = run.actualModelId;
    const ledger = ledgerByRunId.get(artifact.runId);

    if (ledger === undefined) {
      findings.push({
        kind: "ledger_entry_missing",
        runId: artifact.runId,
        field: null,
        servedProvider,
        servedModel,
        message: `no provider-ledger entry found for run id '${artifact.runId}' (served ${servedProvider}/${servedModel}); cannot reconcile cost`,
      });
      continue;
    }

    let reconciled = true;

    // ── ledger id cross-check (only when the ledger source carries one). ──
    if (ledger.ledgerId.length > 0 && ledger.ledgerId !== artifact.ledgerId) {
      reconciled = false;
      findings.push({
        kind: "ledger_id_mismatch",
        runId: artifact.runId,
        field: "ledgerId",
        servedProvider,
        servedModel,
        message: `ledger id mismatch for run id '${artifact.runId}': artifact='${artifact.ledgerId}' ledger='${ledger.ledgerId}'`,
      });
    }

    // ── cost field present + cross-checked three ways. ────────────────────
    const artifactUsd = Number(run.cost.amountUsd);
    if (ledger.costAmountUsd === null || ledger.costAmountUsd.length === 0) {
      reconciled = false;
      findings.push(missingField(artifact.runId, "costAmountUsd", servedProvider, servedModel));
    } else {
      const ledgerUsd = Number(ledger.costAmountUsd);
      if (Math.abs(ledgerUsd - artifactUsd) >= COST_EPSILON_USD) {
        reconciled = false;
        findings.push({
          kind: "cost_mismatch",
          runId: artifact.runId,
          field: "costAmountUsd",
          servedProvider,
          servedModel,
          message: `cost mismatch for run id '${artifact.runId}': artifact usage.cost=${run.cost.amountUsd} ledger cost_amount=${ledger.costAmountUsd} (Δ ${Math.abs(ledgerUsd - artifactUsd)} USD ≥ ${COST_EPSILON_USD})`,
        });
      }
    }

    // ── ledger usage.cost cross-check (third independent source). ─────────
    // Billed runs MUST carry a numeric usage.cost equal to the artifact
    // cost; a zero-cost run legitimately carries no `cost` key, mirroring
    // the ledger partial-NULL CHECK exemption — that is reconciled, not a
    // missing field.
    const usageCost = readUsageCost(ledger.usageResponseJson);
    if (run.cost.costKind === "billed") {
      if (usageCost === null) {
        reconciled = false;
        findings.push(
          missingField(artifact.runId, "usageResponseJson.cost", servedProvider, servedModel),
        );
      } else if (Math.abs(usageCost - artifactUsd) >= COST_EPSILON_USD) {
        reconciled = false;
        findings.push({
          kind: "cost_mismatch",
          runId: artifact.runId,
          field: "usageResponseJson.cost",
          servedProvider,
          servedModel,
          message: `usage.cost mismatch for run id '${artifact.runId}': artifact usage.cost=${run.cost.amountUsd} ledger usage_response_json.cost=${usageCost}`,
        });
      }
    }

    // ── token cross-check (only when the artifact reports a count). ───────
    reconciled = reconcileToken(
      "tokensIn",
      run.tokenUsage.promptTokens,
      ledger.tokensIn,
      artifact.runId,
      servedProvider,
      servedModel,
      findings,
    )
      ? reconciled
      : false;
    reconciled = reconcileToken(
      "tokensOut",
      run.tokenUsage.completionTokens,
      ledger.tokensOut,
      artifact.runId,
      servedProvider,
      servedModel,
      findings,
    )
      ? reconciled
      : false;

    const acc =
      accByKey.get(key) ??
      ({
        servedProvider,
        servedModel,
        reconciledInvocationCount: 0,
        billedInvocationCount: 0,
        zeroCostInvocationCount: 0,
        artifactMicrosUsd: 0,
        ledgerMicrosUsd: 0,
      } satisfies MutableCostAcc);

    if (reconciled) {
      acc.reconciledInvocationCount += 1;
      // COST CORRECTNESS: the artifact aggregate is derived from the
      // AUTHORITATIVE full-precision decimal `usage.cost` (run.cost.amountUsd)
      // via the SAME integer parser as the ledger side — NOT the rounded
      // `amountMicrosUsd` mirror. The mirror round-half-ups the 7th fractional
      // digit whereas the ledger side truncates, so the two arithmetics can
      // diverge by a micro on sub-micro costs (e.g. `0.0000005` → mirror 1 vs
      // ledger 0) even for a run whose decimals reconcile within 1e-9. Both
      // sides now derive from the authoritative decimal with identical
      // arithmetic, so they CANNOT diverge by construction; the exact-integer
      // equality invariant is enforced below (assertCostAggregateReconciled).
      acc.artifactMicrosUsd += usdDecimalStringToMicros(run.cost.amountUsd);
      // Ledger micros derived from the real persisted decimal (×1e6).
      acc.ledgerMicrosUsd += usdDecimalStringToMicros(ledger.costAmountUsd ?? "0");
      if (run.cost.costKind === "billed") acc.billedInvocationCount += 1;
      else acc.zeroCostInvocationCount += 1;
    }
    accByKey.set(key, acc);
  }

  const byServedRoute: Record<ProviderRouteServedKey, RouteCostReconciliationRow> = {};
  let totalArtifactMicros = 0;
  let totalLedgerMicros = 0;
  let totalReconciled = 0;
  for (const key of [...accByKey.keys()].sort()) {
    const acc = accByKey.get(key)!;
    byServedRoute[key] = {
      servedProvider: acc.servedProvider,
      servedModel: acc.servedModel,
      reconciledInvocationCount: acc.reconciledInvocationCount,
      billedInvocationCount: acc.billedInvocationCount,
      zeroCostInvocationCount: acc.zeroCostInvocationCount,
      artifactMicrosUsd: acc.artifactMicrosUsd,
      ledgerMicrosUsd: acc.ledgerMicrosUsd,
      artifactUsd: microsToUsdDecimalString(acc.artifactMicrosUsd),
      ledgerUsd: microsToUsdDecimalString(acc.ledgerMicrosUsd),
    };
    totalArtifactMicros += acc.artifactMicrosUsd;
    totalLedgerMicros += acc.ledgerMicrosUsd;
    totalReconciled += acc.reconciledInvocationCount;
  }

  const report: RouteCostReconciliationReport = {
    schemaVersion: PROVIDER_ROUTE_REPORT_SCHEMA_VERSION,
    section: "cost_reconciliation",
    experimentId: input.experimentId,
    generatedAt: input.generatedAt,
    currency: "USD",
    artifactInvocationCount: input.artifacts.length,
    ledgerEntryCount: input.ledgerEntries.length,
    reconciledInvocationCount: totalReconciled,
    artifactMicrosUsd: totalArtifactMicros,
    ledgerMicrosUsd: totalLedgerMicros,
    artifactUsd: microsToUsdDecimalString(totalArtifactMicros),
    ledgerUsd: microsToUsdDecimalString(totalLedgerMicros),
    byServedRoute,
    findings,
  };

  // COST CORRECTNESS invariant: the headline cost aggregate MUST equal the
  // authoritative ledger aggregate to the exact micro. Both sides are built
  // from the authoritative decimal above, so a divergence here can only come
  // from a code regression (e.g. reintroducing the rounded mirror) or a
  // corrupt input — either way it must fail LOUDLY, never accumulate silently.
  assertCostAggregateReconciled(report);
  return report;
}

/**
 * Thrown by {@link assertCostAggregateReconciled} when the headline cost
 * aggregate does not EXACTLY equal the authoritative ledger aggregate
 * (exact integer micros, no fuzzy epsilon). Names the scope + both amounts
 * so a silent rounded-mirror drift can never masquerade as reconciled.
 */
export class CostAggregateDivergenceError extends Error {
  constructor(
    public readonly scope: string,
    public readonly artifactMicrosUsd: number,
    public readonly ledgerMicrosUsd: number,
  ) {
    super(
      `headline cost aggregate DIVERGED from the authoritative ledger at ${scope}: ` +
        `artifact ${artifactMicrosUsd} micros-USD != ledger ${ledgerMicrosUsd} micros-USD ` +
        `(Δ ${artifactMicrosUsd - ledgerMicrosUsd} micros); the reported cost MUST equal the ` +
        `authoritative ledger cost exactly — no rounded-mirror approximation`,
    );
    this.name = "CostAggregateDivergenceError";
  }
}

/**
 * COST CORRECTNESS enforcement: assert that the report's cost aggregate
 * equals the authoritative ledger aggregate to the EXACT micro, per served
 * route AND in the headline total. This is the check the audit flagged as
 * "never enforced": the headline cost can no longer be a rounded mirror that
 * silently drifts from the ledger. Throws {@link CostAggregateDivergenceError}
 * on any mismatch. Callers that render a report for publication/CLI escalation
 * can call this to fail the process on divergence.
 */
export function assertCostAggregateReconciled(report: RouteCostReconciliationReport): void {
  for (const [key, row] of Object.entries(report.byServedRoute)) {
    if (row.artifactMicrosUsd !== row.ledgerMicrosUsd) {
      throw new CostAggregateDivergenceError(
        `served route '${key}'`,
        row.artifactMicrosUsd,
        row.ledgerMicrosUsd,
      );
    }
  }
  if (report.artifactMicrosUsd !== report.ledgerMicrosUsd) {
    throw new CostAggregateDivergenceError(
      "headline total",
      report.artifactMicrosUsd,
      report.ledgerMicrosUsd,
    );
  }
}

/**
 * Cross-check one token field. Returns `true` when reconciled (field
 * present + equal, or the artifact reports no count to check). When the
 * artifact reports a count but the ledger field is `null`, emits a
 * `missing_ledger_field` finding; when both are present but differ, emits a
 * `token_mismatch`. Both name the run id + field.
 */
function reconcileToken(
  field: "tokensIn" | "tokensOut",
  artifactTokens: number | undefined,
  ledgerTokens: number | null,
  runId: string,
  servedProvider: string,
  servedModel: string,
  findings: RouteReportFinding[],
): boolean {
  if (artifactTokens === undefined) return true;
  if (ledgerTokens === null) {
    findings.push(missingField(runId, field, servedProvider, servedModel));
    return false;
  }
  if (ledgerTokens !== artifactTokens) {
    findings.push({
      kind: "token_mismatch",
      runId,
      field,
      servedProvider,
      servedModel,
      message: `${field} mismatch for run id '${runId}': artifact=${artifactTokens} ledger=${ledgerTokens}`,
    });
    return false;
  }
  return true;
}

function missingField(
  runId: string,
  field: string,
  servedProvider: string,
  servedModel: string,
): RouteReportFinding {
  return {
    kind: "missing_ledger_field",
    runId,
    field,
    servedProvider,
    servedModel,
    message: `provider-ledger entry for run id '${runId}' (served ${servedProvider}/${servedModel}) is missing required field '${field}'`,
  };
}

function readUsageCost(usage: JsonObject): number | null {
  const value = (usage as { cost?: unknown }).cost;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// Composite report + strict assertion.
// ─────────────────────────────────────────────────────────────────────────

export type ProviderRouteReport = {
  readonly schemaVersion: typeof PROVIDER_ROUTE_REPORT_SCHEMA_VERSION;
  readonly experimentId: string;
  readonly generatedAt: string;
  readonly reliability: ProviderRouteReliabilityReport;
  readonly structuredOutputSupport: StructuredOutputSupportReport;
  readonly costReconciliation: RouteCostReconciliationReport;
};

export function renderProviderRouteReport(
  input: RouteCostReconciliationInput,
): ProviderRouteReport {
  return {
    schemaVersion: PROVIDER_ROUTE_REPORT_SCHEMA_VERSION,
    experimentId: input.experimentId,
    generatedAt: input.generatedAt,
    reliability: renderRouteReliability(input),
    structuredOutputSupport: renderStructuredOutputSupport(input),
    costReconciliation: reconcileRouteCost(input),
  };
}

/**
 * Thrown by {@link assertRouteReportReconciled} when the cost
 * reconciliation carried any finding. The message names every offending
 * run id + field so the failure stays visible at the process level (a CLI
 * can escalate it to a non-zero exit). Never a silent pass.
 */
export class RouteReportReconciliationError extends Error {
  constructor(public readonly findings: readonly RouteReportFinding[]) {
    super(
      `provider route cost reconciliation FAILED with ${findings.length} finding(s): ${findings
        .map((f) => `${f.kind}@run:${f.runId}${f.field ? `/field:${f.field}` : ""}`)
        .join(", ")}`,
    );
    this.name = "RouteReportReconciliationError";
  }
}

export function assertRouteReportReconciled(report: RouteCostReconciliationReport): void {
  if (report.findings.length > 0) {
    throw new RouteReportReconciliationError(report.findings);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Micros ↔ USD (the ONLY cost arithmetic; /1e6 integer derivations).
// ─────────────────────────────────────────────────────────────────────────

/** Exact micros→USD decimal string via integer division (no float rounding). */
export function microsToUsdDecimalString(micros: number): string {
  const negative = micros < 0;
  const abs = Math.abs(Math.trunc(micros));
  const whole = Math.floor(abs / 1_000_000);
  const fraction = (abs % 1_000_000).toString().padStart(6, "0").replace(/0+$/u, "");
  const body = fraction.length > 0 ? `${whole}.${fraction}` : `${whole}`;
  return negative ? `-${body}` : body;
}

/** Exact USD decimal string → integer micros (no float drift). */
export function usdDecimalStringToMicros(usd: string): number {
  const trimmed = usd.trim();
  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [whole, fractionRaw = ""] = unsigned.split(".");
  const fraction = `${fractionRaw}000000`.slice(0, 6);
  const micros = Number(whole) * 1_000_000 + Number(fraction);
  return negative ? -micros : micros;
}
