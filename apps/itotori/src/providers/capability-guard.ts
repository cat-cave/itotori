import { assertProviderInputAllowed } from "./policy.js";
import { supportForStructuredOutputMode } from "./structured-output.js";
import {
  ModelProviderError,
  type CapabilitySupport,
  type ModelCapabilities,
  type ModelInvocationRequest,
  type ModelMessage,
  type ModelToolChoice,
  type ProviderDescriptor,
} from "./types.js";

export type ProviderRoutingCapabilityRequirement = keyof ModelCapabilities["routing"];

export type ProviderInvocationGuardInput = {
  descriptor: ProviderDescriptor;
  request: ModelInvocationRequest;
  capabilities?: ModelCapabilities;
  requestedModelId?: string;
  routingRequirements?: ProviderRoutingCapabilityRequirement[];
};

export function assertProviderInvocationSupported(input: ProviderInvocationGuardInput): void {
  const capabilities = input.capabilities ?? input.descriptor.capabilities;
  assertProviderInputAllowed(capabilities, input.request.inputClassification);
  assertStructuredOutputSupported(capabilities, input.request);
  assertToolRequirementsSupported(capabilities, input.request);
  assertImageInputsSupported(capabilities, input.request.messages);
  assertRoutingRequirementsSupported(capabilities, input);
}

function assertStructuredOutputSupported(
  capabilities: ModelCapabilities,
  request: ModelInvocationRequest,
): void {
  if (request.structuredOutput === undefined) {
    return;
  }
  const support = supportForStructuredOutputMode(capabilities, request.structuredOutput.mode);
  assertSupported(support, `structured output mode ${request.structuredOutput.mode}`);
  if (request.structuredOutput.mode !== "tool_call_arguments") {
    return;
  }
  const toolName = request.structuredOutput.toolName;
  if (request.tools?.some((tool) => tool.name === toolName)) {
    throw new ModelProviderError(
      `structured output tool ${toolName} conflicts with request tools`,
      "configuration_error",
      false,
    );
  }
  if (!toolChoiceMatchesForcedTool(request.toolChoice, toolName)) {
    throw new ModelProviderError(
      `structured output mode tool_call_arguments requires forced tool choice ${toolName}`,
      "configuration_error",
      false,
    );
  }
}

function assertToolRequirementsSupported(
  capabilities: ModelCapabilities,
  request: ModelInvocationRequest,
): void {
  const requiresTools =
    (request.tools?.length ?? 0) > 0 ||
    request.structuredOutput?.mode === "tool_call_arguments" ||
    (typeof request.toolChoice === "object" && request.toolChoice.type === "function") ||
    request.toolChoice === "auto";
  if (!requiresTools) {
    return;
  }
  assertSupported(capabilities.toolCalls.support, "tool calls");
  if (capabilities.toolCalls.requiresSchemaPerRequest) {
    for (const tool of request.tools ?? []) {
      assertToolSchemaPresent(tool.name, tool.parameters);
    }
    if (request.structuredOutput?.mode === "tool_call_arguments") {
      assertToolSchemaPresent(request.structuredOutput.toolName, request.structuredOutput.schema);
    }
  }
}

function assertToolSchemaPresent(toolName: string, parameters: Record<string, unknown>): void {
  if (Object.keys(parameters).length > 0) {
    return;
  }
  throw new ModelProviderError(
    `tool ${toolName} must include request schema parameters for this provider`,
    "capability_unsupported",
    false,
  );
}

function assertImageInputsSupported(
  capabilities: ModelCapabilities,
  messages: readonly ModelMessage[],
): void {
  const imageCount = messages.reduce((count, message) => {
    if (!Array.isArray(message.content)) {
      return count;
    }
    return count + message.content.filter((part) => part.type === "image_url").length;
  }, 0);
  if (imageCount === 0) {
    return;
  }
  assertSupported(capabilities.imageInput.support, "image inputs");
  if (
    capabilities.imageInput.maxImagesPerRequest !== undefined &&
    imageCount > capabilities.imageInput.maxImagesPerRequest
  ) {
    throw new ModelProviderError(
      `image input count ${imageCount} exceeds provider limit ${capabilities.imageInput.maxImagesPerRequest}`,
      "capability_unsupported",
      false,
    );
  }
}

function assertRoutingRequirementsSupported(
  capabilities: ModelCapabilities,
  input: ProviderInvocationGuardInput,
): void {
  const requestedModelId =
    input.requestedModelId ?? input.request.modelId ?? input.descriptor.defaultModelId;
  const requirements = new Set<ProviderRoutingCapabilityRequirement>(
    input.routingRequirements ?? [],
  );
  if (fallbackPlanForRequest(input.request, requestedModelId).length > 1) {
    requirements.add("modelFallbacks");
  }
  if (input.request.preset !== undefined) {
    requirements.add("presets");
  }
  for (const requirement of requirements) {
    assertSupported(capabilities.routing[requirement], routingRequirementLabel(requirement));
  }
}

function assertSupported(support: CapabilitySupport, label: string): void {
  if (support === "supported") {
    return;
  }
  throw new ModelProviderError(
    `${label} is ${support} for provider`,
    "capability_unsupported",
    false,
  );
}

function toolChoiceMatchesForcedTool(
  toolChoice: ModelToolChoice | undefined,
  toolName: string,
): boolean {
  return (
    toolChoice === undefined ||
    (typeof toolChoice === "object" && toolChoice.functionName === toolName)
  );
}

function routingRequirementLabel(requirement: ProviderRoutingCapabilityRequirement): string {
  switch (requirement) {
    case "providerRouting":
      return "provider routing";
    case "modelFallbacks":
      return "model fallbacks";
    case "presets":
      return "provider presets";
    case "requireParameters":
      return "strict provider parameter routing";
    case "dataCollectionControl":
      return "provider data collection control";
    case "zeroDataRetentionRouting":
      return "zero data retention routing";
  }
}

function fallbackPlanForRequest(
  request: ModelInvocationRequest,
  requestedModelId: string,
): string[] {
  return Array.from(new Set([requestedModelId, ...(request.fallbackModels ?? [])]));
}
