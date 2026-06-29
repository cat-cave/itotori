// ITOTORI-078 / ITOTORI-220 / ITOTORI-228 / ITOTORI-230 —
// RecordedModelProvider.
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
// bundle.
//
// ITOTORI-230 — every `RecordedProviderResponse` ALSO carries the
// captured OR routing posture (`zdr`, `data_collection`, `only`, etc.)
// from the original LIVE call. Replay surfaces it on
// `ProviderRunRecord.routingPosture` so an offline audit can prove the
// ZDR posture without recapturing the wire.
//
// ITOTORI-232 — every `RecordedProviderResponse` ALSO carries the full
// originating OR response's `usage` block as `usageResponseJson`. The
// bundle's `schemaVersion` is locked to
// `RECORDED_PROVIDER_BUNDLE_SCHEMA_VERSION` (now `v3`); pre-v3 bundles
// fail at construction with a typed `RecordedBundleSchemaMismatchError`.
// Any future capture path (live OpenRouter run → on-disk bundle) MUST
// write the response's `usage` block (with `cost`), the request's
// `provider` block, AND the response's `usage.cost` matching the
// captured ProviderCost.amountMicrosUsd into the bundle; refusing the
// write when any are absent is the contractual forcing function and is
// documented at the future-capture seam.

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
  type OpenRouterRoutingPosture,
  type ProviderCost,
  type ProviderDescriptor,
  type ProviderFamily,
  type ProviderRunRecord,
  type StructuredOutputMode,
  type TokenUsage,
} from "./types.js";
import { createProviderRunId } from "./types.js";

/**
 * Wire-schema version of the recorded-provider bundle.
 *
 * - v1 (ITOTORI-228) added required `cost` on every
 *   `RecordedProviderResponse` + required `schemaVersion` on the
 *   bundle envelope.
 * - v2 (ITOTORI-230) added required `routingPosture` on every
 *   `RecordedProviderResponse` so an offline replay carries the
 *   originally-captured OR ZDR posture verbatim.
 * - v3 (ITOTORI-232) added required `usageResponseJson` on every
 *   `RecordedProviderResponse` so an offline replay carries the
 *   originating OR response's full `usage` block (prompt_tokens,
 *   completion_tokens, cost, cost_details, prompt_tokens_details). The
 *   replayed `ProviderRunRecord.usageResponseJson` mirrors it verbatim
 *   so the ledger row's storage-layer CHECK (migration 0041) still
 *   passes by construction.
 *
 * ITOTORI-233 considered a v3 → v4 bump for the new cache-aware
 * annotations (`cacheReadTokens` / `cacheWriteTokens` /
 * `cacheDiscountMicrosUsd`) but ultimately KEPT v3 because the
 * annotations ride naturally on the EXISTING required v3 shapes:
 *
 *   - Read/write tokens land on `RecordedProviderResponse.tokenUsage`
 *     (already an optional but read-by-replay `TokenUsage`).
 *   - The cache discount lands on `RecordedProviderResponse.cost`
 *     (already required v1 `ProviderCost`).
 *
 * Pre-ITOTORI-233 v3 bundles that lack these optional fields replay
 * with `undefined` → DraftAttemptRecorder defaults to 0 on persist →
 * ledger DEFAULT 0 — which IS the truthful zero a non-cache-hit row
 * would record from a live run. The `usageResponseJson` already
 * mirrors `cost_details` + `prompt_tokens_details` verbatim, so the
 * canonical truth is preserved on disk regardless. A v4 bump would be
 * ceremonial: it would not catch a regression that the v3 shape's
 * `usageResponseJson` mirror does not already catch.
 *
 * Bundles whose `schemaVersion` is anything other than this literal are
 * rejected at `RecordedModelProvider` construction time so a stale file
 * on disk cannot silently replay missing required fields.
 */
