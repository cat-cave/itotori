import type { ModelProfileCertificate, RoleModelProfile } from "../role-model-profiles.js";

const subject = {
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
} as const satisfies RoleModelProfile;

/**
 * Dated live conformance certificate for the DeepSeek Flash capability + ZDR
 * + automatic-fallback profile (ITOTORI-241). Fallback was ENABLED
 * (`allowFallbacks: true`, `zdr: true`), so OpenRouter routed within the
 * account ZDR allow-list and a single provider being rate-limited no longer
 * blocks the node — this is the direct fix for the earlier probe that
 * reported "blocked" when Fireworks returned HTTP 429.
 *
 * The dated live dispatch (2026-07-15) exercised strict structured finish, a
 * typed tool round-trip, reasoning-details continuity, provider usage + cost
 * capture, and a generation lookup. The certificate certifies the (model,
 * capability + ZDR policy, version) triple; it does NOT pin or require a
 * provider. The served (model, provider) pair is RECORDED as telemetry: the
 * served model is `deepseek/deepseek-v4-flash`, and the served provider is
 * explicit-unknown because generation reconciliation is deferred to
 * RB-010 / #941 — it is never fabricated.
 */
export const deepSeekV4FlashCertificate20260715: ModelProfileCertificate = {
  schemaVersion: "itotori.model-profile-certificate.v1",
  certificateStatus: "valid",
  probeMode: "live",
  probedAt: "2026-07-15T22:55:45.017Z",
  subject,
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
    physicalStepCount: 3,
    toolExecutionCount: 1,
    reasoningDetailBatchCount: 2,
    forwardedReasoningDetailBatchCount: 2,
    usage: { promptTokens: 3656, completionTokens: 333, reasoningTokens: 46, cachedTokens: 0 },
    billedUsdByStep: ["0.000074921000", "0.000133718000", "0.000392119000"],
    generationLookupAttempts: 3,
    generationId: null,
    served: { status: "unknown" },
    // Binds this certificate to its actual 2026-07-15 live run: memoKey is the
    // request identity, transcriptHash hashes the real dispatch transcript, and
    // evidenceHash seals the certified evidence. Recomputed and verified on
    // parse, so a hand-authored certificate is rejected.
    runBinding: {
      memoKey: "sha256:a2e3e23752826501f498e30e79cb37a14224b66c83cc209da54361d7176f99db",
      transcriptHash: "sha256:2b485ff3f8274f0163af1e3edb162be9085259e039cdee44d2c6020a79ef40b2",
      evidenceHash: "sha256:3233291093d06e4705ad634f25ff03f02facadd1e3ee23ebecd1dd230f098721",
    },
  },
};

/**
 * Provider-agnostic dated probe record. Replaces the stale
 * `2026-*-fireworks-probe` artifact: the profile and this record name NO
 * provider. `live.served` records the observed served pair honestly — the
 * model is known; the provider is explicit-unknown (deferred to RB-010 /
 * #941), never fabricated.
 */
export const deepSeekV4FlashProbe20260715 = {
  schemaVersion: "itotori.model-profile-probe-result.v1",
  subject,
  live: {
    probeMode: "live",
    probeStatus: "passed",
    certificateEligible: true,
    probedAt: "2026-07-15T22:55:45.017Z",
    // ITOTORI-241 — fallback across the account ZDR allow-list was enabled;
    // there is no single-provider pin. The transport made 3 physical steps
    // with no terminal rate-limit failure.
    fallback: { allowFallbacks: true, zdr: true },
    served: { model: "deepseek/deepseek-v4-flash", provider: { status: "unknown" } },
    checks: deepSeekV4FlashCertificate20260715.checks,
    observations: deepSeekV4FlashCertificate20260715.observations,
  },
  certificate: deepSeekV4FlashCertificate20260715,
} as const;
