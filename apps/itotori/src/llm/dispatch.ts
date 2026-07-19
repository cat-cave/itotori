import { HTTPClient, type Fetcher } from "@openrouter/sdk";
import {
  AuthorizationError,
  injectLlmDurabilityFault,
  LlmPhysicalStepFailedError,
  LlmRetriesExhaustedError,
  LlmSpendAdmissionDeniedError,
  isLlmDurabilityFault,
  type LlmContentReadAuthorizer,
} from "@itotori/db";
import {
  EventType,
  StandardSchemaValidationError,
  chat,
  maxIterations,
  toolDefinition,
  type AnyTool,
  type ChatMiddleware,
  type ModelMessage,
  type UsageInfo,
} from "@tanstack/ai";
import {
  createOpenRouterText,
  type OpenRouterSummarizeModel as OpenRouterModel,
} from "@tanstack/ai-openrouter";
import { z } from "zod";
import {
  CALL_RESULT_SCHEMA_VERSION,
  CallResultSchema,
  CallSpecSchema,
  RebuildCallWirePolicySchema,
  ToolResultSchema,
  assertRebuildLlmStartupPolicy,
  type CallResult,
  type CallSpec,
  type DispatchEvent,
  type EncryptedPayloadRef,
  type ToolName,
  type ToolResult,
} from "../contracts/index.js";
import { sha256 } from "./canonical-json.js";
import {
  createPhysicalStepMemoState,
  memoizePhysicalSteps,
  type PhysicalStepMemoRuntime,
} from "./physical-step-memo.js";
import {
  LlmPhysicalAttemptError,
  createTransportObserver,
  resolveAttemptDeadlineMs,
} from "./physical-attempt-policy.js";
import { normalizeOpenRouterParameters } from "./openrouter-parameter-compat.js";
import {
  preserveReasoningDetails,
  type ReasoningDetailsContinuity,
  type ReasoningDetailsContinuityEvidence,
} from "./reasoning-details-continuity.js";
import type { GenerationLookup } from "./generation-metadata.js";
import { assertCallUsesCertifiedRoleModelProfile } from "./role-model-profiles.js";
import { providerTerminalSchema } from "./terminal-output.js";

export interface DispatchTool {
  readonly name: ToolName;
  readonly description: string;
  readonly inputSchema: z.ZodObject<z.ZodRawShape>;
  readonly execute: (
    input: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined,
  ) => Promise<ToolResult>;
}

export interface DispatchRuntime {
  readonly readPayload: (reference: EncryptedPayloadRef) => Promise<string>;
  readonly tools: readonly DispatchTool[];
  readonly memo: PhysicalStepMemoRuntime;
  readonly contentAccess: LlmContentReadAuthorizer;
  readonly fetcher?: Fetcher;
  /** Resolves the concrete served route after the model response completes. */
  readonly generationLookup?: GenerationLookup;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly onReasoningDetailsContinuity?: (evidence: ReasoningDetailsContinuityEvidence) => void;
}

type UsageAccumulator = {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  sawUsage: boolean;
};

type DispatchState = {
  events: DispatchEvent[];
  usage: UsageAccumulator;
  modelStepCount: number;
  toolCallCount: number;
  stepLimitReached: boolean;
  /** A tool-loop adapter may discard the original injected fault before rethrowing. */
  durabilityFaultCaught: boolean;
  lastFinishReason: "stop" | "tool-calls" | "length" | "content-filter" | "unknown";
};

type FailureKind = Extract<CallResult, { status: "failure" }>["failureKind"];

const EMPTY_USAGE = {
  promptTokens: 0,
  completionTokens: 0,
  reasoningTokens: 0,
  cachedTokens: 0,
  sawUsage: false,
} as const;

class Semaphore {
  readonly #limit: number;
  #active = 0;
  readonly #waiters: Array<() => void> = [];

  constructor(limit: number) {
    this.#limit = limit;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#active >= this.#limit) {
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
    this.#active += 1;
    try {
      return await task();
    } finally {
      this.#active -= 1;
      this.#waiters.shift()?.();
    }
  }
}

async function readPayload(
  runtime: DispatchRuntime,
  reference: EncryptedPayloadRef,
): Promise<string> {
  await runtime.contentAccess.requireContentRead({
    contentRef: reference.storageRef,
    purpose: "dispatch-input",
  });
  const content = await runtime.readPayload(reference);
  if (sha256(content) !== reference.contentHash) {
    throw new Error("encrypted payload content hash mismatch");
  }
  return content;
}

