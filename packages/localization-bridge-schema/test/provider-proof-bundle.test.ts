import { describe, expect, it } from "vitest";
import {
  PROVIDER_PROOF_BUNDLE_SCHEMA_VERSION,
  ProviderProofBundleValidationError,
  assertProviderProofBundle,
  parseProviderProofBundle,
  type ProviderProofBundle,
} from "../src/provider-proof-bundle.js";

function validBundle(): ProviderProofBundle {
  return {
    schemaVersion: PROVIDER_PROOF_BUNDLE_SCHEMA_VERSION,
    proofId: "provider-proof:recorded:fixture-a",
    mode: "recorded",
    fixtureId: "fixture-a",
    maxRepairAttempts: 1,
    zdr: { accountAssertion: "recorded_fixture", perRequestZdr: true },
    roles: [
      {
        role: "draft",
        terminalStatus: "accepted",
        acceptedProviderProofId: "recorded:run-1",
        acceptedOutputHash: "sha256:abc",
        acceptedItemCount: 1,
        attempts: [
          {
            attemptIndex: 0,
            retryState: "initial",
            retryReason: null,
            outcome: "accepted",
            rejection: null,
            providerProofId: "recorded:run-1",
            requestedModelId: "m",
            requestedProviderId: "p",
            servedModel: "m",
            servedProvider: "p",
            requestedRoute: "p",
            servedRoute: "p::m",
            structuredOutputMode: "json_object",
            tokensIn: 10,
            tokensOut: 5,
            tokenCountSource: "deterministic_counter",
            costUsd: "0.000012",
            costMicrosUsd: 12,
            latencyMs: 0,
            zdr: true,
            promptHash: "sha256:p",
          },
        ],
      },
    ],
    ledger: [
      {
        providerProofId: "recorded:run-1",
        role: "draft",
        modelId: "m",
        providerId: "p",
        servedProvider: "p",
        servedModel: "m",
        tokensIn: 10,
        tokensOut: 5,
        tokenCountSource: "deterministic_counter",
        costUnit: "usd",
        costAmount: "0.000012",
        costMicrosUsd: 12,
        latencyMs: 0,
        zdr: true,
        promptHash: "sha256:p",
      },
    ],
    qaOracle: {
      seededDefectCount: 1,
      emittedFindingCount: 1,
      truePositives: 1,
      falsePositives: 0,
      falseNegatives: 0,
      precision: 1,
      recall: 1,
      f1: 1,
      severityCalibration: 1,
      matchedSeededDefectIds: ["seed-1"],
      falseNegativeSeededDefectIds: [],
      falsePositiveBridgeUnitIds: [],
    },
  };
}

describe("provider-proof bundle schema", () => {
  it("accepts a well-formed sanitized bundle", () => {
    expect(() => assertProviderProofBundle(validBundle())).not.toThrow();
  });

  it("round-trips through parse", () => {
    const bundle = validBundle();
    expect(parseProviderProofBundle(JSON.stringify(bundle))).toEqual(bundle);
  });

  it("rejects a stale schema version", () => {
    const bundle = { ...validBundle(), schemaVersion: "stale" };
    expect(() => assertProviderProofBundle(bundle)).toThrow(ProviderProofBundleValidationError);
  });

  it("rejects an accepted role that names no accepted proof id", () => {
    const bundle = validBundle();
    bundle.roles[0]!.acceptedProviderProofId = null;
    expect(() => assertProviderProofBundle(bundle)).toThrow(/acceptedProviderProofId/u);
  });

  it("rejects a rejected role that still names an accepted proof id", () => {
    const bundle = validBundle();
    bundle.roles[0]!.terminalStatus = "rejected_schema_invalid";
    expect(() => assertProviderProofBundle(bundle)).toThrow(/must not name an accepted proof/u);
  });

  it("rejects an accepted attempt that carries a rejection", () => {
    const bundle = validBundle();
    bundle.roles[0]!.attempts[0]!.rejection = { path: "x", rule: "y", detail: "z" };
    expect(() => assertProviderProofBundle(bundle)).toThrow(/rejection/u);
  });
});
