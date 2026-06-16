import { describe, expect, it } from "vitest";
import { assertBridgeBundle, assertPatchExport, assertRuntimeVerificationReport } from "../src/index.js";

describe("localization bridge schema guards", () => {
  it("accepts minimal valid bridge bundles", () => {
    expect(() =>
      assertBridgeBundle({
        schemaVersion: "0.1.0",
        bridgeId: "019ed000-0000-7000-8000-000000000001",
        sourceBundleHash: "hash",
        sourceLocale: "ja-JP",
        extractorName: "kaifuu-fixture",
        extractorVersion: "0.0.0",
        units: [],
      }),
    ).not.toThrow();
  });

  it("rejects invalid patch exports", () => {
    expect(() => assertPatchExport({ schemaVersion: "0.1.0" })).toThrow();
  });

  it("accepts runtime reports", () => {
    expect(() =>
      assertRuntimeVerificationReport({
        schemaVersion: "0.1.0",
        runtimeReportId: "019ed000-0000-7000-8000-000000000002",
        adapterName: "utsushi-fixture",
        fidelityTier: "layout_probe",
        status: "passed",
        textEvents: [],
        frameCaptures: [],
        approximations: [],
      }),
    ).not.toThrow();
  });
});
