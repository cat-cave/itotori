import { assertProviderInvocationSupported } from "./capability-guard.js";
import { safeLocalDataHandlingPolicy } from "./policy.js";
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
  type ProviderDescriptor,
  type ProviderLiveRunOptions,
  type ProviderRunArtifact,
  type ProviderRunRecord,
  type TokenUsage,
  createProviderRunId,
} from "./types.js";

export type LocalOpenAICompatibleProviderOptions = {
  modelId: string;
  baseUrl: string;
  providerName?: string;
  apiKey?: string | (() => string | undefined);
  fetch?: typeof fetch;
  capabilities?: ModelCapabilities;
  live: ProviderLiveRunOptions;
};

export class LocalOpenAICompatibleProvider implements ModelProvider {
  readonly descriptor: ProviderDescriptor;
  private readonly baseUrl: string;
  private readonly apiKey: string | (() => string | undefined) | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly live: ProviderLiveRunOptions;

  constructor(options: LocalOpenAICompatibleProviderOptions) {
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.live = options.live;
    this.descriptor = {
      family: "local-openai-compatible",
      endpointFamily: "local-chat-completions",
      providerName: options.providerName ?? "local-openai-compatible",
      defaultModelId: options.modelId,
      capabilities: options.capabilities ?? localOpenAICompatibleDefaultCapabilities,
    };
  }

