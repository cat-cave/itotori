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

// ITOTORI-227 — itotori's reinvention of OpenRouter's per-pair privacy
// registry was deleted in favour of a three-part posture (see
// docs/openrouter-integration.md §2):
//   (a) the OpenRouter account is ZDR-only at the dashboard level,
//       asserted at process startup via
//       `OPENROUTER_ZDR_ACCOUNT_ASSERTED=1` (see providers/account-zdr.ts),
//   (b) every non-public request body sends `provider.zdr=true` (see
//       providers/openrouter.ts buildOpenRouterProviderRouting), and
//   (c) the response surfaces a 404 envelope if no ZDR provider can
//       serve the call (handled by the existing HTTP-error path).
// The per-pair privacy axes are GONE from `ModelCapabilities` and
// `ProviderRunRecord`.
//
// ITOTORI-230 — (b) is now captured verbatim on every `ProviderRunRecord`
// via `routingPosture: OpenRouterRoutingPosture` (defined below) and
// persisted in the ledger as a `routing_posture jsonb` column. The four
// dead privacy-registry columns ITOTORI-227 left behind on
// itotori_provider_runs and itotori_model_providers were dropped in
// migration 0040 in the same transaction.

/**
 * ITOTORI-230 — the OpenRouter provider-routing block that was on the
 * wire for the call. Captured verbatim on every `ProviderRunRecord` and
 * mirrored on `RecordedProviderResponse` so an offline replay or audit
 * can prove the (a)+(b)+(c) ZDR posture without recapturing the wire.
 *
 * The fields here are the canonical shape from
 * docs/openrouter-integration.md §3 (Provider routing) and
 * docs/openrouter-integration-evidence/2026-06-25.json call_1:
 *   {
 *     order: [preferredProviderId],  // preference, NOT a hard pin
 *     allow_fallbacks: true,         // tolerate transient upstream errors
 *     data_collection: "deny",
 *     zdr: boolean,                  // true for non-public input
 *     require_parameters: boolean    // typically true; mirrors strict mode
 *   }
 *
 * ITOTORI-241 — `order` + `allow_fallbacks: true` replaced the old
 * `only: [providerId]` + `allow_fallbacks: false` hard pin. The pin made
 * a 1-second transient upstream 429 on the single pinned provider a
 * TOTAL failure even though the providers were not down. The reliable,
 * live-proven shape treats the requested provider as a PREFERENCE
 * (`order[0]`) and lets OpenRouter fall back across the account ZDR
 * allow-list. `zdr: true` is what CONFINES that fallback to ZDR-only
 * providers, so reliability is gained without weakening the privacy
 * posture.
 *
 * `data_collection: "deny"` is the wire-level commitment that the
 * upstream provider will not retain the input for training. Combined
 * with `zdr: true` and the account-wide ZDR assertion, this is the
 * three-part posture audit needs to verify ZDR was in force.
 *
 * For non-OpenRouter providers (fake / local-openai-compatible /
 * recorded) the fields are still required: there is no remote provider
 * to send data to in the local/fake case, so `data_collection: "deny"`
 * + `zdr: true` + `allow_fallbacks: false` (nothing to fall back to) is
 * trivially correct. Recorded replays carry the originally-captured
 * posture verbatim (see providers/recorded.ts).
 */
export type OpenRouterRoutingPosture = {
  /**
   * ITOTORI-241 — provider PREFERENCE order. `order[0]` is the preferred
   * upstream; with `allow_fallbacks: true` OpenRouter may route to any
   * other provider in the ZDR allow-list when the preferred one is
   * transiently unavailable. Local/fake providers carry their single
   * provider here (with `allow_fallbacks: false`). Entries are
   * non-empty provider-slug strings.
   */
  order: string[];
  /**
   * ITOTORI-241 — whether OpenRouter may fall back across the ZDR
   * allow-list. `true` on every live OpenRouter call so a transient
   * upstream error on the preferred provider does not fail the request.
   * `false` only for providers that never make a remote call (fake /
   * local-openai-compatible), where there is nothing to fall back to.
   */
  allow_fallbacks: boolean;
  /**
   * Wire-level data-collection commitment. For the canonical ZDR
   * posture this is `"deny"` (the alpha closer never carries anything
   * else). The union admits `"allow"` strictly so the recorded posture
   * is HONEST about a public-input call that opted out of the
   * privacy-preserving default — a posture that always claimed `"deny"`
   * would silently lie about the wire shape, defeating its audit
   * purpose.
   */
  data_collection: "deny" | "allow";
  /**
   * Zero-Data-Retention enforced on the wire (`provider.zdr=true`). With
   * `allow_fallbacks: true` this is also what CONFINES fallback to the
   * account ZDR allow-list, so a fallback can never leak to a non-ZDR
   * provider. Telemetry filters on `routing_posture->>'zdr' = 'true'`.
   */
  zdr: boolean;
  require_parameters: boolean;
};

