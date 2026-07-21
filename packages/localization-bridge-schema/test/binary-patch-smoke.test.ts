import { describe, expect, it } from "vitest";
import { assertPatchResultV02, computePatchResultOutputHashRollupV02 } from "../src/index.js";

/**
 * TS-side validator coverage for the v0.2 PatchResult emitted by the
 * composed binary patch smoke command. The Rust side
 * (`crates/kaifuu-cli/tests/binary_patch_smoke.rs`) covers the same
 * fixtures via `validate_patch_result_v02`; this test mirrors the
 * shape contract on the TypeScript validator so a future drift in
 * either validator surfaces against both.
 *
 * The fixtures used here are inline-constructed shapes (no on-disk
 * fixture files because the smoke command is meant to be reproducible
 * with no special inputs). The shapes mirror the Rust smoke's
 * `build_patch_result_v02` (for passed) and `build_patchback_failure_v02`
 * (for the apply_patches-time failure) outputs.
 */

const ASSET_ID = "019ed011-0000-7000-8000-000000000010";
const PATCH_EXPORT_ID = "019ed011-0000-7000-8000-000000000001";
const BRIDGE_UNIT_ID = "019ed011-0000-7000-8000-000000000020";
const FAILURE_ID = "deadbeef-0000-7000-8000-000000000001";
const PATCH_RESULT_ID = "0deadbef-0000-7000-8000-000000000002";

describe("binary-patch-smoke v0.2 contract surface", () => {
  it("accepts a passed result shape mirroring the smoke promote path", () => {
    const touchedAssets = [
      {
        assetId: ASSET_ID,
        outputHash: "sha256:0000000000000000000000000000000000000000000000000000000000000001",
        byteSize: 47,
      },
    ];
    const passed = {
      schemaVersion: "0.2.0",
      patchResultId: PATCH_RESULT_ID,
      patchExportId: PATCH_EXPORT_ID,
      adapterId: "kaifuu-reallive",
      status: "passed",
      touchedAssets,
      outputHash: computePatchResultOutputHashRollupV02(touchedAssets),
      failures: [],
    };
    expect(() => assertPatchResultV02(passed)).not.toThrow();
  });

  it("accepts a failed result shape mirroring the preflight-byte-budget failure", () => {
    const failed = {
      schemaVersion: "0.2.0",
      patchResultId: PATCH_RESULT_ID,
      patchExportId: PATCH_EXPORT_ID,
      adapterId: "kaifuu-reallive",
      status: "failed",
      failures: [
        {
          failureId: FAILURE_ID,
          category: "patch_write_failed",
          diagnosticCode: "kaifuu.patch_transaction.byte_budget_exceeded",
          cause: "synthetic byte budget rejection",
          assetId: ASSET_ID,
          bridgeUnitId: BRIDGE_UNIT_ID,
          adapterId: "kaifuu-reallive",
          command: "patch.write_string_slot",
        },
      ],
      failureCategories: ["patch_write_failed"],
      partialWrite: {
        disposition: "rolled_back",
        writtenAssetIds: [],
        attemptedAssetIds: [ASSET_ID],
        skippedAssetIds: [ASSET_ID],
        rollbackDiagnosticCode: "kaifuu.patch_transaction.preflight_failed",
      },
    };
    expect(() => assertPatchResultV02(failed)).not.toThrow();
  });

  it("accepts a failed result shape mirroring the verify-hash-mismatch rollback", () => {
    const failed = {
      schemaVersion: "0.2.0",
      patchResultId: PATCH_RESULT_ID,
      patchExportId: PATCH_EXPORT_ID,
      adapterId: "kaifuu-reallive",
      status: "failed",
      failures: [
        {
          failureId: FAILURE_ID,
          category: "output_hash_mismatch",
          diagnosticCode: "kaifuu.patch_result.output_hash_drift",
          cause: "expected/observed sha256 differ at verify time",
          assetId: ASSET_ID,
          bridgeUnitId: BRIDGE_UNIT_ID,
          adapterId: "kaifuu-reallive",
          command: "patch.write_string_slot",
        },
      ],
      failureCategories: ["output_hash_mismatch"],
      partialWrite: {
        disposition: "rolled_back",
        writtenAssetIds: [],
        attemptedAssetIds: [ASSET_ID],
        skippedAssetIds: [ASSET_ID],
        rollbackDiagnosticCode: "kaifuu.patch_transaction.staged_verify_rolled_back",
      },
    };
    expect(() => assertPatchResultV02(failed)).not.toThrow();
  });

  it("accepts a failed result shape mirroring the apply_patches-time PatchBackError fallback", () => {
    const failed = {
      schemaVersion: "0.2.0",
      patchResultId: PATCH_RESULT_ID,
      patchExportId: PATCH_EXPORT_ID,
      adapterId: "kaifuu-reallive",
      status: "failed",
      failures: [
        {
          failureId: FAILURE_ID,
          category: "source_incompatible",
          diagnosticCode: "kaifuu.reallive.patchback_stale_source_hash",
          cause: "expected source hash mismatch from PatchBackError",
          assetId: ASSET_ID,
          bridgeUnitId: BRIDGE_UNIT_ID,
          adapterId: "kaifuu-reallive",
          command: "patch.write_string_slot",
        },
      ],
      failureCategories: ["source_incompatible"],
      partialWrite: {
        disposition: "rolled_back",
        writtenAssetIds: [],
        attemptedAssetIds: [ASSET_ID],
        skippedAssetIds: [ASSET_ID],
        rollbackDiagnosticCode: "kaifuu.reallive.patchback_rolled_back",
      },
    };
    expect(() => assertPatchResultV02(failed)).not.toThrow();
  });

  it("rejects a failed result with no failures (cross-validator parity)", () => {
    const broken = {
      schemaVersion: "0.2.0",
      patchResultId: PATCH_RESULT_ID,
      patchExportId: PATCH_EXPORT_ID,
      adapterId: "kaifuu-reallive",
      status: "failed",
      failures: [],
      failureCategories: [],
      partialWrite: {
        disposition: "rolled_back",
        writtenAssetIds: [],
        attemptedAssetIds: [ASSET_ID],
        skippedAssetIds: [ASSET_ID],
        rollbackDiagnosticCode: "kaifuu.patch_transaction.cancelled",
      },
    };
    expect(() => assertPatchResultV02(broken)).toThrow();
  });
});
