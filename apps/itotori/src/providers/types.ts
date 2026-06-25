export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type ProviderFamily = "fake" | "recorded" | "openrouter" | "local-openai-compatible";
export type EndpointFamily =
  | "chat-completions"
  | "responses"
  | "local-chat-completions"
  | "recorded-fixture";

export type CapabilitySupport = "supported" | "unsupported" | "partial" | "untested";

export type StructuredOutputMode =
  | "json_schema"
  | "json_object"
  | "tool_call_arguments"
  | "plain_json";

export type StructuredOutputCapabilities = {
  jsonSchema: CapabilitySupport;
  jsonObject: CapabilitySupport;
  toolCallArguments: CapabilitySupport;
  plainJsonExtraction: CapabilitySupport;
  preferredModes: StructuredOutputMode[];
};

export type ToolCallCapabilities = {
  support: CapabilitySupport;
  parallelToolCalls: CapabilitySupport;
  requiresSchemaPerRequest: boolean;
};

export type ImageInputCapabilities = {
  support: CapabilitySupport;
  maxImagesPerRequest?: number;
  maxImageBytes?: number;
};

export type RoutingCapabilities = {
  providerRouting: CapabilitySupport;
  modelFallbacks: CapabilitySupport;
  presets: CapabilitySupport;
  requireParameters: CapabilitySupport;
  dataCollectionControl: CapabilitySupport;
  zeroDataRetentionRouting: CapabilitySupport;
};

export type ProviderPolicyState = "allow" | "deny" | "unknown" | "not_applicable";
export type ProviderLoggingState = "enabled" | "disabled" | "unknown" | "not_applicable";
export type ProviderRetentionState =
  | "none"
  | "metadata_only"
  | "prompt_or_completion"
  | "unknown"
  | "not_applicable";

/**
 * ITOTORI-225 — `costTier` is gone. The per-policy "free/paid/mixed/local/
 * unknown" enum was a category error: cost is a per-request fact (carried by
 * `ProviderCost`), not a per-policy axis. The privacy-only fields below are
 * the only thing left in this policy until ITOTORI-227 replaces the whole
 * shape with a pure privacy posture.
 */
export type ProviderDataHandlingPolicy = {
  promptLogging: ProviderLoggingState;
  completionLogging: ProviderLoggingState;
  retention: ProviderRetentionState;
  trainingUse: ProviderPolicyState;
  dataCollection: ProviderPolicyState;
  rawCaptureDefault: ProviderLoggingState;
};

export type OpenRouterAccountPrivacyState = {
  inputOutputLogging: ProviderLoggingState;
  useOfInputsOutputs: ProviderPolicyState;
  providerDataPolicyFilters: ProviderLoggingState;
  metadataCollection: "expected" | "unknown" | "not_applicable";
  euRouting: ProviderLoggingState;
};

export type ModelCapabilities = {
  structuredOutputs: StructuredOutputCapabilities;
  toolCalls: ToolCallCapabilities;
  imageInput: ImageInputCapabilities;
  routing: RoutingCapabilities;
  dataHandling: ProviderDataHandlingPolicy;
  accountPrivacy?: OpenRouterAccountPrivacyState;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  notes?: string[];
};

export type ProviderDescriptor = {
  family: ProviderFamily;
  endpointFamily: EndpointFamily;
  providerName: string;
  defaultModelId: string;
  capabilities: ModelCapabilities;
};

export type ProviderInputClassification =
  | "synthetic_public"
  | "public"
  | "private_corpus"
  | "confidential"
  | "secret";

export type ModelMessageRole = "system" | "user" | "assistant" | "tool";

export type ModelTextContentPart = {
  type: "text";
  text: string;
};

export type ModelImageContentPart = {
  type: "image_url";
  imageUrl: string;
  detail?: "low" | "high" | "auto";
};

export type ModelMessage = {
  role: ModelMessageRole;
  content: string | Array<ModelTextContentPart | ModelImageContentPart> | null;
  name?: string;
  toolCallId?: string;
  toolCalls?: ModelToolCall[];
};

export type ModelTool = {
  name: string;
  description: string;
  parameters: JsonObject;
};

export type ModelToolCall = {
  id: string;
  name: string;
  argumentsJson: string;
};

export type ModelToolChoice =
  | "auto"
  | "none"
  | {
      type: "function";
      functionName: string;
    };

export type StructuredOutputRequest =
  | {
      mode: "json_schema";
      name: string;
      schema: JsonObject;
      strict: boolean;
    }
  | {
      mode: "json_object";
    }
  | {
      mode: "tool_call_arguments";
      toolName: string;
      schema: JsonObject;
      strict: boolean;
    }
  | {
      mode: "plain_json";
    };

export type ModelGenerationOptions = {
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  stop?: string[];
};

export type ProviderPresetReference = {
  slug: string;
  version?: string;
  configHash?: string;
  configSnapshot?: JsonObject;
};

export type PromptPresetReference = {
  presetId: string;
  templateVersion: string;
  promptHash: string;
  schemaVersion?: string;
  configSnapshot?: JsonObject;
};

/**
 * ITOTORI-220 — every model invocation seam declares BOTH a model id AND
 * a specific provider id as a **pair**. Calling out by model alone is a
 * P0 architectural violation: OpenRouter is a marketplace and provider
 * quality, cost, latency, and structured-output support vary by provider
 * for the same model. The pair is non-optional at the type level so a
 * caller cannot silently fall back to "any provider that happens to be
 * cheapest right now".
 */
