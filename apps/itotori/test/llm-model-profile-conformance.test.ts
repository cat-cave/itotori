import { describe, expect, it } from "vitest";
import {
  CALL_RESULT_SCHEMA_VERSION,
  CallResultSchema,
  type CallResult,
} from "../src/contracts/index.js";
import {
  certifyLiveModelProfile,
  type LiveConformanceObservations,
} from "../src/llm/model-profile-conformance.js";
import { deepSeekV4FlashProfile } from "../src/llm/role-model-profiles.js";

const HASH_A = `sha256:${"a".repeat(64)}` as const;
const HASH_B = `sha256:${"b".repeat(64)}` as const;
const capturedBilledUsd = ["0", "000001"].join(".");

describe("live model-profile conformance certification", () => {
  it("certifies strict finish, tools, reasoning continuity, usage, and cost while deferring unknown route metadata", () => {
    const certificate = certifyLiveModelProfile(deepSeekV4FlashProfile, passingObservations());

    expect(certificate).toMatchObject({
      certificateStatus: "valid",
      probeMode: "live",
      checks: {
        strictStructuredFinish: "passed",
        typedToolRoundTrip: "passed",
        reasoningDetailsContinuity: "passed",
        usageCapture: "passed",
        costCapture: "passed",
        generationLookup: "deferred",
        servedPairVerification: "deferred",
      },
      observations: {
        generationId: null,
        served: { status: "unknown" },
      },
    });
  });

  it.each([
    [
      "strict terminal",
      (value: LiveConformanceObservations) => ({
        ...value,
        steps: value.steps.map((step, index) =>
          index === value.steps.length - 1 ? { ...step, outcomeKind: "invalid" as const } : step,
        ),
      }),
      /strict structured terminal/u,
    ],
    [
      "typed tool round-trip",
      (value: LiveConformanceObservations) => ({ ...value, toolExecutionCount: 0 }),
      /typed tool round-trip/u,
    ],
    [
      "reasoning continuity",
      (value: LiveConformanceObservations) => ({
        ...value,
        reasoning: { ...value.reasoning, exactForwardCount: 0 },
      }),
      /opaque reasoning details/u,
    ],
    [
      "usage",
      (value: LiveConformanceObservations) => ({
        ...value,
        steps: value.steps.map((step) => ({ ...step, promptTokens: null })),
      }),
      /provider usage/u,
    ],
    [
      "cost",
      (value: LiveConformanceObservations) => ({
        ...value,
        steps: value.steps.map((step) => ({
          ...step,
          billingState: "billing_unknown" as const,
          billedUsd: null,
        })),
      }),
      /provider-reported cost/u,
    ],
    [
      "explicit unknown reconciliation",
      (value: LiveConformanceObservations) => ({ ...value, generationLookupAttempts: 0 }),
      /explicit unknown/u,
    ],
    [
      "reasoning detail counts",
      (value: LiveConformanceObservations) => ({
        ...value,
        reasoning: { ...value.reasoning, receivedDetailCount: 0, forwardedDetailCount: 0 },
      }),
      /opaque reasoning details/u,
    ],
    [
      "reconciled result usage",
      (value: LiveConformanceObservations) => ({
        ...value,
        result: withResult(value.result, {
          usage: { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cachedTokens: 0 },
        }),
      }),
      /provider usage/u,
    ],
    [
      "reconciled result billing cost",
      (value: LiveConformanceObservations) => ({
        ...value,
        result: withResult(value.result, { billing: { status: "confirmed", costUsd: "0" } }),
      }),
      /provider-reported cost/u,
    ],
    [
      "terminal transcript event",
      (value: LiveConformanceObservations) => ({
        ...value,
        result: withResult(value.result, {
          events: value.result.events.filter(
            (event) => !(event.kind === "model-step-finished" && event.finishReason === "stop"),
          ),
        }),
      }),
      /terminal model step/u,
    ],
  ])("refuses certification when %s proof is removed", (_label, mutate, message) => {
    expect(() =>
      certifyLiveModelProfile(deepSeekV4FlashProfile, mutate(passingObservations())),
    ).toThrow(message);
  });
});

function withResult(result: CallResult, patch: Record<string, unknown>): CallResult {
  return { ...result, ...patch } as CallResult;
}

function passingObservations(): LiveConformanceObservations {
  return {
    probedAt: "2026-07-15T00:00:00.000Z",
    result: quarantinedResult(),
    steps: [step("tool-calls"), step("terminal")],
    toolExecutionCount: 1,
    reasoning: {
      receivedBatchCount: 1,
      receivedDetailCount: 1,
      forwardedBatchCount: 1,
      forwardedDetailCount: 1,
      exactForwardCount: 1,
    },
    generationLookupAttempts: 2,
  };
}

function step(outcomeKind: "tool-calls" | "terminal") {
  return {
    outcomeKind,
    promptTokens: 2,
    completionTokens: 2,
    reasoningTokens: 1,
    cachedTokens: 0,
    billingState: "confirmed" as const,
    billedUsd: capturedBilledUsd,
  };
}

function quarantinedResult(): CallResult {
  return CallResultSchema.parse({
    schemaVersion: CALL_RESULT_SCHEMA_VERSION,
    memoKey: HASH_A,
    requested: {
      model: deepSeekV4FlashProfile.model,
    },
    memoHit: false,
    status: "failure",
    failureKind: "quarantined",
    responseEventId: HASH_B,
    responseEncrypted: {
      storageRef: "encrypted:conformance-response",
      contentHash: HASH_B,
      encryption: "operator-managed",
    },
    served: { status: "unknown" },
    generationId: null,
    verification: "quarantined",
    usage: { promptTokens: 2, completionTokens: 2, reasoningTokens: 1, cachedTokens: 0 },
    billing: { status: "confirmed", costUsd: capturedBilledUsd },
    defects: [],
    events: [
      { kind: "run-started", iteration: 0 },
      {
        kind: "model-step-finished",
        iteration: 0,
        reportedModel: deepSeekV4FlashProfile.model,
        finishReason: "tool-calls",
      },
      {
        kind: "tool-step-finished",
        iteration: 1,
        toolCallId: "tool-call:conformance",
        tool: "decode_get_units",
        argumentsHash: HASH_A,
        result: {
          schemaVersion: "itotori.tool.decode-get-units-result.v1",
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
        },
      },
      {
        kind: "model-step-finished",
        iteration: 1,
        reportedModel: deepSeekV4FlashProfile.model,
        finishReason: "stop",
      },
      { kind: "run-finished", iterationCount: 2, toolCallCount: 1, finishReason: "stop" },
    ],
  });
}