/**
 * ITOTORI-230 — canonical posture for providers that never make a
 * remote call (fake / local-openai-compatible). The pair pin and
 * `data_collection: "deny"` posture are trivially true (no data leaves
 * the boundary), so we record the canonical-looking shape rather than a
 * sentinel — telemetry queries that filter on
 * `routing_posture->>'zdr' = 'true'` will count these rows as
 * ZDR-enforced, which is the truthful summary for "the call never left
 * the process". `require_parameters` follows the canonical default.
 *
 * Recorded-bundle replays do NOT use this helper — they carry the
 * originally-captured posture verbatim from the bundle.
 */
export function localOnlyRoutingPosture(providerId: string): OpenRouterRoutingPosture {
  return {
    order: [providerId],
    allow_fallbacks: false,
    data_collection: "deny",
    zdr: true,
    require_parameters: true,
  };
}

export type ModelCapabilities = {
  structuredOutputs: StructuredOutputCapabilities;
  toolCalls: ToolCallCapabilities;
  imageInput: ImageInputCapabilities;
  routing: RoutingCapabilities;
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
   * Required by ITOTORI-220 — the PREFERRED upstream provider id.
   * ITOTORI-241: for OpenRouter this is passed as `provider.order[0]`
   * (a preference, not a hard pin) and is the upstream OpenRouter routes
   * to first; with `allow_fallbacks: true` a transiently-unavailable
   * preferred provider may be replaced by another ZDR-allow-list
   * provider. For local/recorded/fake providers this is a stable
   * identifier like `local`, `recorded`, or `fake-fixture`.
   */
  providerId: string;
  messages: ModelMessage[];
  inputClassification: ProviderInputClassification;
  structuredOutput?: StructuredOutputRequest;
  tools?: ModelTool[];
  toolChoice?: ModelToolChoice;
  generation?: ModelGenerationOptions;
  /**
   * Per-invocation USD cap from pair-policy stage posture. OpenRouter
   * adapters mirror this to `provider.max_price.request` and also
   * reject any completed response whose reported `usage.cost` exceeds
   * the same cap.
   */
  maxPriceUsd?: number;
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
  /**
   * ITOTORI-233 — prompt-caching annotations mirrored verbatim from
   * `usage.prompt_tokens_details` on the originating OpenRouter response
   * (see docs/openrouter-integration.md §5.3 and the canonical wire shape
   * in docs/openrouter-integration-evidence/2026-06-25.json call_1).
   *
   * - `cacheReadTokens`: `usage.prompt_tokens_details.cached_tokens` —
   *   "Number of tokens read from the cache (cache hit)" (OR docs).
   *   `cachedInputTokens` above mirrors the legacy top-level
   *   `usage.cached_tokens` shape some providers emit; `cacheReadTokens`
   *   mirrors the canonical OR shape from `prompt_tokens_details`. Both
   *   carry the same semantic when both are present, but we surface them
   *   under distinct names so the captured-from-the-wire field is
   *   greppable without losing the legacy alias.
   * - `cacheWriteTokens`: `usage.prompt_tokens_details.cache_write_tokens`
   *   — "Number of tokens written to the cache" (OR docs). Some providers
   *   omit this field even when caching is in play; absent → undefined →
   *   0 at the storage layer.
   *
   * Implicit-cache evidence is empirically UNAVAILABLE on Trevor's
   * account because the deepseek-tagged endpoint (the only deepseek-v4-flash
   * endpoint advertising `supports_implicit_caching: true`) is excluded
   * from the ZDR allow-list; live capture of a non-zero `cached_tokens`
   * is gated on `OPENROUTER_IMPLICIT_CACHE_PROVIDER` being set to a
   * ZDR-allowed cache-supporting provider.
   */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
};

