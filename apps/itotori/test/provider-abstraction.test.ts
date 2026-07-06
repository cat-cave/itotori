import { describe, expect, it, vi } from "vitest";
// itotori-purge-fakemodelprovider-from-production — FakeModelProvider is no
// longer exported from the providers public barrel; tests import the test
// double directly from the fake module.
import { FakeModelProvider } from "../src/providers/fake.js";
import {
  AccountZdrAssertionError,
  LocalOpenAICompatibleProvider,
  ModelProviderError,
  OpenRouterModelProvider,
  OpenRouterProvider,
  openRouterDefaultCapabilities,
  selectStructuredOutputMode,
  type ModelCapabilities,
  type ModelInvocationRequest,
  type ModelTool,
  type ProviderRunArtifact,
  type ProviderRunArtifactRecorder,
} from "../src/providers/index.js";

describe("provider capabilities", () => {
  it("selects only explicitly supported structured-output modes", () => {
    const capabilities = openRouterCapabilitiesForPrivateInputs();

    expect(
      selectStructuredOutputMode(capabilities, [
        "json_schema",
        "tool_call_arguments",
        "plain_json",
      ]),
    ).toBe("json_schema");
  });
});

describe("AccountZdrAssertionError (ITOTORI-227)", () => {
  // The account-wide ZDR posture is the load-bearing operator gate. The
  // OpenRouterModelProvider constructor MUST throw synchronously when
  // OPENROUTER_ZDR_ACCOUNT_ASSERTED is anything other than "1". There
  // is no warning mode, no default-true, no inferred "auto". The
  // assertion lives in OpenRouterModelProvider only — recorded /
  // local / fake providers do NOT carry it because they never make a
  // live call.
  it("throws AccountZdrAssertionError when OPENROUTER_ZDR_ACCOUNT_ASSERTED is unset", () => {
    expect(
      () =>
        new OpenRouterModelProvider({
          env: { OPENROUTER_API_KEY: "sk-test" },
        }),
    ).toThrow(AccountZdrAssertionError);
  });

  it("throws AccountZdrAssertionError when OPENROUTER_ZDR_ACCOUNT_ASSERTED is not the literal '1'", () => {
    expect(
      () =>
        new OpenRouterModelProvider({
          env: {
            OPENROUTER_API_KEY: "sk-test",
            OPENROUTER_ZDR_ACCOUNT_ASSERTED: "true",
          },
        }),
    ).toThrow(AccountZdrAssertionError);
    expect(
      () =>
        new OpenRouterModelProvider({
          env: {
            OPENROUTER_API_KEY: "sk-test",
            OPENROUTER_ZDR_ACCOUNT_ASSERTED: "yes",
          },
        }),
    ).toThrow(AccountZdrAssertionError);
  });

  it("constructs cleanly when OPENROUTER_ZDR_ACCOUNT_ASSERTED=1 (with the API key set)", () => {
    expect(
      () =>
        new OpenRouterModelProvider({
          env: {
            OPENROUTER_API_KEY: "sk-test",
            OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1",
          },
          artifactRecorder: memoryRecorder(),
        }),
    ).not.toThrow();
  });

  it("asserts the ZDR posture BEFORE the API-key check (privacy gate is load-bearing)", () => {
    // No OPENROUTER_API_KEY in env. If the assertion ran AFTER the
    // key check, the error would be `OpenRouterMissingApiKeyError`.
    // The assertion runs FIRST, so we must see the ZDR error.
    expect(() => new OpenRouterModelProvider({ env: {} })).toThrow(AccountZdrAssertionError);
  });
});

describe("OpenRouterModelProvider wire-level provider.zdr posture (ITOTORI-227)", () => {
  function fetchMockSuccess(): {
    fetch: typeof fetch;
    calls: Array<{ body: string }>;
  } {
    const calls: Array<{ body: string }> = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ body: String(init?.body ?? "") });
      return jsonResponse({
        id: "gen-test",
        model: "deepseek/deepseek-v4-flash",
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: "Hello." },
          },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6, cost: 0.000003 }, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
        provider: "fireworks",
      });
    }) as unknown as typeof fetch;
    return { fetch: fetchImpl, calls };
  }

  it("sends provider.zdr=true for private_corpus input", async () => {
    const { fetch: fetchMock, calls } = fetchMockSuccess();
    const provider = new OpenRouterModelProvider({
      env: { OPENROUTER_API_KEY: "sk-test", OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1" },
      httpClient: fetchMock,
      costCapUsd: 1.0,
      rateLimitPerSec: 1000,
      artifactRecorder: memoryRecorder(),
    });

    await provider.invoke(
      zdrPostureRequest("deepseek/deepseek-v4-flash", "fireworks", "private_corpus"),
    );

    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0]!.body) as { provider: { zdr?: unknown } };
    expect(body.provider.zdr).toBe(true);
  });

  it("sends provider.zdr=true for synthetic_public input", async () => {
    const { fetch: fetchMock, calls } = fetchMockSuccess();
    const provider = new OpenRouterModelProvider({
      env: { OPENROUTER_API_KEY: "sk-test", OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1" },
      httpClient: fetchMock,
      costCapUsd: 1.0,
      rateLimitPerSec: 1000,
      artifactRecorder: memoryRecorder(),
    });

    await provider.invoke(
      zdrPostureRequest("deepseek/deepseek-v4-flash", "fireworks", "synthetic_public"),
    );

    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0]!.body) as { provider: { zdr?: unknown } };
    expect(body.provider.zdr).toBe(true);
  });

  it("does NOT send provider.zdr for public input (lower friction for public-content stages)", async () => {
    const { fetch: fetchMock, calls } = fetchMockSuccess();
    const provider = new OpenRouterModelProvider({
      env: { OPENROUTER_API_KEY: "sk-test", OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1" },
      httpClient: fetchMock,
      costCapUsd: 1.0,
      rateLimitPerSec: 1000,
      artifactRecorder: memoryRecorder(),
    });

    await provider.invoke(zdrPostureRequest("deepseek/deepseek-v4-flash", "fireworks", "public"));

    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0]!.body) as { provider: { zdr?: unknown } };
    expect(body.provider.zdr).toBeUndefined();
  });
});