export type ModelInvocationRequest = {
  taskKind: "draft_translation" | "llm_qa" | "repair" | "experiment";
  /** Required by ITOTORI-220 — no defaulting at the request seam. */
  modelId: string;
  /**
   * Required by ITOTORI-220 — pinned upstream provider id. For OpenRouter
   * this is the value passed to `provider: { only: [providerId] }` and
   * the value that must equal `response.upstreamProvider` after the call.
   * For local/recorded/fake providers this is a stable identifier like
   * `local`, `recorded`, or `fake-fixture`.
   */
  providerId: string;
  messages: ModelMessage[];
  inputClassification: ProviderInputClassification;
  structuredOutput?: StructuredOutputRequest;
  tools?: ModelTool[];
  toolChoice?: ModelToolChoice;
  generation?: ModelGenerationOptions;
  fallbackModels?: string[];
  preset?: ProviderPresetReference;
  prompt: PromptPresetReference;
  runId?: string;
  recordRawText?: boolean;
};

export type TokenUsage = {
  tokenCountSource: "provider_reported" | "estimated" | "deterministic_counter" | "unknown";
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
};

/**
 * ITOTORI-225 — `costKind` is `'billed' | 'zero'`, full stop.
 *
 * - `billed`: a real upstream charge. `amountMicrosUsd` is the exact spend
 *   reported by the provider (e.g. OpenRouter's `usage.cost`). Required.
 * - `zero`: no charge was incurred (recorded-fixture replays, deterministic
 *   local mocks, failed pre-billing requests). `amountMicrosUsd === 0`.
 *
 * No `unknown`. No `provider_estimate`. No `local_estimate`. The previous
 * enum existed because we were guessing; per the standing
 * no-hardcoded-cost / no-fallback rule, every successful upstream call
 * returns the real cost, and unsuccessful calls cost nothing.
 *
 * `amountMicrosUsd` is non-optional: both variants carry a real number. A
 * caller cannot omit it.
 */
export type ProviderCost = {
  costKind: "billed" | "zero";
  currency: "USD";
  amountMicrosUsd: number;
  pricingSnapshotId?: string;
};

export type ProviderRunIdentity = {
  providerFamily: ProviderFamily;
  endpointFamily: EndpointFamily;
  providerName: string;
  requestedModelId: string;
  actualModelId: string;
  /**
   * ITOTORI-220 — the providerId the request pinned. Populated for every
   * invocation; downstream consumers (ledger, audit) read it without
   * having to mirror request shape.
   */
  requestedProviderId: string;
  upstreamProvider?: string;
  routeSettingsHash?: string;
};

export type ProviderRunRecord = {
  runId: string;
  taskKind: ModelInvocationRequest["taskKind"];
  startedAt: string;
  completedAt: string;
  latencyMs: number;
  status: "succeeded" | "failed" | "partial" | "skipped";
  provider: ProviderRunIdentity;
  structuredOutputMode: StructuredOutputMode | "none";
  retryCount: number;
  errorClasses: string[];
  fallbackUsed: boolean;
  fallbackPlan: string[];
  tokenUsage: TokenUsage;
  cost: ProviderCost;
  prompt: PromptPresetReference;
  providerPreset?: ProviderPresetReference;
  dataHandling: ProviderDataHandlingPolicy;
  accountPrivacy?: OpenRouterAccountPrivacyState;
};

export type ModelInvocationResult = {
  content: string | null;
  toolCalls: ModelToolCall[];
  finishReason: string;
  providerRun: ProviderRunRecord;
  adapterMetadata?: JsonObject;
};

export type ProviderRunArtifact = {
  schemaVersion: "itotori.provider-run.v0";
  run: ProviderRunRecord;
  request: {
    messageCount: number;
    inputClassification: ProviderInputClassification;
    requestedModelId: string;
    structuredOutputMode: StructuredOutputMode | "none";
    toolCount: number;
    rawTextCaptured: boolean;
    prompt: PromptPresetReference;
    providerPreset?: ProviderPresetReference;
  };
  response?: {
    finishReason: string;
    contentLength: number;
    toolCallCount: number;
  };
  error?: {
    class: string;
    message: string;
  };
  adapterMetadata?: JsonObject;
};

export type ProviderRunArtifactRecorder = {
  recordProviderRun(artifact: ProviderRunArtifact): Promise<void>;
};

export type ProviderLiveRunOptions =
  | {
      enabled: false;
    }
  | {
      enabled: true;
      artifactRecorder: ProviderRunArtifactRecorder;
      rawCapture: ProviderLoggingState;
    };

export interface ModelProvider {
  readonly descriptor: ProviderDescriptor;
  invoke(request: ModelInvocationRequest): Promise<ModelInvocationResult>;
}

/**
 * ITOTORI-220 — `pair_mismatch` is raised when the upstream provider that
 * actually answered does not match the providerId the caller pinned. This
 * fails LOUDLY because silently accepting a different provider would
 * defeat the whole point of locking the (model, provider) pair.
 */
export class ModelProviderError extends Error {
  constructor(
    message: string,
    readonly code:
      | "capability_unsupported"
      | "configuration_error"
      | "pair_mismatch"
      | "policy_blocked"
      | "provider_http_error"
      | "provider_response_invalid",
    readonly retryable = false,
    readonly providerRun?: ProviderRunRecord,
    readonly adapterMetadata?: JsonObject,
  ) {
    super(message);
    this.name = "ModelProviderError";
  }
}

let providerRunCounter = 0;

export function createProviderRunId(prefix: string): string {
  providerRunCounter += 1;
  const timestamp = Date.now().toString(36);
  const counter = providerRunCounter.toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${timestamp}-${counter}-${random}`;
}
