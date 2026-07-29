import { describe, expect, it } from "vitest";
import {
  assertDeltaPackageMetadataV02,
  assertPatchExportV02,
  assertPatchResultV02,
  evaluatePatchExportCompatibilityV02,
} from "../src/index.js";
import {
  HASH_BUNDLE_V02_EXAMPLE_TYPO,
  HASH_UNIT_DIALOGUE_KNOWN,
  HASH_UNIT_DIALOGUE_KNOWN_TYPO,
  bridgeV02Example,
  patchExportFixtureV02Example,
  patchResultFixtureV02Example,
  deltaPackageFixtureV02Example,
  sourceIncompatibleFailureFixture,
  bridgeV02Units,
  cloneRecord,
  patchExportV02Example,
  asTestRecord,
} from "./schema-test-helpers.js";

describe("localization bridge schema guards", () => {
  it("accepts the committed v0.2 patch export, patch result, and delta metadata fixtures", () => {
    expect(() => assertPatchExportV02(patchExportFixtureV02Example())).not.toThrow();
    expect(() => assertPatchResultV02(patchResultFixtureV02Example())).not.toThrow();
    expect(() => assertDeltaPackageMetadataV02(deltaPackageFixtureV02Example())).not.toThrow();
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
        adapterId: "kaifuu-reallive",
        status: "incompatible_source",
        failures: [
          sourceIncompatibleFailureFixture({
            cause: `source_hash_mismatch: script/prologue#line-001 expected ${HASH_UNIT_DIALOGUE_KNOWN} but found ${HASH_UNIT_DIALOGUE_KNOWN_TYPO}`,
          }),
        ],
        failureCategories: ["source_incompatible"],
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

  it("reports a bridge unit id mismatch as incompatible even when source keys and hashes match", () => {
    const bridge = bridgeV02Example();
    const patchExport = patchExportV02Example(bridge);
    const units = bridgeV02Units(bridge);
    const firstUnit = asTestRecord(units[0], "first v0.2 unit");
    const secondUnit = asTestRecord(units[1], "second v0.2 unit");
    const entries = patchExport.entries as Array<Record<string, unknown>>;
    const firstEntry = asTestRecord(entries[0], "first v0.2 patch export entry");
    firstEntry.bridgeUnitId = secondUnit.bridgeUnitId;

    const report = evaluatePatchExportCompatibilityV02(patchExport, bridge);

    expect(report.status).toBe("incompatible");
    expect(report.sourceBundleHashMatches).toBe(true);
    expect(report.incompatibleUnits).toEqual([
      expect.objectContaining({
        bridgeUnitId: secondUnit.bridgeUnitId,
        actualBridgeUnitId: firstUnit.bridgeUnitId,
        sourceUnitKey: firstUnit.sourceUnitKey,
        expectedSourceHash: firstUnit.sourceHash,
        actualSourceHash: firstUnit.sourceHash,
        reason: "bridge_unit_id_mismatch",
      }),
    ]);
    expect(report.compatibleUnits).toEqual([
      expect.objectContaining({
        bridgeUnitId: secondUnit.bridgeUnitId,
        sourceUnitKey: secondUnit.sourceUnitKey,
        status: "compatible",
      }),
    ]);
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
        adapterId: "kaifuu-reallive",
        status: "incompatible_source",
        failures: [sourceIncompatibleFailureFixture()],
        failureCategories: ["source_incompatible"],
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
        adapterId: "kaifuu-reallive",
        status: "incompatible_source",
        failures: [sourceIncompatibleFailureFixture()],
        failureCategories: ["source_incompatible"],
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
        adapterId: "kaifuu-reallive",
        status: "incompatible_source",
        failures: [sourceIncompatibleFailureFixture()],
        failureCategories: ["source_incompatible"],
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
        adapterId: "kaifuu-reallive",
        status: "failed",
        failures: [
          {
            failureId: "019ed001-0000-7000-8000-00000000fa58",
            category: "patch_write_failed",
            diagnosticCode: "kaifuu.reallive.patchback_offset_overflow",
            cause: "apply_failed: offset would overflow during write",
            assetId: "019ed001-0000-7000-8000-000000000800",
            bridgeUnitId: "019ed001-0000-7000-8000-000000000201",
            adapterId: "kaifuu-reallive",
            command: "patch.write_string_slot",
          },
        ],
        failureCategories: ["patch_write_failed"],
        sourceCompatibility: report,
      }),
    ).toThrow(/status must be incompatible_source/);
  });
});
