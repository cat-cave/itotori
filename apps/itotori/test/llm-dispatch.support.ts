import { createHash } from "node:crypto";
import {
  LlmDurabilityFaultError,
  LlmMemoConflictError,
  LlmRetriesExhaustedError,
  type LlmAttemptFailure,
  type LlmCallMemoStore,
  type LlmMemoSingleflightInput,
  type LlmMemoSingleflightResult,
} from "@itotori/db";

import {
  CALL_SPEC_SCHEMA_VERSION,
  REVIEW_VERDICT_SCHEMA_VERSION,
  type CallSpec,
} from "../src/contracts/index.js";
import { type DispatchRuntime, type DispatchTool } from "../src/llm/dispatch.js";
import { reviewVerdictExample } from "./contract-fixtures-core.js";
import { TEST_MODEL_PROFILE } from "./llm-step-test-support.js";

export const HASH_A = `sha256:${"a".repeat(64)}` as const;

export const HASH_B = `sha256:${"b".repeat(64)}` as const;

export type CapturedRequest = { headers: Headers; body: Record<string, unknown> };

export type ProviderResponse = Response | Error;

export class MemoryMemoStore implements LlmCallMemoStore {
  readonly #memos = new Map<string, Extract<LlmMemoSingleflightResult, { kind: "completed" }>>();
  readonly #attemptCounts = new Map<string, number>();
  readonly failures: LlmAttemptFailure[] = [];