describe("OpenRouterProvider", () => {
  it("rejects unconfirmed structured output support before contacting OpenRouter", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch;
    const provider = new OpenRouterProvider({
      modelId: "openai/gpt-4o-mini",
      apiKey: "test-key",
      fetch: fetchMock,
      live: { enabled: true, artifactRecorder: memoryRecorder(), rawCapture: "disabled" },
    });

    await expect(
      provider.invoke({
        ...jsonSchemaRequest(),
        inputClassification: "public",
      }),
    ).rejects.toMatchObject({
      code: "capability_unsupported",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps neutral JSON-schema requests into OpenRouter routing without exposing router fields to callers", async () => {
    const recorder = memoryRecorder();
    const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ input, init });
      return jsonResponse({
        id: "gen-test",
        model: "openai/gpt-4o-mini",
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: '{"targetText":"Hello, {player}."}',
            },
          },
        ],
        usage: {
          prompt_tokens: 11,
          completion_tokens: 7,
          total_tokens: 18,
          cost: 0.000019, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
        },
        openrouter_metadata: {
          requested: "openai/gpt-4o-mini",
          strategy: "direct",
          attempt: 1,
          endpoints: {
            available: [
              {
                provider: "OpenAI",
                model: "openai/gpt-4o-mini",
                selected: true,
              },
            ],
          },
        },
      });
    }) as unknown as typeof fetch;
    const provider = new OpenRouterProvider({
      modelId: "openai/gpt-4o-mini",
      apiKey: "test-key",
      fetch: fetchMock,
      capabilities: openRouterCapabilitiesForPrivateInputs(),
      live: { enabled: true, artifactRecorder: recorder, rawCapture: "disabled" },
    });

    const result = await provider.invoke(jsonSchemaRequest());

    expect(result.content).toBe('{"targetText":"Hello, {player}."}');
    expect(result.providerRun.provider).toMatchObject({
      providerFamily: "openrouter",
      endpointFamily: "chat-completions",
      requestedModelId: "openai/gpt-4o-mini",
      actualModelId: "openai/gpt-4o-mini",
      upstreamProvider: "OpenAI",
    });
    expect(result.providerRun.provider.routeSettingsHash).toMatch(/^sha256:/u);
    expect(result.providerRun.cost).toEqual({
      costKind: "billed",
      currency: "USD",
      amountUsd: "0.000019", // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
      amountMicrosUsd: 19, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
      // ITOTORI-233 — synthetic response has no usage.cost_details so
      // the cache discount lands as 0.
      cacheDiscountMicrosUsd: 0,
    });
    expect(fetchCalls).toHaveLength(1);
    const requestBody = JSON.parse(String(fetchCalls[0]?.init?.body)) as {
      provider: { data_collection?: string; require_parameters?: boolean };
      response_format: { type?: string; json_schema?: { strict?: boolean } };
    };
    expect(requestBody.provider).toMatchObject({
      data_collection: "deny",
      require_parameters: true,
    });
    expect(requestBody.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { strict: true },
    });
    expect(recorder.artifacts).toHaveLength(1);
    expect(recorder.artifacts[0]?.request.rawTextCaptured).toBe(false);
    expect(recorder.artifacts[0]?.request.prompt).toMatchObject({
      presetId: "test-prompt-v1",
      templateVersion: "1.0.0",
    });
    expect(recorder.artifacts[0]?.request.providerPreset).toMatchObject({
      slug: "openrouter/itotori-test",
      version: "2026-06-17",
      configSnapshot: expect.objectContaining({
        route: "fixture",
      }),
    });
    expect(recorder.artifacts[0]?.adapterMetadata).toHaveProperty("openrouterMetadata");
  });

  it("records the served upstream provider name for each ZDR-allow-list provider OpenRouter may serve", async () => {
    // OpenRouter-side fallback (provider.order + allow_fallbacks) may serve
    // any provider in the account ZDR allow-list on a primary-provider 429.
    // Whichever upstream actually served must be recorded verbatim on the
    // provider-run record; these fixtures pin the served-name mapping for the
    // representative providers the localize-project recipe routes across.
    for (const fixture of LOCALIZE_PROJECT_PROVIDER_NAME_FIXTURES) {
      const recorder = memoryRecorder();
      const fetchMock = vi.fn(async () =>
        jsonResponse({
          id: `gen-${fixture.providerId}`,
          model: "deepseek/deepseek-v4-flash",
          provider: fixture.observedProviderName,
          choices: [
            {
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: '{"targetText":"Hello, {player}."}',
              },
            },
          ],
          usage: {
            prompt_tokens: 11,
            completion_tokens: 7,
            total_tokens: 18,
            cost: 0.000019, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
          },
        }),
      ) as unknown as typeof fetch;
      const provider = new OpenRouterProvider({
        modelId: "deepseek/deepseek-v4-flash",
        apiKey: "test-key",
        fetch: fetchMock,
        capabilities: openRouterCapabilitiesForPrivateInputs(),
        live: { enabled: true, artifactRecorder: recorder, rawCapture: "disabled" },
      });

      const result = await provider.invoke(
        jsonSchemaRequest("deepseek/deepseek-v4-flash", fixture.providerId),
      );

      expect(result.providerRun.status).toBe("succeeded");
      expect(result.providerRun.provider).toMatchObject({
        requestedProviderId: fixture.providerId,
        upstreamProvider: fixture.observedProviderName,
      });
      expect(recorder.artifacts).toHaveLength(1);
    }
  });

  it("ITOTORI-243: accepts a Fireworks-preferred request served by another ZDR-allow-list provider and records the served pair", async () => {
    // The request is private_corpus, so zdr:true is enforced on the wire —
    // OpenRouter could only have served a ZDR-allow-list provider. AtlasCloud
    // is one such provider, so a Fireworks-PREFERRED (order[0]) request served
    // by AtlasCloud is a valid ZDR serve (OpenRouter-side fallback). ITOTORI-243
    // removed the provider-identity throw: accept and record the served (model,
    // providerId) pair + real billed cost, never reject.
    const recorder = memoryRecorder();
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        id: "gen-fireworks-routed-elsewhere",
        model: "deepseek/deepseek-v4-flash",
        provider: "AtlasCloud",
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: '{"targetText":"Hello, {player}."}',
            },
          },
        ],
        usage: {
          prompt_tokens: 11,
          completion_tokens: 7,
          total_tokens: 18,
          cost: 0.000019, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
        },
      }),
    ) as unknown as typeof fetch;
    const provider = new OpenRouterProvider({
      modelId: "deepseek/deepseek-v4-flash",
      apiKey: "test-key",
      fetch: fetchMock,
      capabilities: openRouterCapabilitiesForPrivateInputs(),
      live: { enabled: true, artifactRecorder: recorder, rawCapture: "disabled" },
    });

    const result = await provider.invoke(
      jsonSchemaRequest("deepseek/deepseek-v4-flash", "fireworks"),
    );
    expect(result.providerRun.status).toBe("succeeded");
    expect(result.providerRun.provider.requestedProviderId).toBe("fireworks");
    expect(result.providerRun.provider.upstreamProvider).toBe("AtlasCloud");
    expect(result.providerRun.cost.costKind).toBe("billed");
    expect(result.providerRun.cost.amountMicrosUsd).toBe(19);
    // zdr:true posture recorded — the privacy gate that makes the served
    // provider ZDR-eligible.
    expect(result.providerRun.routingPosture.zdr).toBe(true);
    expect(recorder.artifacts[0]?.run.provider.upstreamProvider).toBe("AtlasCloud");
  });

  it("throws provider errors carrying failed run records", async () => {
    const recorder = memoryRecorder();
    const fetchMock = vi.fn(async () => {
      return jsonResponse({ error: { message: "rate limited" } }, 429);
    }) as unknown as typeof fetch;
    const provider = new OpenRouterProvider({
      modelId: "openai/gpt-4o-mini",
      apiKey: "test-key",
      fetch: fetchMock,
      capabilities: openRouterCapabilitiesForPrivateInputs(),
      live: { enabled: true, artifactRecorder: recorder, rawCapture: "disabled" },
    });

    await expect(provider.invoke(jsonSchemaRequest())).rejects.toMatchObject({
      code: "provider_http_error",
      retryable: true,
      providerRun: expect.objectContaining({
        status: "failed",
        errorClasses: ["http_429"],
        cost: { costKind: "zero", currency: "USD", amountUsd: "0", amountMicrosUsd: 0 },
        prompt: expect.objectContaining({ presetId: "test-prompt-v1" }),
        providerPreset: expect.objectContaining({ slug: "openrouter/itotori-test" }),
      }),
    });
    expect(recorder.artifacts).toHaveLength(1);
    expect(recorder.artifacts[0]?.run.status).toBe("failed");
    expect(recorder.artifacts[0]?.error).toMatchObject({
      class: "provider_http_error",
      message: "OpenRouter HTTP 429 (http_429)",
      statusCode: 429,
      retryable: true,
      providerErrorClass: "http_429",
    });
  });

  it("redacts upstream HTTP error text from private provider-run artifacts", async () => {
    const privatePath = "/Users/trevor/private-client/ja-JP/game.po";
    const promptFragment = "preserve the moon-gate honorific exactly";
    const tokenLikeString = "sk-or-v1-private-token-1234567890abcdef";
    const projectTitle = "Project Violet Harbor";
    const recorder = memoryRecorder();
    const fetchMock = vi.fn(async () => {
      return jsonResponse(
        {
          error: {
            code: "rate_limit_exceeded",
            message:
              `429 for ${privatePath}; prompt '${promptFragment}'; ` +
              `token ${tokenLikeString}; project ${projectTitle}`,
          },
        },
        429,
      );
    }) as unknown as typeof fetch;
    const provider = new OpenRouterProvider({
      modelId: "openai/gpt-4o-mini",
      apiKey: "test-key",
      fetch: fetchMock,
      capabilities: openRouterCapabilitiesForPrivateInputs(),
      live: { enabled: true, artifactRecorder: recorder, rawCapture: "disabled" },
    });

    await expect(
      provider.invoke({
        ...jsonSchemaRequest(),
        messages: [
          {
            role: "user",
            content: `Translate ${projectTitle}: ${promptFragment} from ${privatePath}`,
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "provider_http_error",
      retryable: true,
      providerRun: expect.objectContaining({
        status: "failed",
        errorClasses: ["http_429"],
        provider: expect.objectContaining({
          requestedProviderId: "OpenAI",
        }),
      }),
    });

    expect(recorder.artifacts).toHaveLength(1);
    expect(recorder.artifacts[0]?.error).toMatchObject({
      class: "provider_http_error",
      message: "OpenRouter HTTP 429 (rate_limit_exceeded)",
      statusCode: 429,
      retryable: true,
      providerErrorClass: "rate_limit_exceeded",
    });
    const serializedArtifact = JSON.stringify(recorder.artifacts[0]);
    expect(serializedArtifact).not.toContain(privatePath);
    expect(serializedArtifact).not.toContain(promptFragment);
    expect(serializedArtifact).not.toContain(tokenLikeString);
    expect(serializedArtifact).not.toContain(projectTitle);
  });

  it("keeps bounded upstream HTTP error text for public provider-run artifacts", async () => {
    const recorder = memoryRecorder();
    const fetchMock = vi.fn(async () => {
      return jsonResponse(
        {
          error: {
            code: "quota_exceeded",
            message: "quota exhausted for public fixture",
          },
        },
        402,
      );
    }) as unknown as typeof fetch;
    const provider = new OpenRouterProvider({
      modelId: "openai/gpt-4o-mini",
      apiKey: "test-key",
      fetch: fetchMock,
      capabilities: openRouterCapabilitiesForPrivateInputs(),
      live: { enabled: true, artifactRecorder: recorder, rawCapture: "disabled" },
    });

    await expect(
      provider.invoke({
        ...jsonSchemaRequest(),
        inputClassification: "public",
      }),
    ).rejects.toMatchObject({
      code: "provider_http_error",
      retryable: false,
    });

    expect(recorder.artifacts).toHaveLength(1);
    expect(recorder.artifacts[0]?.error).toMatchObject({
      class: "provider_http_error",
      message: "quota exhausted for public fixture",
      statusCode: 402,
      retryable: false,
      providerErrorClass: "quota_exceeded",
    });
  });

  it("records malformed successful responses as failed provider runs", async () => {
    const recorder = memoryRecorder();
    const fetchMock = vi.fn(async () => {
      return jsonResponse({
        model: "openai/gpt-4o-mini",
        choices: { malformed: true },
      });
    }) as unknown as typeof fetch;
    const provider = new OpenRouterProvider({
      modelId: "openai/gpt-4o-mini",
      apiKey: "test-key",
      fetch: fetchMock,
      capabilities: openRouterCapabilitiesForPrivateInputs(),
      live: { enabled: true, artifactRecorder: recorder, rawCapture: "disabled" },
    });

    await expect(provider.invoke(jsonSchemaRequest())).rejects.toMatchObject({
      code: "provider_response_invalid",
      providerRun: expect.objectContaining({
        status: "failed",
        errorClasses: ["provider_response_invalid"],
        cost: { costKind: "zero", currency: "USD", amountUsd: "0", amountMicrosUsd: 0 },
        prompt: expect.objectContaining({ presetId: "test-prompt-v1" }),
      }),
    });
    expect(recorder.artifacts).toHaveLength(1);
    expect(recorder.artifacts[0]?.run.status).toBe("failed");
    expect(recorder.artifacts[0]?.error).toMatchObject({
      class: "provider_response_invalid",
    });
  });

  it("requires explicit live opt-in before any fetch can run", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch;
    const provider = new OpenRouterProvider({
      modelId: "openai/gpt-4o-mini",
      apiKey: "test-key",
      fetch: fetchMock,
      capabilities: openRouterCapabilitiesForPrivateInputs(),
      live: { enabled: false },
    });

    await expect(provider.invoke(jsonSchemaRequest())).rejects.toMatchObject({
      code: "configuration_error",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forces provider data collection denial for private inputs despite routing overrides", async () => {
    const recorder = memoryRecorder();
    const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ input, init });
      return jsonResponse({
        model: "openai/gpt-4o-mini",
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: '{"targetText":"Hello."}',
            },
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8, cost: 0.000005 }, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
      });
    }) as unknown as typeof fetch;
    const provider = new OpenRouterProvider({
      modelId: "openai/gpt-4o-mini",
      apiKey: "test-key",
      fetch: fetchMock,
      capabilities: openRouterCapabilitiesForPrivateInputs(),
      routing: { dataCollection: "allow" },
      live: { enabled: true, artifactRecorder: recorder, rawCapture: "disabled" },
    });

    await provider.invoke(jsonSchemaRequest());

    const requestBody = JSON.parse(String(fetchCalls[0]?.init?.body)) as {
      provider: { data_collection?: string; zdr?: unknown };
    };
    expect(requestBody.provider.data_collection).toBe("deny");
    // ITOTORI-227 — private_corpus input also defaults provider.zdr=true.
    expect(requestBody.provider.zdr).toBe(true);
  });

  it("records the actual OpenRouter data collection routing policy for public inputs", async () => {
    const recorder = memoryRecorder();
    const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ input, init });
      return jsonResponse({
        model: "openai/gpt-4o-mini",
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: '{"targetText":"Hello."}',
            },
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8, cost: 0.000005 }, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
      });
    }) as unknown as typeof fetch;
    const provider = new OpenRouterProvider({
      modelId: "openai/gpt-4o-mini",
      apiKey: "test-key",
      fetch: fetchMock,
      capabilities: openRouterCapabilitiesForPrivateInputs(),
      routing: { dataCollection: "allow" },
      live: { enabled: true, artifactRecorder: recorder, rawCapture: "disabled" },
    });

    await provider.invoke({
      ...jsonSchemaRequest(),
      inputClassification: "public",
    });

    const requestBody = JSON.parse(String(fetchCalls[0]?.init?.body)) as {
      provider: { data_collection?: string; zdr?: unknown };
    };
    expect(requestBody.provider.data_collection).toBe("allow");
    // ITOTORI-227 — public input skips the provider.zdr default.
    expect(requestBody.provider.zdr).toBeUndefined();
  });

  it("translates tool_call_arguments into a required OpenRouter tool call", async () => {
    const recorder = memoryRecorder();
    const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ input, init });
      return jsonResponse({
        model: "openai/gpt-4o-mini",
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call-1",
                  type: "function",
                  function: {
                    name: "emit_translation",
                    arguments: '{"targetText":"Hello."}',
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8, cost: 0.000005 }, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
      });
    }) as unknown as typeof fetch;
    const provider = new OpenRouterProvider({
      modelId: "openai/gpt-4o-mini",
      apiKey: "test-key",
      fetch: fetchMock,
      capabilities: openRouterCapabilitiesWithToolCallArguments(),
      live: { enabled: true, artifactRecorder: recorder, rawCapture: "disabled" },
    });

    const result = await provider.invoke(toolCallArgumentsRequest());

    const requestBody = JSON.parse(String(fetchCalls[0]?.init?.body)) as {
      provider: { require_parameters?: boolean };
      response_format?: unknown;
      tools?: Array<{ function?: { name?: string; parameters?: unknown; strict?: boolean } }>;
      tool_choice?: { function?: { name?: string } };
    };
    expect(requestBody.response_format).toBeUndefined();
    expect(requestBody.provider.require_parameters).toBe(true);
    expect(requestBody.tools).toHaveLength(1);
    expect(requestBody.tools?.[0]?.function).toMatchObject({
      name: "emit_translation",
      parameters: toolCallSchema(),
      strict: true,
    });
    expect(requestBody.tool_choice).toMatchObject({
      function: { name: "emit_translation" },
    });
    expect(result.toolCalls).toEqual([
      {
        id: "call-1",
        name: "emit_translation",
        argumentsJson: '{"targetText":"Hello."}',
      },
    ]);
    expect(result.providerRun.structuredOutputMode).toBe("tool_call_arguments");
    expect(recorder.artifacts[0]?.request.structuredOutputMode).toBe("tool_call_arguments");
  });

  it("rejects empty synthetic tool schemas before contacting OpenRouter", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch;
    const provider = new OpenRouterProvider({
      modelId: "openai/gpt-4o-mini",
      apiKey: "test-key",
      fetch: fetchMock,
      capabilities: openRouterCapabilitiesWithToolCallArguments(),
      live: { enabled: true, artifactRecorder: memoryRecorder(), rawCapture: "disabled" },
    });

    await expect(provider.invoke(emptyToolCallArgumentsRequest())).rejects.toMatchObject({
      code: "capability_unsupported",
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("records routed provider, policy, fallback chain, and retry state", async () => {
    const recorder = memoryRecorder();
    const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ input, init });
      return jsonResponse({
        id: "gen-fallback-test",
        model: "anthropic/claude-3-haiku",
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: '{"targetText":"Hello."}',
            },
          },
        ],
        usage: {
          prompt_tokens: 9,
          completion_tokens: 5,
          total_tokens: 14,
          cost: 0.000014, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
        },
        openrouter_metadata: {
          requested: "openai/gpt-4o-mini",
          strategy: "fallback",
          attempt: 1,
          endpoints: {
            available: [
              {
                provider: "Anthropic",
                model: "anthropic/claude-3-haiku",
                selected: true,
              },
            ],
          },
        },
      });
    }) as unknown as typeof fetch;
    const provider = new OpenRouterProvider({
      modelId: "openai/gpt-4o-mini",
      apiKey: "test-key",
      fetch: fetchMock,
      capabilities: openRouterCapabilitiesForPrivateInputs(),
      // ITOTORI-220 — `only` pins provider routing to the request's
      // providerId at invoke time; no caller-supplied `order` or
      // `allowFallbacks` is honoured for provider routing.
      routing: {},
      live: { enabled: true, artifactRecorder: recorder, rawCapture: "disabled" },
    });

    const result = await provider.invoke({
      // ITOTORI-243 — providerId leads the preference `order`; the mocked
      // fixture's served provider is recorded as the served pair.
      ...jsonSchemaRequest("openai/gpt-4o-mini", "Anthropic"),
      fallbackModels: ["anthropic/claude-3-haiku"],
    });

    const requestBody = JSON.parse(String(fetchCalls[0]?.init?.body)) as {
      models?: string[];
      provider: { order?: string[]; only?: string[]; allow_fallbacks?: boolean };
    };
    expect(requestBody.models).toEqual(["openai/gpt-4o-mini", "anthropic/claude-3-haiku"]);
    expect(requestBody.provider).toMatchObject({
      order: ["Anthropic"],
      allow_fallbacks: true,
    });
    expect(requestBody.provider.only).toBeUndefined();
    expect(result.providerRun).toMatchObject({
      retryCount: 0,
      fallbackUsed: true,
      fallbackPlan: ["openai/gpt-4o-mini", "anthropic/claude-3-haiku"],
      provider: {
        requestedModelId: "openai/gpt-4o-mini",
        actualModelId: "anthropic/claude-3-haiku",
        upstreamProvider: "Anthropic",
        routeSettingsHash: expect.stringMatching(/^sha256:/u),
      },
      providerPreset: expect.objectContaining({
        slug: "openrouter/itotori-test",
      }),
    });
    expect(recorder.artifacts[0]?.adapterMetadata).toMatchObject({
      providerRouting: expect.objectContaining({
        order: ["Anthropic"],
        allow_fallbacks: true,
      }),
      openrouterMetadata: expect.objectContaining({
        strategy: "fallback",
        attempt: 1,
      }),
    });
  });
});

