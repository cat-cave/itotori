import { ItotoriLlmAttributionRepository } from "@itotori/db";
import { describe, expect, it } from "vitest";
import { dispatch } from "../src/llm/dispatch.js";
import { createTransportObserver } from "../src/llm/physical-attempt-policy.js";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import {
  TestMemoCipher,
  dispatchHarness,
  physicalCallSpec,
  structuredProviderResponse,
} from "./llm-step-test-support.js";
import { reviewVerdictExample } from "./contract-fixtures-core.js";

import { requireLivePostgres } from "../../../packages/itotori-db/test/live-postgres-suite.js";

const postgresDescribe = requireLivePostgres(describe);

it("captures an OpenRouter generation ID from the first SSE chunk", async () => {
  const observer = createTransportObserver(async () =>
    structuredProviderResponse(reviewVerdictExample),
  );
  await observer.fetcher("https://provider.test/chat");
  await expect(observer.takeGenerationId()).resolves.toBe("generation:test");
});

postgresDescribe("physical provider-attribution ledger", () => {
  it("persists an unavailable route beside the physical receipt", async () => {
    const context = await isolatedMigratedContext();
    try {
      const harness = dispatchHarness({
        pool: context.pool,
        cipher: new TestMemoCipher(),
        prompt: "Return a review verdict whose generation is not published yet.",
        responses: [structuredProviderResponse(reviewVerdictExample, 0.00000425)],
      });
      const result = await dispatch(
        physicalCallSpec("Return a review verdict whose generation is not published yet."),
        harness.runtime,
      );
      expect(harness.transportCalls()).toBe(1);
      expect(result).toMatchObject({
        status: "success",
        generationId: null,
        served: { status: "unknown" },
      });

      const ledger = new ItotoriLlmAttributionRepository(context.pool);
      const rows = await context.pool.query<{
        memo_key: string;
        generation_id: string | null;
        attribution_status: string;
        served_pair_status: string;
      }>(`select memo_key, generation_id, attribution_status, served_pair_status
          from itotori_llm_provider_attributions`);
      expect(rows.rows).toEqual([
        {
          memo_key: result.memoKey,
          generation_id: null,
          attribution_status: "unavailable",
          served_pair_status: "unknown",
        },
      ]);
      await expect(ledger.pending(10)).resolves.toEqual([]);

      // A real transport capture supplies this ID before the physical receipt
      // is committed; model the publication-lag branch without another call.
      await context.pool.query(
        `update itotori_llm_provider_attributions
         set generation_id = 'generation:pending', attribution_status = 'pending',
             lookup_attempts = 1, next_lookup_at = now()
         where memo_key = $1`,
        [result.memoKey],
      );
      await expect(
        ledger.reconcilePending(10, async (generationId) => {
          expect(generationId).toBe("generation:pending");
          return {
            served: { status: "confirmed", model: "model:served", provider: "provider:served" },
            routerAttempts: [],
            reportedCostUsd: "0.00000425",
          };
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          memoKey: result.memoKey,
          status: "verified",
          served: { status: "confirmed", model: "model:served", provider: "provider:served" },
          lookupAttempts: 2,
          nextLookupAt: null,
        }),
      ]);
    } finally {
      await context.close();
    }
  });
});