  async invoke(request: ModelInvocationRequest): Promise<ModelInvocationResult> {
    if (!this.live.enabled) {
      throw new ModelProviderError(
        "local OpenAI-compatible invocation requires explicit opt-in and a provider-run artifact recorder",
        "configuration_error",
        false,
      );
    }

    const requestedModelId = request.modelId ?? this.descriptor.defaultModelId;
    assertProviderInvocationSupported({ descriptor: this.descriptor, request, requestedModelId });
    const startedAt = new Date();
    let response: Response;
    try {
      response = await this.fetchImpl(`${stripTrailingSlash(this.baseUrl)}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(buildRequestBody(request, requestedModelId)),
      });
    } catch (error) {
      const run = buildRun({
        descriptor: this.descriptor,
        request,
        requestedModelId,
        actualModelId: requestedModelId,
        startedAt,
        status: "failed",
        errorClasses: ["provider_network_error"],
        tokenUsage: { tokenCountSource: "unknown" },
      });
      await this.live.artifactRecorder.recordProviderRun(
        buildArtifact({
          request,
          run,
          error: {
            class: "provider_http_error",
            message: providerExceptionMessage(error),
          },
        }),
      );
      throw new ModelProviderError(
        `local OpenAI-compatible request failed before response: ${providerExceptionMessage(error)}`,
        "provider_http_error",
        true,
        run,
      );
    }
    const body = await safeJson(response);
    if (!response.ok) {
      const run = buildRun({
        descriptor: this.descriptor,
        request,
        requestedModelId,
        actualModelId: requestedModelId,
        startedAt,
        status: "failed",
        errorClasses: [`http_${response.status}`],
        tokenUsage: { tokenCountSource: "unknown" },
      });
      await this.live.artifactRecorder.recordProviderRun(
        buildArtifact({
          request,
          run,
          error: {
            class: "provider_http_error",
            message: providerErrorMessage(body, response.status),
          },
        }),
      );
      throw new ModelProviderError(
        `local OpenAI-compatible request failed with HTTP ${response.status}`,
        "provider_http_error",
        response.status >= 500 || response.status === 429,
        run,
      );
    }

    let normalized: ReturnType<typeof normalizeResponse>;
    try {
      normalized = normalizeResponse(body, requestedModelId);
    } catch (error) {
      const run = buildRun({
        descriptor: this.descriptor,
        request,
        requestedModelId,
        actualModelId:
          isRecord(body) && typeof body.model === "string" ? body.model : requestedModelId,
        startedAt,
        status: "failed",
        errorClasses: ["provider_response_invalid"],
        tokenUsage: isRecord(body) ? normalizeUsage(body.usage) : { tokenCountSource: "unknown" },
      });
      await this.live.artifactRecorder.recordProviderRun(
        buildArtifact({
          request,
          run,
          error: {
            class: "provider_response_invalid",
            message: providerExceptionMessage(error),
          },
        }),
      );
      throw new ModelProviderError(
        `local OpenAI-compatible response was invalid: ${providerExceptionMessage(error)}`,
        "provider_response_invalid",
        false,
        run,
      );
    }
    const run = buildRun({
      descriptor: this.descriptor,
      request,
      requestedModelId,
      actualModelId: normalized.actualModelId,
      startedAt,
      status: "succeeded",
      errorClasses: [],
      tokenUsage: normalized.tokenUsage,
    });
    await this.live.artifactRecorder.recordProviderRun(
      buildArtifact({
        request,
        run,
        response: {
          finishReason: normalized.finishReason,
          contentLength: normalized.content?.length ?? 0,
          toolCallCount: normalized.toolCalls.length,
        },
      }),
    );
    return {
      content: normalized.content,
      toolCalls: normalized.toolCalls,
      finishReason: normalized.finishReason,
      providerRun: run,
    };
  }

  private headers(): HeadersInit {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const apiKey = this.resolveApiKey();
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    return headers;
  }

  private resolveApiKey(): string | undefined {
    if (typeof this.apiKey === "function") {
      return this.apiKey();
    }
    return this.apiKey;
  }
}

export const localOpenAICompatibleDefaultCapabilities: ModelCapabilities = {
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
    providerRouting: "unsupported",
    modelFallbacks: "unsupported",
    presets: "unsupported",
    requireParameters: "untested",
    dataCollectionControl: "unsupported",
    zeroDataRetentionRouting: "unsupported",
  },
  dataHandling: safeLocalDataHandlingPolicy,
  notes: ["local OpenAI-compatible endpoint capabilities must be supplied per runtime"],
};

function buildRequestBody(request: ModelInvocationRequest, requestedModelId: string): JsonObject {
  const body: Record<string, JsonValue> = {
    model: requestedModelId,
    messages: request.messages.map(toOpenAiMessage) as JsonValue,
    stream: false,
  };
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

function normalizeResponse(
  body: unknown,
  requestedModelId: string,
): {
  content: string | null;
  toolCalls: ModelToolCall[];
  finishReason: string;
  actualModelId: string;
  tokenUsage: TokenUsage;
} {
  const record = asRecord(body, "local model response");
  const choices = asArray(record.choices, "local model response choices");
  const firstChoice = asRecord(choices[0], "local model first choice");
  const message = asRecord(firstChoice.message, "local model first choice message");
  return {
    content: message.content === null ? null : (optionalString(message.content) ?? ""),
    toolCalls: normalizeToolCalls(message.tool_calls),
    finishReason: optionalString(firstChoice.finish_reason) ?? "unknown",
    actualModelId: optionalString(record.model) ?? requestedModelId,
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

function buildRun(input: {
  descriptor: ProviderDescriptor;
  request: ModelInvocationRequest;
  requestedModelId: string;
  actualModelId: string;
  startedAt: Date;
  status: ProviderRunRecord["status"];
  errorClasses: string[];
  tokenUsage: TokenUsage;
}): ProviderRunRecord {
  const completedAt = new Date();
  const run: ProviderRunRecord = {
    runId: input.request.runId ?? createProviderRunId("local"),
    taskKind: input.request.taskKind,
    startedAt: input.startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    latencyMs: completedAt.getTime() - input.startedAt.getTime(),
    status: input.status,
    provider: {
      providerFamily: input.descriptor.family,
      endpointFamily: input.descriptor.endpointFamily,
      providerName: input.descriptor.providerName,
      requestedModelId: input.requestedModelId,
      actualModelId: input.actualModelId,
    },
    structuredOutputMode: input.request.structuredOutput?.mode ?? "none",
    retryCount: 0,
    errorClasses: input.errorClasses,
    fallbackUsed: false,
    fallbackPlan: [input.requestedModelId],
    tokenUsage: input.tokenUsage,
    cost:
      input.status === "failed"
        ? {
            costKind: "unknown",
            currency: "USD",
          }
        : {
            costKind: "local_estimate",
            currency: "USD",
            amountMicrosUsd: 0,
          },
    prompt: input.request.prompt,
    dataHandling: input.descriptor.capabilities.dataHandling,
  };
  if (input.request.preset) {
    run.providerPreset = input.request.preset;
  }
  return run;
}

function buildArtifact(input: {
  request: ModelInvocationRequest;
  run: ProviderRunRecord;
  response?: ProviderRunArtifact["response"];
  error?: ProviderRunArtifact["error"];
}): ProviderRunArtifact {
  const artifact: ProviderRunArtifact = {
    schemaVersion: "itotori.provider-run.v0",
    run: input.run,
    request: {
      messageCount: input.request.messages.length,
      inputClassification: input.request.inputClassification,
      requestedModelId: input.run.provider.requestedModelId,
      structuredOutputMode: input.run.structuredOutputMode,
      toolCount: input.request.tools?.length ?? 0,
      rawTextCaptured: false,
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
  return artifact;
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
