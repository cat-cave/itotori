// no-provider-name invariant — DEV_PAIR is a MODEL-ONLY dev default.
//
// Trevor's decisive routing ruling (2026-07-15): NO provider is EVER named
// in production routing — not as a rigid `only:[...]` pin, and not even as a
// soft `order:[preferredProvider]` preference. A dev-mode call is fully
// specified by (a) a MODEL id and (b) a capability + ZDR/privacy + fallback
// POLICY:
//   - capabilities we need (structured/JSON output, typed tool-calling,
//     reasoning) enforced via `require_parameters`,
//   - our privacy contract (`zdr:true` + `data_collection:"deny"`, backed by
//     the account-wide ZDR allow-list), and
//   - `allow_fallbacks:true`.
// OpenRouter then picks the upstream provider PURELY on capability + ZDR +
// price. The (model, provider) pair that actually served a call is a RECORDED
// OUTPUT (for honesty / cost / telemetry — see `ProviderRunRecord.provider
// .upstreamProvider`, read verbatim from the response), NEVER a routing INPUT.
//
// This is why `DEV_PAIR` carries ONLY a `modelId`. The previous constant
// pinned `providerId: "fireworks"` as `order[0]`; even with
// `allow_fallbacks:true` that NAMED a provider in the routing policy, which
// the invariant forbids. `fireworks` (and every other slug) is now something
// we may only READ BACK from a response, never write into a request.
//
// Model choice — `deepseek/deepseek-v4-flash`:
//   - Catalog match. The OpenRouter catalog lookup at
//     /api/v1/models/deepseek/deepseek-v4-flash/endpoints (captured at
//     docs/openrouter-integration-evidence/2026-06-25.json, alphaPairCatalog)
//     returns 18 endpoints; canonical slug is
//     `deepseek/deepseek-v4-flash-20260423`.
//   - Structured output under ZDR. Live testing proved that
//     `response_format: { type: "json_schema" }` (strict AND non-strict) AND
//     `response_format: { type: "json_object" }` are UNROUTABLE under ZDR for
//     this model: the account ZDR allow-list ∩ providers advertising a
//     structured `response_format` is EMPTY, so `require_parameters: true`
//     narrows the routable pool to empty (HTTP 404 "No endpoints found that
//     can handle the requested parameters"). The only ZDR-routable
//     deterministic mode is a PLAIN completion (`plain_json`) — no
//     `response_format` / no `require_parameters`, so the pool is not narrowed
//     (verified HTTP 200). The agentic loop selects it via
//     selectStructuredOutputRequest; the schema is enforced by the caller's
//     bounded-repair + strict post-parse validation. The capability sheet
//     below therefore marks BOTH `jsonSchema` AND `jsonObject` `unsupported`
//     for this ZDR-routed model. See
//     itotori-structured-output-plain-json-fallback-under-zdr and the
//     ZDR-fallback audit 2026-07-04.
//   - Implicit caching is forgone as the price of ZDR (the only endpoint that
//     advertised it is excluded from the account ZDR allow-list — call_3 in
//     the evidence file returned HTTP 404 "No endpoints found matching your
//     data policy").
//
// The capability sheets are keyed by MODEL (not by a (model, provider) pair):
// under the account-wide ZDR posture we do NOT choose the upstream provider,
// so the routable capability floor is a property of the model under our ZDR
// allow-list, not of any single named provider. The other entries cover the
// two production-tier models we reach for when DEV_PAIR isn't appropriate.

import type { ModelCapabilities } from "./types.js";
import { openRouterDefaultCapabilities } from "./openrouter.js";

/**
 * The MODEL used by every itotori dev-mode agent invocation. Imported by
 * name — never typed as a string literal in agent code. No provider is
 * named: routing is capability + ZDR + fallback only, and the served
 * provider is a recorded output of each call.
 */
export const DEV_PAIR: { readonly modelId: string } = Object.freeze({
  modelId: "deepseek/deepseek-v4-flash",
});

/**
 * The capability + privacy + fallback POLICY that, together with
 * `DEV_PAIR.modelId`, fully specifies a dev-mode call — with NO `order` and
 * NO `only`, so no provider is named. `requireParameters` is decided
 * per-call (strict for the structured modes the request carries); the wire
 * sets `provider.require_parameters` from that, which is how we enforce the
 * capabilities we need WITHOUT naming who must satisfy them.
 */
