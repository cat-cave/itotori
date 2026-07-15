import { EventType, type StreamChunk } from "@tanstack/ai";
import { describe, expect, it } from "vitest";
import {
  UNKNOWN_GENERATION_METADATA,
  reconcileGenerationMetadata,
  type GenerationMetadataSource,
} from "../src/llm/generation-metadata.js";

describe("generation metadata reconciliation", () => {
  it("uses complete inline RUN_FINISHED metadata without a lookup", async () => {
    let lookups = 0;
    const source: GenerationMetadataSource = {
      async lookup() {
        lookups += 1;
        return UNKNOWN_GENERATION_METADATA;
      },
    };

    const metadata = await reconcileGenerationMetadata([inlineFinishedChunk()], source);

    expect(lookups).toBe(0);
    expect(metadata).toMatchObject({
      source: "inline",
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

  it("invokes a missing-inline lookup exactly once and keeps absence unknown", async () => {
    let lookups = 0;
    const source: GenerationMetadataSource = {
      async lookup() {
        lookups += 1;
        return UNKNOWN_GENERATION_METADATA;
      },
    };

    const metadata = await reconcileGenerationMetadata([finishedChunkWithoutMetadata()], source);

    expect(lookups).toBe(1);
    expect(metadata).toMatchObject({
      source: "unknown",
      generationId: null,
      served: { status: "unknown" },
    });
  });

  it("does not retry a failed generation lookup", async () => {
    let lookups = 0;
    const source: GenerationMetadataSource = {
      async lookup() {
        lookups += 1;
        throw new Error("generation metadata unavailable");
      },
    };

    await expect(
      reconcileGenerationMetadata([finishedChunkWithoutMetadata()], source),
    ).resolves.toMatchObject({ source: "unknown", served: { status: "unknown" } });
    expect(lookups).toBe(1);
  });

  it.each([
    [
      "structured pair",
      { served: { status: "confirmed", model: "unknown", provider: "provider:inline" } },
    ],
    ["flat pair", { servedModel: "unknown", servedProvider: "provider:inline" }],
    ["incomplete flat pair", { servedModel: "served/model:inline" }],
    [
      "selected endpoint",
      {
        openrouterMetadata: {
          endpoints: {
            available: [{ model: "unknown", provider: "provider:inline", selected: true }],
          },
        },
      },
    ],
  ])("keeps an invalid %s unknown", async (_label, routeMetadata) => {
    const metadata = await reconcileGenerationMetadata([finishedChunkWithMetadata(routeMetadata)], {
      async lookup() {
        return UNKNOWN_GENERATION_METADATA;
      },
    });

    expect(metadata).toMatchObject({
      generationId: "generation:inline:invalid-route",
      served: { status: "unknown" },
      source: "unknown",
    });
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
    runId: "run:invalid-route",
    threadId: "thread:invalid-route",
    finishReason: "stop",
    generationId: "generation:inline:invalid-route",
    ...metadata,
  } as StreamChunk;
}
