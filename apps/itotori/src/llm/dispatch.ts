import { createHash } from "node:crypto";
import { HTTPClient, type Fetcher } from "@openrouter/sdk";
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
  DefectBundleSchema,
  DraftBatchSchema,
  LocalizedRenderingSchema,
  RebuildCallWirePolicySchema,
  ReviewVerdictSchema,
  ToolResultSchema,
  WikiObjectSchema,
  assertRebuildLlmStartupPolicy,
  type CallResult,
  type CallSpec,
  type DispatchEvent,
  type EncryptedPayloadRef,
  type TerminalOutput,
  type ToolName,
  type ToolResult,
} from "../contracts/index.js";

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
  readonly fetcher?: Fetcher;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

type UsageAccumulator = {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  reportedCost: number;
  sawUsage: boolean;
  sawCost: boolean;
};

type DispatchState = {
  events: DispatchEvent[];
  usage: UsageAccumulator;
  servedModel: string;
  modelStepCount: number;
  toolCallCount: number;
  responseSeen: boolean;
  stepLimitReached: boolean;
  lastFinishReason: "stop" | "tool-calls" | "length" | "content-filter" | "unknown";
};

type FailureKind = Extract<CallResult, { status: "failure" }>["failureKind"];

const EMPTY_USAGE = {
  promptTokens: 0,
  completionTokens: 0,
  reasoningTokens: 0,
  cachedTokens: 0,
  reportedCost: 0,
  sawUsage: false,
  sawCost: false,
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

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function hash(value: unknown): `sha256:${string}` {
  const bytes = typeof value === "string" ? value : JSON.stringify(canonicalize(value));
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function decimalCost(value: number): string | null {
  if (!Number.isFinite(value) || value < 0) return null;
  return value.toFixed(12).replace(/(?:\.0+|(?<fraction>\.\d*?)0+)$/u, "$<fraction>");
}

function terminalSchema(output: CallSpec["output"]): z.ZodType<TerminalOutput> {
  switch (output.name) {
    case "wiki-object":
      return WikiObjectSchema;
    case "localized-rendering":
      return LocalizedRenderingSchema;
    case "draft-batch":
      return DraftBatchSchema;
    case "review-verdict":
      return ReviewVerdictSchema;
    case "defect-bundle":
      return DefectBundleSchema;
  }
}

function replaceExclusiveUnions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(replaceExclusiveUnions);
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value).map(([key, child]) => [
    key === "oneOf" ? "anyOf" : key,
    replaceExclusiveUnions(child),
  ]);
  return Object.fromEntries(entries);
}

function providerTerminalSchema(output: CallSpec["output"]): z.ZodType<TerminalOutput> {
  const schema = terminalSchema(output);
  const standard = schema["~standard"];
  // The adapter rejects oneOf before sending; Zod still performs exact local validation.
  return {
    "~standard": {
      ...standard,
      jsonSchema: {
        input: (options) =>
          replaceExclusiveUnions(standard.jsonSchema.input(options)) as Record<string, unknown>,
        output: (options) =>
          replaceExclusiveUnions(standard.jsonSchema.output(options)) as Record<string, unknown>,
      },
    },
  } as z.ZodType<TerminalOutput>;
}

async function readPayload(
  runtime: DispatchRuntime,
  reference: EncryptedPayloadRef,
): Promise<string> {
  const content = await runtime.readPayload(reference);
  if (hash(content) !== reference.contentHash) {
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
  if (typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0) {
    target.sawCost = true;
    target.reportedCost += usage.cost;
  }
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
      state.responseSeen = true;
      state.modelStepCount += 1;
      state.servedModel = chunk.model || state.servedModel;
      state.lastFinishReason =
        chunk.finishReason === "tool_calls" ? "tool-calls" : finishReason(chunk.finishReason);
      state.events.push({
        kind: "model-step-finished",
        iteration: context.iteration,
        servedModel: chunk.model || "unknown",
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
        argumentsHash: hash(input),
        result: parsed,
      });
      return parsed;
    }),
  );
  return { tools, toolsByName: selectedByName };
}

