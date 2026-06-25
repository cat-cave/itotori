// ITOTORI-078 / ITOTORI-220 — RecordedModelProvider.
//
// Replays a previously-recorded model invocation from an in-memory bundle.
// Used by the QA invocation service in recorded mode so tests and offline
// CI runs exercise the parse / validate / persist path without ever
// touching a live provider. Same input bundle → byte-equal output.
//
// Bundles are matched against requests by `bundleKey`. The default key is
// the SHA-256 of (modelId, providerId, promptHash, inputClassification)
// per ITOTORI-220 so a replay is pinned to the (model, provider) pair
// that originally produced it. A miss throws `RecordedBundleMissingError`
// so silent fallbacks are impossible.

import { createHash } from "node:crypto";
import { assertProviderInvocationSupported } from "./capability-guard.js";
import { deterministicFixtureDataHandlingPolicy } from "./policy.js";
import {
  ModelProviderError,
  type JsonObject,
  type ModelCapabilities,
  type ModelInvocationRequest,
  type ModelInvocationResult,
  type ModelProvider,
  type ModelToolCall,
  type ProviderDescriptor,
  type ProviderFamily,
  type ProviderRunRecord,
  type StructuredOutputMode,
  type TokenUsage,
} from "./types.js";
import { createProviderRunId } from "./types.js";

export type RecordedProviderResponse = {
  /** Verbatim provider content; usually a JSON string for structured-output paths. */
  content: string | null;
  toolCalls?: ModelToolCall[];
  finishReason?: string;
  /** Provider-reported token usage; defaults to a deterministic counter. */
  tokenUsage?: TokenUsage;
  adapterMetadata?: JsonObject;
};

export type RecordedProviderBundle = {
  /** Stable id for the bundle. Surfaced in `QaInvocationResult.recordedArtifactId`. */
  bundleId: string;
  /**
   * Provider that originally produced the response. Driven into the
   * replayed `ProviderRunRecord.provider.providerFamily` so downstream
   * consumers see the captured identity, not the family of the replay
   * harness.
   */
  capturedProviderFamily: ProviderFamily;
  capturedProviderName: string;
  capturedRequestedModelId: string;
  capturedActualModelId: string;
  /**
   * ITOTORI-220 — providerId the originally-captured request pinned. Used
   * as part of the bundle key so replays are pinned to the same
   * (model, provider) pair that originally produced the bytes.
   */
  capturedProviderId: string;
  /** Keyed lookup: `bundleKey` → response. */
  responses: Record<string, RecordedProviderResponse>;
};

export type RecordedModelProviderOptions = {
  bundle: RecordedProviderBundle;
  /**
   * Maps an incoming `ModelInvocationRequest` to a bundle key. Default
   * uses `request.prompt.promptHash` so reruns of the same prompt deliver
   * byte-equal output.
   */
  bundleKey?: (request: ModelInvocationRequest) => string;
};

export class RecordedBundleMissingError extends Error {
  constructor(
    public readonly bundleId: string,
    public readonly bundleKey: string,
    public readonly availableKeys: string[],
  ) {
    super(
      `recorded bundle ${bundleId} has no response for key '${bundleKey}'; available keys: [${availableKeys.join(", ")}]`,
    );
    this.name = "RecordedBundleMissingError";
  }
}

export class RecordedModelProvider implements ModelProvider {
  readonly descriptor: ProviderDescriptor;
  private readonly bundle: RecordedProviderBundle;
  private readonly bundleKey: (request: ModelInvocationRequest) => string;

  constructor(options: RecordedModelProviderOptions) {
    this.bundle = options.bundle;
    this.bundleKey = options.bundleKey ?? defaultBundleKey;
    this.descriptor = {
      family: "recorded",
      endpointFamily: "recorded-fixture",
      providerName: `${options.bundle.capturedProviderName}:recorded`,
      defaultModelId: options.bundle.capturedActualModelId,
      capabilities: recordedModelCapabilities,
    };
  }

