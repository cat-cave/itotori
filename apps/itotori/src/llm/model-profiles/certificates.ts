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
 * account-wide ZDR policy). `generationLookupAttempts` is the faithful count of
 * the single authoritative lookup bound to the accepted terminal generation id
 * (RB-015 one-lookup invariant). The `runBinding.evidenceHash` is recomputed by
 * `ModelProfileCertificateSchema` on load, so these values cannot be hand-edited
 * without invalidating the certificate.
 */
export const modelProfileCertificates: readonly ModelProfileCertificate[] = [
  {
    schemaVersion: "itotori.model-profile-certificate.v1",
    certificateStatus: "valid",
    probeMode: "live",
    probedAt: "2026-07-19T05:19:33.228Z",
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
        promptTokens: 3665,
        completionTokens: 337,
        reasoningTokens: 53,
        cachedTokens: 2560,
      },
      billedUsdByStep: ["0.000076311000", "0.000134691000", "0.000392119000"],
      generationReconciliation: "enabled",
      runBinding: {
        memoKey: "sha256:a2e3e23752826501f498e30e79cb37a14224b66c83cc209da54361d7176f99db",
        transcriptHash: "sha256:b355f1a7ac0c49f1c701d65389d049246a8e29b19dd95c4f4c1f7f54bd441870",
        evidenceHash: "sha256:500dd2c267d7bec4886ac37c6f19f1224c0828b8f7f60601d096b0907018822e",
      },
      generationLookupAttempts: 1,
      generationId: "gen-1784438361-JOQ63uzJehOAbvlb0IJV",
      served: {
        status: "confirmed",
        model: "deepseek/deepseek-v4-flash-20260423",
        provider: "Morph",
      },
    },
  },
];
