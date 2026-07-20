import {
  injectLlmDurabilityFault,
  LlmMemoConflictError,
  type LlmAttemptFailure,
  type LlmCallMemoStore,
} from "@itotori/db";
import { EventType, type AnyTextAdapter, type StreamChunk, type TextOptions } from "@tanstack/ai";
import {
  CONTEXT_SNAPSHOT_SCHEMA_VERSION,
  LOCALIZATION_SNAPSHOT_SCHEMA_VERSION,
  PHYSICAL_STEP_MEMO_KEY_SCHEMA_VERSION,
  PHYSICAL_STEP_MEMO_SCHEMA_VERSION,
  PhysicalStepMemoKeySchema,
  PhysicalStepMemoSchema,
  type CallSpec,
  type EncryptedPayloadRef,
  type PhysicalStepMemo,
} from "../contracts/index.js";
import { canonicalJson, sha256 } from "./canonical-json.js";
import { memoEncryptedRef } from "./physical-step-outcome.js";
import {
  LlmPhysicalAttemptError,
  memoizedPhysicalAttempt,
  type PhysicalAttemptControl,
  type PhysicalAttemptRuntime,
  type TransportObserver,
} from "./physical-attempt-policy.js";
import {
  completedStreamStep,
  completedStructuredStep,
  type PhysicalStepIdentity,
} from "./physical-step-completion.js";
import { captureGenerationMetadata } from "./generation-metadata.js";
import type { GenerationLookup } from "./generation-metadata.js";

const TANSTACK_VERSION = "0.40.0";
const OPENROUTER_ADAPTER_VERSION = "0.15.8";

export interface PhysicalStepMemoRuntime extends PhysicalAttemptRuntime {
  readonly store: LlmCallMemoStore;
  readonly generationLookup?: GenerationLookup;
  readonly snapshots: {
    decodeRevisionHash: `sha256:${string}`;
    glossaryRevisionHash: `sha256:${string}`;
    styleRevisionHash: `sha256:${string}`;
    acceptedOutputHeadHash: `sha256:${string}` | null;
  };
}

export interface PhysicalStepReceipt {
  memoKey: `sha256:${string}`;
  responseEventId: `sha256:${string}`;
  responseEncrypted: EncryptedPayloadRef;
  verification: PhysicalStepMemo["value"]["verification"];
  usage: PhysicalStepMemo["value"]["usage"];
  billing: PhysicalStepMemo["value"]["billing"];
  memoHit: boolean;
}

export interface PhysicalStepMemoState {
  receipts: PhysicalStepReceipt[];
  lastMemoKey: `sha256:${string}` | null;
  conflict: LlmMemoConflictError | null;
}

type Boundary = "chat" | "structured-output";
type StructuredOutputOptions = Parameters<AnyTextAdapter["structuredOutput"]>[0];
type StructuredOutputResult = Awaited<ReturnType<AnyTextAdapter["structuredOutput"]>>;
type PhysicalRequest = {
  boundary: Boundary;
  model: string;
  messages: unknown;
  systemPrompts: unknown;
  tools: unknown;
  metadata: unknown;
  modelOptions: unknown;
  outputSchema: unknown;
};

export function createPhysicalStepMemoState(): PhysicalStepMemoState {
  return { receipts: [], lastMemoKey: null, conflict: null };
}

