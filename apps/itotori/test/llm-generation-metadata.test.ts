import { EventType, type StreamChunk } from "@tanstack/ai";
import { describe, expect, it } from "vitest";
import {
  captureGenerationMetadata,
  generationReconciliation,
} from "../src/llm/generation-metadata.js";

describe("upstream generation metadata capture", () => {
  it("keeps generation reconciliation disabled until TanStack exposes the served pair", () => {
    expect(generationReconciliation).toMatchObject({ enabled: false });
  });

  it("persists a complete inline RUN_FINISHED served pair without a side-channel lookup", () => {
    expect(captureGenerationMetadata([inlineFinishedChunk()])).toMatchObject({
      generationId: "generation:inline:1",
      served: {
        status: "confirmed",
        model: "served/model:inline",
        provider: "provider:inline",
      },
      routerAttempts: [
        {
          ordinal: 1,
          model: "served/model:inline",
          provider: "provider:inline",
          httpStatus: 200,
        },
      ],
      billing: { status: "confirmed", costUsd: "0.0000025" },
    });
  });

  it("keeps missing or incomplete inline metadata explicitly unknown", () => {
    expect(captureGenerationMetadata([finishedChunkWithoutMetadata()])).toMatchObject({
      generationId: null,
      served: { status: "unknown" },
      billing: { status: "billing_unknown" },
    });
    expect(
      captureGenerationMetadata([
        finishedChunkWithMetadata({
          generationId: "generation:inline:incomplete",
          servedModel: "served/model:inline",
        }),
      ]),
    ).toMatchObject({
      generationId: "generation:inline:incomplete",
      served: { status: "unknown" },
    });
  });

  it("does not promote an unbound inline pair when the generation ID is absent", () => {
    expect(
      captureGenerationMetadata([
        finishedChunkWithMetadata({
          servedModel: "served/model:inline",
          servedProvider: "provider:inline",
        }),
      ]),
    ).toMatchObject({ generationId: null, served: { status: "unknown" } });
  });
});

function inlineFinishedChunk(): StreamChunk {
  return {
    type: EventType.RUN_FINISHED,
    runId: "run:inline",
    threadId: "thread:inline",
    finishReason: "stop",
    usage: {
      promptTokens: 4,
      completionTokens: 3,
      totalTokens: 7,
      cost: 0.0000025, // itotori-225-audit-allow: synthetic provider-reported test usage, not model pricing
    },
    rawEvent: {
      id: "generation:inline:1",
      openrouterMetadata: {
        endpoints: {
          available: [
            {
              model: "served/model:inline",
              provider: "provider:inline",
              selected: true,
            },
          ],
        },
        attempts: [{ model: "served/model:inline", provider: "provider:inline", status: 200 }],
      },
    },
  };
}

function finishedChunkWithoutMetadata(): StreamChunk {
  return {
    type: EventType.RUN_FINISHED,
    runId: "run:unknown",
    threadId: "thread:unknown",
    finishReason: "stop",
  };
}

function finishedChunkWithMetadata(metadata: Readonly<Record<string, unknown>>): StreamChunk {
  return {
    type: EventType.RUN_FINISHED,
    runId: "run:metadata",
    threadId: "thread:metadata",
    finishReason: "stop",
    ...metadata,
  } as StreamChunk;
}