async function modelMessages(
  spec: CallSpec,
  runtime: DispatchRuntime,
  toolsByName: ReadonlyMap<ToolName, DispatchTool>,
): Promise<{ messages: ModelMessage[]; systemPrompts: string[] }> {
  const messages: ModelMessage[] = [];
  const systemPrompts: string[] = [];

  for (const message of spec.messages) {
    if (message.kind === "text") {
      const content = await readPayload(runtime, message.contentEncrypted);
      if (message.role === "system") systemPrompts.push(content);
      else messages.push({ role: message.role, content });
      continue;
    }
    if (message.kind === "tool-result") {
      messages.push({
        role: "tool",
        toolCallId: message.toolCallId,
        content: JSON.stringify(message.result),
      });
      continue;
    }
    if (message.kind === "opaque-reasoning") {
      const content = await readPayload(runtime, message.contentEncrypted);
      messages.push({ role: "assistant", content: "", thinking: [{ content }] });
      continue;
    }

    const toolCalls = await Promise.all(
      message.calls.map(async (call) => {
        const runtimeTool = toolsByName.get(call.tool);
        if (!runtimeTool) throw new Error("conversation references a disallowed tool");
        const rawArguments = await readPayload(runtime, call.argumentsEncrypted);
        let parsedArguments: unknown;
        try {
          parsedArguments = JSON.parse(rawArguments);
        } catch {
          throw new Error("conversation tool arguments are not valid JSON");
        }
        runtimeTool.inputSchema.parse(parsedArguments);
        return {
          id: call.toolCallId,
          type: "function" as const,
          function: { name: call.tool, arguments: rawArguments },
        };
      }),
    );
    messages.push({ role: "assistant", content: null, toolCalls });
  }

  return { messages, systemPrompts };
}

function addUsage(target: UsageAccumulator, usage: UsageInfo): void {
  target.sawUsage = true;
  target.promptTokens += usage.promptTokens;
  target.completionTokens += usage.completionTokens;
  target.reasoningTokens += usage.completionTokensDetails?.reasoningTokens ?? 0;
  target.cachedTokens += usage.promptTokensDetails?.cachedTokens ?? 0;
}

function finishReason(
  value: string | null | undefined,
): "stop" | "length" | "content-filter" | "unknown" {
  if (value === "stop" || value === "length") return value;
  return value === "content_filter" ? "content-filter" : "unknown";
}

function dispatchMiddleware(state: DispatchState, maxToolCalls: number): ChatMiddleware {
  return {
    name: "itotori-dispatch-capture",
    onStart() {
      state.events.push({ kind: "run-started", iteration: 0 });
    },
    onChunk(context, chunk) {
      if (chunk.type !== EventType.RUN_FINISHED) return;
      state.modelStepCount += 1;
      state.lastFinishReason =
        chunk.finishReason === "tool_calls" ? "tool-calls" : finishReason(chunk.finishReason);
      state.events.push({
        kind: "model-step-finished",
        iteration: context.iteration,
        reportedModel: chunk.model ?? null,
        finishReason:
          chunk.finishReason === "tool_calls" ? "tool-calls" : finishReason(chunk.finishReason),
      });
    },
    onBeforeToolCall() {
      state.toolCallCount += 1;
      if (state.toolCallCount <= maxToolCalls) return;
      state.stepLimitReached = true;
      return { type: "abort", reason: "tool-call limit reached" };
    },
    onAfterToolCall(context) {
      if (state.durabilityFaultCaught) {
        context.abort("durability fault injected after tool result");
      }
    },
    onUsage(_context, usage) {
      addUsage(state.usage, usage);
    },
    onFinish(_context, info) {
      state.events.push({
        kind: "run-finished",
        iterationCount: state.modelStepCount,
        toolCallCount: state.toolCallCount,
        finishReason: finishReason(info.finishReason),
      });
    },
    onError() {
      state.events.push({
        kind: "run-finished",
        iterationCount: state.modelStepCount,
        toolCallCount: state.toolCallCount,
        finishReason: "unknown",
      });
    },
  };
}

function runtimeTools(
  spec: CallSpec,
  runtime: DispatchRuntime,
  state: DispatchState,
  semaphore: Semaphore,
): { tools: AnyTool[]; toolsByName: ReadonlyMap<ToolName, DispatchTool> } {
  const available = new Map(runtime.tools.map((tool) => [tool.name, tool]));
  const selected = spec.tools.map((contract) => {
    const tool = available.get(contract.name);
    if (!tool) throw new Error("tool allowlist implementation is missing");
    return tool;
  });
  const selectedByName = new Map(selected.map((tool) => [tool.name, tool]));
  const tools = selected.map((tool) =>
    toolDefinition({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: ToolResultSchema,
    }).server(async (input, context) => {
      const result = await semaphore.run(() => tool.execute(input, context?.abortSignal));
      const parsed = ToolResultSchema.parse(result);
      if (parsed.tool !== tool.name) throw new Error("tool returned a result for another tool");
      state.events.push({
        kind: "tool-step-finished",
        iteration: state.modelStepCount,
        toolCallId: context?.toolCallId ?? "unknown",
        tool: tool.name,
        argumentsHash: sha256(input),
        result: parsed,
      });
      try {
        await injectLlmDurabilityFault(runtime.memo.durabilityFaults, "after-tool-result");
      } catch (error: unknown) {
        if (isLlmDurabilityFault(error)) state.durabilityFaultCaught = true;
        throw error;
      }
      return parsed;
    }),
  );
  return { tools, toolsByName: selectedByName };
}