  async invoke(request: ModelInvocationRequest): Promise<ModelInvocationResult> {
    assertProviderInvocationSupported({ descriptor: this.descriptor, request });
    const key = this.bundleKey(request);
    const response = this.bundle.responses[key];
    if (response === undefined) {
      throw new RecordedBundleMissingError(
        this.bundle.bundleId,
        key,
        Object.keys(this.bundle.responses),
      );
    }
    const startedAt = new Date(0).toISOString();
    const completedAt = startedAt;
    const requestedModelId = request.modelId;
    const structuredOutputMode: StructuredOutputMode | "none" =
      request.structuredOutput?.mode ?? "none";
    const run: ProviderRunRecord = {
      runId: request.runId ?? createProviderRunId("recorded"),
      taskKind: request.taskKind,
      startedAt,
      completedAt,
      latencyMs: 0,
      status: "succeeded",
      provider: {
        providerFamily: this.bundle.capturedProviderFamily,
        endpointFamily: this.descriptor.endpointFamily,
        providerName: this.bundle.capturedProviderName,
        requestedModelId,
        requestedProviderId: request.providerId,
        actualModelId: this.bundle.capturedActualModelId,
        upstreamProvider: this.bundle.capturedProviderId,
      },
      structuredOutputMode,
      retryCount: 0,
      errorClasses: [],
      fallbackUsed: false,
      fallbackPlan: request.fallbackModels ?? [requestedModelId],
      tokenUsage: response.tokenUsage ?? defaultTokenUsage(request, response.content),
      cost: {
        costKind: "zero",
        currency: "USD",
        amountMicrosUsd: 0,
      },
      prompt: request.prompt,
      dataHandling: this.descriptor.capabilities.dataHandling,
    };
    if (request.preset) {
      run.providerPreset = request.preset;
    }
    const result: ModelInvocationResult = {
      content: response.content,
      toolCalls: response.toolCalls ?? [],
      finishReason: response.finishReason ?? "stop",
      providerRun: run,
    };
    if (response.adapterMetadata !== undefined) {
      result.adapterMetadata = response.adapterMetadata;
    }
    return result;
  }

  /** Bundle id surfaced into `QaInvocationResult.recordedArtifactId`. */
  bundleId(): string {
    return this.bundle.bundleId;
  }
}

/**
 * ITOTORI-220 — default bundle key combines modelId + providerId +
 * promptHash + inputClassification under SHA-256 so a recorded bundle is
 * keyed by the (model, provider) pair that originally produced it.
 * Callers MAY override via `bundleKey` (used by the QA calibration suite
 * which keys directly on the prompt hash today), but the default refuses
 * to collapse different (model, provider) pairs onto the same key.
 */
function defaultBundleKey(request: ModelInvocationRequest): string {
  return recordedBundleKey({
    modelId: request.modelId,
    providerId: request.providerId,
    promptHash: request.prompt.promptHash,
    inputClassification: request.inputClassification,
  });
}

export type RecordedBundleKeyInputs = {
  modelId: string;
  providerId: string;
  promptHash: string;
  inputClassification: string;
};

/**
 * Deterministic recorded-bundle key per ITOTORI-220. Stable across runs;
 * any drift in (modelId, providerId, promptHash, inputClassification)
 * invalidates the cached bundle.
 */
export function recordedBundleKey(inputs: RecordedBundleKeyInputs): string {
  const hash = createHash("sha256");
  hash.update(
    [inputs.modelId, inputs.providerId, inputs.promptHash, inputs.inputClassification].join(":"),
  );
  return `sha256:${hash.digest("hex")}`;
}

function defaultTokenUsage(request: ModelInvocationRequest, content: string | null): TokenUsage {
  const promptText = request.messages
    .map((message) => (typeof message.content === "string" ? message.content : ""))
    .join(" ");
  const promptTokens = approximateTokens(promptText);
  const completionTokens = approximateTokens(content ?? "");
  return {
    tokenCountSource: "deterministic_counter",
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  };
}

function approximateTokens(text: string): number {
  const normalized = text.trim();
  if (normalized.length === 0) {
    return 0;
  }
  return Math.max(1, Math.ceil(normalized.length / 4));
}

/**
 * Capability profile for the recorded provider. Structured-output modes
 * are all `supported` because the bundle authority captured a real
 * provider that did support them; the recorded harness merely replays
 * the bytes. This is what lets the QA capability guard succeed in
 * recorded mode without faking the provider's real capabilities.
 */
export const recordedModelCapabilities: ModelCapabilities = {
  structuredOutputs: {
    jsonSchema: "supported",
    jsonObject: "supported",
    toolCallArguments: "supported",
    plainJsonExtraction: "supported",
    preferredModes: ["json_schema", "json_object", "tool_call_arguments", "plain_json"],
  },
  toolCalls: {
    support: "supported",
    parallelToolCalls: "unsupported",
    requiresSchemaPerRequest: false,
  },
  imageInput: {
    support: "unsupported",
  },
  routing: {
    providerRouting: "unsupported",
    modelFallbacks: "unsupported",
    presets: "unsupported",
    requireParameters: "unsupported",
    dataCollectionControl: "unsupported",
    zeroDataRetentionRouting: "unsupported",
  },
  dataHandling: deterministicFixtureDataHandlingPolicy,
  notes: ["replay-only provider for recorded fixture bundles"],
};

// Re-exported for shape-completeness even though it is currently unused
// outside this file.
export { ModelProviderError };
