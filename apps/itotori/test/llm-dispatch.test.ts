import { createHash } from "node:crypto";
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

const HASH_A = `sha256:${"a".repeat(64)}` as const;
const HASH_B = `sha256:${"b".repeat(64)}` as const;

type CapturedRequest = { headers: Headers; body: Record<string, unknown> };

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

function sse(chunks: ReadonlyArray<Record<string, unknown>>): Response {
  const body = [
    ...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`),
    "data: [DONE]\n\n",
  ].join("");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function structuredResponse(
  content: string,
  id = "generation:test",
  cost: number | null = 0.00000125,
): Response {
  return sse([
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
  ]);
}

function toolCallResponse(callIndex: number): Response {
  const id = `generation:tool:${callIndex}`;
  return sse([
    streamChunk({
      id,
      delta: {
        role: "assistant",
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
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7, cost: 0.0000005 },
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
      order: ["provider:primary"],
      only: ["provider:primary"],
      allowFallbacks: false,
      zdr: true,
      dataCollection: "deny",
      requireParameters: true,
    },
    parentEventId: HASH_A,
    contextSnapshotId: "snapshot:context:1",
    localizationSnapshotId: "snapshot:localization:1",
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
  responses: Response[],
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
    readPayload: async () => prompt,
    fetcher: async (input, init) => {
      const request = new Request(input, init);
      captured.push({
        headers: new Headers(request.headers),
        body: (await request.clone().json()) as Record<string, unknown>,
      });
      const response = responses.shift();
      if (!response) throw new Error("unexpected extra provider request");
      return response;
    },
  };
}

describe("the rebuilt LLM dispatcher", () => {
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

  it("sends the mandatory ZDR wire and returns a strict explicit-unknown result", async () => {
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
        order: ["provider:primary"],
        only: ["provider:primary"],
        allow_fallbacks: false,
        zdr: true,
        data_collection: "deny",
        require_parameters: true,
      },
      plugins: [],
      reasoning: { effort: "none" },
      max_completion_tokens: 2_048,
      response_format: {
        type: "json_schema",
        json_schema: { name: "structured_output", strict: true },
      },
    });
    expect(captured[0]?.body).not.toHaveProperty("provider.allowFallbacks");
    expect(captured[0]?.body).not.toHaveProperty("provider.dataCollection");

    expect(result).toMatchObject({
      status: "success",
      value: reviewVerdictExample,
      served: { model: "deepseek/deepseek-v4-flash", provider: "unknown" },
      generationId: null,
      verification: "explicit-unknown",
      usage: { promptTokens: 11, completionTokens: 7, reasoningTokens: 3, cachedTokens: 2 },
      billing: { status: "billing-unknown", reportedCostUsd: "0.00000125" },
    });
    expect(result.events.map((event) => event.kind)).toEqual([
      "run-started",
      "model-step-finished",
      "run-finished",
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
      verification: "unverified",
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
      billing: { status: "billing-unknown", reportedCostUsd: null },
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

  it("bounds repeated tool use by maxSteps and records strict tool results", async () => {
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
          snapshotId: "snapshot:context:1",
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
    const result = await dispatch(
      spec,
      runtime(
        prompt,
        [
          toolCallResponse(1),
          toolCallResponse(2),
          structuredResponse(JSON.stringify(reviewVerdictExample), "generation:terminal"),
        ],
        captured,
        [decodeTool],
      ),
    );

    expect(captured).toHaveLength(3);
    expect(executions).toBe(2);
    expect(result.status).toBe("success");
    expect(result.events.filter((event) => event.kind === "tool-step-finished")).toHaveLength(2);
  });
});

const liveProvider = process.env.ITOTORI_OPENROUTER_ZDR_PROVIDER;
const liveEnabled =
  Boolean(process.env.OPENROUTER_API_KEY) &&
  process.env.OPENROUTER_ZDR_ACCOUNT_ASSERTED === "1" &&
  process.env.OPENROUTER_ZDR_GUARDRAIL_ASSERTED === "1" &&
  Boolean(liveProvider);

(liveEnabled ? it : it.skip)(
  "returns a real structured DeepSeek V4 Flash result with explicit-unknown generation metadata",
  async () => {
    const prompt = `Return exactly one PASS review verdict for synthetic unit unit:1. Use schemaVersion ${REVIEW_VERDICT_SCHEMA_VERSION}, reviewId review:live:1, localizationSnapshotId snapshot:localization:1, roleId Q1, rubric meaning, unitId unit:1, wiki-first basis with bibleRenderingIds [rendering:1], severity none, null span/category/repairConstraint, and evidenceIds [fact:unit:1].`;
    const spec = callSpec(prompt, {
      providerPolicy: {
        order: [liveProvider!],
        only: [liveProvider!],
        allowFallbacks: false,
        zdr: true,
        dataCollection: "deny",
        requireParameters: true,
      },
    });
    const result = await dispatch(spec, {
      env: process.env,
      tools: [],
      readPayload: async () => prompt,
    });

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.verification).toBe("explicit-unknown");
      expect(result.generationId).toBeNull();
      expect(result.served.provider).toBe("unknown");
    }
  },
  360_000,
);
