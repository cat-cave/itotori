// ITOTORI-228 — RecordedModelProvider replays captured real cost
// (mirrors `usage.cost` verbatim instead of hardcoding zero).
//
// Acceptance contract (per
// docs/proposals/openrouter-audit-consolidation-2026-06-25.md §2 node 5):
//   1. A bundle constructed from a captured LIVE-mode artifact carrying a
//      real `usage.cost` replays with `ProviderRunRecord.cost` equal to
//      the captured value — NOT the hardcoded `{ costKind: 'zero',
//      amountMicrosUsd: 0 }` that the pre-ITOTORI-228 implementation
//      returned.
//   2. The cost-cap arithmetic test (openrouter-provider.test.ts:182)
//      passes unchanged (covered there; this file owns the replay-side
//      contract).
//   3. Pre-ITOTORI-228 bundles (missing the new required `cost` field on
//      response, or missing the `schemaVersion` envelope) fail at
//      `RecordedModelProvider` construction with the typed
//      `RecordedBundleSchemaMismatchError`.
//   4. Two bundles merged via `mergeRecordedBundles` raise the typed
//      `RecordedCostMismatchError` when they carry different captured
//      costs under the same key (the audit's
//      "RecordedCostMismatchError downgraded to a warning" anti-pattern
//      is prevented by the typed-error path).

import { describe, expect, it } from "vitest";
import { ZERO_COST, usageCostToMicros } from "../src/providers/cost.js";
import {
  RECORDED_PROVIDER_BUNDLE_SCHEMA_VERSION,
  RecordedBundleSchemaMismatchError,
  RecordedCostMismatchError,
  RecordedModelProvider,
  mergeRecordedBundles,
  recordedBundleKey,
  type RecordedProviderBundle,
} from "../src/providers/recorded.js";
import type { ModelInvocationRequest, ProviderCost } from "../src/providers/types.js";

function baseRequest(overrides: Partial<ModelInvocationRequest> = {}): ModelInvocationRequest {
  return {
    taskKind: "experiment",
    modelId: "anthropic/claude-3.5-sonnet",
    providerId: "anthropic",
    inputClassification: "synthetic_public",
    prompt: {
      presetId: "itotori-228-cost-replay",
      templateVersion: "1.0.0",
      promptHash: "sha256:cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe",
    },
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  };
}

function keyFor(request: ModelInvocationRequest): string {
  return recordedBundleKey({
    modelId: request.modelId,
    providerId: request.providerId,
    promptHash: request.prompt.promptHash,
    inputClassification: request.inputClassification,
  });
}

function bundleWith(
  request: ModelInvocationRequest,
  cost: ProviderCost,
  overrides: Partial<RecordedProviderBundle> = {},
): RecordedProviderBundle {
  return {
    schemaVersion: RECORDED_PROVIDER_BUNDLE_SCHEMA_VERSION,
    bundleId: "itotori-228-cost-replay-bundle",
    capturedProviderFamily: "openrouter",
    capturedProviderName: "openrouter:itotori-228-test",
    capturedRequestedModelId: request.modelId,
    capturedProviderId: request.providerId,
    capturedActualModelId: request.modelId,
    responses: {
      [keyFor(request)]: {
        content: "captured-response",
        finishReason: "stop",
        cost,
        // ITOTORI-230 — canonical alpha posture stand-in; the cost
        // replay test asserts cost shape, not posture content. A real
        // capture would mirror the actual wire-level posture.
        routingPosture: {
          only: [request.providerId],
          allow_fallbacks: false,
          data_collection: "deny",
          zdr: true,
          require_parameters: true,
        },
      },
    },
    ...overrides,
  };
}

