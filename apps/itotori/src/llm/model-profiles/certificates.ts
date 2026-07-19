import type { ModelProfileCertificate } from "../role-model-profiles.js";

/**
 * Dated certificates are appended only after the live probe has emitted a
 * verified result. Until that evidence is committed, production resolution is
 * deliberately fail-closed rather than treating an older deferred capture as
 * proof of the current reconciliation contract.
 *
 * The entry below is the verbatim artifact emitted by the live DeepSeek V4
 * Flash probe (`apps/itotori/test/llm-model-profile-live.test.ts`) on a real
 * ZDR-scoped OpenRouter call: strict structured finish, typed tool round-trip,
 * opaque reasoning-detail continuity, provider usage + cost, and a reconciled
 * served pair (`deepseek/deepseek-v4-flash-20260423` served by Morph under the
 * account-wide ZDR policy). The `runBinding.evidenceHash` is recomputed by
 * `ModelProfileCertificateSchema` on load, so these values cannot be hand-edited
 * without invalidating the certificate.
 */
export const modelProfileCertificates: readonly ModelProfileCertificate[] = [
  {
    schemaVersion: "itotori.model-profile-certificate.v1",
    certificateStatus: "valid",
    probeMode: "live",
    probedAt: "2026-07-19T04:23:00.592Z",
    subject: {
      profileId: "deepseek-v4-flash",
      version:
        "itotori.model-profile.v1:sha256:8ba1a4fe037eecadfd22e717073346ea3918634b4ba1136a7e3d7ecaa351472e",
      model: "deepseek/deepseek-v4-flash",
      providerPolicy: {
        allowFallbacks: true,
        zdr: true,
        dataCollection: "deny",
        requireParameters: true,
      },
    },
    checks: {
      strictStructuredFinish: "passed",
      typedToolRoundTrip: "passed",
      reasoningDetailsContinuity: "passed",
      usageCapture: "passed",
      costCapture: "passed",
      generationLookup: "passed",
      servedPairVerification: "passed",
    },
    observations: {
      physicalStepCount: 3,
      toolExecutionCount: 1,
      reasoningDetailBatchCount: 2,
      forwardedReasoningDetailBatchCount: 2,
      usage: {
        promptTokens: 3673,
        completionTokens: 341,
        reasoningTokens: 61,
        cachedTokens: 512,
      },
      billedUsdByStep: ["0.000077423000", "0.000135803000", "0.000392119000"],
      runBinding: {
        memoKey: "sha256:a2e3e23752826501f498e30e79cb37a14224b66c83cc209da54361d7176f99db",
        transcriptHash: "sha256:58a96f5dd740faf5de80578a99d834b1c53f1c2f73cca22c07eeb67fccea54f0",
        evidenceHash: "sha256:3eb0cf2d4eb2c67e7ef929d9b8bfb938eb6e8f833391ca5b5480247f0ec9c8f7",
      },
      generationLookupAttempts: 1,
      generationId: "gen-1784434970-NCbLZiT1xfcxVuuV1vZ9",
      served: {
        status: "confirmed",
        model: "deepseek/deepseek-v4-flash-20260423",
        provider: "Morph",
      },
    },
  },
];
