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
  // ITOTORI-232 — bundle schema v3 requires usageResponseJson on every
  // response. For a billed capture we mirror the captured FULL-PRECISION
  // `cost.amountUsd` into `usageResponseJson.cost` (USD decimal) so the
  // bundle-construction CHECK (assertUsageResponseMatchesCost) compares
  // like-for-like and a sub-micro cost (0.00000602) round-trips intact;
  // deriving it from rounded micros would re-introduce the very defect
  // this suite guards against. For a zero-cost capture we omit the `cost`
  // key so the partial-NULL CHECK exempts the ledger row on persist.
  const usageResponseJson =
    cost.costKind === "zero"
      ? { _synthetic_zero_cost: true }
      : { prompt_tokens: 4, completion_tokens: 4, cost: Number(cost.amountUsd) };
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
        // genaudit2-01 — recorded responses carry the REAL captured token
        // counts (a capture of a real call always does). Mirror the
        // prompt/completion counts the usageResponseJson records so the
        // bundle is internally consistent. There is no char/4 fallback any
        // more: omitting this field is now a construction-time schema error.
        tokenUsage: {
          tokenCountSource: "provider_reported",
          promptTokens: 4,
          completionTokens: 4,
          totalTokens: 8,
        },
        cost,
        // ITOTORI-230 — canonical alpha posture stand-in; the cost
        // replay test asserts cost shape, not posture content. A real
        // capture would mirror the actual wire-level posture.
        routingPosture: {
          order: [request.providerId],
          allow_fallbacks: false,
          data_collection: "deny",
          zdr: true,
          require_parameters: true,
        },
        usageResponseJson,
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
      // ITOTORI-232 — the AUTHORITATIVE full-precision cost. `amountMicrosUsd`
      // rounds this sub-micro value to 6 (= 0.000006), a 2e-8 error that the
      // ledger CHECK rejects; `amountUsd` carries the exact upstream decimal
      // so the replayed-and-persisted row holds within 1e-9.
      amountUsd: "0.00000602", // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
      amountMicrosUsd: capturedAmountMicrosUsd,
    };
    const request = baseRequest();
    const provider = new RecordedModelProvider({
      bundle: bundleWith(request, capturedCost),
    });

    const result = await provider.invoke(request);

    expect(result.providerRun.cost.costKind).toBe("billed");
    expect(result.providerRun.cost.amountMicrosUsd).toBe(capturedAmountMicrosUsd);
    // The replayed cost carries the sub-micro tail verbatim — NOT the
    // micros-rounded 0.000006.
    expect(result.providerRun.cost.amountUsd).toBe("0.00000602");
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
      amountUsd: "0.012345", // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
      amountMicrosUsd: 12_345, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
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

  it("ITOTORI-241: refuses a bundle whose routingPosture.order is empty or whose allow_fallbacks is non-boolean", () => {
    const request = baseRequest();
    // Empty `order` is rejected: a recorded posture must name at least the
    // preferred provider it routed to. (The old invariant forbade
    // allow_fallbacks:true; that is now a legal, expected live value.)
    const emptyOrder = {
      schemaVersion: RECORDED_PROVIDER_BUNDLE_SCHEMA_VERSION,
      bundleId: "bad-order-bundle",
      capturedProviderFamily: "openrouter" as const,
      capturedProviderName: "openrouter:bad-order",
      capturedRequestedModelId: request.modelId,
      capturedProviderId: request.providerId,
      capturedActualModelId: request.modelId,
      responses: {
        [keyFor(request)]: {
          content: "captured-response",
          finishReason: "stop",
          cost: ZERO_COST,
          routingPosture: {
            order: [],
            allow_fallbacks: true,
            data_collection: "deny",
            zdr: true,
            require_parameters: true,
          },
        },
      },
    } as unknown as RecordedProviderBundle;
    expect(() => new RecordedModelProvider({ bundle: emptyOrder })).toThrow(
      RecordedBundleSchemaMismatchError,
    );

    // Non-boolean allow_fallbacks is rejected (it is now a real boolean).
    const badFallbacks = {
      ...emptyOrder,
      bundleId: "bad-allow-fallbacks-bundle",
      responses: {
        [keyFor(request)]: {
          content: "captured-response",
          finishReason: "stop",
          cost: ZERO_COST,
          routingPosture: {
            order: [request.providerId],
            allow_fallbacks: "yes",
            data_collection: "deny",
            zdr: true,
            require_parameters: true,
          },
        },
      },
    } as unknown as RecordedProviderBundle;
    expect(() => new RecordedModelProvider({ bundle: badFallbacks })).toThrow(
      RecordedBundleSchemaMismatchError,
    );
  });

  it("replays captured routingPosture verbatim onto the ProviderRunRecord", async () => {
    const request = baseRequest();
    const capturedPosture = {
      order: [request.providerId],
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
            order: [request.providerId],
            allow_fallbacks: false,
            data_collection: "deny",
            zdr: true,
            require_parameters: true,
          },
          // ITOTORI-232 — supply a valid usageResponseJson so the
          // costKind check fires before the usage-block check.
          usageResponseJson: { cost: 0.000005 }, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
        },
      },
    } as unknown as RecordedProviderBundle;

    expect(() => new RecordedModelProvider({ bundle: stale })).toThrow(
      RecordedBundleSchemaMismatchError,
    );
  });

  it("refuses a bundle whose response is missing usageResponseJson (ITOTORI-232 / v3 forcing function)", () => {
    const request = baseRequest();
    const malformed = {
      schemaVersion: RECORDED_PROVIDER_BUNDLE_SCHEMA_VERSION,
      bundleId: "missing-usage-bundle",
      capturedProviderFamily: "openrouter" as const,
      capturedProviderName: "openrouter:missing-usage",
      capturedRequestedModelId: request.modelId,
      capturedProviderId: request.providerId,
      capturedActualModelId: request.modelId,
      responses: {
        [keyFor(request)]: {
          content: "captured-response",
          finishReason: "stop",
          cost: ZERO_COST,
          routingPosture: {
            order: [request.providerId],
            allow_fallbacks: false,
            data_collection: "deny",
            zdr: true,
            require_parameters: true,
          },
          // usageResponseJson intentionally omitted — exactly what a
          // pre-ITOTORI-232 (v2) bundle on disk would have looked like.
          // Replaying without it would let the ledger row claim a
          // different cost than the LIVE run that produced the bundle.
        },
      },
    } as unknown as RecordedProviderBundle;

    expect(() => new RecordedModelProvider({ bundle: malformed })).toThrow(
      RecordedBundleSchemaMismatchError,
    );
  });

  it("genaudit2-01: refuses a recorded response that lacks a REAL token count (no char/4 laundering)", () => {
    const request = baseRequest();
    // A well-formed v3 response EXCEPT for its tokenUsage. Helper lets each
    // case mutate only the token field so we prove the token guard fires
    // independently of cost / posture / usageResponseJson validation.
    const malformedWith = (tokenUsage: unknown): RecordedProviderBundle =>
      ({
        schemaVersion: RECORDED_PROVIDER_BUNDLE_SCHEMA_VERSION,
        bundleId: "missing-real-token-count-bundle",
        capturedProviderFamily: "openrouter" as const,
        capturedProviderName: "openrouter:missing-token-count",
        capturedRequestedModelId: request.modelId,
        capturedProviderId: request.providerId,
        capturedActualModelId: request.modelId,
        responses: {
          [keyFor(request)]: {
            content: "captured-response",
            finishReason: "stop",
            cost: ZERO_COST,
            routingPosture: {
              order: [request.providerId],
              allow_fallbacks: false,
              data_collection: "deny",
              zdr: true,
              require_parameters: true,
            },
            usageResponseJson: { _synthetic_zero_cost: true },
            ...(tokenUsage === undefined ? {} : { tokenUsage }),
          },
        },
      }) as unknown as RecordedProviderBundle;

    // 1. tokenUsage omitted entirely — pre-genaudit2-01 this silently fell
    //    back to defaultTokenUsage() → a char/4 estimate tagged
    //    `deterministic_counter`. Now a construction-time schema error.
    expect(() => new RecordedModelProvider({ bundle: malformedWith(undefined) })).toThrow(
      RecordedBundleSchemaMismatchError,
    );

    // 2. The exact laundering shape the old fallback produced: a char/4
    //    estimate dressed up as `deterministic_counter`. It must NOT be
    //    accepted just because its provenance string is whitelisted — but
    //    here we prove the path that produced it is gone by rejecting a
    //    response that carries an honestly-tagged `estimated` count: a
    //    non-real provenance is incomplete evidence.
    expect(
      () =>
        new RecordedModelProvider({
          bundle: malformedWith({
            tokenCountSource: "estimated",
            promptTokens: 3,
            completionTokens: 4,
            totalTokens: 7,
          }),
        }),
    ).toThrow(RecordedBundleSchemaMismatchError);

    // 3. `unknown` provenance (provider omitted the usage block) is likewise
    //    rejected — not coerced to a count.
    expect(
      () =>
        new RecordedModelProvider({
          bundle: malformedWith({
            tokenCountSource: "unknown",
            promptTokens: 3,
            completionTokens: 4,
          }),
        }),
    ).toThrow(RecordedBundleSchemaMismatchError);

    // 4. Real provenance but a missing completion count is still incomplete
    //    evidence — no `?? 0` / `?? estimate` coercion survives.
    expect(
      () =>
        new RecordedModelProvider({
          bundle: malformedWith({ tokenCountSource: "provider_reported", promptTokens: 3 }),
        }),
    ).toThrow(RecordedBundleSchemaMismatchError);
  });

  it("genaudit2-01: replays the captured REAL token count verbatim (the only accepted path)", async () => {
    // A bundle that carries genuine provider-reported counts constructs and
    // replays them byte-for-byte — proving the fix removed the laundered
    // fallback WITHOUT breaking the real recorded-replay contract.
    const request = baseRequest();
    const provider = new RecordedModelProvider({ bundle: bundleWith(request, ZERO_COST) });
    const result = await provider.invoke(request);
    expect(result.providerRun.tokenUsage).toEqual({
      tokenCountSource: "provider_reported",
      promptTokens: 4,
      completionTokens: 4,
      totalTokens: 8,
    });
  });

  it("refuses a v3 bundle whose usageResponseJson.cost mismatches the captured ProviderCost", () => {
    const request = baseRequest();
    const stale = {
      schemaVersion: RECORDED_PROVIDER_BUNDLE_SCHEMA_VERSION,
      bundleId: "usage-cost-mismatch-bundle",
      capturedProviderFamily: "openrouter" as const,
      capturedProviderName: "openrouter:usage-cost-mismatch",
      capturedRequestedModelId: request.modelId,
      capturedProviderId: request.providerId,
      capturedActualModelId: request.modelId,
      responses: {
        [keyFor(request)]: {
          content: "captured-response",
          finishReason: "stop",
          // captured ProviderCost claims $0.01 USD …
          cost: { costKind: "billed", currency: "USD", amountUsd: "0.01", amountMicrosUsd: 10_000 }, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
          routingPosture: {
            order: [request.providerId],
            allow_fallbacks: false,
            data_collection: "deny",
            zdr: true,
            require_parameters: true,
          },
          // … but the captured usage block says $99 USD. The replay
          // would silently disagree with itself; bundle construction
          // must reject this before any caller sees the bundle.
          usageResponseJson: { cost: 99 }, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
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
      { costKind: "billed", currency: "USD", amountUsd: "0.0001", amountMicrosUsd: 100 }, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
      { bundleId: "left-bundle" },
    );
    const right: RecordedProviderBundle = bundleWith(
      request,
      { costKind: "billed", currency: "USD", amountUsd: "0.0002", amountMicrosUsd: 200 }, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
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
      amountUsd: "0.000007", // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
      amountMicrosUsd: 7, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
    };
    const left = bundleWith(request, cost, { bundleId: "left-bundle" });
    const right = bundleWith(request, cost, { bundleId: "right-bundle" });

    const merged = mergeRecordedBundles(left, right);
    expect(merged.bundleId).toBe("left-bundle");
    expect(Object.keys(merged.responses)).toHaveLength(1);
  });
});
