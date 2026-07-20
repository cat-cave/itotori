import { createHash } from "node:crypto";
import {
  AuthorizationError,
  LlmDurabilityFaultError,
  LlmMemoConflictError,
  LlmRetriesExhaustedError,
  type LlmAttemptFailure,
  type LlmCallMemoStore,
  type LlmMemoSingleflightInput,
  type LlmMemoSingleflightResult,
} from "@itotori/db";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CALL_SPEC_SCHEMA_VERSION,
  DECODE_GET_UNITS_RESULT_SCHEMA_VERSION,
  REVIEW_VERDICT_SCHEMA_VERSION,
  type CallSpec,
} from "../src/contracts/index.js";
import { dispatch, type DispatchRuntime, type DispatchTool } from "../src/llm/dispatch.js";
import { reviewVerdictExample } from "./contract-fixtures-core.js";
import {
  TEST_MODEL_PROFILE,
  decodedUnitsTool,
  httpProviderResponse,
  rawTransportDropError,
  toolLoopSpec,
  toolProviderResponse,
} from "./llm-step-test-support.js";

const HASH_A = `sha256:${"a".repeat(64)}` as const;
const HASH_B = `sha256:${"b".repeat(64)}` as const;

type CapturedRequest = { headers: Headers; body: Record<string, unknown> };
type ProviderResponse = Response | Error;

