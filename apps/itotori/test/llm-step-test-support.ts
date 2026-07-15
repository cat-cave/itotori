import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import {
  ItotoriLlmCallMemoRepository,
  type DatabaseContext,
  type LlmMemoCipher,
} from "@itotori/db";
import { z } from "zod";
import {
  CALL_SPEC_SCHEMA_VERSION,
  DECODE_GET_UNITS_RESULT_SCHEMA_VERSION,
  REVIEW_VERDICT_SCHEMA_VERSION,
  type CallSpec,
} from "../src/contracts/index.js";
import type { DispatchRuntime, DispatchTool } from "../src/llm/dispatch.js";
import type { MeasuredModelProfile, RetryRuntime } from "../src/llm/physical-attempt-policy.js";

export const STEP_HASH_A = `sha256:${"a".repeat(64)}` as const;
export const STEP_HASH_B = `sha256:${"b".repeat(64)}` as const;
export const STEP_HASH_C = `sha256:${"c".repeat(64)}` as const;
export const STEP_HASH_D = `sha256:${"d".repeat(64)}` as const;

export const TEST_MODEL_PROFILE: MeasuredModelProfile = {
  name: "reviewer",
  version: "reviewer:v1",
  deadlines: { normalMs: 300_000, deepMs: 600_000 },
  maxAttemptExposureUsd: "1", // itotori-225-audit-allow: synthetic per-attempt ceiling for mock transport tests, not a billed model cost
};

export class TestMemoCipher implements LlmMemoCipher {
  readonly #key = randomBytes(32);

  async seal(plaintext: string): Promise<{ ciphertext: Uint8Array; keyRef: string }> {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return {
      ciphertext: Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]),
      keyRef: "test-envelope-key:v1",
    };
  }

  async open(ciphertext: Uint8Array, keyRef: string): Promise<string> {
    if (keyRef !== "test-envelope-key:v1") throw new Error("unknown test envelope key");
    const bytes = Buffer.from(ciphertext);
    const decipher = createDecipheriv("aes-256-gcm", this.#key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
  }
}

type ProviderResponse = Response | Error | ((signal: AbortSignal) => Promise<Response>);

export function dispatchHarness(input: {
  pool: DatabaseContext["pool"];
  cipher: LlmMemoCipher;
  prompt: string;
  responses: readonly ProviderResponse[];
  tools?: readonly DispatchTool[];
  signal?: AbortSignal;
  profile?: MeasuredModelProfile;
  retry?: Partial<RetryRuntime>;
  admission?: { scope: string; confirmedCostCapUsd: string };
}): { runtime: DispatchRuntime; transportCalls: () => number } {
  const responses = [...input.responses];
  let transportCalls = 0;
  return {
    runtime: {
      env: {
        OPENROUTER_API_KEY: "test-key",
        OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1",
        OPENROUTER_ZDR_GUARDRAIL_ASSERTED: "1",
      },
      tools: input.tools ?? [],
      readPayload: async () => input.prompt,
      memo: {
        store: new ItotoriLlmCallMemoRepository(input.pool, input.cipher),
        profile: input.profile ?? TEST_MODEL_PROFILE,
        admission: input.admission ?? {
          scope: "test:llm-step",
          confirmedCostCapUsd: "10", // itotori-225-audit-allow: synthetic admission cap for mock transport tests, not a billed model cost
        },
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.retry ? { retry: input.retry } : {}),
        snapshots: {
          decodeRevisionHash: STEP_HASH_A,
          glossaryRevisionHash: STEP_HASH_B,
          styleRevisionHash: STEP_HASH_C,
          acceptedOutputHeadHash: STEP_HASH_D,
        },
      },
      fetcher: async (requestInput, init) => {
        transportCalls += 1;
        const response = responses.shift();
        if (!response) throw new Error("unexpected extra provider request");
        if (response instanceof Error) throw response;
        const request = new Request(requestInput, init);
        return typeof response === "function" ? response(request.signal) : response;
      },
    },
    transportCalls: () => transportCalls,
  };
}

