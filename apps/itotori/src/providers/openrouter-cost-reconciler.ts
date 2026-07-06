// ITOTORI-235 — OpenRouter cost reconciliation.
//
// OpenRouter exposes `GET /api/v1/generation?id={genId}` (docs
// openrouter.ai/docs/api/api-reference/generations/get-generation, fetched
// 2026-06-25; live evidence in docs/openrouter-integration-evidence/
// 2026-06-25.json call_6) which returns the CANONICAL, settled real cost of
// a prior generation as `data.total_cost` (USD number), alongside
// `data.upstream_inference_cost` and `data.cache_discount`.
//
// itotori captures the generation id (`gen-...`, the chat-completions
// response's top-level `id`) onto the recorded artifact / invocation result
// at `adapterMetadata.generationId` (see `adapterMetadata` in
// providers/openrouter.ts). This module re-fetches the settled cost for a
// prior generation and compares `total_cost` to the ledger row's persisted
// `cost_amount` within 1e-9 USD — a post-hoc drift check on the real billed
// value, never an estimate.
//
// Two behaviours matter for correctness:
//   1. The lookup is EVENTUALLY CONSISTENT: the evidence file's call_6
//      succeeded ~8s after the originating call, and a first attempt at ~3s
//      returned HTTP 404 "Generation <id> not found". The reconciler tolerates
//      this with a bounded exponential backoff over the documented window.
//   2. Per docs/openrouter-integration.md §5.4 observation 2, the lookup's
//      `upstream_inference_cost` can DIFFER from the chat-completions
//      `cost_details.upstream_inference_cost`. `total_cost` is the ONLY
//      billing-truth field; the reconciler compares `total_cost` and surfaces
//      the other two as informational context.

import type { JsonObject } from "./types.js";

/** Tolerance for the `total_cost` vs `cost_amount` equality (USD). */
export const COST_RECONCILE_TOLERANCE_USD = 1e-9;

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
// Eventual-consistency backoff. The documented window is ~5-8s (evidence
// call_6 settled at ~8s); these defaults probe across ~1.5+2.25+3.4+5+7.6+
// 11.4 ≈ 31s of cumulative backoff before giving up, comfortably covering it
// while staying bounded.
const DEFAULT_MAX_ATTEMPTS = 7;
const DEFAULT_INITIAL_DELAY_MS = 1_500;
const DEFAULT_BACKOFF_FACTOR = 1.5;

export class OpenRouterCostReconciliationError extends Error {
  constructor(
    readonly code:
      | "generation_not_settled"
      | "generation_lookup_failed"
      | "generation_response_invalid"
      | "invalid_ledger_row",
    message: string,
  ) {
    super(message);
    this.name = "OpenRouterCostReconciliationError";
  }
}

/**
 * The minimal ledger-row surface the reconciler consumes: the generation id
 * captured at `adapterMetadata.generationId` plus the row's persisted
 * `cost_amount` (canonical full-precision decimal-USD string, e.g.
 * `"0.00000602"`). `rowRef` is an optional caller identifier (ledger entry id
 * / draft-attempt id) echoed into the report for drift attribution.
 */
export type ReconcilableLedgerRow = {
  generationId: string;
  costAmountUsd: string;
  rowRef?: string;
};

/** Canonical settled cost re-fetched from `GET /api/v1/generation?id=`. */
export type CanonicalGenerationCost = {
  generationId: string;
  totalCostUsd: number;
  upstreamInferenceCostUsd: number;
  cacheDiscountUsd: number | null;
};

export type LedgerCostReconciliation = {
  generationId: string;
  rowRef?: string;
  ledgerCostAmountUsd: string;
  canonicalTotalCostUsd: number;
  upstreamInferenceCostUsd: number;
  cacheDiscountUsd: number | null;
  /** `canonicalTotalCostUsd - Number(ledgerCostAmountUsd)`. */
  driftUsd: number;
  withinTolerance: boolean;
};

export type LedgerCostReconciliationReport = {
  toleranceUsd: number;
  reconciliations: LedgerCostReconciliation[];
  driftedRows: LedgerCostReconciliation[];
  hasDrift: boolean;
};

export type ReconcileRetryOptions = {
  maxAttempts?: number;
  initialDelayMs?: number;
  backoffFactor?: number;
  sleep?: (ms: number) => Promise<void>;
};

export type OpenRouterGenerationReconcilerDeps = {
  apiKey: string;
  fetch?: typeof fetch;
  /** Base URL including the `/api/v1` suffix. Defaults to production. */
  baseUrl?: string;
  retry?: ReconcileRetryOptions;
};

/**
 * Read the generation id itotori captured onto an invocation result / recorded
 * provider-run artifact. The OR adapter records the chat-completions response's
 * top-level `id` (`gen-...`) at `adapterMetadata.generationId`; returns
 * `undefined` for offline/local/fake providers that never produced one.
 */
