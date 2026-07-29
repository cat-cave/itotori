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

import {
  HASH_A,
  HASH_B,
  CapturedRequest,
  ProviderResponse,
  MemoryMemoStore,
  contentHash,
  streamChunk,
  sse,
  structuredResponse,
  completedThenLostResponse,
  TRANSIENT_TRANSPORT,
  toolCallResponse,
  callSpec,
  runtime,
  faultAt,
  liveEnabled,
} from "./llm-dispatch.support.js";

describe("the rebuilt LLM dispatcher", () => {
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
