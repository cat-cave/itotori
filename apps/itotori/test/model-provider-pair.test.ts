// no-provider-name invariant — provider identity is a RECORDED OUTPUT, never
// a routing input, across every agent seam.
//
// Per Trevor's decisive routing ruling (2026-07-15): no provider is EVER named
// in production routing (no `only`, not even a soft `order` preference).
// OpenRouter picks the upstream on capability + ZDR + price; the (model,
// provider) pair that actually served is recorded for honesty/cost/telemetry.
// This file is the load-bearing assertion suite for that contract:
//
//   1. ModelInvocationRequest.providerId is OPTIONAL and is NEVER routed.
//   2. OpenRouter emits NO provider.order and NO provider.only — even when the
//      request carries a providerId hint — only capability + ZDR + fallbacks.
//   3. OpenRouter records the SERVED (model, provider) pair from the response;
//      whichever ZDR-allow-list provider OpenRouter routes to is a valid serve
//      (no provider-identity pin, no `pair_mismatch` throw).
//   4. Recorded bundle key includes (modelId, providerId, promptHash,
//      inputClassification) — a test-double LOOKUP key, not routing.
//   5. CapabilityGuard keys lookups by MODEL, not by a (model, provider) pair.
//   6. RecordedModelProvider surfaces the requestedProviderId on its
//      ProviderRunIdentity.
//   7. Fake provider preserves the requestedProviderId end-to-end.

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
  modelCapabilityKey,
} from "../src/providers/capability-guard.js";
import { REQUESTED_PROVIDER_UNKNOWN } from "../src/providers/types.js";
import type { ModelInvocationRequest, ProviderRunArtifact } from "../src/providers/types.js";

function baseRequest(overrides: Partial<ModelInvocationRequest> = {}): ModelInvocationRequest {
  return {
    taskKind: "experiment",
    modelId: "openai/gpt-4o-mini",
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

describe("no-provider-name — provider identity is a recorded output, never a routing input", () => {
  it("ModelInvocationRequest.providerId is OPTIONAL (a recorded hint), not required", () => {
    // Constructs cleanly with NO providerId — the request names no provider.
    const request = baseRequest();
    expect(request.providerId).toBeUndefined();
    expect(request.modelId).toBe("openai/gpt-4o-mini");
    // A providerId MAY be supplied as a recorded hint, but it is never routed.
    const hinted = baseRequest({ providerId: "OpenAI" });
    expect(hinted.providerId).toBe("OpenAI");
  });

  it("OpenRouter request body names NO provider (no order, no only) even when a providerId hint is present", async () => {
    let observedBody:
      | {
          provider: { order?: string[]; only?: string[]; allow_fallbacks?: boolean; zdr?: boolean };
        }
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
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4, cost: 0.000003 }, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
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
    // Even with a providerId HINT on the request, the wire names no provider.
    await provider.invoke(
      baseRequest({ providerId: "OpenAI", inputClassification: "private_corpus" }),
    );
    expect(observedBody?.provider.order).toBeUndefined();
    expect(observedBody?.provider.only).toBeUndefined();
    expect(observedBody?.provider.allow_fallbacks).toBe(true);
    expect(observedBody?.provider.zdr).toBe(true);
  });

  it("OpenRouter records the SERVED (model, provider) pair; the request named none, so requestedProviderId is explicit-unknown", async () => {
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
        provider: "Together",
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: "ok" },
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4, cost: 0.000003 }, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
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
    // We named no provider; OpenRouter served 'Together' (a ZDR-allow-list
    // member by construction). Accept and record the served pair + real billed
    // cost, never throw.
    const result = await provider.invoke(baseRequest());
    expect(result.providerRun.status).toBe("succeeded");
    expect(result.providerRun.provider.requestedProviderId).toBe(REQUESTED_PROVIDER_UNKNOWN);
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
    // Different bundle providerId (a lookup key, not routing) yields a different key.
    expect(key1).not.toEqual(key2);
    // Same inputs yield a stable key.
    expect(key1).toEqual(key3);
    // Key format is sha256:hex (64 chars after prefix).
    expect(key1).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("CapabilityGuard keys lookups by MODEL (no provider named)", () => {
    const guard = new CapabilityGuard();
    const caps = openRouterDefaultCapabilities;
    guard.register("openai/gpt-4o-mini", caps);
    expect(guard.has("openai/gpt-4o-mini")).toBe(true);
    // A different MODEL is a separate registration.
    expect(guard.has("anthropic/claude-sonnet-4")).toBe(false);
    // Miss on an unregistered model throws.
    expect(() => guard.lookup("anthropic/claude-sonnet-4")).toThrow(CapabilityGuardMissError);
    // Lookup-hit returns the registered capabilities object identity.
    expect(guard.lookup("openai/gpt-4o-mini")).toBe(caps);
    // The capability key is the model id alone — no `::provider` component.
    expect(modelCapabilityKey("openai/gpt-4o-mini")).toBe("openai/gpt-4o-mini");
  });

  it("RecordedModelProvider surfaces requestedProviderId on the ProviderRunIdentity", async () => {
    const bundleKey = recordedBundleKey({
      modelId: "openai/gpt-4o-mini",
      // The replay caller names no provider, so the bundle is keyed under the
      // explicit-unknown requested identity.
      providerId: REQUESTED_PROVIDER_UNKNOWN,
      promptHash: "sha256:cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe",
      inputClassification: "synthetic_public",
    });
    const bundle: RecordedProviderBundle = {
      schemaVersion: RECORDED_PROVIDER_BUNDLE_SCHEMA_VERSION,
      bundleId: "pair-test-bundle-001",
      capturedProviderFamily: "openrouter",
      capturedProviderName: "openrouter:pair-test",
      capturedRequestedModelId: "openai/gpt-4o-mini",
      // The SERVED provider (recorded output) captured for this replay.
      capturedProviderId: "OpenAI",
      capturedActualModelId: "openai/gpt-4o-mini",
      responses: {
        [bundleKey]: {
          content: "ok",
          finishReason: "stop",
          cost: ZERO_COST,
          tokenUsage: {
            tokenCountSource: "provider_reported",
            promptTokens: 3,
            completionTokens: 1,
            totalTokens: 4,
          },
          // no-provider-name invariant — the captured posture names no provider.
          routingPosture: {
            order: [],
            allow_fallbacks: true,
            data_collection: "deny",
            zdr: true,
            require_parameters: true,
          },
          usageResponseJson: { _synthetic_pair_contract_test: true },
        },
      },
    };
    const provider = new RecordedModelProvider({ bundle });
    const result = await provider.invoke(baseRequest());
    // The request named no provider → explicit-unknown requested identity.
    expect(result.providerRun.provider.requestedProviderId).toBe(REQUESTED_PROVIDER_UNKNOWN);
    // The served upstream is the recorded output captured in the bundle.
    expect(result.providerRun.provider.upstreamProvider).toBe("OpenAI");
  });

  it("FakeModelProvider preserves an explicitly-supplied requestedProviderId end-to-end", async () => {
    const provider = new FakeModelProvider({
      modelId: "itotori-fake-pair-v0",
      providerName: "itotori-fixture",
      generate: () => "pair-test",
    });
    // A fake/local test double MAY carry a stable local id as a recorded hint.
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
