import { describe, expect, it } from "vitest";
import { RoleIdSchema } from "../src/contracts/index.js";
import {
  MODEL_PROFILE_CERTIFICATE_VERSION,
  ROLE_MODEL_PROFILE_CONFIG_VERSION,
  ModelProfileCertificateSchema,
  certificateEvidenceHash,
  constructRoleModelProfile,
  deepSeekV4FlashProfile,
  resolveRoleModelProfile,
  roleModelProfileConfig,
  servedModelIsCertified,
  type ModelProfileCertificate,
  type RoleModelProfile,
} from "../src/llm/role-model-profiles.js";

const simulatedBilledUsd = ["0", "000001"].join(".");
const BIND_MEMO_KEY = `sha256:${"1".repeat(64)}` as const;
const BIND_TRANSCRIPT_HASH = `sha256:${"2".repeat(64)}` as const;

// ITOTORI-241 — the corrected invariant: a provider policy enforces
// capability + ZDR + automatic fallback and names NO provider. The
// actually-served (model, provider) pair is recorded per call, never pinned.
const zdrFallbackPolicy = {
  allowFallbacks: true,
  zdr: true,
  dataCollection: "deny",
  requireParameters: true,
} as const;

describe("certified per-role model profiles", () => {
  it("resolves every A/P/Q role to the DeepSeek Flash capability + ZDR + fallback policy", () => {
    const certificates = [passingCertificate(deepSeekV4FlashProfile)];
    const resolved = RoleIdSchema.options.map((roleId) =>
      resolveRoleModelProfile(roleId, { certificates }),
    );

    expect(roleModelProfileConfig.schemaVersion).toBe(ROLE_MODEL_PROFILE_CONFIG_VERSION);
    expect(resolved).toHaveLength(19);
    for (const profile of resolved) {
      expect(profile.model).toBe("deepseek/deepseek-v4-flash");
      // No provider is named: capability + ZDR + automatic fallback only.
      expect(profile.providerPolicy).toEqual(zdrFallbackPolicy);
      expect(profile.providerPolicy).not.toHaveProperty("only");
      expect(profile.providerPolicy).not.toHaveProperty("order");
      expect(profile.certificate.certificateStatus).toBe("valid");
      // The served pair is recorded telemetry, not a selection input.
      expect(profile.certificate.observations.served).toMatchObject({ status: "confirmed" });
    }
    expect(resolved.filter((profile) => profile.roleId.startsWith("A"))).toHaveLength(10);
    expect(resolved.filter((profile) => profile.roleId.startsWith("P"))).toHaveLength(3);
    expect(resolved.filter((profile) => profile.roleId.startsWith("Q"))).toHaveLength(6);
  });

  it.each([
    ["a non-empty only pin", { ...zdrFallbackPolicy, only: ["fireworks"] }],
    ["a hardcoded provider order", { ...zdrFallbackPolicy, order: ["fireworks"] }],
    ["allowFallbacks:false", { ...zdrFallbackPolicy, allowFallbacks: false }],
  ])("rejects %s at construction", (_label, pinnedPolicy) => {
    expect(() =>
      constructRoleModelProfile({
        profileId: "deepseek-v4-flash",
        model: "deepseek/deepseek-v4-flash",
        // deliberately reintroduce a single-provider pin
        providerPolicy: pinnedPolicy as never,
      }),
    ).toThrow(/must not pin a provider/u);
  });

  it("rejects a provider-bearing profile identity at construction", () => {
    // A provider named in the IDENTITY re-smuggles a pin even with a clean policy.
    expect(() =>
      constructRoleModelProfile({
        profileId: "deepseek-v4-flash-fireworks",
        model: "deepseek/deepseek-v4-flash",
        providerPolicy: zdrFallbackPolicy,
      }),
    ).toThrow(/must not name a provider/u);
    // The clean model + capability identity is accepted.
    expect(() =>
      constructRoleModelProfile({
        profileId: "deepseek-v4-flash",
        model: "deepseek/deepseek-v4-flash",
        providerPolicy: zdrFallbackPolicy,
      }),
    ).not.toThrow();
  });

  it("rejects a hand-authored certificate without a valid run binding", () => {
    // A fabricated certificate: exact subject, all checks passed, arbitrary
    // positive usage/cost, but an evidence hash NOT computed from a real run.
    const forged = {
      schemaVersion: MODEL_PROFILE_CERTIFICATE_VERSION,
      certificateStatus: "valid",
      probeMode: "live",
      probedAt: PROBED_AT,
      subject: deepSeekV4FlashProfile,
      checks: PASSING_CHECKS,
      observations: {
        ...passingObservationsWithoutBinding(),
        usage: {
          promptTokens: 9999,
          completionTokens: 9999,
          reasoningTokens: 9999,
          cachedTokens: 0,
        },
        billedUsdByStep: ["9.999999999999"],
        runBinding: {
          memoKey: BIND_MEMO_KEY,
          transcriptHash: BIND_TRANSCRIPT_HASH,
          evidenceHash: `sha256:${"0".repeat(64)}`,
        },
      },
    };
    expect(ModelProfileCertificateSchema.safeParse(forged).success).toBe(false);
    expect(() => resolveRoleModelProfile("A1", { certificates: [forged] })).toThrow(
      /no valid certificate/u,
    );

    // A certificate missing the run binding entirely is rejected by the schema.
    const noBinding = { ...forged, observations: passingObservationsWithoutBinding() };
    expect(ModelProfileCertificateSchema.safeParse(noBinding).success).toBe(false);

    // Control: the genuinely-sealed certificate parses and selects.
    expect(
      ModelProfileCertificateSchema.safeParse(passingCertificate(deepSeekV4FlashProfile)).success,
    ).toBe(true);
  });

  it.each(["openrouter/auto", "vendor/model:latest", "switchpoint/router"])(
    "rejects non-exact model route %s at construction",
    (model) => {
      expect(() =>
        constructRoleModelProfile({
          profileId: "invalid-route",
          model,
          providerPolicy: deepSeekV4FlashProfile.providerPolicy,
        }),
      ).toThrow(/exact versioned slug/u);
    },
  );

  it("fails closed when the exact profile has no valid certificate", () => {
    expect(() => resolveRoleModelProfile("A1", { certificates: [] })).toThrow(
      /no valid certificate/u,
    );
    const recorded = {
      ...passingCertificate(deepSeekV4FlashProfile),
      certificateStatus: "invalid",
      probeMode: "recorded",
    } as const;
    expect(() => resolveRoleModelProfile("P1", { certificates: [recorded] })).toThrow(
      /no valid certificate/u,
    );
  });

  it("mints a new version and invalidates the prior certificate on model drift", () => {
    const changed = constructRoleModelProfile({
      profileId: deepSeekV4FlashProfile.profileId,
      model: "deepseek/deepseek-v4-flash-20260423",
      providerPolicy: deepSeekV4FlashProfile.providerPolicy,
    });
    const changedConfig = {
      ...roleModelProfileConfig,
      profiles: { [changed.profileId]: changed },
    };

    expect(changed.version).not.toBe(deepSeekV4FlashProfile.version);
    // The prior certificate is content-addressed over {model, providerPolicy};
    // a model change mints a new version that the old certificate cannot cover.
    expect(passingCertificate(deepSeekV4FlashProfile).subject.version).not.toBe(changed.version);
    expect(() =>
      resolveRoleModelProfile("Q1", {
        config: changedConfig,
        certificates: [passingCertificate(deepSeekV4FlashProfile)],
      }),
    ).toThrow(/no valid certificate/u);
  });

  it("accepts the distinct no-lookup certificate shape only when reconciliation is disabled", () => {
    const certificate = deferredCertificate(deepSeekV4FlashProfile);

    expect(certificate.checks).toMatchObject({
      generationLookup: "deferred",
      servedPairVerification: "deferred",
    });
    expect(certificate.observations).toMatchObject({
      generationReconciliation: "disabled",
      generationLookupAttempts: 0,
      generationId: null,
      served: { status: "unknown" },
    });
    expect(certificate.observations).not.toHaveProperty("served.model");
    expect(certificate.observations).not.toHaveProperty("served.provider");

    const { runBinding, ...observations } = certificate.observations;
    const enabledObservations = { ...observations, generationReconciliation: "enabled" } as const;
    const reconciliationEnabled = {
      ...certificate,
      observations: {
        ...enabledObservations,
        runBinding: {
          ...runBinding,
          evidenceHash: certificateEvidenceHash({
            probedAt: certificate.probedAt,
            subject: certificate.subject,
            checks: certificate.checks,
            observations: enabledObservations,
            memoKey: runBinding.memoKey,
            transcriptHash: runBinding.transcriptHash,
          }),
        },
      },
    };
    expect(ModelProfileCertificateSchema.safeParse(reconciliationEnabled).success).toBe(false);
  });

  it("accepts a one-shot terminal lookup whose served pair is explicitly unknown", () => {
    const certificate = explicitUnknownCertificate(deepSeekV4FlashProfile);

    expect(certificate.checks).toMatchObject({
      generationLookup: "passed",
      servedPairVerification: "deferred",
    });
    expect(certificate.observations).toMatchObject({
      generationReconciliation: "enabled",
      generationLookupAttempts: 1,
      generationId: "generation:recorded-certificate",
      served: { status: "unknown" },
    });
    expect(resolveRoleModelProfile("A1", { certificates: [certificate] }).certificate).toEqual(
      certificate,
    );
  });

  it("rejects a reconciled observation that is relabeled as deferred", () => {
    const certificate = passingCertificate(deepSeekV4FlashProfile);
    const { runBinding, ...observations } = certificate.observations;
    const checks = {
      ...certificate.checks,
      generationLookup: "deferred",
      servedPairVerification: "deferred",
    } as const;
    const relabeled = {
      ...certificate,
      checks,
      observations: {
        ...observations,
        runBinding: {
          ...runBinding,
          evidenceHash: certificateEvidenceHash({
            probedAt: certificate.probedAt,
            subject: certificate.subject,
            checks,
            observations,
            memoKey: runBinding.memoKey,
            transcriptHash: runBinding.transcriptHash,
          }),
        },
      },
    };

    expect(ModelProfileCertificateSchema.safeParse(relabeled).success).toBe(false);
  });

  it("certifies from the appended faithful live certificate rather than failing closed", () => {
    const resolved = resolveRoleModelProfile("Q6");
    expect(resolved.certificate.certificateStatus).toBe("valid");
    expect(resolved.certificate.probeMode).toBe("live");
    expect(resolved.certificate.subject.model).toBe("deepseek/deepseek-v4-flash");
    expect(resolved.certificate.observations.generationLookupAttempts).toBe(1);
    expect(resolved.certificate.checks).toMatchObject({
      strictStructuredFinish: "passed",
      typedToolRoundTrip: "passed",
      reasoningDetailsContinuity: "passed",
      usageCapture: "passed",
      costCapture: "passed",
      generationLookup: "passed",
      servedPairVerification: "passed",
    });
  });
});

