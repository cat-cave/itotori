// ITOTORI-221 — DEV_PAIR constant + minimal known-good capability table.
//
// Per the standing feedback-model-provider-pair rule and the alpha gap
// analysis (docs/proposals/alpha-gap-analysis-2026-06-24.md §3 — ITOTORI-
// NEW-Bopen), the dev-time (modelId, providerId) pair MUST be a hard-coded
// constant. Deferring it to `process.env.DEV_PAIR_MODEL_ID` defeats the
// pin: the env var becomes a silent escape hatch where a caller can swap
// pairs without a commit-visible change. Therefore: the constant lives in
// code, the choice is justified in this comment, and changes require a
// real PR.
//
// Why deepseek/deepseek-v4-flash with `fireworks` as the PREFERRED
// provider (ITOTORI-241 reframe of the ITOTORI-226 evidence-grounded
// pair; replaces the prior invented slug that was never in OpenRouter's
// catalog — see docs/audits/openrouter-wiring-audit-2026-06-25.md §3-A):
//
//   ITOTORI-241 — `providerId` is the PREFERRED provider (`order[0]`),
//   NOT a hard pin. The live request now sends
//   `provider: { order: ["fireworks"], zdr: true, allow_fallbacks: true,
//   data_collection: "deny", require_parameters: <strict> }`. OpenRouter
//   routes to Fireworks first; if Fireworks is transiently unavailable
//   (e.g. a 1-second upstream 429) OpenRouter falls back across the
//   account ZDR allow-list rather than failing the whole call. The
//   fallback set is NOT enumerated here: `zdr: true` confines it to the
//   account's ZDR-only providers, so it self-updates as that allow-list
//   changes. `fireworks` is dated 2026-06-25 as the validated preferred
//   provider (evidence below); revisiting the preference requires a real
//   commit + fresh live capture.
//
//   - Catalog match. The OpenRouter catalog lookup at
//     /api/v1/models/deepseek/deepseek-v4-flash/endpoints (captured at
//     docs/openrouter-integration-evidence/2026-06-25.json,
//     alphaPairCatalog) returns 18 endpoints; canonical slug is
//     `deepseek/deepseek-v4-flash-20260423`. The `fireworks` endpoint IS
//     in that list (tag='fireworks') AND is in Trevor's ZDR allow-list.
//     See also docs/openrouter-integration.md §9.3.
//   - Preferred provider verified live. The evidence file's call_1
//     (label `call_1_baseline_zdr_alpha_pair`) posted
//     {model: "deepseek/deepseek-v4-flash", provider: { zdr: true, ... }}
//     and received HTTP 200 with `body.provider === "Fireworks"` — i.e.
//     the request routed to and was billed by Fireworks under the
//     corrected slug. Under the ITOTORI-241 posture Fireworks remains
//     order[0]; the difference is that a transient Fireworks outage now
//     yields another ZDR-allow-list provider instead of a total failure.
//   - Pricing on Fireworks (from the same alphaPairCatalog block):
//     prompt $0.00000014/token (≈$0.14/Mtok), completion $0.00000028/
//     token (≈$0.28/Mtok). A 4k-prompt+1k-completion QA call costs
//     ~$0.00084, so the ITOTORI-231 DEFAULT_COST_CAP_USD ($0.5) admits
//     ~600 such calls — well above any single agentic-loop run.
//   - Implicit caching is NOT supported on the Fireworks endpoint
//     (alphaPairCatalog.fireworks_supports_implicit_caching === false).
//     The `deepseek` endpoint does advertise it
//     (deepseek_supports_implicit_caching === true) but is excluded
//     from Trevor's ZDR allow-list — empirically proven by call_3 in
//     the same evidence file (HTTP 404, "No endpoints found matching
//     your data policy"). We forgo implicit caching as the price of
//     staying within ZDR; the preferred-provider + fallback posture is
//     orthogonal to caching.
//   - JSON-schema structured output. Catalog and live capture confirm
//     `response_format: { type: "json_schema" }` is accepted by
//     Fireworks-hosted deepseek-v4-flash at this slug; with fallback now
//     ON, `provider.require_parameters: true` (set on every structured /
//     tool request) confines any fallback to ZDR providers that also
//     support `response_format` so the agentic loop cannot silently
//     degrade onto one that ignores it (openrouter-integration.md §4.2).
//
// Other entries in the table cover the two production-tier pairs we
// reach for when DEV_PAIR isn't appropriate (e.g. high-stakes manual
// reruns); they exist so CapabilityGuard registration works for them
// without each caller having to invent a capability sheet.

import type { ModelCapabilities } from "./types.js";
import { openRouterDefaultCapabilities } from "./openrouter.js";

/**
 * The (modelId, providerId) pair used by every itotori dev-mode agent
 * invocation. Imported by name — never typed as a string literal in
 * agent code. The audit check enforced by ITOTORI-221 (`git grep
 * -nE "'fireworks'|\"fireworks\""` outside this file) confirms there
 * are no provider id literals scattered across the agent surface.
 *
 * ITOTORI-241 — `providerId` is the PREFERRED provider (`order[0]` on
 * the wire), not a hard pin. The orchestrator passes it as
 * `request.providerId`; the OpenRouter provider maps it to
 * `provider.order=[providerId]` with `allow_fallbacks: true` + `zdr:
 * true`, so a transient Fireworks outage falls back across the account
 * ZDR allow-list instead of failing the call.
 */
export const DEV_PAIR: { readonly modelId: string; readonly providerId: string } = Object.freeze({
  modelId: "deepseek/deepseek-v4-flash",
  providerId: "fireworks",
});

