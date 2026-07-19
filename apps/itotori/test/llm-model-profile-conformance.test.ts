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
import { reviewVerdictExample } from "./contract-fixtures-core.js";

const HASH_A = `sha256:${"a".repeat(64)}` as const;
const HASH_B = `sha256:${"b".repeat(64)}` as const;
const capturedBilledUsd = ["0", "000001"].join(".");

describe("live model-profile conformance certification", () => {
  it("certifies a no-lookup probe only when reconciliation was disabled", async () => {
    const certificate = certifyLiveModelProfile(
      deepSeekV4FlashProfile,
      await recordedProbeTransport("disabled").observe(),
    );

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
        generationReconciliation: "disabled",
        generationLookupAttempts: 0,
        generationId: null,
        served: { status: "unknown" },
      },
    });
  });

  it("certifies a recorded probe with exactly one reconciled generation lookup", async () => {
    const certificate = certifyLiveModelProfile(
      deepSeekV4FlashProfile,
      await recordedProbeTransport("verified").observe(),
    );

    expect(certificate).toMatchObject({
      certificateStatus: "valid",
      probeMode: "live",
      checks: {
        generationLookup: "passed",
        servedPairVerification: "passed",
      },
      observations: {
        generationReconciliation: "enabled",
        generationLookupAttempts: 1,
        generationId: "generation:recorded-probe",
        served: {
          status: "confirmed",
          model: "deepseek/deepseek-v4-flash-20260423",
          provider: "recorded-zdr-provider",
        },
      },
    });
  });

  it("certifies an eventual-consistency miss after one terminal lookup as explicit unknown", async () => {
    const certificate = certifyLiveModelProfile(
      deepSeekV4FlashProfile,
      await recordedProbeTransport("explicit-unknown").observe(),
    );

    expect(certificate).toMatchObject({
      certificateStatus: "valid",
      probeMode: "live",
      checks: {
        generationLookup: "passed",
        servedPairVerification: "deferred",
      },
      observations: {
        generationReconciliation: "enabled",
        generationLookupAttempts: 1,
        generationId: "generation:recorded-probe",
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
      "a disabled reconciliation probe performs a lookup",
      (value: LiveConformanceObservations) => ({
        ...value,
        generationReconciliationEnabled: false,
        result: explicitUnknownResult(),
        generationLookupAttempts: 1,
      }),
      /neither disabled, explicitly unknown, nor verified/u,
    ],
    [
      "an enabled terminal lookup is absent",
      (value: LiveConformanceObservations) => ({ ...value, generationLookupAttempts: 0 }),
      /neither disabled, explicitly unknown, nor verified/u,
    ],
    [
      "the measured terminal lookup count is above one",
      (value: LiveConformanceObservations) => ({ ...value, generationLookupAttempts: 2 }),
      /neither disabled, explicitly unknown, nor verified/u,
    ],
    [
      "an explicit unknown lookup has no terminal generation ID",
      (value: LiveConformanceObservations) => ({
        ...value,
        result: explicitUnknownResult(),
        generationLookupAttempts: 1,
      }),
      /neither disabled, explicitly unknown, nor verified/u,
    ],
    [
      "different served model",
      (value: LiveConformanceObservations) => ({
        ...value,
        result: withResult(value.result, {
          served: { status: "confirmed", model: "other/model", provider: "recorded-zdr-provider" },
        }),
      }),
      /outside the certified model family/u,
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
  ])("refuses certification when %s proof is removed", async (_label, mutate, message) => {
    const observations = mutate(await recordedProbeTransport("verified").observe());
    expect(() => certifyLiveModelProfile(deepSeekV4FlashProfile, observations)).toThrow(message);
  });
});

function withResult(result: CallResult, patch: Record<string, unknown>): CallResult {
  return { ...result, ...patch } as CallResult;
}

type ReconciliationMode = "disabled" | "verified" | "explicit-unknown";

function recordedProbeTransport(mode: ReconciliationMode): {
  readonly observe: () => Promise<LiveConformanceObservations>;
} {
  return {
    async observe() {
      return passingObservations(mode);
    },
  };
}

function passingObservations(mode: ReconciliationMode): LiveConformanceObservations {
  return {
    probedAt: "2026-07-15T00:00:00.000Z",
    result:
      mode === "disabled"
        ? explicitUnknownResult()
        : mode === "explicit-unknown"
          ? lookupUnknownResult()
          : reconciledResult(),
    steps: [step("tool-calls"), step("terminal")],
    toolExecutionCount: 1,
    reasoning: {
      receivedBatchCount: 1,
      receivedDetailCount: 1,
      forwardedBatchCount: 1,
      forwardedDetailCount: 1,
      exactForwardCount: 1,
    },
    generationReconciliationEnabled: mode !== "disabled",
    generationLookupAttempts: mode === "disabled" ? 0 : 1,
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

function explicitUnknownResult(): CallResult {
  return CallResultSchema.parse({
    schemaVersion: CALL_RESULT_SCHEMA_VERSION,
    memoKey: HASH_A,
    requested: {
      model: deepSeekV4FlashProfile.model,
    },
    memoHit: false,
    status: "success",
    value: reviewVerdictExample,
    responseEventId: HASH_B,
    served: { status: "unknown" },
    generationId: null,
    verification: "explicit-unknown",
    usage: { promptTokens: 2, completionTokens: 2, reasoningTokens: 1, cachedTokens: 0 },
    billing: { status: "confirmed", costUsd: capturedBilledUsd },
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

function reconciledResult(): CallResult {
  return withResult(explicitUnknownResult(), {
    served: {
      status: "confirmed",
      model: "deepseek/deepseek-v4-flash-20260423",
      provider: "recorded-zdr-provider",
    },
    generationId: "generation:recorded-probe",
    verification: "verified",
  });
}

function lookupUnknownResult(): CallResult {
  return withResult(explicitUnknownResult(), {
    generationId: "generation:recorded-probe",
  });
}