/**
 * ITOTORI-225 / ITOTORI-134 — `costKind` is `'billed' | 'provider_estimate' | 'zero'`.
 *
 * - `billed`: a real upstream charge. `amountUsd` carries the exact spend
 *   reported by the provider (OpenRouter's `usage.cost`) verbatim;
 *   `amountMicrosUsd` is a derived cap/telemetry mirror. Required.
 * - `provider_estimate` (ITOTORI-134): a deterministic cost ESTIMATE derived
 *   from provider-supplied pricing signals when the authoritative
 *   `usage.cost` is absent — either `usage.cost_details` (the
 *   `upstream_inference_cost` breakdown) or the selected endpoint's per-token
 *   `pricing` multiplied by reported token usage. This is a distinct ledger
 *   cost STATE, never a substitute for `billed`: the real billed cost (if any)
 *   lands later via the cost-reconciler (ITOTORI-235). `amountUsd` /
 *   `amountMicrosUsd` carry the derived estimate; `estimateBasis` records
 *   which fallback produced it (`"cost_details"` | `"endpoint_pricing"`).
 * - `zero`: no charge was incurred (recorded-fixture replays, deterministic
 *   local mocks, failed pre-billing requests). `amountUsd === "0"` and
 *   `amountMicrosUsd === 0`.
 *
 * No `unknown`. No `local_estimate`. ITOTORI-225 purged the legacy
 * guess-based enum; ITOTORI-134 re-introduces `provider_estimate` as a
 * narrowly-scoped, deterministic fallback that records an EXPLICIT estimate
 * (derived from real provider pricing data) rather than fabricating
 * precision or silently undercounting spend.
 *
 * `amountMicrosUsd` is non-optional: every variant carries a real number. A
 * caller cannot omit it.
 */
export type ProviderCost = {
  costKind: "billed" | "provider_estimate" | "zero";
  currency: "USD";
  /**
   * ITOTORI-232 — AUTHORITATIVE full-precision billed cost: the exact
   * decimal-USD string the provider reported (OpenRouter `usage.cost`),
   * carried VERBATIM. This — not `amountMicrosUsd` — is the value the
   * journal persists into `itotori_llm_attempts.cost_usd` alongside the
   * verbatim usage response.
   *
   * Why a string and not just micros: `amountMicrosUsd` rounds to 1e-6
   * resolution and CANNOT represent the sub-micro costs cheap models
   * actually bill (DEV_PAIR deepseek-v4-flash evidence: `usage.cost`
   * `0.00000602`, which `amountMicrosUsd` would round to `0.000006`, a
   * 2e-8 error that a micros-only persistence model loses). `amountMicrosUsd`
   * is therefore a DERIVED, informational value for the cost cap, telemetry
   * aggregates, and dashboards — it is NEVER the persisted journal
   * authority. For `costKind: 'zero'` this is the exact string `"0"`.
   */
  amountUsd: string;
  amountMicrosUsd: number;
  pricingSnapshotId?: string;
  /**
   * ITOTORI-233 — prompt-caching discount mirrored verbatim from
   * `usage.cost_details.cache_discount` on the originating OpenRouter
   * response (see docs/openrouter-integration.md §5.3 and the live
   * evidence at docs/openrouter-integration-evidence/2026-06-25.json
   * call_6 — `cache_discount` is a `number | null` field).
   *
   * DOC-AMBIGUOUS-6 RESOLVED (integration doc §11 entry 6, §5.3):
   * `usage.cost` is treated as authoritative billed cost and is **net**
   * of `cache_discount`; we surface `cache_discount` here as an
   * informational annotation for telemetry ("how much did caching save
   * us"), NOT as an arithmetic input to the cost cap. The cap consumes
   * `amountMicrosUsd` verbatim — see `OpenRouterModelProvider.recordSpend`.
   *
   * Optional at the TS layer (older shapes / non-OR providers omit it),
   * but the storage layer DEFAULTS to 0 NOT NULL on persist (migration
   * 0042). Absent on the wire → 0 here → 0 in the ledger; present →
   * mirrored verbatim via `decimalUsdStringToMicros`.
   */
  cacheDiscountMicrosUsd?: number;
  /**
   * ITOTORI-134 — for `costKind: 'provider_estimate'` only, records which
   * deterministic fallback produced the estimate so the ledger / audit can
   * distinguish the two branches:
   *
   *   - `"cost_details"`: the estimate came from
   *     `usage.cost_details.upstream_inference_cost` (the upstream provider's
   *     own cost breakdown, surfaced when the top-level `usage.cost` is
   *     absent).
   *   - `"endpoint_pricing"`: the estimate came from the selected endpoint's
   *     per-token `pricing` (from `openrouter_metadata.endpoints.available`)
   *     multiplied by the reported `prompt_tokens` / `completion_tokens`.
   *
   * Absent for `costKind: 'billed'` / `costKind: 'zero'` (no estimate basis
   * applies). A `provider_estimate` without an `estimateBasis` is a bug —
   * every estimate branch in `normalizeOpenRouterCost` sets it.
   */
  estimateBasis?: "cost_details" | "endpoint_pricing";
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
  /**
   * ITOTORI-230 — the OpenRouter routing posture the call carried on
   * the wire. Required: every record (LIVE OR, recorded replay, fake,
   * local) MUST surface a posture so the ledger row + telemetry have
   * a uniform shape. See {@link OpenRouterRoutingPosture}.
   */
  routingPosture: OpenRouterRoutingPosture;
  /**
   * ITOTORI-232 — full `usage` block from the originating OpenRouter
   * response (prompt_tokens, completion_tokens, cost, cost_details,
   * prompt_tokens_details with caching annotations). Required and
   * non-optional: every record surfaces the bytes so the ledger CHECK
   * can verify `cost_amount` equals `usage_response_json->>'cost'`
   * within 1e-9 USD on every new row.
   *
   * For LIVE OR runs this MUST carry `cost` as a number (decimal USD)
   * equal to `cost.amountUsd` (the authoritative full-precision decimal;
   * `amountMicrosUsd` is only a derived cap/telemetry mirror) to within
   * 1e-9; the OR adapter populates it from `responseBody.usage` verbatim
   * so the equality holds by construction. Recorded replays mirror the bundle
   * verbatim (bundle schema v3). Fake / local providers that never bill
   * pass an object with no `cost` key (e.g. `{}` or a typed sentinel
   * like `{"_local": true}`); the partial-NULL CHECK exempts these.
   */
  usageResponseJson: JsonObject;
  prompt: PromptPresetReference;
  providerPreset?: ProviderPresetReference;
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
    statusCode?: number;
    retryable?: boolean;
    providerErrorClass?: string;
  };
  adapterMetadata?: JsonObject;
};

