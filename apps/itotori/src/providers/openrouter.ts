import { createHash } from "node:crypto";
import {
  assertProviderInvocationSupported,
  globalCapabilityGuard,
  type CapabilityGuard,
  type ProviderRoutingCapabilityRequirement,
} from "./capability-guard.js";
import { knownPairs, type ModelProviderPair } from "./dev-pair.js";
import { usageCostToMicros, ZERO_COST } from "./cost.js";
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
  type ProviderDataHandlingPolicy,
  type ProviderDescriptor,
  type ProviderCost,
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

/**
 * ITOTORI-220 — typed payload thrown when the upstream provider that
 * answered does not match the providerId the request pinned. The metadata
 * shape lands in the artifact recorder so downstream audit can see both
 * the requested and the observed provider.
 */
export type OpenRouterProviderPairMismatchMetadata = {
  requestedProviderId: string;
  observedUpstreamProvider: string | undefined;
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
    const requestedModelId = request.modelId;
    const requestedProviderId = request.providerId;
    // ITOTORI-220 — pin OpenRouter to the requested provider id at request time.
    // Merging with the routing-defined `only` is intentional: the request's
    // providerId is authoritative and any pre-configured `only` list must
    // either match or be tightened to it.
    const providerRouting = buildOpenRouterProviderRouting(this.routing, request);
    const effectiveDataHandling = openRouterDataHandlingForRouting(
      this.descriptor.capabilities.dataHandling,
      providerRouting,
    );
    assertProviderInvocationSupported({
      descriptor: this.descriptor,
      request,
      requestedModelId,
      capabilities: {
        ...this.descriptor.capabilities,
        dataHandling: effectiveDataHandling,
      },
      routingRequirements: openRouterRoutingRequirements(this.routing, providerRouting),
    });

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
    // ITOTORI-220 — post-response pair check. If the upstream provider
    // that actually answered differs from the providerId we pinned, fail
    // LOUDLY rather than accept the swap silently. We still record the
    // artifact so audit can see the mismatch.
    if (
      normalized.upstreamProvider !== undefined &&
      normalized.upstreamProvider !== requestedProviderId
    ) {
      const metadata = adapterMetadata(body, providerRouting);
      const mismatchMetadata: OpenRouterProviderPairMismatchMetadata = {
        requestedProviderId,
        observedUpstreamProvider: normalized.upstreamProvider,
      };
      const mismatchAdapterMetadata: JsonObject = {
        ...metadata,
        pairMismatch: {
          requestedProviderId: mismatchMetadata.requestedProviderId,
          observedUpstreamProvider: mismatchMetadata.observedUpstreamProvider ?? null,
        },
      };
      const run = buildProviderRunRecord({
        descriptor: this.descriptor,
        request,
        requestedModelId,
        startedAt,
        status: "failed",
        actualModelId: normalized.actualModelId,
        upstreamProvider: normalized.upstreamProvider,
        routeSettingsHash,
        errorClasses: ["pair_mismatch"],
        tokenUsage: normalized.tokenUsage,
        dataHandling: effectiveDataHandling,
      });
      await this.live.artifactRecorder.recordProviderRun(
        buildArtifact({
          request,
          run,
          rawCapture: this.live.rawCapture,
          error: {
            class: "pair_mismatch",
            message: `OpenRouter routed to provider '${normalized.upstreamProvider}' but request pinned providerId '${requestedProviderId}'`,
          },
          adapterMetadata: mismatchAdapterMetadata,
        }),
      );
      throw new ModelProviderError(
        `OpenRouter routed to provider '${normalized.upstreamProvider}' but request pinned providerId '${requestedProviderId}'`,
        "pair_mismatch",
        false,
        run,
        mismatchAdapterMetadata,
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
      cost: normalized.cost,
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
  // ITOTORI-220 — pin OpenRouter routing to the requested providerId. If
  // the caller pre-supplied an `only` list, it MUST contain the request's
  // providerId; we refuse to widen it for them.
  if (routing.only !== undefined) {
    if (!routing.only.includes(request.providerId)) {
      throw new ModelProviderError(
        `OpenRouter provider routing only=[${routing.only.join(",")}] does not include requested providerId '${request.providerId}'`,
        "configuration_error",
        false,
      );
    }
    provider.only = [request.providerId];
  } else {
    provider.only = [request.providerId];
  }
  // Always disable provider fallbacks: pinning a providerId means we
  // refuse to silently swap providers on this call.
  provider.allow_fallbacks = false;
  if (routing.ignore) {
    provider.ignore = routing.ignore;
  }
  if (routing.quantizations) {
    provider.quantizations = routing.quantizations;
  }
  if (routing.sort) {
    provider.sort = routing.sort;
  }
  // `allow_fallbacks` is forced to false above by the providerId pin —
  // honouring a caller-supplied true here would defeat the pair lock.
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

function openRouterRoutingRequirements(
  routing: OpenRouterProviderRouting,
  providerRouting: JsonObject,
): ProviderRoutingCapabilityRequirement[] {
  const requirements = new Set<ProviderRoutingCapabilityRequirement>([
    "providerRouting",
    "dataCollectionControl",
  ]);
  if (providerRouting.require_parameters === true) {
    requirements.add("requireParameters");
  }
  // ITOTORI-220 — provider fallbacks are forced off by the providerId pin,
  // so we no longer require modelFallbacks capability based on routing.
  if (routing.zdr === true) {
    requirements.add("zeroDataRetentionRouting");
  }
  return [...requirements];
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
  cost: ProviderCost;
} {
  const record = asRecord(body, "OpenRouter response");
  const choices = asArray(record.choices, "OpenRouter response choices");
  const firstChoice = asRecord(choices[0], "OpenRouter first choice");
  const message = asRecord(firstChoice.message, "OpenRouter first choice message");
  const content = message.content === null ? null : (optionalString(message.content) ?? "");
  const finishReason = optionalString(firstChoice.finish_reason) ?? "unknown";
  const tokenUsage = normalizeUsage(record.usage);
  return {
    content,
    toolCalls: normalizeToolCalls(message.tool_calls),
    finishReason,
    actualModelId:
      optionalString(record.model) ?? selectedOpenRouterModel(body) ?? requestedModelId,
    upstreamProvider: selectedOpenRouterProvider(body),
    tokenUsage,
    cost: normalizeOpenRouterCost(record),
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

/**
 * ITOTORI-225 — single-branch real-cost normalizer.
 *
 * Per docs/openrouter-integration.md §5 (canonical real-cost contract) and
 * the live evidence at docs/openrouter-integration-evidence/2026-06-25.json,
 * every successful OpenRouter response carries `usage.cost` as a decimal
 * USD value. The integration is `usage.cost`-or-error: a successful HTTP
 * response without a `usage.cost` field is a protocol violation we surface
 * as `provider_response_invalid` so the caller can fail loudly instead of
 * silently undercounting spend.
 *
 * The endpoint-pricing fallback path (recompute spend from per-token prices
 * advertised in `openrouter_metadata.endpoints`) survives in the codebase
 * via {@link normalizeOpenRouterCostFromEndpointPricing} — that branch is
 * keep-and-fix territory for ITOTORI-233 per the 2026-06-25 audit. It is
 * intentionally NOT wired into the active code path here: the only correct
 * source of truth is the upstream-reported `usage.cost`. ITOTORI-233 will
 * decide whether to wire it back as a sanity-check sentinel (compare
 * recomputed-from-pricing to `usage.cost` and warn on drift) or repurpose
 * it; either way, it is not silently chained in front of an error today.
 */
function normalizeOpenRouterCost(response: Record<string, unknown>): ProviderCost {
  const usage = isRecord(response.usage) ? response.usage : undefined;
  if (usage === undefined || usage.cost === undefined || usage.cost === null) {
    throw new ModelProviderError(
      "OpenRouter response missing usage.cost; ITOTORI-225 contract requires real billed cost on every successful call",
      "provider_response_invalid",
      false,
    );
  }
  return {
    costKind: "billed",
    currency: "USD",
    amountMicrosUsd: usageCostToMicros(usage.cost),
  };
}

/**
 * ITOTORI-233 (held) — endpoint-pricing recompute path, parked here so the
 * 2026-06-25 audit's keep-and-fix verdict survives. NOT called from the
 * main path. The audit's evidence (docs/audits/openrouter-cost-tracking-
 * audit-2026-06-25.md §3 N1) explicitly tells ITOTORI-225 NOT to delete
 * this as dead; ITOTORI-233 will resurrect it as a cross-check sentinel
 * or repurpose its observation of the endpoints catalog.
 */
function normalizeOpenRouterCostFromEndpointPricing(
  response: Record<string, unknown>,
  tokenUsage: TokenUsage,
): ProviderCost | undefined {
  const endpointPricing = selectedOpenRouterPricing(response);
  const promptPriceUsd = finiteNonNegativeNumber(endpointPricing?.prompt);
  const completionPriceUsd = finiteNonNegativeNumber(endpointPricing?.completion);
  if (
    promptPriceUsd !== undefined &&
    completionPriceUsd !== undefined &&
    tokenUsage.promptTokens !== undefined &&
    tokenUsage.completionTokens !== undefined
  ) {
    return {
      costKind: "billed",
      currency: "USD",
      amountMicrosUsd: usdToMicros(
        tokenUsage.promptTokens * promptPriceUsd + tokenUsage.completionTokens * completionPriceUsd,
      ),
      pricingSnapshotId: "openrouter_response_endpoint_pricing",
    };
  }
  return undefined;
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
  cost?: ProviderCost;
  dataHandling: ProviderDataHandlingPolicy;
}): ProviderRunRecord {
  const completedAt = new Date();
  const fallbackPlan = fallbackPlanForRequest(input.request, input.requestedModelId);
  const provider: ProviderRunRecord["provider"] = {
    providerFamily: input.descriptor.family,
    endpointFamily: input.descriptor.endpointFamily,
    providerName: input.descriptor.providerName,
    requestedModelId: input.requestedModelId,
    requestedProviderId: input.request.providerId,
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
    // ITOTORI-225 — failed runs incurred no upstream charge; record them
    // as zero-cost rather than the deprecated 'unknown'. Successful runs
    // always carry an `input.cost` because normalizeOpenRouterCost
    // throws on missing usage.cost rather than returning a fallback.
    cost: input.status === "succeeded" && input.cost ? input.cost : ZERO_COST,
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
  const fromMetadata = optionalString(selected?.provider);
  if (fromMetadata !== undefined) {
    return fromMetadata;
  }
  // Fallback: OpenRouter chat-completions echoes the actual upstream
  // provider on the top-level `provider` field (string id). ITOTORI-220
  // post-response pair check reads this when `openrouter_metadata` is
  // absent (which is the live-mode default).
  if (isRecord(body)) {
    return optionalString(body.provider);
  }
  return undefined;
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

function selectedOpenRouterPricing(body: unknown): Record<string, unknown> | undefined {
  const selectedEndpoint = selectedOpenRouterEndpoint(body);
  return isRecord(selectedEndpoint?.pricing) ? selectedEndpoint.pricing : undefined;
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

function finiteNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return undefined;
}

function usdToMicros(value: number): number {
  return Math.round(value * 1_000_000);
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

// ---------------------------------------------------------------------------
// ITOTORI-221 — OpenRouterModelProvider
//
// Concrete live-LLM ModelProvider implementation. Wraps the existing
// `OpenRouterProvider` (which handles the HTTP request shape, provider-
// routing block, and the post-response pair check) and layers on three
// new responsibilities the alpha-gap analysis (§3 ITOTORI-NEW-Bopen)
// requires for a production-tier seam:
//
//   1. Reads `OPENROUTER_API_KEY` from `process.env` at construction.
//      Never touches `.env` on disk: that's the shell / direnv's job.
//      Missing key → `OpenRouterMissingApiKeyError` at construction,
//      not on first invoke, so the failure is loud and traceable to the
//      starting process.
//   2. Per-process USD cost cap. Tracks cumulative billed cost across
//      every `invoke()` and refuses to fire a new request once the cap
//      is hit. The check runs BEFORE the HTTP call so a cap-busted
//      caller never spends money it doesn't have a budget for.
//   3. Token-bucket rate limit at `rateLimitPerSec`. When the bucket is
//      empty, `invoke()` awaits the next slot rather than throwing —
//      this is the softer of the two limits, and matches OpenRouter's
//      own rps-based throttling behaviour.
//
// On construction the provider also registers every known (modelId,
// providerId) capability sheet from `dev-pair.ts` into the global
// CapabilityGuard, so the orchestrator can `globalCapabilityGuard()
// .lookup(modelId, providerId)` without each call site wiring its own
// registration.
// ---------------------------------------------------------------------------

export class OpenRouterMissingApiKeyError extends Error {
  constructor(readonly envVarName: string) {
    super(
      `OpenRouterModelProvider requires environment variable ${envVarName} to be set at construction; ` +
        `it reads from process.env directly and never opens a .env file`,
    );
    this.name = "OpenRouterMissingApiKeyError";
  }
}

export class OpenRouterCostCapError extends Error {
  constructor(
    readonly capUsd: number,
    readonly spentUsd: number,
    readonly remainingUsd: number,
  ) {
    super(
      `OpenRouterModelProvider per-process cost cap of $${capUsd.toFixed(4)} USD hit: ` +
        `$${spentUsd.toFixed(6)} already spent, remaining budget $${remainingUsd.toFixed(6)}`,
    );
    this.name = "OpenRouterCostCapError";
  }
}

export type OpenRouterHttpClient = typeof fetch;

export type OpenRouterModelProviderOptions = {
  /** Env var to read for the API key. Defaults to `OPENROUTER_API_KEY`. */
  apiKeyEnvVar?: string;
  /** Per-process cumulative USD cap. Default `1.0`. */
  costCapUsd?: number;
  /** Token-bucket rate (rps). Default `1.0`. */
  rateLimitPerSec?: number;
  /** Optional injection for unit tests (defaults to global `fetch`). */
  httpClient?: OpenRouterHttpClient;
  /** Optional injection of the cap-guard clock (test-only). */
  now?: () => number;
  /** Optional injection of the cap-guard sleep (test-only). */
  sleep?: (ms: number) => Promise<void>;
  /** Optional override for the capability guard registration target. */
  capabilityGuard?: CapabilityGuard;
  /** Optional artifact recorder; defaults to a no-op in-memory recorder. */
  artifactRecorder?: { recordProviderRun(artifact: ProviderRunArtifact): Promise<void> };
  /**
   * Optional override of the underlying base URL (test-only; production
   * should use the default). Must include the `/api/v1` suffix.
   */
  baseUrl?: string;
  /**
   * Optional process env source; defaults to `process.env`. Test-only —
   * production callers should never override this.
   */
  env?: Readonly<Record<string, string | undefined>>;
  /**
   * Optional providerName override (descriptor / logging). Defaults to
   * `"openrouter"`.
   */
  providerName?: string;
};

// In-memory no-op artifact recorder. Real callers wire a persistent
// recorder via the artifacts module; the live-mode provider needs one
// to satisfy the underlying OpenRouterProvider's ProviderLiveRunOptions
// shape even when artifact persistence is handled elsewhere.
class NoopArtifactRecorder {
  async recordProviderRun(_artifact: ProviderRunArtifact): Promise<void> {
    return undefined;
  }
}

type TokenBucketDeps = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;
  private waitChain: Promise<void> = Promise.resolve();

  constructor(
    readonly ratePerSec: number,
    readonly capacity: number,
    private readonly deps: TokenBucketDeps,
  ) {
    this.tokens = capacity;
    this.lastRefillMs = deps.now();
  }

  /**
   * Acquire one token, awaiting the next available slot if the bucket
   * is empty. Calls are FIFO-serialised so three back-to-back calls at
   * 1 rps each wait ~1 second apart deterministically.
   */
  async acquire(): Promise<void> {
    const next = this.waitChain.then(() => this.acquireOne());
    this.waitChain = next.catch(() => undefined);
    return next;
  }

  private async acquireOne(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    const tokensNeeded = 1 - this.tokens;
    const waitMs = Math.ceil((tokensNeeded / this.ratePerSec) * 1000);
    await this.deps.sleep(waitMs);
    this.refill();
    this.tokens = Math.max(0, this.tokens - 1);
  }

  private refill(): void {
    const nowMs = this.deps.now();
    const elapsedSec = (nowMs - this.lastRefillMs) / 1000;
    if (elapsedSec <= 0) {
      return;
    }
    const refilled = elapsedSec * this.ratePerSec;
    this.tokens = Math.min(this.capacity, this.tokens + refilled);
    this.lastRefillMs = nowMs;
  }
}

const DEFAULT_API_KEY_ENV_VAR = "OPENROUTER_API_KEY";
// ITOTORI-231 — single source of truth for the per-process USD cap.
//
// Why 0.5 USD: Trevor's standing rule is that every model invocation
// declares its (modelId, providerId) pair and cost is always REAL (the
// generation/<id> endpoint settles `usage.cost`) — never estimated.
// Empirically, per the ITOTORI-224 evidence pack a single agentic-loop
// call against the DEV_PAIR (deepseek-v3.2-exp at fireworks) settles
// at ~USD 0.000003 (USD 0.0000182 across six calls). A 0.5 USD ceiling
// therefore admits roughly 166,000 calls of headroom in a single
// process run — far more than any realistic interactive Sweetie HD
// localization session needs, while still tight enough to refuse a
// runaway loop. Batch runs pass `--cost-cap-usd` to override this
// per-invocation; the constant is the only default in code.
export const DEFAULT_COST_CAP_USD = 0.5;
const DEFAULT_RATE_LIMIT_PER_SEC = 1.0;

export class OpenRouterModelProvider implements ModelProvider {
  readonly descriptor: ProviderDescriptor;
  readonly costCapUsd: number;
  readonly rateLimitPerSec: number;
  readonly apiKeyEnvVar: string;
  private spentUsd = 0;
  private readonly inner: OpenRouterProvider;
  private readonly bucket: TokenBucket;

  constructor(options: OpenRouterModelProviderOptions = {}) {
    this.apiKeyEnvVar = options.apiKeyEnvVar ?? DEFAULT_API_KEY_ENV_VAR;
    this.costCapUsd = options.costCapUsd ?? DEFAULT_COST_CAP_USD;
    this.rateLimitPerSec = options.rateLimitPerSec ?? DEFAULT_RATE_LIMIT_PER_SEC;

    const envSource: Readonly<Record<string, string | undefined>> = options.env ?? process.env;
    const apiKey = envSource[this.apiKeyEnvVar];
    if (apiKey === undefined || apiKey.length === 0) {
      throw new OpenRouterMissingApiKeyError(this.apiKeyEnvVar);
    }

    const recorder = options.artifactRecorder ?? new NoopArtifactRecorder();
    const now = options.now ?? (() => Date.now());
    const sleep =
      options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

    this.bucket = new TokenBucket(this.rateLimitPerSec, Math.max(1, this.rateLimitPerSec), {
      now,
      sleep,
    });

    // The inner OpenRouterProvider does the request shaping + pair
    // check; we wrap it for cost cap + rate limit + env config.
    // modelId on the descriptor is "openrouter" because the provider
    // is multi-model — actual modelId per call comes from the request.
    this.inner = new OpenRouterProvider({
      modelId: "openrouter",
      providerName: options.providerName ?? "openrouter",
      ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
      apiKey,
      fetch: options.httpClient ?? globalThis.fetch,
      live: { enabled: true, artifactRecorder: recorder, rawCapture: "disabled" },
    });
    this.descriptor = this.inner.descriptor;

    // Register every known-pair capability sheet into the singleton
    // CapabilityGuard so orchestrator code calling
    // globalCapabilityGuard().lookup(modelId, providerId) succeeds for
    // any pair from dev-pair.ts without per-call registration.
    const guard = options.capabilityGuard ?? globalCapabilityGuard();
    for (const entry of knownPairsForRegistration()) {
      guard.register(entry.pair.modelId, entry.pair.providerId, entry.modelCapabilities);
    }
  }

  async invoke(request: ModelInvocationRequest): Promise<ModelInvocationResult> {
    // Cost cap check BEFORE the HTTP request fires (per the spec audit
    // focus: "Cost cap bypassed by a code path that constructs the
    // HTTP request before the policy check"). Mocked tests assert
    // fetchMock was never called when the cap is hit.
    const remaining = this.remainingBudgetUsd();
    if (remaining <= 0) {
      throw new OpenRouterCostCapError(this.costCapUsd, this.spentUsd, 0);
    }

    // Rate-limit wait. Softer than the cost cap: blocks the caller
    // until the bucket has a token.
    await this.bucket.acquire();

    const result = await this.inner.invoke(request);
    this.recordSpend(result);
    return result;
  }

  /** Currently spent USD against the per-process cap. */
  totalSpentUsd(): number {
    return this.spentUsd;
  }

  /** Remaining USD budget (cap minus spent). */
  remainingBudgetUsd(): number {
    return Math.max(0, this.costCapUsd - this.spentUsd);
  }

  private recordSpend(result: ModelInvocationResult): void {
    const cost = result.providerRun.cost;
    if (cost.amountMicrosUsd === undefined) {
      return;
    }
    this.spentUsd += cost.amountMicrosUsd / 1_000_000;
  }
}

// Indirection so the dev-pair.ts import only resolves when called.
// (Circularity-safe: dev-pair.ts imports only types +
// openRouterDefaultCapabilities from this file, both of which are
// module-top-level by the time knownPairsForRegistration runs.)
function knownPairsForRegistration(): ReturnType<typeof knownPairs> {
  return knownPairs();
}

export type { ModelProviderPair };