export function memoizePhysicalSteps(
  adapter: AnyTextAdapter,
  spec: CallSpec,
  runtime: PhysicalStepMemoRuntime,
  state: PhysicalStepMemoState,
  observer: TransportObserver,
): AnyTextAdapter {
  let stepOrdinal = 0;
  let parentResponseEventId: string = spec.parentEventId;

  const nextIdentity = (boundary: Boundary, request: PhysicalRequest): PhysicalStepIdentity => {
    const identity = deriveStepIdentity(spec, runtime, boundary, stepOrdinal, request);
    stepOrdinal += 1;
    state.lastMemoKey = asHash(identity.key.memoKey);
    return identity;
  };

  const replayStream = async function* (
    boundary: Boundary,
    options: TextOptions<Record<string, unknown>>,
    outbound: (signal: AbortSignal) => AsyncIterable<StreamChunk>,
  ): AsyncIterable<StreamChunk> {
    if (runtime.signal?.aborted) throw cancelledPhysicalStep();
    const request = physicalRequest(boundary, options, options.outputSchema);
    const identity = nextIdentity(boundary, request);
    try {
      const stored = await memoizedPhysicalAttempt({
        store: runtime.store,
        spec,
        runtime,
        observer,
        memo: {
          memoKey: identity.key.memoKey,
          semanticHash: identity.key.semanticHash,
          schemaVersion: PHYSICAL_STEP_MEMO_SCHEMA_VERSION,
          requestJson: identity.requestJson,
        },
        execute: async (attempt, control) => {
          const chunks: StreamChunk[] = [];
          // The model request is in flight until the stream is fully collected.
          // A transport failure raised in this window is a retryable mid-flight
          // drop; a failure raised afterward (completion phase) is not.
          let streamPhase = true;
          try {
            await injectLlmDurabilityFault(runtime.durabilityFaults, "before-dispatch");
            await collectStreamChunks(outbound(control.signal), control, chunks);
            const runError = chunks.findLast((chunk) => chunk.type === EventType.RUN_ERROR);
            // A RUN_ERROR chunk is the adapter reporting that the model stream
            // itself failed — classify it in the stream phase so a transient
            // drop after a good response header is retried, not aborted.
            const failure = runError ? control.failure(runError, "stream") : null;
            if (runError && failure) return incompleteStep(chunks, failure);
            streamPhase = false;
            await injectLlmDurabilityFault(runtime.durabilityFaults, "after-remote-response");
            return completedStreamStep(spec, identity, chunks, attempt, parentResponseEventId, {
              observedGenerationId: await observer.takeGenerationId(),
              ...(runtime.generationLookup
                ? {
                    generationLookup: (generationId) =>
                      runtime.generationLookup!(generationId, control.signal),
                  }
                : {}),
            });
          } catch (error: unknown) {
            const failure =
              control.failure(error, streamPhase ? "stream" : "completion") ??
              permanentAttemptFailure();
            return incompleteStep(chunks, failure);
          }
        },
      });
      if (stored.kind === "completed") {
        const memo = PhysicalStepMemoSchema.parse(JSON.parse(stored.outcomeJson));
        const responseEventId = asHash(stored.responseEventId);
        parentResponseEventId = responseEventId;
        state.receipts.push({
          memoKey: asHash(identity.key.memoKey),
          responseEventId,
          responseEncrypted: identity.responseRef(stored.responseJson),
          verification: memo.value.verification,
          usage: memo.value.usage,
          billing: memo.value.billing,
          memoHit: stored.memoHit,
        });
      }
      for (const chunk of parseChunks(stored.responseJson)) yield chunk;
    } catch (error: unknown) {
      if (error instanceof LlmMemoConflictError) state.conflict = error;
      throw error;
    }
  };

  const replayStructured = async (
    options: StructuredOutputOptions,
  ): Promise<StructuredOutputResult> => {
    if (runtime.signal?.aborted) throw cancelledPhysicalStep();
    const request = physicalRequest("structured-output", options.chatOptions, options.outputSchema);
    const identity = nextIdentity("structured-output", request);
    try {
      const stored = await memoizedPhysicalAttempt({
        store: runtime.store,
        spec,
        runtime,
        observer,
        memo: {
          memoKey: asHash(identity.key.memoKey),
          semanticHash: identity.key.semanticHash,
          schemaVersion: PHYSICAL_STEP_MEMO_SCHEMA_VERSION,
          requestJson: identity.requestJson,
        },
        execute: async (attempt, control) => {
          try {
            await injectLlmDurabilityFault(runtime.durabilityFaults, "before-dispatch");
            const result = await control.race(
              adapter.structuredOutput({
                ...options,
                chatOptions: withSignal(options.chatOptions, control.signal),
              }),
            );
            await injectLlmDurabilityFault(runtime.durabilityFaults, "after-remote-response");
            return completedStructuredStep(spec, identity, result, attempt, parentResponseEventId, {
              observedGenerationId: await observer.takeGenerationId(),
              ...(runtime.generationLookup
                ? {
                    generationLookup: (generationId) =>
                      runtime.generationLookup!(generationId, control.signal),
                  }
                : {}),
            });
          } catch (error: unknown) {
            // The structured call is a single in-flight remote request, so a
            // transport failure after a good header is a retryable stream drop.
            const failure = control.failure(error, "stream") ?? permanentAttemptFailure();
            return {
              kind: "incomplete",
              responseJson: null,
              attemptStatus: attemptStatus(failure.kind),
              httpStatus: failure.httpStatus,
              generationId: null,
              served: { status: "unknown" },
              routerAttempts: [],
              usage: null,
              billing: { status: "billing_unknown" },
              reportedCostUsd: null,
              failure,
              completedAt: new Date().toISOString(),
            };
          }
        },
      });
      if (stored.kind !== "completed") throw new Error("structured model step was incomplete");
      const memo = PhysicalStepMemoSchema.parse(JSON.parse(stored.outcomeJson));
      const responseEventId = asHash(stored.responseEventId);
      parentResponseEventId = responseEventId;
      state.receipts.push({
        memoKey: asHash(identity.key.memoKey),
        responseEventId,
        responseEncrypted: identity.responseRef(stored.responseJson),
        verification: memo.value.verification,
        usage: memo.value.usage,
        billing: memo.value.billing,
        memoHit: stored.memoHit,
      });
      return parseStructuredResult(stored.responseJson);
    } catch (error: unknown) {
      if (error instanceof LlmMemoConflictError) state.conflict = error;
      throw error;
    }
  };

  return {
    kind: adapter.kind,
    name: adapter.name,
    model: adapter.model,
    ...(adapter.requires ? { requires: adapter.requires } : {}),
    "~types": adapter["~types"],
    chatStream: (options) =>
      replayStream("chat", options, (signal) =>
        adapter.chatStream(withSignal(withCombinedOutputSchema(options), signal)),
      ),
    structuredOutput: replayStructured,
    ...(adapter.structuredOutputStream
      ? {
          structuredOutputStream: (options: StructuredOutputOptions) =>
            replayStream("structured-output", options.chatOptions, (signal) =>
              adapter.structuredOutputStream!({
                ...options,
                chatOptions: withSignal(options.chatOptions, signal),
              }),
            ),
        }
      : {}),
    // OpenRouter accepts response_format alongside tools, but its adapter does
    // not yet advertise that capability. The proxy adds the already-converted
    // schema to its model options above, so the terminal turn remains one
    // schema-constrained physical step rather than an unstructured turn plus
    // a separate finalization request.
    supportsCombinedToolsAndSchema: () => true,
  };
}

