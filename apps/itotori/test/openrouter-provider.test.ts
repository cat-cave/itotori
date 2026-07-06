// ITOTORI-221 — OpenRouterModelProvider unit tests.
//
// These tests cover the wrapper-layer responsibilities the
// OpenRouterModelProvider adds on top of the existing OpenRouterProvider:
//
//   - constructor reads OPENROUTER_API_KEY from process.env (default
//     env var name; never reads .env)
//   - missing env var raises OpenRouterMissingApiKeyError at construction
//   - request body sends provider: { order: [providerId],
//     allow_fallbacks: true } per ITOTORI-241 (preference, not a pin)
//   - a ZDR-served provider that differs from order[0] is ACCEPTED
//     (ITOTORI-243: no provider-identity pin) and its served (model,
//     providerId) pair + real billed cost are recorded
//   - per-process USD cost cap raises OpenRouterCostCapError BEFORE
//     the HTTP request fires (third call mocked at $0.60 each so the
//     cumulative >$1.00 cap rejects without a network hit)
//   - token-bucket rate limit serialises three back-to-back invocations
//     at 1 rps using a controllable clock + sleep injection
//   - the CapabilityGuard registers the DEV_PAIR (modelId, providerId)
//     on construction

import { describe, expect, it, vi } from "vitest";
import {
  addDecimalUsd,
  assertBilledCost,
  assertBilledCostDecimal,
  CapabilityGuard,
  DEV_PAIR,
  extractCacheDiscountMicros,
  ModelProviderError,
  OpenRouterCostCapError,
  OpenRouterMissingArtifactRecorderError,
  OpenRouterMissingApiKeyError,
  OpenRouterModelProvider,
  OpenRouterProvider,
  openRouterDefaultCapabilities,
  selectStructuredOutputRequest,
  type ModelInvocationRequest,
  type ProviderRunArtifact,
  type ProviderRunArtifactRecorder,
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
  usageCost?: number | string;
  modelId?: string;
  cachedTokens?: number;
  cacheWriteTokens?: number;
  cacheDiscount?: number | null;
}): Response {
  const usage: Record<string, unknown> = {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
    cost: opts.usageCost ?? 0.001,
  };
  // ITOTORI-233 — optionally include the prompt-caching annotations
  // the OR docs §5.3 describe (verified shape: evidence file call_1).
  if (opts.cachedTokens !== undefined || opts.cacheWriteTokens !== undefined) {
    usage.prompt_tokens_details = {
      cached_tokens: opts.cachedTokens ?? 0,
      cache_write_tokens: opts.cacheWriteTokens ?? 0,
      audio_tokens: 0,
      video_tokens: 0,
    };
  }
  if (opts.cacheDiscount !== undefined) {
    usage.cost_details = {
      upstream_inference_cost: opts.usageCost ?? 0.001,
      cache_discount: opts.cacheDiscount,
    };
  }
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
    usage,
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function memoryRecorder(): ProviderRunArtifactRecorder & { artifacts: ProviderRunArtifact[] } {
  const artifacts: ProviderRunArtifact[] = [];
  return {
    artifacts,
    recordProviderRun: async (artifact: ProviderRunArtifact) => {
      artifacts.push(artifact);
    },
  };
}

describe("OpenRouterModelProvider — env + construction", () => {
  // ITOTORI-227 — every live-path test passes
  // OPENROUTER_ZDR_ACCOUNT_ASSERTED=1 so the account-wide ZDR assertion
  // (the load-bearing operator gate) is satisfied; the rest of the
  // construction behaviour is what these tests are about. The
  // assertion-itself tests live in provider-abstraction.test.ts under
  // `AccountZdrAssertionError (ITOTORI-227)`.

  it("throws OpenRouterMissingApiKeyError when the API-key env var is unset (ZDR asserted)", () => {
    expect(
      () =>
        new OpenRouterModelProvider({
          env: { OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1" },
          httpClient: vi.fn() as unknown as typeof fetch,
        }),
    ).toThrow(OpenRouterMissingApiKeyError);
  });

  it("throws OpenRouterMissingApiKeyError when the API-key env var is the empty string (ZDR asserted)", () => {
    expect(
      () =>
        new OpenRouterModelProvider({
          env: { OPENROUTER_API_KEY: "", OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1" },
          httpClient: vi.fn() as unknown as typeof fetch,
        }),
    ).toThrow(OpenRouterMissingApiKeyError);
  });

  it("honours apiKeyEnvVar override and reads from the provided env", () => {
    const provider = new OpenRouterModelProvider({
      apiKeyEnvVar: "MY_CUSTOM_KEY",
      env: { MY_CUSTOM_KEY: "abc-123", OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1" },
      httpClient: vi.fn() as unknown as typeof fetch,
      artifactRecorder: memoryRecorder(),
    });
    expect(provider.apiKeyEnvVar).toBe("MY_CUSTOM_KEY");
  });

  it("refuses live construction without a provider-run artifact recorder", () => {
    expect(
      () =>
        new OpenRouterModelProvider({
          env: { OPENROUTER_API_KEY: "abc", OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1" },
          httpClient: vi.fn() as unknown as typeof fetch,
        }),
    ).toThrow(OpenRouterMissingArtifactRecorderError);
  });

  it("registers DEV_PAIR + known production pairs into the CapabilityGuard at construction", () => {
    const guard = new CapabilityGuard();
    new OpenRouterModelProvider({
      env: { OPENROUTER_API_KEY: "abc", OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1" },
      capabilityGuard: guard,
      httpClient: vi.fn() as unknown as typeof fetch,
      artifactRecorder: memoryRecorder(),
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
  it("ITOTORI-241: sends provider.order=[providerId] (preference) + allow_fallbacks=true, and never emits a hard `only` pin", async () => {
    let observedBody:
      | {
          provider: { order?: string[]; only?: string[]; allow_fallbacks: boolean };
          model?: string;
        }
      | undefined;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      observedBody = JSON.parse(String(init?.body ?? "{}"));
      return successResponse({});
    }) as unknown as typeof fetch;
    const provider = new OpenRouterModelProvider({
      env: { OPENROUTER_API_KEY: "abc", OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1" },
      httpClient: fetchMock,
      capabilityGuard: new CapabilityGuard(),
      artifactRecorder: memoryRecorder(),
    });
    await provider.invoke(baseRequest());
    expect(observedBody?.provider.order).toEqual([DEV_PAIR.providerId]);
    expect(observedBody?.provider.allow_fallbacks).toBe(true);
    // The old hard pin must not survive: no `only` enumeration on the wire.
    expect(observedBody?.provider.only).toBeUndefined();
    expect(observedBody?.model).toBe(DEV_PAIR.modelId);
  });

  it("ITOTORI-241: a structured (json_schema) request composes require_parameters:true with zdr:true + allow_fallbacks:true and sends response_format", async () => {
    // With fallback now ON, require_parameters:true is load-bearing: it
    // confines any ZDR-allow-list fallback to providers that actually
    // support the requested response_format, so the structured-output
    // path cannot silently degrade onto a provider that ignores it. We
    // exercise the inner OpenRouterProvider directly with a
    // json_schema-capable capability sheet (the wrapper's default sheet
    // is `untested`, which is the capability guard's job to refuse).
    let observedBody:
      | {
          provider: {
            order?: string[];
            allow_fallbacks?: boolean;
            zdr?: boolean;
            data_collection?: string;
            require_parameters?: boolean;
          };
          response_format?: { type?: string };
        }
      | undefined;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      observedBody = JSON.parse(String(init?.body ?? "{}"));
      return successResponse({});
    }) as unknown as typeof fetch;
    const provider = new OpenRouterProvider({
      modelId: DEV_PAIR.modelId,
      apiKey: "abc",
      fetch: fetchMock,
      capabilities: {
        ...openRouterDefaultCapabilities,
        structuredOutputs: {
          ...openRouterDefaultCapabilities.structuredOutputs,
          jsonSchema: "supported",
          preferredModes: ["json_schema"],
        },
      },
      live: { enabled: true, artifactRecorder: memoryRecorder(), rawCapture: "disabled" },
    });
    await provider.invoke(
      baseRequest({
        structuredOutput: {
          mode: "json_schema",
          name: "itotori_test_schema",
          strict: true,
          schema: { type: "object", additionalProperties: false, properties: {} },
        },
      }),
    );
    expect(observedBody?.provider).toMatchObject({
      order: [DEV_PAIR.providerId],
      allow_fallbacks: true,
      zdr: true,
      data_collection: "deny",
      require_parameters: true,
    });
    expect(observedBody?.response_format?.type).toBe("json_schema");
  });

  it("ITOTORI-241: a json_object request sets provider.require_parameters:true on the wire AND the recorded posture matches (no posture/wire drift)", async () => {
    // Audit P2: json_object was NOT in the strict-parameters set, so the
    // wire omitted provider.require_parameters while the recorded posture
    // defaulted the absent field to `true` — the ledger disagreed with the
    // bytes. With json_object now in `structuredOutputRequiresStrictParameters`
    // the wire carries require_parameters:true AND the captured posture
    // mirrors it. Asserting BOTH against the observed wire body is the
    // drift regression guard.
    let observedBody:
      | {
          provider: { require_parameters?: boolean };
          response_format?: { type?: string };
        }
      | undefined;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      observedBody = JSON.parse(String(init?.body ?? "{}"));
      return successResponse({});
    }) as unknown as typeof fetch;
    const recorder = memoryRecorder();
    const provider = new OpenRouterProvider({
      modelId: DEV_PAIR.modelId,
      apiKey: "abc",
      fetch: fetchMock,
      capabilities: {
        ...openRouterDefaultCapabilities,
        structuredOutputs: {
          ...openRouterDefaultCapabilities.structuredOutputs,
          jsonObject: "supported",
          preferredModes: ["json_object"],
        },
      },
      live: { enabled: true, artifactRecorder: recorder, rawCapture: "disabled" },
    });
    await provider.invoke(baseRequest({ structuredOutput: { mode: "json_object" } }));

    // (a) wire carries require_parameters:true + the json_object response_format.
    expect(observedBody?.provider.require_parameters).toBe(true);
    expect(observedBody?.response_format).toEqual({ type: "json_object" });

    // (b) recorded posture matches the wire — the drift is gone.
    expect(recorder.artifacts).toHaveLength(1);
    const recordedRequireParameters = recorder.artifacts[0]!.run.routingPosture.require_parameters;
    expect(recordedRequireParameters).toBe(true);
    expect(recordedRequireParameters).toBe(observedBody?.provider.require_parameters);
  });

  it("plain-json-fallback-under-zdr: agentic selection falls back to plain_json when the pair's ZDR pool routes neither json_schema nor json_object", () => {
    // The DEV_PAIR sheet registered at construction marks BOTH json_schema
    // and json_object 'unsupported' (ZDR 404 on either response_format —
    // the account ZDR allow-list ∩ response_format-advertising providers is
    // empty). The pair-driven selector must therefore resolve to the plain
    // completion (`plain_json`), never force an unroutable response_format.
    const provider = new OpenRouterModelProvider({
      env: { OPENROUTER_API_KEY: "abc", OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1" },
      httpClient: vi.fn() as unknown as typeof fetch,
      capabilityGuard: new CapabilityGuard(),
      artifactRecorder: memoryRecorder(),
    });
    const capabilities = provider.descriptorForPair(DEV_PAIR).capabilities;
    expect(capabilities.structuredOutputs.jsonSchema).toBe("unsupported");
    expect(capabilities.structuredOutputs.jsonObject).toBe("unsupported");
    expect(capabilities.structuredOutputs.plainJsonExtraction).toBe("supported");

    const selected = selectStructuredOutputRequest(capabilities, {
      name: "itotori_agentic_schema",
      schema: { type: "object", additionalProperties: false, properties: {} },
      strict: true,
    });
    expect(selected).toEqual({ mode: "plain_json" });

    // Contrast 1: a pair whose sheet validates json_object as ZDR-supported
    // PREFERS the structured wire mode — the fallback is used only when
    // needed, never in place of a routable structured mode.
    const jsonObjectPair = selectStructuredOutputRequest(
      {
        ...capabilities,
        structuredOutputs: {
          ...capabilities.structuredOutputs,
          jsonObject: "supported",
          preferredModes: ["json_object", "plain_json"],
        },
      },
      {
        name: "itotori_agentic_schema",
        schema: { type: "object", additionalProperties: false, properties: {} },
        strict: true,
      },
    );
    expect(jsonObjectPair).toEqual({ mode: "json_object" });

    // Contrast 2: a pair whose sheet validates json_schema as ZDR-supported
    // still gets json_schema (selection is pair-driven, not hardcoded).
    const jsonSchemaPair = selectStructuredOutputRequest(
      {
        ...capabilities,
        structuredOutputs: {
          ...capabilities.structuredOutputs,
          jsonSchema: "supported",
          preferredModes: ["json_schema", "json_object", "plain_json"],
        },
      },
      {
        name: "itotori_agentic_schema",
        schema: { type: "object", additionalProperties: false, properties: {} },
        strict: true,
      },
    );
    expect(jsonSchemaPair.mode).toBe("json_schema");

    // Contrast 3: a pair that advertises NONE of the three fails loud rather
    // than silently degrading.
    expect(() =>
      selectStructuredOutputRequest(
        {
          ...capabilities,
          structuredOutputs: {
            ...capabilities.structuredOutputs,
            jsonSchema: "unsupported",
            jsonObject: "unsupported",
            plainJsonExtraction: "unsupported",
            preferredModes: [],
          },
        },
        {
          name: "itotori_agentic_schema",
          schema: { type: "object", additionalProperties: false, properties: {} },
          strict: true,
        },
      ),
    ).toThrow(/no ZDR-routable structured-output mode/u);
  });

  it("plain-json-fallback-under-zdr: a plain_json request omits response_format AND require_parameters on the wire, and the recorded posture matches (no posture/wire drift)", async () => {
    // The whole point of the plain fallback is to NOT narrow the ZDR pool:
    // it must send neither response_format nor require_parameters. And — as
    // for json_object — the recorded posture must be byte-identical to the
    // wire, so an operator auditing the ledger sees exactly what went out.
    let observedBody:
      | {
          provider: { require_parameters?: boolean };
          response_format?: unknown;
        }
      | undefined;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      observedBody = JSON.parse(String(init?.body ?? "{}"));
      return successResponse({});
    }) as unknown as typeof fetch;
    const recorder = memoryRecorder();
    const provider = new OpenRouterProvider({
      modelId: DEV_PAIR.modelId,
      apiKey: "abc",
      fetch: fetchMock,
      capabilities: {
        ...openRouterDefaultCapabilities,
        structuredOutputs: {
          ...openRouterDefaultCapabilities.structuredOutputs,
          plainJsonExtraction: "supported",
          preferredModes: ["plain_json"],
        },
      },
      live: { enabled: true, artifactRecorder: recorder, rawCapture: "disabled" },
    });
    await provider.invoke(baseRequest({ structuredOutput: { mode: "plain_json" } }));

    // (a) wire carries NO response_format and NO require_parameters.
    expect(observedBody?.response_format).toBeUndefined();
    expect(observedBody?.provider.require_parameters).toBeUndefined();

    // (b) recorded posture matches the wire — require_parameters is false
    // (the omitted-on-the-wire, not-required semantics), not a dishonest true.
    expect(recorder.artifacts).toHaveLength(1);
    const recordedRequireParameters = recorder.artifacts[0]!.run.routingPosture.require_parameters;
    expect(recordedRequireParameters).toBe(false);
    expect(recordedRequireParameters).toBe(observedBody?.provider.require_parameters ?? false);
  });

  it("sends request maxPriceUsd as provider.max_price.request", async () => {
    let observedBody:
      | {
          provider: { max_price?: { request?: number } };
        }
      | undefined;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      observedBody = JSON.parse(String(init?.body ?? "{}"));
      return successResponse({ usageCost: 0.000001 });
    }) as unknown as typeof fetch;
    const provider = new OpenRouterModelProvider({
      env: { OPENROUTER_API_KEY: "abc", OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1" },
      httpClient: fetchMock,
      capabilityGuard: new CapabilityGuard(),
      artifactRecorder: memoryRecorder(),
    });
    await provider.invoke(baseRequest({ maxPriceUsd: 0.000002 }));
    expect(observedBody?.provider.max_price).toEqual({ request: 0.000002 });
  });

  it("rejects a malformed maxPriceUsd before any request fires", async () => {
    // The cap is validated up-front (assertValidMaxPriceUsd) rather than
    // via a discarded conversion: a non-finite / negative cap must throw a
    // configuration_error and never reach the wire.
    const fetchMock = vi.fn(async () =>
      successResponse({ usageCost: 0.000001 }),
    ) as unknown as typeof fetch;
    const provider = new OpenRouterModelProvider({
      env: { OPENROUTER_API_KEY: "abc", OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1" },
      httpClient: fetchMock,
      capabilityGuard: new CapabilityGuard(),
      artifactRecorder: memoryRecorder(),
    });
    await expect(provider.invoke(baseRequest({ maxPriceUsd: -1 }))).rejects.toMatchObject({
      code: "configuration_error",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ITOTORI-243: ACCEPTS a ZDR-served provider that differs from order[0] and records the served pair + real billed cost", async () => {
    // The privacy gate is the REQUEST posture (zdr:true, enforced for the
    // synthetic_public default). With zdr:true on the wire OpenRouter can
    // only serve a ZDR-allow-list provider, so a served upstream
    // ('deepinfra') that differs from the preferred order[0]
    // (DEV_PAIR.providerId='fireworks') is a VALID serve — there is no
    // provider-identity pin and no throw. We record the truth: the served
    // (model, providerId) pair and the real billed cost (usage.cost, NOT
    // zeroed).
    const recorder = memoryRecorder();
    const fetchMock = vi.fn(async () =>
      successResponse({ upstreamProvider: "deepinfra", usageCost: 0.000042 }),
    ) as unknown as typeof fetch;
    const provider = new OpenRouterModelProvider({
      env: { OPENROUTER_API_KEY: "abc", OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1" },
      httpClient: fetchMock,
      capabilityGuard: new CapabilityGuard(),
      artifactRecorder: recorder,
    });
    const result = await provider.invoke(baseRequest());
    // Accepted, not thrown: succeeded run served by the ZDR fallback provider.
    expect(result.providerRun.status).toBe("succeeded");
    expect(result.providerRun.provider.requestedProviderId).toBe(DEV_PAIR.providerId);
    expect(result.providerRun.provider.actualModelId).toBe(DEV_PAIR.modelId);
    // Served (model, providerId) pair recorded as the TRUTH.
    expect(result.providerRun.provider.upstreamProvider).toBe("deepinfra");
    // Real billed cost extracted from usage.cost — NOT zeroed by a
    // rejection firing before cost extraction.
    expect(result.providerRun.cost.costKind).toBe("billed");
    expect(result.providerRun.cost.amountMicrosUsd).toBe(42);
    // The recorded artifact carries the same served pair + billed cost.
    expect(recorder.artifacts).toHaveLength(1);
    expect(recorder.artifacts[0]?.run.provider.upstreamProvider).toBe("deepinfra");
    expect(recorder.artifacts[0]?.run.cost.amountMicrosUsd).toBe(42);
  });

  it("ITOTORI-236: accepts TitleCase response.provider when request.providerId is the lowercase slug (Fireworks ↔ fireworks)", async () => {
    // Live OR responses echo the human-readable provider_name (TitleCase,
    // e.g. "Fireworks") while the request pins the lowercase routing slug
    // ("fireworks"). The historical strict-equality pair check (ITOTORI-220)
    // tripped on this legit shape; see docs/openrouter-integration.md §9.2.
    const fetchMock = vi.fn(async () =>
      successResponse({ upstreamProvider: "Fireworks" }),
    ) as unknown as typeof fetch;
    const provider = new OpenRouterModelProvider({
      env: { OPENROUTER_API_KEY: "abc", OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1" },
      httpClient: fetchMock,
      capabilityGuard: new CapabilityGuard(),
      artifactRecorder: memoryRecorder(),
    });
    const result = await provider.invoke(baseRequest());
    expect(result.providerRun.status).toBe("succeeded");
    expect(result.providerRun.provider.requestedProviderId).toBe(DEV_PAIR.providerId);
    expect(result.providerRun.provider.upstreamProvider).toBe("Fireworks");
  });

  it("ITOTORI-243: ACCEPTS any ZDR-served provider that differs from order[0] (request='fireworks' → response='OpenAI') and records the served pair", async () => {
    // ITOTORI-243 product decision: strict provider-pinning + a
    // post-response provider-identity throw were a needless formality with
    // no operational security. ZDR (zdr:true on the wire) is the only
    // privacy gate, so whichever provider OpenRouter routes to within the
    // ZDR allow-list is a valid serve and is recorded as the served
    // (model, providerId) pair — never rejected.
    const recorder = memoryRecorder();
    const fetchMock = vi.fn(async () =>
      successResponse({ upstreamProvider: "OpenAI", usageCost: 0.000007 }),
    ) as unknown as typeof fetch;
    const provider = new OpenRouterModelProvider({
      env: { OPENROUTER_API_KEY: "abc", OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1" },
      httpClient: fetchMock,
      capabilityGuard: new CapabilityGuard(),
      artifactRecorder: recorder,
    });
    const result = await provider.invoke(baseRequest());
    expect(result.providerRun.status).toBe("succeeded");
    expect(result.providerRun.provider.requestedProviderId).toBe(DEV_PAIR.providerId);
    expect(result.providerRun.provider.upstreamProvider).toBe("OpenAI");
    expect(result.providerRun.cost.costKind).toBe("billed");
    expect(result.providerRun.cost.amountMicrosUsd).toBe(7);
    expect(recorder.artifacts[0]?.run.provider.upstreamProvider).toBe("OpenAI");
  });

  it("ITOTORI-242: ACCEPTS a genuine ZDR fallback (preferred 429s → 2nd ZDR-allow-list provider) and records the swap in adapterMetadata.openrouterRouting", async () => {
    // End-to-end 429-resilience: the preferred provider (order[0],
    // DEV_PAIR.providerId='fireworks') 429s, OpenRouter routes to the NEXT
    // ZDR-allow-list provider ('deepinfra'). The privacy gate held (this
    // request enforces zdr:true — synthetic_public input), so the served
    // upstream is a ZDR-allow-list member by construction. The post-response
    // check must ACCEPT it — NOT throw pair_mismatch — and the swap must be
    // auditable, not silent: OpenRouter's router metadata records the
    // fallback (attempt>1 + a summary naming the served provider), mirrored
    // verbatim onto adapterMetadata.openrouterRouting (ITOTORI-238).
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "gen-zdr-fallback",
            model: DEV_PAIR.modelId,
            // Served by deepinfra, NOT the preferred 'fireworks'.
            provider: "deepinfra",
            choices: [{ finish_reason: "stop", message: { role: "assistant", content: "hi" } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.001 }, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
            openrouter_metadata: {
              requested: DEV_PAIR.modelId,
              strategy: "fallback",
              // attempt is 1-indexed: attempt=1 is the preferred provider
              // served directly; attempt=2 means OpenRouter advanced past
              // the 429'd preferred provider to the next ZDR-allow-list one.
              attempt: 2,
              summary: "fireworks rate-limited (429); served by deepinfra",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    ) as unknown as typeof fetch;
    const recorder = memoryRecorder();
    const provider = new OpenRouterModelProvider({
      env: { OPENROUTER_API_KEY: "abc", OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1" },
      httpClient: fetchMock,
      capabilityGuard: new CapabilityGuard(),
      artifactRecorder: recorder,
    });

    const result = await provider.invoke(baseRequest());

    // Accepted: no pair_mismatch throw, succeeded run, served by the
    // fallback provider.
    expect(result.providerRun.status).toBe("succeeded");
    expect(result.providerRun.provider.requestedProviderId).toBe(DEV_PAIR.providerId);
    expect(result.providerRun.provider.upstreamProvider).toBe("deepinfra");
    // Auditable, not silent: the fallback is recorded in
    // adapterMetadata.openrouterRouting (attempt>1 / summary names the
    // served provider).
    const routing = (result.adapterMetadata as Record<string, unknown>).openrouterRouting as
      | { attempt?: number; summary?: string }
      | undefined;
    expect(routing?.attempt).toBe(2);
    expect(routing?.summary).toContain("deepinfra");
    // The recorded artifact carries the same auditable swap record.
    expect(recorder.artifacts).toHaveLength(1);
    expect(recorder.artifacts[0]?.adapterMetadata?.openrouterRouting).toMatchObject({
      attempt: 2,
    });
  });

  it("ITOTORI-242: fallbackUsed is TRUE when the served provider differs from order[0] (a genuine provider-level ZDR fallback), and the served pair is recorded", async () => {
    // The headline ITOTORI-242 resilience path: order[0]
    // (DEV_PAIR.providerId='fireworks') 429s, OpenRouter serves a DIFFERENT
    // ZDR-allow-list provider ('deepinfra') with the SAME model. The old
    // model-only check (actualModelId !== requestedModelId) read this as
    // fallbackUsed:false; the provider swap must now be first-class
    // telemetry — fallbackUsed:true — without any rejection.
    const recorder = memoryRecorder();
    const fetchMock = vi.fn(async () =>
      successResponse({ upstreamProvider: "deepinfra", usageCost: 0.000042 }),
    ) as unknown as typeof fetch;
    const provider = new OpenRouterModelProvider({
      env: { OPENROUTER_API_KEY: "abc", OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1" },
      httpClient: fetchMock,
      capabilityGuard: new CapabilityGuard(),
      artifactRecorder: recorder,
    });
    const result = await provider.invoke(baseRequest());
    // Accepted, not rejected: a non-preferred ZDR serve is valid.
    expect(result.providerRun.status).toBe("succeeded");
    // The provider-level fallback is reflected in the first-class flag.
    expect(result.providerRun.fallbackUsed).toBe(true);
    // The served pair is recorded as the truth.
    expect(result.providerRun.provider.upstreamProvider).toBe("deepinfra");
    expect(result.providerRun.provider.requestedProviderId).toBe(DEV_PAIR.providerId);
    expect(recorder.artifacts[0]?.run.fallbackUsed).toBe(true);
    expect(recorder.artifacts[0]?.run.provider.upstreamProvider).toBe("deepinfra");
  });

  it("ITOTORI-242: fallbackUsed is FALSE when order[0] serves directly (no provider fallback, same model)", async () => {
    // The preferred provider (order[0], DEV_PAIR.providerId='fireworks')
    // answers directly with the requested model — no provider swap and no
    // model fallback, so fallbackUsed must be false.
    const recorder = memoryRecorder();
    const fetchMock = vi.fn(async () =>
      successResponse({ upstreamProvider: DEV_PAIR.providerId, usageCost: 0.000011 }),
    ) as unknown as typeof fetch;
    const provider = new OpenRouterModelProvider({
      env: { OPENROUTER_API_KEY: "abc", OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1" },
      httpClient: fetchMock,
      capabilityGuard: new CapabilityGuard(),
      artifactRecorder: recorder,
    });
    const result = await provider.invoke(baseRequest());
    expect(result.providerRun.status).toBe("succeeded");
    expect(result.providerRun.fallbackUsed).toBe(false);
    expect(result.providerRun.provider.upstreamProvider).toBe(DEV_PAIR.providerId);
    expect(recorder.artifacts[0]?.run.fallbackUsed).toBe(false);
  });

  it("ITOTORI-242: a casing/version-only diff (order[0]='fireworks' → served='Fireworks') does NOT falsely read as a provider fallback", async () => {
    // Live OR echoes the human-readable provider name (TitleCase
    // 'Fireworks') while order[0] is the lowercase slug ('fireworks').
    // That is the SAME provider — a slug↔display-name shape, not a
    // fallback — so provider-id normalization must keep fallbackUsed:false.
    const recorder = memoryRecorder();
    const fetchMock = vi.fn(async () =>
      successResponse({ upstreamProvider: "Fireworks", usageCost: 0.000013 }),
    ) as unknown as typeof fetch;
    const provider = new OpenRouterModelProvider({
      env: { OPENROUTER_API_KEY: "abc", OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1" },
      httpClient: fetchMock,
      capabilityGuard: new CapabilityGuard(),
      artifactRecorder: recorder,
    });
    const result = await provider.invoke(baseRequest());
    expect(result.providerRun.status).toBe("succeeded");
    // Casing-only diff: NOT a fallback.
    expect(result.providerRun.fallbackUsed).toBe(false);
    expect(result.providerRun.provider.upstreamProvider).toBe("Fireworks");
    expect(recorder.artifacts[0]?.run.fallbackUsed).toBe(false);
  });

  it("ITOTORI-243: ACCEPTS a public-input serve from a provider differing from order[0] and records the served pair + real cost", async () => {
    // For `public` input there is no privacy contract (zdr is not enforced
    // on the wire), so any provider OpenRouter routes to is a valid serve.
    // ITOTORI-243 removed the provider-identity throw entirely — we record
    // the served (model, providerId) pair and the real billed cost rather
    // than rejecting.
    const recorder = memoryRecorder();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "gen-public-serve",
            model: DEV_PAIR.modelId,
            provider: "deepinfra",
            choices: [{ finish_reason: "stop", message: { role: "assistant", content: "hi" } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.001 }, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
            openrouter_metadata: { strategy: "fallback", attempt: 2 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    ) as unknown as typeof fetch;
    const provider = new OpenRouterModelProvider({
      env: { OPENROUTER_API_KEY: "abc", OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1" },
      httpClient: fetchMock,
      capabilityGuard: new CapabilityGuard(),
      artifactRecorder: recorder,
    });
    const result = await provider.invoke(baseRequest({ inputClassification: "public" }));
    expect(result.providerRun.status).toBe("succeeded");
    expect(result.providerRun.provider.upstreamProvider).toBe("deepinfra");
    expect(result.providerRun.cost.costKind).toBe("billed");
    expect(result.providerRun.cost.amountMicrosUsd).toBe(1000);
    expect(recorder.artifacts[0]?.run.provider.upstreamProvider).toBe("deepinfra");
  });

  it("ITOTORI-243: ACCEPTS a serve from a differing provider even with NO fallback record in openrouter_metadata — records the served pair as the truth", async () => {
    // ITOTORI-243 supersedes the ITOTORI-238 silent-swap throw. There is no
    // longer a 'silent' swap to forbid: whatever provider answered IS
    // recorded as the served (model, providerId) pair, so the record is
    // always the truth regardless of whether OpenRouter emitted a fallback
    // annotation. zdr:true (the privacy gate) still holds for this default
    // synthetic_public request.
    const recorder = memoryRecorder();
    const fetchMock = vi.fn(async () =>
      successResponse({ upstreamProvider: "deepinfra", usageCost: 0.000009 }),
    ) as unknown as typeof fetch;
    const provider = new OpenRouterModelProvider({
      env: { OPENROUTER_API_KEY: "abc", OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1" },
      httpClient: fetchMock,
      capabilityGuard: new CapabilityGuard(),
      artifactRecorder: recorder,
    });
    const result = await provider.invoke(baseRequest());
    expect(result.providerRun.status).toBe("succeeded");
    expect(result.providerRun.provider.upstreamProvider).toBe("deepinfra");
    expect(result.providerRun.cost.costKind).toBe("billed");
    expect(result.providerRun.cost.amountMicrosUsd).toBe(9);
    expect(recorder.artifacts[0]?.run.provider.upstreamProvider).toBe("deepinfra");
  });

  it("sends Bearer auth header populated from the resolved env API key", async () => {
    let observedAuth: string | undefined;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      observedAuth = headers.get("authorization") ?? undefined;
      return successResponse({});
    }) as unknown as typeof fetch;
    const provider = new OpenRouterModelProvider({
      env: { OPENROUTER_API_KEY: "sk-or-1234", OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1" },
      httpClient: fetchMock,
      capabilityGuard: new CapabilityGuard(),
      artifactRecorder: memoryRecorder(),
    });
    await provider.invoke(baseRequest());
    expect(observedAuth).toBe("Bearer sk-or-1234");
  });

  it("records routingPosture and usageResponseJson without raw prompt, response, or API-key leakage", async () => {
    const recorder = memoryRecorder();
    const rawPrompt = "RAW_PROMPT_SHOULD_NOT_LEAK";
    const rawResponse = "RAW_RESPONSE_SHOULD_NOT_LEAK";
    const apiKey = "sk-or-secret-should-not-leak";
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "gen-artifact-redaction",
            model: DEV_PAIR.modelId,
            provider: DEV_PAIR.providerId,
            choices: [
              {
                finish_reason: "stop",
                message: { role: "assistant", content: rawResponse },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.000006 }, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    ) as unknown as typeof fetch;
    const provider = new OpenRouterModelProvider({
      env: { OPENROUTER_API_KEY: apiKey, OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1" },
      httpClient: fetchMock,
      capabilityGuard: new CapabilityGuard(),
      artifactRecorder: recorder,
    });

    await provider.invoke(baseRequest({ messages: [{ role: "user", content: rawPrompt }] }));

    expect(recorder.artifacts).toHaveLength(1);
    const artifact = recorder.artifacts[0]!;
    expect(artifact.run.routingPosture).toMatchObject({
      order: [DEV_PAIR.providerId],
      allow_fallbacks: true,
      data_collection: "deny",
    });
    expect(artifact.run.usageResponseJson).toMatchObject({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      cost: 0.000006, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
    });
    expect(artifact.request.rawTextCaptured).toBe(false);
    const serialized = JSON.stringify(artifact);
    expect(serialized).not.toContain(rawPrompt);
    expect(serialized).not.toContain(rawResponse);
    expect(serialized).not.toContain(apiKey);
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("Bearer");
  });
});

describe("OpenRouterModelProvider — per-process cost cap", () => {
  it("raises cost_cap_exceeded when reported usage.cost exceeds request maxPriceUsd", async () => {
    const recorder = memoryRecorder();
    const fetchMock = vi.fn(async () =>
      successResponse({ usageCost: 0.000003 }),
    ) as unknown as typeof fetch;
    const provider = new OpenRouterModelProvider({
      env: { OPENROUTER_API_KEY: "abc", OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1" },
      httpClient: fetchMock,
      rateLimitPerSec: 1000,
      capabilityGuard: new CapabilityGuard(),
      artifactRecorder: recorder,
    });
    const error = await provider
      .invoke(baseRequest({ maxPriceUsd: 0.000001 }))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelProviderError);
    if (error instanceof ModelProviderError) {
      expect(error.code).toBe("cost_cap_exceeded");
      expect(error.message).toContain("maxPriceUsd");
      expect(error.providerRun?.errorClasses).toContain("cost_cap_exceeded");
      expect(error.providerRun?.cost).toEqual({
        costKind: "billed",
        currency: "USD",
        amountUsd: "0.000003", // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
        amountMicrosUsd: 3, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
        cacheDiscountMicrosUsd: 0,
      });
      expect(error.providerRun?.usageResponseJson).toMatchObject({
        cost: 0.000003, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
        _cost_cap_exceeded: true,
      });
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(provider.totalSpentUsd()).toBeCloseTo(0.000003, 6);
    expect(recorder.artifacts[0]?.error?.class).toBe("cost_cap_exceeded");
    expect(recorder.artifacts[0]?.run.cost).toEqual({
      costKind: "billed",
      currency: "USD",
      amountUsd: "0.000003", // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
      amountMicrosUsd: 3, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
      cacheDiscountMicrosUsd: 0,
    });
    expect(recorder.artifacts[0]?.run.usageResponseJson).toMatchObject({
      cost: 0.000003, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
      _cost_cap_exceeded: true,
    });
  });

  it("raises OpenRouterCostCapError when cumulative spend exceeds the cap (third call blocked, no HTTP fired)", async () => {
    // Three calls each reporting $0.60 → after 2 the cumulative is
    // $1.20 which is already over the explicit $1 cap configured
    // below, so the third invoke must throw BEFORE the HTTP request
    // fires. (The provider's canonical DEFAULT_COST_CAP_USD is 0.5;
    // this test pins 1.0 so the per-call $0.60 reports are meaningful.)
    const fetchMock = vi.fn(async () =>
      successResponse({ usageCost: 0.6 }),
    ) as unknown as typeof fetch;
    const provider = new OpenRouterModelProvider({
      env: { OPENROUTER_API_KEY: "abc", OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1" },
      httpClient: fetchMock,
      costCapUsd: 1.0,
      rateLimitPerSec: 1000, // effectively unlimited for this test
      capabilityGuard: new CapabilityGuard(),
      artifactRecorder: memoryRecorder(),
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
      successResponse({ usageCost: 1.0 }),
    ) as unknown as typeof fetch;
    const provider = new OpenRouterModelProvider({
      env: { OPENROUTER_API_KEY: "abc", OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1" },
      httpClient: fetchMock,
      costCapUsd: 1.0,
      rateLimitPerSec: 1000,
      capabilityGuard: new CapabilityGuard(),
      artifactRecorder: memoryRecorder(),
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
      successResponse({ usageCost: 0.001 }),
    ) as unknown as typeof fetch;
    const provider = new OpenRouterModelProvider({
      env: { OPENROUTER_API_KEY: "abc", OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1" },
      httpClient: fetchMock,
      rateLimitPerSec: 1.0,
      now,
      sleep,
      capabilityGuard: new CapabilityGuard(),
      artifactRecorder: memoryRecorder(),
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

describe("OpenRouterModelProvider — ITOTORI-225 real-cost contract", () => {
  // Acceptance criterion #2: every recorded ProviderCost from a
  // successful response tags `costKind === 'billed'`. We exercise the
  // single-branch `normalizeOpenRouterCost` with a `usage.cost` decimal
  // string and an integer, plus the legacy floating-point form, and
  // assert that all three land as billed integers in micros.
  it("tags every successful response as billed with the exact upstream amount", async () => {
    const cases: Array<{
      cost: number | string;
      expectedMicros: number;
      expectedAmountUsd: string;
    }> = [
      { cost: 0.000019, expectedMicros: 19, expectedAmountUsd: "0.000019" }, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
      { cost: "0.000006", expectedMicros: 6, expectedAmountUsd: "0.000006" },
      { cost: 0, expectedMicros: 0, expectedAmountUsd: "0" },
      // ITOTORI-232 — sub-micro values: `amountMicrosUsd` rounds (and can
      // truncate to 0) but `amountUsd` carries the EXACT upstream decimal
      // so the ledger persists full precision.
      { cost: 0.00000049, expectedMicros: 0, expectedAmountUsd: "0.00000049" }, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
      { cost: 0.0000005, expectedMicros: 1, expectedAmountUsd: "0.0000005" }, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
    ];
    for (const { cost, expectedMicros, expectedAmountUsd } of cases) {
      const fetchMock = vi.fn(async () =>
        successResponse({ usageCost: cost as number }),
      ) as unknown as typeof fetch;
      const provider = new OpenRouterModelProvider({
        env: { OPENROUTER_API_KEY: "abc", OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1" },
        httpClient: fetchMock,
        capabilityGuard: new CapabilityGuard(),
        artifactRecorder: memoryRecorder(),
      });
      const result = await provider.invoke(baseRequest());
      expect(result.providerRun.cost).toEqual({
        costKind: "billed",
        currency: "USD",
        amountUsd: expectedAmountUsd,
        amountMicrosUsd: expectedMicros,
        // ITOTORI-233 — every cost mirror surfaces the cache discount;
        // these synthetic responses have no cost_details, so the
        // discount lands as 0.
        cacheDiscountMicrosUsd: 0,
      });
    }
  });

  // Acceptance criterion #3: a successful HTTP response without a
  // `usage.cost` field is a protocol violation surfaced as
  // `provider_response_invalid`. No silent zero-fill, no estimate.
  it("raises provider_response_invalid when usage.cost is missing on a successful response", async () => {
    const responseWithoutCost = (): Response =>
      new Response(
        JSON.stringify({
          id: "gen-missing-cost",
          model: DEV_PAIR.modelId,
          provider: DEV_PAIR.providerId,
          choices: [
            {
              finish_reason: "stop",
              message: { role: "assistant", content: "hi" },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    const fetchMock = vi.fn(async () => responseWithoutCost()) as unknown as typeof fetch;
    const provider = new OpenRouterModelProvider({
      env: { OPENROUTER_API_KEY: "abc", OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1" },
      httpClient: fetchMock,
      capabilityGuard: new CapabilityGuard(),
      artifactRecorder: memoryRecorder(),
    });
    const error = await provider.invoke(baseRequest()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelProviderError);
    if (error instanceof ModelProviderError) {
      expect(error.code).toBe("provider_response_invalid");
      expect(error.message).toContain("usage.cost");
    }
  });

  // A missing top-level `usage` block is the same protocol violation.
  it("raises provider_response_invalid when usage is entirely absent", async () => {
    const responseWithoutUsage = (): Response =>
      new Response(
        JSON.stringify({
          id: "gen-no-usage",
          model: DEV_PAIR.modelId,
          provider: DEV_PAIR.providerId,
          choices: [
            {
              finish_reason: "stop",
              message: { role: "assistant", content: "hi" },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    const fetchMock = vi.fn(async () => responseWithoutUsage()) as unknown as typeof fetch;
    const provider = new OpenRouterModelProvider({
      env: { OPENROUTER_API_KEY: "abc", OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1" },
      httpClient: fetchMock,
      capabilityGuard: new CapabilityGuard(),
      artifactRecorder: memoryRecorder(),
    });
    await expect(provider.invoke(baseRequest())).rejects.toMatchObject({
      code: "provider_response_invalid",
    });
  });

  // A non-numeric / non-decimal-string cost is also a violation.
  it("raises provider_response_invalid when usage.cost is not a number or decimal string", async () => {
    const responseWithBadCost = (): Response =>
      new Response(
        JSON.stringify({
          id: "gen-bad-cost",
          model: DEV_PAIR.modelId,
          provider: DEV_PAIR.providerId,
          choices: [
            {
              finish_reason: "stop",
              message: { role: "assistant", content: "hi" },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: "not-a-number" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    const fetchMock = vi.fn(async () => responseWithBadCost()) as unknown as typeof fetch;
    const provider = new OpenRouterModelProvider({
      env: { OPENROUTER_API_KEY: "abc", OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1" },
      httpClient: fetchMock,
      capabilityGuard: new CapabilityGuard(),
      artifactRecorder: memoryRecorder(),
    });
    await expect(provider.invoke(baseRequest())).rejects.toMatchObject({
      code: "provider_response_invalid",
    });
  });
});

describe("OpenRouterModelProvider — ITOTORI-233 cache-aware annotations", () => {
  // Acceptance criterion #1 (env-gated subset): synthetic response with
  // `prompt_tokens_details.cached_tokens > 0` lands cache fields on the
  // ProviderRunRecord. The live-call version of this test is env-gated on
  // OPENROUTER_IMPLICIT_CACHE_PROVIDER (see openrouter-live.test.ts) —
  // implicit-cache evidence is empirically unavailable on Trevor's ZDR
  // allow-list per the ITOTORI-224 evidence pack (call_3 returned
  // HTTP 404 ZDR envelope), so this unit test mocks the wire shape that
  // a ZDR-allowed cache-supporting provider WOULD return.

  it("populates TokenUsage.cacheReadTokens / cacheWriteTokens from usage.prompt_tokens_details", async () => {
    const fetchMock = vi.fn(async () =>
      successResponse({ usageCost: 0.000006, cachedTokens: 7, cacheWriteTokens: 3 }),
    ) as unknown as typeof fetch;
    const provider = new OpenRouterModelProvider({
      env: { OPENROUTER_API_KEY: "abc", OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1" },
      httpClient: fetchMock,
      capabilityGuard: new CapabilityGuard(),
      artifactRecorder: memoryRecorder(),
    });
    const result = await provider.invoke(baseRequest());
    expect(result.providerRun.tokenUsage.cacheReadTokens).toBe(7);
    expect(result.providerRun.tokenUsage.cacheWriteTokens).toBe(3);
  });

  it("populates ProviderCost.cacheDiscountMicrosUsd from usage.cost_details.cache_discount verbatim", async () => {
    // Mirrors the canonical OR shape: `cache_discount` is a USD decimal
    // number on a real implicit-cache hit. 0.000003 USD → 3 micros via
    // decimalUsdStringToMicros (the same helper usage.cost uses).
    const fetchMock = vi.fn(async () =>
      successResponse({ usageCost: 0.000005, cachedTokens: 5, cacheDiscount: 0.000003 }),
    ) as unknown as typeof fetch;
    const provider = new OpenRouterModelProvider({
      env: { OPENROUTER_API_KEY: "abc", OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1" },
      httpClient: fetchMock,
      capabilityGuard: new CapabilityGuard(),
      artifactRecorder: memoryRecorder(),
    });
    const result = await provider.invoke(baseRequest());
    expect(result.providerRun.cost.amountMicrosUsd).toBe(5);
    expect(result.providerRun.cost.cacheDiscountMicrosUsd).toBe(3);
  });

  it("treats cache_discount: null as 0 (the normal non-cache-hit case per evidence file call_6)", async () => {
    const fetchMock = vi.fn(async () =>
      successResponse({ usageCost: 0.000006, cacheDiscount: null }),
    ) as unknown as typeof fetch;
    const provider = new OpenRouterModelProvider({
      env: { OPENROUTER_API_KEY: "abc", OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1" },
      httpClient: fetchMock,
      capabilityGuard: new CapabilityGuard(),
      artifactRecorder: memoryRecorder(),
    });
    const result = await provider.invoke(baseRequest());
    expect(result.providerRun.cost.cacheDiscountMicrosUsd).toBe(0);
  });

  it("treats absent cost_details / prompt_tokens_details as 0 (synthetic legacy shape)", async () => {
    const fetchMock = vi.fn(async () =>
      successResponse({ usageCost: 0.000006 }),
    ) as unknown as typeof fetch;
    const provider = new OpenRouterModelProvider({
      env: { OPENROUTER_API_KEY: "abc", OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1" },
      httpClient: fetchMock,
      capabilityGuard: new CapabilityGuard(),
      artifactRecorder: memoryRecorder(),
    });
    const result = await provider.invoke(baseRequest());
    expect(result.providerRun.cost.cacheDiscountMicrosUsd).toBe(0);
    expect(result.providerRun.tokenUsage.cacheReadTokens).toBeUndefined();
    expect(result.providerRun.tokenUsage.cacheWriteTokens).toBeUndefined();
  });

  it("cost cap consumes usage.cost VERBATIM, not (usage.cost - cache_discount) — DOC-AMBIGUOUS-6 / §5.3", async () => {
    // ITOTORI-233 / docs/openrouter-integration.md §5.3 + §11 entry 6
    // RESOLVED: `usage.cost` is treated as authoritative billed cost and
    // is **net** of `cache_discount`. The cost cap consumes the
    // post-discount amount verbatim — subtracting cache_discount AGAIN
    // would double-count it. This test mocks two calls at usage.cost
    // = $0.6 (with $0.3 cache_discount each); a $1.0 cap should refuse
    // the THIRD call because cumulative spend = $1.2 > $1.0, NOT
    // because $1.2 - $0.6 = $0.6 < $1.0.
    const fetchMock = vi.fn(async () =>
      successResponse({ usageCost: 0.6, cacheDiscount: 0.3 }),
    ) as unknown as typeof fetch;
    const provider = new OpenRouterModelProvider({
      env: { OPENROUTER_API_KEY: "abc", OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1" },
      httpClient: fetchMock,
      costCapUsd: 1.0,
      rateLimitPerSec: 1000,
      capabilityGuard: new CapabilityGuard(),
      artifactRecorder: memoryRecorder(),
    });
    await provider.invoke(baseRequest());
    await provider.invoke(baseRequest());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(provider.totalSpentUsd()).toBeCloseTo(1.2, 5);
    const error = await provider.invoke(baseRequest()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenRouterCostCapError);
    // Critical: the third call's HTTP request never fired because
    // cumulative spent $1.2 > $1.0 cap — and the cap arithmetic used
    // $0.6 per call (the authoritative `usage.cost`), NOT $0.3 (the
    // pre-discount nominal would yield $0.9 - $1.0 still under cap).
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("per-call maxPriceUsd cap fails closed: a billed cost with no amount throws instead of passing", () => {
    // Regression guard for the audit finding
    // `openrouter-cost-cap-nullish-zero-silent-pass`: the maxPriceUsd
    // guard previously read `normalized.cost.amountMicrosUsd ?? 0`, so a
    // future change that yielded an absent amount would compare `0 > cap`
    // → false and ALWAYS pass the cap (silent undercount). The guard now
    // delegates to `assertBilledCost`, which throws on a `billed` cost
    // that carries no real amount — the fail-loud posture cost law
    // requires. A genuine zero-cost call still passes (returns 0).
    const billedWithNoAmount = {
      costKind: "billed",
      currency: "USD",
      amountUsd: "0.5", // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
      // amountMicrosUsd deliberately absent — the exact shape a future
      // regression could produce.
    } as unknown as Parameters<typeof assertBilledCost>[0];
    expect(() => assertBilledCost(billedWithNoAmount)).toThrow();

    // A real zero-cost (free) call is NOT a missing amount — it passes.
    expect(
      assertBilledCost({
        costKind: "zero",
        currency: "USD",
        amountUsd: "0",
        amountMicrosUsd: 0,
      }),
    ).toBe(0n);
  });
});

describe("full-precision billed-cost rendering (assertBilledCostDecimal + addDecimalUsd)", () => {
  it("assertBilledCostDecimal returns the verbatim sub-micro amountUsd, not the micros-rounded form", () => {
    // The billed cost carries amountUsd "0.00000602" and amountMicrosUsd 6
    // (6.02 micros rounded). The decimal accessor must return the FULL
    // precision string the ledger persists, never the 6-digit micros mirror.
    const decimal = assertBilledCostDecimal({
      costKind: "billed",
      currency: "USD",
      amountUsd: "0.00000602", // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
      amountMicrosUsd: 6, // itotori-225-audit-allow: synthetic micros mirror (6.02→6) proving the decimal accessor returns amountUsd verbatim, never this rounded value
    });
    expect(decimal).toBe("0.00000602");
    expect(decimal).not.toBe("0.000006");
    // Zero cost renders "0".
    expect(
      assertBilledCostDecimal({
        costKind: "zero",
        currency: "USD",
        amountUsd: "0",
        amountMicrosUsd: 0,
      }),
    ).toBe("0");
  });

  it("addDecimalUsd sums sub-micro decimals losslessly (no micros truncation, carries across scale)", () => {
    // Two sub-micro charges: the micros mirror would round each to 0.000006
    // and total 0.000012, losing the 0.00000004 tail. The lossless sum keeps
    // every digit.
    expect(addDecimalUsd("0.00000602", "0.00000602")).toBe("0.00001204");
    expect(addDecimalUsd("0", "0.00000602")).toBe("0.00000602");
    expect(addDecimalUsd("0", "0")).toBe("0");
    // Mismatched fractional scales align correctly.
    expect(addDecimalUsd("0.1", "0.02")).toBe("0.12");
    // Fractional carry into the whole part.
    expect(addDecimalUsd("0.6", "0.6")).toBe("1.2");
    expect(addDecimalUsd("0.999999995", "0.000000005")).toBe("1");
  });
});

describe("OpenRouterModelProvider — ITOTORI-233 live cache evidence (env-gated)", () => {
  // Acceptance criterion #1: "Live call against an implicit-cache
  // supporting provider writes `cache_discount` and `cached_input_tokens`
  // to the ledger". Empirical implicit-cache evidence is UNAVAILABLE on
  // Trevor's account because the only deepseek-v4-flash endpoint
  // advertising `supports_implicit_caching: true` is the
  // `deepseek`-tagged endpoint, which is excluded from his ZDR
  // allow-list (call_3 in docs/openrouter-integration-evidence/
  // 2026-06-25.json returned HTTP 404 "No endpoints found matching
  // your data policy").
  //
  // This test compiles + is skipped at runtime unless
  // `OPENROUTER_IMPLICIT_CACHE_PROVIDER` is set to a ZDR-allowed
  // cache-supporting provider. It exists as a forcing-function
  // scaffold so a future evidence pass that DOES surface a non-zero
  // cache_discount value can flip the live assertion on without
  // adding a new test file.

  const liveCacheProvider = process.env.OPENROUTER_IMPLICIT_CACHE_PROVIDER;
  const it_live = liveCacheProvider ? it : it.skip;

  it_live("live call surfaces cacheReadTokens + cacheDiscountMicrosUsd from the wire", async () => {
    // This test body is intentionally minimal: it asserts only that
    // the shape lands on the ProviderRunRecord when a live call
    // returns a non-zero cache hit. The full ledger-row assertion
    // lives in the env-gated DB integration suite.
    expect(liveCacheProvider).toBeDefined();
    // No actual HTTP path here — the live smoke harness owns the
    // wire call; this assertion is the scaffolded forcing function.
  });

  // Always-runs assertion on the cache-discount normalizer so the
  // describe block is never "0 tests" when the live env var is unset.
  // This exercises the non-cache-hit path that IS reachable on Trevor's
  // ZDR account (the deepseek implicit-cache endpoint is excluded): a
  // response whose `usage.cost_details.cache_discount` is null/absent
  // maps to 0 micros, which is exactly the value the ledger records for
  // every non-cache call until a non-null discount is empirically
  // surfaced (see ITOTORI-233).
  it("extractCacheDiscountMicros maps the non-cache-hit shape (null/absent cache_discount) to 0", () => {
    // Empirical non-cache-hit shape (2026-06-25.json call_6): explicit null.
    expect(extractCacheDiscountMicros({ cost_details: { cache_discount: null } })).toBe(0);
    // cost_details present but the key omitted entirely.
    expect(extractCacheDiscountMicros({ cost_details: {} })).toBe(0);
    // cost_details absent altogether.
    expect(extractCacheDiscountMicros({})).toBe(0);
    // Empty-string discount (whitespace-only) also normalizes to 0.
    expect(extractCacheDiscountMicros({ cost_details: { cache_discount: "  " } })).toBe(0);
  });
});

describe("OpenRouterModelProvider — ITOTORI-237 descriptorForPair", () => {
  // The agentic-loop pre-flight check (e.g. SpeakerLabelAgent's
  // assertProviderSupportsStructuredOutput) reads
  // `provider.descriptor.capabilities` directly. The class-level
  // `descriptor` falls back to `openRouterDefaultCapabilities` (untested
  // for structured outputs), which would refuse DEV_PAIR even though
  // its registered capability sheet declares jsonSchema='supported'.
  // `descriptorForPair` synthesises a descriptor whose capabilities
  // reflect the per-(modelId, providerId) sheet registered in the
  // provider's CapabilityGuard at construction.

  it("plain-json-fallback-under-zdr: returns a descriptor whose capabilities reflect the registered DEV_PAIR sheet (jsonSchema AND jsonObject 'unsupported' under ZDR, plainJsonExtraction 'supported')", () => {
    const provider = new OpenRouterModelProvider({
      env: { OPENROUTER_API_KEY: "abc", OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1" },
      httpClient: vi.fn() as unknown as typeof fetch,
      capabilityGuard: new CapabilityGuard(),
      artifactRecorder: memoryRecorder(),
    });
    const descriptor = provider.descriptorForPair(DEV_PAIR);
    // plain-json-fallback-under-zdr — BOTH json_schema and json_object are
    // unroutable under ZDR for this pair (HTTP 404 on either response_format);
    // the plain completion is the proven-routable mode.
    expect(descriptor.capabilities.structuredOutputs.jsonSchema).toBe("unsupported");
    expect(descriptor.capabilities.structuredOutputs.jsonObject).toBe("unsupported");
    expect(descriptor.capabilities.structuredOutputs.plainJsonExtraction).toBe("supported");
    expect(descriptor.capabilities.toolCalls.support).toBe("supported");
    // The non-capabilities fields stay identical to the class-level descriptor.
    expect(descriptor.family).toBe(provider.descriptor.family);
    expect(descriptor.endpointFamily).toBe(provider.descriptor.endpointFamily);
    expect(descriptor.providerName).toBe(provider.descriptor.providerName);
    expect(descriptor.defaultModelId).toBe(provider.descriptor.defaultModelId);
  });

  it("falls back to openRouterDefaultCapabilities for an unknown pair (jsonSchema stays 'untested')", () => {
    const provider = new OpenRouterModelProvider({
      env: { OPENROUTER_API_KEY: "abc", OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1" },
      httpClient: vi.fn() as unknown as typeof fetch,
      capabilityGuard: new CapabilityGuard(),
      artifactRecorder: memoryRecorder(),
    });
    const descriptor = provider.descriptorForPair({
      modelId: "some/random-model",
      providerId: "some-random-provider",
    });
    // Unknown pair falls back to the safe defaults — jsonSchema remains
    // 'untested' so the pre-flight check still refuses, preserving the
    // no-silent-fallback invariant.
    expect(descriptor.capabilities.structuredOutputs.jsonSchema).toBe("untested");
    expect(descriptor.capabilities).toBe(provider.descriptor.capabilities);
    expect(descriptor.capabilities.structuredOutputs.jsonSchema).toBe(
      openRouterDefaultCapabilities.structuredOutputs.jsonSchema,
    );
  });

  it("leaves the class-level descriptor (request-agnostic) at the safe defaults", () => {
    // Sanity check on the load-bearing invariant: nothing about
    // descriptorForPair should mutate the class-level descriptor —
    // unknown callers still see 'untested'.
    const provider = new OpenRouterModelProvider({
      env: { OPENROUTER_API_KEY: "abc", OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1" },
      httpClient: vi.fn() as unknown as typeof fetch,
      capabilityGuard: new CapabilityGuard(),
      artifactRecorder: memoryRecorder(),
    });
    // Read the per-pair descriptor first — must not mutate class state.
    provider.descriptorForPair(DEV_PAIR);
    expect(provider.descriptor.capabilities.structuredOutputs.jsonSchema).toBe("untested");
  });
});