export type ProviderRunArtifactRecorder = {
  recordProviderRun(artifact: ProviderRunArtifact): Promise<void>;
};

/**
 * Whether the live provider captures raw request/response bytes for the
 * recorded-artifact pipeline. Live OpenRouter runs default to `disabled`
 * (we record metadata only); the recorded provider passes
 * `not_applicable`. Kept as a closed union (not an open string) so a
 * caller cannot smuggle in an unaudited mode.
 */
export type ProviderRawCaptureMode = "enabled" | "disabled" | "unknown" | "not_applicable";

export type ProviderLiveRunOptions =
  | {
      enabled: false;
    }
  | {
      enabled: true;
      artifactRecorder: ProviderRunArtifactRecorder;
      rawCapture: ProviderRawCaptureMode;
    };

export interface ModelProvider {
  readonly descriptor: ProviderDescriptor;
  invoke(request: ModelInvocationRequest): Promise<ModelInvocationResult>;
}

/**
 * ITOTORI-243 — itotori no longer pins the served provider. The privacy
 * gate is the REQUEST posture (`zdr:true` + `data_collection:deny`); any
 * provider OpenRouter routes to within the ZDR allow-list is a valid serve,
 * recorded as the served (model, providerId) pair. There is therefore no
 * `pair_mismatch` code — provider-identity is no longer a failure axis.
 */
export class ModelProviderError extends Error {
  constructor(
    message: string,
    readonly code:
      | "capability_unsupported"
      | "configuration_error"
      | "cost_cap_exceeded"
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

// A completed physical call can be followed by a local side effect such as
// artifact persistence. Keep its ProviderRunRecord associated with the raw
// thrown value so the physical-call journal can still account for the call.
// This is deliberately opaque: mutating a filesystem Error can fail when it
// is frozen, and a public property would invite unrelated error plumbing to
// treat it as a provider error.
const providerRunByThrownError = new WeakMap<object, ProviderRunRecord>();

/**
 * Preserve a raw post-call error while retaining the physical call it followed.
 * Error objects are returned unchanged, including their original class/code.
 */
export function attachProviderRunToThrownError(
  error: unknown,
  providerRun: ProviderRunRecord,
): unknown {
  if (isObjectLike(error)) {
    providerRunByThrownError.set(error, providerRun);
    return error;
  }

  // JavaScript permits throwing primitives. That cannot carry opaque
  // provenance without a wrapper; normal provider/artifact failures are Error
  // objects and take the identity-preserving branch above.
  const wrapped = new Error("provider post-call side effect threw a non-object value");
  providerRunByThrownError.set(wrapped, providerRun);
  return wrapped;
}

/** Return a physical run retained alongside a typed or raw thrown error. */
export function providerRunFromThrownError(error: unknown): ProviderRunRecord | undefined {
  if (error instanceof ModelProviderError) {
    return error.providerRun;
  }
  return isObjectLike(error) ? providerRunByThrownError.get(error) : undefined;
}

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

let providerRunCounter = 0;

export function createProviderRunId(prefix: string): string {
  providerRunCounter += 1;
  const timestamp = Date.now().toString(36);
  const counter = providerRunCounter.toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${timestamp}-${counter}-${random}`;
}