function withCombinedOutputSchema<T extends TextOptions<Record<string, unknown>>>(options: T): T {
  if (!options.outputSchema) return options;
  return {
    ...options,
    modelOptions: {
      ...options.modelOptions,
      responseFormat: {
        type: "json_schema",
        jsonSchema: {
          name: "structured_output",
          schema: options.outputSchema,
          strict: true,
        },
      },
    },
  };
}

function deriveStepIdentity(
  spec: CallSpec,
  runtime: PhysicalStepMemoRuntime,
  boundary: Boundary,
  stepOrdinal: number,
  request: PhysicalRequest,
): PhysicalStepIdentity {
  const projected = [
    ...asArray(request.systemPrompts).map((message, index) =>
      projectedMessage("system", index, message),
    ),
    ...asArray(request.messages).map((message, index) =>
      projectedMessage("message", index, message),
    ),
  ];
  const semantic = {
    substrate: {
      name: "tanstack-ai" as const,
      version: TANSTACK_VERSION,
      openRouterAdapterVersion: OPENROUTER_ADAPTER_VERSION,
    },
    purpose: spec.purpose,
    roleId: spec.roleId,
    modelProfile: spec.modelProfile,
    modelProfileVersion: spec.modelProfileVersion,
    requestedModel: spec.requestedModel,
    providerPolicy: spec.providerPolicy,
    parentEventHash: spec.parentEventId,
    projectedMessages: projected,
    promptVersion: spec.promptVersion,
    tools: spec.tools,
    orderedToolResultHashes: asArray(request.messages)
      .filter(isToolMessage)
      .map((message) => sha256(message)),
    terminalSchema: spec.output,
    reasoning: spec.reasoning,
    sampling: spec.sampling,
    limits: spec.limits,
    snapshots: {
      contextSnapshotId: spec.contextSnapshotId,
      contextSnapshotSchemaVersion: CONTEXT_SNAPSHOT_SCHEMA_VERSION,
      localizationSnapshotId: spec.localizationSnapshotId,
      localizationSnapshotSchemaVersion: spec.localizationSnapshotId
        ? LOCALIZATION_SNAPSHOT_SCHEMA_VERSION
        : null,
      ...runtime.snapshots,
    },
    sampleId: spec.sampleId,
  };
  const memoKey = sha256({
    schemaVersion: PHYSICAL_STEP_MEMO_KEY_SCHEMA_VERSION,
    parentEventId: spec.parentEventId,
    purpose: spec.purpose,
    roleId: spec.roleId,
    sampleId: spec.sampleId,
    boundary,
    stepOrdinal,
  });
  const key = PhysicalStepMemoKeySchema.parse({
    schemaVersion: PHYSICAL_STEP_MEMO_KEY_SCHEMA_VERSION,
    memoKey,
    semanticHash: sha256({ semantic, request }),
    semantic,
  });
  const requestJson = canonicalJson({ key, physicalRequest: request });
  return {
    key,
    requestJson,
    responseRef: (responseJson) => memoEncryptedRef(memoKey, "response", responseJson),
  };
}

