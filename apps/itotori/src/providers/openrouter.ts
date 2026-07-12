import { createHash } from "node:crypto";
import { assertOpenRouterZdrAccount } from "./account-zdr.js";
import { recordProviderRunArtifact } from "./artifacts.js";
import {
  assertProviderInvocationSupported,
  globalCapabilityGuard,
  type CapabilityGuard,
  type ProviderRoutingCapabilityRequirement,
} from "./capability-guard.js";
import { knownPairs, type ModelProviderPair } from "./dev-pair.js";
import {
  addDecimalUsd,
  compareDecimalUsd,
  decimalUsdStringCanonical,
  decimalUsdStringToMicros,
  usageCostToDecimalString,
  usageCostToMicros,
  ZERO_COST,
} from "./cost.js";
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
  // ITOTORI-241 — `order` is provider PREFERENCE (not a hard pin). The
  // old `only` field was removed with the allow_fallbacks=false pin: the
  // ZDR allow-list (provider.zdr=true) now bounds the routable set, so
  // there is no itotori-side `only` enumeration to keep in sync.
  order?: string[];
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
  /**
   * ITOTORI-243 follow-up — the per-(modelId, providerId) capability
   * registry the invoke-time guard consults so structured-output modes
   * advertised by a pair's sheet (e.g. DEV_PAIR `json_object`) are not
   * refused against the class-level `openRouterDefaultCapabilities`
   * fallback. Omitted when the inner provider is built standalone; a
   * guard miss falls back to the descriptor capabilities, preserving the
   * no-silent-fallback refusal for unknown pairs.
   */
  capabilityGuard?: CapabilityGuard;
};

export class OpenRouterProvider implements ModelProvider {
  readonly descriptor: ProviderDescriptor;
  private readonly baseUrl: string;
  private readonly apiKey: string | (() => string | undefined) | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly routing: OpenRouterProviderRouting;
  private readonly live: ProviderLiveRunOptions;
  private readonly capabilityGuard: CapabilityGuard | undefined;