describe("ITOTORI-228 — RecordedModelProvider replays captured real cost", () => {
  it("replays captured real cost (not hardcoded zero) — billed", async () => {
    // Mirrors the live-evidence shape from
    // docs/openrouter-integration-evidence/2026-06-25.json: a small
    // decimal `usage.cost` string that the live OR adapter would have
    // converted to micros via `usageCostToMicros`. The recorded bundle
    // carries that already-converted value verbatim.
    const capturedAmountMicrosUsd = usageCostToMicros("0.00000602");
    expect(capturedAmountMicrosUsd).toBe(6);

    const capturedCost: ProviderCost = {
      costKind: "billed",
      currency: "USD",
      amountMicrosUsd: capturedAmountMicrosUsd,
    };
    const request = baseRequest();
    const provider = new RecordedModelProvider({
      bundle: bundleWith(request, capturedCost),
    });

    const result = await provider.invoke(request);

    expect(result.providerRun.cost.costKind).toBe("billed");
    expect(result.providerRun.cost.amountMicrosUsd).toBe(capturedAmountMicrosUsd);
    expect(result.providerRun.cost.currency).toBe("USD");
    // Sanity: the cost is NOT the pre-fix hardcoded zero shape.
    expect(result.providerRun.cost).not.toEqual({
      costKind: "zero",
      currency: "USD",
      amountMicrosUsd: 0,
    });
  });

  it("replays captured zero cost as zero (genuinely-free upstream call survives the schema)", async () => {
    const request = baseRequest({
      providerId: "OpenAI",
      modelId: "openai/gpt-4o-mini",
    });
    const provider = new RecordedModelProvider({
      bundle: bundleWith(request, ZERO_COST),
    });

    const result = await provider.invoke(request);

    expect(result.providerRun.cost).toEqual(ZERO_COST);
  });

  it("two replays of the same bundle yield byte-equal cost (replay determinism)", async () => {
    const capturedCost: ProviderCost = {
      costKind: "billed",
      currency: "USD",
      amountMicrosUsd: 12_345,
    };
    const request = baseRequest();
    const provider = new RecordedModelProvider({
      bundle: bundleWith(request, capturedCost),
    });

    const first = await provider.invoke(request);
    const second = await provider.invoke(request);

    expect(first.providerRun.cost).toEqual(second.providerRun.cost);
    expect(JSON.stringify(first.providerRun.cost)).toEqual(JSON.stringify(second.providerRun.cost));
  });

  it("refuses a bundle whose schemaVersion is missing (pre-ITOTORI-228 forcing function)", () => {
    const request = baseRequest();
    const stale = {
      // No `schemaVersion` field — exactly the shape a pre-ITOTORI-228
      // bundle on disk would have.
      bundleId: "pre-itotori-228-bundle",
      capturedProviderFamily: "openrouter" as const,
      capturedProviderName: "openrouter:pre-itotori-228",
      capturedRequestedModelId: request.modelId,
      capturedProviderId: request.providerId,
      capturedActualModelId: request.modelId,
      responses: {
        [keyFor(request)]: {
          content: "captured-response",
          finishReason: "stop",
          // Even with a cost on the response, the bundle envelope's
          // missing schemaVersion is fatal.
          cost: ZERO_COST,
        },
      },
    } as unknown as RecordedProviderBundle;

    expect(() => new RecordedModelProvider({ bundle: stale })).toThrow(
      RecordedBundleSchemaMismatchError,
    );
  });

  it("refuses a bundle whose response is missing required cost field", () => {
    const request = baseRequest();
    const malformed = {
      schemaVersion: RECORDED_PROVIDER_BUNDLE_SCHEMA_VERSION,
      bundleId: "missing-cost-bundle",
      capturedProviderFamily: "openrouter" as const,
      capturedProviderName: "openrouter:missing-cost",
      capturedRequestedModelId: request.modelId,
      capturedProviderId: request.providerId,
      capturedActualModelId: request.modelId,
      responses: {
        [keyFor(request)]: {
          content: "captured-response",
          finishReason: "stop",
          // cost intentionally omitted (the type would normally refuse;
          // the cast simulates a pre-fix on-disk bundle reaching the
          // constructor at runtime).
        },
      },
    } as unknown as RecordedProviderBundle;

    expect(() => new RecordedModelProvider({ bundle: malformed })).toThrow(
      RecordedBundleSchemaMismatchError,
    );
  });

  it("refuses a bundle whose response is missing routingPosture (ITOTORI-230 / v2 forcing function)", () => {
    const request = baseRequest();
    const malformed = {
      schemaVersion: RECORDED_PROVIDER_BUNDLE_SCHEMA_VERSION,
      bundleId: "missing-routing-posture-bundle",
      capturedProviderFamily: "openrouter" as const,
      capturedProviderName: "openrouter:missing-posture",
      capturedRequestedModelId: request.modelId,
      capturedProviderId: request.providerId,
      capturedActualModelId: request.modelId,
      responses: {
        [keyFor(request)]: {
          content: "captured-response",
          finishReason: "stop",
          cost: ZERO_COST,
          // routingPosture intentionally omitted — exactly what a
          // pre-ITOTORI-230 (v1) bundle on disk would have looked like.
        },
      },
    } as unknown as RecordedProviderBundle;

    expect(() => new RecordedModelProvider({ bundle: malformed })).toThrow(
      RecordedBundleSchemaMismatchError,
    );
  });

  it("refuses a bundle whose routingPosture.allow_fallbacks is not literal false (ITOTORI-220 pin)", () => {
    const request = baseRequest();
    const stale = {
      schemaVersion: RECORDED_PROVIDER_BUNDLE_SCHEMA_VERSION,
      bundleId: "bad-allow-fallbacks-bundle",
      capturedProviderFamily: "openrouter" as const,
      capturedProviderName: "openrouter:bad-allow-fallbacks",
      capturedRequestedModelId: request.modelId,
      capturedProviderId: request.providerId,
      capturedActualModelId: request.modelId,
      responses: {
        [keyFor(request)]: {
          content: "captured-response",
          finishReason: "stop",
          cost: ZERO_COST,
          routingPosture: {
            only: [request.providerId],
            // allow_fallbacks: true is forbidden — pair pin requires false.
            allow_fallbacks: true,
            data_collection: "deny",
            zdr: true,
            require_parameters: true,
          },
        },
      },
    } as unknown as RecordedProviderBundle;

    expect(() => new RecordedModelProvider({ bundle: stale })).toThrow(
      RecordedBundleSchemaMismatchError,
    );
  });

  it("replays captured routingPosture verbatim onto the ProviderRunRecord", async () => {
    const request = baseRequest();
    const capturedPosture = {
      only: [request.providerId],
      allow_fallbacks: false as const,
      data_collection: "deny" as const,
      zdr: true,
      require_parameters: true,
    };
    const bundle = bundleWith(request, ZERO_COST);
    // Replace the auto-built posture with a specific captured value so
    // we can assert byte-equal replay.
    bundle.responses[keyFor(request)]!.routingPosture = capturedPosture;
    const provider = new RecordedModelProvider({ bundle });
    const result = await provider.invoke(request);
    expect(result.providerRun.routingPosture).toEqual(capturedPosture);
  });

  it("refuses a bundle whose response cost has an invalid costKind (post-ITOTORI-225 narrowing)", () => {
    const request = baseRequest();
    const stale = {
      schemaVersion: RECORDED_PROVIDER_BUNDLE_SCHEMA_VERSION,
      bundleId: "stale-costkind-bundle",
      capturedProviderFamily: "openrouter" as const,
      capturedProviderName: "openrouter:stale-costkind",
      capturedRequestedModelId: request.modelId,
      capturedProviderId: request.providerId,
      capturedActualModelId: request.modelId,
      responses: {
        [keyFor(request)]: {
          content: "captured-response",
          finishReason: "stop",
          cost: { costKind: "provider_estimate", currency: "USD", amountMicrosUsd: 5 }, // itotori-225-audit-allow: boundary test that the legacy enum value is rejected by RecordedBundleSchemaMismatchError
          // ITOTORI-230 — the boundary test asserts the cost-kind check
          // fires; a valid posture is supplied so we exercise the cost
          // validation independently of the posture validation.
          routingPosture: {
            only: [request.providerId],
            allow_fallbacks: false,
            data_collection: "deny",
            zdr: true,
            require_parameters: true,
          },
        },
      },
    } as unknown as RecordedProviderBundle;

    expect(() => new RecordedModelProvider({ bundle: stale })).toThrow(
      RecordedBundleSchemaMismatchError,
    );
  });

  it("mergeRecordedBundles raises RecordedCostMismatchError on conflicting captured costs", () => {
    const request = baseRequest();
    const key = keyFor(request);

    const left: RecordedProviderBundle = bundleWith(
      request,
      { costKind: "billed", currency: "USD", amountMicrosUsd: 100 },
      { bundleId: "left-bundle" },
    );
    const right: RecordedProviderBundle = bundleWith(
      request,
      { costKind: "billed", currency: "USD", amountMicrosUsd: 200 },
      { bundleId: "right-bundle" },
    );

    let caught: unknown;
    try {
      mergeRecordedBundles(left, right);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RecordedCostMismatchError);
    if (caught instanceof RecordedCostMismatchError) {
      expect(caught.bundleKey).toBe(key);
      expect(caught.leftBundleId).toBe("left-bundle");
      expect(caught.rightBundleId).toBe("right-bundle");
      expect(caught.leftCost.amountMicrosUsd).toBe(100);
      expect(caught.rightCost.amountMicrosUsd).toBe(200);
    }
  });

  it("mergeRecordedBundles succeeds when the same key carries identical costs", () => {
    const request = baseRequest();
    const cost: ProviderCost = {
      costKind: "billed",
      currency: "USD",
      amountMicrosUsd: 7,
    };
    const left = bundleWith(request, cost, { bundleId: "left-bundle" });
    const right = bundleWith(request, cost, { bundleId: "right-bundle" });

    const merged = mergeRecordedBundles(left, right);
    expect(merged.bundleId).toBe("left-bundle");
    expect(Object.keys(merged.responses)).toHaveLength(1);
  });
});
