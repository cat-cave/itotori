// ITOTORI-235 — unit coverage for the OpenRouter cost reconciler + CLI command.
//
// These exercise the pure logic with an INJECTED fetch (no live key): the
// 1e-9 total_cost-vs-cost_amount compare, the eventual-consistency retry on
// the 404 "not found" envelope, the generation-id extractor, and the CLI
// command's non-zero exit on a synthetic drift / zero exit on a match.
//
// No real costs are hardcoded: the injected fetch simulates the /generation
// endpoint's `total_cost` response field (the endpoint's own value), and the
// ledger `costAmount` is passed as an opaque decimal string — the same shape
// the ledger persists.

import { describe, expect, it, vi } from "vitest";
import {
  COST_RECONCILE_TOLERANCE_USD,
  OpenRouterCostReconciliationError,
  fetchCanonicalGenerationCost,
  generationIdFromAdapterMetadata,
  parseReconcilableLedgerRows,
  reconcileLedgerRow,
  runReconcileLedgerCostCommand,
  type LedgerCostReconciliationReport,
} from "../src/providers/openrouter-cost-reconciler.js";

const GEN_ID = "gen-1782395748-RbpAzhCNny8TxgUgPC4P";
const LEDGER_AMOUNT = "0.00000602";

function generationLookupResponse(fields: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ data: { id: GEN_ID, ...fields } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function notFoundResponse(): Response {
  return new Response(JSON.stringify({ error: { message: `Generation ${GEN_ID} not found` } }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
}

const noSleep = async (): Promise<void> => undefined;

describe("openrouter-cost-reconciler — canonical re-fetch + compare", () => {
  it("re-fetches total_cost and matches the ledger cost_amount within 1e-9", async () => {
    const fetchMock = vi.fn(async () =>
      generationLookupResponse({
        total_cost: 0.00000602,
        upstream_inference_cost: 0,
        cache_discount: null,
      }),
    );
    const reconciliation = await reconcileLedgerRow(
      { generationId: GEN_ID, costAmountUsd: LEDGER_AMOUNT, rowRef: "ledger-1" },
      { apiKey: "test-key", fetch: fetchMock as unknown as typeof fetch },
    );
    expect(reconciliation.canonicalTotalCostUsd).toBe(0.00000602);
    expect(reconciliation.driftUsd).toBeLessThanOrEqual(COST_RECONCILE_TOLERANCE_USD);
    expect(reconciliation.withinTolerance).toBe(true);
    expect(reconciliation.cacheDiscountUsd).toBeNull();
    // Endpoint called with the generation id on the query string.
    const calledUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(calledUrl).toContain("/generation?id=");
    expect(calledUrl).toContain(encodeURIComponent(GEN_ID));
  });

  it("flags drift when total_cost diverges from cost_amount beyond tolerance", async () => {
    const fetchMock = vi.fn(async () =>
      generationLookupResponse({ total_cost: 0.00001, upstream_inference_cost: 0 }),
    );
    const reconciliation = await reconcileLedgerRow(
      { generationId: GEN_ID, costAmountUsd: LEDGER_AMOUNT },
      { apiKey: "k", fetch: fetchMock as unknown as typeof fetch },
    );
    expect(reconciliation.withinTolerance).toBe(false);
    expect(Math.abs(reconciliation.driftUsd)).toBeGreaterThan(COST_RECONCILE_TOLERANCE_USD);
  });

  it("tolerates the 5-8s eventual-consistency window: retries the 404 then settles", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(notFoundResponse())
      .mockResolvedValueOnce(notFoundResponse())
      .mockResolvedValueOnce(
        generationLookupResponse({ total_cost: 0.00000602, upstream_inference_cost: 0 }),
      );
    const canonical = await fetchCanonicalGenerationCost(GEN_ID, {
      apiKey: "k",
      fetch: fetchMock as unknown as typeof fetch,
      retry: { sleep: noSleep, initialDelayMs: 1 },
    });
    expect(canonical.totalCostUsd).toBe(0.00000602);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("throws generation_not_settled when the id never becomes queryable", async () => {
    const fetchMock = vi.fn(async () => notFoundResponse());
    await expect(
      fetchCanonicalGenerationCost(GEN_ID, {
        apiKey: "k",
        fetch: fetchMock as unknown as typeof fetch,
        retry: { sleep: noSleep, maxAttempts: 3, initialDelayMs: 1 },
      }),
    ).rejects.toMatchObject({ code: "generation_not_settled" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("throws on a non-retryable HTTP status (e.g. 401)", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "unauthorized" } }), { status: 401 }),
    );
    await expect(
      fetchCanonicalGenerationCost(GEN_ID, {
        apiKey: "k",
        fetch: fetchMock as unknown as typeof fetch,
        retry: { sleep: noSleep },
      }),
    ).rejects.toMatchObject({ code: "generation_lookup_failed" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("openrouter-cost-reconciler — generation-id extractor", () => {
  it("reads generationId from adapter metadata; undefined when absent", () => {
    expect(generationIdFromAdapterMetadata({ generationId: GEN_ID })).toBe(GEN_ID);
    expect(generationIdFromAdapterMetadata({ providerRouting: {} })).toBeUndefined();
    expect(generationIdFromAdapterMetadata(undefined)).toBeUndefined();
  });
});

describe("openrouter-cost-reconciler — row parsing", () => {
  it("accepts costAmount or costAmountUsd and rowRef/ledgerEntryId aliases", () => {
    const rows = parseReconcilableLedgerRows([
      { generationId: GEN_ID, costAmount: LEDGER_AMOUNT, ledgerEntryId: "entry-9" },
      { generationId: "gen-x", costAmountUsd: "0.0001", rowRef: "r2" },
    ]);
    expect(rows[0]).toEqual({
      generationId: GEN_ID,
      costAmountUsd: LEDGER_AMOUNT,
      rowRef: "entry-9",
    });
    expect(rows[1]?.rowRef).toBe("r2");
  });

  it("rejects rows missing a generation id or a decimal amount", () => {
    expect(() => parseReconcilableLedgerRows([{ costAmount: LEDGER_AMOUNT }])).toThrow(
      OpenRouterCostReconciliationError,
    );
    expect(() =>
      parseReconcilableLedgerRows([{ generationId: GEN_ID, costAmount: "not-a-number" }]),
    ).toThrow(OpenRouterCostReconciliationError);
  });
});

describe("openrouter-cost-reconciler — CLI command exit code", () => {
  it("exits 0 when every row matches", async () => {
    const fetchMock = vi.fn(async () =>
      generationLookupResponse({ total_cost: 0.00000602, upstream_inference_cost: 0 }),
    );
    let exitCode: number | undefined;
    let written: LedgerCostReconciliationReport | undefined;
    const report = await runReconcileLedgerCostCommand({
      ledgerRowsInput: [{ generationId: GEN_ID, costAmount: LEDGER_AMOUNT, rowRef: "ok-row" }],
      deps: { apiKey: "k", fetch: fetchMock as unknown as typeof fetch, retry: { sleep: noSleep } },
      writeReport: (r) => {
        written = r;
      },
      log: () => undefined,
      exit: (code) => {
        exitCode = code;
      },
    });
    expect(report.hasDrift).toBe(false);
    expect(exitCode).toBe(0);
    expect(written?.reconciliations).toHaveLength(1);
  });

  it("exits 1 on a synthetic drift", async () => {
    const fetchMock = vi.fn(async () =>
      generationLookupResponse({ total_cost: 0.0005, upstream_inference_cost: 0 }),
    );
    let exitCode: number | undefined;
    const report = await runReconcileLedgerCostCommand({
      ledgerRowsInput: [{ generationId: GEN_ID, costAmount: LEDGER_AMOUNT, rowRef: "drift-row" }],
      deps: { apiKey: "k", fetch: fetchMock as unknown as typeof fetch, retry: { sleep: noSleep } },
      writeReport: () => undefined,
      log: () => undefined,
      exit: (code) => {
        exitCode = code;
      },
    });
    expect(report.hasDrift).toBe(true);
    expect(report.driftedRows[0]?.rowRef).toBe("drift-row");
    expect(exitCode).toBe(1);
  });
});
