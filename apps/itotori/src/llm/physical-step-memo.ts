import {
  LlmMemoConflictError,
  type CompletedLlmStep,
  type LlmCallMemoStore,
  type LlmStepAttemptContext,
} from "@itotori/db";
import {
  EventType,
  type AnyTextAdapter,
  type StreamChunk,
  type TextOptions,
  type TokenUsage,
} from "@tanstack/ai";
import {
  CONTEXT_SNAPSHOT_SCHEMA_VERSION,
  CONVERSATION_EVENT_SCHEMA_VERSION,
  LOCALIZATION_SNAPSHOT_SCHEMA_VERSION,
  PHYSICAL_STEP_MEMO_KEY_SCHEMA_VERSION,
  PHYSICAL_STEP_MEMO_SCHEMA_VERSION,
  PHYSICAL_STEP_MEMO_VALUE_SCHEMA_VERSION,
  PhysicalStepMemoKeySchema,
  PhysicalStepMemoSchema,
  type CallSpec,
  type EncryptedPayloadRef,
  type PhysicalStepMemoKey,
} from "../contracts/index.js";
import { canonicalJson, sha256 } from "./canonical-json.js";
import {
  emptyUsage,
  invalidMemoOutcome,
  memoEncryptedRef,
  streamMemoOutcome,
  usageFromChunks,
  type PhysicalStepMemoOutcome,
} from "./physical-step-outcome.js";
import { terminalOutputSchema } from "./terminal-output.js";

const TANSTACK_VERSION = "0.40.0";
const OPENROUTER_ADAPTER_VERSION = "0.15.8";

