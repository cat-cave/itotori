import { describe, expect, it } from "vitest";
import {
  adapterMatrixSupports,
  adapterMatrixSupportsAtLeast,
  assertAdapterCapabilityMatrixV02,
  assertCapabilityLevelStatusV02,
  assertPatchExport,
  assertRuntimeEvidenceReportV02,
  assertRuntimeVerificationReport,
} from "../src/index.js";
import type { AdapterCapabilityMatrixV02 } from "../src/index.js";
import {
  runtimeEvidenceV02Example,
  traceOnlyReferenceFidelityReport,
  asTestRecord,
} from "./schema-test-helpers.js";

describe("localization bridge schema guards", () => {
  it("rejects v0.2 runtime captures without bridge-unit traceability", () => {
    const report = runtimeEvidenceV02Example();
    const captures = report.captures as Array<Record<string, unknown>>;
    const firstCapture = asTestRecord(captures[0], "first runtime capture");
    delete firstCapture.bridgeUnitRef;

    expect(() => assertRuntimeEvidenceReportV02(report)).toThrow(/bridgeUnitRef/);
  });

  it.each([
    ["embedded data URI", "data:image/png;base64,AAAA"],
    ["URI scheme", "https://example.invalid/capture.png"],
    ["absolute POSIX path", "/tmp/runtime/frame.png"],
    ["current-directory dot segment", "./capture.png"],
    ["parent-directory dot segment", "../capture.png"],
    ["nested parent-directory dot segment", "artifacts/utsushi/../capture.png"],
    ["Windows path", "C:\\runtime\\frame.png"],
  ])("rejects non-portable v0.2 runtime screenshot references: %s", (_label, uri) => {
    const report = runtimeEvidenceV02Example();
    const captures = report.captures as Array<Record<string, unknown>>;
    const firstCapture = asTestRecord(captures[0], "first runtime capture");
    const artifactRef = asTestRecord(firstCapture.artifactRef, "first capture artifact ref");
    artifactRef.uri = uri;

    expect(() => assertRuntimeEvidenceReportV02(report)).toThrow(/reference an artifact|portable/);
  });

  it("rejects v0.2 runtime branch points whose selected option is not listed", () => {
    const report = runtimeEvidenceV02Example();
    const branchEvents = report.branchEvents as Array<Record<string, unknown>>;
    const firstBranchEvent = asTestRecord(branchEvents[0], "first branch event");
    firstBranchEvent.selectedOptionId = "019ed003-0000-7000-8000-00000000ffff";

    expect(() => assertRuntimeEvidenceReportV02(report)).toThrow(/selectedOptionId/);
  });

  it("accepts a runtime evidence report referencing a conformance fixture via the existing reference comparison kind", () => {
    // The Rust-side ConformanceManifest/Result contract exists; this smoke
    // test proves the existing bridge schema already accommodates
    // conformance reports through the
    // `conformance_fixture` reference comparison kind without any
    // schema change.
    const report = traceOnlyReferenceFidelityReport();
    report.referenceComparisons = [
      {
        comparisonId: "019ed003-0000-7000-8000-00000000e441",
        comparisonKind: "conformance_fixture",
        status: "passed",
        scope: "utsushi-synthetic text-trace profile",
        coveredBridgeUnitRefs: [
          {
            bridgeUnitId: "019ed001-0000-7000-8000-000000000201",
            sourceUnitKey: "script/prologue#line-001",
          },
        ],
        artifactRef: {
          artifactId: "019ed003-0000-7000-8000-00000000e451",
          artifactKind: "reference_comparison",
          uri: "artifacts/utsushi/runtime/synthetic-run/conformance-reports/text-trace-pass.json",
          hash: "sha256:9f19ff8b1b206d23c4df42dc35913c9fdb14d5ec4a85139d368c39942c197f51",
          mediaType: "application/json",
          byteSize: 2048,
        },
      },
    ];

    expect(() => assertRuntimeEvidenceReportV02(report)).not.toThrow();
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

  // Capability ladder coverage. Mirrors the Rust round-trip and strict-gate
  // tests in `crates/kaifuu-core/src/registry/capability.rs`.
  it("accepts capability matrices that exercise supported / partial / unsupported branches", () => {
    const matrix: AdapterCapabilityMatrixV02 = {
      adapterId: "kaifuu.example",
      identify: { kind: "supported" },
      inventory: { kind: "partial", limitations: ["incomplete index"] },
      extract: { kind: "partial", limitations: ["only some surfaces"] },
      patch: { kind: "unsupported", reason: "no patch path yet" },
    };
    expect(() => assertAdapterCapabilityMatrixV02(matrix)).not.toThrow();
    // Strict gate: Partial does NOT count as Supported.
    expect(adapterMatrixSupports(matrix, "identify")).toBe(true);
    expect(adapterMatrixSupports(matrix, "inventory")).toBe(false);
    expect(adapterMatrixSupports(matrix, "extract")).toBe(false);
    expect(adapterMatrixSupports(matrix, "patch")).toBe(false);
    expect(adapterMatrixSupportsAtLeast(matrix, "identify")).toBe(true);
    expect(adapterMatrixSupportsAtLeast(matrix, "inventory")).toBe(false);
  });

  it("rejects supported status carrying a reason or limitations", () => {
    expect(() =>
      assertCapabilityLevelStatusV02(
        { kind: "supported", reason: "should not appear" },
        "CapabilityLevelStatusV02",
      ),
    ).toThrow();
    expect(() =>
      assertCapabilityLevelStatusV02(
        { kind: "supported", limitations: ["should not appear"] },
        "CapabilityLevelStatusV02",
      ),
    ).toThrow();
  });

  it("rejects partial status without limitations or with empty list", () => {
    expect(() =>
      assertCapabilityLevelStatusV02({ kind: "partial" }, "CapabilityLevelStatusV02"),
    ).toThrow();
    expect(() =>
      assertCapabilityLevelStatusV02(
        { kind: "partial", limitations: [] },
        "CapabilityLevelStatusV02",
      ),
    ).toThrow();
  });

  it("rejects unsupported status without a reason", () => {
    expect(() =>
      assertCapabilityLevelStatusV02({ kind: "unsupported" }, "CapabilityLevelStatusV02"),
    ).toThrow();
    expect(() =>
      assertCapabilityLevelStatusV02(
        { kind: "unsupported", reason: "" },
        "CapabilityLevelStatusV02",
      ),
    ).toThrow();
  });

  it("identify-only matrix gates higher rungs for itotori consumers", () => {
    const matrix: AdapterCapabilityMatrixV02 = {
      adapterId: "kaifuu.identify_only",
      identify: { kind: "supported" },
      inventory: { kind: "unsupported", reason: "detector-only fixture" },
      extract: { kind: "unsupported", reason: "detector-only fixture" },
      patch: { kind: "unsupported", reason: "detector-only fixture" },
    };
    expect(() => assertAdapterCapabilityMatrixV02(matrix)).not.toThrow();
    expect(adapterMatrixSupports(matrix, "identify")).toBe(true);
    expect(adapterMatrixSupports(matrix, "extract")).toBe(false);
    expect(adapterMatrixSupports(matrix, "patch")).toBe(false);
  });
});
