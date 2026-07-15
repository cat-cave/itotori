import { describe, expect, it } from "vitest";
import {
  PrivacyRetentionEgressContractSchema,
  QualifyingRunEgressSchema,
  RebuildCallWirePolicySchema,
  assertPrivacyRetentionEgressContract,
  assertRebuildLlmStartupPolicy,
  assertWebSearchEgress,
  privacyRetentionEgressManifest,
} from "../src/contracts/index.js";

describe("privacy, retention, and egress contract", () => {
  it("accepts the frozen policy manifest and rejects a weakened copy", () => {
    expect(
      PrivacyRetentionEgressContractSchema.safeParse(privacyRetentionEgressManifest).success,
    ).toBe(true);
    expect(
      PrivacyRetentionEgressContractSchema.safeParse({
        ...privacyRetentionEgressManifest,
        egress: { ...privacyRetentionEgressManifest.egress, qualifyingRunEnabled: true },
      }).success,
    ).toBe(false);
    expect(() => assertPrivacyRetentionEgressContract()).not.toThrow();
  });

  it("requires the complete private wire plan", () => {
    const policy = {
      model: "provider:model-v4",
      provider: {
        order: ["provider:primary", "provider:secondary"],
        only: ["provider:primary", "provider:secondary"],
        allowFallbacks: false,
        zdr: true,
        dataCollection: "deny",
        requireParameters: true,
      },
      headers: {
        "X-OpenRouter-Metadata": "enabled",
        "X-OpenRouter-Cache": "false",
      },
      plugins: [],
      remoteCache: false,
      hiddenRetries: false,
    } as const;

    expect(RebuildCallWirePolicySchema.safeParse(policy).success).toBe(true);
    expect(RebuildCallWirePolicySchema.safeParse({ ...policy, remoteCache: true }).success).toBe(
      false,
    );
    expect(
      RebuildCallWirePolicySchema.safeParse({
        ...policy,
        provider: { ...policy.provider, dataCollection: "allow" },
      }).success,
    ).toBe(false);
    expect(
      RebuildCallWirePolicySchema.safeParse({ ...policy, model: "provider:auto" }).success,
    ).toBe(false);
  });

  it("requires account and guardrail ZDR assertions before a rebuilt dispatcher starts", () => {
    expect(() => assertRebuildLlmStartupPolicy({})).toThrow("OPENROUTER_ZDR_ACCOUNT_ASSERTED");
    expect(() =>
      assertRebuildLlmStartupPolicy({
        OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1",
        OPENROUTER_ZDR_GUARDRAIL_ASSERTED: "1",
      }),
    ).not.toThrow();
  });

  it("permits web search only with the operator switch outside qualifying runs", () => {
    expect(() =>
      assertWebSearchEgress({ roleId: "A7", operatorEnabled: true, qualifyingRun: false }),
    ).not.toThrow();
    expect(() =>
      assertWebSearchEgress({ roleId: "A8", operatorEnabled: true, qualifyingRun: false }),
    ).toThrow("restricted");
    expect(() =>
      assertWebSearchEgress({ roleId: "A7", operatorEnabled: false, qualifyingRun: false }),
    ).toThrow("operator");
    expect(() =>
      assertWebSearchEgress({ roleId: "A7", operatorEnabled: true, qualifyingRun: true }),
    ).toThrow("qualifying");
    expect(
      QualifyingRunEgressSchema.safeParse({ qualifyingRun: true, webSearchEnabled: false }).success,
    ).toBe(true);
    expect(
      QualifyingRunEgressSchema.safeParse({ qualifyingRun: true, webSearchEnabled: true }).success,
    ).toBe(false);
  });
});
