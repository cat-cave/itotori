// ITOTORI-221 — OpenRouterModelProvider unit tests.
//
// These tests cover the wrapper-layer responsibilities the
// OpenRouterModelProvider adds on top of the existing OpenRouterProvider:
//
//   - constructor reads OPENROUTER_API_KEY from process.env (default
//     env var name; never reads .env)
//   - missing env var raises OpenRouterMissingApiKeyError at construction
//   - request body still pins provider: { only: [providerId],
//     allow_fallbacks: false } per ITOTORI-220
//   - mismatched upstream provider raises ModelProviderError
//     { code: "pair_mismatch" }
//   - per-process USD cost cap raises OpenRouterCostCapError BEFORE
//     the HTTP request fires (third call mocked at $0.60 each so the
//     cumulative >$1.00 cap rejects without a network hit)
//   - token-bucket rate limit serialises three back-to-back invocations
//     at 1 rps using a controllable clock + sleep injection
//   - the CapabilityGuard registers the DEV_PAIR (modelId, providerId)
//     on construction

import { describe, expect, it, vi } from "vitest";
import {
  CapabilityGuard,
  DEV_PAIR,
  ModelProviderError,
  OpenRouterCostCapError,
  OpenRouterMissingApiKeyError,
  OpenRouterModelProvider,
  type ModelInvocationRequest,
} from "../src/providers/index.js";

function baseRequest(overrides: Partial<ModelInvocationRequest> = {}): ModelInvocationRequest {
  return {
    taskKind: "experiment",
    modelId: DEV_PAIR.modelId,
    providerId: DEV_PAIR.providerId,
    inputClassification: "synthetic_public",
    prompt: {
      presetId: "itotori-221-test",
      templateVersion: "1.0.0",
      promptHash: "sha256:" + "a".repeat(64),
    },
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  };
}

function successResponse(opts: {
  upstreamProvider?: string;
  costUsd?: number;
  modelId?: string;
}): Response {
  const body = {
    id: "gen-test-" + Math.random().toString(36).slice(2, 10),
    model: opts.modelId ?? DEV_PAIR.modelId,
    provider: opts.upstreamProvider ?? DEV_PAIR.providerId,
    choices: [
      {
        finish_reason: "stop",
        message: { role: "assistant", content: "hi" },
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      cost: opts.costUsd ?? 0.001,
    },
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("OpenRouterModelProvider — env + construction", () => {
  it("throws OpenRouterMissingApiKeyError when the env var is unset", () => {
    expect(
      () =>
        new OpenRouterModelProvider({
          env: {},
          httpClient: vi.fn() as unknown as typeof fetch,
        }),
    ).toThrow(OpenRouterMissingApiKeyError);
  });

  it("throws OpenRouterMissingApiKeyError when the env var is the empty string", () => {
    expect(
      () =>
        new OpenRouterModelProvider({
          env: { OPENROUTER_API_KEY: "" },
          httpClient: vi.fn() as unknown as typeof fetch,
        }),
    ).toThrow(OpenRouterMissingApiKeyError);
  });

  it("honours apiKeyEnvVar override and reads from the provided env", () => {
    const provider = new OpenRouterModelProvider({
      apiKeyEnvVar: "MY_CUSTOM_KEY",
      env: { MY_CUSTOM_KEY: "abc-123" },
      httpClient: vi.fn() as unknown as typeof fetch,
    });
    expect(provider.apiKeyEnvVar).toBe("MY_CUSTOM_KEY");
  });

  it("registers DEV_PAIR + known production pairs into the CapabilityGuard at construction", () => {
    const guard = new CapabilityGuard();
    new OpenRouterModelProvider({
      env: { OPENROUTER_API_KEY: "abc" },
      capabilityGuard: guard,
      httpClient: vi.fn() as unknown as typeof fetch,
    });
    expect(guard.has(DEV_PAIR.modelId, DEV_PAIR.providerId)).toBe(true);
    const registered = guard.registeredPairs();
    expect(registered).toContainEqual({
      modelId: DEV_PAIR.modelId,
      providerId: DEV_PAIR.providerId,
    });
    expect(registered.length).toBeGreaterThanOrEqual(3);
  });
});

describe("OpenRouterModelProvider — request shape (ITOTORI-220 pair pin)", () => {
  it("sends provider.only=[providerId] and allow_fallbacks=false in the request body", async () => {
    let observedBody:
      | {
          provider: { only: string[]; allow_fallbacks: boolean };
          model?: string;
        }
      | undefined;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      observedBody = JSON.parse(String(init?.body ?? "{}"));
      return successResponse({});
    }) as unknown as typeof fetch;
    const provider = new OpenRouterModelProvider({
      env: { OPENROUTER_API_KEY: "abc" },
      httpClient: fetchMock,
      capabilityGuard: new CapabilityGuard(),
    });
    await provider.invoke(baseRequest());
    expect(observedBody?.provider.only).toEqual([DEV_PAIR.providerId]);
    expect(observedBody?.provider.allow_fallbacks).toBe(false);
    expect(observedBody?.model).toBe(DEV_PAIR.modelId);
  });

  it("throws ModelProviderError code='pair_mismatch' when the upstream provider differs", async () => {
    const fetchMock = vi.fn(async () =>
      successResponse({ upstreamProvider: "deepinfra" }),
    ) as unknown as typeof fetch;
    const provider = new OpenRouterModelProvider({
      env: { OPENROUTER_API_KEY: "abc" },
      httpClient: fetchMock,
      capabilityGuard: new CapabilityGuard(),
    });
    const error = await provider.invoke(baseRequest()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelProviderError);
    if (error instanceof ModelProviderError) {
      expect(error.code).toBe("pair_mismatch");
      expect(error.message).toContain("deepinfra");
      expect(error.message).toContain(DEV_PAIR.providerId);
    }
  });

  it("sends Bearer auth header populated from the resolved env API key", async () => {
    let observedAuth: string | undefined;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      observedAuth = headers.get("authorization") ?? undefined;
      return successResponse({});
    }) as unknown as typeof fetch;
    const provider = new OpenRouterModelProvider({
      env: { OPENROUTER_API_KEY: "sk-or-1234" },
      httpClient: fetchMock,
      capabilityGuard: new CapabilityGuard(),
    });
    await provider.invoke(baseRequest());
    expect(observedAuth).toBe("Bearer sk-or-1234");
  });
});

