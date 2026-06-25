// ITOTORI-220 — required (modelId, providerId) pair across every agent
// seam.
//
// Per docs/proposals/alpha-gap-analysis-2026-06-24.md §3 and the standing
// feedback-model-provider-pair rule: every model invocation must declare
// BOTH a model id AND a specific provider id as a pair. This test file
// is the load-bearing assertion suite for that contract:
//
//   1. ModelInvocationRequest carries providerId as a required field.
//   2. OpenRouter emits provider: { only: [providerId] } at request time.
//   3. OpenRouter post-response check throws ModelProviderError with
//      code 'pair_mismatch' when the upstream provider differs.
//   4. ModelProviderError carries a 'pair_mismatch' code variant.
//   5. Recorded bundle key includes (modelId, providerId, promptHash,
//      inputClassification).
//   6. CapabilityGuard keys lookups by (modelId, providerId), not modelId.
//   7. RecordedModelProvider surfaces the requestedProviderId on its
//      ProviderRunIdentity.
//   8. Fake provider preserves the requestedProviderId end-to-end.

import { describe, expect, it } from "vitest";
import { FakeModelProvider } from "../src/providers/fake.js";
import {
  RecordedModelProvider,
  recordedBundleKey,
  type RecordedProviderBundle,
} from "../src/providers/recorded.js";
import { OpenRouterProvider, openRouterDefaultCapabilities } from "../src/providers/openrouter.js";
import {
  CapabilityGuard,
  CapabilityGuardMissError,
  modelProviderPairKey,
} from "../src/providers/capability-guard.js";
import { ModelProviderError, type ModelInvocationRequest } from "../src/providers/types.js";

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

  it("OpenRouter request body emits provider.only=[providerId] and pins allow_fallbacks=false", async () => {
    let observedBody: { provider: { only?: string[]; allow_fallbacks?: boolean } } | undefined;
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
    expect(observedBody?.provider.only).toEqual(["OpenAI"]);
    expect(observedBody?.provider.allow_fallbacks).toBe(false);
  });

  it("OpenRouter throws ModelProviderError code='pair_mismatch' when upstream provider differs", async () => {
    const recorder = { recordProviderRun: async () => undefined };
    const fetchMock: typeof fetch = async () =>
      jsonResponse({
        id: "gen-pair-mismatch",
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
    const error = await provider
      .invoke(baseRequest({ providerId: "OpenAI" }))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelProviderError);
    if (error instanceof ModelProviderError) {
      expect(error.code).toBe("pair_mismatch");
      expect(error.message).toContain("Together");
      expect(error.message).toContain("OpenAI");
    }
  });

  it("ModelProviderError exposes 'pair_mismatch' as a typed code variant", () => {
    const err = new ModelProviderError("test", "pair_mismatch", false);
    expect(err.code).toBe("pair_mismatch");
    expect(err.name).toBe("ModelProviderError");
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
      bundleId: "pair-test-bundle-001",
      capturedProviderFamily: "openrouter",
      capturedProviderName: "openrouter:pair-test",
      capturedRequestedModelId: "openai/gpt-4o-mini",
      capturedProviderId: "OpenAI",
      capturedActualModelId: "openai/gpt-4o-mini",
      responses: {
        [bundleKey]: { content: "ok", finishReason: "stop" },
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
