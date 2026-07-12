// blind-judge ZDR adapter — strict-parse + ZDR-gate tests (NO real LLM calls).
//
// Exercises the REAL-path adapter's logic with an INLINE fake ModelProvider (a
// canned response), never a network call: it proves the adapter parses a
// well-formed judge response into the §4.3 contract, passes the provider's real
// ProviderRunRecord through (cost source), disqualifies a non-ZDR serve (§4.1),
// and rejects malformed/out-of-contract responses.

import { describe, expect, it } from "vitest";
import {
  BENCHMARK_QUALITY_RUBRIC,
  BENCHMARK_RUBRIC_DIMENSION_IDS,
} from "@itotori/localization-bridge-schema";
import {
  ZdrJudgeError,
  ZdrModelJudge,
  parseJudgeScoringJson,
  type BlindJudgeUnitInput,
} from "../../src/benchmark-stages/index.js";
import {
  ZERO_COST,
  localOnlyRoutingPosture,
  openRouterDefaultCapabilities,
  type ModelInvocationRequest,
  type ModelInvocationResult,
  type ModelProvider,
  type OpenRouterRoutingPosture,
  type ProviderRunRecord,
} from "../../src/providers/index.js";

function blindInput(): BlindJudgeUnitInput {
  return {
    unitId: "019ed010-0000-7000-8000-0000000000d1",
    decodedContext: {
      unitId: "019ed010-0000-7000-8000-0000000000d1",
      speaker: "和人",
      sourceLine: "おはよう、りん。",
      textSurface: null,
      scene: { sceneId: 2031, dispatchPosition: 1, dispatchOrderLength: 2, nextScene: 2040 },
      branch: null,
    },
    rubric: BENCHMARK_QUALITY_RUBRIC,
    candidates: [
      { blindLabel: "candidate-a", candidateText: "Morning, Rin." },
      { blindLabel: "candidate-b", candidateText: "Good morning, Rin." },
    ],
  };
}

function wellFormedJudgeJson(input: BlindJudgeUnitInput): string {
  return JSON.stringify({
    candidates: input.candidates.map((c) => ({
      blindLabel: c.blindLabel,
      dimensions: BENCHMARK_RUBRIC_DIMENSION_IDS.map((dimensionId) => ({
        dimensionId,
        score: 4,
        citation: null,
      })),
    })),
  });
}

function fakeProviderRun(zdr: boolean): ProviderRunRecord {
  const posture: OpenRouterRoutingPosture = zdr
    ? localOnlyRoutingPosture("fake-provider")
    : { ...localOnlyRoutingPosture("fake-provider"), zdr: false };
  return {
    runId: "fake-judge-run",
    taskKind: "llm_qa",
    startedAt: "1970-01-01T00:00:00.000Z",
    completedAt: "1970-01-01T00:00:00.000Z",
    latencyMs: 0,
    status: "succeeded",
    provider: {
      providerFamily: "fake",
      endpointFamily: "recorded-fixture",
      providerName: "fake-judge",
      requestedModelId: "fake/model",
      actualModelId: "fake/model",
      requestedProviderId: "fake-provider",
    },
    structuredOutputMode: "plain_json",
    retryCount: 0,
    errorClasses: [],
    fallbackUsed: false,
    fallbackPlan: [],
    tokenUsage: { tokenCountSource: "deterministic_counter", totalTokens: 0 },
    cost: ZERO_COST,
    routingPosture: posture,
    usageResponseJson: {},
    prompt: { presetId: "fake", templateVersion: "1.0.0", promptHash: "sha256:fake" },
  };
}

function fakeProvider(content: string, zdr: boolean): ModelProvider {
  return {
    descriptor: {
      family: "fake",
      endpointFamily: "recorded-fixture",
      providerName: "fake-judge",
      defaultModelId: "fake/model",
      capabilities: openRouterDefaultCapabilities,
    },
    invoke: async (_request: ModelInvocationRequest): Promise<ModelInvocationResult> => ({
      content,
      toolCalls: [],
      finishReason: "stop",
      providerRun: fakeProviderRun(zdr),
    }),
  };
}

function makeJudge(content: string, zdr: boolean): ZdrModelJudge {
  return makeJudgeWithProvider(fakeProvider(content, zdr));
}

function makeJudgeWithProvider(provider: ModelProvider): ZdrModelJudge {
  return new ZdrModelJudge({
    judgeId: "judge-fake",
    modelId: "fake/model",
    providerId: "fake-provider",
    modelFamily: "fake",
    provider,
    capabilities: {
      ...openRouterDefaultCapabilities,
      structuredOutputs: {
        ...openRouterDefaultCapabilities.structuredOutputs,
        jsonSchema: "unsupported",
        jsonObject: "unsupported",
        plainJsonExtraction: "supported",
        preferredModes: ["plain_json"],
      },
    },
    maxPriceUsd: 0.05,
  });
}