export const RECORDED_PROVIDER_BUNDLE_SCHEMA_VERSION =
  "itotori.recorded-provider-bundle.v3" as const;

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
  /**
   * ITOTORI-230 — the original LIVE call's OR routing posture (the
   * `provider: { only, allow_fallbacks, data_collection, zdr,
   * require_parameters }` block that hit the wire). Mirrored verbatim
   * so an offline replay proves the three-part ZDR posture without
   * recapturing the wire. Required: a recorded bundle that lacks this
   * field is a schema mismatch, NOT a recoverable case — the audit
   * trail would silently lose the captured-on-wire posture.
   */
  routingPosture: OpenRouterRoutingPosture;
  /**
   * ITOTORI-232 — the originating OR response's full `usage` block
   * (prompt_tokens, completion_tokens, cost, cost_details,
   * prompt_tokens_details with caching annotations). Mirrored verbatim
   * so the replayed `ProviderRunRecord.usageResponseJson` matches the
   * LIVE run byte-for-byte; the ledger CHECK (migration 0041) verifies
   * `cost_amount = usage_response_json->>'cost'` to within 1e-9 USD on
   * persist.
   *
   * For genuinely zero-cost captures (e.g. a recorded fixture that
   * never backed a real OR call), pass an object with no `cost` key —
   * the partial-NULL CHECK exempts these. Required: a recorded bundle
   * that lacks this field is a schema mismatch, NOT a recoverable case;
   * a future regression that silently elided the captured usage block
   * would let the replay claim a different cost than the LIVE run that
   * produced it.
   */
  usageResponseJson: JsonObject;
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
      `RecordedBundleSchemaMismatchError: bundle '${bundleId}' is below the current bundle schema (${detail}); please recapture to schema '${RECORDED_PROVIDER_BUNDLE_SCHEMA_VERSION}' so the original usage.cost, routing posture, and usage block are mirrored on replay.`,
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
  return `costKind=${cost.costKind} amountUsd=${cost.amountUsd} amountMicrosUsd=${cost.amountMicrosUsd}`;
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
    a.amountUsd === b.amountUsd &&
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
      // ITOTORI-230 — mirror the captured routing posture verbatim so
      // the replayed run carries the same audit evidence as the LIVE
      // run that produced the bundle. The bundle schema (v3) makes
      // `response.routingPosture` non-optional.
      routingPosture: response.routingPosture,
      // ITOTORI-232 — mirror the captured `usage` block verbatim so the
      // replayed `cost` matches the LIVE `cost_amount` byte-for-byte.
      // The bundle schema (v3) makes `response.usageResponseJson`
      // non-optional.
      usageResponseJson: response.usageResponseJson,
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
    const posture = (response as { routingPosture?: unknown }).routingPosture;
    if (posture === undefined || posture === null) {
      throw new RecordedBundleSchemaMismatchError(
        bundle.bundleId,
        `response under key '${key}' is missing required field 'routingPosture' (ITOTORI-230 / bundle schema v2 added routingPosture: OpenRouterRoutingPosture as a required field on every recorded response)`,
      );
    }
    assertRoutingPostureShape(bundle.bundleId, key, posture);
    // ITOTORI-232 — bundle schema v3 makes usageResponseJson required.
    const usageJson = (response as { usageResponseJson?: unknown }).usageResponseJson;
    if (usageJson === undefined || usageJson === null) {
      throw new RecordedBundleSchemaMismatchError(
        bundle.bundleId,
        `response under key '${key}' is missing required field 'usageResponseJson' (ITOTORI-232 / bundle schema v3 added usageResponseJson: JsonObject as a required field on every recorded response so the replayed cost matches the LIVE cost_amount byte-for-byte)`,
      );
    }
    if (typeof usageJson !== "object" || Array.isArray(usageJson)) {
      throw new RecordedBundleSchemaMismatchError(
        bundle.bundleId,
        `response under key '${key}' usageResponseJson must be a JSON object (got ${JSON.stringify(usageJson)})`,
      );
    }
    assertUsageResponseMatchesCost(
      bundle.bundleId,
      key,
      usageJson as JsonObject,
      cost as ProviderCost,
    );
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
  // ITOTORI-232 — `amountUsd` is the authoritative full-precision cost the
  // replayed run persists (and the migration-0041 CHECK validates). It MUST
  // be a plain non-negative decimal string; pre-amountUsd bundles fail here
  // rather than silently replaying a micros-rounded cost.
  if (typeof candidate.amountUsd !== "string" || !/^\d+(\.\d+)?$/u.test(candidate.amountUsd)) {
    throw new RecordedBundleSchemaMismatchError(
      bundleId,
      `response under key '${key}' has invalid amountUsd ${JSON.stringify(candidate.amountUsd)} (expected a non-negative decimal string)`,
    );
  }
  if (candidate.costKind === "zero" && candidate.amountMicrosUsd !== 0) {
    throw new RecordedBundleSchemaMismatchError(
      bundleId,
      `response under key '${key}' is costKind='zero' but amountMicrosUsd=${candidate.amountMicrosUsd} (zero-cost responses must have amountMicrosUsd=0)`,
    );
  }
  if (candidate.costKind === "zero" && Number(candidate.amountUsd) !== 0) {
    throw new RecordedBundleSchemaMismatchError(
      bundleId,
      `response under key '${key}' is costKind='zero' but amountUsd=${candidate.amountUsd} (zero-cost responses must have amountUsd "0")`,
    );
  }
}

/**
 * ITOTORI-230 — validate the `routingPosture` shape on a recorded
 * response. The five required fields are exactly the canonical posture
 * from docs/openrouter-integration.md §3 and the live evidence at
 * docs/openrouter-integration-evidence/2026-06-25.json. Any deviation
 * (missing field, wrong type, `allow_fallbacks: true`) is a typed
 * `RecordedBundleSchemaMismatchError`, not a synthesis-with-fallback
 * site.
 */
