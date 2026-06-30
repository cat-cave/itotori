// ITOTORI-220 — required (modelId, providerId) pair across every agent
// seam.
//
// Per docs/proposals/alpha-gap-analysis-2026-06-24.md §3 and the standing
// feedback-model-provider-pair rule: every model invocation must declare
// BOTH a model id AND a specific provider id as a pair. This test file
// is the load-bearing assertion suite for that contract:
//
//   1. ModelInvocationRequest carries providerId as a required field.
//   2. OpenRouter emits provider: { order: [providerId] } (preference)
//      with allow_fallbacks:true at request time (ITOTORI-241).
//   3. ITOTORI-243 — OpenRouter records the served (model, providerId)
//      pair from the response (any ZDR-allow-list provider OpenRouter
//      routes to is a valid serve); there is no provider-identity pin and
//      no `pair_mismatch` throw.
//   5. Recorded bundle key includes (modelId, providerId, promptHash,
//      inputClassification).
//   6. CapabilityGuard keys lookups by (modelId, providerId), not modelId.
//   7. RecordedModelProvider surfaces the requestedProviderId on its
//      ProviderRunIdentity.
//   8. Fake provider preserves the requestedProviderId end-to-end.

import { describe, expect, it } from "vitest";
import { FakeModelProvider } from "../src/providers/fake.js";
import {
  RECORDED_PROVIDER_BUNDLE_SCHEMA_VERSION,
  RecordedModelProvider,
  recordedBundleKey,
  type RecordedProviderBundle,
} from "../src/providers/recorded.js";
import { ZERO_COST } from "../src/providers/cost.js";
import { OpenRouterProvider, openRouterDefaultCapabilities } from "../src/providers/openrouter.js";
import {
  CapabilityGuard,
  CapabilityGuardMissError,
  modelProviderPairKey,
} from "../src/providers/capability-guard.js";
import type { ModelInvocationRequest, ProviderRunArtifact } from "../src/providers/types.js";