  async singleflight(input: LlmMemoSingleflightInput): Promise<LlmMemoSingleflightResult> {
    const existing = this.#memos.get(input.memoKey);
    if (existing) {
      if (existing.semanticHash !== input.semanticHash) {
        throw new LlmMemoConflictError(input.memoKey);
      }
      return { ...existing, memoHit: true };
    }
    const ordinal = (this.#attemptCounts.get(input.memoKey) ?? 0) + 1;
    if (ordinal > 3) throw new LlmRetriesExhaustedError(input.memoKey);
    this.#attemptCounts.set(input.memoKey, ordinal);
    const execution = await input.execute({ ordinal, startedAt: new Date().toISOString() });
    if (execution.kind === "incomplete") {
      this.failures.push(execution.failure);
      return {
        kind: "incomplete",
        memoHit: false,
        memoKey: input.memoKey,
        semanticHash: input.semanticHash,
        responseJson: execution.responseJson,
        attemptOrdinal: ordinal,
        failure: execution.failure,
      };
    }
    const completed = {
      kind: "completed" as const,
      memoHit: false,
      memoKey: input.memoKey,
      semanticHash: input.semanticHash,
      responseJson: execution.responseJson,
      outcomeJson: execution.outcomeJson,
      responseEventId: execution.responseEvent.eventId,
    };
    this.#memos.set(input.memoKey, completed);
    return completed;
  }
}

export function contentHash(content: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

export function streamChunk(input: {
  id: string;
  model?: string;
  delta?: Record<string, unknown>;
  finishReason?: string | null;
  usage?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    id: input.id,
    created: 1,
    model: input.model ?? "deepseek/deepseek-v4-flash",
    object: "chat.completion.chunk",
    choices:
      input.delta || input.finishReason !== undefined
        ? [
            {
              index: 0,
              delta: input.delta ?? {},
              finish_reason: input.finishReason ?? null,
              logprobs: null,
            },
          ]
        : [],
    ...(input.usage ? { usage: input.usage } : {}),
  };
}

export function sse(
  chunks: ReadonlyArray<Record<string, unknown>>,
  headers: HeadersInit = {},
): Response {
  const body = [
    ...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`),
    "data: [DONE]\n\n",
  ].join("");
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "text/event-stream");
  return new Response(body, { status: 200, headers: responseHeaders });
}

export function structuredResponse(
  content: string,
  id = "generation:test",
  cost: number | null = 0.00000125, // cost-audit-allow: deterministic mock-wire cost in a fake stream chunk, not a production cost source
  headers: HeadersInit = {},
): Response {
  return sse(
    [
      streamChunk({ id, delta: { role: "assistant", content } }),
      streamChunk({ id, delta: {}, finishReason: "stop" }),
      streamChunk({
        id,
        usage: {
          prompt_tokens: 11,
          completion_tokens: 7,
          total_tokens: 18,
          ...(cost === null ? {} : { cost }),
          prompt_tokens_details: { cached_tokens: 2 },
          completion_tokens_details: { reasoning_tokens: 3 },
        },
      }),
    ],
    headers,
  );
}

export function completedThenLostResponse(): Response {
  const encoder = new TextEncoder();
  const frames = [
    streamChunk({
      id: "generation:lost-response",
      delta: { role: "assistant", content: JSON.stringify(reviewVerdictExample) },
    }),
    streamChunk({ id: "generation:lost-response", delta: {}, finishReason: "stop" }),
    streamChunk({
      id: "generation:lost-response",
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, cost: 0.00000125 }, // cost-audit-allow: synthetic lost-response evidence, not a production cost source
    }),
  ];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames)
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
      controller.error(new Error("connection reset after the completed response"));
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

export const TRANSIENT_TRANSPORT: LlmAttemptFailure = {
  classification: "transient",
  kind: "transport",
  httpStatus: null,
  retryAfterMs: null,
};

export function toolCallResponse(
  callIndex: number,
  reasoningDetails: readonly unknown[] = [],
): Response {
  const id = `generation:tool:${callIndex}`;
  return sse([
    streamChunk({
      id,
      delta: {
        role: "assistant",
        ...(reasoningDetails.length > 0 ? { reasoning_details: reasoningDetails } : {}),
        tool_calls: [
          {
            index: 0,
            id: `tool-call:${callIndex}`,
            type: "function",
            function: { name: "decode_get_units", arguments: "{}" },
          },
        ],
      },
      finishReason: "tool_calls",
    }),
    streamChunk({
      id,
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7, cost: 0.0000005 }, // cost-audit-allow: deterministic mock-wire cost in a fake stream chunk, not a production cost source
    }),
  ]);
}

export function callSpec(prompt: string, overrides: Partial<CallSpec> = {}): CallSpec {
  const promptHash = contentHash(prompt);
  return {
    schemaVersion: CALL_SPEC_SCHEMA_VERSION,
    purpose: "review",
    roleId: "Q1",
    modelProfile: "reviewer",
    modelProfileVersion: "reviewer:v1",
    requestedModel: "deepseek/deepseek-v4-flash",
    providerPolicy: {
      allowFallbacks: true,
      zdr: true,
      dataCollection: "deny",
      requireParameters: true,
    },
    parentEventId: HASH_A,
    contextSnapshotId: HASH_A,
    localizationSnapshotId: HASH_B,
    messages: [
      {
        kind: "text",
        eventId: HASH_A,
        role: "user",
        contentEncrypted: {
          storageRef: "encrypted:prompt:1",
          contentHash: promptHash,
          encryption: "operator-managed",
        },
      },
    ],
    tools: [],
    output: {
      name: "review-verdict",
      schemaVersion: REVIEW_VERDICT_SCHEMA_VERSION,
      schemaHash: HASH_B,
    },
    promptVersion: "prompt:v1",
    reasoning: { effort: "none" },
    sampling: { temperature: 0, topP: 1, seed: null },
    limits: {
      maxSteps: 4,
      maxToolCalls: 8,
      maxParallelTools: 4,
      maxOutputTokens: 2_048,
      timeoutClass: "normal",
    },
    sampleId: null,
    runMode: "test-dev",
    contextScope: "whole-game",
    ...overrides,
  };
}

export function runtime(
  prompt: string,
  responses: ProviderResponse[],
  captured: CapturedRequest[],
  tools: readonly DispatchTool[] = [],
): DispatchRuntime {
  return {
    env: {
      OPENROUTER_API_KEY: "test-key",
    },
    tools,
    contentAccess: { requireContentRead: async () => undefined },
    memo: {
      store: new MemoryMemoStore(),
      profile: TEST_MODEL_PROFILE,
      admission: {
        scope: "test:llm-dispatch",
        confirmedCostCapUsd: "10", // cost-audit-allow: synthetic admission cap for mock transport tests, not a billed model cost
      },
      snapshots: {
        decodeRevisionHash: HASH_A,
        glossaryRevisionHash: HASH_B,
        styleRevisionHash: HASH_A,
        acceptedOutputHeadHash: HASH_B,
      },
    },
    readPayload: async () => prompt,
    fetcher: async (input, init) => {
      const request = new Request(input, init);
      captured.push({
        headers: new Headers(request.headers),
        body: (await request.clone().json()) as Record<string, unknown>,
      });
      const response = responses.shift();
      if (!response) throw new Error("unexpected extra provider request");
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

export function faultAt(boundary: "in-flight" | "after-tool-result") {
  return {
    async killAt(actual: "in-flight" | "after-tool-result") {
      if (actual === boundary) throw new LlmDurabilityFaultError(actual);
    },
  };
}
