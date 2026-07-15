import type { RoleModelProfile } from "../role-model-profiles.js";

const subject = {
  profileId: "deepseek-v4-flash-fireworks",
  version:
    "itotori.model-profile.v1:sha256:678d529133d505ae1608bea1f4c17e7bde76cc1c3c6b262f9040ce4a869f8e7d",
  model: "deepseek/deepseek-v4-flash",
  providerPolicy: {
    order: ["fireworks"],
    only: ["fireworks"],
    allowFallbacks: false,
    zdr: true,
    dataCollection: "deny",
    requireParameters: true,
  },
} as const satisfies RoleModelProfile;

/** Content-free result from the dated live attempt and its recorded fallback. */
export const deepSeekV4FlashFireworksProbe20260715 = {
  schemaVersion: "itotori.model-profile-probe-result.v1",
  subject,
  live: {
    probeMode: "live",
    probeStatus: "failed",
    certificateEligible: false,
    probedAt: "2026-07-15T20:58:54.199Z",
    failure: {
      kind: "provider-rate-limit",
      providerName: "Fireworks",
      httpStatus: 429,
      attemptCount: 3,
    },
    checks: {
      strictStructuredFinish: "not-observed",
      typedToolRoundTrip: "not-observed",
      reasoningDetailsContinuity: "not-observed",
      usageCapture: "not-observed",
      costCapture: "not-observed",
      generationLookup: "deferred",
      servedPairVerification: "deferred",
    },
    observations: {
      physicalStepCount: 0,
      toolExecutionCount: 0,
      reasoningDetailBatchCount: 0,
      generationLookupAttempts: 3,
      generationId: null,
      served: { status: "unknown" },
      billing: { status: "billing_unknown" },
    },
  },
  recordedFallback: {
    probeMode: "recorded",
    probeStatus: "machinery-passed",
    certificateEligible: false,
    recordedAt: "2026-07-15T20:58:30.000Z",
    provingTest:
      "llm-dispatch.test.ts: recorded conformance path with strict tools, reasoning, usage, cost, and unknown route evidence",
    checks: {
      strictStructuredFinish: "passed-recorded",
      typedToolRoundTrip: "passed-recorded",
      reasoningDetailsContinuity: "passed-recorded",
      usageCapture: "passed-recorded",
      costCapture: "passed-recorded",
      generationLookup: "deferred",
      servedPairVerification: "deferred",
    },
    observations: {
      physicalStepCount: 3,
      toolExecutionCount: 2,
      reasoningDetailBatchCount: 2,
      forwardedReasoningDetailBatchCount: 2,
      generationId: null,
      served: { status: "unknown" },
    },
  },
} as const;