/**
 * Lightweight capability summary surfaced to the orchestrator when it
 * picks structured-output modes / context budgets at request time. The
 * shape intentionally avoids re-deriving the full ModelCapabilities
 * record: those live in the per-pair capability table below.
 */
export type DevPairCapabilities = {
  readonly supportsStructuredOutput: boolean;
  readonly supportsToolUse: boolean;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
};

export type ModelProviderPair = {
  readonly modelId: string;
  readonly providerId: string;
};

type PairCapabilityEntry = {
  pair: ModelProviderPair;
  capabilities: DevPairCapabilities;
  modelCapabilities: ModelCapabilities;
};

// Lazy-initialised to dodge the circular import with openrouter.ts:
// openrouter.ts imports `knownPairs` from here, and this module imports
// `openRouterDefaultCapabilities` from openrouter.ts. We MUST NOT read
// the imported binding at module init; instead, build the table on
// first call.
let CACHED_TABLE: ReadonlyArray<PairCapabilityEntry> | undefined;
let CACHED_INDEX: Map<string, PairCapabilityEntry> | undefined;

function pairKey(pair: ModelProviderPair): string {
  return `${pair.modelId}::${pair.providerId}`;
}

function buildPairCapabilityTable(): ReadonlyArray<PairCapabilityEntry> {
  return [
    {
      pair: DEV_PAIR,
      capabilities: {
        supportsStructuredOutput: true,
        supportsToolUse: true,
        contextWindowTokens: 128_000,
        maxOutputTokens: 8_192,
      },
      modelCapabilities: {
        ...openRouterDefaultCapabilities,
        structuredOutputs: {
          jsonSchema: "supported",
          jsonObject: "supported",
          toolCallArguments: "supported",
          plainJsonExtraction: "supported",
          preferredModes: ["json_schema", "tool_call_arguments", "json_object", "plain_json"],
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
          // ITOTORI-226 (2026-06-25): the slug correction landed; this
          // capability sheet describes the catalog-correct
          // deepseek/deepseek-v4-flash pair with Fireworks as the
          // PREFERRED provider. Live evidence — call_1 in
          //   docs/openrouter-integration-evidence/2026-06-25.json
          // — confirms HTTP 200 with body.provider === "Fireworks" under
          // provider.zdr=true. ITOTORI-241 reframed the wire posture to
          // provider.order=["fireworks"] + allow_fallbacks=true (no hard
          // pin); ZDR confines any fallback to the account allow-list.
          // ITOTORI-224 owns the canonical doc + evidence capture; see
          // docs/openrouter-integration.md §9.3 for the catalog row.
          "ITOTORI-226 (2026-06-25): slug correction landed (deepseek/deepseek-v4-flash on fireworks). Live evidence: docs/openrouter-integration-evidence/2026-06-25.json call_1 (HTTP 200, body.provider === 'Fireworks'). Canonical doc: docs/openrouter-integration.md §9.3.",
        ],
      },
    },
    {
      pair: { modelId: "anthropic/claude-sonnet-4", providerId: "anthropic" },
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
      pair: { modelId: "google/gemini-2.5", providerId: "google-vertex" },
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

function getTable(): ReadonlyArray<PairCapabilityEntry> {
  if (CACHED_TABLE === undefined) {
    CACHED_TABLE = buildPairCapabilityTable();
  }
  return CACHED_TABLE;
}

function getIndex(): Map<string, PairCapabilityEntry> {
  if (CACHED_INDEX === undefined) {
    CACHED_INDEX = new Map(getTable().map((entry) => [pairKey(entry.pair), entry] as const));
  }
  return CACHED_INDEX;
}

/**
 * Thrown when a caller asks for capabilities for a pair that has not
 * been measured + registered. Falling back to a "best guess" sheet
 * would re-introduce the silent-fallback failure mode ITOTORI-220
 * removed; instead the orchestrator is forced to either register the
 * pair explicitly or fail loudly.
 */
export class DevPairUnknownError extends Error {
  constructor(
    readonly modelId: string,
    readonly providerId: string,
  ) {
    super(
      `no known capability sheet for (modelId=${modelId}, providerId=${providerId}); register the pair in dev-pair.ts before using it`,
    );
    this.name = "DevPairUnknownError";
  }
}

/**
 * Return the small DevPairCapabilities summary for a known pair.
 * Throws DevPairUnknownError on miss — no silent fallback.
 */
export function getCapabilities(pair: ModelProviderPair): DevPairCapabilities {
  const entry = getIndex().get(pairKey(pair));
  if (entry === undefined) {
    throw new DevPairUnknownError(pair.modelId, pair.providerId);
  }
  return entry.capabilities;
}

/**
 * Return the full ModelCapabilities sheet for a known pair, suitable
 * for CapabilityGuard.register(). Throws on miss.
 */
export function getModelCapabilities(pair: ModelProviderPair): ModelCapabilities {
  const entry = getIndex().get(pairKey(pair));
  if (entry === undefined) {
    throw new DevPairUnknownError(pair.modelId, pair.providerId);
  }
  return entry.modelCapabilities;
}

/**
 * Iterate the known-pair table — used by OpenRouterModelProvider to
 * register every pair into the global CapabilityGuard at construction
 * time so the orchestrator's CapabilityGuard.lookup(modelId, providerId)
 * returns table data for any production-tier pair without per-call
 * registration.
 */
export function knownPairs(): ReadonlyArray<{
  pair: ModelProviderPair;
  modelCapabilities: ModelCapabilities;
}> {
  return getTable().map((entry) => ({
    pair: entry.pair,
    modelCapabilities: entry.modelCapabilities,
  }));
}
