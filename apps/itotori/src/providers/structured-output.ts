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
 * ITOTORI-241 — capability-driven, ZDR-correct structured-mode selection
 * for the agentic loop (style-guide + speaker-label + translation + qa).
 *
 * The agentic path no longer FORCES `json_schema`. Live testing of the
 * ITOTORI-241 routing fix proved that `response_format: json_schema`
 * (strict AND non-strict) is UNROUTABLE under ZDR for the DEV_PAIR
 * (deepseek/deepseek-v4-flash via Fireworks): OpenRouter returns HTTP 404
 * "No endpoints found that can handle the requested parameters" because
 * no ZDR-allow-list provider for that pair advertises json_schema and
 * `require_parameters:true` narrows the routable pool to empty. The
 * proven-routable deterministic structured mode under ZDR is `json_object`.
 *
 * Selection is PAIR-DRIVEN, never hardcoded to a provider: `json_schema`
 * is chosen only when the active pair's capability sheet validates it as
 * `"supported"` (i.e. its ZDR providers advertise it); otherwise the call
 * falls back to `json_object` when that is `"supported"`. A pair whose
 * sheet supports neither throws `capability_unsupported` rather than
 * silently degrading.
 */
const AGENTIC_STRUCTURED_MODE_PREFERENCE: readonly StructuredOutputMode[] = [
  "json_schema",
  "json_object",
];

export function selectStructuredOutputRequest(
  capabilities: ModelCapabilities,
  spec: StructuredOutputSchemaSpec,
): StructuredOutputRequest {
  const mode = selectStructuredOutputMode(capabilities, [...AGENTIC_STRUCTURED_MODE_PREFERENCE]);
  if (mode === undefined) {
    throw new ModelProviderError(
      `no ZDR-routable structured-output mode (json_schema or json_object) is supported for this pair ` +
        `(jsonSchema=${capabilities.structuredOutputs.jsonSchema}, jsonObject=${capabilities.structuredOutputs.jsonObject})`,
      "capability_unsupported",
      false,
    );
  }
  if (mode === "json_schema") {
    return { mode, name: spec.name, schema: spec.schema, strict: spec.strict };
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
