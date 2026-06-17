import { createHash } from "node:crypto";
import { assertProviderInputAllowed } from "./policy.js";
import { assertStructuredOutputModeSupported } from "./structured-output.js";
import {
  type JsonObject,
  type JsonValue,
  type ModelCapabilities,
  type ModelInvocationRequest,
  type ModelInvocationResult,
  type ModelMessage,
  type ModelProvider,
  ModelProviderError,
  type ModelTool,
  type ModelToolCall,
  type ModelToolChoice,
  type ProviderDataHandlingPolicy,
  type ProviderDescriptor,
  type ProviderInputClassification,
  type ProviderLiveRunOptions,
  type ProviderRunArtifact,
  type ProviderRunRecord,
  type TokenUsage,
  createProviderRunId,
} from "./types.js";

export type OpenRouterProviderRouting = {
  order?: string[];
  only?: string[];
  ignore?: string[];
  quantizations?: string[];
  sort?: "price" | "throughput" | "latency";
  allowFallbacks?: boolean;
  requireParameters?: boolean;
  dataCollection?: "allow" | "deny";
  zdr?: boolean;
  enforceDistillableText?: boolean;
  maxPrice?: JsonObject;
};

export type OpenRouterProviderOptions = {
  modelId: string;
  providerName?: string;
  baseUrl?: string;
  apiKey?: string | (() => string | undefined);
  fetch?: typeof fetch;
  capabilities?: ModelCapabilities;
  routing?: OpenRouterProviderRouting;
  live: ProviderLiveRunOptions;
};

export class OpenRouterProvider implements ModelProvider {
  readonly descriptor: ProviderDescriptor;
  private readonly baseUrl: string;
  private readonly apiKey: string | (() => string | undefined) | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly routing: OpenRouterProviderRouting;
  private readonly live: ProviderLiveRunOptions;

  constructor(options: OpenRouterProviderOptions) {
    this.baseUrl = options.baseUrl ?? "https://openrouter.ai/api/v1";
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.routing = options.routing ?? {};
    this.live = options.live;
    this.descriptor = {
      family: "openrouter",
      endpointFamily: "chat-completions",
      providerName: options.providerName ?? "openrouter",
      defaultModelId: options.modelId,
      capabilities: options.capabilities ?? openRouterDefaultCapabilities,
    };
  }

