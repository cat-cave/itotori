import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertBridgeBundle,
  assertBridgeBundleV02,
  assertDeltaPackageMetadataV02,
  assertPatchExport,
  assertPatchExportV02,
  assertPatchResultV02,
  assertRuntimeVerificationReport,
  evaluatePatchExportCompatibilityV02,
} from "../src/index.js";

const HASH_PATCH_EXPORT_V02_EXAMPLE =
  "sha256:8c8bd1092bba59430737fc36ec0ede41e36b8c94d7759a1313bcfc5aba94941a";
const HASH_BUNDLE_V02_EXAMPLE_TYPO =
  "sha256:530752517d6fe6af8505a362c5da79a034a16bb1c73b9c3b4c2e5bd5c2a2c060";
const HASH_UNIT_DIALOGUE_KNOWN =
  "sha256:fa01799c693dbf37732740572dde0106c2d67bed57a5955528687642896968e1";
const HASH_UNIT_DIALOGUE_KNOWN_TYPO =
  "sha256:ee738430dc6b47e520cbf9de9a54130e50671aa69dfd4d05bc447a9cbb980ea3";

function bridgeV02Example(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL("./examples/bridge-v0.2.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

function bridgeV02Units(bridge: Record<string, unknown>): Array<Record<string, unknown>> {
  return bridge.units as Array<Record<string, unknown>>;
}

function cloneRecord<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function patchExportV02Example(
  bridge: Record<string, unknown>,
  unitCount = 2,
): Record<string, unknown> {
  const units = bridgeV02Units(bridge).slice(0, unitCount);
  return {
    schemaVersion: "0.2.0",
    patchExportId: "019ed001-0000-7000-8000-000000000901",
    sourceBridgeId: bridge.bridgeId,
    sourceGame: cloneRecord(bridge.sourceGame),
    sourceBundleHash: bridge.sourceBundleHash,
    sourceBundleRevision: cloneRecord(bridge.sourceBundleRevision),
    sourceLocale: bridge.sourceLocale,
    targetLocale: "fr-FR",
    hashStrategy: cloneRecord(bridge.hashStrategy),
    patchExportHash: HASH_PATCH_EXPORT_V02_EXAMPLE,
    generatedAt: "2026-06-17T00:00:00.000Z",
    entries: units.map((unit, index) => ({
      entryId: `019ed001-0000-7000-8000-00000000091${index}`,
      bridgeUnitId: unit.bridgeUnitId,
      sourceUnitKey: unit.sourceUnitKey,
      sourceHash: unit.sourceHash,
      sourceRevision: cloneRecord(unit.sourceRevision),
      targetText: index === 0 ? "Bonjour, {player}." : "La porte s'ouvre.",
      protectedSpanMappings:
        index === 0 ? [{ raw: "{player}", targetStart: 9, targetEnd: 17 }] : [],
    })),
  };
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

  it.each([
    ["label placeholder", "sha256:unit-dialogue-known"],
    ["short digest", "sha256:abc123"],
    ["uppercase digest", "sha256:FA01799C693DBF37732740572DDE0106C2D67BED57A5955528687642896968E1"],
    ["missing prefix", "fa01799c693dbf37732740572dde0106c2d67bed57a5955528687642896968e1"],
  ])("rejects malformed v0.2 hashes: %s", (_label, malformedHash) => {
    const bridge = bridgeV02Example();
    bridge.sourceBundleHash = malformedHash;

    expect(() => assertBridgeBundleV02(bridge)).toThrow(/canonical sha256 hash string/);
  });

  it("rejects ambiguous v0.2 hash strategies without per-scope rules", () => {
    const bridge = bridgeV02Example();
    bridge.hashStrategy = {
      algorithm: "sha256",
      normalization: "utf8-nfc-lf-json-stable-v1",
      sourceProfileScope: "source_profile",
      sourceBundleScope: "source_bundle",
      sourceAssetScope: "source_asset",
      sourceUnitScope: "source_unit",
      unitHashFields: ["sourceText"],
    };

    expect(() => assertBridgeBundleV02(bridge)).toThrow(/hashStrategy\.sourceProfile/);
  });

  it("rejects v0.2 asset hash rules that do not use byte normalization", () => {
    const bridge = bridgeV02Example();
    const hashStrategy = asTestRecord(bridge.hashStrategy, "v0.2 hash strategy");
    const sourceAsset = asTestRecord(hashStrategy.sourceAsset, "v0.2 source asset hash rule");
    sourceAsset.normalization = "utf8-nfc-lf-json-stable-v1";

    expect(() => assertBridgeBundleV02(bridge)).toThrow(/hashStrategy\.sourceAsset\.normalization/);
  });

  it("rejects v0.2 unit hash rules without explicit source fields", () => {
    const bridge = bridgeV02Example();
    const hashStrategy = asTestRecord(bridge.hashStrategy, "v0.2 hash strategy");
    const sourceUnit = asTestRecord(hashStrategy.sourceUnit, "v0.2 source unit hash rule");
    sourceUnit.fields = [];

    expect(() => assertBridgeBundleV02(bridge)).toThrow(/hashStrategy\.sourceUnit\.fields/);
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

  it("accepts v0.2 patch exports with explicit source compatibility metadata", () => {
    const bridge = bridgeV02Example();
    const patchExport = patchExportV02Example(bridge);

    expect(() => assertPatchExportV02(patchExport)).not.toThrow();
  });

  it("rejects v0.2 patch exports without unit source revisions", () => {
    const bridge = bridgeV02Example();
    const patchExport = patchExportV02Example(bridge);
    const firstEntry = asTestRecord(
      (patchExport.entries as Array<Record<string, unknown>>)[0],
      "first v0.2 patch export entry",
    );
    delete firstEntry.sourceRevision;

    expect(() => assertPatchExportV02(patchExport)).toThrow(/sourceRevision/);
  });

  it("reports only affected units when a source typo changes one unit hash", () => {
    const bridge = bridgeV02Example();
    const patchExport = patchExportV02Example(bridge);
    const rerunBridge = cloneRecord(bridge);
    rerunBridge.sourceBundleHash = HASH_BUNDLE_V02_EXAMPLE_TYPO;
    const rerunBundleRevision = asTestRecord(
      rerunBridge.sourceBundleRevision,
      "rerun source bundle revision",
    );
    rerunBundleRevision.value = HASH_BUNDLE_V02_EXAMPLE_TYPO;
    const firstUnit = bridgeV02Units(rerunBridge)[0];
    expect(firstUnit).toBeDefined();
    firstUnit.sourceText = "Hello, {player}!";
    firstUnit.sourceHash = HASH_UNIT_DIALOGUE_KNOWN_TYPO;

    const report = evaluatePatchExportCompatibilityV02(patchExport, rerunBridge);

    expect(report.status).toBe("incompatible");
    expect(report.sourceBundleHashMatches).toBe(false);
    expect(report.incompatibleUnits).toEqual([
      expect.objectContaining({
        sourceUnitKey: "script/prologue#line-001",
        expectedSourceHash: HASH_UNIT_DIALOGUE_KNOWN,
        actualSourceHash: HASH_UNIT_DIALOGUE_KNOWN_TYPO,
        reason: "source_hash_mismatch",
      }),
    ]);
    expect(report.compatibleUnits).toHaveLength(1);

    expect(() =>
      assertPatchResultV02({
        schemaVersion: "0.2.0",
        patchResultId: "019ed001-0000-7000-8000-000000000950",
        patchExportId: patchExport.patchExportId,
        status: "incompatible_source",
        failures: [
          `source_hash_mismatch: script/prologue#line-001 expected ${HASH_UNIT_DIALOGUE_KNOWN} but found ${HASH_UNIT_DIALOGUE_KNOWN_TYPO}`,
        ],
        sourceCompatibility: report,
      }),
    ).not.toThrow();
  });

  it("reports all entries compatible when source unit hashes still match", () => {
    const bridge = bridgeV02Example();
    const patchExport = patchExportV02Example(bridge);

    const report = evaluatePatchExportCompatibilityV02(patchExport, bridge);

    expect(report.status).toBe("compatible");
    expect(report.sourceBundleHashMatches).toBe(true);
    expect(report.compatibleUnits).toHaveLength(2);
    expect(report.incompatibleUnits).toEqual([]);
  });

  it("reports a missing source unit without invalidating unrelated compatible units", () => {
    const bridge = bridgeV02Example();
    const patchExport = patchExportV02Example(bridge);
    const rerunBridge = cloneRecord(bridge);
    rerunBridge.units = bridgeV02Units(rerunBridge).slice(1);

    const report = evaluatePatchExportCompatibilityV02(patchExport, rerunBridge);

    expect(report.status).toBe("incompatible");
    expect(report.incompatibleUnits).toEqual([
      expect.objectContaining({
        sourceUnitKey: "script/prologue#line-001",
        reason: "missing_source_unit",
      }),
    ]);
    expect(report.compatibleUnits).toHaveLength(1);
  });

  it("reports duplicate source unit keys as incompatible", () => {
    const bridge = bridgeV02Example();
    const patchExport = patchExportV02Example(bridge, 1);
    const rerunBridge = cloneRecord(bridge);
    const units = bridgeV02Units(rerunBridge);
    expect(units[0]).toBeDefined();
    expect(units[1]).toBeDefined();
    units[1].sourceUnitKey = units[0].sourceUnitKey;
    const duplicatePatchRef = asTestRecord(units[1].patchRef, "duplicate source unit patch ref");
    duplicatePatchRef.sourceUnitKey = units[1].sourceUnitKey;

    const report = evaluatePatchExportCompatibilityV02(patchExport, rerunBridge);

    expect(report.status).toBe("incompatible");
    expect(report.incompatibleUnits).toEqual([
      expect.objectContaining({
        sourceUnitKey: "script/prologue#line-001",
        reason: "duplicate_source_unit_key",
      }),
    ]);
    expect(report.compatibleUnits).toEqual([]);
  });

  it("rejects incompatible patch results without source compatibility details", () => {
    const bridge = bridgeV02Example();
    const patchExport = patchExportV02Example(bridge);

    expect(() =>
      assertPatchResultV02({
        schemaVersion: "0.2.0",
        patchResultId: "019ed001-0000-7000-8000-000000000951",
        patchExportId: patchExport.patchExportId,
        status: "incompatible_source",
        failures: ["source_hash_mismatch"],
      }),
    ).toThrow(/sourceCompatibility is required/);
  });

  it("rejects patch results whose source compatibility targets a different patch export", () => {
    const bridge = bridgeV02Example();
    const patchExport = patchExportV02Example(bridge);
    const rerunBridge = cloneRecord(bridge);
    rerunBridge.sourceBundleHash = HASH_BUNDLE_V02_EXAMPLE_TYPO;
    const rerunBundleRevision = asTestRecord(
      rerunBridge.sourceBundleRevision,
      "rerun source bundle revision",
    );
    rerunBundleRevision.value = HASH_BUNDLE_V02_EXAMPLE_TYPO;
    const firstUnit = bridgeV02Units(rerunBridge)[0];
    expect(firstUnit).toBeDefined();
    firstUnit.sourceHash = HASH_UNIT_DIALOGUE_KNOWN_TYPO;
    const report = evaluatePatchExportCompatibilityV02(patchExport, rerunBridge);
    report.patchExportId = "019ed001-0000-7000-8000-000000000902";

    expect(() =>
      assertPatchResultV02({
        schemaVersion: "0.2.0",
        patchResultId: "019ed001-0000-7000-8000-000000000956",
        patchExportId: patchExport.patchExportId,
        status: "incompatible_source",
        failures: ["incompatible_source"],
        sourceCompatibility: report,
      }),
    ).toThrow(/sourceCompatibility\.patchExportId.*PatchResultV02\.patchExportId/);
  });

  it("rejects incompatible_source patch results with a compatible source report", () => {
    const bridge = bridgeV02Example();
    const patchExport = patchExportV02Example(bridge);
    const report = evaluatePatchExportCompatibilityV02(patchExport, bridge);

    expect(() =>
      assertPatchResultV02({
        schemaVersion: "0.2.0",
        patchResultId: "019ed001-0000-7000-8000-000000000957",
        patchExportId: patchExport.patchExportId,
        status: "incompatible_source",
        failures: ["incompatible_source"],
        sourceCompatibility: report,
      }),
    ).toThrow(/sourceCompatibility\.status must be incompatible/);
  });

  it("rejects non-incompatible_source patch results with an incompatible source report", () => {
    const bridge = bridgeV02Example();
    const patchExport = patchExportV02Example(bridge);
    const rerunBridge = cloneRecord(bridge);
    rerunBridge.sourceBundleHash = HASH_BUNDLE_V02_EXAMPLE_TYPO;
    const rerunBundleRevision = asTestRecord(
      rerunBridge.sourceBundleRevision,
      "rerun source bundle revision",
    );
    rerunBundleRevision.value = HASH_BUNDLE_V02_EXAMPLE_TYPO;
    const firstUnit = bridgeV02Units(rerunBridge)[0];
    expect(firstUnit).toBeDefined();
    firstUnit.sourceHash = HASH_UNIT_DIALOGUE_KNOWN_TYPO;
    const report = evaluatePatchExportCompatibilityV02(patchExport, rerunBridge);

    expect(() =>
      assertPatchResultV02({
        schemaVersion: "0.2.0",
        patchResultId: "019ed001-0000-7000-8000-000000000958",
        patchExportId: patchExport.patchExportId,
        status: "failed",
        failures: ["apply_failed"],
        sourceCompatibility: report,
      }),
    ).toThrow(/status must be incompatible_source/);
  });

  it("rejects inconsistent v0.2 compatibility reports", () => {
    const bridge = bridgeV02Example();
    const patchExport = patchExportV02Example(bridge);
    const report = evaluatePatchExportCompatibilityV02(patchExport, bridge);

    const incompatibleWithEmptyUnits = cloneRecord(report);
    incompatibleWithEmptyUnits.status = "incompatible";
    expect(() =>
      assertPatchResultV02({
        schemaVersion: "0.2.0",
        patchResultId: "019ed001-0000-7000-8000-000000000952",
        patchExportId: patchExport.patchExportId,
        status: "incompatible_source",
        failures: ["incompatible_source"],
        sourceCompatibility: incompatibleWithEmptyUnits,
      }),
    ).toThrow(/empty incompatibleUnits/);

    const incompatibleInCompatibleUnits = cloneRecord(report);
    const compatibleUnits = incompatibleInCompatibleUnits.compatibleUnits as Array<
      Record<string, unknown>
    >;
    compatibleUnits[0].status = "incompatible";
    compatibleUnits[0].reason = "source_hash_mismatch";
    expect(() =>
      assertPatchResultV02({
        schemaVersion: "0.2.0",
        patchResultId: "019ed001-0000-7000-8000-000000000953",
        patchExportId: patchExport.patchExportId,
        status: "incompatible_source",
        failures: ["incompatible_source"],
        sourceCompatibility: incompatibleInCompatibleUnits,
      }),
    ).toThrow(/compatibleUnits\[0\]\.status/);

    const compatibleWithReason = cloneRecord(report);
    const reasonUnits = compatibleWithReason.compatibleUnits as Array<Record<string, unknown>>;
    reasonUnits[0].reason = "source_hash_mismatch";
    expect(() =>
      assertPatchResultV02({
        schemaVersion: "0.2.0",
        patchResultId: "019ed001-0000-7000-8000-000000000954",
        patchExportId: patchExport.patchExportId,
        status: "incompatible_source",
        failures: ["incompatible_source"],
        sourceCompatibility: compatibleWithReason,
      }),
    ).toThrow(/reason is only valid/);

    const mismatchedBundleFlag = cloneRecord(report);
    mismatchedBundleFlag.sourceBundleHashMatches = false;
    expect(() =>
      assertPatchResultV02({
        schemaVersion: "0.2.0",
        patchResultId: "019ed001-0000-7000-8000-000000000955",
        patchExportId: patchExport.patchExportId,
        status: "incompatible_source",
        failures: ["incompatible_source"],
        sourceCompatibility: mismatchedBundleFlag,
      }),
    ).toThrow(/sourceBundleHashMatches/);
  });

  it("accepts v0.2 delta metadata that traces to a source revision and patch export", () => {
    const bridge = bridgeV02Example();
    const patchExport = patchExportV02Example(bridge);

    expect(() =>
      assertDeltaPackageMetadataV02({
        schemaVersion: "0.2.0",
        deltaPackageId: "019ed001-0000-7000-8000-000000000960",
        sourceBridgeId: bridge.bridgeId,
        sourceGame: bridge.sourceGame,
        sourceBundleHash: bridge.sourceBundleHash,
        sourceBundleRevision: bridge.sourceBundleRevision,
        generatedPatchExportId: patchExport.patchExportId,
        generatedPatchExportHash: patchExport.patchExportHash,
        targetLocale: patchExport.targetLocale,
        hashStrategy: bridge.hashStrategy,
        createdAt: "2026-06-17T00:00:00.000Z",
      }),
    ).not.toThrow();
  });

  it("rejects v0.2 delta metadata whose source bundle revision does not trace its hash", () => {
    const bridge = bridgeV02Example();
    const patchExport = patchExportV02Example(bridge);
    const sourceBundleRevision = cloneRecord(bridge.sourceBundleRevision) as Record<
      string,
      unknown
    >;
    sourceBundleRevision.value = HASH_BUNDLE_V02_EXAMPLE_TYPO;

    expect(() =>
      assertDeltaPackageMetadataV02({
        schemaVersion: "0.2.0",
        deltaPackageId: "019ed001-0000-7000-8000-000000000961",
        sourceBridgeId: bridge.bridgeId,
        sourceGame: bridge.sourceGame,
        sourceBundleHash: bridge.sourceBundleHash,
        sourceBundleRevision,
        generatedPatchExportId: patchExport.patchExportId,
        generatedPatchExportHash: patchExport.patchExportHash,
        targetLocale: patchExport.targetLocale,
        hashStrategy: bridge.hashStrategy,
      }),
    ).toThrow(/sourceBundleRevision\.value/);
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