function failureKind(error: unknown, state: DispatchState): FailureKind {
  if (state.durabilityFaultCaught || isLlmDurabilityFault(error)) return "cancelled";
  if (error instanceof LlmRetriesExhaustedError) return "retries-exhausted";
  if (error instanceof LlmSpendAdmissionDeniedError) return "spend-admission";
  if (error instanceof LlmPhysicalStepFailedError) {
    return error.attemptStatus === "http-error" ? "http" : "transport";
  }
  if (error instanceof LlmPhysicalAttemptError) {
    if (error.failure.classification === "cancelled") return "cancelled";
    return error.failure.kind === "http" ? "http" : "transport";
  }
  if (state.stepLimitReached) return "step-limit";
  if (state.lastFinishReason === "length") return "truncation";
  if (state.lastFinishReason === "content-filter") return "refusal";
  if (error instanceof StandardSchemaValidationError || error instanceof z.ZodError) {
    return "schema-failure";
  }
  if (error instanceof AuthorizationError) return "permission";
  const message = error instanceof Error ? error.message : "";
  if (
    /measured model profile|call route does not match|role model profile|rebuilt LLM requires|operator assertions/iu.test(
      message,
    )
  ) {
    return "configuration";
  }
  if (/parse structured output|not valid JSON/iu.test(message)) return "invalid-json";
  if (/no content|missing structured result/iu.test(message)) return "empty-output";
  if (/tool arguments|tool allowlist|tool returned/iu.test(message)) {
    return "invalid-tool-arguments";
  }
  if (/validation|invalid input|expected|schema/iu.test(message)) return "schema-failure";
  return "transport";
}

