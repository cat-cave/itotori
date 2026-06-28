import { createHash } from "node:crypto";
import { assertOpenRouterZdrAccount } from "./account-zdr.js";
import {
  assertProviderInvocationSupported,
  globalCapabilityGuard,
  type CapabilityGuard,
  type ProviderRoutingCapabilityRequirement,
} from "./capability-guard.js";
import { knownPairs, type ModelProviderPair } from "./dev-pair.js";
import { decimalUsdStringToMicros, usageCostToMicros, ZERO_COST } from "./cost.js";
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
  type OpenRouterRoutingPosture,
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
    // ITOTORI-230 — typed restatement of the same posture for the
    // ledger / recorded-bundle audit trail. Derived from the same
    // routing block we put on the wire (above), not synthesized
    // separately, so the two cannot drift.
    const routingPosture = openRouterRoutingPostureFromBlock(providerRouting);
    assertProviderInvocationSupported({
      descriptor: this.descriptor,
      request,
      requestedModelId,
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
        routingPosture,
        // ITOTORI-232 — no response body landed; record the typed
        // network-error sentinel so a later audit can tell pre-response
        // failures apart from missing-cost responses.
        usageResponseJson: { _network_error: true },
      });
      await this.live.artifactRecorder.recordProviderRun(
        buildArtifact({
          request,
          run,
          rawCapture: this.live.rawCapture,
          error: providerNetworkErrorArtifact({
            error,
            inputClassification: request.inputClassification,
          }),
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
        routingPosture,
        // ITOTORI-232 — surface whatever `usage` the error envelope
        // carried (often nothing on 4xx/5xx); if the body wasn't a
        // record at all, record the typed http-error sentinel so the
        // ledger row is still object-shaped and traceable.
        usageResponseJson: extractUsageResponseJson(body, "_http_error"),
      });
      const retryable = response.status >= 500 || response.status === 429;
      await this.live.artifactRecorder.recordProviderRun(
        buildArtifact({
          request,
          run,
          rawCapture: this.live.rawCapture,
          error: providerHttpErrorArtifact({
            body,
            status: response.status,
            retryable,
            inputClassification: request.inputClassification,
          }),
          adapterMetadata: metadata,
        }),
      );
      throw new ModelProviderError(
        `OpenRouter request failed with HTTP ${response.status}`,
        "provider_http_error",
        retryable,
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
        routingPosture,
        // ITOTORI-232 — preserve whatever `usage` shape the malformed
        // response carried; the failed-run path tags the row zero-cost
        // so even an absent `cost` field is honest.
        usageResponseJson: extractUsageResponseJson(body, "_response_invalid"),
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
    //
    // ITOTORI-236 — `request.providerId` is the lowercase routing slug
    // (e.g. `"fireworks"`) used in `provider.only`/`provider.order`, but
    // `response.provider` is the TitleCase human-readable `provider_name`
    // (e.g. `"Fireworks"`) per docs/openrouter-integration.md §9.2. A
    // strict `===` here flagged every successful Fireworks-routed call as
    // a `pair_mismatch`. The fix routes both ends through
    // `openRouterProviderIdsMatch`, which checks the known slug↔name
    // registry first and then falls back to case-insensitive comparison;
    // a GENUINE mismatch (Fireworks pinned, OpenAI returned) still throws.
    if (
      normalized.upstreamProvider !== undefined &&
      !openRouterProviderIdsMatch(requestedProviderId, normalized.upstreamProvider)
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
        routingPosture,
        // ITOTORI-232 — surface the upstream `usage` block; the
        // pair-mismatch failure path tags the run zero-cost (see
        // buildProviderRunRecord), so `cost_amount` is 0 — but we still
        // capture whatever upstream charged the audit can review.
        usageResponseJson: extractUsageResponseJson(body, "_pair_mismatch"),
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
    const maxPriceUsd = request.maxPriceUsd;
    if (maxPriceUsd !== undefined) {
      const maxPriceMicrosUsd = maxPriceUsdToMicros(maxPriceUsd);
      const actualMicrosUsd = normalized.cost.amountMicrosUsd ?? 0;
      if (actualMicrosUsd > maxPriceMicrosUsd) {
        const metadata = {
          ...adapterMetadata(body, providerRouting),
          localMaxPriceUsd: maxPriceUsd,
          actualCostUsd: actualMicrosUsd / 1_000_000,
        } as JsonObject;
        const run = buildProviderRunRecord({
          descriptor: this.descriptor,
          request,
          requestedModelId,
          startedAt,
          status: "failed",
          actualModelId: normalized.actualModelId,
          upstreamProvider: normalized.upstreamProvider,
          routeSettingsHash,
          errorClasses: ["cost_cap_exceeded"],
          tokenUsage: normalized.tokenUsage,
          cost: normalized.cost,
          routingPosture,
          usageResponseJson: extractUsageResponseJson(body, "_cost_cap_exceeded"),
        });
        await this.live.artifactRecorder.recordProviderRun(
          buildArtifact({
            request,
            run,
            rawCapture: this.live.rawCapture,
            error: {
              class: "cost_cap_exceeded",
              message: `OpenRouter response cost $${(actualMicrosUsd / 1_000_000).toFixed(6)} exceeded pair-policy maxPriceUsd $${maxPriceUsd.toFixed(6)}`,
            },
            adapterMetadata: metadata,
          }),
        );
        throw new ModelProviderError(
          `OpenRouter response cost $${(actualMicrosUsd / 1_000_000).toFixed(6)} exceeded pair-policy maxPriceUsd $${maxPriceUsd.toFixed(6)}`,
          "cost_cap_exceeded",
          false,
          run,
          metadata,
        );
      }
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
      routingPosture,
      // ITOTORI-232 — mirror the response's `usage` block verbatim onto
      // the run so the recorder persists it into the ledger row. The
      // `cost` field in this object is the same upstream value
      // normalizeOpenRouterCost extracted; the DB CHECK enforces that
      // `cost_amount = usage_response_json->>'cost'` within 1e-9 USD.
      usageResponseJson: extractUsageResponseJson(body, null),
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
  notes: [
    // ITOTORI-227 — itotori no longer carries per-pair privacy axes.
    // The posture is enforced by the account-wide ZDR assertion
    // (assertOpenRouterZdrAccount) plus the per-request
    // `provider.zdr=true` default for non-public input. See
    // docs/openrouter-integration.md §2.
    "OpenRouter privacy posture is account-wide ZDR + per-request provider.zdr=true (see docs/openrouter-integration.md §2)",
  ],
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
  // ITOTORI-230 — derive the typed posture FIRST, then mirror it onto
  // the wire JsonObject. Driving the wire shape from the posture (not
  // the other way round) is how we keep the captured-on-ledger posture
  // identical to what actually went out — a captured posture that
  // disagreed with the wire would be worse than no posture at all.
  const posture = buildOpenRouterRoutingPosture(routing, request);
  const provider: Record<string, JsonValue> = {
    only: posture.only,
    allow_fallbacks: posture.allow_fallbacks,
    data_collection: posture.data_collection,
  };
  // ITOTORI-227 — posture.zdr is only emitted to the wire when the
  // call carries a privacy contract; public-input calls skip it.
  if (posture.zdr) {
    provider.zdr = true;
  } else if (routing.zdr !== undefined) {
    // Caller explicitly set zdr (e.g. false). Mirror their choice.
    provider.zdr = routing.zdr;
  }
  // require_parameters mirrors the posture's typed value when strict
  // mode applies; otherwise we only emit if the caller asked.
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
  if (routing.ignore) {
    provider.ignore = routing.ignore;
  }
  if (routing.quantizations) {
    provider.quantizations = routing.quantizations;
  }
  if (routing.sort) {
    provider.sort = routing.sort;
  }
  if (routing.enforceDistillableText !== undefined) {
    provider.enforce_distillable_text = routing.enforceDistillableText;
  }
  if (routing.maxPrice !== undefined) {
    provider.max_price = routing.maxPrice;
  } else if (request.maxPriceUsd !== undefined) {
    maxPriceUsdToDecimalString(request.maxPriceUsd);
    provider.max_price = { request: request.maxPriceUsd };
  }
  return provider as JsonObject;
}

/**
 * ITOTORI-230 — build the typed `OpenRouterRoutingPosture` for THIS
 * call. Pure function of the routing config + request; the wire-level
 * routing block (above) is then derived from this posture so the two
 * cannot drift.
 *
 * Why each field's value is what it is:
 *   - only: always `[request.providerId]` — the ITOTORI-220 pair pin.
 *   - allow_fallbacks: literal `false` — same reason.
 *   - data_collection: `"deny"` for any private input; mirrors
 *     `routing.dataCollection` for public input (defaults to `"deny"`).
 *     A caller-explicit `"allow"` for public inputs is honoured so the
 *     captured posture is HONEST about the wire shape.
 *   - zdr: `true` by default for non-public inputs (ITOTORI-227); a
 *     caller override is honoured verbatim. `public` inputs default
 *     to `false` (no zdr on the wire) unless caller asks.
 *   - require_parameters: `true` whenever strict structured output or
 *     tool calls are in play; otherwise mirrors caller, defaulting to
 *     `true` per the canonical ZDR posture (docs/openrouter-
 *     integration.md §3) when the caller is silent.
 */
function buildOpenRouterRoutingPosture(
  routing: OpenRouterProviderRouting,
  request: ModelInvocationRequest,
): OpenRouterRoutingPosture {
  // ITOTORI-220 — pin OpenRouter routing to the requested providerId. If
  // the caller pre-supplied an `only` list, it MUST contain the request's
  // providerId; we refuse to widen it for them.
  if (routing.only !== undefined && !routing.only.includes(request.providerId)) {
    throw new ModelProviderError(
      `OpenRouter provider routing only=[${routing.only.join(",")}] does not include requested providerId '${request.providerId}'`,
      "configuration_error",
      false,
    );
  }
  const dataCollection = dataCollectionForRequest(
    routing.dataCollection,
    request.inputClassification,
  );
  // ITOTORI-227 — zdr default: true for non-public input, mirrors caller
  // otherwise. Posture records the boolean explicitly (the wire shape
  // skips the field for public input; both are recoverable from the
  // posture + classification).
  const zdr = routing.zdr !== undefined ? routing.zdr : request.inputClassification !== "public";
  const strictParametersRequired =
    request.structuredOutput?.mode === "json_schema" ||
    request.structuredOutput?.mode === "tool_call_arguments" ||
    Boolean(request.tools?.length);
  const requireParameters = strictParametersRequired ? true : (routing.requireParameters ?? true);
  return {
    only: [request.providerId],
    allow_fallbacks: false,
    data_collection: dataCollection,
    zdr,
    require_parameters: requireParameters,
  };
}

/**
 * Restate the wire-level routing JsonObject as the typed
 * {@link OpenRouterRoutingPosture}. Used by the post-build path where
 * we have the JsonObject in hand (e.g. when threading the captured
 * posture onto a `ProviderRunRecord` via the same `providerRouting`
 * value that hit the wire). Strict: every required field MUST be
 * present and shape-correct; otherwise a `ModelProviderError` of code
 * `configuration_error` fires (the posture-derivation invariant is
 * violated, which would be a bug in `buildOpenRouterProviderRouting`).
 */
function openRouterRoutingPostureFromBlock(block: JsonObject): OpenRouterRoutingPosture {
  const only = block.only;
  if (!Array.isArray(only) || !only.every((entry) => typeof entry === "string")) {
    throw new ModelProviderError(
      "OpenRouter routing posture missing 'only' string array",
      "configuration_error",
      false,
    );
  }
  if (block.allow_fallbacks !== false) {
    throw new ModelProviderError(
      "OpenRouter routing posture must have allow_fallbacks=false",
      "configuration_error",
      false,
    );
  }
  if (block.data_collection !== "deny" && block.data_collection !== "allow") {
    throw new ModelProviderError(
      `OpenRouter routing posture data_collection must be 'deny' or 'allow', got ${String(block.data_collection)}`,
      "configuration_error",
      false,
    );
  }
  const zdr = typeof block.zdr === "boolean" ? block.zdr : false;
  const requireParameters =
    typeof block.require_parameters === "boolean" ? block.require_parameters : true;
  return {
    only: only as string[],
    allow_fallbacks: false,
    data_collection: block.data_collection,
    zdr,
    require_parameters: requireParameters,
  };
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

function maxPriceUsdToDecimalString(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    throw new ModelProviderError(
      `maxPriceUsd must be a finite non-negative number, got ${String(value)}`,
      "configuration_error",
      false,
    );
  }
  return value.toFixed(12).replace(/0+$/u, "").replace(/\.$/u, "");
}

function maxPriceUsdToMicros(value: number): number {
  return decimalUsdStringToMicros(maxPriceUsdToDecimalString(value));
}

function isPrivateInput(inputClassification: ProviderInputClassification): boolean {
  return inputClassification !== "synthetic_public" && inputClassification !== "public";
}

function openRouterRoutingRequirements(
  _routing: OpenRouterProviderRouting,
  providerRouting: JsonObject,
): ProviderRoutingCapabilityRequirement[] {
  const requirements = new Set<ProviderRoutingCapabilityRequirement>([
    "providerRouting",
    "dataCollectionControl",
  ]);
  if (providerRouting.require_parameters === true) {
    requirements.add("requireParameters");
  }
  // ITOTORI-227 — every non-public request body carries
  // `provider.zdr=true` by default, so the zero-data-retention capability
  // requirement applies whenever the routing block carries `zdr`. This
  // is set automatically (not just when the caller opts in) so the
  // capability guard refuses to fire on providers that haven't been
  // confirmed for ZDR routing.
  if (providerRouting.zdr === true) {
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
  // ITOTORI-233 — mirror prompt-caching annotations from
  // `usage.prompt_tokens_details` per docs/openrouter-integration.md §5.3
  // (canonical shape verified in docs/openrouter-integration-evidence/
  // 2026-06-25.json call_1: `prompt_tokens_details: { cached_tokens: 0,
  // cache_write_tokens: 0, audio_tokens: 0, video_tokens: 0 }`). Absent
  // → undefined → 0 at the storage layer (NOT NULL DEFAULT 0 per
  // migration 0042).
  const promptTokensDetails = value.prompt_tokens_details;
  if (isRecord(promptTokensDetails)) {
    assignNumber(usage, "cacheReadTokens", promptTokensDetails.cached_tokens);
    assignNumber(usage, "cacheWriteTokens", promptTokensDetails.cache_write_tokens);
  }
  return usage;
}

/**
 * ITOTORI-225 / ITOTORI-233 — single-branch real-cost normalizer with
 * cache-aware annotations.
 *
 * Per docs/openrouter-integration.md §5 (canonical real-cost contract) and
 * the live evidence at docs/openrouter-integration-evidence/2026-06-25.json,
 * every successful OpenRouter response carries `usage.cost` as a decimal
 * USD value. The integration is `usage.cost`-or-error: a successful HTTP
 * response without a `usage.cost` field is a protocol violation we surface
 * as `provider_response_invalid` so the caller can fail loudly instead of
 * silently undercounting spend.
 *
 * ITOTORI-233 / DOC-AMBIGUOUS-6 RESOLVED (integration doc §11 entry 6,
 * §5.3): `usage.cost` is **net of `cache_discount`** by treaty — we treat
 * it as authoritative billed cost and **never recompute**. The cost cap
 * therefore consumes `amountMicrosUsd` directly; `cache_discount` is
 * mirrored onto `cacheDiscountMicrosUsd` as an INFORMATIONAL annotation
 * for telemetry ("how much did caching save us") and is NOT subtracted
 * from `amountMicrosUsd`. Subtracting it would double-count the discount
 * (it is already netted out upstream).
 *
 * Source: docs/openrouter-integration-evidence/2026-06-25.json call_1
 * shows the canonical `usage.cost_details` shape; call_6 shows
 * `cache_discount: null` is the normal case on a non-cache hit (we map
 * null → 0 micros). The implicit-cache evidence with a non-null
 * `cache_discount` is empirically UNAVAILABLE on Trevor's account
 * because the deepseek-tagged endpoint is excluded from the ZDR
 * allow-list (call_3 returned HTTP 404 ZDR envelope); the math is still
 * correct because the value flows verbatim through
 * `decimalUsdStringToMicros` whenever a provider DOES surface it.
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
  const cost: ProviderCost = {
    costKind: "billed",
    currency: "USD",
    amountMicrosUsd: usageCostToMicros(usage.cost),
    cacheDiscountMicrosUsd: extractCacheDiscountMicros(usage),
  };
  return cost;
}

/**
 * ITOTORI-233 — extract `cache_discount` from `usage.cost_details` and
 * convert to integer micros via the canonical decimal-string helper.
 *
 * Empirical wire shape (docs/openrouter-integration-evidence/2026-06-25.json
 * call_6): `cache_discount: null` is the normal case on a non-cache-hit,
 * mapped to 0 here. When non-null the value is a USD decimal number; we
 * stringify via `toFixed(12)` so the same `decimalUsdStringToMicros`
 * parser handles it without floating-point loss-of-precision. Negative
 * values would be an upstream protocol violation — the parser rejects
 * them with `provider_response_invalid`. Defaults to 0 if `cost_details`
 * is absent.
 */
function extractCacheDiscountMicros(usage: Record<string, unknown>): number {
  const costDetails = usage.cost_details;
  if (!isRecord(costDetails)) {
    return 0;
  }
  const cacheDiscount = costDetails.cache_discount;
  if (cacheDiscount === undefined || cacheDiscount === null) {
    return 0;
  }
  if (typeof cacheDiscount === "number") {
    if (!Number.isFinite(cacheDiscount) || cacheDiscount === 0) {
      return 0;
    }
    return decimalUsdStringToMicros(cacheDiscount.toFixed(12));
  }
  if (typeof cacheDiscount === "string") {
    if (cacheDiscount.trim().length === 0) {
      return 0;
    }
    return decimalUsdStringToMicros(cacheDiscount);
  }
  throw new ModelProviderError(
    `OpenRouter usage.cost_details.cache_discount must be a number, decimal string, or null (got ${typeof cacheDiscount})`,
    "provider_response_invalid",
    false,
  );
}

/**
 * ITOTORI-232 — extract the `usage` block from an OpenRouter response body
 * and return it as a plain JsonObject suitable for persisting verbatim into
 * `itotori_draft_attempt_provider_ledger.usage_response_json`.
 *
 * Behaviour:
 *
 *   - On a successful call (`failureMarker === null`) the response's full
 *     `usage` object is mirrored verbatim, including `cost`, `cost_details`,
 *     `prompt_tokens_details`, and any caching annotations. This is the
 *     ledger row's load-bearing payload: the DB CHECK (migration 0041)
 *     verifies `cost_amount = usage_response_json->>'cost'` to within 1e-9
 *     USD on every new row. We re-shape only the JSON-incompatible bits
 *     (filtering out symbols / undefined leaves) via {@link jsonValueOrUndefined};
 *     numbers, strings, booleans, arrays, and nested objects survive verbatim.
 *
 *   - On most FAILED calls (`failureMarker` is a sentinel like
 *     `_http_error` / `_response_invalid` / `_pair_mismatch`) we
 *     deliberately STRIP the upstream `cost` field before persisting.
 *     Those failed runs are tagged zero-cost (see
 *     `buildProviderRunRecord`); if we kept the upstream `cost` here,
 *     the partial-NULL CHECK would fire and reject the row (cost_amount=0
 *     ≠ usage.cost). `_cost_cap_exceeded` is the exception: OpenRouter
 *     already completed and billed that response, so the failed audit row
 *     must retain the upstream cost.
 *
 * The returned object is always shaped: caller never sees `undefined`.
 */
function extractUsageResponseJson(
  body: unknown,
  failureMarker:
    | "_http_error"
    | "_response_invalid"
    | "_pair_mismatch"
    | "_cost_cap_exceeded"
    | null,
): JsonObject {
  const usageBlock = isRecord(body) && isRecord(body.usage) ? body.usage : undefined;
  if (usageBlock === undefined) {
    if (failureMarker === null) {
      // A successful call MUST carry usage (normalizeOpenRouterCost will
      // have thrown before we got here if usage.cost was absent); this
      // branch is unreachable but we surface a typed sentinel rather
      // than a silent empty object so a future regression surfaces
      // visibly in the ledger.
      return { _missing_usage: true };
    }
    return { [failureMarker]: true };
  }
  const json: JsonObject = {};
  for (const [key, value] of Object.entries(usageBlock)) {
    // Failure-path strip: never persist upstream `cost` on a zero-cost
    // failure row; the CHECK would reject the equality. Cost-cap failures
    // are already billed, so they retain `cost`.
    if (failureMarker !== null && failureMarker !== "_cost_cap_exceeded" && key === "cost") {
      continue;
    }
    const converted = jsonValueOrUndefined(value);
    if (converted !== undefined) {
      json[key] = converted;
    }
  }
  if (failureMarker !== null) {
    json[failureMarker] = true;
  }
  return json;
}

/**
 * ITOTORI-232 — best-effort coerce a value pulled from the OR response
 * body into a {@link JsonValue}. OpenRouter responses are JSON to begin
 * with so this is just a defensive filter for stray undefined / symbol /
 * function leaves (impossible in practice; the helper exists so the
 * extractor compiles against the strict JsonValue type without `any`).
 */
function jsonValueOrUndefined(value: unknown): JsonValue | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    const arr: JsonValue[] = [];
    for (const entry of value) {
      const converted = jsonValueOrUndefined(entry);
      if (converted !== undefined) {
        arr.push(converted);
      }
    }
    return arr;
  }
  if (typeof value === "object") {
    const obj: JsonObject = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      const converted = jsonValueOrUndefined(raw);
      if (converted !== undefined) {
        obj[key] = converted;
      }
    }
    return obj;
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
  // ITOTORI-230 — typed routing posture for the captured run.
  routingPosture: OpenRouterRoutingPosture;
  // ITOTORI-232 — full `usage` block from the originating OR response,
  // mirrored verbatim onto the run so the recorder can persist it into
  // the ledger row. For LIVE OR successes this carries `cost` as a
  // number equal to ProviderCost.amountMicrosUsd / 1_000_000 (the same
  // upstream value normalizeOpenRouterCost extracted); the DB CHECK
  // (migration 0041) enforces the equality within 1e-9 USD.
  //
  // For zero-cost failure paths (HTTP error, response-invalid, pair
  // mismatch) we still surface whatever `usage` shape the response
  // carried (or an empty `{}` when there was no body at all) — but
  // those runs are tagged zero-cost, so the absence of a `cost` key in
  // the JSON is honest and the CHECK does not fire on them. Cost-cap
  // failures are different: OpenRouter completed and billed the
  // response, so callers pass `cost` and retain `usage.cost`.
  usageResponseJson: JsonObject;
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
    // ITOTORI-225 — zero-cost failures record ZERO_COST rather than the
    // deprecated 'unknown'. Some failed audit rows, such as
    // cost_cap_exceeded, still incurred an upstream bill and pass
    // `input.cost` so accounting remains exact.
    cost: input.cost ?? ZERO_COST,
    routingPosture: input.routingPosture,
    usageResponseJson: input.usageResponseJson,
    prompt: input.request.prompt,
  };
  if (input.request.preset) {
    run.providerPreset = input.request.preset;
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

/**
 * ITOTORI-236 — known-provider registry mapping the lowercase routing
 * slug (the `tag` form used in `provider.only` / `provider.order`) to
 * the TitleCase human-readable `provider_name` that OpenRouter echoes
 * on the response body. Per docs/openrouter-integration.md §9.2 OR
 * carries both forms, so a strict `===` between the request slug and
 * the response provider name spuriously trips the ITOTORI-220 pair
 * check on every legitimate routed call.
 *
 * Entries cover the providers itotori's dev-pair table reaches for
 * (see dev-pair.ts) plus the evidence-backed providerIds declared in
 * presets/localize-project.pair-policy.json. Unknown providers fall through to the
 * case-insensitive comparison in `openRouterProviderIdsMatch` — still
 * safer than the historical strict-equality path and the registry is
 * additive: register new pairs here as they're empirically observed.
 */
const OPENROUTER_KNOWN_PROVIDERS: ReadonlyArray<{
  readonly slug: string;
  readonly name: string;
}> = Object.freeze([
  { slug: "fireworks", name: "Fireworks" },
  { slug: "anthropic", name: "Anthropic" },
  { slug: "google-vertex", name: "Google Vertex" },
  { slug: "openai", name: "OpenAI" },
  { slug: "deepinfra", name: "DeepInfra" },
  { slug: "wafer", name: "Wafer" },
  { slug: "digitalocean", name: "DigitalOcean" },
  { slug: "morph", name: "Morph" },
  { slug: "atlas-cloud", name: "AtlasCloud" },
]);

/**
 * ITOTORI-236 — compare the request's lowercase routing slug against
 * the response's human-readable `provider_name`. Match semantics:
 *
 *   1. If both ends normalize (lowercase) equal → match.
 *   2. If the registry knows a (slug, name) pair where either field
 *      case-insensitively equals one input and the other field
 *      case-insensitively equals the other → match.
 *   3. Otherwise → mismatch (the load-bearing routing-swap signal).
 *
 * Case 1 alone would already be sufficient for the alpha-validation
 * fix; case 2 exists so a future OR rename like "Google Vertex AI"
 * vs slug `google-vertex` is still recognized as the same provider
 * without re-tripping the pair check.
 */
function openRouterProviderIdsMatch(
  requestedProviderId: string,
  observedProviderName: string,
): boolean {
  const requested = requestedProviderId.toLowerCase();
  const observed = observedProviderName.toLowerCase();
  if (requested === observed) {
    return true;
  }
  for (const entry of OPENROUTER_KNOWN_PROVIDERS) {
    const slug = entry.slug.toLowerCase();
    const name = entry.name.toLowerCase();
    if ((requested === slug && observed === name) || (requested === name && observed === slug)) {
      return true;
    }
  }
  return false;
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

const MAX_PROVIDER_ERROR_MESSAGE_LENGTH = 512;
const MAX_PROVIDER_ERROR_CLASS_LENGTH = 96;

function providerNetworkErrorArtifact(input: {
  error: unknown;
  inputClassification: ProviderInputClassification;
}): ProviderRunArtifact["error"] {
  const privateInput = isPrivateInput(input.inputClassification);
  const message = privateInput
    ? "OpenRouter request failed before response"
    : boundedDiagnosticMessage(providerExceptionMessage(input.error));
  return {
    class: "provider_http_error",
    message,
    retryable: true,
    providerErrorClass: "network_error",
  };
}

function providerHttpErrorArtifact(input: {
  body: unknown;
  status: number;
  retryable: boolean;
  inputClassification: ProviderInputClassification;
}): ProviderRunArtifact["error"] {
  const providerErrorClass = providerSafeErrorClass(input.body) ?? `http_${input.status}`;
  const privateInput = isPrivateInput(input.inputClassification);
  const message = privateInput
    ? `OpenRouter HTTP ${input.status} (${providerErrorClass})`
    : boundedDiagnosticMessage(providerErrorMessage(input.body, input.status));

  return {
    class: "provider_http_error",
    message,
    statusCode: input.status,
    retryable: input.retryable,
    providerErrorClass,
  };
}

function providerSafeErrorClass(body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body.error)) {
    return undefined;
  }
  return sanitizedDiagnosticClass(
    optionalString(body.error.code) ?? optionalString(body.error.type),
  );
}

function sanitizedDiagnosticClass(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length > MAX_PROVIDER_ERROR_CLASS_LENGTH) {
    return undefined;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:]*$/u.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function boundedDiagnosticMessage(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= MAX_PROVIDER_ERROR_MESSAGE_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_PROVIDER_ERROR_MESSAGE_LENGTH - 3)}...`;
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
//      This provider does not parse env files directly; shells, direnv,
//      secret managers, or approved local/live launchers must hydrate the
//      process environment first.
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
        `it reads from process.env directly and does not parse env files itself`,
    );
    this.name = "OpenRouterMissingApiKeyError";
  }
}

export class OpenRouterMissingArtifactRecorderError extends Error {
  constructor() {
    super(
      "OpenRouterModelProvider live construction requires a provider-run artifact recorder; pass a persistent recorder so live routing posture and usage metadata are auditably persisted",
    );
    this.name = "OpenRouterMissingArtifactRecorderError";
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
  /** Required artifact recorder for live construction. */
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
// call against the DEV_PAIR (deepseek-v4-flash at fireworks) settles
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
  private readonly capabilityGuard: CapabilityGuard;

  constructor(options: OpenRouterModelProviderOptions = {}) {
    this.apiKeyEnvVar = options.apiKeyEnvVar ?? DEFAULT_API_KEY_ENV_VAR;
    this.costCapUsd = options.costCapUsd ?? DEFAULT_COST_CAP_USD;
    this.rateLimitPerSec = options.rateLimitPerSec ?? DEFAULT_RATE_LIMIT_PER_SEC;

    const envSource: Readonly<Record<string, string | undefined>> = options.env ?? process.env;

    // ITOTORI-227 — assert the account-wide Zero-Data-Retention posture
    // BEFORE any other startup work. The assertion is synchronous and
    // throws AccountZdrAssertionError if the operator has not flagged
    // the OpenRouter dashboard as ZDR-only via
    // OPENROUTER_ZDR_ACCOUNT_ASSERTED=1. This gate is intentionally
    // ahead of the API-key check so a misconfigured live process fails
    // on the privacy posture (the load-bearing one) rather than on the
    // missing-key path. Recorded/replay providers do NOT carry this
    // assertion — they never make a live call.
    assertOpenRouterZdrAccount(envSource);

    const apiKey = envSource[this.apiKeyEnvVar];
    if (apiKey === undefined || apiKey.length === 0) {
      throw new OpenRouterMissingApiKeyError(this.apiKeyEnvVar);
    }

    const recorder = options.artifactRecorder;
    if (recorder === undefined) {
      throw new OpenRouterMissingArtifactRecorderError();
    }
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
    this.capabilityGuard = guard;
  }

  /**
   * ITOTORI-237 — return a per-pair-aware descriptor whose `capabilities`
   * field reflects the (modelId, providerId) sheet registered in the
   * provider's CapabilityGuard at construction.
   *
   * Why this exists: the agentic-loop pre-flight check (see
   * `apps/itotori/src/agents/speaker-label/agent.ts`'s
   * `assertProviderSupportsStructuredOutput`) reads
   * `provider.descriptor.capabilities` directly. The class-level
   * `descriptor` falls back to `openRouterDefaultCapabilities` (safe but
   * `untested` for structured outputs), so without a per-pair lookup the
   * agent refuses even pairs that DO support structured outputs.
   *
   * Unknown pairs (not in dev-pair.ts) intentionally fall back to the
   * default sheet — they keep their `untested` posture and remain
   * refused, preserving the no-silent-fallback invariant.
   */
  descriptorForPair(pair: ModelProviderPair): ProviderDescriptor {
    const capabilities = this.capabilityGuard.has(pair.modelId, pair.providerId)
      ? this.capabilityGuard.lookup(pair.modelId, pair.providerId)
      : this.descriptor.capabilities;
    return { ...this.descriptor, capabilities };
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

    try {
      const result = await this.inner.invoke(request);
      this.recordSpend(result);
      return result;
    } catch (error) {
      if (error instanceof ModelProviderError && error.providerRun !== undefined) {
        this.recordRunSpend(error.providerRun);
      }
      throw error;
    }
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
    this.recordRunSpend(result.providerRun);
  }

  private recordRunSpend(run: ProviderRunRecord): void {
    const cost = run.cost;
    if (cost.amountMicrosUsd === undefined) {
      return;
    }
    // ITOTORI-233 — `cost.amountMicrosUsd` mirrors `usage.cost` verbatim
    // and `usage.cost` is **net of `cache_discount`** per
    // docs/openrouter-integration.md §5.3 / §11 entry 6 (DOC-AMBIGUOUS-6
    // RESOLVED: treat as authoritative billed cost, never recompute).
    // The cost cap therefore consumes the post-discount amount directly;
    // we do NOT subtract `cost.cacheDiscountMicrosUsd` again — that
    // would double-count the discount. The discount is an INFORMATIONAL
    // annotation surfaced through telemetry (see `cache_savings_usd` in
    // apps/itotori/src/telemetry/queries.ts + cli.ts), not an arithmetic
    // input to the cap.
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
