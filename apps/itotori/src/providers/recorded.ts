// ITOTORI-078 / ITOTORI-220 / ITOTORI-228 — RecordedModelProvider.
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
//
// ITOTORI-228 — every `RecordedProviderResponse` carries the original
// LIVE call's billed `cost` (mirrored verbatim from the captured
// `usage.cost`). `RecordedModelProvider.invoke` surfaces it on the
// replayed `ProviderRunRecord.cost` so cost-cap arithmetic, telemetry,
// and ledger writes are byte-equal to the LIVE run that produced the
// bundle. The bundle's `schemaVersion` is locked to
// `RECORDED_PROVIDER_BUNDLE_SCHEMA_VERSION`; pre-ITOTORI-228 bundles
// (without a captured `cost`) fail at construction with a typed
// `RecordedBundleSchemaMismatchError`. Any future capture path (live
// OpenRouter run → on-disk bundle) MUST write the response's
// `usage.cost` into the bundle; refusing the write when `usage.cost` is
// absent is the contractual forcing function and is documented at the
// future-capture seam.

import { createHash } from "node:crypto";
import { assertProviderInvocationSupported } from "./capability-guard.js";
import { ZERO_COST } from "./cost.js";
import {
  ModelProviderError,
  type JsonObject,
  type ModelCapabilities,
  type ModelInvocationRequest,
  type ModelInvocationResult,
  type ModelProvider,
  type ModelToolCall,
  type ProviderCost,
  type ProviderDescriptor,
  type ProviderFamily,
  type ProviderRunRecord,
  type StructuredOutputMode,
  type TokenUsage,
} from "./types.js";
import { createProviderRunId } from "./types.js";

/**
 * Wire-schema version of the recorded-provider bundle. Bumped by
 * ITOTORI-228 (added required `cost` on every `RecordedProviderResponse`
 * + required `schemaVersion` on the bundle envelope). Bundles whose
 * `schemaVersion` is anything other than this literal are rejected at
 * `RecordedModelProvider` construction time so a pre-ITOTORI-228 file
 * on disk silently replaying as `cost: 0` is impossible.
 */
export const RECORDED_PROVIDER_BUNDLE_SCHEMA_VERSION =
  "itotori.recorded-provider-bundle.v1" as const;

export type RecordedProviderResponse = {
  /** Verbatim provider content; usually a JSON string for structured-output paths. */
  content: string | null;
  toolCalls?: ModelToolCall[];
  finishReason?: string;
  /** Provider-reported token usage; defaults to a deterministic counter. */
  tokenUsage?: TokenUsage;
  /**
   * ITOTORI-228 — the original LIVE call's billed cost (USD micros),
   * mirrored verbatim from `usage.cost` on the captured response. After
   * ITOTORI-225 narrowing the only legal `costKind` values are `billed`
   * (any real spend) or `zero` (genuinely-free upstream call — e.g.
   * cached prompt with full discount). Required: a recorded bundle that
   * lacks this field is a schema mismatch, not a recoverable case.
   */
  cost: ProviderCost;
  adapterMetadata?: JsonObject;
};