export interface PhysicalStepMemoRuntime {
  readonly store: LlmCallMemoStore;
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

type StepIdentity = {
  key: PhysicalStepMemoKey;
  requestJson: string;
  responseRef: (responseJson: string) => EncryptedPayloadRef;
};

export function createPhysicalStepMemoState(): PhysicalStepMemoState {
  return { receipts: [], lastMemoKey: null, conflict: null };
}

export function memoizePhysicalSteps(
  adapter: AnyTextAdapter,
  spec: CallSpec,
  runtime: PhysicalStepMemoRuntime,
  state: PhysicalStepMemoState,
): AnyTextAdapter {
  let stepOrdinal = 0;
  let parentResponseEventId: string = spec.parentEventId;

  const nextIdentity = (boundary: Boundary, request: PhysicalRequest): StepIdentity => {
    const identity = deriveStepIdentity(spec, runtime, boundary, stepOrdinal, request);
    stepOrdinal += 1;
    state.lastMemoKey = asHash(identity.key.memoKey);
    return identity;
  };

  const replayStream = async function* (
    boundary: Boundary,
    options: TextOptions<Record<string, unknown>>,
    outbound: () => AsyncIterable<StreamChunk>,
  ): AsyncIterable<StreamChunk> {
    const request = physicalRequest(boundary, options, options.outputSchema);
    const identity = nextIdentity(boundary, request);
    try {
      const stored = await runtime.store.singleflight({
        memoKey: identity.key.memoKey,
        semanticHash: identity.key.semanticHash,
        schemaVersion: PHYSICAL_STEP_MEMO_SCHEMA_VERSION,
        requestJson: identity.requestJson,
        execute: async (attempt) => {
          const chunks: StreamChunk[] = [];
          for await (const chunk of outbound()) chunks.push(chunk);
          const responseJson = canonicalJson(chunks);
          const runError = chunks.findLast((chunk) => chunk.type === EventType.RUN_ERROR);
          if (runError && !isCompletedInvalidResponse(runError)) {
            return {
              kind: "incomplete",
              responseJson,
              attemptStatus: "transport-error",
              httpStatus: null,
              generationId: null,
              billing: { status: "billing_unknown" },
              completedAt: new Date().toISOString(),
            };
          }
          return completedStreamStep(spec, identity, chunks, attempt, parentResponseEventId);
        },
      });
      if (stored.kind === "completed") {
        PhysicalStepMemoSchema.parse(JSON.parse(stored.outcomeJson));
        const responseEventId = asHash(stored.responseEventId);
        parentResponseEventId = responseEventId;
        state.receipts.push({
          memoKey: asHash(identity.key.memoKey),
          responseEventId,
          responseEncrypted: identity.responseRef(stored.responseJson),
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
    const request = physicalRequest("structured-output", options.chatOptions, options.outputSchema);
    const identity = nextIdentity("structured-output", request);
    try {
      const stored = await runtime.store.singleflight({
        memoKey: asHash(identity.key.memoKey),
        semanticHash: identity.key.semanticHash,
        schemaVersion: PHYSICAL_STEP_MEMO_SCHEMA_VERSION,
        requestJson: identity.requestJson,
        execute: async (attempt) => {
          const result = await adapter.structuredOutput(options);
          return completedStructuredStep(spec, identity, result, attempt, parentResponseEventId);
        },
      });
      if (stored.kind !== "completed") throw new Error("structured model step was incomplete");
      PhysicalStepMemoSchema.parse(JSON.parse(stored.outcomeJson));
      const responseEventId = asHash(stored.responseEventId);
      parentResponseEventId = responseEventId;
      state.receipts.push({
        memoKey: asHash(identity.key.memoKey),
        responseEventId,
        responseEncrypted: identity.responseRef(stored.responseJson),
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
    chatStream: (options) => replayStream("chat", options, () => adapter.chatStream(options)),
    structuredOutput: replayStructured,
    ...(adapter.structuredOutputStream
      ? {
          structuredOutputStream: (options: StructuredOutputOptions) =>
            replayStream("structured-output", options.chatOptions, () =>
              adapter.structuredOutputStream!(options),
            ),
        }
      : {}),
    ...(adapter.supportsCombinedToolsAndSchema
      ? {
          supportsCombinedToolsAndSchema: (options?: Record<string, unknown>) =>
            adapter.supportsCombinedToolsAndSchema!(options),
        }
      : {}),
  };
}

function deriveStepIdentity(
  spec: CallSpec,
  runtime: PhysicalStepMemoRuntime,
  boundary: Boundary,
  stepOrdinal: number,
  request: PhysicalRequest,
): StepIdentity {
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

function completedStreamStep(
  spec: CallSpec,
  identity: StepIdentity,
  chunks: readonly StreamChunk[],
  attempt: LlmStepAttemptContext,
  parentResponseEventId: string,
): CompletedLlmStep {
  const responseJson = canonicalJson(chunks);
  const outcome = streamMemoOutcome(spec, identity.key.memoKey, chunks);
  const completedAt = new Date().toISOString();
  return completedStep(
    spec,
    identity,
    responseJson,
    outcome,
    usageFromChunks(chunks),
    attempt,
    parentResponseEventId,
    completedAt,
  );
}

function completedStructuredStep(
  spec: CallSpec,
  identity: StepIdentity,
  result: StructuredOutputResult,
  attempt: LlmStepAttemptContext,
  parentResponseEventId: string,
): CompletedLlmStep {
  const responseJson = canonicalJson(result);
  const parsed = terminalOutputSchema(spec.output).safeParse(result.data);
  const outcome = parsed.success
    ? ({ kind: "terminal", output: parsed.data } as const)
    : invalidMemoOutcome(
        "schema-failure",
        parsed.error.issues.map((issue) => issue.message),
      );
  const completedAt = new Date().toISOString();
  return completedStep(
    spec,
    identity,
    responseJson,
    outcome,
    result.usage ?? emptyUsage(),
    attempt,
    parentResponseEventId,
    completedAt,
  );
}

function completedStep(
  spec: CallSpec,
  identity: StepIdentity,
  responseJson: string,
  outcome: PhysicalStepMemoOutcome,
  usage: TokenUsage,
  attempt: LlmStepAttemptContext,
  parentResponseEventId: string,
  completedAt: string,
): CompletedLlmStep {
  const responseEventId = sha256({
    memoKey: identity.key.memoKey,
    responseHash: sha256(responseJson),
  });
  const memoBilling = { status: "billing-unknown" as const };
  const normalizedUsage = {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    reasoningTokens: usage.completionTokensDetails?.reasoningTokens ?? 0,
    cachedTokens: usage.promptTokensDetails?.cachedTokens ?? 0,
  };
  const memo = PhysicalStepMemoSchema.parse({
    schemaVersion: PHYSICAL_STEP_MEMO_SCHEMA_VERSION,
    key: identity.key,
    value: {
      schemaVersion: PHYSICAL_STEP_MEMO_VALUE_SCHEMA_VERSION,
      memoKey: identity.key.memoKey,
      requestEncrypted: memoEncryptedRef(identity.key.memoKey, "request", identity.requestJson),
      responseEncrypted: identity.responseRef(responseJson),
      outcome,
      verification: {
        status: "quarantined",
        generationId: null,
        served: null,
        reason: "served route verification pending",
      },
      requestedModel: spec.requestedModel,
      providerPolicy: spec.providerPolicy,
      routerAttempts: [
        {
          ordinal: attempt.ordinal,
          provider: null,
          startedAt: attempt.startedAt,
          completedAt,
          httpStatus: 200,
          generationId: null,
          billing: memoBilling,
        },
      ],
      usage: normalizedUsage,
      billing: memoBilling,
      completedAt,
    },
  });
  const outcomeJson = canonicalJson(memo);
  return {
    kind: "completed",
    responseJson,
    outcomeJson,
    outcomeKind: outcome.kind,
    verificationStatus: "quarantined",
    generationId: null,
    requestedModel: spec.requestedModel,
    providerPolicy: spec.providerPolicy,
    servedModel: null,
    servedProvider: null,
    usage: normalizedUsage,
    billing: { status: "billing_unknown" },
    completedAt,
    responseEvent: {
      eventId: responseEventId,
      schemaVersion: CONVERSATION_EVENT_SCHEMA_VERSION,
      parentEventIds: [parentResponseEventId],
      snapshotKind: spec.localizationSnapshotId ? "localization" : "context",
      snapshotId: spec.localizationSnapshotId ?? spec.contextSnapshotId,
      actorRole: spec.roleId,
      bodyJson: canonicalJson({
        kind: "physical-model-response",
        memoKey: identity.key.memoKey,
        responseHash: sha256(responseJson),
        outcomeKind: outcome.kind,
      }),
    },
  };
}

function projectedMessage(kind: string, index: number, message: unknown) {
  const eventHash = sha256(message);
  return { eventId: sha256({ kind, index, eventHash }), eventHash };
}

function isCompletedInvalidResponse(error: Extract<StreamChunk, { type: EventType.RUN_ERROR }>) {
  return /parse structured output|valid JSON|schema validation/iu.test(error.message);
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