export const DEV_ROUTING_POLICY: {
  readonly allowFallbacks: true;
  readonly zdr: true;
  readonly dataCollection: "deny";
} = Object.freeze({
  allowFallbacks: true,
  zdr: true,
  dataCollection: "deny",
});

/**
 * Lightweight capability summary surfaced to the orchestrator when it
 * picks structured-output modes / context budgets at request time. The
 * shape intentionally avoids re-deriving the full ModelCapabilities
 * record: those live in the per-model capability table below.
 */
export type DevPairCapabilities = {
  readonly supportsStructuredOutput: boolean;
  readonly supportsToolUse: boolean;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
};

/**
 * A (model, provider) pair as a RECORDED identity — e.g. what a response
 * reported as the served pair. Never a routing input. Retained for callers
 * that describe an already-served pair (telemetry, experiment reports).
 */
export type ModelProviderPair = {
  readonly modelId: string;
  readonly providerId: string;
};

type ModelCapabilityEntry = {
  modelId: string;
  capabilities: DevPairCapabilities;
  modelCapabilities: ModelCapabilities;
};

// Lazy-initialised to dodge the circular import with openrouter.ts:
// openrouter.ts imports `knownModels` from here, and this module imports
// `openRouterDefaultCapabilities` from openrouter.ts. We MUST NOT read
// the imported binding at module init; instead, build the table on
// first call.
let CACHED_TABLE: ReadonlyArray<ModelCapabilityEntry> | undefined;
let CACHED_INDEX: Map<string, ModelCapabilityEntry> | undefined;

function buildModelCapabilityTable(): ReadonlyArray<ModelCapabilityEntry> {
  return [
    {
      modelId: DEV_PAIR.modelId,
      capabilities: {
        supportsStructuredOutput: true,
        supportsToolUse: true,
        contextWindowTokens: 128_000,
        maxOutputTokens: 8_192,
      },
      modelCapabilities: {
        ...openRouterDefaultCapabilities,
        structuredOutputs: {
          // plain-json-fallback-under-zdr — BOTH `json_schema` and
          // `json_object` are UNROUTABLE under ZDR for this model: the account
          // ZDR allow-list ∩ providers that advertise a structured
          // `response_format` is EMPTY for deepseek/deepseek-v4-flash, so
          // `require_parameters:true` narrows the routable pool to empty for
          // EITHER response_format (HTTP 404 "No endpoints found that can
          // handle the requested parameters"). Both are therefore
          // `unsupported` for THIS (ZDR-routed) model regardless of what the
          // bare model can do off-ZDR. The only ZDR-routable mode is a PLAIN
          // completion (`plain_json`): no response_format / no
          // require_parameters, so the pool is not narrowed (verified HTTP
          // 200). The agentic loop selects it via selectStructuredOutputRequest;
          // the schema is enforced by the caller's bounded-repair + strict
          // post-parse validation.
          jsonSchema: "unsupported",
          jsonObject: "unsupported",
          toolCallArguments: "supported",
          plainJsonExtraction: "supported",
          preferredModes: ["plain_json", "tool_call_arguments"],
        },
        toolCalls: {
          support: "supported",
          parallelToolCalls: "partial",
          requiresSchemaPerRequest: true,
        },
        imageInput: { support: "unsupported" },
        routing: {
          ...openRouterDefaultCapabilities.routing,
          providerRouting: "supported",
          modelFallbacks: "supported",
          presets: "supported",
          requireParameters: "supported",
          dataCollectionControl: "supported",
          zeroDataRetentionRouting: "supported",
        },
        contextWindowTokens: 128_000,
        maxOutputTokens: 8_192,
        notes: [
          // The capability sheet describes deepseek/deepseek-v4-flash under
          // the account-wide ZDR allow-list — no provider is named. Live
          // evidence for the ZDR-routable profile:
          // docs/openrouter-integration-evidence/2026-06-25.json (HTTP 200 on
          // plain_json; HTTP 404 on json_schema/json_object under ZDR).
          // Canonical doc: docs/openrouter-integration.md §9.3.
          "deepseek/deepseek-v4-flash ZDR-routable profile: plain_json only (json_schema/json_object 404 under ZDR). No provider named; served provider is a recorded output. Doc: docs/openrouter-integration.md §9.3.",
        ],
      },
    },
    {
      modelId: "anthropic/claude-sonnet-4",
      capabilities: {
        supportsStructuredOutput: true,
        supportsToolUse: true,
        contextWindowTokens: 200_000,
        maxOutputTokens: 8_192,
      },
      modelCapabilities: {
        ...openRouterDefaultCapabilities,
        structuredOutputs: {
          jsonSchema: "supported",
          jsonObject: "supported",
          toolCallArguments: "supported",
          plainJsonExtraction: "supported",
          preferredModes: ["tool_call_arguments", "json_schema", "json_object", "plain_json"],
        },
        toolCalls: {
          support: "supported",
          parallelToolCalls: "supported",
          requiresSchemaPerRequest: true,
        },
        imageInput: { support: "supported" },
        routing: {
          ...openRouterDefaultCapabilities.routing,
          providerRouting: "supported",
          modelFallbacks: "supported",
          presets: "supported",
          requireParameters: "supported",
          dataCollectionControl: "supported",
          zeroDataRetentionRouting: "supported",
        },
        contextWindowTokens: 200_000,
        maxOutputTokens: 8_192,
      },
    },
    {
      modelId: "google/gemini-2.5",
      capabilities: {
        supportsStructuredOutput: true,
        supportsToolUse: true,
        contextWindowTokens: 1_000_000,
        maxOutputTokens: 8_192,
      },
      modelCapabilities: {
        ...openRouterDefaultCapabilities,
        structuredOutputs: {
          jsonSchema: "supported",
          jsonObject: "supported",
          toolCallArguments: "partial",
          plainJsonExtraction: "supported",
          preferredModes: ["json_schema", "json_object", "plain_json", "tool_call_arguments"],
        },
        toolCalls: {
          support: "supported",
          parallelToolCalls: "supported",
          requiresSchemaPerRequest: true,
        },
        imageInput: { support: "supported" },
        routing: {
          ...openRouterDefaultCapabilities.routing,
          providerRouting: "supported",
          modelFallbacks: "supported",
          presets: "supported",
          requireParameters: "supported",
          dataCollectionControl: "supported",
          zeroDataRetentionRouting: "supported",
        },
        contextWindowTokens: 1_000_000,
        maxOutputTokens: 8_192,
      },
    },
  ];
}

