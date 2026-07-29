import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  assertDeltaPackageMetadataV02,
  assertFindingRecordFixtureV02,
  assertPatchResultV02,
  assertPermissionLocalUserFixtureV02,
  assertTriageBundleV02,
  computePatchResultOutputHashRollupV02,
  evaluatePatchExportCompatibilityV02,
} from "../src/index.js";
import {
  HASH_BUNDLE_V02_EXAMPLE_TYPO,
  bridgeV02Example,
  triageV02Example,
  findingFixtureV02Example,
  sourceIncompatibleFailureFixture,
  permissionLocalUserFixtureV02Example,
  publicFixture,
  cloneRecord,
  patchExportV02Example,
  asTestRecord,
} from "./schema-test-helpers.js";

describe("localization bridge schema guards", () => {
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
        adapterId: "kaifuu-reallive",
        status: "incompatible_source",
        failures: [sourceIncompatibleFailureFixture()],
        failureCategories: ["source_incompatible"],
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
        adapterId: "kaifuu-reallive",
        status: "incompatible_source",
        failures: [sourceIncompatibleFailureFixture()],
        failureCategories: ["source_incompatible"],
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
        adapterId: "kaifuu-reallive",
        status: "incompatible_source",
        failures: [sourceIncompatibleFailureFixture()],
        failureCategories: ["source_incompatible"],
        sourceCompatibility: compatibleWithReason,
      }),
    ).toThrow(/reason is only valid/);

    const bridgeUnitMismatchWithoutActual = cloneRecord(report);
    bridgeUnitMismatchWithoutActual.status = "incompatible";
    const mismatchCompatibleUnits = bridgeUnitMismatchWithoutActual.compatibleUnits as Array<
      Record<string, unknown>
    >;
    const mismatchUnit = asTestRecord(
      mismatchCompatibleUnits.shift(),
      "bridge unit mismatch compatibility unit",
    );
    mismatchUnit.status = "incompatible";
    mismatchUnit.reason = "bridge_unit_id_mismatch";
    bridgeUnitMismatchWithoutActual.incompatibleUnits = [mismatchUnit];
    expect(() =>
      assertPatchResultV02({
        schemaVersion: "0.2.0",
        patchResultId: "019ed001-0000-7000-8000-000000000959",
        patchExportId: patchExport.patchExportId,
        adapterId: "kaifuu-reallive",
        status: "incompatible_source",
        failures: [sourceIncompatibleFailureFixture()],
        failureCategories: ["source_incompatible"],
        sourceCompatibility: bridgeUnitMismatchWithoutActual,
      }),
    ).toThrow(/actualBridgeUnitId is required/);

    const mismatchedBundleFlag = cloneRecord(report);
    mismatchedBundleFlag.sourceBundleHashMatches = false;
    expect(() =>
      assertPatchResultV02({
        schemaVersion: "0.2.0",
        patchResultId: "019ed001-0000-7000-8000-000000000955",
        patchExportId: patchExport.patchExportId,
        adapterId: "kaifuu-reallive",
        status: "incompatible_source",
        failures: [sourceIncompatibleFailureFixture()],
        failureCategories: ["source_incompatible"],
        sourceCompatibility: mismatchedBundleFlag,
      }),
    ).toThrow(/sourceBundleHashMatches/);
  });

  describe("PatchResultV02 v0.2 structured failures and partial-write accounting", () => {
    function invalidPatchResultFixture(name: string): Record<string, unknown> {
      return JSON.parse(
        readFileSync(new URL(`./examples/invalid/${name}`, import.meta.url), "utf8"),
      ) as Record<string, unknown>;
    }

    function helloGamePatchResultFixture(): Record<string, unknown> {
      return publicFixture("fixtures/hello-game/expected/patch-result-v0.2.fr-FR.json");
    }

    it("accepts the hello-game v0.2 patch result fixture with touched assets and rollup outputHash", () => {
      expect(() => assertPatchResultV02(helloGamePatchResultFixture())).not.toThrow();
    });

    it("rejects patch-result-v0.2-missing-failure-category fixture with the documented semantic code", () => {
      expect(() =>
        assertPatchResultV02(
          invalidPatchResultFixture("patch-result-v0.2-missing-failure-category.json"),
        ),
      ).toThrow(/kaifuu\.patch_result\.missing_failure_category/);
    });

    it("rejects patch-result-v0.2-output-hash-mismatch fixture with output_hash_drift", () => {
      expect(() =>
        assertPatchResultV02(
          invalidPatchResultFixture("patch-result-v0.2-output-hash-mismatch.json"),
        ),
      ).toThrow(/kaifuu\.patch_result\.output_hash_drift/);
    });

    it("rejects patch-result-v0.2-partial-write fixture with silent_partial_write", () => {
      expect(() =>
        assertPatchResultV02(invalidPatchResultFixture("patch-result-v0.2-partial-write.json")),
      ).toThrow(/kaifuu\.patch_result\.silent_partial_write/);
    });

    it("requires outputHash when status is passed", () => {
      const result = helloGamePatchResultFixture();
      delete result.outputHash;
      expect(() => assertPatchResultV02(result)).toThrow(
        /kaifuu\.patch_result\.passed_requires_output_hash/,
      );
    });

    it("requires touchedAssets when status is passed", () => {
      const result = helloGamePatchResultFixture();
      delete result.touchedAssets;
      expect(() => assertPatchResultV02(result)).toThrow(
        /kaifuu\.patch_result\.passed_requires_touched_assets/,
      );
    });

    it("rejects incompatible_source results with a non-source_incompatible failure", () => {
      const base = invalidPatchResultFixture("patch-result-v0.2-incompatible-status.json");
      const result = {
        ...base,
        status: "incompatible_source",
        failures: [
          {
            failureId: "019ed001-0000-7000-8000-00000000fa11",
            category: "patch_write_failed",
            diagnosticCode: "kaifuu.reallive.patchback_offset_overflow",
            cause: "wrong category for incompatible_source",
            assetId: "019ed001-0000-7000-8000-000000000800",
            bridgeUnitId: "019ed001-0000-7000-8000-000000000201",
            adapterId: "kaifuu-reallive",
            command: "patch.write_string_slot",
          },
        ],
        failureCategories: ["patch_write_failed"],
      };
      expect(() => assertPatchResultV02(result)).toThrow(
        /kaifuu\.patch_result\.incompatible_source_category_required/,
      );
    });

    it("rejects partialWrite without rollbackDiagnosticCode for non-retained dispositions", () => {
      const result = {
        schemaVersion: "0.2.0",
        patchResultId: "019ed001-0000-7000-8000-00000000fb01",
        patchExportId: "019ed001-0000-7000-8000-000000000901",
        adapterId: "kaifuu-reallive",
        status: "failed",
        failures: [
          {
            failureId: "019ed001-0000-7000-8000-00000000fb11",
            category: "patch_write_failed",
            diagnosticCode: "kaifuu.reallive.patchback_offset_overflow",
            cause: "offset overflow",
            assetId: "019ed001-0000-7000-8000-000000000810",
            bridgeUnitId: "019ed001-0000-7000-8000-000000000201",
            adapterId: "kaifuu-reallive",
            command: "patch.write_string_slot",
          },
        ],
        failureCategories: ["patch_write_failed"],
        partialWrite: {
          attemptedAssetIds: ["019ed001-0000-7000-8000-000000000810"],
          writtenAssetIds: [],
          skippedAssetIds: ["019ed001-0000-7000-8000-000000000810"],
          disposition: "rolled_back",
        },
      };
      expect(() => assertPatchResultV02(result)).toThrow(
        /kaifuu\.patch_result\.rollback_diagnostic_required/,
      );
    });

    it("accepts a partialWrite report with retained_partial disposition and no rollback diagnostic", () => {
      const result = {
        schemaVersion: "0.2.0",
        patchResultId: "019ed001-0000-7000-8000-00000000fb02",
        patchExportId: "019ed001-0000-7000-8000-000000000901",
        adapterId: "kaifuu-reallive",
        status: "failed",
        failures: [
          {
            failureId: "019ed001-0000-7000-8000-00000000fb22",
            category: "patch_write_failed",
            diagnosticCode: "kaifuu.reallive.patchback_offset_overflow",
            cause: "mid-write corruption could not be rolled back",
            assetId: "019ed001-0000-7000-8000-000000000810",
            bridgeUnitId: "019ed001-0000-7000-8000-000000000201",
            adapterId: "kaifuu-reallive",
            command: "patch.write_string_slot",
          },
        ],
        failureCategories: ["patch_write_failed"],
        partialWrite: {
          attemptedAssetIds: ["019ed001-0000-7000-8000-000000000810"],
          writtenAssetIds: ["019ed001-0000-7000-8000-000000000810"],
          skippedAssetIds: [],
          disposition: "retained_partial",
        },
      };
      expect(() => assertPatchResultV02(result)).not.toThrow();
    });

    it("rejects failureCategories that include an unobserved category", () => {
      const result = invalidPatchResultFixture("patch-result-v0.2-missing-failure-category.json");
      result.failureCategories = ["patch_write_failed", "adapter_unsupported"];
      expect(() => assertPatchResultV02(result)).toThrow(
        /kaifuu\.patch_result\.unknown_failure_category/,
      );
    });

    it("computes the rollup hash deterministically over sorted touched assets", () => {
      const assets = [
        {
          assetId: "019ed001-0000-7000-8000-0000000000aa",
          outputHash: "sha256:aa".padEnd(71, "a"),
          byteSize: 4,
        },
        {
          assetId: "019ed001-0000-7000-8000-0000000000ab",
          outputHash: "sha256:bb".padEnd(71, "b"),
          byteSize: 4,
        },
      ];
      const first = computePatchResultOutputHashRollupV02(assets);
      const second = computePatchResultOutputHashRollupV02([assets[1]!, assets[0]!]);
      expect(first).toBe(second);
      expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
    });
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

  it("accepts the v0.2 triage event and finding taxonomy example", () => {
    const triage = triageV02Example();

    expect(() => assertTriageBundleV02(triage)).not.toThrow();

    const findings = triage.findings as Array<{
      severity: string;
      qualityCategory?: string;
      provenance: Array<{ provenanceKind: string }>;
    }>;
    const provenanceKinds = new Set(
      findings.flatMap((finding) =>
        finding.provenance.map((provenance) => provenance.provenanceKind),
      ),
    );
    expect(provenanceKinds).toEqual(
      new Set(["source_annotation", "style_guide", "model_output", "patching_cause"]),
    );
    expect(findings.map((finding) => finding.severity)).toContain("P0");
    expect(findings.map((finding) => finding.qualityCategory)).toContain("style");
    expect(findings.some((finding) => finding.severity === finding.qualityCategory)).toBe(false);
  });

  it("accepts the standalone v0.2 finding and local-user permission fixtures", () => {
    const finding = findingFixtureV02Example();
    const permission = permissionLocalUserFixtureV02Example();

    expect(() => assertFindingRecordFixtureV02(finding)).not.toThrow();
    expect(() => assertPermissionLocalUserFixtureV02(permission)).not.toThrow();
    expect(permission.grants).toContain("feedback.import");
  });

  it("rejects triage findings that use confidence instead of evidence", () => {
    const triage = triageV02Example();
    const findings = triage.findings as Array<Record<string, unknown>>;
    const firstFinding = asTestRecord(findings[0], "first v0.2 finding");
    firstFinding.confidence = 0.9;

    expect(() => assertTriageBundleV02(triage)).toThrow(/confidence/i);
  });

  it("rejects triage findings without provenance", () => {
    const triage = triageV02Example();
    const findings = triage.findings as Array<Record<string, unknown>>;
    const firstFinding = asTestRecord(findings[0], "first v0.2 finding");
    firstFinding.provenance = [];

    expect(() => assertTriageBundleV02(triage)).toThrow(/provenance.*at least one/);
  });

  it("rejects mutable status buckets in append-only triage events", () => {
    const triage = triageV02Example();
    const events = triage.events as Array<Record<string, unknown>>;
    const firstEvent = asTestRecord(events[0], "first v0.2 triage event");
    firstEvent.payload = { status: "closed" };

    expect(() => assertTriageBundleV02(triage)).toThrow(/append-only events/);
  });

  it("rejects triage events that causally link to future events", () => {
    const triage = triageV02Example();
    const events = triage.events as Array<{ causalLinks: Array<Record<string, unknown>> }>;
    const firstEvent = events[0];
    expect(firstEvent).toBeDefined();
    firstEvent.causalLinks = [
      {
        causalLinkId: "019ed002-0000-7000-8000-0000000007ff",
        linkKind: "caused_by",
        targetKind: "event",
        targetId: "019ed002-0000-7000-8000-000000000102",
      },
    ];

    expect(() => assertTriageBundleV02(triage)).toThrow(/prior event/);
  });
});