export type RecordedProviderBundle = {
  /**
   * ITOTORI-228 — locked to `RECORDED_PROVIDER_BUNDLE_SCHEMA_VERSION`.
   * Any other value (or absence) is a typed
   * `RecordedBundleSchemaMismatchError` at construction time. The
   * forcing function is intentional: pre-ITOTORI-228 bundles must be
   * re-recorded against the new schema so their replayed cost matches
   * the LIVE run that originally produced them.
   */
  schemaVersion: typeof RECORDED_PROVIDER_BUNDLE_SCHEMA_VERSION;
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

/**
 * ITOTORI-228 — raised at `RecordedModelProvider` construction when the
 * bundle's `schemaVersion` is missing or does not match the current
 * `RECORDED_PROVIDER_BUNDLE_SCHEMA_VERSION`, or when any individual
 * `RecordedProviderResponse` is missing the required `cost` field. The
 * message names the offending bundle and the specific
 * `bundleKey` (when applicable) so a stale on-disk file is easy to
 * locate and re-record.
 */
export class RecordedBundleSchemaMismatchError extends Error {
  constructor(
    public readonly bundleId: string,
    public readonly detail: string,
  ) {
    super(
      `RecordedBundleSchemaMismatchError: bundle '${bundleId}' is pre-ITOTORI-228 (${detail}); please recapture to schema '${RECORDED_PROVIDER_BUNDLE_SCHEMA_VERSION}' so the original usage.cost is mirrored on replay.`,
    );
    this.name = "RecordedBundleSchemaMismatchError";
  }
}

/**
 * ITOTORI-228 — raised when two recorded responses keyed to the same
 * `bundleKey` disagree on captured cost. Today the in-memory bundle is
 * a `Record<string, RecordedProviderResponse>` which structurally
 * collapses duplicate keys to whichever was assigned last; the typed
 * error fires when a caller MERGES two bundles via
 * `mergeRecordedBundles` and a key collides with a different cost. This
 * surfaces silent cost loss (the audit's "RecordedCostMismatchError
 * downgraded to a warning" anti-pattern) as a hard, typed failure.
 */
export class RecordedCostMismatchError extends Error {
  constructor(
    public readonly bundleKey: string,
    public readonly leftBundleId: string,
    public readonly rightBundleId: string,
    public readonly leftCost: ProviderCost,
    public readonly rightCost: ProviderCost,
  ) {
    super(
      `RecordedCostMismatchError: key '${bundleKey}' present in both '${leftBundleId}' (${formatProviderCost(leftCost)}) and '${rightBundleId}' (${formatProviderCost(rightCost)}); merging would silently drop one captured cost — refusing.`,
    );
    this.name = "RecordedCostMismatchError";
  }
}

function formatProviderCost(cost: ProviderCost): string {
  return `costKind=${cost.costKind} amountMicrosUsd=${cost.amountMicrosUsd}`;
}

/**
 * ITOTORI-228 — merge two recorded bundles into one (left-id retained).
 * Refuses with `RecordedCostMismatchError` when both bundles carry the
 * same key with non-equal captured costs. Used by the calibration
 * harness when chaining per-(fixture, agent) bundles into a single
 * provider; surfaces silent cost loss as a typed failure rather than
 * letting `Object.assign` semantics pick the last writer.
 */
export function mergeRecordedBundles(
  left: RecordedProviderBundle,
  right: RecordedProviderBundle,
): RecordedProviderBundle {
  const merged: Record<string, RecordedProviderResponse> = { ...left.responses };
  for (const [key, rightResponse] of Object.entries(right.responses)) {
    const leftResponse = merged[key];
    if (leftResponse !== undefined && !providerCostsEqual(leftResponse.cost, rightResponse.cost)) {
      throw new RecordedCostMismatchError(
        key,
        left.bundleId,
        right.bundleId,
        leftResponse.cost,
        rightResponse.cost,
      );
    }
    merged[key] = rightResponse;
  }
  return { ...left, responses: merged };
}

function providerCostsEqual(a: ProviderCost, b: ProviderCost): boolean {
  return (
    a.costKind === b.costKind &&
    a.currency === b.currency &&
    a.amountMicrosUsd === b.amountMicrosUsd &&
    a.pricingSnapshotId === b.pricingSnapshotId
  );
}

export class RecordedModelProvider implements ModelProvider {
  readonly descriptor: ProviderDescriptor;
  private readonly bundle: RecordedProviderBundle;
  private readonly bundleKey: (request: ModelInvocationRequest) => string;

  constructor(options: RecordedModelProviderOptions) {
    assertBundleSchema(options.bundle);
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
      // ITOTORI-228 — mirror the captured LIVE cost verbatim. The bundle
      // schema makes `response.cost` non-optional; pre-ITOTORI-228 files
      // would have already failed `assertBundleSchema` at construction.
      cost: response.cost,
      prompt: request.prompt,
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
  notes: ["replay-only provider for recorded fixture bundles"],
};

// Re-exported for shape-completeness even though it is currently unused
// outside this file.
export { ModelProviderError };

/**
 * ITOTORI-228 — validate the bundle's `schemaVersion` literal and that
 * every response carries a structurally-valid `cost: ProviderCost`. The
 * checks are intentionally strict: a missing field is a typed
 * `RecordedBundleSchemaMismatchError`, not a synthesis-with-fallback
 * site. This is the forcing function the audit requires
 * (docs/proposals/openrouter-audit-consolidation-2026-06-25.md §2 N5).
 *
 * `ZERO_COST` is imported so the contract is self-documenting: callers
 * who genuinely captured a zero-cost upstream call (e.g. a cached
 * prompt fully covered by a discount, or a deterministic offline
 * fixture that never charged) can pass `ZERO_COST` rather than
 * inventing their own zero object.
 */
function assertBundleSchema(bundle: RecordedProviderBundle): void {
  if (bundle.schemaVersion !== RECORDED_PROVIDER_BUNDLE_SCHEMA_VERSION) {
    throw new RecordedBundleSchemaMismatchError(
      bundle.bundleId,
      `bundle.schemaVersion is ${JSON.stringify(bundle.schemaVersion)}, expected '${RECORDED_PROVIDER_BUNDLE_SCHEMA_VERSION}' (no captured cost on pre-ITOTORI-228 schema)`,
    );
  }
  for (const [key, response] of Object.entries(bundle.responses)) {
    if (response === null || typeof response !== "object") {
      throw new RecordedBundleSchemaMismatchError(
        bundle.bundleId,
        `response under key '${key}' is not an object`,
      );
    }
    const cost = (response as { cost?: unknown }).cost;
    if (cost === undefined || cost === null) {
      throw new RecordedBundleSchemaMismatchError(
        bundle.bundleId,
        `response under key '${key}' is missing required field 'cost' (ITOTORI-228 added cost: ProviderCost as a required field on every recorded response)`,
      );
    }
    assertResponseCostShape(bundle.bundleId, key, cost);
  }
  // Touch ZERO_COST so the import survives tree-shaking; documents the
  // canonical zero-cost shape callers should reuse on genuinely-free
  // captures rather than inventing their own `{ costKind: 'zero', ... }`.
  void ZERO_COST;
}

function assertResponseCostShape(bundleId: string, key: string, cost: unknown): void {
  const candidate = cost as Partial<ProviderCost> & { costKind?: unknown };
  if (candidate.costKind !== "billed" && candidate.costKind !== "zero") {
    throw new RecordedBundleSchemaMismatchError(
      bundleId,
      `response under key '${key}' has unsupported costKind ${JSON.stringify(candidate.costKind)} (expected 'billed' or 'zero' per ITOTORI-225 narrowing)`,
    );
  }
  if (candidate.currency !== "USD") {
    throw new RecordedBundleSchemaMismatchError(
      bundleId,
      `response under key '${key}' has unsupported currency ${JSON.stringify(candidate.currency)} (expected 'USD')`,
    );
  }
  if (
    typeof candidate.amountMicrosUsd !== "number" ||
    !Number.isFinite(candidate.amountMicrosUsd)
  ) {
    throw new RecordedBundleSchemaMismatchError(
      bundleId,
      `response under key '${key}' has invalid amountMicrosUsd ${JSON.stringify(candidate.amountMicrosUsd)} (expected finite number)`,
    );
  }
  if (candidate.costKind === "zero" && candidate.amountMicrosUsd !== 0) {
    throw new RecordedBundleSchemaMismatchError(
      bundleId,
      `response under key '${key}' is costKind='zero' but amountMicrosUsd=${candidate.amountMicrosUsd} (zero-cost responses must have amountMicrosUsd=0)`,
    );
  }
}