function baseRequest(overrides: Partial<ModelInvocationRequest> = {}): ModelInvocationRequest {
  return {
    taskKind: "experiment",
    modelId: "openai/gpt-4o-mini",
    providerId: "OpenAI",
    inputClassification: "synthetic_public",
    prompt: {
      presetId: "itotori-pair-test",
      templateVersion: "1.0.0",
      promptHash: "sha256:cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe",
    },
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ITOTORI-220 — (modelId, providerId) pair contract", () => {
  it("ModelInvocationRequest carries providerId as a required field", () => {
    const request = baseRequest();
    // TypeScript would refuse to construct this without providerId; runtime
    // assertion mirrors the type-level invariant.
    expect(request.providerId).toBe("OpenAI");
    expect(request.modelId).toBe("openai/gpt-4o-mini");
  });

  it("ITOTORI-241: OpenRouter request body emits provider.order=[providerId] (preference) with allow_fallbacks=true and no `only` pin", async () => {
    let observedBody:
      | { provider: { order?: string[]; only?: string[]; allow_fallbacks?: boolean } }
      | undefined;
    const recorder = {
      recordProviderRun: async () => undefined,
    };
    const fetchMock: typeof fetch = async (_url, init) => {
      observedBody = JSON.parse(String(init?.body ?? "{}"));
      return jsonResponse({
        id: "gen-pair-test",
        model: "openai/gpt-4o-mini",
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: "ok" },
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4, cost: 0.000003 },
        openrouter_metadata: {
          endpoints: {
            available: [{ provider: "OpenAI", model: "openai/gpt-4o-mini", selected: true }],
          },
        },
      });
    };
    const provider = new OpenRouterProvider({
      modelId: "openai/gpt-4o-mini",
      apiKey: "test-key",
      fetch: fetchMock,
      capabilities: openRouterDefaultCapabilities,
      live: { enabled: true, artifactRecorder: recorder, rawCapture: "disabled" },
    });
    await provider.invoke(baseRequest({ inputClassification: "synthetic_public" }));
    expect(observedBody?.provider.order).toEqual(["OpenAI"]);
    expect(observedBody?.provider.allow_fallbacks).toBe(true);
    expect(observedBody?.provider.only).toBeUndefined();
  });

  it("ITOTORI-243: OpenRouter records the served (model, providerId) pair when the upstream provider differs from order[0]", async () => {
    const artifacts: ProviderRunArtifact[] = [];
    const recorder = {
      recordProviderRun: async (artifact: ProviderRunArtifact) => {
        artifacts.push(artifact);
      },
    };
    const fetchMock: typeof fetch = async () =>
      jsonResponse({
        id: "gen-served-pair",
        model: "openai/gpt-4o-mini",
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: "ok" },
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4, cost: 0.000003 },
        openrouter_metadata: {
          endpoints: {
            available: [{ provider: "Together", model: "openai/gpt-4o-mini", selected: true }],
          },
        },
      });
    const provider = new OpenRouterProvider({
      modelId: "openai/gpt-4o-mini",
      apiKey: "test-key",
      fetch: fetchMock,
      capabilities: openRouterDefaultCapabilities,
      live: { enabled: true, artifactRecorder: recorder, rawCapture: "disabled" },
    });
    // order[0] is 'OpenAI', OpenRouter served 'Together' (a ZDR-allow-list
    // member by construction). ITOTORI-243: accept and record the served
    // pair + real billed cost, never throw.
    const result = await provider.invoke(baseRequest({ providerId: "OpenAI" }));
    expect(result.providerRun.status).toBe("succeeded");
    expect(result.providerRun.provider.requestedProviderId).toBe("OpenAI");
    expect(result.providerRun.provider.upstreamProvider).toBe("Together");
    expect(result.providerRun.cost.costKind).toBe("billed");
    expect(result.providerRun.cost.amountMicrosUsd).toBe(3);
    expect(artifacts[0]?.run.provider.upstreamProvider).toBe("Together");
  });

  it("Recorded bundle key combines modelId + providerId + promptHash + inputClassification", () => {
    const key1 = recordedBundleKey({
      modelId: "openai/gpt-4o-mini",
      providerId: "OpenAI",
      promptHash: "sha256:abc",
      inputClassification: "private_corpus",
    });
    const key2 = recordedBundleKey({
      modelId: "openai/gpt-4o-mini",
      providerId: "Together",
      promptHash: "sha256:abc",
      inputClassification: "private_corpus",
    });
    const key3 = recordedBundleKey({
      modelId: "openai/gpt-4o-mini",
      providerId: "OpenAI",
      promptHash: "sha256:abc",
      inputClassification: "private_corpus",
    });
    // Different providerId yields a different key.
    expect(key1).not.toEqual(key2);
    // Same inputs yield a stable key.
    expect(key1).toEqual(key3);
    // Key format is sha256:hex (64 chars after prefix).
    expect(key1).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("CapabilityGuard keys lookups by (modelId, providerId) pair, not modelId alone", () => {
    const guard = new CapabilityGuard();
    const caps = openRouterDefaultCapabilities;
    guard.register("openai/gpt-4o-mini", "OpenAI", caps);
    // Same model on a different provider is a separate registration.
    expect(guard.has("openai/gpt-4o-mini", "OpenAI")).toBe(true);
    expect(guard.has("openai/gpt-4o-mini", "Together")).toBe(false);
    // Miss on the wrong provider throws.
    expect(() => guard.lookup("openai/gpt-4o-mini", "Together")).toThrow(CapabilityGuardMissError);
    // Lookup-hit returns the registered capabilities object identity.
    expect(guard.lookup("openai/gpt-4o-mini", "OpenAI")).toBe(caps);
    // Pair key includes both components.
    const pairKey = modelProviderPairKey("openai/gpt-4o-mini", "OpenAI");
    expect(pairKey).toBe("openai/gpt-4o-mini::OpenAI");
  });

  it("RecordedModelProvider surfaces requestedProviderId on the ProviderRunIdentity", async () => {
    const bundleKey = recordedBundleKey({
      modelId: "openai/gpt-4o-mini",
      providerId: "OpenAI",
      promptHash: "sha256:cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe",
      inputClassification: "synthetic_public",
    });
    const bundle: RecordedProviderBundle = {
      schemaVersion: RECORDED_PROVIDER_BUNDLE_SCHEMA_VERSION,
      bundleId: "pair-test-bundle-001",
      capturedProviderFamily: "openrouter",
      capturedProviderName: "openrouter:pair-test",
      capturedRequestedModelId: "openai/gpt-4o-mini",
      capturedProviderId: "OpenAI",
      capturedActualModelId: "openai/gpt-4o-mini",
      responses: {
        // ITOTORI-228 — pair-contract test; the assertion is on
        // providerId routing, not cost. ZERO_COST is the structurally
        // honest stand-in (no real LIVE call ever produced these bytes).
        [bundleKey]: {
          content: "ok",
          finishReason: "stop",
          cost: ZERO_COST,
          // genaudit2-01 — pair-contract test; well-formed real counts so
          // construction passes and the assertion is on providerId routing.
          tokenUsage: {
            tokenCountSource: "provider_reported",
            promptTokens: 3,
            completionTokens: 1,
            totalTokens: 4,
          },
          // ITOTORI-230 — pair-contract test; canonical alpha posture
          // stand-in (no real LIVE call ever produced these bytes).
          routingPosture: {
            order: ["OpenAI"],
            allow_fallbacks: true,
            data_collection: "deny",
            zdr: true,
            require_parameters: true,
          },
          // ITOTORI-232 — synthetic pair-contract bundle, no real LIVE
          // call. ZERO_COST + sentinel-shaped usage (no `cost` key) so
          // the bundle-construction check accepts the zero-cost
          // capture and the ledger CHECK exempts the row on persist.
          usageResponseJson: { _synthetic_pair_contract_test: true },
        },
      },
    };
    const provider = new RecordedModelProvider({ bundle });
    const result = await provider.invoke(baseRequest());
    expect(result.providerRun.provider.requestedProviderId).toBe("OpenAI");
    expect(result.providerRun.provider.upstreamProvider).toBe("OpenAI");
  });

  it("FakeModelProvider preserves the requestedProviderId end-to-end on its ProviderRunIdentity", async () => {
    const provider = new FakeModelProvider({
      modelId: "itotori-fake-pair-v0",
      providerName: "itotori-fixture",
      generate: () => "pair-test",
    });
    const result = await provider.invoke(
      baseRequest({
        modelId: "itotori-fake-pair-v0",
        providerId: "fake-fixture",
      }),
    );
    expect(result.providerRun.provider.requestedProviderId).toBe("fake-fixture");
    expect(result.providerRun.provider.requestedModelId).toBe("itotori-fake-pair-v0");
  });
});