export function physicalCallSpec(prompt: string, overrides: Partial<CallSpec> = {}): CallSpec {
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
    parentEventId: STEP_HASH_A,
    contextSnapshotId: "snapshot:context:1",
    localizationSnapshotId: "snapshot:localization:1",
    messages: [
      {
        kind: "text",
        eventId: STEP_HASH_A,
        role: "user",
        contentEncrypted: {
          storageRef: "encrypted:prompt:1",
          contentHash: contentHash(prompt),
          encryption: "operator-managed",
        },
      },
    ],
    tools: [],
    output: {
      name: "review-verdict",
      schemaVersion: REVIEW_VERDICT_SCHEMA_VERSION,
      schemaHash: STEP_HASH_B,
    },
    promptVersion: "prompt:v1",
    reasoning: { effort: "none" },
    sampling: { temperature: 0, topP: 1, seed: null },
    limits: {
      maxSteps: 4,
      maxToolCalls: 8,
      maxParallelTools: 1,
      maxOutputTokens: 2_048,
      timeoutClass: "normal",
    },
    sampleId: null,
    runMode: "test-dev",
    contextScope: "whole-game",
    ...overrides,
  };
}

export function toolLoopSpec(prompt: string): CallSpec {
  return physicalCallSpec(prompt, {
    tools: [
      {
        name: "decode_get_units",
        input: {
          name: "decode-get-units-input",
          schemaVersion: "input:v1",
          schemaHash: STEP_HASH_A,
        },
        output: {
          name: "decode-get-units-result",
          schemaVersion: DECODE_GET_UNITS_RESULT_SCHEMA_VERSION,
          schemaHash: STEP_HASH_B,
        },
        implementationVersion: "implementation:v1",
      },
    ],
    limits: {
      maxSteps: 3,
      maxToolCalls: 8,
      maxParallelTools: 1,
      maxOutputTokens: 2_048,
      timeoutClass: "normal",
    },
  });
}

export function decodedUnitsTool(onExecute?: () => void): DispatchTool {
  return {
    name: "decode_get_units",
    description: "Read synthetic decoded units.",
    inputSchema: z.object({}).strict(),
    execute: async () => {
      onExecute?.();
      return {
        schemaVersion: DECODE_GET_UNITS_RESULT_SCHEMA_VERSION,
        tool: "decode_get_units",
        snapshotId: "snapshot:context:1",
        requestHash: STEP_HASH_A,
        resultHash: STEP_HASH_B,
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
}

export function structuredProviderResponse(value: unknown): Response {
  return sse([
    streamChunk({ delta: { role: "assistant", content: JSON.stringify(value) } }),
    streamChunk({ delta: {}, finishReason: "stop" }),
    streamChunk({
      usage: {
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18,
        prompt_tokens_details: { cached_tokens: 2 },
        completion_tokens_details: { reasoning_tokens: 3 },
      },
    }),
  ]);
}

export function rawStructuredProviderResponse(content: string): Response {
  return sse([
    streamChunk({ delta: { role: "assistant", content } }),
    streamChunk({ delta: {}, finishReason: "stop" }),
    streamChunk({
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }),
  ]);
}

export function httpProviderResponse(status: number, retryAfter?: string): Response {
  return new Response(JSON.stringify({ error: { message: "synthetic provider failure" } }), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...(retryAfter === undefined ? {} : { "Retry-After": retryAfter }),
    },
  });
}

export function toolProviderResponse(index: number): Response {
  return sse([
    streamChunk({
      delta: {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: `tool-call:${index}`,
            type: "function",
            function: { name: "decode_get_units", arguments: "{}" },
          },
        ],
      },
      finishReason: "tool_calls",
    }),
    streamChunk({ usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }),
  ]);
}

function contentHash(content: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function streamChunk(input: {
  delta?: Record<string, unknown>;
  finishReason?: string | null;
  usage?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    id: "generation:test",
    created: 1,
    model: "deepseek/deepseek-v4-flash",
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

function sse(chunks: readonly Record<string, unknown>[]): Response {
  const body = [
    ...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`),
    "data: [DONE]\n\n",
  ].join("");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}
