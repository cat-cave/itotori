import { ModelProviderError, type ModelCapabilities, type StructuredOutputMode } from "./types.js";

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