  constructor(options: OpenRouterProviderOptions) {
    this.baseUrl = options.baseUrl ?? "https://openrouter.ai/api/v1";
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.routing = options.routing ?? {};
    this.live = options.live;
    this.capabilityGuard = options.capabilityGuard;
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
    // ITOTORI-243 — request.providerId leads the provider PREFERENCE
    // `order` (order[0]); it is NOT a hard pin. With `allow_fallbacks:true`
    // + `zdr:true` on the wire, OpenRouter may serve ANY ZDR-allow-list
    // provider, and whichever one actually answers is recorded as the
    // served (model, providerId) pair below — there is no request-time pin.
    const providerRouting = buildOpenRouterProviderRouting(this.routing, request);
    // ITOTORI-230 — typed restatement of the same posture for the
    // ledger / recorded-bundle audit trail. Derived from the same
    // routing block we put on the wire (above), not synthesized
    // separately, so the two cannot drift.
    const routingPosture = openRouterRoutingPostureFromBlock(
      providerRouting,
      request.inputClassification,
    );
    // ITOTORI-243 follow-up — the invoke-time capability guard must consult
    // the per-(modelId, providerId) sheet registered in the singleton
    // CapabilityGuard (the same sheet the agentic loop's structured-mode
    // selector reads via `descriptorForPair`), NOT the class-level
    // `openRouterDefaultCapabilities` fallback. Without this, a pair whose
    // sheet advertises `json_object` (e.g. DEV_PAIR via Fireworks) is
    // refused at invoke time with "structured output mode json_object is
    // untested for provider", even though the agent legitimately selected
    // `json_object` from that very sheet. Unknown pairs (guard miss) keep
    // the default `untested` posture and stay refused — the
    // no-silent-fallback invariant is preserved.
    const pairCapabilities =
      this.capabilityGuard !== undefined &&
      this.capabilityGuard.has(requestedModelId, request.providerId)
        ? this.capabilityGuard.lookup(requestedModelId, request.providerId)
        : this.descriptor.capabilities;
    assertProviderInvocationSupported({
      descriptor: this.descriptor,
      capabilities: pairCapabilities,
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
        ...(request.signal !== undefined ? { signal: request.signal } : {}),
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
      await recordProviderRunArtifact({
        recorder: this.live.artifactRecorder,
        providerRun: run,
        artifact: buildArtifact({
          request,
          run,
          rawCapture: this.live.rawCapture,
          error: providerNetworkErrorArtifact({
            error,
            inputClassification: request.inputClassification,
          }),
          adapterMetadata: metadata,
        }),
      });
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
      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
      const metadata: JsonObject = {
        ...adapterMetadata(body, providerRouting),
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      };
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
      await recordProviderRunArtifact({
        recorder: this.live.artifactRecorder,
        providerRun: run,
        artifact: buildArtifact({
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
      });
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
      // Semantic shape can be malformed after OpenRouter has already billed
      // the request. Recover `usage.cost` independently of choices/message
      // normalization so a malformed HTTP-200 never launders a paid call to
      // zero. If the billing field itself is absent/invalid, mark it unknown;
      // the durable reservation intentionally remains conservative.
      const recoveredBilledCost = recoverBilledCostFromResponse(body);
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
        ...(recoveredBilledCost === undefined ? {} : { cost: recoveredBilledCost }),
        billingState: recoveredBilledCost === undefined ? "unknown" : "known",
        routingPosture,
        usageResponseJson: extractUsageResponseJson(
          body,
          "_response_invalid",
          recoveredBilledCost !== undefined,
        ),
      });
      await recordProviderRunArtifact({
        recorder: this.live.artifactRecorder,
        providerRun: run,
        artifact: buildArtifact({
          request,
          run,
          rawCapture: this.live.rawCapture,
          error: {
            class: "provider_response_invalid",
            message: providerExceptionMessage(error),
          },
          adapterMetadata: metadata,
        }),
      });
      throw new ModelProviderError(
        `OpenRouter response was invalid: ${providerExceptionMessage(error)}`,
        "provider_response_invalid",
        false,
        run,
        metadata,
      );
    }
    // ITOTORI-243 — RECORD THE TRUTH, do not pin. There is no post-response
    // provider-identity guard. The privacy gate is the REQUEST posture
    // (`zdr:true` + `data_collection:deny`, enforced in
    // `openRouterRoutingPostureFromBlock` for any private input): with
    // `zdr:true` on the wire OpenRouter can only have served a ZDR-allow-list
    // provider (otherwise it returns the 404 ZDR envelope), so whichever
    // provider actually answered is a valid serve. Strict provider-pinning +
    // a post-response provider-identity throw were a needless formality with
    // no operational security. A provider-side route change remains recorded
    // transport provenance; run retry and pause policy belong to the
    // supervisor. The real served
    // (model, providerId) pair — `normalized.actualModelId` /
    // `normalized.upstreamProvider`, read verbatim from the response — and
    // the real billed cost (`normalized.cost`, costKind:"billed" from
    // `usage.cost`) flow straight into the succeeded run below. Any fallback
    // OpenRouter performed is still auditable: `adapterMetadata` mirrors the
    // response's `openrouter_metadata` (attempt / attempts / summary) onto
    // `adapterMetadata.openrouterRouting`.
    const maxPriceUsd = request.maxPriceUsd;
    if (maxPriceUsd !== undefined) {
      const maxPriceExactUsd = maxPriceUsdToDecimalString(maxPriceUsd);
      // This is an exact decimal comparison. `amountMicrosUsd` is a display
      // mirror only: using it here can round a paid sub-micro call to zero.
      if (compareDecimalUsd(normalized.cost.amountUsd, maxPriceExactUsd) > 0) {
        const metadata = {
          ...adapterMetadata(body, providerRouting),
          localMaxPriceUsd: maxPriceUsd,
          actualCostUsd: normalized.cost.amountUsd,
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
          billingState: normalized.cost.costKind === "billed" ? "known" : "unknown",
          routingPosture,
          usageResponseJson: extractUsageResponseJson(body, "_cost_cap_exceeded"),
        });
        await recordProviderRunArtifact({
          recorder: this.live.artifactRecorder,
          providerRun: run,
          artifact: buildArtifact({
            request,
            run,
            rawCapture: this.live.rawCapture,
            error: {
              class: "cost_cap_exceeded",
              message: `OpenRouter response cost $${normalized.cost.amountUsd} exceeded pair-policy maxPriceUsd $${maxPriceExactUsd}`,
            },
            adapterMetadata: metadata,
          }),
        });
        throw new ModelProviderError(
          `OpenRouter response cost $${normalized.cost.amountUsd} exceeded pair-policy maxPriceUsd $${maxPriceExactUsd}`,
          "cost_cap_exceeded",
          false,
          run,
          metadata,
        );
      }
    }
    // ITOTORI-132 — surface OpenRouter's router `attempt` counter so
    // `buildProviderRunRecord` can derive a coherent `retryCount` for an
    // OR-side fallback (attempt>1 → retries = attempt-1). Without this the
    // live ledger recorded `retryCount:0` even when OpenRouter fell back
    // across the ZDR allow-list, disagreeing with `fallbackUsed:true` and
    // the recorded-fixture semantics (retryCount:1). Absent on a direct
    // serve (attempt=1 or no metadata) → 0 retries, unchanged.
    const providerAttempt = openRouterAttemptCount(body);
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
      billingState: normalized.cost.costKind === "billed" ? "known" : "unknown",
      routingPosture,
      ...(providerAttempt !== undefined ? { providerAttempt } : {}),
      // ITOTORI-232 — mirror the response's `usage` block verbatim onto
      // the run so the recorder persists it into the ledger row. The
      // `cost` field in this object is the same upstream value
      // normalizeOpenRouterCost extracted; the DB CHECK enforces that
      // `cost_amount = usage_response_json->>'cost'` within 1e-9 USD.
      usageResponseJson: extractUsageResponseJson(body, null),
    });
    const metadata = adapterMetadata(body, providerRouting);
    await recordProviderRunArtifact({
      recorder: this.live.artifactRecorder,
      providerRun: run,
      artifact: buildArtifact({
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
    });
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

/**
 * ITOTORI-241 — does this request require `provider.require_parameters:true`
 * on the wire? True whenever the body carries something a fallback provider
 * could silently ignore: a `response_format` (json_schema OR json_object),
 * a forced structured tool call, or any tools[].
 *
 * json_object is INCLUDED (was the audit-P2 gap): a `json_object` call
 * sends `response_format:{type:"json_object"}`, so with fallback ON it must
 * be confined to providers that honour `response_format` — otherwise the
 * agentic loop could degrade onto a provider that ignores it and returns
 * unconstrained prose. Including it ALSO removes the posture/wire drift:
 * `openRouterRoutingPostureFromBlock` defaults an absent `require_parameters`
 * to `true`, so omitting the field on the wire while recording it `true`
 * meant the ledger disagreed with the bytes that actually went out. Both
 * the wire and the recorded posture now carry `require_parameters:true` for
 * json_object. `plain_json` is intentionally excluded: it emits no
 * `response_format`, so there is nothing for a provider to ignore.
 */
function structuredOutputRequiresStrictParameters(request: ModelInvocationRequest): boolean {
  return (
    request.structuredOutput?.mode === "json_schema" ||
    request.structuredOutput?.mode === "json_object" ||
    request.structuredOutput?.mode === "tool_call_arguments" ||
    Boolean(request.tools?.length)
  );
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
    allow_fallbacks: posture.allow_fallbacks,
    data_collection: posture.data_collection,
  };
  // ITOTORI-241 — emit `order` (provider PREFERENCE), never the old
  // `only` hard pin. order[0] is the preferred upstream; with
  // allow_fallbacks:true OpenRouter may route to another ZDR-allow-list
  // provider when the preferred one is transiently unavailable. We do
  // NOT enumerate `only`: zdr:true (below) is what enforces the
  // allow-list, so the membership self-updates as the account ZDR set
  // changes — no itotori-side provider registry to drift.
  if (posture.order.length > 0) {
    provider.order = posture.order;
  }
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
  if (structuredOutputRequiresStrictParameters(request)) {
    provider.require_parameters = true;
  } else if (routing.requireParameters !== undefined) {
    provider.require_parameters = routing.requireParameters;
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
    // OpenRouter's `provider.max_price.request` is the per-request USD
    // ceiling (docs/openrouter-integration.md §3.2; OpenRouter
    // provider-preferences `max_price: {prompt?, completion?, request?,
    // image?}`). Validate the cap up-front so a malformed value fails
    // before the request goes out, then emit the value VERBATIM as a JSON
    // number — that is the documented, honoured wire shape; nothing is
    // approximated or reformatted.
    assertValidMaxPriceUsd(request.maxPriceUsd);
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
 *   - order: `[request.providerId, ...routing.order]` (de-duplicated) —
 *     the ITOTORI-241 provider PREFERENCE. order[0] is the preferred
 *     upstream; it is NOT a hard pin. `request.providerId` always leads
 *     so the requested provider is tried first.
 *   - allow_fallbacks: `true` — a transient upstream error on the
 *     preferred provider must not fail the whole call. zdr:true confines
 *     the fallback pool to the account ZDR allow-list.
 *   - data_collection: `"deny"` for any private input; mirrors
 *     `routing.dataCollection` for public input (defaults to `"deny"`).
 *     A caller-explicit `"allow"` for public inputs is honoured so the
 *     captured posture is HONEST about the wire shape.
 *   - zdr: `true` by default for non-public inputs (ITOTORI-227); a
 *     caller override is honoured verbatim. `public` inputs default
 *     to `false` (no zdr on the wire) unless caller asks.
 *   - require_parameters: `true` whenever the request carries a
 *     `response_format` (json_schema OR json_object), a forced structured
 *     tool, or any tools — see `structuredOutputRequiresStrictParameters`;
 *     otherwise mirrors the caller, defaulting to `false` (i.e. the wire
 *     OMITS the field, OpenRouter's not-required default) when the caller is
 *     silent. This keeps the recorded posture byte-identical to
 *     `buildOpenRouterProviderRouting` — a silent-caller `plain_json`
 *     fallback omits require_parameters on the wire precisely so the ZDR
 *     pool is not narrowed, and the posture must not claim otherwise. When
 *     strict mode DOES apply this is load-bearing: it confines fallback to
 *     providers that actually support the request's tools / response_format
 *     so the agentic loop cannot silently degrade onto a provider that
 *     ignores them.
 */
function buildOpenRouterRoutingPosture(
  routing: OpenRouterProviderRouting,
  request: ModelInvocationRequest,
): OpenRouterRoutingPosture {
  // ITOTORI-241 — provider PREFERENCE order. The requested providerId
  // always leads; any caller-configured routing.order entries follow as
  // additional preferences. De-duplicated, preserving first-seen order.
  const order = [...new Set([request.providerId, ...(routing.order ?? [])])];
  const dataCollection = dataCollectionForRequest(
    routing.dataCollection,
    request.inputClassification,
  );
  // ITOTORI-227 — zdr default: true for non-public input, mirrors caller
  // otherwise. Posture records the boolean explicitly (the wire shape
  // skips the field for public input; both are recoverable from the
  // posture + classification).
  const zdr = routing.zdr !== undefined ? routing.zdr : request.inputClassification !== "public";
  // ITOTORI-241 / plain-json-fallback-under-zdr — the recorded posture MUST
  // match the bytes on the wire (buildOpenRouterProviderRouting): the wire
  // emits provider.require_parameters ONLY when strict mode applies OR the
  // caller set it explicitly, and OMITS it otherwise (OpenRouter then treats
  // it as not-required). A `plain_json` fallback is exactly this omitted
  // case — recording `true` here while the wire omits the field would be the
  // very posture/wire drift ITOTORI-241 removed for json_object, and would
  // misreport a call whose whole point is NOT to narrow the ZDR pool. So the
  // silent-caller default mirrors the wire's omission (not-required).
  const requireParameters = structuredOutputRequiresStrictParameters(request)
    ? true
    : (routing.requireParameters ?? false);
  return {
    order,
    allow_fallbacks: true,
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
function openRouterRoutingPostureFromBlock(
  block: JsonObject,
  inputClassification: ProviderInputClassification,
): OpenRouterRoutingPosture {
  const order = block.order;
  // ITOTORI-241 — `order` (provider preference) is the canonical field;
  // every entry must be a non-empty provider-slug string.
  if (
    !Array.isArray(order) ||
    order.length === 0 ||
    !order.every((entry) => typeof entry === "string" && entry.length > 0)
  ) {
    throw new ModelProviderError(
      "OpenRouter routing posture 'order' must be a non-empty array of non-empty strings",
      "configuration_error",
      false,
    );
  }
  if (typeof block.allow_fallbacks !== "boolean") {
    throw new ModelProviderError(
      "OpenRouter routing posture allow_fallbacks must be a boolean",
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
  // ITOTORI-241 — ZDR is the privacy gate. Any genuinely-private input
  // (private_corpus / confidential) MUST carry zdr=true on the wire so
  // fallback (now enabled) can never leak to a non-ZDR provider. This
  // replaces the old allow_fallbacks=false invariant.
  if (isPrivateInput(inputClassification) && zdr !== true) {
    throw new ModelProviderError(
      `OpenRouter routing posture must enforce zdr=true for non-public input (classification '${inputClassification}')`,
      "configuration_error",
      false,
    );
  }
  // plain-json-fallback-under-zdr — the posture MUST equal the bytes: when
  // the wire block OMITS require_parameters (the `plain_json` ZDR fallback,
  // whose whole point is to NOT narrow the pool), OpenRouter treats it as
  // not-required, so the recorded posture is `false`. Defaulting an absent
  // field to `true` here was the posture/wire drift — it made the ledger
  // claim a pool-narrowing the bytes never sent.
  const requireParameters =
    typeof block.require_parameters === "boolean" ? block.require_parameters : false;
  return {
    order: order as string[],
    allow_fallbacks: block.allow_fallbacks,
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

function assertValidMaxPriceUsd(value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new ModelProviderError(
      `maxPriceUsd must be a finite non-negative number, got ${String(value)}`,
      "configuration_error",
      false,
    );
  }
}

function maxPriceUsdToDecimalString(value: number): string {
  assertValidMaxPriceUsd(value);
  return usageCostToDecimalString(value);
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
 * ITOTORI-225 / ITOTORI-233 / ITOTORI-134 — real-cost normalizer with
 * cache-aware annotations and deterministic cost-estimate fallbacks.
 *
 * Per docs/openrouter-integration.md §5 (canonical real-cost contract) and
 * the live evidence at docs/openrouter-integration-evidence/2026-06-25.json,
 * every successful OpenRouter response carries `usage.cost` as a decimal
 * USD value. The preferred path is `usage.cost`-or-error: a successful HTTP
 * response with `usage.cost` tags `costKind: 'billed'` and carries the
 * verbatim amount.
 *
 * ITOTORI-134 — when `usage.cost` is ABSENT, two deterministic cost-ESTIMATE
 * fallback branches produce `costKind: 'provider_estimate'` (a distinct
 * ledger cost STATE, never a silent substitute for `billed`):
 *
 *   1. `cost_details` branch: `usage.cost_details.upstream_inference_cost`
 *      (the upstream provider's own cost breakdown) is present → use it as
 *      the estimate (`estimateBasis: 'cost_details'`).
 *   2. endpoint-pricing branch: the selected endpoint (from
 *      `openrouter_metadata.endpoints.available[].selected`) carries
 *      per-token `pricing.prompt` / `pricing.completion`, and `usage`
 *      carries `prompt_tokens` / `completion_tokens` → multiply and sum
 *      (`estimateBasis: 'endpoint_pricing'`).
 *
 * If NEITHER `usage.cost` NOR any fallback pricing signal is available, the
 * call surfaces `provider_response_invalid` — responses without enough
 * pricing data remain EXPLICIT instead of fabricating precision (the
 * third ITOTORI-134 acceptance criterion).
 *
 * ITOTORI-233 / DOC-AMBIGUOUS-6 RESOLVED (integration doc §11 entry 6,
 * §5.3): `usage.cost` is **net of `cache_discount`** by treaty — we treat
 * it as authoritative billed cost and **never recompute**. The durable
 * run-cost account reconciles exact `amountUsd`; `cache_discount` is
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
  // Branch 1 (preferred): direct usage.cost → billed.
  if (usage !== undefined && usage.cost !== undefined && usage.cost !== null) {
    const cost: ProviderCost = {
      costKind: "billed",
      currency: "USD",
      // ITOTORI-232 — authoritative full-precision cost, the verbatim
      // `usage.cost`. This is what the ledger persists and the
      // migration-0041 CHECK validates; `amountMicrosUsd` below is the
      // rounded informational mirror for display / telemetry only.
      amountUsd: usageCostToDecimalString(usage.cost),
      amountMicrosUsd: usageCostToMicros(usage.cost),
      cacheDiscountMicrosUsd: extractCacheDiscountMicros(usage),
    };
    return cost;
  }
  // ITOTORI-134 — Branch 2: cost_details estimate → provider_estimate.
  // `usage.cost` is absent; fall back to the upstream provider's own cost
  // breakdown (`upstream_inference_cost`) when it is present. This is a
  // deterministic value the provider surfaced, NOT a fabrication.
  if (usage !== undefined) {
    const detailsEstimate = estimateFromCostDetails(usage);
    if (detailsEstimate !== undefined) {
      const cost: ProviderCost = {
        costKind: "provider_estimate",
        currency: "USD",
        amountUsd: detailsEstimate.decimalString,
        amountMicrosUsd: detailsEstimate.micros,
        estimateBasis: "cost_details",
        cacheDiscountMicrosUsd: extractCacheDiscountMicros(usage),
      };
      return cost;
    }
  }
  // ITOTORI-134 — Branch 3: endpoint-pricing × tokens → provider_estimate.
  // Neither `usage.cost` nor a usable `cost_details` is present; fall back to
  // the selected endpoint's per-token pricing multiplied by reported token
  // usage. Requires BOTH a pricing block and non-zero token counts.
  const pricingEstimate = estimateFromEndpointPricing(response);
  if (pricingEstimate !== undefined) {
    const cost: ProviderCost = {
      costKind: "provider_estimate",
      currency: "USD",
      amountUsd: pricingEstimate.decimalString,
      amountMicrosUsd: pricingEstimate.micros,
      estimateBasis: "endpoint_pricing",
    };
    return cost;
  }
  // Branch 4: no cost data of any kind → protocol violation. Responses
  // without enough pricing data remain EXPLICIT instead of fabricating
  // precision (ITOTORI-134 acceptance criterion #3).
  throw new ModelProviderError(
    "OpenRouter response missing usage.cost and no deterministic cost-estimate fallback (cost_details / endpoint pricing) was available; cannot record spend without real pricing data",
    "provider_response_invalid",
    false,
  );
}

/**
 * Recover a settled OpenRouter bill without requiring a semantically valid
 * chat-completions envelope. This deliberately reads only `usage.cost`; a
 * malformed choice/message must not erase a charge that OpenRouter returned.
 */
function recoverBilledCostFromResponse(body: unknown): ProviderCost | undefined {
  if (!isRecord(body) || !isRecord(body.usage)) return undefined;
  const usage = body.usage;
  if (usage.cost === undefined || usage.cost === null) return undefined;
  try {
    const cost: ProviderCost = {
      costKind: "billed",
      currency: "USD",
      amountUsd: usageCostToDecimalString(usage.cost),
      amountMicrosUsd: usageCostToMicros(usage.cost),
    };
    // Cache metadata is informational. A malformed cache_discount must not
    // discard the independently valid settled bill.
    try {
      cost.cacheDiscountMicrosUsd = extractCacheDiscountMicros(usage);
    } catch {
      // Preserve the exact billed amount; the malformed metadata remains in
      // usageResponseJson for forensic reconciliation.
    }
    return cost;
  } catch {
    return undefined;
  }
}

/**
 * ITOTORI-134 — extract a deterministic cost estimate from
 * `usage.cost_details.upstream_inference_cost` when the top-level
 * `usage.cost` is absent.
 *
 * The canonical `cost_details` shape (docs/openrouter-integration.md §5.2,
 * evidence file call_1) carries `upstream_inference_cost` as a USD decimal
 * number — the upstream provider's own inference charge BEFORE any
 * OpenRouter-side caching discount. When `usage.cost` is absent but this
 * field is present, it is the most precise estimate available (it is the
 * provider's real charge, not a recomputation). Returns `undefined` when
 * `cost_details` / `upstream_inference_cost` is absent or not a usable
 * number/string, so the caller can fall through to endpoint-pricing.
 */
function estimateFromCostDetails(usage: Record<string, unknown>):
  | {
      decimalString: string;
      micros: number;
    }
  | undefined {
  const costDetails = usage.cost_details;
  if (!isRecord(costDetails)) {
    return undefined;
  }
  const upstream = costDetails.upstream_inference_cost;
  if (upstream === undefined || upstream === null) {
    return undefined;
  }
  // Reuse the same validation + conversion path as usage.cost so a
  // non-numeric / negative value throws `provider_response_invalid` rather
  // than silently producing NaN.
  return {
    decimalString: usageCostToDecimalString(upstream),
    micros: usageCostToMicros(upstream),
  };
}

/**
 * ITOTORI-134 — derive a deterministic cost estimate from the selected
 * endpoint's per-token pricing multiplied by reported token usage, when
 * neither `usage.cost` nor `cost_details` is available.
 *
 * The selected endpoint record (from `openrouter_metadata.endpoints.available`,
 * surfaced by the `X-OpenRouter-Metadata: enabled` request header) carries a
 * `pricing` block whose `prompt` / `completion` fields are USD-per-token
 * decimal strings (docs/openrouter-integration.md §9.1: "pricing.prompt /
 * pricing.completion are USD per token as decimal strings", e.g. `"0.00000014"`).
 * The estimate is `prompt_tokens × pricing.prompt + completion_tokens ×
 * pricing.completion`, computed via the lossless `addDecimalUsd` helper so
 * sub-micro precision survives.
 *
 * Requires ALL of: a selected endpoint with a `pricing` block carrying
 * numeric `prompt` + `completion`, AND `usage.prompt_tokens` /
 * `usage.completion_tokens` present. Returns `undefined` when any input is
 * absent so the caller can surface the explicit `provider_response_invalid`
 * diagnostic rather than fabricating a partial estimate.
 */
function estimateFromEndpointPricing(response: Record<string, unknown>):
  | {
      decimalString: string;
      micros: number;
    }
  | undefined {
  const endpoint = selectedOpenRouterEndpoint(response);
  if (endpoint === undefined) {
    return undefined;
  }
  const pricing = endpoint.pricing;
  if (!isRecord(pricing)) {
    return undefined;
  }
  const promptPrice = pricing.prompt;
  const completionPrice = pricing.completion;
  if (
    promptPrice === undefined ||
    promptPrice === null ||
    completionPrice === undefined ||
    completionPrice === null
  ) {
    return undefined;
  }
  const usage = isRecord(response.usage) ? response.usage : undefined;
  if (usage === undefined) {
    return undefined;
  }
  const promptTokens = usage.prompt_tokens;
  const completionTokens = usage.completion_tokens;
  if (
    typeof promptTokens !== "number" ||
    !Number.isFinite(promptTokens) ||
    typeof completionTokens !== "number" ||
    !Number.isFinite(completionTokens)
  ) {
    return undefined;
  }
  // Validate the per-token prices via the canonical decimal-string parser
  // (rejects negative / non-decimal) before multiplying. Prices are USD per
  // token as decimal strings or numbers.
  const promptDecimal = tokenPriceToDecimalString(promptPrice, "pricing.prompt");
  const completionDecimal = tokenPriceToDecimalString(completionPrice, "pricing.completion");
  const promptCost = multiplyDecimalByInteger(promptDecimal, promptTokens);
  const completionCost = multiplyDecimalByInteger(completionDecimal, completionTokens);
  const total = addDecimalUsd(promptCost, completionCost);
  return {
    decimalString: total,
    micros: decimalUsdStringToMicros(total),
  };
}

/**
 * ITOTORI-134 — coerce a per-token price (string or number) into the
 * canonical decimal-USD string form, validating it is a plain non-negative
 * decimal. Mirrors `usageCostToDecimalString` but is named for the
 * endpoint-pricing context so the throw site is self-locating.
 */
function tokenPriceToDecimalString(value: unknown, label: string): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return decimalUsdStringCanonical(value.toFixed(12));
  }
  if (typeof value === "string") {
    return decimalUsdStringCanonical(value);
  }
  throw new ModelProviderError(
    `OpenRouter endpoint ${label} must be a number or decimal string, got ${typeof value}`,
    "provider_response_invalid",
    false,
  );
}

/**
 * ITOTORI-134 — losslessly multiply a non-negative decimal-USD string by a
 * non-negative integer token count, returning the canonical decimal-USD
 * product. Operates on the scaled-integer representation via BigInt so there
 * is no floating-point drift; mirrors `addDecimalUsd`'s precision posture.
 */
function multiplyDecimalByInteger(decimal: string, count: number): string {
  const canonical = decimalUsdStringCanonical(decimal);
  const [whole = "0", fractional = ""] = canonical.split(".");
  const scale = fractional.length;
  const scaledInteger = BigInt(whole + fractional);
  const product = scaledInteger * BigInt(Math.trunc(count));
  if (scale === 0) {
    return product.toString();
  }
  const digits = product.toString().padStart(scale + 1, "0");
  const productWhole = digits.slice(0, digits.length - scale);
  const productFrac = digits.slice(digits.length - scale);
  const trimmedFrac = productFrac.replace(/0+$/u, "");
  return trimmedFrac.length > 0 ? `${productWhole}.${trimmedFrac}` : productWhole;
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
export function extractCacheDiscountMicros(usage: Record<string, unknown>): number {
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
 * `itotori_llm_attempts.usage_response_json`.
 *
 * Behaviour:
 *
 *   - On a successful call (`failureMarker === null`) the response's full
 *     `usage` object is mirrored verbatim, including `cost`, `cost_details`,
 *     `prompt_tokens_details`, and any caching annotations. This is the
 *     journal attempt's load-bearing payload. We re-shape only the
 *     JSON-incompatible bits
 *     (filtering out symbols / undefined leaves) via {@link jsonValueOrUndefined};
 *     numbers, strings, booleans, arrays, and nested objects survive verbatim.
 *
 *   - Failed responses preserve `usage.cost` only when the adapter recovered
 *     a valid settled bill independently of semantic success. A malformed
 *     HTTP-200 can therefore reconcile a real charge; a missing/invalid bill
 *     remains explicitly unknown and keeps its reservation conservative.
 *
 * The returned object is always shaped: caller never sees `undefined`.
 */
function extractUsageResponseJson(
  body: unknown,
  failureMarker: "_http_error" | "_response_invalid" | "_cost_cap_exceeded" | null,
  preserveSettledCost = false,
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
    if (
      failureMarker !== null &&
      failureMarker !== "_cost_cap_exceeded" &&
      !preserveSettledCost &&
      key === "cost"
    ) {
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
  /** Omitted only when no settled billing fact was available. */
  billingState?: "known" | "unknown";
  // ITOTORI-132 — OpenRouter's 1-indexed router `attempt` counter from the
  // response's `openrouter_metadata.attempt`. attempt=1 means the preferred
  // provider (order[0]) served directly; attempt=2 means OpenRouter advanced
  // past one transiently-unavailable provider to the next ZDR-allow-list one.
  // Used to derive a coherent `retryCount` for an OR-side fallback. Only
  // threaded on the succeeded path (error paths leave it undefined → 0).
  providerAttempt?: number;
  // ITOTORI-230 — typed routing posture for the captured run.
  routingPosture: OpenRouterRoutingPosture;
  // ITOTORI-232 — full `usage` block from the originating OR response,
  // mirrored verbatim onto the run so the recorder can persist it into
  // the ledger row. For LIVE OR successes this carries `cost` as a
  // number equal to ProviderCost.amountUsd (the authoritative full-
  // precision decimal normalizeOpenRouterCost carried verbatim) within
  // 1e-9 USD, which is what the DB CHECK (migration 0041) enforces.
  // `amountMicrosUsd / 1_000_000` is NOT the equality/CHECK basis — it
  // rounds to 1e-6 and is only a derived cap/telemetry mirror.
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
  // ITOTORI-242 — fallbackUsed must reflect BOTH a model-level fallback
  // (the served model differs from the requested model within a multi-
  // entry fallback plan) AND a provider-level ZDR fallback. With OR-side
  // fallback ON (allow_fallbacks:true), a 429 on the preferred provider
  // (order[0]) makes OpenRouter serve a DIFFERENT ZDR-allow-list provider
  // while keeping the same model — a provider swap that the old model-only
  // check missed entirely. It must read as fallbackUsed:true so recorded
  // transport provenance remains honest. This is telemetry, NOT application
  // resilience: the pair_mismatch guard is gone, so this
  // NEVER rejects a non-preferred ZDR serve. The served provider
  // (input.upstreamProvider, read verbatim from the response) is compared
  // to the preferred order[0] under casing/version normalization so a
  // legit slug↔display-name shape ('fireworks' ↔ 'Fireworks') or a dated
  // snapshot suffix does NOT read as a false fallback.
  const modelFallbackUsed =
    fallbackPlan.length > 1 && input.actualModelId !== input.requestedModelId;
  const providerFallbackUsed = servedProviderDiffersFromPreferred(
    input.upstreamProvider,
    input.routingPosture.order[0],
  );
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
    // ITOTORI-132 — `retryCount` is derived from OpenRouter's router
    // `attempt` counter on a successful serve: attempt=1 (preferred served
    // directly, or attempt absent) → 0 retries; attempt=2 → 1 fallback;
    // attempt=n → n-1. This keeps the live ledger coherent with
    // `fallbackUsed` and the recorded-fixture semantics (retryCount:1 for a
    // fallback). Error paths omit `providerAttempt` and stay 0: a failed run
    // produced no successful retry to count.
    retryCount: input.providerAttempt !== undefined ? Math.max(0, input.providerAttempt - 1) : 0,
    errorClasses: input.errorClasses,
    fallbackUsed: modelFallbackUsed || providerFallbackUsed,
    fallbackPlan,
    tokenUsage: input.tokenUsage,
    // The ProviderCost shape retains `ZERO_COST` for artifact compatibility,
    // but `billingState` prevents an absent settlement from releasing a durable
    // reservation as though it were a confirmed free call.
    cost: input.cost ?? ZERO_COST,
    billingState:
      input.billingState ??
      (input.cost?.costKind === "billed" || input.cost?.costKind === "zero" ? "known" : "unknown"),
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
  // ITOTORI-235 — capture the generation id (the chat-completions response's
  // top-level `id`, e.g. `gen-1782395748-…`) so a later cost reconciliation
  // can re-fetch the canonical settled cost from
  // `GET /api/v1/generation?id=` and compare it to the ledger's cost_amount
  // (see providers/openrouter-cost-reconciler.ts). This is the ONLY place the
  // generation id is surfaced onto the recorded artifact / invocation result:
  // the `usage` block mirrored into the ledger's usage_response_json does not
  // carry it. Absent / non-string id (offline / local / fake providers) → not
  // recorded.
  if (isRecord(body) && typeof body.id === "string" && body.id.length > 0) {
    metadata.generationId = body.id;
  }
  if (isRecord(body) && isJsonValue(body.openrouter_metadata)) {
    metadata.openrouterMetadata = body.openrouter_metadata;
    // ITOTORI-241 — surface the router-metadata fallback-observability
    // fields (`summary`, `attempts`) explicitly so they land in the
    // recorded ledger as a first-class, queryable shape. With fallback
    // now ON (allow_fallbacks:true), a future "429" report can read
    // `adapterMetadata.openrouterRouting.attempts` to see whether
    // OpenRouter fell back across the ZDR allow-list and which providers
    // it tried. Absent on a standard chat-completions body (the X-
    // OpenRouter-Metadata header is sent at request time, ~line 143);
    // when present it is mirrored verbatim, never synthesized.
    if (isRecord(body.openrouter_metadata)) {
      const routing: Record<string, JsonValue> = {};
      if (isJsonValue(body.openrouter_metadata.summary)) {
        routing.summary = body.openrouter_metadata.summary;
      }
      // OpenRouter live chat-completions carry the fallback counter as
      // `attempt` (singular, 0 = served by the preferred provider with no
      // fallback). Some routing strategies also carry an `attempts` list;
      // capture whichever is present so a "429" report can see whether
      // fallback engaged and how many providers were tried.
      if (isJsonValue(body.openrouter_metadata.attempt)) {
        routing.attempt = body.openrouter_metadata.attempt;
      }
      if (isJsonValue(body.openrouter_metadata.attempts)) {
        routing.attempts = body.openrouter_metadata.attempts;
      }
      if (isJsonValue(body.openrouter_metadata.strategy)) {
        routing.strategy = body.openrouter_metadata.strategy;
      }
      if (Object.keys(routing).length > 0) {
        metadata.openrouterRouting = routing;
      }
    }
  }
  return metadata as JsonObject;
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) return undefined;
  return Math.max(0, instant - Date.now());
}

function fallbackPlanForRequest(
  request: ModelInvocationRequest,
  requestedModelId: string,
): string[] {
  return Array.from(new Set([requestedModelId, ...(request.fallbackModels ?? [])]));
}

/**
 * ITOTORI-242 — true when OpenRouter served a provider that genuinely
 * differs from the preferred order[0], i.e. a real provider-level ZDR
 * fallback fired. Returns false when either side is absent (no served
 * provider recorded, or no routing preference) or when the only difference
 * is provider-id casing or a trailing version/snapshot suffix — those are
 * legit slug↔display-name shapes, NOT a fallback.
 */
function servedProviderDiffersFromPreferred(
  served: string | undefined,
  preferred: string | undefined,
): boolean {
  if (served === undefined || preferred === undefined) {
    return false;
  }
  return normalizeProviderIdForComparison(served) !== normalizeProviderIdForComparison(preferred);
}

/**
 * Casing/version-insensitive provider-id key. OpenRouter echoes the
 * human-readable provider name (e.g. `Fireworks`) while the routing
 * `order` carries the lowercase slug (`fireworks`); some ids also carry a
 * trailing version/snapshot token or a parenthetical index. Lowercasing
 * and stripping those trailing tokens keeps a legit slug↔display-name (or
 * dated-snapshot) diff from reading as a provider fallback. OR provider
 * slugs never end in a bare version number (e.g. `01-ai`, `deepinfra`,
 * `digitalocean` end in letters), so the trailing-version strip cannot
 * collapse two distinct providers.
 */
function normalizeProviderIdForComparison(id: string): string {
  return (
    id
      .trim()
      .toLowerCase()
      // strip a trailing parenthetical index/annotation, e.g. `digitalocean (6)`.
      .replace(/\s*\([^)]*\)\s*$/, "")
      // strip a trailing version/date-snapshot token, e.g. `-v2`, `@2024-01-01`.
      .replace(/[\s@:_/-]*v?\d+(?:[._-]\d+)*$/, "")
      .replace(/[\s_/-]+$/, "")
      .trim()
  );
}

function selectedOpenRouterProvider(body: unknown): string | undefined {
  const selected = selectedOpenRouterEndpoint(body);
  const fromMetadata = optionalString(selected?.provider);
  if (fromMetadata !== undefined) {
    return fromMetadata;
  }
  // Fallback: OpenRouter chat-completions echoes the actual upstream
  // provider on the top-level `provider` field (string id). ITOTORI-243
  // records this as the served (model, providerId) pair when
  // `openrouter_metadata` is absent (which is the live-mode default).
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
 * ITOTORI-132 — read OpenRouter's 1-indexed router `attempt` counter from the
 * response's `openrouter_metadata.attempt`. attempt=1 means the preferred
 * provider served directly (no fallback); attempt=2 means OpenRouter advanced
 * past one transiently-unavailable provider. Returns `undefined` when the
 * metadata is absent or the `attempt` field is not a positive integer, so the
 * caller can leave `retryCount` at 0 (the no-metadata / direct-serve case).
 */
function openRouterAttemptCount(body: unknown): number | undefined {
  if (!isRecord(body) || !isRecord(body.openrouter_metadata)) {
    return undefined;
  }
  const attempt = body.openrouter_metadata.attempt;
  if (typeof attempt === "number" && Number.isInteger(attempt) && attempt > 0) {
    return attempt;
  }
  return undefined;
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
// routing block, and recording the served (model, providerId) pair) and
// layers on two
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
//   2. Token-bucket rate limit at `rateLimitPerSec`. InvocationSupervisor
//      acquires the token before the durable cost-reservation transaction;
//      direct fixture/admin calls acquire it in `invoke()`.
//
// Cost caps do NOT live in this process. The journal's exact-decimal account
// atomically reserves and reconciles each run, so concurrent processes share
// one authoritative admission decision.
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

export type OpenRouterHttpClient = typeof fetch;

export type OpenRouterModelProviderOptions = {
  /** Env var to read for the API key. Defaults to `OPENROUTER_API_KEY`. */
  apiKeyEnvVar?: string;
  /** Token-bucket rate (rps). Default `1.0`. */
  rateLimitPerSec?: number;
  /** Optional injection for unit tests (defaults to global `fetch`). */
  httpClient?: OpenRouterHttpClient;
  /** Optional injection of the rate-token clock (test-only). */
  now?: () => number;
  /** Optional injection of the rate-token sleep (test-only). */
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
// Default run-level cap used by policy parsing. The durable Postgres account,
// not this transport process, owns admission and reconciliation.
export const DEFAULT_COST_CAP_USD = 0.5;
const DEFAULT_RATE_LIMIT_PER_SEC = 1.0;
const OPENROUTER_RATE_TOKEN_ACQUIRED = Symbol("itotori.openrouter.rate-token");

export class OpenRouterModelProvider implements ModelProvider {
  readonly descriptor: ProviderDescriptor;
  readonly rateLimitPerSec: number;
  readonly apiKeyEnvVar: string;
  private readonly inner: OpenRouterProvider;
  private readonly bucket: TokenBucket;
  private readonly capabilityGuard: CapabilityGuard;

  constructor(options: OpenRouterModelProviderOptions = {}) {
    this.apiKeyEnvVar = options.apiKeyEnvVar ?? DEFAULT_API_KEY_ENV_VAR;
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

    // Register every known-pair capability sheet into the singleton
    // CapabilityGuard so orchestrator code calling
    // globalCapabilityGuard().lookup(modelId, providerId) succeeds for
    // any pair from dev-pair.ts without per-call registration. Resolve +
    // populate the guard BEFORE constructing the inner provider so the
    // same registered sheets back the inner's invoke-time capability
    // check (ITOTORI-243 follow-up).
    const guard = options.capabilityGuard ?? globalCapabilityGuard();
    for (const entry of knownPairsForRegistration()) {
      guard.register(entry.pair.modelId, entry.pair.providerId, entry.modelCapabilities);
    }
    this.capabilityGuard = guard;

    // The inner OpenRouterProvider does request shaping and recording; this
    // wrapper owns only transport rate tokens and env configuration. Run-cost
    // admission is deliberately durable and lives above the transport.
    // modelId on the descriptor is "openrouter" because the provider
    // is multi-model — actual modelId per call comes from the request.
    this.inner = new OpenRouterProvider({
      modelId: "openrouter",
      providerName: options.providerName ?? "openrouter",
      ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
      apiKey,
      fetch: options.httpClient ?? globalThis.fetch,
      live: { enabled: true, artifactRecorder: recorder, rawCapture: "disabled" },
      capabilityGuard: guard,
    });
    this.descriptor = this.inner.descriptor;
  }

  /**
   * ITOTORI-237 — return a per-pair-aware descriptor whose `capabilities`
   * field reflects the (modelId, providerId) sheet registered in the
   * provider's CapabilityGuard at construction.
   *
   * Why this exists: the agentic-loop structured-mode selection (see
   * `apps/itotori/src/agents/speaker-label/agent.ts`'s
   * `resolveStructuredOutput`, which calls `selectStructuredOutputRequest`)
   * reads `provider.descriptor.capabilities` directly. The class-level
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

  async preflightInvocation(request: ModelInvocationRequest): Promise<{ admitted: true }> {
    // InvocationSupervisor calls this before durable cost reservation. Keep a
    // symbol on the request so the later invoke consumes this exact token
    // rather than acquiring a second one; object-spread adapter layers retain
    // enumerable symbol keys.
    await this.bucket.acquire();
    (request as ModelInvocationRequest & { [OPENROUTER_RATE_TOKEN_ACQUIRED]?: true })[
      OPENROUTER_RATE_TOKEN_ACQUIRED
    ] = true;
    return { admitted: true };
  }

  async invoke(request: ModelInvocationRequest): Promise<ModelInvocationResult> {
    const tokenWasPrepared =
      (request as ModelInvocationRequest & { [OPENROUTER_RATE_TOKEN_ACQUIRED]?: true })[
        OPENROUTER_RATE_TOKEN_ACQUIRED
      ] === true;
    // Direct fixture/admin calls still receive rate limiting. Production
    // supervised calls have already acquired their token before reservation.
    if (!tokenWasPrepared) await this.bucket.acquire();
    return await this.inner.invoke(request);
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