describe("servedModelIsCertified", () => {
  const certified = deepSeekV4FlashProfile.model; // "deepseek/deepseek-v4-flash"

  it("accepts the exact certified slug", () => {
    expect(servedModelIsCertified(certified, certified)).toBe(true);
  });

  it("accepts a dated snapshot pin of the certified model (OpenRouter served route)", () => {
    // The /generation lookup reports the concrete snapshot OpenRouter billed.
    expect(servedModelIsCertified(`${certified}-20260423`, certified)).toBe(true);
  });

  it("rejects a genuinely different model", () => {
    expect(servedModelIsCertified("deepseek/deepseek-v3", certified)).toBe(false);
    expect(servedModelIsCertified("anthropic/claude-opus-4-8", certified)).toBe(false);
  });

  it("rejects a non-date suffix (only 8-digit snapshot dates are a certified pin)", () => {
    expect(servedModelIsCertified(`${certified}-turbo`, certified)).toBe(false);
    expect(servedModelIsCertified(`${certified}-2026`, certified)).toBe(false);
    expect(servedModelIsCertified(`${certified}-free`, certified)).toBe(false);
  });

  it("rejects a different family that merely shares the prefix text", () => {
    expect(servedModelIsCertified("deepseek/deepseek-v4-flash-lite-20260423", certified)).toBe(
      false,
    );
  });
});