function sequencedFakeProvider(
  responses: readonly { content: string; zdr: boolean }[],
  requests: ModelInvocationRequest[],
): ModelProvider {
  const descriptor = fakeProvider("", true).descriptor;
  let invocationIndex = 0;
  return {
    descriptor,
    invoke: async (request): Promise<ModelInvocationResult> => {
      requests.push(request);
      const response = responses[Math.min(invocationIndex, responses.length - 1)];
      invocationIndex += 1;
      if (response === undefined) {
        throw new Error("sequenced fake judge requires at least one response");
      }
      return {
        content: response.content,
        toolCalls: [],
        finishReason: "stop",
        providerRun: fakeProviderRun(response.zdr),
      };
    },
  };
}

describe("ZdrModelJudge — parse + passthrough + ZDR gate", () => {
  it("parses a well-formed response and passes the real provider run through", async () => {
    const input = blindInput();
    const judge = makeJudge(wellFormedJudgeJson(input), true);
    const scoring = await judge.scoreUnit(input);
    expect(scoring.unitId).toBe(input.unitId);
    expect(scoring.candidates.map((c) => c.blindLabel).sort()).toEqual([
      "candidate-a",
      "candidate-b",
    ]);
    for (const candidate of scoring.candidates) {
      expect(candidate.dimensions.length).toBe(BENCHMARK_RUBRIC_DIMENSION_IDS.length);
    }
    expect(scoring.providerRun.cost.costKind).toBe("zero");
    expect(scoring.providerRun.routingPosture.zdr).toBe(true);
  });

  it("DISQUALIFIES a non-ZDR serve (§4.1)", async () => {
    const input = blindInput();
    const judge = makeJudge(wellFormedJudgeJson(input), false);
    await expect(judge.scoreUnit(input)).rejects.toThrow(/not ZDR-routed/);
  });

  it("correctively retries invalid scoring schema before accepting the judge attempt", async () => {
    const input = blindInput();
    const requests: ModelInvocationRequest[] = [];
    const schemaInvalid = JSON.stringify({
      candidates: [{ blindLabel: "candidate-a", dimensions: [] }],
    });
    const judge = makeJudgeWithProvider(
      sequencedFakeProvider(
        [
          { content: schemaInvalid, zdr: true },
          { content: wellFormedJudgeJson(input), zdr: true },
        ],
        requests,
      ),
    );

    const scoring = await judge.scoreUnit(input);

    expect(scoring.candidates).toHaveLength(input.candidates.length);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages.at(-1)?.content).toMatch(
      /schema_invalid.*did not score dimension/iu,
    );
  });

  it("correctively retries a non-ZDR semantic failure before accepting a ZDR serve", async () => {
    const input = blindInput();
    const requests: ModelInvocationRequest[] = [];
    const judge = makeJudgeWithProvider(
      sequencedFakeProvider(
        [
          { content: wellFormedJudgeJson(input), zdr: false },
          { content: wellFormedJudgeJson(input), zdr: true },
        ],
        requests,
      ),
    );

    const scoring = await judge.scoreUnit(input);

    expect(scoring.providerRun.routingPosture.zdr).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages.at(-1)?.content).toMatch(/semantic_invalid.*not ZDR-routed/iu);
  });
});

describe("parseJudgeScoringJson — reject-before-accept", () => {
  it("rejects non-JSON, wrong shape, unknown label, missing dimension, bad score", () => {
    const input = blindInput();
    expect(() => parseJudgeScoringJson("not json", input)).toThrow(ZdrJudgeError);
    expect(() => parseJudgeScoringJson(JSON.stringify({ candidates: {} }), input)).toThrow(
      /candidates must be an array/,
    );
    // Unknown blind label.
    expect(() =>
      parseJudgeScoringJson(
        JSON.stringify({ candidates: [{ blindLabel: "candidate-z", dimensions: [] }] }),
        input,
      ),
    ).toThrow(/unknown blind label/);
    // Missing dimensions for a real label.
    expect(() =>
      parseJudgeScoringJson(
        JSON.stringify({ candidates: [{ blindLabel: "candidate-a", dimensions: [] }] }),
        input,
      ),
    ).toThrow(/did not score dimension/);
    // Out-of-range score.
    const badScore = JSON.stringify({
      candidates: [
        {
          blindLabel: "candidate-a",
          dimensions: BENCHMARK_RUBRIC_DIMENSION_IDS.map((dimensionId) => ({
            dimensionId,
            score: 7,
            citation: null,
          })),
        },
      ],
    });
    expect(() => parseJudgeScoringJson(badScore, input)).toThrow(/not a 0-4 rubric score/);
  });

  it("accepts a citation object and requires all three string fields", () => {
    const input = blindInput();
    const withBadCitation = JSON.stringify({
      candidates: [
        {
          blindLabel: "candidate-a",
          dimensions: BENCHMARK_RUBRIC_DIMENSION_IDS.map((dimensionId) => ({
            dimensionId,
            score: 2,
            citation: { sourceSpan: "x", decodedContextUsed: "y" }, // missing rationale
          })),
        },
      ],
    });
    expect(() => parseJudgeScoringJson(withBadCitation, input)).toThrow(/citation must carry/);
  });
});
