import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertBridgeBundle,
  assertBridgeBundleV02,
  assertPatchExport,
  assertRuntimeVerificationReport,
} from "../src/index.js";

function bridgeV02Example(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL("./examples/bridge-v0.2.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

function bridgeV02Units(bridge: Record<string, unknown>): Array<Record<string, unknown>> {
  return bridge.units as Array<Record<string, unknown>>;
}

function asTestRecord(value: unknown, label: string): Record<string, unknown> {
  expect(value, label).toBeDefined();
  return value as Record<string, unknown>;
}

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

  it("accepts the v0.2 bridge surface example", () => {
    const bridge = bridgeV02Example();

    expect(() => assertBridgeBundleV02(bridge)).not.toThrow();

    const units = bridge.units as Array<{ speaker?: { knowledgeState?: string } }>;
    const speakerStates = units.map((unit) => unit.speaker?.knowledgeState).filter(Boolean);
    expect(speakerStates).toContain("parser_unknown");
    expect(speakerStates).toContain("reader_unknown");
  });

  it("rejects v0.2 bridge ids that are not UUID7", () => {
    const bridge = bridgeV02Example();
    bridge.bridgeId = "not-a-uuid";

    expect(() => assertBridgeBundleV02(bridge)).toThrow(/UUID7/);
  });

  it("rejects raw or unknown v0.2 category values", () => {
    const bridge = bridgeV02Example();
    const units = bridgeV02Units(bridge);
    const firstUnit = units[0];
    expect(firstUnit).toBeDefined();
    firstUnit.surfaceKind = "dialogue_line";

    expect(() => assertBridgeBundleV02(bridge)).toThrow(/surfaceKind/);
  });

  it("rejects v0.1-style raw speaker strings in v0.2 units", () => {
    const bridge = bridgeV02Example();
    const units = bridgeV02Units(bridge);
    const firstUnit = units[0];
    expect(firstUnit).toBeDefined();
    firstUnit.speaker = "Mira";

    expect(() => assertBridgeBundleV02(bridge)).toThrow(/speaker must be an object/);
  });

  it("rejects conflated unknown speaker state in v0.2 units", () => {
    const bridge = bridgeV02Example();
    const units = bridgeV02Units(bridge);
    const firstUnit = units[0];
    expect(firstUnit).toBeDefined();
    firstUnit.speaker = { knowledgeState: "unknown" };

    expect(() => assertBridgeBundleV02(bridge)).toThrow(/knowledgeState/);
  });

  it("rejects v0.2 protected spans whose byte ranges do not match source text", () => {
    const bridge = bridgeV02Example();
    const units = bridge.units as Array<{ spans: Array<Record<string, unknown>> }>;
    const firstSpan = units[0]?.spans[0];
    expect(firstSpan).toBeDefined();
    firstSpan.startByte = 0;

    expect(() => assertBridgeBundleV02(bridge)).toThrow(/byte range/);
  });

  it("rejects dangling v0.2 source asset references", () => {
    const bridge = bridgeV02Example();
    const firstUnit = asTestRecord(bridgeV02Units(bridge)[0], "first v0.2 unit");
    const sourceAssetRef = asTestRecord(firstUnit.sourceAssetRef, "first v0.2 source asset ref");
    sourceAssetRef.assetId = "019ed001-0000-7000-8000-00000000ffff";

    expect(() => assertBridgeBundleV02(bridge)).toThrow(/sourceAssetRef\.assetId/);
  });

  it("rejects dangling v0.2 patch asset references", () => {
    const bridge = bridgeV02Example();
    const firstUnit = asTestRecord(bridgeV02Units(bridge)[0], "first v0.2 unit");
    const patchRef = asTestRecord(firstUnit.patchRef, "first v0.2 patch ref");
    patchRef.assetId = "019ed001-0000-7000-8000-00000000ffff";

    expect(() => assertBridgeBundleV02(bridge)).toThrow(/patchRef\.assetId/);
  });

  it("rejects dangling v0.2 song audio asset references", () => {
    const bridge = bridgeV02Example();
    const songUnit = bridgeV02Units(bridge).find((unit) => {
      const context = asTestRecord(unit.context, "v0.2 unit context");
      return context.song !== undefined;
    });
    expect(songUnit).toBeDefined();
    const context = asTestRecord(songUnit?.context, "v0.2 song unit context");
    const song = asTestRecord(context.song, "v0.2 song context");
    const audioAssetRef = asTestRecord(song.audioAssetRef, "v0.2 song audio asset ref");
    audioAssetRef.assetId = "019ed001-0000-7000-8000-00000000ffff";

    expect(() => assertBridgeBundleV02(bridge)).toThrow(/song\.audioAssetRef\.assetId/);
  });

  it("rejects unknown v0.2 policy scopes", () => {
    const bridge = bridgeV02Example();
    const policyRecords = bridge.policyRecords as Array<Record<string, unknown>>;
    const firstPolicyRecord = asTestRecord(policyRecords[0], "first v0.2 policy record");
    firstPolicyRecord.scope = "global";

    expect(() => assertBridgeBundleV02(bridge)).toThrow(/policyRecords\[0\]\.scope/);
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
