import { describe, expect, it, vi } from "vitest";
import {
  LocalOpenAICompatibleProvider,
  ModelProviderError,
  OpenRouterProvider,
  evaluateProviderInputPolicy,
  openRouterDefaultCapabilities,
  selectStructuredOutputMode,
  type ModelCapabilities,
  type ModelInvocationRequest,
  type ProviderRunArtifact,
  type ProviderRunArtifactRecorder,
} from "../src/providers/index.js";

describe("provider policy and capabilities", () => {
  it("blocks private inputs when provider logging policy is unknown", () => {
    const decision = evaluateProviderInputPolicy(
      openRouterDefaultCapabilities.dataHandling,
      "private_corpus",
      openRouterDefaultCapabilities.accountPrivacy,
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain("cost tier is unknown");
    expect(decision.reasons).toContain("account input/output logging is unknown");
  });

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

describe("OpenRouterProvider", () => {
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
    expect(recorder.artifacts[0]?.adapterMetadata).toHaveProperty("openrouterMetadata");
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

  it("blocks private inputs when OpenRouter account privacy state is unknown", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch;
    const provider = new OpenRouterProvider({
      modelId: "openai/gpt-4o-mini",
      apiKey: "test-key",
      fetch: fetchMock,
      live: { enabled: true, artifactRecorder: memoryRecorder(), rawCapture: "disabled" },
    });

    await expect(provider.invoke(jsonSchemaRequest())).rejects.toMatchObject({
      code: "policy_blocked",
    });
    expect(fetchMock).not.toHaveBeenCalled();
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
      messages: [{ role: "user", content: "こんにちは、{player}。" }],
    });

    expect(result.content).toBe("Hello, {player}.");
    expect(result.providerRun.provider.providerFamily).toBe("local-openai-compatible");
    expect(result.providerRun.cost).toMatchObject({
      costKind: "local_estimate",
      amountMicrosUsd: 0,
    });
    const requestBody = JSON.parse(String(fetchCalls[0]?.init?.body)) as { provider?: unknown };
    expect(requestBody.provider).toBeUndefined();
    expect(recorder.artifacts[0]?.run.provider.endpointFamily).toBe("local-chat-completions");
  });
});

function jsonSchemaRequest(): ModelInvocationRequest {
  return {
    taskKind: "draft_translation",
    inputClassification: "private_corpus",
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

function openRouterCapabilitiesForPrivateInputs(): ModelCapabilities {
  return {
    ...openRouterDefaultCapabilities,
    structuredOutputs: {
      ...openRouterDefaultCapabilities.structuredOutputs,
      jsonSchema: "supported",
    },
    dataHandling: {
      costTier: "paid",
      promptLogging: "disabled",
      completionLogging: "disabled",
      retention: "metadata_only",
      trainingUse: "deny",
      dataCollection: "deny",
      rawCaptureDefault: "disabled",
    },
    accountPrivacy: {
      inputOutputLogging: "disabled",
      useOfInputsOutputs: "deny",
      providerDataPolicyFilters: "enabled",
      metadataCollection: "expected",
      euRouting: "unknown",
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
    dataHandling: {
      costTier: "local",
      promptLogging: "not_applicable",
      completionLogging: "not_applicable",
      retention: "not_applicable",
      trainingUse: "not_applicable",
      dataCollection: "not_applicable",
      rawCaptureDefault: "disabled",
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