/** The only production boundary that constructs an OpenRouter-backed model adapter. */
export async function dispatch(specInput: CallSpec, runtime: DispatchRuntime): Promise<CallResult> {
  const spec = CallSpecSchema.parse(specInput);
  assertCallUsesCertifiedRoleModelProfile(spec);
  const requested = { model: spec.requestedModel };
  const env = runtime.env ?? process.env;
  assertRebuildLlmStartupPolicy(env);
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("rebuilt LLM requires OPENROUTER_API_KEY");
  RebuildCallWirePolicySchema.parse({
    model: spec.requestedModel,
    provider: spec.providerPolicy,
    headers: { "X-OpenRouter-Metadata": "enabled", "X-OpenRouter-Cache": "false" },
    plugins: [],
    remoteCache: false,
    hiddenRetries: false,
  });
  const state: DispatchState = {
    events: [],
    usage: { ...EMPTY_USAGE },
    modelStepCount: 0,
    toolCallCount: 0,
    stepLimitReached: false,
    durabilityFaultCaught: false,
    lastFinishReason: "unknown",
  };
  const memoState = createPhysicalStepMemoState();
  const memo = {
    ...runtime.memo,
    ...(runtime.generationLookup ? { generationLookup: runtime.generationLookup } : {}),
  };
  let reasoningContinuity: ReasoningDetailsContinuity | undefined;

  try {
    if (spec.tools.length > 0 && spec.limits.maxSteps < 2) {
      state.stepLimitReached = true;
      throw new Error("tool use requires room for a terminal model step");
    }

    const semaphore = new Semaphore(spec.limits.maxParallelTools);
    const configuredTools = runtimeTools(spec, runtime, state, semaphore);
    const converted = await modelMessages(spec, runtime, configuredTools.toolsByName);
    reasoningContinuity = preserveReasoningDetails(
      normalizeOpenRouterParameters(runtime.fetcher ?? globalThis.fetch),
    );
    const observer = createTransportObserver(
      reasoningContinuity.fetcher,
      runtime.memo.durabilityFaults,
    );
    const httpClient = new HTTPClient({ fetcher: observer.fetcher });
    httpClient.addHook("beforeRequest", (request) => {
      const headers = new Headers(request.headers);
      headers.set("X-OpenRouter-Metadata", "enabled");
      headers.set("X-OpenRouter-Cache", "false");
      return new Request(request, { headers });
    });
    const adapter = memoizePhysicalSteps(
      createOpenRouterText(spec.requestedModel as OpenRouterModel, apiKey, {
        httpClient,
        retryConfig: { strategy: "none" },
        timeoutMs: resolveAttemptDeadlineMs(spec, runtime.memo.profile),
      }),
      spec,
      memo,
      memoState,
      observer,
    );

    const value = await chat({
      adapter,
      messages: converted.messages,
      systemPrompts: converted.systemPrompts,
      tools: spec.limits.maxToolCalls === 0 ? [] : configuredTools.tools,
      outputSchema: providerTerminalSchema(spec.output),
      agentLoopStrategy: maxIterations(Math.max(1, spec.limits.maxSteps - 1)),
      modelOptions: {
        provider: spec.providerPolicy,
        plugins: [],
        reasoning: { effort: spec.reasoning.effort },
        temperature: spec.sampling.temperature,
        topP: spec.sampling.topP,
        ...(spec.sampling.seed === null ? {} : { seed: spec.sampling.seed }),
        maxCompletionTokens: spec.limits.maxOutputTokens,
        ...(spec.tools.length > 0 && spec.limits.maxParallelTools > 1
          ? { parallelToolCalls: true }
          : {}),
      },
      middleware: [dispatchMiddleware(state, spec.limits.maxToolCalls)],
      debug: false,
    });

    if (!state.usage.sawUsage) throw new Error("provider response omitted usage");
    const finalStep = memoState.receipts.at(-1);
    if (!finalStep) throw new Error("provider response was not durably memoized");
    if (memoState.receipts.some((receipt) => receipt.verification.status === "quarantined")) {
      return CallResultSchema.parse({
        schemaVersion: CALL_RESULT_SCHEMA_VERSION,
        memoKey: finalStep.memoKey,
        requested,
        memoHit: finalStep.memoHit,
        status: "failure",
        failureKind: "quarantined",
        responseEventId: finalStep.responseEventId,
        responseEncrypted: finalStep.responseEncrypted,
        served: finalStep.verification.served,
        generationId: finalStep.verification.generationId,
        verification: "quarantined",
        usage: finalStep.usage,
        billing: finalStep.billing,
        defects: [],
        events: state.events,
      });
    }
    const verification = finalStep.verification;
    if (verification.status === "quarantined") {
      throw new Error("quarantined receipt passed the projection guard");
    }
    if (finalStep.usage === null) throw new Error("accepted response omitted usage");
    const result = {
      schemaVersion: CALL_RESULT_SCHEMA_VERSION,
      memoKey: finalStep.memoKey,
      requested,
      memoHit: finalStep.memoHit,
      status: "success",
      value,
      responseEventId: finalStep.responseEventId,
      served: verification.served,
      generationId: verification.generationId,
      verification: verification.status,
      usage: finalStep.usage,
      billing: finalStep.billing,
      events: state.events,
    } as const;
    return CallResultSchema.parse(result);
  } catch (error: unknown) {
    if (memoState.conflict) throw memoState.conflict;
    const finalStep = memoState.receipts.at(-1);
    const memoKey = memoState.lastMemoKey ?? sha256(spec);
    const completedLastStep = finalStep?.memoKey === memoKey;
    const kind = failureKind(error, state);
    const defectCode =
      kind === "invalid-json"
        ? "invalid-json"
        : kind === "invalid-tool-arguments"
          ? "invalid-tool-arguments"
          : "schema";
    return CallResultSchema.parse({
      schemaVersion: CALL_RESULT_SCHEMA_VERSION,
      memoKey,
      requested,
      memoHit: completedLastStep ? (finalStep?.memoHit ?? false) : false,
      status: "failure",
      failureKind: kind,
      responseEventId: completedLastStep ? (finalStep?.responseEventId ?? null) : null,
      responseEncrypted: completedLastStep ? (finalStep?.responseEncrypted ?? null) : null,
      served: completedLastStep
        ? (finalStep?.verification.served ?? { status: "unknown" })
        : { status: "unknown" },
      generationId: completedLastStep ? (finalStep?.verification.generationId ?? null) : null,
      verification: completedLastStep
        ? (finalStep?.verification.status ?? "unverified")
        : "unverified",
      usage: completedLastStep ? (finalStep?.usage ?? null) : null,
      billing: completedLastStep
        ? (finalStep?.billing ?? { status: "billing-unknown" })
        : { status: "billing-unknown" },
      defects:
        kind === "step-limit" ||
        kind === "transport" ||
        kind === "http" ||
        kind === "cancelled" ||
        kind === "retries-exhausted" ||
        kind === "spend-admission" ||
        kind === "configuration" ||
        kind === "permission"
          ? []
          : [{ path: [], code: defectCode, message: `terminal ${kind}` }],
      events: state.events,
    });
  } finally {
    if (reasoningContinuity) {
      runtime.onReasoningDetailsContinuity?.(reasoningContinuity.evidence());
    }
  }
}