class MemoryMemoStore implements LlmCallMemoStore {
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

function contentHash(content: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function streamChunk(input: {
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

function sse(chunks: ReadonlyArray<Record<string, unknown>>, headers: HeadersInit = {}): Response {
  const body = [
    ...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`),
    "data: [DONE]\n\n",
  ].join("");
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "text/event-stream");
  return new Response(body, { status: 200, headers: responseHeaders });
}

function structuredResponse(
  content: string,
  id = "generation:test",
  cost: number | null = 0.00000125, // itotori-225-audit-allow: deterministic mock-wire cost in a fake stream chunk, not a production cost source
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

/** A response that completed its data frames before its connection was lost.
 * The adapter reports this indistinguishably from a mid-stream body loss as a
 * RUN_ERROR, so this fixture must remain terminal and billing-unknown. */
function completedThenLostResponse(): Response {
  const encoder = new TextEncoder();
  const frames = [
    streamChunk({
      id: "generation:lost-response",
      delta: { role: "assistant", content: JSON.stringify(reviewVerdictExample) },
    }),
    streamChunk({ id: "generation:lost-response", delta: {}, finishReason: "stop" }),
    streamChunk({
      id: "generation:lost-response",
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, cost: 0.00000125 }, // itotori-225-audit-allow: synthetic lost-response evidence, not a production cost source
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

const TRANSIENT_TRANSPORT: LlmAttemptFailure = {
  classification: "transient",
  kind: "transport",
  httpStatus: null,
  retryAfterMs: null,
};

function toolCallResponse(callIndex: number, reasoningDetails: readonly unknown[] = []): Response {
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
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7, cost: 0.0000005 }, // itotori-225-audit-allow: deterministic mock-wire cost in a fake stream chunk, not a production cost source
    }),
  ]);
}

function callSpec(prompt: string, overrides: Partial<CallSpec> = {}): CallSpec {
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

function runtime(
  prompt: string,
  responses: ProviderResponse[],
  captured: CapturedRequest[],
  tools: readonly DispatchTool[] = [],
): DispatchRuntime {
  return {
    env: {
      OPENROUTER_API_KEY: "test-key",
      OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1",
      OPENROUTER_ZDR_GUARDRAIL_ASSERTED: "1",
    },
    tools,
    contentAccess: { requireContentRead: async () => undefined },
    memo: {
      store: new MemoryMemoStore(),
      profile: TEST_MODEL_PROFILE,
      admission: {
        scope: "test:llm-dispatch",
        confirmedCostCapUsd: "10", // itotori-225-audit-allow: synthetic admission cap for mock transport tests, not a billed model cost
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

describe("the rebuilt LLM dispatcher", () => {
  it("classifies an injected in-flight process death as cancelled", async () => {
    const prompt = "Return a review verdict.";
    const configured = runtime(
      prompt,
      [structuredResponse(JSON.stringify(reviewVerdictExample))],
      [],
    );

    const result = await dispatch(callSpec(prompt), {
      ...configured,
      memo: {
        ...configured.memo,
        durabilityFaults: faultAt("in-flight"),
      },
    });

    expect(result).toMatchObject({ status: "failure", failureKind: "cancelled" });
  });

  it("classifies an injected tool-loop process death as cancelled", async () => {
    const prompt = "Use the decoded-unit tool, then return a verdict.";
    const captured: CapturedRequest[] = [];
    let toolRuns = 0;
    const configured = runtime(prompt, [toolProviderResponse(1)], captured, [
      decodedUnitsTool(() => (toolRuns += 1)),
    ]);

    const result = await dispatch(toolLoopSpec(prompt), {
      ...configured,
      memo: {
        ...configured.memo,
        durabilityFaults: faultAt("after-tool-result"),
      },
    });

    expect(result).toMatchObject({ status: "failure", failureKind: "cancelled" });
    expect(captured).toHaveLength(1);
    expect(toolRuns).toBe(1);
  });

  it("resumes a fresh tool-loop dispatch after a post-result durability fault", async () => {
    const prompt = "Use the decoded-unit tool, then return a verdict.";
    const interruptedRequests: CapturedRequest[] = [];
    let interruptedToolRuns = 0;
    const interrupted = runtime(prompt, [toolProviderResponse(1)], interruptedRequests, [
      decodedUnitsTool(() => (interruptedToolRuns += 1)),
    ]);

    const interruptedResult = await dispatch(toolLoopSpec(prompt), {
      ...interrupted,
      memo: {
        ...interrupted.memo,
        durabilityFaults: faultAt("after-tool-result"),
      },
    });

    expect(interruptedResult).toMatchObject({ status: "failure", failureKind: "cancelled" });
    expect(interruptedRequests).toHaveLength(1);
    expect(interruptedToolRuns).toBe(1);

    const restartedRequests: CapturedRequest[] = [];
    let restartedToolRuns = 0;
    const restarted = runtime(
      prompt,
      [structuredResponse(JSON.stringify(reviewVerdictExample))],
      restartedRequests,
      [decodedUnitsTool(() => (restartedToolRuns += 1))],
    );

    const restartedResult = await dispatch(toolLoopSpec(prompt), {
      ...restarted,
      memo: { ...restarted.memo, store: interrupted.memo.store },
    });

    expect(restartedResult).toMatchObject({ status: "success", memoHit: false });
    expect(restartedRequests).toHaveLength(1);
    expect(restartedRequests[0]?.body).toMatchObject({
      response_format: { type: "json_schema", json_schema: { strict: true } },
    });
    expect(restartedToolRuns).toBe(1);
  });

  it("hard-cancels a hung stream at each attempt deadline and records transient deadline failures", async () => {
    const prompt = "Return a review verdict before the synthetic deadline.";
    const store = new MemoryMemoStore();
    const profile = {
      ...TEST_MODEL_PROFILE,
      deadlines: { normalMs: 10, deepMs: 20 },
    };
    const signals: AbortSignal[] = [];
    const configured = runtime(prompt, [], []);
    const startedAt = Date.now();

    const result = await dispatch(callSpec(prompt), {
      ...configured,
      memo: {
        ...configured.memo,
        store,
        profile,
        retry: { random: () => 0, sleep: async () => undefined },
      },
      fetcher: async (input, init) => {
        signals.push(new Request(input, init).signal);
        return new Promise<Response>(() => undefined);
      },
    });

    expect(result).toMatchObject({ status: "failure", failureKind: "retries-exhausted" });
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(signals).toHaveLength(3);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(store.failures).toEqual(
      Array.from({ length: 3 }, () => ({
        classification: "transient",
        kind: "deadline",
        httpStatus: null,
        retryAfterMs: null,
      })),
    );
  });

  it("fails before transport when the account and guardrail ZDR assertions are absent", async () => {
    const prompt = "Return a review verdict.";
    const captured: CapturedRequest[] = [];
    const configured = runtime(
      prompt,
      [structuredResponse(JSON.stringify(reviewVerdictExample))],
      captured,
    );

    await expect(dispatch(callSpec(prompt), { ...configured, env: {} })).rejects.toThrow(
      /operator assertions/u,
    );
    expect(captured).toHaveLength(0);
  });

  it("sends the mandatory ZDR wire and accepts an unknown served pair explicitly", async () => {
    const prompt = "Return the requested synthetic review verdict.";
    const captured: CapturedRequest[] = [];
    const result = await dispatch(
      callSpec(prompt),
      runtime(prompt, [structuredResponse(JSON.stringify(reviewVerdictExample))], captured),
    );

    expect(captured).toHaveLength(1);
    expect(captured[0]?.headers.get("X-OpenRouter-Metadata")).toBe("enabled");
    expect(captured[0]?.headers.get("X-OpenRouter-Cache")).toBe("false");
    expect(captured[0]?.body).toMatchObject({
      model: "deepseek/deepseek-v4-flash",
      provider: {
        allow_fallbacks: true,
        zdr: true,
        data_collection: "deny",
        require_parameters: true,
      },
      plugins: [],
      reasoning: { effort: "none" },
      max_tokens: 2_048,
      response_format: {
        type: "json_schema",
        json_schema: { name: "structured_output", strict: true },
      },
    });
    expect(captured[0]?.body).not.toHaveProperty("provider.allowFallbacks");
    expect(captured[0]?.body).not.toHaveProperty("provider.dataCollection");
    // ITOTORI-241 - the wire names no provider: automatic fallback (zdr:true)
    // confines routing to the account ZDR allow-list without an only/order pin.
    expect(captured[0]?.body).not.toHaveProperty("provider.only");
    expect(captured[0]?.body).not.toHaveProperty("provider.order");
    expect(captured[0]?.body).not.toHaveProperty("parallel_tool_calls");
    expect(captured[0]?.body).not.toHaveProperty("seed");
    expect(captured[0]?.body).not.toHaveProperty("max_completion_tokens");

    expect(result).toMatchObject({
      status: "success",
      served: { status: "unknown" },
      generationId: null,
      verification: "explicit-unknown",
      usage: { promptTokens: 11, completionTokens: 7, reasoningTokens: 3, cachedTokens: 2 },
      billing: { status: "confirmed", costUsd: "0.00000125" },
    });
    expect(result).toHaveProperty("value");
    expect(result.events.map((event) => event.kind)).toEqual([
      "run-started",
      "model-step-finished",
      "run-finished",
    ]);
  });

  it("does not bypass TanStack with response headers while served metadata is unknown", async () => {
    const prompt = "Return the requested synthetic review verdict.";
    const verified = await dispatch(
      callSpec(prompt),
      runtime(
        prompt,
        [
          structuredResponse(JSON.stringify(reviewVerdictExample), undefined, undefined, {
            "x-generation-id": "gen-header-1",
            "x-provider-name": "Morph",
          }),
        ],
        [],
      ),
    );

    expect(verified).toMatchObject({
      status: "success",
      generationId: null,
      served: { status: "unknown" },
      verification: "explicit-unknown",
    });

    const absent = await dispatch(
      callSpec(`${prompt} No response metadata.`),
      runtime(
        `${prompt} No response metadata.`,
        [structuredResponse(JSON.stringify(reviewVerdictExample))],
        [],
      ),
    );

    expect(absent).toMatchObject({
      status: "success",
      generationId: null,
      served: { status: "unknown" },
      verification: "explicit-unknown",
    });
  });

  it("permits OpenRouter fallback and retries a single-provider 429 without aborting", async () => {
    // ITOTORI-241 - proves fallback is genuinely ENABLED without a live outage:
    // inject a 429 on the first upstream, then a valid response. This shows the
    // wire permits OpenRouter to fall back and the dispatcher does not treat a
    // single-provider rate limit as a terminal failure. (Server-side alternate
    // selection is OpenRouter-internal; served-provider stays deferred.)
    const prompt = "Return the requested synthetic review verdict.";
    const captured: CapturedRequest[] = [];
    const base = runtime(
      prompt,
      [httpProviderResponse(429, "0"), structuredResponse(JSON.stringify(reviewVerdictExample))],
      captured,
    );
    // Deterministic, instant retry - no real backoff sleep.
    const configured: DispatchRuntime = {
      ...base,
      memo: { ...base.memo, retry: { random: () => 0, sleep: async () => undefined } },
    };

    const result = await dispatch(callSpec(prompt), configured);

    // (i) The outgoing request PERMITS OpenRouter-side fallback: allow_fallbacks
    //     is true, ZDR confines it to the allow-list, and there is NO only/order
    //     pin - so a 429 on one endpoint is allowed to route to another.
    expect(captured[0]?.body.provider).toEqual({
      allow_fallbacks: true,
      zdr: true,
      data_collection: "deny",
      require_parameters: true,
    });
    expect(captured[0]?.body).not.toHaveProperty("provider.only");
    expect(captured[0]?.body).not.toHaveProperty("provider.order");
    // (ii) The dispatcher made a SECOND attempt after the 429 rather than
    //      aborting on the single-provider rate limit, and recovered.
    expect(captured).toHaveLength(2);
    expect(result.status).toBe("success");
  });

  it("retries raw transport exceptions, then succeeds", async () => {
    // A raw connection reset reaches streaming execute's catch before the
    // adapter can emit RUN_ERROR. It is therefore safe to retry under the
    // bounded attempt budget.
    const prompt = "Return the requested synthetic review verdict.";
    const captured: CapturedRequest[] = [];
    const store = new MemoryMemoStore();
    const base = runtime(
      prompt,
      [
        rawTransportDropError(),
        rawTransportDropError(),
        structuredResponse(JSON.stringify(reviewVerdictExample)),
      ],
      captured,
    );
    const configured: DispatchRuntime = {
      ...base,
      memo: { ...base.memo, store, retry: { random: () => 0, sleep: async () => undefined } },
    };

    const result = await dispatch(callSpec(prompt), configured);

    // Two raw transport failures were retried, and the third attempt succeeded.
    expect(captured).toHaveLength(3);
    expect(result.status).toBe("success");
    // Each retried attempt was recorded as a transient transport failure — the
    // http_attempts ledger preserves the lineage of the retried physical steps.
    expect(store.failures).toEqual([TRANSIENT_TRANSPORT, TRANSIENT_TRANSPORT]);
  });

  it("treats an adapter RUN_ERROR as terminal billing-unknown", async () => {
    const prompt = "Return the requested synthetic review verdict.";
    const captured: CapturedRequest[] = [];
    const store = new MemoryMemoStore();
    const base = runtime(prompt, [completedThenLostResponse()], captured);
    const configured: DispatchRuntime = {
      ...base,
      memo: { ...base.memo, store, retry: { random: () => 0, sleep: async () => undefined } },
    };

    const result = await dispatch(callSpec(prompt), configured);

    // The adapter discards completion metadata when it emits RUN_ERROR; retrying
    // could re-bill an already-completed response, so exactly one attempt stops.
    expect(captured).toHaveLength(1);
    expect(result).toMatchObject({
      status: "failure",
      failureKind: "transport",
      billing: { status: "billing-unknown" },
    });
    expect(store.failures).toEqual([
      { classification: "permanent", kind: "transport", httpStatus: null, retryAfterMs: null },
    ]);
  });

  it("surfaces a clear retries-exhausted terminal failure when raw transport exceptions persist", async () => {
    const prompt = "Return the requested synthetic review verdict.";
    const captured: CapturedRequest[] = [];
    const store = new MemoryMemoStore();
    const base = runtime(
      prompt,
      [rawTransportDropError(), rawTransportDropError(), rawTransportDropError()],
      captured,
    );
    const configured: DispatchRuntime = {
      ...base,
      memo: { ...base.memo, store, retry: { random: () => 0, sleep: async () => undefined } },
    };

    const result = await dispatch(callSpec(prompt), configured);

    // Exactly the bounded budget of attempts — not a hang, not unbounded retries.
    expect(captured).toHaveLength(3);
    expect(result).toMatchObject({ status: "failure", failureKind: "retries-exhausted" });
    expect(store.failures).toEqual([TRANSIENT_TRANSPORT, TRANSIENT_TRANSPORT, TRANSIENT_TRANSPORT]);
  });

  it("does not retry a non-transient 4xx transport failure", async () => {
    // A 400 will not improve on retry: classify permanent and fail once.
    const prompt = "Return the requested synthetic review verdict.";
    const captured: CapturedRequest[] = [];
    const store = new MemoryMemoStore();
    const base = runtime(prompt, [httpProviderResponse(400)], captured);
    const configured: DispatchRuntime = {
      ...base,
      memo: { ...base.memo, store, retry: { random: () => 0, sleep: async () => undefined } },
    };

    const result = await dispatch(callSpec(prompt), configured);

    expect(captured).toHaveLength(1);
    expect(result).toMatchObject({ status: "failure", failureKind: "http" });
    expect(store.failures).toEqual([
      { classification: "permanent", kind: "http", httpStatus: 400, retryAfterMs: null },
    ]);
  });

  it("returns malformed terminal JSON as a typed failure without salvage or retry", async () => {
    const prompt = "Return a review verdict.";
    const captured: CapturedRequest[] = [];
    const fencedJson = `\`\`\`json\n${JSON.stringify(reviewVerdictExample)}\n\`\`\``;
    const result = await dispatch(
      callSpec(prompt),
      runtime(prompt, [structuredResponse(fencedJson)], captured),
    );

    expect(captured).toHaveLength(1);
    expect(result).toMatchObject({
      status: "failure",
      failureKind: "invalid-json",
      generationId: null,
      verification: "quarantined",
    });
    expect(result).not.toHaveProperty("value");
  });

  it("does not fabricate a zero cost when upstream omits cost", async () => {
    const prompt = "Return a review verdict.";
    const result = await dispatch(
      callSpec(prompt),
      runtime(
        prompt,
        [structuredResponse(JSON.stringify(reviewVerdictExample), undefined, null)],
        [],
      ),
    );

    expect(result).toMatchObject({
      status: "success",
      billing: { status: "billing-unknown" },
    });
  });

  it("returns schema-invalid terminal content as a typed failure", async () => {
    const prompt = "Return a review verdict.";
    const captured: CapturedRequest[] = [];
    const result = await dispatch(
      callSpec(prompt),
      runtime(prompt, [structuredResponse("{}")], captured),
    );

    expect(captured).toHaveLength(1);
    expect(result).toMatchObject({ status: "failure", failureKind: "schema-failure" });
    expect(result).not.toHaveProperty("value");
  });

  it("classifies a measured-profile mismatch before it is mistaken for transport", async () => {
    const prompt = "Return a review verdict.";
    const configured = runtime(prompt, [], []);
    const result = await dispatch(callSpec(prompt), {
      ...configured,
      memo: {
        ...configured.memo,
        profile: { ...configured.memo.profile, name: "draft" },
      },
    });

    expect(result).toMatchObject({ status: "failure", failureKind: "configuration" });
  });

  it("classifies a content-read denial before it is mistaken for transport", async () => {
    const prompt = "Return a review verdict.";
    const configured = runtime(prompt, [], []);
    const result = await dispatch(callSpec(prompt), {
      ...configured,
      contentAccess: {
        async requireContentRead() {
          throw new AuthorizationError({ userId: "denied-user" }, "content.read");
        },
      },
    });

    expect(result).toMatchObject({ status: "failure", failureKind: "permission" });
  });

  it("runs the recorded conformance path with strict tools, reasoning, usage, cost, and unknown route evidence", async () => {
    const prompt = "Use the local unit tool, then return the review verdict.";
    const captured: CapturedRequest[] = [];
    let executions = 0;
    const decodeTool: DispatchTool = {
      name: "decode_get_units",
      description: "Read synthetic decoded units.",
      inputSchema: z.object({}).strict(),
      execute: async () => {
        executions += 1;
        return {
          schemaVersion: DECODE_GET_UNITS_RESULT_SCHEMA_VERSION,
          tool: "decode_get_units",
          snapshotId: HASH_A,
          requestHash: HASH_A,
          resultHash: HASH_B,
          page: {
            kind: "complete",
            requestCursor: null,
            returnedRows: 0,
            returnedBytes: 0,
            maxRows: 1,
            maxBytes: 1,
            nextCursor: null,
          },
          facts: [],
        };
      },
    };
    const toolRef = {
      name: "decode_get_units",
      input: { name: "decode-get-units-input", schemaVersion: "input:v1", schemaHash: HASH_A },
      output: {
        name: "decode-get-units-result",
        schemaVersion: DECODE_GET_UNITS_RESULT_SCHEMA_VERSION,
        schemaHash: HASH_B,
      },
      implementationVersion: "implementation:v1",
    } as const;
    const spec = callSpec(prompt, {
      tools: [toolRef],
      limits: {
        maxSteps: 3,
        maxToolCalls: 8,
        maxParallelTools: 1,
        maxOutputTokens: 2_048,
        timeoutClass: "normal",
      },
    });
    const firstReasoningDetails = [
      {
        type: "reasoning.text",
        text: "synthetic opaque reasoning detail one",
        format: "unknown",
        signature: "synthetic-signature-one",
      },
    ];
    const secondReasoningDetails = [
      {
        type: "reasoning.text",
        text: "synthetic opaque reasoning detail two",
        format: "unknown",
        signature: "synthetic-signature-two",
      },
    ];
    const continuityEvidence: Array<{
      receivedBatchCount: number;
      forwardedBatchCount: number;
      exactForwardCount: number;
    }> = [];
    const configuredRuntime = runtime(
      prompt,
      [
        toolCallResponse(1, firstReasoningDetails),
        toolCallResponse(2, secondReasoningDetails),
        structuredResponse(JSON.stringify(reviewVerdictExample), "generation:terminal"),
      ],
      captured,
      [decodeTool],
    );
    const result = await dispatch(spec, {
      ...configuredRuntime,
      onReasoningDetailsContinuity: (evidence) => continuityEvidence.push(evidence),
    });

    expect(captured).toHaveLength(3);
    expect(captured[1]?.body).toMatchObject({
      messages: [
        { role: "user" },
        { role: "assistant", reasoning_details: firstReasoningDetails },
        { role: "tool" },
      ],
    });
    expect(captured[2]?.body).toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          reasoning_details: secondReasoningDetails,
        }),
      ]),
    });
    expect(executions).toBe(2);
    expect(result).toMatchObject({
      status: "success",
      verification: "explicit-unknown",
      generationId: null,
      served: { status: "unknown" },
      usage: { promptTokens: 11, completionTokens: 7, reasoningTokens: 3, cachedTokens: 2 },
      billing: { status: "confirmed", costUsd: "0.00000125" },
    });
    expect(result.events.filter((event) => event.kind === "tool-step-finished")).toHaveLength(2);
    expect(continuityEvidence).toEqual([
      expect.objectContaining({
        receivedBatchCount: 2,
        forwardedBatchCount: 2,
        exactForwardCount: 2,
      }),
    ]);
  });
});

