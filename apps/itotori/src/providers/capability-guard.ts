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

/**
 * ITOTORI-227 — privacy enforcement no longer lives in the capability
 * guard. The per-pair privacy registry was deleted in favour of the
 * account-wide ZDR posture (assertOpenRouterZdrAccount at process
 * startup) plus per-request `provider.zdr=true` defaulting in the
 * OpenRouter routing block. The guard now only validates per-request
 * capability claims (structured output, tools, images, routing).
 */
export function assertProviderInvocationSupported(input: ProviderInvocationGuardInput): void {
  const capabilities = input.capabilities ?? input.descriptor.capabilities;
  assertStructuredOutputSupported(capabilities, input.request);
  assertToolRequirementsSupported(capabilities, input.request);
  assertImageInputsSupported(capabilities, input.request.messages);
  assertRoutingRequirementsSupported(capabilities, input);
}

// ---------------------------------------------------------------------------
// Model-keyed capability lookup (no-provider-name invariant).
//
// Under the account-wide ZDR posture we do NOT choose the upstream provider —
// OpenRouter picks it on capability + ZDR + price, and the served provider is
// a RECORDED OUTPUT, never a routing input. Capability claims like
// "supportsStructuredOutput" are therefore the routable floor of a MODEL
// under our ZDR allow-list, not a per-(model, provider) fact. `CapabilityGuard`
// is a small in-memory registry keyed on `modelId` so callers can register
// what they have measured and look it up without naming a provider. A miss
// throws — never silently degrades.
// ---------------------------------------------------------------------------

export type ModelCapabilityKey = string & { readonly __brand: "ModelCapabilityKey" };

export function modelCapabilityKey(modelId: string): ModelCapabilityKey {
  if (modelId.length === 0) {
    throw new ModelProviderError(
      "modelCapabilityKey requires a non-empty modelId",
      "configuration_error",
      false,
    );
  }
  return modelId as ModelCapabilityKey;
}

export class CapabilityGuardMissError extends Error {
  constructor(public readonly modelId: string) {
    super(`capability guard miss for modelId=${modelId}; register the model before invocation`);
    this.name = "CapabilityGuardMissError";
  }
}

export class CapabilityGuard {
  private readonly entries = new Map<ModelCapabilityKey, ModelCapabilities>();

  /** Register (or overwrite) the capabilities for a model. */
  register(modelId: string, capabilities: ModelCapabilities): void {
    this.entries.set(modelCapabilityKey(modelId), capabilities);
  }

  /** Lookup; throws CapabilityGuardMissError when the model has not been registered. */
  lookup(modelId: string): ModelCapabilities {
    const entry = this.entries.get(modelCapabilityKey(modelId));
    if (entry === undefined) {
      throw new CapabilityGuardMissError(modelId);
    }
    return entry;
  }

  /** True iff the model is registered. */
  has(modelId: string): boolean {
    return this.entries.has(modelCapabilityKey(modelId));
  }

  /** Clear the registry — test-only escape hatch; never call from app code. */
  clear(): void {
    this.entries.clear();
  }

  /** Snapshot of registered model ids for diagnostics. */
  registeredModels(): string[] {
    return [...this.entries.keys()];
  }
}

// Process-wide singleton CapabilityGuard. The OpenRouterModelProvider
// registers every known model into this guard at construction so the
// agentic-loop orchestrator can call `globalCapabilityGuard().lookup(modelId)`
// without each call site having to wire its own guard. A singleton is the
// right shape here because capability claims are per-model facts, not
// per-provider-instance facts.
let GLOBAL_CAPABILITY_GUARD: CapabilityGuard | undefined;

export function globalCapabilityGuard(): CapabilityGuard {
  if (GLOBAL_CAPABILITY_GUARD === undefined) {
    GLOBAL_CAPABILITY_GUARD = new CapabilityGuard();
  }
  return GLOBAL_CAPABILITY_GUARD;
}

/** Test-only: reset the singleton guard so each test starts clean. */
export function __resetGlobalCapabilityGuardForTests(): void {
  GLOBAL_CAPABILITY_GUARD = undefined;
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
  const requestedModelId = input.requestedModelId ?? input.request.modelId;
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
