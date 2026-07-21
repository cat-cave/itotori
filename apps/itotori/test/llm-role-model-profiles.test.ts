import { describe, expect, it } from "vitest";
import { RoleIdSchema } from "../src/contracts/index.js";
import { modelProfileCertificates } from "../src/llm/model-profiles/certificates.js";
import {
  MODEL_PROFILE_CERTIFICATE_VERSION,
  ModelProfileCertificateSchema,
  RegisteredModelProfileCertificateSchema,
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
const zdrFallbackPolicy = {
  allowFallbacks: true,
  zdr: true,
  dataCollection: "deny",
  requireParameters: true,
} as const;

describe("certified per-role model profiles", () => {
  it("resolves every role through the trusted live certificate", () => {
    const resolved = RoleIdSchema.options.map((roleId) => resolveRoleModelProfile(roleId));

    expect(roleModelProfileConfig.schemaVersion).toBe("itotori.role-model-profiles.v1");
    expect(resolved).toHaveLength(19);
    for (const profile of resolved) {
      expect(profile.model).toBe("deepseek/deepseek-v4-flash");
      expect(profile.providerPolicy).toEqual(zdrFallbackPolicy);
      expect(profile.certificate.certificateStatus).toBe("valid");
      expect(profile.certificate.observations.served).toMatchObject({ status: "confirmed" });
    }
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
        providerPolicy: pinnedPolicy as never,
      }),
    ).toThrow(/must not pin a provider/u);
  });

  it("rejects a provider-bearing profile identity at construction", () => {
    expect(() =>
      constructRoleModelProfile({
        profileId: "deepseek-v4-flash-fireworks",
        model: "deepseek/deepseek-v4-flash",
        providerPolicy: zdrFallbackPolicy,
      }),
    ).toThrow(/must not name a provider/u);
  });

  it("rejects a self-consistent hand-authored certificate without a real-run attestation", () => {
    const registered = modelProfileCertificates[0]!;
    const forged = {
      ...registered,
      certificate: {
        ...registered.certificate,
        observations: {
          ...registered.certificate.observations,
          usage: {
            promptTokens: 9999,
            completionTokens: 9999,
            reasoningTokens: 9999,
            cachedTokens: 0,
          },
          billedUsdByStep: ["9.999999999999"],
        },
      },
    };

    // The forged body has every internally coherent certificate field. The
    // loader rejects it because its detached signature only attests the real run.
    expect(ModelProfileCertificateSchema.safeParse(forged.certificate).success).toBe(true);
    expect(RegisteredModelProfileCertificateSchema.safeParse(forged).success).toBe(false);
    expect(() => resolveRoleModelProfile("A1", { certificates: [forged] })).toThrow(
      /no valid trusted certificate/u,
    );
  });

  it("rejects an unregistered certificate body even when its run references have valid hashes", () => {
    const body = passingCertificateBody(deepSeekV4FlashProfile);
    expect(ModelProfileCertificateSchema.safeParse(body).success).toBe(true);
    expect(() => resolveRoleModelProfile("A1", { certificates: [body] })).toThrow(
      /no valid trusted certificate/u,
    );
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

  it("fails closed when the exact profile has no trusted certificate", () => {
    expect(() => resolveRoleModelProfile("A1", { certificates: [] })).toThrow(
      /no valid trusted certificate/u,
    );
  });

  it("invalidates the certificate on exact model drift", () => {
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
    expect(() =>
      resolveRoleModelProfile("Q1", {
        config: changedConfig,
        certificates: modelProfileCertificates,
      }),
    ).toThrow(/no valid trusted certificate/u);
  });

  it("accepts a no-lookup body only when reconciliation is disabled", () => {
    const certificate = deferredCertificateBody(deepSeekV4FlashProfile);
    expect(ModelProfileCertificateSchema.safeParse(certificate).success).toBe(true);

    const enabled = {
      ...certificate,
      observations: { ...certificate.observations, generationReconciliation: "enabled" },
    };
    expect(ModelProfileCertificateSchema.safeParse(enabled).success).toBe(false);
  });

  it("accepts an explicitly unknown served pair after one terminal lookup", () => {
    expect(
      ModelProfileCertificateSchema.safeParse(
        explicitUnknownCertificateBody(deepSeekV4FlashProfile),
      ).success,
    ).toBe(true);
  });

  it("rejects a reconciled observation relabeled as deferred", () => {
    const certificate = passingCertificateBody(deepSeekV4FlashProfile);
    const relabeled = {
      ...certificate,
      checks: {
        ...certificate.checks,
        generationLookup: "deferred" as const,
        servedPairVerification: "deferred" as const,
      },
    };
    expect(ModelProfileCertificateSchema.safeParse(relabeled).success).toBe(false);
  });
});