function faultAt(boundary: "in-flight" | "after-tool-result") {
  return {
    async killAt(actual: "in-flight" | "after-tool-result") {
      if (actual === boundary) throw new LlmDurabilityFaultError(actual);
    },
  };
}

const liveEnabled =
  Boolean(process.env.OPENROUTER_API_KEY) &&
  process.env.OPENROUTER_ZDR_ACCOUNT_ASSERTED === "1" &&
  process.env.OPENROUTER_ZDR_GUARDRAIL_ASSERTED === "1";

(liveEnabled ? it : it.skip)(
  "accepts a real structured response with an explicitly unknown served pair",
  async () => {
    const prompt = `Return exactly one PASS review verdict for synthetic unit unit:1. Use schemaVersion ${REVIEW_VERDICT_SCHEMA_VERSION}, reviewId review:live:1, localizationSnapshotId ${HASH_B}, roleId Q1, rubric meaning, unitId unit:1, wiki-first basis with bibleRenderingIds [rendering:1], severity none, null span/category/repairConstraint, and evidenceIds [fact:unit:1].`;
    const spec = callSpec(prompt, {
      providerPolicy: {
        allowFallbacks: true,
        zdr: true,
        dataCollection: "deny",
        requireParameters: true,
      },
    });
    const result = await dispatch(spec, {
      env: process.env,
      tools: [],
      contentAccess: { requireContentRead: async () => undefined },
      memo: {
        store: new MemoryMemoStore(),
        profile: TEST_MODEL_PROFILE,
        admission: {
          scope: "test:llm-dispatch-live",
          confirmedCostCapUsd: "10", // itotori-225-audit-allow: synthetic live-test cap, not a billed model cost
        },
        snapshots: {
          decodeRevisionHash: HASH_A,
          glossaryRevisionHash: HASH_B,
          styleRevisionHash: HASH_A,
          acceptedOutputHeadHash: HASH_B,
        },
      },
      readPayload: async () => prompt,
    });

    expect(result).toMatchObject({
      status: "success",
      verification: "explicit-unknown",
      generationId: null,
      served: { status: "unknown" },
    });
  },
  360_000,
);