export function generationIdFromAdapterMetadata(
  metadata: JsonObject | undefined,
): string | undefined {
  if (metadata === undefined) {
    return undefined;
  }
  const value = metadata.generationId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Re-fetch the canonical settled cost for a prior generation. Tolerates the
 * documented eventual-consistency window with a bounded exponential backoff
 * (retries on the 404 "not found" envelope and on 429/5xx), then throws
 * `generation_not_settled` if the id is still not queryable.
 */
export async function fetchCanonicalGenerationCost(
  generationId: string,
  deps: OpenRouterGenerationReconcilerDeps,
): Promise<CanonicalGenerationCost> {
  if (generationId.length === 0) {
    throw new OpenRouterCostReconciliationError(
      "invalid_ledger_row",
      "generationId must be a non-empty string",
    );
  }
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const baseUrl = stripTrailingSlash(deps.baseUrl ?? DEFAULT_BASE_URL);
  const url = `${baseUrl}/generation?id=${encodeURIComponent(generationId)}`;
  const maxAttempts = deps.retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const initialDelayMs = deps.retry?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const backoffFactor = deps.retry?.backoffFactor ?? DEFAULT_BACKOFF_FACTOR;
  const sleep =
    deps.retry?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let lastStatus: number | undefined;
  let delayMs = initialDelayMs;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${deps.apiKey}` },
      });
    } catch (error) {
      // Network error — retryable within the bounded window.
      lastStatus = undefined;
      if (attempt === maxAttempts) {
        throw new OpenRouterCostReconciliationError(
          "generation_lookup_failed",
          `generation lookup for ${generationId} failed after ${attempt} attempts: ${errorMessage(error)}`,
        );
      }
      await sleep(delayMs);
      delayMs *= backoffFactor;
      continue;
    }

    if (response.ok) {
      const body = (await safeJson(response)) as unknown;
      return parseCanonicalGenerationCost(generationId, body);
    }

    lastStatus = response.status;
    const retryable = response.status === 404 || response.status === 429 || response.status >= 500;
    if (!retryable) {
      throw new OpenRouterCostReconciliationError(
        "generation_lookup_failed",
        `generation lookup for ${generationId} returned non-retryable HTTP ${response.status}`,
      );
    }
    if (attempt === maxAttempts) {
      break;
    }
    await sleep(delayMs);
    delayMs *= backoffFactor;
  }

  throw new OpenRouterCostReconciliationError(
    "generation_not_settled",
    `generation ${generationId} was not queryable after ${maxAttempts} attempts` +
      `${lastStatus === undefined ? "" : ` (last HTTP ${lastStatus})`}` +
      "; the /generation endpoint is eventually consistent (docs §5.4)",
  );
}

/**
 * Reconcile a single ledger row against its canonical settled cost. Re-fetches
 * `total_cost` and compares it to the row's `cost_amount` within
 * {@link COST_RECONCILE_TOLERANCE_USD}.
 */
export async function reconcileLedgerRow(
  row: ReconcilableLedgerRow,
  deps: OpenRouterGenerationReconcilerDeps,
): Promise<LedgerCostReconciliation> {
  const ledgerCostUsd = parseLedgerCostAmount(row.costAmountUsd);
  const canonical = await fetchCanonicalGenerationCost(row.generationId, deps);
  const driftUsd = canonical.totalCostUsd - ledgerCostUsd;
  const withinTolerance = Math.abs(driftUsd) <= COST_RECONCILE_TOLERANCE_USD;
  return {
    generationId: row.generationId,
    ...(row.rowRef === undefined ? {} : { rowRef: row.rowRef }),
    ledgerCostAmountUsd: row.costAmountUsd,
    canonicalTotalCostUsd: canonical.totalCostUsd,
    upstreamInferenceCostUsd: canonical.upstreamInferenceCostUsd,
    cacheDiscountUsd: canonical.cacheDiscountUsd,
    driftUsd,
    withinTolerance,
  };
}

/**
 * Reconcile a batch of ledger rows and roll them into a drift report. The
 * report's `hasDrift` is true when ANY row's `total_cost` diverges from its
 * `cost_amount` beyond tolerance — the CLI turns this into a non-zero exit.
 */
export async function reconcileLedgerRows(
  rows: ReadonlyArray<ReconcilableLedgerRow>,
  deps: OpenRouterGenerationReconcilerDeps,
): Promise<LedgerCostReconciliationReport> {
  const reconciliations: LedgerCostReconciliation[] = [];
  for (const row of rows) {
    reconciliations.push(await reconcileLedgerRow(row, deps));
  }
  const driftedRows = reconciliations.filter((r) => !r.withinTolerance);
  return {
    toleranceUsd: COST_RECONCILE_TOLERANCE_USD,
    reconciliations,
    driftedRows,
    hasDrift: driftedRows.length > 0,
  };
}

/**
 * Validate + normalize raw JSON (e.g. an exported ledger-rows file) into
 * {@link ReconcilableLedgerRow}s. Accepts `costAmountUsd` or the ledger's
 * `costAmount` key for the persisted amount, and an optional `rowRef` /
 * `ledgerEntryId` identifier.
 */
export function parseReconcilableLedgerRows(raw: unknown): ReconcilableLedgerRow[] {
  if (!Array.isArray(raw)) {
    throw new OpenRouterCostReconciliationError(
      "invalid_ledger_row",
      "ledger rows input must be a JSON array",
    );
  }
  return raw.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new OpenRouterCostReconciliationError(
        "invalid_ledger_row",
        `ledger row ${index} must be a JSON object`,
      );
    }
    const record = entry as Record<string, unknown>;
    const generationId = record.generationId;
    if (typeof generationId !== "string" || generationId.length === 0) {
      throw new OpenRouterCostReconciliationError(
        "invalid_ledger_row",
        `ledger row ${index} is missing a non-empty string generationId`,
      );
    }
    const amount = record.costAmountUsd ?? record.costAmount;
    if (typeof amount !== "string" || !/^\d+(?:\.\d+)?$/u.test(amount)) {
      throw new OpenRouterCostReconciliationError(
        "invalid_ledger_row",
        `ledger row ${index} is missing a non-negative decimal costAmountUsd/costAmount string`,
      );
    }
    const rowRef = record.rowRef ?? record.ledgerEntryId ?? record.draftJobAttemptId;
    return {
      generationId,
      costAmountUsd: amount,
      ...(typeof rowRef === "string" && rowRef.length > 0 ? { rowRef } : {}),
    };
  });
}

export type ReconcileLedgerCostCommandInput = {
  /** Raw parsed JSON of the ledger-rows file (validated internally). */
  ledgerRowsInput: unknown;
  deps: OpenRouterGenerationReconcilerDeps;
  /** Persist the drift report (e.g. the CLI's `--output` JSON writer). */
  writeReport: (report: LedgerCostReconciliationReport) => void;
  log: (message: string) => void;
  /** Set the process exit code: non-zero when any row drifts. */
  exit: (code: number) => void;
};

/**
 * CLI entry point: reconcile a batch of ledger rows against their canonical
 * settled cost, persist the drift report, and exit NON-ZERO if any row's
 * `total_cost` diverges from its `cost_amount` beyond tolerance. Returns the
 * report so callers/tests can assert on it directly.
 */
export async function runReconcileLedgerCostCommand(
  input: ReconcileLedgerCostCommandInput,
): Promise<LedgerCostReconciliationReport> {
  const rows = parseReconcilableLedgerRows(input.ledgerRowsInput);
  const report = await reconcileLedgerRows(rows, input.deps);
  input.writeReport(report);
  for (const drift of report.driftedRows) {
    input.log(
      `DRIFT ${drift.rowRef ?? drift.generationId}: ledger cost_amount ${drift.ledgerCostAmountUsd} ` +
        `!= canonical total_cost ${drift.canonicalTotalCostUsd} (drift ${drift.driftUsd} USD)`,
    );
  }
  input.log(
    `reconciled ${report.reconciliations.length} ledger row(s); ` +
      `${report.driftedRows.length} drifted beyond ${report.toleranceUsd} USD`,
  );
  input.exit(report.hasDrift ? 1 : 0);
  return report;
}

function parseLedgerCostAmount(value: string): number {
  if (!/^\d+(?:\.\d+)?$/u.test(value)) {
    throw new OpenRouterCostReconciliationError(
      "invalid_ledger_row",
      `ledger cost_amount ${JSON.stringify(value)} is not a non-negative decimal string`,
    );
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new OpenRouterCostReconciliationError(
      "invalid_ledger_row",
      `ledger cost_amount ${JSON.stringify(value)} did not parse to a finite non-negative number`,
    );
  }
  return parsed;
}

function parseCanonicalGenerationCost(
  generationId: string,
  body: unknown,
): CanonicalGenerationCost {
  if (!isRecord(body) || !isRecord(body.data)) {
    throw new OpenRouterCostReconciliationError(
      "generation_response_invalid",
      `generation lookup for ${generationId} returned a body without a data object`,
    );
  }
  const data = body.data;
  const totalCostUsd = asFiniteNonNegative(data.total_cost, "data.total_cost", generationId);
  // `upstream_inference_cost` is informational only (docs §5.4 obs. 2: it can
  // diverge from the chat-completions value). Default to 0 when absent/null.
  const upstreamInferenceCostUsd =
    data.upstream_inference_cost === undefined || data.upstream_inference_cost === null
      ? 0
      : asFiniteNonNegative(
          data.upstream_inference_cost,
          "data.upstream_inference_cost",
          generationId,
        );
  const cacheDiscountUsd =
    data.cache_discount === undefined || data.cache_discount === null
      ? null
      : asFiniteNonNegative(data.cache_discount, "data.cache_discount", generationId);
  return { generationId, totalCostUsd, upstreamInferenceCostUsd, cacheDiscountUsd };
}

function asFiniteNonNegative(value: unknown, label: string, generationId: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new OpenRouterCostReconciliationError(
      "generation_response_invalid",
      `generation lookup for ${generationId} field ${label} must be a finite non-negative number (got ${String(value)})`,
    );
  }
  return value;
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