function failureKind(error: unknown, state: DispatchState): FailureKind {
  if (state.stepLimitReached) return "step-limit";
  if (state.lastFinishReason === "length") return "truncation";
  if (state.lastFinishReason === "content-filter") return "refusal";
  if (error instanceof StandardSchemaValidationError || error instanceof z.ZodError) {
    return "schema-failure";
  }
  const message = error instanceof Error ? error.message : "";
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
  const memoKey = hash(spec);
  const requested = { model: spec.requestedModel, providerOrder: spec.providerPolicy.order };
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
    servedModel: "unknown",
    modelStepCount: 0,
    toolCallCount: 0,
    responseSeen: false,
    stepLimitReached: false,
    lastFinishReason: "unknown",
  };

  try {
    if (spec.tools.length > 0 && spec.limits.maxSteps < 2) {
      state.stepLimitReached = true;
      throw new Error("tool use requires room for a terminal model step");
    }

    const semaphore = new Semaphore(spec.limits.maxParallelTools);
    const configuredTools = runtimeTools(spec, runtime, state, semaphore);
    const converted = await modelMessages(spec, runtime, configuredTools.toolsByName);
    const httpClient = new HTTPClient(runtime.fetcher ? { fetcher: runtime.fetcher } : undefined);
    httpClient.addHook("beforeRequest", (request) => {
      const headers = new Headers(request.headers);
      headers.set("X-OpenRouter-Metadata", "enabled");
      headers.set("X-OpenRouter-Cache", "false");
      return new Request(request, { headers });
    });
    const adapter = createOpenRouterText(spec.requestedModel as OpenRouterModel, apiKey, {
      httpClient,
      retryConfig: { strategy: "none" },
      timeoutMs: spec.limits.timeoutClass === "deep" ? 600_000 : 300_000,
    });

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
        seed: spec.sampling.seed,
        maxCompletionTokens: spec.limits.maxOutputTokens,
        parallelToolCalls: spec.limits.maxParallelTools > 1,
      },
      middleware: [dispatchMiddleware(state, spec.limits.maxToolCalls)],
      debug: false,
    });

    if (!state.usage.sawUsage) throw new Error("provider response omitted usage");
    const result = {
      schemaVersion: CALL_RESULT_SCHEMA_VERSION,
      memoKey,
      requested,
      memoHit: false,
      status: "success",
      value,
      responseEventId: hash({ memoKey, value }),
      served: { model: state.servedModel, provider: "unknown" },
      generationId: null,
      verification: "explicit-unknown",
      usage: {
        promptTokens: state.usage.promptTokens,
        completionTokens: state.usage.completionTokens,
        reasoningTokens: state.usage.reasoningTokens,
        cachedTokens: state.usage.cachedTokens,
      },
      billing: {
        status: "billing-unknown",
        reportedCostUsd: state.usage.sawCost ? decimalCost(state.usage.reportedCost) : null,
      },
      events: state.events,
    } as const;
    return CallResultSchema.parse(result);
  } catch (error: unknown) {
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
      memoHit: false,
      status: "failure",
      failureKind: kind,
      responseEventId: state.responseSeen ? hash({ memoKey, failureKind: kind }) : null,
      responseEncrypted: null,
      served: state.responseSeen ? { model: state.servedModel, provider: "unknown" } : null,
      generationId: null,
      verification: "unverified",
      usage: state.usage.sawUsage
        ? {
            promptTokens: state.usage.promptTokens,
            completionTokens: state.usage.completionTokens,
            reasoningTokens: state.usage.reasoningTokens,
            cachedTokens: state.usage.cachedTokens,
          }
        : null,
      billing: { status: "billing-unknown" },
      defects:
        kind === "step-limit" || kind === "transport"
          ? []
          : [{ path: [], code: defectCode, message: `terminal ${kind}` }],
      events: state.events,
    });
  }
}