function getTable(): ReadonlyArray<ModelCapabilityEntry> {
  if (CACHED_TABLE === undefined) {
    CACHED_TABLE = buildModelCapabilityTable();
  }
  return CACHED_TABLE;
}

function getIndex(): Map<string, ModelCapabilityEntry> {
  if (CACHED_INDEX === undefined) {
    CACHED_INDEX = new Map(getTable().map((entry) => [entry.modelId, entry] as const));
  }
  return CACHED_INDEX;
}

/**
 * Thrown when a caller asks for capabilities for a model that has not
 * been measured + registered. Falling back to a "best guess" sheet
 * would re-introduce the silent-fallback failure mode ITOTORI-220
 * removed; instead the orchestrator is forced to either register the
 * model explicitly or fail loudly.
 */
export class DevPairUnknownError extends Error {
  constructor(readonly modelId: string) {
    super(
      `no known capability sheet for modelId=${modelId}; register the model in dev-pair.ts before using it`,
    );
    this.name = "DevPairUnknownError";
  }
}

/**
 * Return the small DevPairCapabilities summary for a known model.
 * Throws DevPairUnknownError on miss — no silent fallback.
 */
export function getCapabilities(modelId: string): DevPairCapabilities {
  const entry = getIndex().get(modelId);
  if (entry === undefined) {
    throw new DevPairUnknownError(modelId);
  }
  return entry.capabilities;
}

/**
 * Return the full ModelCapabilities sheet for a known model, suitable
 * for CapabilityGuard.register(). Throws on miss.
 */
export function getModelCapabilities(modelId: string): ModelCapabilities {
  const entry = getIndex().get(modelId);
  if (entry === undefined) {
    throw new DevPairUnknownError(modelId);
  }
  return entry.modelCapabilities;
}

/**
 * Iterate the known-model table — used by OpenRouterModelProvider to
 * register every model into the global CapabilityGuard at construction
 * time so the orchestrator's CapabilityGuard.lookup(modelId) returns
 * table data for any production-tier model without per-call registration.
 */
export function knownModels(): ReadonlyArray<{
  modelId: string;
  modelCapabilities: ModelCapabilities;
}> {
  return getTable().map((entry) => ({
    modelId: entry.modelId,
    modelCapabilities: entry.modelCapabilities,
  }));
}
