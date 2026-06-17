import { deterministicFixtureDataHandlingPolicy } from "./policy.js";
import type {
  ModelCapabilities,
  ModelInvocationRequest,
  ModelInvocationResult,
  ModelProvider,
  ProviderDescriptor,
  ProviderRunRecord,
} from "./types.js";

export type FakeModelProviderOptions = {
  providerName?: string;
  modelId?: string;
  generate?: (request: ModelInvocationRequest) => string;
};

export class FakeModelProvider implements ModelProvider {
  readonly descriptor: ProviderDescriptor;
  private readonly generate: (request: ModelInvocationRequest) => string;

  constructor(options: FakeModelProviderOptions = {}) {
    const modelId = options.modelId ?? "itotori-fake-draft-v0";
    this.descriptor = {
      family: "fake",
      endpointFamily: "chat-completions",
      providerName: options.providerName ?? "itotori-fixture",
      defaultModelId: modelId,
      capabilities: fakeModelCapabilities,
    };
    this.generate = options.generate ?? defaultFakeCompletion;
  }

  async invoke(request: ModelInvocationRequest): Promise<ModelInvocationResult> {
    const startedAt = new Date().toISOString();
    const content = this.generate(request);
    const completedAt = new Date().toISOString();
    const requestedModelId = request.modelId ?? this.descriptor.defaultModelId;
    const promptTokens = countApproximateTokens(
      request.messages.map((message) => message.content).join(" "),
    );
    const completionTokens = countApproximateTokens(content);
    const run: ProviderRunRecord = {
      runId: request.runId ?? `fake-${Date.now().toString(36)}`,
      taskKind: request.taskKind,
      startedAt,
      completedAt,
      latencyMs: 0,
      status: "succeeded",
      provider: {
        providerFamily: this.descriptor.family,
        endpointFamily: this.descriptor.endpointFamily,
        providerName: this.descriptor.providerName,
        requestedModelId,
        actualModelId: requestedModelId,
      },
      structuredOutputMode: request.structuredOutput?.mode ?? "none",
      retryCount: 0,
      errorClasses: [],
      fallbackUsed: false,
      fallbackPlan: request.fallbackModels ?? [requestedModelId],
      tokenUsage: {
        tokenCountSource: "deterministic_counter",
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
      cost: {
        costKind: "zero",
        currency: "USD",
        amountMicrosUsd: 0,
      },
      dataHandling: this.descriptor.capabilities.dataHandling,
    };
    return { content, toolCalls: [], finishReason: "stop", providerRun: run };
  }
}

export const fakeModelCapabilities: ModelCapabilities = {
  structuredOutputs: {
    jsonSchema: "supported",
    jsonObject: "supported",
    toolCallArguments: "supported",
    plainJsonExtraction: "supported",
    preferredModes: ["json_schema", "json_object", "tool_call_arguments", "plain_json"],
  },
  toolCalls: {
    support: "supported",
    parallelToolCalls: "unsupported",
    requiresSchemaPerRequest: false,
  },
  imageInput: {
    support: "unsupported",
  },
  routing: {
    providerRouting: "unsupported",
    modelFallbacks: "unsupported",
    presets: "unsupported",
    requireParameters: "unsupported",
    dataCollectionControl: "unsupported",
    zeroDataRetentionRouting: "unsupported",
  },
  dataHandling: deterministicFixtureDataHandlingPolicy,
  notes: ["deterministic fake provider for CI and unit tests"],
};

function defaultFakeCompletion(request: ModelInvocationRequest): string {
  const sourceText = extractSourceText(request);
  if (sourceText === "こんにちは、{player}。") {
    return "Hello, {player}.";
  }
  return `[en-US] ${sourceText}`;
}

function extractSourceText(request: ModelInvocationRequest): string {
  const lastUserMessage = [...request.messages]
    .reverse()
    .find((message) => message.role === "user");
  if (typeof lastUserMessage?.content !== "string") {
    return "";
  }
  try {
    const parsed = JSON.parse(lastUserMessage.content) as { sourceText?: unknown };
    if (typeof parsed.sourceText === "string") {
      return parsed.sourceText;
    }
  } catch {
    return lastUserMessage.content;
  }
  return lastUserMessage.content;
}

function countApproximateTokens(text: string): number {
  const normalized = text.trim();
  if (normalized.length === 0) {
    return 0;
  }
  return Math.max(1, Math.ceil(normalized.length / 4));
}