describe("LocalOpenAICompatibleProvider", () => {
  it("uses the same provider interface without OpenRouter routing fields", async () => {
    const recorder = memoryRecorder();
    const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ input, init });
      return jsonResponse({
        model: "local-model",
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: "Hello, {player}.",
            },
          },
        ],
        usage: {
          prompt_tokens: 4,
          completion_tokens: 3,
          total_tokens: 7,
        },
      });
    }) as unknown as typeof fetch;
    const provider = new LocalOpenAICompatibleProvider({
      modelId: "local-model",
      baseUrl: "http://127.0.0.1:11434/v1",
      fetch: fetchMock,
      capabilities: localCapabilities(),
      live: { enabled: true, artifactRecorder: recorder, rawCapture: "disabled" },
    });

    const result = await provider.invoke({
      taskKind: "draft_translation",
      inputClassification: "private_corpus",
      prompt: promptFixture(),
      messages: [{ role: "user", content: "こんにちは、{player}。" }],
    });

    expect(result.content).toBe("Hello, {player}.");
    expect(result.providerRun.provider.providerFamily).toBe("local-openai-compatible");
    expect(result.providerRun.cost).toMatchObject({
      costKind: "zero",
      amountMicrosUsd: 0,
    });
    const requestBody = JSON.parse(String(fetchCalls[0]?.init?.body)) as { provider?: unknown };
    expect(requestBody.provider).toBeUndefined();
    expect(recorder.artifacts[0]?.run.provider.endpointFamily).toBe("local-chat-completions");
  });

  it("records malformed local responses as failed zero-cost provider runs", async () => {
    const recorder = memoryRecorder();
    const fetchMock = vi.fn(async () => {
      return jsonResponse({
        model: "local-model",
        choices: "not-an-array",
      });
    }) as unknown as typeof fetch;
    const provider = new LocalOpenAICompatibleProvider({
      modelId: "local-model",
      baseUrl: "http://127.0.0.1:11434/v1",
      fetch: fetchMock,
      capabilities: localCapabilities(),
      live: { enabled: true, artifactRecorder: recorder, rawCapture: "disabled" },
    });

    await expect(
      provider.invoke({
        taskKind: "draft_translation",
        inputClassification: "private_corpus",
        prompt: promptFixture(),
        messages: [{ role: "user", content: "こんにちは、{player}。" }],
      }),
    ).rejects.toMatchObject({
      code: "provider_response_invalid",
      providerRun: expect.objectContaining({
        status: "failed",
        errorClasses: ["provider_response_invalid"],
        cost: { costKind: "zero", currency: "USD", amountUsd: "0", amountMicrosUsd: 0 },
      }),
    });
    expect(recorder.artifacts).toHaveLength(1);
    expect(recorder.artifacts[0]?.run.status).toBe("failed");
    expect(recorder.artifacts[0]?.error).toMatchObject({
      class: "provider_response_invalid",
    });
  });

  it("translates tool_call_arguments into a required local OpenAI-compatible tool call", async () => {
    const recorder = memoryRecorder();
    const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ input, init });
      return jsonResponse({
        model: "local-model",
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call-local-1",
                  type: "function",
                  function: {
                    name: "emit_translation",
                    arguments: '{"targetText":"Hello."}',
                  },
                },
              ],
            },
          },
        ],
      });
    }) as unknown as typeof fetch;
    const provider = new LocalOpenAICompatibleProvider({
      modelId: "local-model",
      baseUrl: "http://127.0.0.1:11434/v1",
      fetch: fetchMock,
      capabilities: localCapabilitiesWithToolCallArguments(),
      live: { enabled: true, artifactRecorder: recorder, rawCapture: "disabled" },
    });

    const result = await provider.invoke(toolCallArgumentsRequest());

    const requestBody = JSON.parse(String(fetchCalls[0]?.init?.body)) as {
      response_format?: unknown;
      tools?: Array<{ function?: { name?: string; parameters?: unknown; strict?: boolean } }>;
      tool_choice?: { function?: { name?: string } };
    };
    expect(requestBody.response_format).toBeUndefined();
    expect(requestBody.tools).toHaveLength(1);
    expect(requestBody.tools?.[0]?.function).toMatchObject({
      name: "emit_translation",
      parameters: toolCallSchema(),
      strict: true,
    });
    expect(requestBody.tool_choice).toMatchObject({
      function: { name: "emit_translation" },
    });
    expect(result.toolCalls).toEqual([
      {
        id: "call-local-1",
        name: "emit_translation",
        argumentsJson: '{"targetText":"Hello."}',
      },
    ]);
    expect(result.providerRun.structuredOutputMode).toBe("tool_call_arguments");
    expect(recorder.artifacts[0]?.request.structuredOutputMode).toBe("tool_call_arguments");
  });

  it("rejects empty synthetic tool schemas before contacting local providers", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch;
    const provider = new LocalOpenAICompatibleProvider({
      modelId: "local-model",
      baseUrl: "http://127.0.0.1:11434/v1",
      fetch: fetchMock,
      capabilities: localCapabilitiesWithToolCallArguments(),
      live: { enabled: true, artifactRecorder: memoryRecorder(), rawCapture: "disabled" },
    });

    await expect(provider.invoke(emptyToolCallArgumentsRequest())).rejects.toMatchObject({
      code: "capability_unsupported",
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects tool requirements before contacting providers that have not confirmed tool support", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch;
    const provider = new LocalOpenAICompatibleProvider({
      modelId: "local-model",
      baseUrl: "http://127.0.0.1:11434/v1",
      fetch: fetchMock,
      capabilities: localCapabilities(),
      live: { enabled: true, artifactRecorder: memoryRecorder(), rawCapture: "disabled" },
    });

    await expect(
      provider.invoke({
        taskKind: "experiment",
        inputClassification: "private_corpus",
        prompt: promptFixture(),
        messages: [{ role: "user", content: "call the tool" }],
        tools: [toolFixture()],
      }),
    ).rejects.toMatchObject({
      code: "capability_unsupported",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects fallback chains before contacting providers without fallback support", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch;
    const provider = new LocalOpenAICompatibleProvider({
      modelId: "local-model",
      baseUrl: "http://127.0.0.1:11434/v1",
      fetch: fetchMock,
      capabilities: localCapabilities(),
      live: { enabled: true, artifactRecorder: memoryRecorder(), rawCapture: "disabled" },
    });

    await expect(
      provider.invoke({
        taskKind: "experiment",
        inputClassification: "private_corpus",
        prompt: promptFixture(),
        messages: [{ role: "user", content: "try fallback" }],
        fallbackModels: ["backup-local-model"],
      }),
    ).rejects.toMatchObject({
      code: "capability_unsupported",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("FakeModelProvider", () => {
  it("rejects empty synthetic tool schemas before generation when required", async () => {
    const generate = vi.fn(() => "generated");
    const provider = new FakeModelProvider({ generate });
    const originalRequiresSchemaPerRequest =
      provider.descriptor.capabilities.toolCalls.requiresSchemaPerRequest;
    provider.descriptor.capabilities.toolCalls.requiresSchemaPerRequest = true;

    try {
      await expect(provider.invoke(emptyToolCallArgumentsRequest())).rejects.toMatchObject({
        code: "capability_unsupported",
        retryable: false,
      });
    } finally {
      provider.descriptor.capabilities.toolCalls.requiresSchemaPerRequest =
        originalRequiresSchemaPerRequest;
    }
    expect(generate).not.toHaveBeenCalled();
  });
});

const LOCALIZE_PROJECT_PROVIDER_NAME_FIXTURES = [
  { providerId: "fireworks", observedProviderName: "Fireworks" },
  { providerId: "deepinfra", observedProviderName: "DeepInfra" },
  { providerId: "wafer", observedProviderName: "Wafer" },
  { providerId: "digitalocean", observedProviderName: "DigitalOcean" },
  { providerId: "morph", observedProviderName: "Morph" },
  { providerId: "atlas-cloud", observedProviderName: "AtlasCloud" },
] as const;

/**
 * ITOTORI-227 — minimal request fixture for the wire-level provider.zdr
 * posture tests. No structured output / no tools — we only care about
 * the routing block on the request body.
 */
function zdrPostureRequest(
  modelId: string,
  providerId: string,
  inputClassification: ModelInvocationRequest["inputClassification"],
): ModelInvocationRequest {
  return {
    taskKind: "draft_translation",
    modelId,
    providerId,
    inputClassification,
    prompt: promptFixture(),
    messages: [{ role: "user", content: "translate hello" }],
  };
}

function jsonSchemaRequest(
  modelId: string = "openai/gpt-4o-mini",
  providerId: string = "OpenAI",
): ModelInvocationRequest {
  return {
    taskKind: "draft_translation",
    modelId,
    providerId,
    inputClassification: "private_corpus",
    prompt: promptFixture(),
    preset: providerPresetFixture(),
    messages: [{ role: "user", content: "translate hello" }],
    structuredOutput: {
      mode: "json_schema",
      name: "translation",
      strict: true,
      schema: {
        type: "object",
        properties: {
          targetText: { type: "string" },
        },
        required: ["targetText"],
        additionalProperties: false,
      },
    },
  };
}

function toolCallArgumentsRequest(
  modelId: string = "openai/gpt-4o-mini",
  providerId: string = "OpenAI",
): ModelInvocationRequest {
  return {
    taskKind: "draft_translation",
    modelId,
    providerId,
    inputClassification: "private_corpus",
    prompt: promptFixture(),
    messages: [{ role: "user", content: "translate hello" }],
    structuredOutput: {
      mode: "tool_call_arguments",
      toolName: "emit_translation",
      strict: true,
      schema: toolCallSchema(),
    },
  };
}

function emptyToolCallArgumentsRequest(): ModelInvocationRequest {
  return {
    ...toolCallArgumentsRequest(),
    structuredOutput: {
      mode: "tool_call_arguments",
      toolName: "emit_translation",
      strict: true,
      schema: {},
    },
  };
}

function promptFixture() {
  return {
    presetId: "test-prompt-v1",
    templateVersion: "1.0.0",
    promptHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    schemaVersion: "itotori.prompt-preset.v0",
    configSnapshot: {
      prompt: "test fixture prompt",
    },
  };
}

function providerPresetFixture() {
  return {
    slug: "openrouter/itotori-test",
    version: "2026-06-17",
    configHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    configSnapshot: {
      route: "fixture",
      models: ["openai/gpt-4o-mini"],
    },
  };
}

function toolCallSchema() {
  return {
    type: "object",
    properties: {
      targetText: { type: "string" },
    },
    required: ["targetText"],
    additionalProperties: false,
  };
}

function toolFixture(): ModelTool {
  return {
    name: "lookup_term",
    description: "Looks up glossary terms.",
    parameters: {
      type: "object",
      properties: {
        term: { type: "string" },
      },
      required: ["term"],
      additionalProperties: false,
    },
  };
}

function openRouterCapabilitiesForPrivateInputs(): ModelCapabilities {
  // ITOTORI-227 — capability sheets no longer carry per-pair privacy
  // axes. Privacy is enforced account-wide (ZDR assertion) plus
  // per-request (provider.zdr=true default for non-public input).
  return {
    ...openRouterDefaultCapabilities,
    structuredOutputs: {
      ...openRouterDefaultCapabilities.structuredOutputs,
      jsonSchema: "supported",
    },
  };
}

function openRouterCapabilitiesWithToolCallArguments(): ModelCapabilities {
  const capabilities = openRouterCapabilitiesForPrivateInputs();
  return {
    ...capabilities,
    structuredOutputs: {
      ...capabilities.structuredOutputs,
      toolCallArguments: "supported",
    },
    toolCalls: {
      ...capabilities.toolCalls,
      support: "supported",
    },
  };
}

function localCapabilities(): ModelCapabilities {
  return {
    ...openRouterCapabilitiesForPrivateInputs(),
    routing: {
      providerRouting: "unsupported",
      modelFallbacks: "unsupported",
      presets: "unsupported",
      requireParameters: "untested",
      dataCollectionControl: "unsupported",
      zeroDataRetentionRouting: "unsupported",
    },
  };
}

function localCapabilitiesWithToolCallArguments(): ModelCapabilities {
  const capabilities = localCapabilities();
  return {
    ...capabilities,
    structuredOutputs: {
      ...capabilities.structuredOutputs,
      toolCallArguments: "supported",
    },
    toolCalls: {
      ...capabilities.toolCalls,
      support: "supported",
    },
  };
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

expect.addSnapshotSerializer({
  test: (value) => value instanceof ModelProviderError,
  serialize: (value) => String((value as ModelProviderError).message),
});