describe("served model certification", () => {
  const certified = deepSeekV4FlashProfile.model;

  it("accepts the exact model and dated snapshots", () => {
    expect(servedModelIsCertified(certified, certified)).toBe(true);
    expect(servedModelIsCertified(`${certified}-20260423`, certified)).toBe(true);
  });

  it.each([
    "deepseek/deepseek-v3",
    "anthropic/claude-opus-4-8",
    `${certified}-turbo`,
    `${certified}-2026`,
    "deepseek/deepseek-v4-flash-lite-20260423",
  ])("rejects an uncertified served model %s", (model) => {
    expect(servedModelIsCertified(model, certified)).toBe(false);
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

function passingObservations() {
  return {
    physicalStepCount: 2,
    toolExecutionCount: 1,
    reasoningDetailBatchCount: 1,
    forwardedReasoningDetailBatchCount: 1,
    usage: { promptTokens: 2, completionTokens: 2, reasoningTokens: 1, cachedTokens: 0 },
    billedUsdByStep: [simulatedBilledUsd, simulatedBilledUsd],
    generationReconciliation: "enabled" as const,
    generationLookupAttempts: 1 as const,
    generationId: "generation:recorded-certificate",
    served: {
      status: "confirmed" as const,
      model: "deepseek/deepseek-v4-flash-20260423",
      provider: "recorded-zdr-provider",
    },
  };
}

function passingCertificateBody(profile: RoleModelProfile): ModelProfileCertificate {
  return ModelProfileCertificateSchema.parse({
    schemaVersion: MODEL_PROFILE_CERTIFICATE_VERSION,
    certificateStatus: "valid",
    probeMode: "live",
    probedAt: PROBED_AT,
    subject: profile,
    checks: PASSING_CHECKS,
    observations: {
      ...passingObservations(),
      runBinding: { memoKey: BIND_MEMO_KEY, transcriptHash: BIND_TRANSCRIPT_HASH },
    },
  });
}

function deferredCertificateBody(profile: RoleModelProfile): ModelProfileCertificate {
  const checks = {
    ...PASSING_CHECKS,
    generationLookup: "deferred" as const,
    servedPairVerification: "deferred" as const,
  };
  return ModelProfileCertificateSchema.parse({
    schemaVersion: MODEL_PROFILE_CERTIFICATE_VERSION,
    certificateStatus: "valid",
    probeMode: "live",
    probedAt: PROBED_AT,
    subject: profile,
    checks,
    observations: {
      ...passingObservations(),
      generationReconciliation: "disabled",
      generationLookupAttempts: 0,
      generationId: null,
      served: { status: "unknown" },
      runBinding: { memoKey: BIND_MEMO_KEY, transcriptHash: BIND_TRANSCRIPT_HASH },
    },
  });
}

function explicitUnknownCertificateBody(profile: RoleModelProfile): ModelProfileCertificate {
  const checks = { ...PASSING_CHECKS, servedPairVerification: "deferred" as const };
  return ModelProfileCertificateSchema.parse({
    schemaVersion: MODEL_PROFILE_CERTIFICATE_VERSION,
    certificateStatus: "valid",
    probeMode: "live",
    probedAt: PROBED_AT,
    subject: profile,
    checks,
    observations: {
      ...passingObservations(),
      served: { status: "unknown" },
      runBinding: { memoKey: BIND_MEMO_KEY, transcriptHash: BIND_TRANSCRIPT_HASH },
    },
  });
}