function physicalRequest(
  boundary: Boundary,
  options: TextOptions<Record<string, unknown>>,
  outputSchema: unknown,
): PhysicalRequest {
  return {
    boundary,
    model: options.model,
    messages: options.messages,
    systemPrompts: options.systemPrompts ?? [],
    tools: (options.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      needsApproval: tool.needsApproval ?? false,
      lazy: tool.lazy ?? false,
      metadata: tool.metadata ?? null,
    })),
    metadata: options.metadata ?? null,
    modelOptions: options.modelOptions ?? null,
    outputSchema: outputSchema ?? null,
  };
}

function projectedMessage(kind: string, index: number, message: unknown) {
  const eventHash = sha256(message);
  return { eventId: sha256({ kind, index, eventHash }), eventHash };
}

function attemptStatus(
  kind: "transport" | "http" | "deadline" | "cancelled",
): "transport-error" | "http-error" | "cancelled" {
  if (kind === "http") return "http-error";
  return kind === "cancelled" ? "cancelled" : "transport-error";
}

async function collectStreamChunks(
  stream: AsyncIterable<StreamChunk>,
  control: PhysicalAttemptControl,
  chunks: StreamChunk[],
): Promise<void> {
  const iterator = stream[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = await control.race(iterator.next());
      if (next.done) return;
      chunks.push(next.value);
    }
  } finally {
    // Do not await a non-cooperative iterator's cleanup: the deadline must
    // settle this physical attempt even when the provider ignores abort.
    if (control.signal.aborted) void iterator.return?.().catch(() => undefined);
  }
}

async function incompleteStep(chunks: StreamChunk[], failure: LlmAttemptFailure) {
  const metadata = captureGenerationMetadata(chunks);
  return {
    kind: "incomplete" as const,
    responseJson: canonicalJson(chunks),
    attemptStatus: attemptStatus(failure.kind),
    httpStatus: failure.httpStatus,
    generationId: metadata.generationId,
    served: metadata.served,
    routerAttempts: metadata.routerAttempts,
    usage: metadata.usage,
    billing: { status: "billing_unknown" as const },
    reportedCostUsd: metadata.reportedCostUsd,
    failure,
    completedAt: new Date().toISOString(),
  };
}

function permanentAttemptFailure() {
  return {
    classification: "permanent" as const,
    kind: "transport" as const,
    httpStatus: null,
    retryAfterMs: null,
  };
}

function cancelledPhysicalStep(): LlmPhysicalAttemptError {
  return new LlmPhysicalAttemptError({
    classification: "cancelled",
    kind: "cancelled",
    httpStatus: null,
    retryAfterMs: null,
  });
}

function withSignal<T extends TextOptions<Record<string, unknown>>>(
  options: T,
  signal: AbortSignal,
): T {
  const request = options.request;
  const existingSignal = request instanceof Request ? request.signal : request?.signal;
  const combined = existingSignal ? AbortSignal.any([existingSignal, signal]) : signal;
  const headers = request instanceof Request ? request.headers : request?.headers;
  return {
    ...options,
    request: { ...(headers === undefined ? {} : { headers }), signal: combined },
  } as T;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isToolMessage(value: unknown): boolean {
  return typeof value === "object" && value !== null && "role" in value && value.role === "tool";
}

function parseChunks(json: string | null): StreamChunk[] {
  if (json === null) return [];
  const parsed: unknown = JSON.parse(json);
  if (
    !Array.isArray(parsed) ||
    parsed.some((chunk) => typeof chunk !== "object" || chunk === null)
  ) {
    throw new Error("memoized physical response is not a stream chunk array");
  }
  return parsed as StreamChunk[];
}

function parseStructuredResult(json: string): StructuredOutputResult {
  const parsed: unknown = JSON.parse(json);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("data" in parsed) ||
    !("rawText" in parsed)
  ) {
    throw new Error("memoized structured response is invalid");
  }
  const rawText = parsed.rawText;
  if (typeof rawText !== "string") throw new Error("memoized structured raw text is invalid");
  return { data: parsed.data, rawText };
}

function asHash(value: string): `sha256:${string}` {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) throw new Error("memo identity is not a SHA-256 hash");
  return value as `sha256:${string}`;
}
