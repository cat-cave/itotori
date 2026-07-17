import { describe, expect, it } from "vitest";
import {
  certificateEvidenceHash,
  constructRoleModelProfile,
} from "../src/llm/role-model-profiles.js";
import { modelProfileCertificates } from "../src/llm/model-profiles/certificates.js";
import {
  LIVE_CONFORMANCE_MAX_AGE_MS,
  admitQualifyingRun,
  runAfterQualifyingAdmission,
  type QualifyingAdmissionRequest,
} from "../src/zdr-admission/index.js";

const now = new Date("2026-07-16T00:00:00.000Z");
const certifiedProfile = constructRoleModelProfile({
  profileId: "deepseek-v4-flash",
  model: "deepseek/deepseek-v4-flash",
  providerPolicy: {
    allowFallbacks: true,
    zdr: true,
    dataCollection: "deny",
    requireParameters: true,
  },
});

const privateWire = {
  model: certifiedProfile.model,
  provider: certifiedProfile.providerPolicy,
  headers: { "X-OpenRouter-Metadata": "enabled", "X-OpenRouter-Cache": "false" },
  plugins: [],
  remoteCache: false,
  hiddenRetries: false,
} as const;

function qualifyingRequest(
  overrides: Partial<QualifyingAdmissionRequest> = {},
): QualifyingAdmissionRequest {
  return {
    env: {
      OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1",
      OPENROUTER_ZDR_GUARDRAIL_ASSERTED: "1",
    },
    routes: [
      {
        roleId: "P1",
        modelProfile: "draft",
        modelProfileVersion: certifiedProfile.version,
        requestedModel: certifiedProfile.model,
        providerPolicy: certifiedProfile.providerPolicy,
      },
    ],
    certificates: modelProfileCertificates,
    wireCapture: privateWire,
    telemetryCapture: {
      captureKind: "qualifying-content-free",
      contentFree: true,
      promptTextPathEnabled: false,
      sourceTextPathEnabled: false,
      targetTextPathEnabled: false,
    },
    egressPolicy: { operatorEnabled: false, qualifyingRun: true },
    now,
    ...overrides,
  };
}

describe("qualifying ZDR admission", () => {
  it("attests the six required privacy controls before the qualifying run", () => {
    const admission = admitQualifyingRun(qualifyingRequest());

    expect(admission).toMatchObject({
      admittedAt: now.toISOString(),
      routeCount: 1,
      attestations: {
        "account-zdr": "passed",
        "certified-route": "passed",
        "live-conformance": "passed",
        "private-wire": "passed",
        "content-free-telemetry": "passed",
        "web-egress-closed": "passed",
      },
    });
  });

  it("rejects missing account or guardrail ZDR assertions", () => {
    expect(() =>
      admitQualifyingRun(qualifyingRequest({ env: { OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1" } })),
    ).toThrow(/account-zdr/u);
  });

  it("rejects an unverified route and blocks the run before execution", async () => {
    let executions = 0;
    const request = qualifyingRequest({
      routes: [{ ...qualifyingRequest().routes[0]!, requestedModel: "unverified/model" }],
    });

    await expect(
      runAfterQualifyingAdmission(request, () => {
        executions += 1;
        return "should not run";
      }),
    ).rejects.toMatchObject({
      name: "QualifyingAdmissionError",
      attestation: "certified-route",
    });
    expect(executions).toBe(0);
  });

  it("rejects an expired live conformance capture", () => {
    expect(() =>
      admitQualifyingRun(
        qualifyingRequest({ now: new Date(now.getTime() + LIVE_CONFORMANCE_MAX_AGE_MS + 1) }),
      ),
    ).toThrow(/live-conformance/u);
  });

  it("rejects a valid-but-mismatched live conformance capture", () => {
    expect(() =>
      admitQualifyingRun(qualifyingRequest({ certificates: [mismatchedCertificate()] })),
    ).toThrow(/live-conformance/u);
  });

  it("rejects a missing outbound wire capture", () => {
    expect(() => admitQualifyingRun(qualifyingRequest({ wireCapture: null }))).toThrow(
      /private-wire/u,
    );
  });

  it.each([
    [
      "metadata disabled",
      { ...privateWire, headers: { ...privateWire.headers, "X-OpenRouter-Metadata": "disabled" } },
    ],
    [
      "cache enabled",
      { ...privateWire, headers: { ...privateWire.headers, "X-OpenRouter-Cache": "true" } },
    ],
    ["plugin enabled", { ...privateWire, plugins: ["external-plugin"] }],
  ])("rejects a private wire when %s", (_label, wireCapture) => {
    expect(() => admitQualifyingRun(qualifyingRequest({ wireCapture }))).toThrow(/private-wire/u);
  });

  it("rejects telemetry when any content text path is enabled", () => {
    expect(() =>
      admitQualifyingRun(
        qualifyingRequest({
          telemetryCapture: {
            captureKind: "qualifying-content-free",
            contentFree: true,
            promptTextPathEnabled: true,
            sourceTextPathEnabled: false,
            targetTextPathEnabled: false,
          },
        }),
      ),
    ).toThrow(/content-free-telemetry/u);
  });

  it("rejects the run when web egress is enabled", () => {
    expect(() =>
      admitQualifyingRun(
        qualifyingRequest({ egressPolicy: { operatorEnabled: true, qualifyingRun: true } }),
      ),
    ).toThrow(/web-egress-closed/u);
  });
});

function mismatchedCertificate() {
  const base = modelProfileCertificates[0]!;
  const otherProfile = constructRoleModelProfile({
    profileId: "different-deepseek-route",
    model: "deepseek/deepseek-v4-flash-2026-07",
    providerPolicy: certifiedProfile.providerPolicy,
  });
  const { runBinding, ...observations } = base.observations;
  return {
    ...base,
    subject: otherProfile,
    observations: {
      ...observations,
      runBinding: {
        ...runBinding,
        evidenceHash: certificateEvidenceHash({
          probedAt: base.probedAt,
          subject: otherProfile,
          checks: base.checks,
          observations,
          memoKey: runBinding.memoKey,
          transcriptHash: runBinding.transcriptHash,
        }),
      },
    },
  };
}
