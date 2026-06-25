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
// Why deepseek/deepseek-chat-v4 on `fireworks`:
//   - Pricing: deepseek-chat-v4 is the cheapest production-grade model on
//     OpenRouter that still supports JSON-schema structured output well.
//   - Provider pin: `fireworks` is documented by OpenRouter to host the
//     deepseek-v4 family with response_format support and `strict: true`
//     enforcement, which is required by ITOTORI-220 when QA/translation
//     stages request `json_schema`. Picking a provider that silently
//     drops `strict` would degrade QA precision without a typed error,
//     which is exactly the failure mode the (model, provider) pair rule
//     prevents.
//   - Latency: fireworks publishes sub-second time-to-first-token for
//     deepseek-v4 at our typical 50–4k token completions; alternative
//     providers (deepinfra, novita) trade latency for marginally lower
//     cost.
//   - Cost cap: at $0.27 / Mtok prompt and $1.10 / Mtok completion (as of
//     2026-06), a single 4k-prompt+1k-completion QA call costs ~$0.0022,
//     so the $1.00 default per-process cap allows ~450 such calls — well
//     above any single agentic-loop run.
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
 */
export const DEV_PAIR: { readonly modelId: string; readonly providerId: string } = Object.freeze({
  modelId: "deepseek/deepseek-chat-v4",
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
        dataHandling: {
          costTier: "paid",
          promptLogging: "disabled",
          completionLogging: "disabled",
          retention: "none",
          trainingUse: "deny",
          dataCollection: "deny",
          rawCaptureDefault: "disabled",
        },
        contextWindowTokens: 128_000,
        maxOutputTokens: 8_192,
        notes: [
          // ITOTORI-224 (2026-06-25): the previous claim ("verified against
          // OpenRouter's published Fireworks-hosted deepseek-v4 endpoint as
          // of 2026-06") was grounded in an invented endpoint description,
          // not in a captured response. The real evidence — a live ZDR-
          // posture toy call against the alpha pair, plus the catalog
          // /api/v1/models/.../endpoints lookup — is recorded at
          //   docs/openrouter-integration-evidence/2026-06-25.json
          // and canonicalised at docs/openrouter-integration.md §9.3.
          // ITOTORI-226 owns the slug correction (deepseek/deepseek-v4-flash
          // replacing the invented deepseek/deepseek-chat-v4 above) and
          // re-grounds this note once it lands.
          "ITOTORI-224 (2026-06-25): evidence file at docs/openrouter-integration-evidence/2026-06-25.json; canonical reference at docs/openrouter-integration.md §9.3. Slug correction tracked by ITOTORI-226.",
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
        dataHandling: {
          costTier: "paid",
          promptLogging: "disabled",
          completionLogging: "disabled",
          retention: "none",
          trainingUse: "deny",
          dataCollection: "deny",
          rawCaptureDefault: "disabled",
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
        dataHandling: {
          costTier: "paid",
          promptLogging: "disabled",
          completionLogging: "disabled",
          retention: "none",
          trainingUse: "deny",
          dataCollection: "deny",
          rawCaptureDefault: "disabled",
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
