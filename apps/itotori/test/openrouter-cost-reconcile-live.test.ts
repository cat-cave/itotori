// ITOTORI-235 — REAL cost-reconciliation proof.
//
// Makes ONE real generation through the production OpenRouterProvider under
// ZDR/DEV_PAIR, captures its generation id (`adapterMetadata.generationId`,
// the chat-completions response's top-level `gen-...` id), then re-fetches the
// canonical settled cost from `GET /api/v1/generation?id=` and asserts the
// endpoint's `total_cost` equals the ledger's `cost_amount`
// (`providerRun.cost.amountUsd`, the exact string the DraftAttemptRecorder
// persists) within 1e-9 USD. Also asserts the ZDR posture was preserved and
// the served (model, provider) pair was recorded.
//
// The reconciler tolerates the documented 5-8s eventual-consistency window on
// /generation with a bounded exponential backoff.
//
// Gated on ITOTORI_COST_RECONCILE_LIVE=1 + OPENROUTER_API_KEY +
// OPENROUTER_ZDR_ACCOUNT_ASSERTED=1. Unset → visible skip (no silent pass), so
// `pnpm test` in CI skips it. Budget: ONE small call, capped at $0.50.

import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  REQUESTED_PROVIDER_UNKNOWN,
  OpenRouterProvider,
  assertOpenRouterZdrAccount,
  generationIdFromAdapterMetadata,
  reconcileLedgerRow,
  type JsonObject,
  type ModelInvocationRequest,
} from "../src/providers/index.js";
import { DEV_PAIR, getModelCapabilities } from "../src/providers/dev-pair.js";

const LIVE_ENABLED =
  process.env.ITOTORI_COST_RECONCILE_LIVE === "1" &&
  typeof process.env.OPENROUTER_API_KEY === "string" &&
  process.env.OPENROUTER_API_KEY.length > 0;

const PER_CALL_MAX_PRICE_USD = 0.5;

describe("itotori-235 cost reconciliation — real /generation re-fetch vs ledger cost_amount", () => {
  it("re-fetches total_cost and matches the ledger cost_amount within 1e-9, ZDR preserved", async () => {
    if (!LIVE_ENABLED) {
      // eslint-disable-next-line no-console
      console.warn(
        "[i235-reconcile] skipping real run — set ITOTORI_COST_RECONCILE_LIVE=1, " +
          "OPENROUTER_API_KEY, and OPENROUTER_ZDR_ACCOUNT_ASSERTED=1 to run it",
      );
      return;
    }
    const env = process.env;
    // Privacy gate BEFORE any live byte.
    assertOpenRouterZdrAccount(env);

    const apiKey = env.OPENROUTER_API_KEY as string;
    const capabilities = getModelCapabilities(DEV_PAIR.modelId);
    const provider = new OpenRouterProvider({
      modelId: DEV_PAIR.modelId,
      apiKey,
      capabilities,
      routing: {
        zdr: true,
        dataCollection: "deny",
        allowFallbacks: true,
        maxPrice: { request: PER_CALL_MAX_PRICE_USD } as JsonObject,
      },
      live: {
        enabled: true,
        artifactRecorder: { recordProviderRun: async () => undefined },
        rawCapture: "disabled",
      },
    });

    // A trivial synthetic-public plain completion (no structured output → routable
    // under ZDR). synthetic_public keeps zdr:true + data_collection:deny.
    const request: ModelInvocationRequest = {
      taskKind: "experiment",
      modelId: DEV_PAIR.modelId,
      providerId: REQUESTED_PROVIDER_UNKNOWN,
      inputClassification: "synthetic_public",
      messages: [{ role: "user", content: "Reply with the single word: ok." }],
      generation: { maxOutputTokens: 16, temperature: 0 },
      maxPriceUsd: PER_CALL_MAX_PRICE_USD,
      prompt: {
        presetId: "itotori-235-reconcile-live",
        templateVersion: "v1",
        promptHash: "sha256:itotori-235-reconcile-live",
      },
    };

    const result = await provider.invoke(request);
    const run = result.providerRun;

    // (1) real billed cost + succeeded run.
    expect(run.status).toBe("succeeded");
    expect(run.cost.costKind).toBe("billed");
    const ledgerCostAmountUsd = run.cost.amountUsd; // the exact string persisted as cost_amount
    expect(ledgerCostAmountUsd.length).toBeGreaterThan(0);

    // (2) the generation id was captured onto the adapter metadata.
    const generationId = generationIdFromAdapterMetadata(result.adapterMetadata);
    expect(generationId).toBeTruthy();

    // (3) ZDR posture preserved on the recorded run.
    expect(run.routingPosture?.zdr).toBe(true);
    expect(run.routingPosture?.data_collection).toBe("deny");

    // (4) the served (model, provider) pair recorded.
    const servedPair = {
      model: run.provider.actualModelId,
      provider: run.provider.upstreamProvider,
    };
    expect(servedPair.model.length).toBeGreaterThan(0);

    // (5) THE CRUX — re-fetch canonical settled cost and reconcile within 1e-9,
    // tolerating the eventual-consistency window.
    const reconciliation = await reconcileLedgerRow(
      {
        generationId: generationId as string,
        costAmountUsd: ledgerCostAmountUsd,
        rowRef: run.runId,
      },
      { apiKey },
    );
    expect(reconciliation.withinTolerance).toBe(true);
    expect(Math.abs(reconciliation.driftUsd)).toBeLessThanOrEqual(1e-9);

    const summary = {
      node: "ITOTORI-235",
      generationId,
      ledgerCostAmountUsd,
      canonicalTotalCostUsd: reconciliation.canonicalTotalCostUsd,
      upstreamInferenceCostUsd: reconciliation.upstreamInferenceCostUsd,
      cacheDiscountUsd: reconciliation.cacheDiscountUsd,
      driftUsd: reconciliation.driftUsd,
      withinTolerance: reconciliation.withinTolerance,
      zdr: run.routingPosture?.zdr,
      dataCollection: run.routingPosture?.data_collection,
      servedPair,
    };
    const reportPath =
      env.ITOTORI_COST_RECONCILE_REPORT ?? "/tmp/itotori-235-reconcile-real-run.json";
    writeFileSync(reportPath, JSON.stringify(summary, null, 2), "utf8");
    // eslint-disable-next-line no-console
    console.log(`[i235-reconcile] ${JSON.stringify(summary)} report=${reportPath}`);
  }, 120_000);
});