  async invoke(request: ModelInvocationRequest): Promise<ModelInvocationResult> {
    if (!this.live.enabled) {
      throw new ModelProviderError(
        "OpenRouter invocation requires explicit live opt-in and a provider-run artifact recorder",
        "configuration_error",
        false,
      );
    }
    const startedAt = new Date();
    const requestedModelId = request.modelId ?? this.descriptor.defaultModelId;
    const providerRouting = buildOpenRouterProviderRouting(this.routing, request);
    const effectiveDataHandling = openRouterDataHandlingForRouting(
      this.descriptor.capabilities.dataHandling,
      providerRouting,
    );
    assertProviderInputAllowed(
      {
        ...this.descriptor.capabilities,
        dataHandling: effectiveDataHandling,
      },
      request.inputClassification,
    );
    if (request.structuredOutput) {
      assertStructuredOutputModeSupported(
        this.descriptor.capabilities,
        request.structuredOutput.mode,
      );
    }
    assertToolCallArgumentsCanBeForced(request);

    const apiKey = this.resolveApiKey();
    if (!apiKey) {
      throw new ModelProviderError(
        "OpenRouter API key is required for live invocation; pass it through runtime config or an already-exported environment variable",
        "configuration_error",
        false,
      );
    }

    const requestBody = buildOpenRouterRequestBody(request, requestedModelId, providerRouting);
    const routeSettingsHash = hashJson(providerRouting);
    let response: Response;
    try {
      response = await this.fetchImpl(`${stripTrailingSlash(this.baseUrl)}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "X-OpenRouter-Metadata": "enabled",
        },
        body: JSON.stringify(requestBody),
      });
    } catch (error) {
      const metadata = adapterMetadata({}, providerRouting);
      const run = buildProviderRunRecord({
        descriptor: this.descriptor,
        request,
        requestedModelId,
        startedAt,
        status: "failed",
        actualModelId: requestedModelId,
        upstreamProvider: undefined,
        routeSettingsHash,
        errorClasses: ["provider_network_error"],
        tokenUsage: { tokenCountSource: "unknown" },
        dataHandling: effectiveDataHandling,
      });
      await this.live.artifactRecorder.recordProviderRun(
        buildArtifact({
          request,
          run,
          rawCapture: this.live.rawCapture,
          error: {
            class: "provider_http_error",
            message: providerExceptionMessage(error),
          },
          adapterMetadata: metadata,
        }),
      );
      throw new ModelProviderError(
        `OpenRouter request failed before response: ${providerExceptionMessage(error)}`,
        "provider_http_error",
        true,
        run,
        metadata,
      );
    }

    const body = await safeJson(response);
    if (!response.ok) {
      const metadata = adapterMetadata(body, providerRouting);
      const run = buildProviderRunRecord({
        descriptor: this.descriptor,
        request,
        requestedModelId,
        startedAt,
        status: "failed",
        actualModelId: requestedModelId,
        upstreamProvider: selectedOpenRouterProvider(body),
        routeSettingsHash,
        errorClasses: [`http_${response.status}`],
        tokenUsage: { tokenCountSource: "unknown" },
        dataHandling: effectiveDataHandling,
      });
      await this.live.artifactRecorder.recordProviderRun(
        buildArtifact({
          request,
          run,
          rawCapture: this.live.rawCapture,
          error: {
            class: "provider_http_error",
            message: providerErrorMessage(body, response.status),
          },
          adapterMetadata: metadata,
        }),
      );
      throw new ModelProviderError(
        `OpenRouter request failed with HTTP ${response.status}`,
        "provider_http_error",
        response.status >= 500 || response.status === 429,
        run,
        metadata,
      );
    }

    let normalized: ReturnType<typeof normalizeOpenRouterResponse>;
    try {
      normalized = normalizeOpenRouterResponse(body, requestedModelId);
    } catch (error) {
      const metadata = adapterMetadata(body, providerRouting);
      const run = buildProviderRunRecord({
        descriptor: this.descriptor,
        request,
        requestedModelId,
        startedAt,
        status: "failed",
        actualModelId: selectedOpenRouterModel(body) ?? requestedModelId,
        upstreamProvider: selectedOpenRouterProvider(body),
        routeSettingsHash,
        errorClasses: ["provider_response_invalid"],
        tokenUsage: isRecord(body) ? normalizeUsage(body.usage) : { tokenCountSource: "unknown" },
        dataHandling: effectiveDataHandling,
      });
      await this.live.artifactRecorder.recordProviderRun(
        buildArtifact({
          request,
          run,
          rawCapture: this.live.rawCapture,
          error: {
            class: "provider_response_invalid",
            message: providerExceptionMessage(error),
          },
          adapterMetadata: metadata,
        }),
      );
      throw new ModelProviderError(
        `OpenRouter response was invalid: ${providerExceptionMessage(error)}`,
        "provider_response_invalid",
        false,
        run,
        metadata,
      );
    }
    const run = buildProviderRunRecord({
      descriptor: this.descriptor,
      request,
      requestedModelId,
      startedAt,
      status: "succeeded",
      actualModelId: normalized.actualModelId,
      upstreamProvider: normalized.upstreamProvider,
      routeSettingsHash,
      errorClasses: [],
      tokenUsage: normalized.tokenUsage,
      dataHandling: effectiveDataHandling,
    });
    const metadata = adapterMetadata(body, providerRouting);
    await this.live.artifactRecorder.recordProviderRun(
      buildArtifact({
        request,
        run,
        rawCapture: this.live.rawCapture,
        response: {
          finishReason: normalized.finishReason,
          contentLength: normalized.content?.length ?? 0,
          toolCallCount: normalized.toolCalls.length,
        },
        adapterMetadata: metadata,
      }),
    );
    return {
      content: normalized.content,
      toolCalls: normalized.toolCalls,
      finishReason: normalized.finishReason,
      providerRun: run,
      adapterMetadata: metadata,
    };
  }

  private resolveApiKey(): string | undefined {
    if (typeof this.apiKey === "function") {
      return this.apiKey();
    }
    return this.apiKey;
  }
}

export function openRouterApiKeyFromEnv(
  env: Record<string, string | undefined>,
): string | undefined {
  return env.OPENROUTER_API_KEY;
}

export const openRouterDefaultCapabilities: ModelCapabilities = {
  structuredOutputs: {
    jsonSchema: "untested",
    jsonObject: "untested",
    toolCallArguments: "untested",
    plainJsonExtraction: "supported",
    preferredModes: ["json_schema", "json_object", "tool_call_arguments", "plain_json"],
  },
  toolCalls: {
    support: "untested",
    parallelToolCalls: "untested",
    requiresSchemaPerRequest: true,
  },
  imageInput: {
    support: "untested",
  },
  routing: {
    providerRouting: "supported",
    modelFallbacks: "supported",
    presets: "supported",
    requireParameters: "supported",
    dataCollectionControl: "supported",
    zeroDataRetentionRouting: "supported",
  },
  dataHandling: {
    costTier: "unknown",
    promptLogging: "unknown",
    completionLogging: "unknown",
    retention: "unknown",
    trainingUse: "unknown",
    dataCollection: "deny",
    rawCaptureDefault: "disabled",
  },
  accountPrivacy: {
    inputOutputLogging: "unknown",
    useOfInputsOutputs: "unknown",
    providerDataPolicyFilters: "unknown",
    metadataCollection: "expected",
    euRouting: "unknown",
  },
  notes: ["OpenRouter defaults require model/provider capability confirmation before private use"],
};

function buildOpenRouterRequestBody(
  request: ModelInvocationRequest,
  requestedModelId: string,
  providerRouting: JsonObject,
): JsonObject {
  const body: Record<string, JsonValue> = {
    messages: request.messages.map(toOpenAiMessage) as JsonValue,
    stream: false,
    provider: providerRouting,
  };
  const fallbackPlan = fallbackPlanForRequest(request, requestedModelId);
  if (fallbackPlan.length > 1) {
    body.models = fallbackPlan;
  } else {
    body.model = requestedModelId;
  }
  if (request.generation?.temperature !== undefined) {
    body.temperature = request.generation.temperature;
  }
  if (request.generation?.maxOutputTokens !== undefined) {
    body.max_completion_tokens = request.generation.maxOutputTokens;
  }
  if (request.generation?.topP !== undefined) {
    body.top_p = request.generation.topP;
  }
  if (request.generation?.stop !== undefined) {
    body.stop = request.generation.stop;
  }
  if (request.structuredOutput?.mode === "json_schema") {
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: request.structuredOutput.name,
        strict: request.structuredOutput.strict,
        schema: request.structuredOutput.schema,
      },
    };
  }
  if (request.structuredOutput?.mode === "json_object") {
    body.response_format = { type: "json_object" };
  }
  const tools = toolsForRequest(request);
  if (tools.length > 0) {
    body.tools = tools;
  }
  if (request.structuredOutput?.mode === "tool_call_arguments") {
    body.tool_choice = forcedToolChoice(request.structuredOutput.toolName);
  } else if (request.toolChoice) {
    body.tool_choice =
      typeof request.toolChoice === "string"
        ? request.toolChoice
        : { type: "function", function: { name: request.toolChoice.functionName } };
  }
  return body as JsonObject;
}

function buildOpenRouterProviderRouting(
  routing: OpenRouterProviderRouting,
  request: ModelInvocationRequest,
): JsonObject {
  const provider: Record<string, JsonValue> = {
    data_collection: dataCollectionForRequest(routing.dataCollection, request.inputClassification),
  };
  const strictParametersRequired =
    request.structuredOutput?.mode === "json_schema" ||
    request.structuredOutput?.mode === "tool_call_arguments" ||
    Boolean(request.tools?.length);
  if (strictParametersRequired) {
    provider.require_parameters = true;
  } else if (routing.requireParameters !== undefined) {
    provider.require_parameters = routing.requireParameters;
  }
  if (routing.order) {
    provider.order = routing.order;
  }
  if (routing.only) {
    provider.only = routing.only;
  }
  if (routing.ignore) {
    provider.ignore = routing.ignore;
  }
  if (routing.quantizations) {
    provider.quantizations = routing.quantizations;
  }
  if (routing.sort) {
    provider.sort = routing.sort;
  }
  if (routing.allowFallbacks !== undefined) {
    provider.allow_fallbacks = routing.allowFallbacks;
  }
  if (routing.zdr !== undefined) {
    provider.zdr = routing.zdr;
  }
  if (routing.enforceDistillableText !== undefined) {
    provider.enforce_distillable_text = routing.enforceDistillableText;
  }
  if (routing.maxPrice !== undefined) {
    provider.max_price = routing.maxPrice;
  }
  return provider as JsonObject;
}

function dataCollectionForRequest(
  requested: OpenRouterProviderRouting["dataCollection"],
  inputClassification: ProviderInputClassification,
): "allow" | "deny" {
  if (isPrivateInput(inputClassification)) {
    return "deny";
  }
  return requested ?? "deny";
}

function isPrivateInput(inputClassification: ProviderInputClassification): boolean {
  return inputClassification !== "synthetic_public" && inputClassification !== "public";
}

function openRouterDataHandlingForRouting(
  basePolicy: ProviderDataHandlingPolicy,
  providerRouting: JsonObject,
): ProviderDataHandlingPolicy {
  return {
    ...basePolicy,
    dataCollection: providerRouting.data_collection === "allow" ? "allow" : "deny",
  };
}

function toOpenAiMessage(message: ModelMessage): JsonObject {
  const mapped: Record<string, JsonValue> = { role: message.role };
  if (typeof message.content === "string" || message.content === null) {
    mapped.content = message.content;
  } else {
    mapped.content = message.content.map((part) => {
      if (part.type === "text") {
        return { type: "text", text: part.text };
      }
      const imageUrl: Record<string, JsonValue> = { url: part.imageUrl };
      if (part.detail) {
        imageUrl.detail = part.detail;
      }
      return { type: "image_url", image_url: imageUrl };
    });
  }
  if (message.name) {
    mapped.name = message.name;
  }
  if (message.toolCallId) {
    mapped.tool_call_id = message.toolCallId;
  }
  if (message.toolCalls) {
    mapped.tool_calls = message.toolCalls.map((toolCall) => ({
      id: toolCall.id,
      type: "function",
      function: {
        name: toolCall.name,
        arguments: toolCall.argumentsJson,
      },
    }));
  }
  return mapped as JsonObject;
}

function toOpenAiTool(tool: ModelTool): JsonObject {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function toolsForRequest(request: ModelInvocationRequest): JsonValue[] {
  const tools = request.tools?.map(toOpenAiTool) ?? [];
  if (request.structuredOutput?.mode === "tool_call_arguments") {
    tools.push({
      type: "function",
      function: {
        name: request.structuredOutput.toolName,
        description: "Return the requested structured output as function arguments.",
        parameters: request.structuredOutput.schema,
        strict: request.structuredOutput.strict,
      },
    });
  }
  return tools;
}

function forcedToolChoice(toolName: string): JsonObject {
  return { type: "function", function: { name: toolName } };
}

function assertToolCallArgumentsCanBeForced(request: ModelInvocationRequest): void {
  if (request.structuredOutput?.mode !== "tool_call_arguments") {
    return;
  }
  const toolName = request.structuredOutput.toolName;
  if (request.tools?.some((tool) => tool.name === toolName)) {
    throw new ModelProviderError(
      `structured output tool ${toolName} conflicts with request tools`,
      "configuration_error",
      false,
    );
  }
  if (!toolChoiceMatchesForcedTool(request.toolChoice, toolName)) {
    throw new ModelProviderError(
      `structured output mode tool_call_arguments requires forced tool choice ${toolName}`,
      "configuration_error",
      false,
    );
  }
}

function toolChoiceMatchesForcedTool(
  toolChoice: ModelToolChoice | undefined,
  toolName: string,
): boolean {
  return (
    toolChoice === undefined ||
    (typeof toolChoice === "object" && toolChoice.functionName === toolName)
  );
}

function normalizeOpenRouterResponse(
  body: unknown,
  requestedModelId: string,
): {
  content: string | null;
  toolCalls: ModelToolCall[];
  finishReason: string;
  actualModelId: string;
  upstreamProvider: string | undefined;
  tokenUsage: TokenUsage;
} {
  const record = asRecord(body, "OpenRouter response");
  const choices = asArray(record.choices, "OpenRouter response choices");
  const firstChoice = asRecord(choices[0], "OpenRouter first choice");
  const message = asRecord(firstChoice.message, "OpenRouter first choice message");
  const content = message.content === null ? null : (optionalString(message.content) ?? "");
  const finishReason = optionalString(firstChoice.finish_reason) ?? "unknown";
  return {
    content,
    toolCalls: normalizeToolCalls(message.tool_calls),
    finishReason,
    actualModelId:
      optionalString(record.model) ?? selectedOpenRouterModel(body) ?? requestedModelId,
    upstreamProvider: selectedOpenRouterProvider(body),
    tokenUsage: normalizeUsage(record.usage),
  };
}

function normalizeToolCalls(value: unknown): ModelToolCall[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((toolCall, index) => {
    const record = asRecord(toolCall, `tool call ${index}`);
    const fn = asRecord(record.function, `tool call ${index} function`);
    return {
      id: optionalString(record.id) ?? `tool-${index}`,
      name: requiredString(fn.name, `tool call ${index} function name`),
      argumentsJson: requiredString(fn.arguments, `tool call ${index} function arguments`),
    };
  });
}

function normalizeUsage(value: unknown): TokenUsage {
  if (!isRecord(value)) {
    return { tokenCountSource: "unknown" };
  }
  const usage: TokenUsage = { tokenCountSource: "provider_reported" };
  assignNumber(usage, "promptTokens", value.prompt_tokens);
  assignNumber(usage, "completionTokens", value.completion_tokens);
  assignNumber(usage, "reasoningTokens", value.reasoning_tokens);
  assignNumber(usage, "cachedInputTokens", value.cached_tokens);
  assignNumber(usage, "totalTokens", value.total_tokens);
  return usage;
}

function buildProviderRunRecord(input: {
  descriptor: ProviderDescriptor;
  request: ModelInvocationRequest;
  requestedModelId: string;
  startedAt: Date;
  status: ProviderRunRecord["status"];
  actualModelId: string;
  upstreamProvider: string | undefined;
  routeSettingsHash: string;
  errorClasses: string[];
  tokenUsage: TokenUsage;
  dataHandling: ProviderDataHandlingPolicy;
}): ProviderRunRecord {
  const completedAt = new Date();
  const fallbackPlan = fallbackPlanForRequest(input.request, input.requestedModelId);
  const provider: ProviderRunRecord["provider"] = {
    providerFamily: input.descriptor.family,
    endpointFamily: input.descriptor.endpointFamily,
    providerName: input.descriptor.providerName,
    requestedModelId: input.requestedModelId,
    actualModelId: input.actualModelId,
    routeSettingsHash: input.routeSettingsHash,
  };
  if (input.upstreamProvider) {
    provider.upstreamProvider = input.upstreamProvider;
  }
  const run: ProviderRunRecord = {
    runId: input.request.runId ?? createProviderRunId("openrouter"),
    taskKind: input.request.taskKind,
    startedAt: input.startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    latencyMs: completedAt.getTime() - input.startedAt.getTime(),
    status: input.status,
    provider,
    structuredOutputMode: input.request.structuredOutput?.mode ?? "none",
    retryCount: 0,
    errorClasses: input.errorClasses,
    fallbackUsed: fallbackPlan.length > 1 && input.actualModelId !== input.requestedModelId,
    fallbackPlan,
    tokenUsage: input.tokenUsage,
    cost: {
      costKind: "unknown",
      currency: "USD",
    },
    prompt: input.request.prompt,
    dataHandling: input.dataHandling,
  };
  if (input.request.preset) {
    run.providerPreset = input.request.preset;
  }
  if (input.descriptor.capabilities.accountPrivacy) {
    run.accountPrivacy = input.descriptor.capabilities.accountPrivacy;
  }
  return run;
}

function buildArtifact(input: {
  request: ModelInvocationRequest;
  run: ProviderRunRecord;
  rawCapture: "enabled" | "disabled" | "unknown" | "not_applicable";
  response?: ProviderRunArtifact["response"];
  error?: ProviderRunArtifact["error"];
  adapterMetadata?: JsonObject;
}): ProviderRunArtifact {
  const rawTextCaptured = input.request.recordRawText === true && input.rawCapture === "enabled";
  const artifact: ProviderRunArtifact = {
    schemaVersion: "itotori.provider-run.v0",
    run: input.run,
    request: {
      messageCount: input.request.messages.length,
      inputClassification: input.request.inputClassification,
      requestedModelId: input.run.provider.requestedModelId,
      structuredOutputMode: input.run.structuredOutputMode,
      toolCount: input.request.tools?.length ?? 0,
      rawTextCaptured,
      prompt: input.run.prompt,
    },
  };
  if (input.run.providerPreset) {
    artifact.request.providerPreset = input.run.providerPreset;
  }
  if (input.response) {
    artifact.response = input.response;
  }
  if (input.error) {
    artifact.error = input.error;
  }
  if (input.adapterMetadata) {
    artifact.adapterMetadata = input.adapterMetadata;
  }
  return artifact;
}

function adapterMetadata(body: unknown, providerRouting: JsonObject): JsonObject {
  const metadata: Record<string, JsonValue> = {
    providerRouting,
  };
  if (isRecord(body) && isJsonValue(body.openrouter_metadata)) {
    metadata.openrouterMetadata = body.openrouter_metadata;
  }
  return metadata as JsonObject;
}

function fallbackPlanForRequest(
  request: ModelInvocationRequest,
  requestedModelId: string,
): string[] {
  return Array.from(new Set([requestedModelId, ...(request.fallbackModels ?? [])]));
}

function selectedOpenRouterProvider(body: unknown): string | undefined {
  const selected = selectedOpenRouterEndpoint(body);
  return optionalString(selected?.provider);
}

function selectedOpenRouterModel(body: unknown): string | undefined {
  const selected = selectedOpenRouterEndpoint(body);
  return optionalString(selected?.model);
}

function selectedOpenRouterEndpoint(body: unknown): Record<string, unknown> | undefined {
  if (!isRecord(body) || !isRecord(body.openrouter_metadata)) {
    return undefined;
  }
  const endpoints = body.openrouter_metadata.endpoints;
  if (!isRecord(endpoints) || !Array.isArray(endpoints.available)) {
    return undefined;
  }
  return endpoints.available.find(
    (endpoint) => isRecord(endpoint) && endpoint.selected === true,
  ) as Record<string, unknown> | undefined;
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function providerErrorMessage(body: unknown, status: number): string {
  if (isRecord(body) && isRecord(body.error) && typeof body.error.message === "string") {
    return body.error.message;
  }
  return `HTTP ${status}`;
}

function providerExceptionMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function hashJson(value: JsonObject): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ModelProviderError(`${label} must be an array`, "provider_response_invalid", false);
  }
  return value;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ModelProviderError(`${label} must be an object`, "provider_response_invalid", false);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  const result = optionalString(value);
  if (result === undefined) {
    throw new ModelProviderError(`${label} must be a string`, "provider_response_invalid", false);
  }
  return result;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function assignNumber<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: unknown,
): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    target[key] = value as T[K];
  }
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (isRecord(value)) {
    return Object.values(value).every(isJsonValue);
  }
  return false;
}