const PROBED_AT = "2026-07-15T00:00:00.000Z";
const PASSING_CHECKS = {
  strictStructuredFinish: "passed",
  typedToolRoundTrip: "passed",
  reasoningDetailsContinuity: "passed",
  usageCapture: "passed",
  costCapture: "passed",
  generationLookup: "passed",
  servedPairVerification: "passed",
} as const;

function passingObservationsWithoutBinding() {
  return {
    physicalStepCount: 2,
    toolExecutionCount: 1,
    reasoningDetailBatchCount: 1,
    forwardedReasoningDetailBatchCount: 1,
    usage: { promptTokens: 2, completionTokens: 2, reasoningTokens: 1, cachedTokens: 0 },
    billedUsdByStep: [simulatedBilledUsd, simulatedBilledUsd],
    generationReconciliation: "enabled",
    generationLookupAttempts: 1,
    generationId: "generation:recorded-certificate",
    served: {
      status: "confirmed",
      model: "deepseek/deepseek-v4-flash-20260423",
      provider: "recorded-zdr-provider",
    },
  } as const;
}

function passingCertificate(profile: RoleModelProfile): ModelProfileCertificate {
  const observations = passingObservationsWithoutBinding();
  const evidenceHash = certificateEvidenceHash({
    probedAt: PROBED_AT,
    subject: profile,
    checks: PASSING_CHECKS,
    observations,
    memoKey: BIND_MEMO_KEY,
    transcriptHash: BIND_TRANSCRIPT_HASH,
  });
  return ModelProfileCertificateSchema.parse({
    schemaVersion: MODEL_PROFILE_CERTIFICATE_VERSION,
    certificateStatus: "valid",
    probeMode: "live",
    probedAt: PROBED_AT,
    subject: profile,
    checks: PASSING_CHECKS,
    observations: {
      ...observations,
      runBinding: {
        memoKey: BIND_MEMO_KEY,
        transcriptHash: BIND_TRANSCRIPT_HASH,
        evidenceHash,
      },
    },
  });
}

