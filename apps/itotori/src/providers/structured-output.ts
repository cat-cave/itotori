import {
  ModelProviderError,
  type JsonObject,
  type ModelCapabilities,
  type StructuredOutputMode,
  type StructuredOutputRequest,
} from "./types.js";

export function supportForStructuredOutputMode(
  capabilities: ModelCapabilities,
  mode: StructuredOutputMode,
): "supported" | "unsupported" | "partial" | "untested" {
  switch (mode) {
    case "json_schema":
      return capabilities.structuredOutputs.jsonSchema;
    case "json_object":
      return capabilities.structuredOutputs.jsonObject;
    case "tool_call_arguments":
      if (capabilities.structuredOutputs.toolCallArguments !== "supported") {
        return capabilities.structuredOutputs.toolCallArguments;
      }
      if (capabilities.toolCalls.support !== "supported") {
        return capabilities.toolCalls.support;
      }
      return capabilities.structuredOutputs.toolCallArguments;
    case "plain_json":
      return capabilities.structuredOutputs.plainJsonExtraction;
  }
}

export function selectStructuredOutputMode(
  capabilities: ModelCapabilities,
  requestedModes = capabilities.structuredOutputs.preferredModes,
): StructuredOutputMode | undefined {
  for (const mode of requestedModes) {
    if (supportForStructuredOutputMode(capabilities, mode) === "supported") {
      return mode;
    }
  }
  return undefined;
}

/**
 * ITOTORI-241 — the schema-bearing inputs the agentic loop needs to build
 * a structured-output request, independent of which wire mode is actually
 * selected. `schema`/`name`/`strict` only ride the wire in `json_schema`
 * mode; in `json_object` mode the provider guarantees syntactically-valid
 * JSON only and the schema is enforced by the agent's own post-parse
 * validation.
 */
export type StructuredOutputSchemaSpec = {
  name: string;
  schema: JsonObject;
  strict: boolean;
};

/**
 * ITOTORI-241 / itotori-structured-output-plain-json-fallback-under-zdr —
 * capability-driven, ZDR-correct structured-mode selection for the agentic
 * loop (style-guide + speaker-label + translation + qa).
 *
 * The agentic path no longer FORCES `json_schema`. Live testing of the
 * ITOTORI-241 routing fix proved that `response_format: json_schema`
 * (strict AND non-strict) is UNROUTABLE under ZDR for the DEV_PAIR
 * (deepseek/deepseek-v4-flash via Fireworks): OpenRouter returns HTTP 404
 * "No endpoints found that can handle the requested parameters" because
 * no ZDR-allow-list provider for that pair advertises json_schema and
 * `require_parameters:true` narrows the routable pool to empty. Two later
 * live runs (at-scale-v2 + structure-informed-context) proved the SAME 404
 * for `response_format: json_object`: the ZDR-allow-list providers ∩
 * structured-mode-advertising providers is EMPTY for this pair, so ANY
 * `response_format` + `require_parameters:true` combination empties the
 * routable pool. The only ZDR-routable mode for such a pair is a PLAIN
 * completion (`plain_json`): no `response_format`, no `require_parameters`,
 * so the pool is not narrowed. The JSON is prompt-enforced and salvaged by
 * the caller's bounded JSON repair, then validated against the SAME strict
 * schema as the structured path (a malformed/schema-violating plain
 * response is still rejected — no silent acceptance of garbage).
 *
 * Selection is PAIR-DRIVEN, never hardcoded to a provider, and PREFERS the
 * structured wire mode whenever it is routable: `json_schema` is chosen
 * when the active pair's sheet validates it `"supported"`; else `json_object`
 * when that is `"supported"`; else `plain_json` when the pair advertises
 * plain-JSON extraction. Only a pair whose sheet supports NONE of the three
 * throws `capability_unsupported` rather than silently degrading. This is a
 * single selector with a fallback chain — not a parallel plain-only path.
 */
const AGENTIC_STRUCTURED_MODE_PREFERENCE: readonly StructuredOutputMode[] = [
  "json_schema",
  "json_object",
  "plain_json",
];

export function selectStructuredOutputRequest(
  capabilities: ModelCapabilities,
  spec: StructuredOutputSchemaSpec,
): StructuredOutputRequest {
  const mode = selectStructuredOutputMode(capabilities, [...AGENTIC_STRUCTURED_MODE_PREFERENCE]);
  if (mode === undefined) {
    throw new ModelProviderError(
      `no ZDR-routable structured-output mode (json_schema, json_object, or plain_json) is supported ` +
        `for this pair (jsonSchema=${capabilities.structuredOutputs.jsonSchema}, ` +
        `jsonObject=${capabilities.structuredOutputs.jsonObject}, ` +
        `plainJsonExtraction=${capabilities.structuredOutputs.plainJsonExtraction})`,
      "capability_unsupported",
      false,
    );
  }
  if (mode === "json_schema") {
    return { mode, name: spec.name, schema: spec.schema, strict: spec.strict };
  }
  if (mode === "plain_json") {
    // plain_json — the ZDR fallback when no structured wire mode is
    // routable for the pair. Emits NO `response_format`/`require_parameters`
    // (so the ZDR pool is not emptied); the schema is enforced entirely by
    // the caller's bounded-repair + strict post-parse validation.
    return { mode: "plain_json" };
  }
  // json_object — the schema is enforced by the caller's post-parse
  // validation, so it is intentionally not forwarded to the wire.
  return { mode: "json_object" };
}

export function assertStructuredOutputModeSupported(
  capabilities: ModelCapabilities,
  mode: StructuredOutputMode,
): void {
  const support = supportForStructuredOutputMode(capabilities, mode);
  if (support !== "supported") {
    throw new ModelProviderError(
      `structured output mode ${mode} is ${support} for ${capabilities.notes?.[0] ?? "provider"}`,
      "capability_unsupported",
      false,
    );
  }
}