function assertRoutingPostureShape(bundleId: string, key: string, posture: unknown): void {
  if (posture === null || typeof posture !== "object" || Array.isArray(posture)) {
    throw new RecordedBundleSchemaMismatchError(
      bundleId,
      `response under key '${key}' routingPosture is not an object`,
    );
  }
  const candidate = posture as Partial<OpenRouterRoutingPosture>;
  if (!Array.isArray(candidate.only) || candidate.only.some((entry) => typeof entry !== "string")) {
    throw new RecordedBundleSchemaMismatchError(
      bundleId,
      `response under key '${key}' routingPosture.only must be a string array (got ${JSON.stringify(candidate.only)})`,
    );
  }
  if (candidate.allow_fallbacks !== false) {
    throw new RecordedBundleSchemaMismatchError(
      bundleId,
      `response under key '${key}' routingPosture.allow_fallbacks must be literal false (got ${JSON.stringify(candidate.allow_fallbacks)}); ITOTORI-220 pair pin requires no silent fallbacks`,
    );
  }
  if (candidate.data_collection !== "deny" && candidate.data_collection !== "allow") {
    throw new RecordedBundleSchemaMismatchError(
      bundleId,
      `response under key '${key}' routingPosture.data_collection must be 'deny' or 'allow' (got ${JSON.stringify(candidate.data_collection)})`,
    );
  }
  if (typeof candidate.zdr !== "boolean") {
    throw new RecordedBundleSchemaMismatchError(
      bundleId,
      `response under key '${key}' routingPosture.zdr must be boolean (got ${JSON.stringify(candidate.zdr)})`,
    );
  }
  if (typeof candidate.require_parameters !== "boolean") {
    throw new RecordedBundleSchemaMismatchError(
      bundleId,
      `response under key '${key}' routingPosture.require_parameters must be boolean (got ${JSON.stringify(candidate.require_parameters)})`,
    );
  }
}

/**
 * ITOTORI-232 — verify the captured `usageResponseJson` is consistent with
 * the captured `ProviderCost` at bundle-construction time. If the bundle
 * carries a `usage.cost` field, it must equal `ProviderCost.amountMicrosUsd`
 * to within 1e-9 USD (the same tolerance the DB CHECK enforces on persist).
 * This catches a mis-recapture before replay; without it, a v3 bundle could
 * silently load and only fail at the ledger-write seam, where the failure
 * mode is less obvious.
 *
 * Zero-cost captures (genuinely-free or synthetic test fixtures) MAY omit
 * the `cost` key in usageResponseJson; the partial-NULL CHECK exempts
 * these. We accept `cost === 0` matching `amountMicrosUsd === 0`, and an
 * absent `cost` key matching `costKind === 'zero'`, as the two truthful
 * representations of "no upstream charge".
 */
function assertUsageResponseMatchesCost(
  bundleId: string,
  key: string,
  usageResponseJson: JsonObject,
  cost: ProviderCost,
): void {
  const declaredCost = usageResponseJson.cost;
  if (declaredCost === undefined || declaredCost === null) {
    // Zero-cost shape: cost key absent. Acceptable only if the captured
    // ProviderCost is also zero — otherwise the bundle would silently
    // claim a cost that does not appear in its own usage block.
    if (cost.costKind !== "zero") {
      throw new RecordedBundleSchemaMismatchError(
        bundleId,
        `response under key '${key}' captured costKind='${cost.costKind}' with amountUsd=${cost.amountUsd} but its usageResponseJson has no 'cost' field; either populate usage.cost from the original LIVE response or re-capture as a zero-cost bundle`,
      );
    }
    return;
  }
  if (typeof declaredCost !== "number" || !Number.isFinite(declaredCost) || declaredCost < 0) {
    throw new RecordedBundleSchemaMismatchError(
      bundleId,
      `response under key '${key}' usageResponseJson.cost must be a finite non-negative number (got ${JSON.stringify(declaredCost)})`,
    );
  }
  // ITOTORI-232 — compare the AUTHORITATIVE full-precision `amountUsd` (the
  // value the ledger actually persists as `cost_amount`) against the
  // declared usage.cost with the same tight bound the DB CHECK uses. Using
  // `amountUsd` — not `amountMicrosUsd / 1e6` — is the fix: micros cannot
  // represent sub-micro costs (`0.00000602`), so the old micros comparison
  // spuriously failed this check on real cheap-model bundles.
  const recordedCostUsd = Number(cost.amountUsd);
  if (Math.abs(recordedCostUsd - declaredCost) >= 1e-9) {
    throw new RecordedBundleSchemaMismatchError(
      bundleId,
      `response under key '${key}' captured cost.amountUsd=${cost.amountUsd} does not match usageResponseJson.cost=${declaredCost} within 1e-9 USD; the bundle would fail ITOTORI-232's ledger CHECK on replay-and-persist`,
    );
  }
}