function deferredCertificate(profile: RoleModelProfile): ModelProfileCertificate {
  const checks = {
    ...PASSING_CHECKS,
    generationLookup: "deferred",
    servedPairVerification: "deferred",
  } as const;
  const observations = {
    ...passingObservationsWithoutBinding(),
    generationReconciliation: "disabled",
    generationLookupAttempts: 0,
    generationId: null,
    served: { status: "unknown" },
  } as const;
  const evidenceHash = certificateEvidenceHash({
    probedAt: PROBED_AT,
    subject: profile,
    checks,
    observations,
    memoKey: BIND_MEMO_KEY,
    transcriptHash: BIND_TRANSCRIPT_HASH,
  });
  return ModelProfileCertificateSchema.parse({
    schemaVersion: MODEL_PROFILE_CERTIFICATE_VERSION,
    certificateStatus: "valid",
    probeMode: "live",
    probedAt: PROBED_AT,
    subject: profile,
    checks,
    observations: {
      ...observations,
      runBinding: {
        memoKey: BIND_MEMO_KEY,
        transcriptHash: BIND_TRANSCRIPT_HASH,
        evidenceHash,
      },
    },
  });
}

function explicitUnknownCertificate(profile: RoleModelProfile): ModelProfileCertificate {
  const checks = { ...PASSING_CHECKS, servedPairVerification: "deferred" } as const;
  const observations = {
    ...passingObservationsWithoutBinding(),
    served: { status: "unknown" },
  } as const;
  const evidenceHash = certificateEvidenceHash({
    probedAt: PROBED_AT,
    subject: profile,
    checks,
    observations,
    memoKey: BIND_MEMO_KEY,
    transcriptHash: BIND_TRANSCRIPT_HASH,
  });
  return ModelProfileCertificateSchema.parse({
    schemaVersion: MODEL_PROFILE_CERTIFICATE_VERSION,
    certificateStatus: "valid",
    probeMode: "live",
    probedAt: PROBED_AT,
    subject: profile,
    checks,
    observations: {
      ...observations,
      runBinding: {
        memoKey: BIND_MEMO_KEY,
        transcriptHash: BIND_TRANSCRIPT_HASH,
        evidenceHash,
      },
    },
  });
}