describe("OpenRouterModelProvider — per-process cost cap", () => {
  it("raises OpenRouterCostCapError when cumulative spend exceeds the cap (third call blocked, no HTTP fired)", async () => {
    // Three calls each reporting $0.60 → after 2 the cumulative is
    // $1.20 which is already over the default $1 cap, so the third
    // invoke must throw BEFORE the HTTP request fires.
    const fetchMock = vi.fn(async () =>
      successResponse({ costUsd: 0.6 }),
    ) as unknown as typeof fetch;
    const provider = new OpenRouterModelProvider({
      env: { OPENROUTER_API_KEY: "abc" },
      httpClient: fetchMock,
      costCapUsd: 1.0,
      rateLimitPerSec: 1000, // effectively unlimited for this test
      capabilityGuard: new CapabilityGuard(),
    });
    await provider.invoke(baseRequest());
    await provider.invoke(baseRequest());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const error = await provider.invoke(baseRequest()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenRouterCostCapError);
    if (error instanceof OpenRouterCostCapError) {
      expect(error.remainingUsd).toBe(0);
      expect(error.capUsd).toBe(1.0);
      expect(error.spentUsd).toBeCloseTo(1.2, 5);
    }
    // Critical audit assertion: the third call's HTTP request never fired.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not refuse a call that exactly equals the cap (the next call after will)", async () => {
    const fetchMock = vi.fn(async () =>
      successResponse({ costUsd: 1.0 }),
    ) as unknown as typeof fetch;
    const provider = new OpenRouterModelProvider({
      env: { OPENROUTER_API_KEY: "abc" },
      httpClient: fetchMock,
      costCapUsd: 1.0,
      rateLimitPerSec: 1000,
      capabilityGuard: new CapabilityGuard(),
    });
    await provider.invoke(baseRequest());
    expect(provider.totalSpentUsd()).toBeCloseTo(1.0, 5);
    await expect(provider.invoke(baseRequest())).rejects.toBeInstanceOf(OpenRouterCostCapError);
  });
});

describe("OpenRouterModelProvider — token-bucket rate limit", () => {
  it("waits between back-to-back calls at 1 rps using injected clock + sleep", async () => {
    // Controllable clock: starts at t=0, only advances when sleep is called.
    let nowMs = 0;
    const sleepCalls: number[] = [];
    const sleep = async (ms: number) => {
      sleepCalls.push(ms);
      nowMs += ms;
    };
    const now = () => nowMs;
    const fetchMock = vi.fn(async () =>
      successResponse({ costUsd: 0.001 }),
    ) as unknown as typeof fetch;
    const provider = new OpenRouterModelProvider({
      env: { OPENROUTER_API_KEY: "abc" },
      httpClient: fetchMock,
      rateLimitPerSec: 1.0,
      now,
      sleep,
      capabilityGuard: new CapabilityGuard(),
    });
    await provider.invoke(baseRequest());
    await provider.invoke(baseRequest());
    await provider.invoke(baseRequest());
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // First call uses the initial token (no sleep). Second + third each
    // wait ~1000ms for a refill at 1 rps.
    expect(sleepCalls.length).toBe(2);
    for (const ms of sleepCalls) {
      expect(ms).toBeGreaterThanOrEqual(900);
      expect(ms).toBeLessThanOrEqual(1100);
    }
  });
});
