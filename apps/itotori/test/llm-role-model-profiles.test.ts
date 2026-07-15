import { describe, expect, it } from "vitest";
import { RoleIdSchema } from "../src/contracts/index.js";
import {
  MODEL_PROFILE_CERTIFICATE_VERSION,
  ROLE_MODEL_PROFILE_CONFIG_VERSION,
  ModelProfileCertificateSchema,
  constructRoleModelProfile,
  deepSeekV4FlashFireworksProfile,
  resolveRoleModelProfile,
  roleModelProfileConfig,
  type ModelProfileCertificate,
  type RoleModelProfile,
} from "../src/llm/role-model-profiles.js";
import { deepSeekV4FlashFireworksProbe20260715 } from "../src/llm/model-profiles/2026-07-15-deepseek-v4-flash-fireworks-probe.js";

const simulatedBilledUsd = ["0", "000001"].join(".");

describe("certified per-role model profiles", () => {
  it("resolves every A/P/Q role to the exact DeepSeek Flash ZDR policy", () => {
    const certificate = passingCertificate(deepSeekV4FlashFireworksProfile);

    const resolved = RoleIdSchema.options.map((roleId) =>
      resolveRoleModelProfile(roleId, { certificates: [certificate] }),
    );

    expect(roleModelProfileConfig.schemaVersion).toBe(ROLE_MODEL_PROFILE_CONFIG_VERSION);
    expect(resolved).toHaveLength(19);
    for (const profile of resolved) {
      expect(profile.model).toBe("deepseek/deepseek-v4-flash");
      expect(profile.providerPolicy).toEqual({
        order: ["fireworks"],
        only: ["fireworks"],
        allowFallbacks: false,
        zdr: true,
        dataCollection: "deny",
        requireParameters: true,
      });
      expect(profile.certificate.certificateStatus).toBe("valid");
    }
    expect(resolved.filter((profile) => profile.roleId.startsWith("A"))).toHaveLength(10);
    expect(resolved.filter((profile) => profile.roleId.startsWith("P"))).toHaveLength(3);
    expect(resolved.filter((profile) => profile.roleId.startsWith("Q"))).toHaveLength(6);
  });

  it.each(["openrouter/auto", "vendor/model:latest", "switchpoint/router"])(
    "rejects non-exact model route %s at construction",
    (model) => {
      expect(() =>
        constructRoleModelProfile({
          profileId: "invalid-route",
          model,
          providerPolicy: deepSeekV4FlashFireworksProfile.providerPolicy,
        }),
      ).toThrow(/exact versioned slug/u);
    },
  );

  it("fails closed when the exact profile has no valid certificate", () => {
    expect(() => resolveRoleModelProfile("A1", { certificates: [] })).toThrow(
      /no valid certificate/u,
    );
    const recorded = {
      ...passingCertificate(deepSeekV4FlashFireworksProfile),
      certificateStatus: "invalid",
      probeMode: "recorded",
    } as const;
    expect(() => resolveRoleModelProfile("P1", { certificates: [recorded] })).toThrow(
      /no valid certificate/u,
    );
  });

  it("mints a new version and invalidates the prior certificate on policy drift", () => {
    const changed = constructRoleModelProfile({
      profileId: deepSeekV4FlashFireworksProfile.profileId,
      model: deepSeekV4FlashFireworksProfile.model,
      providerPolicy: {
        ...deepSeekV4FlashFireworksProfile.providerPolicy,
        order: ["fireworks", "deepinfra"],
        only: ["fireworks", "deepinfra"],
      },
    });
    const changedConfig = {
      ...roleModelProfileConfig,
      profiles: { [changed.profileId]: changed },
    };

    expect(changed.version).not.toBe(deepSeekV4FlashFireworksProfile.version);
    expect(() =>
      resolveRoleModelProfile("Q1", {
        config: changedConfig,
        certificates: [passingCertificate(deepSeekV4FlashFireworksProfile)],
      }),
    ).toThrow(/no valid certificate/u);
  });

  it("mints a new version and invalidates the prior certificate on model drift", () => {
    const changed = constructRoleModelProfile({
      profileId: deepSeekV4FlashFireworksProfile.profileId,
      model: "deepseek/deepseek-v4-flash-20260423",
      providerPolicy: deepSeekV4FlashFireworksProfile.providerPolicy,
    });

    expect(changed.version).not.toBe(deepSeekV4FlashFireworksProfile.version);
    expect(passingCertificate(deepSeekV4FlashFireworksProfile).subject.version).not.toBe(
      changed.version,
    );
  });

  it("records unavailable generation and served-pair evidence only as deferred unknown", () => {
    const certificate = passingCertificate(deepSeekV4FlashFireworksProfile);

    expect(certificate.checks).toMatchObject({
      generationLookup: "deferred",
      servedPairVerification: "deferred",
    });
    expect(certificate.observations).toMatchObject({
      generationId: null,
      served: { status: "unknown" },
    });
    expect(certificate.observations).not.toHaveProperty("served.model");
    expect(certificate.observations).not.toHaveProperty("served.provider");
  });

  it("stores the failed live probe and green recorded fallback without minting a certificate", () => {
    const result = deepSeekV4FlashFireworksProbe20260715;

    expect(result.subject).toEqual(deepSeekV4FlashFireworksProfile);
    expect(result.live).toMatchObject({
      probeStatus: "failed",
      certificateEligible: false,
      failure: { kind: "provider-rate-limit", httpStatus: 429, attemptCount: 3 },
      checks: { generationLookup: "deferred", servedPairVerification: "deferred" },
      observations: {
        generationId: null,
        served: { status: "unknown" },
        billing: { status: "billing_unknown" },
      },
    });
    expect(result.recordedFallback).toMatchObject({
      probeStatus: "machinery-passed",
      certificateEligible: false,
    });
    expect(ModelProfileCertificateSchema.safeParse(result.live).success).toBe(false);
    expect(() => resolveRoleModelProfile("Q6")).toThrow(/no valid certificate/u);
  });
});

function passingCertificate(profile: RoleModelProfile): ModelProfileCertificate {
  return ModelProfileCertificateSchema.parse({
    schemaVersion: MODEL_PROFILE_CERTIFICATE_VERSION,
    certificateStatus: "valid",
    probeMode: "live",
    probedAt: "2026-07-15T00:00:00.000Z",
    subject: profile,
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
      physicalStepCount: 2,
      toolExecutionCount: 1,
      reasoningDetailBatchCount: 1,
      forwardedReasoningDetailBatchCount: 1,
      usage: { promptTokens: 2, completionTokens: 2, reasoningTokens: 1, cachedTokens: 0 },
      billedUsdByStep: [simulatedBilledUsd, simulatedBilledUsd],
      generationLookupAttempts: 2,
      generationId: null,
      served: { status: "unknown" },
    },
  });
}
