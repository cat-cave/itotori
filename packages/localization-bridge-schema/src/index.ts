export type Uuid7 = string;
export type Bcp47Locale = string;

export type TextSurface = "dialogue" | "system";
export type ProtectedSpanKind = "placeholder";
export type PreserveMode = "exact";
export type PatchWriteMode = "replace";
export type RuntimeFidelityTier = "trace_only" | "layout_probe";

export type ProtectedSpan = {
  kind: ProtectedSpanKind;
  raw: string;
  start: number;
  end: number;
  preserveMode: PreserveMode;
};

export type BridgeUnit = {
  bridgeUnitId: Uuid7;
  sourceUnitKey: string;
  occurrenceId: string;
  sourceHash: string;
  sourceLocale: Bcp47Locale;
  sourceText: string;
  speaker?: string;
  textSurface: TextSurface;
  protectedSpans: ProtectedSpan[];
  patchRef: {
    assetId: string;
    writeMode: PatchWriteMode;
    sourceUnitKey: string;
  };
};

export type BridgeBundle = {
  schemaVersion: "0.1.0";
  bridgeId: Uuid7;
  sourceBundleHash: string;
  sourceLocale: Bcp47Locale;
  extractorName: "kaifuu-fixture";
  extractorVersion: string;
  units: BridgeUnit[];
};

export type PatchExportEntry = {
  entryId: Uuid7;
  bridgeUnitId: Uuid7;
  sourceUnitKey: string;
  sourceHash: string;
  targetText: string;
  protectedSpanMappings: Array<{ raw: string; targetStart: number; targetEnd: number }>;
};

export type PatchExport = {
  schemaVersion: "0.1.0";
  patchExportId: Uuid7;
  sourceBridgeId: Uuid7;
  sourceBundleHash: string;
  sourceLocale: Bcp47Locale;
  targetLocale: Bcp47Locale;
  entries: PatchExportEntry[];
};

export type PatchResult = {
  schemaVersion: "0.1.0";
  patchResultId: Uuid7;
  patchExportId?: Uuid7;
  status: "passed" | "failed";
  outputHash: string;
  failures: string[];
};

export type RuntimeTextEvent = {
  runtimeTextEventId: Uuid7;
  bridgeUnitId: Uuid7;
  text: string;
  frame: number;
};

export type FrameCapture = {
  frameCaptureId: Uuid7;
  bridgeUnitId: Uuid7;
  width: number;
  height: number;
  nonZeroPixels: number;
  artifactPath: string;
};

export type RuntimeVerificationReport = {
  schemaVersion: "0.1.0";
  runtimeReportId: Uuid7;
  adapterName: "utsushi-fixture";
  fidelityTier: RuntimeFidelityTier;
  status: "passed" | "failed";
  textEvents: RuntimeTextEvent[];
  frameCaptures: FrameCapture[];
  approximations: string[];
};

export function assertBridgeBundle(value: unknown): asserts value is BridgeBundle {
  const bundle = asRecord(value, "BridgeBundle");
  assertEqual(bundle.schemaVersion, "0.1.0", "BridgeBundle.schemaVersion");
  assertString(bundle.bridgeId, "BridgeBundle.bridgeId");
  assertString(bundle.sourceBundleHash, "BridgeBundle.sourceBundleHash");
  assertString(bundle.sourceLocale, "BridgeBundle.sourceLocale");
  assertArray(bundle.units, "BridgeBundle.units");
}

export function assertPatchExport(value: unknown): asserts value is PatchExport {
  const patch = asRecord(value, "PatchExport");
  assertEqual(patch.schemaVersion, "0.1.0", "PatchExport.schemaVersion");
  assertString(patch.patchExportId, "PatchExport.patchExportId");
  assertString(patch.sourceBridgeId, "PatchExport.sourceBridgeId");
  assertString(patch.targetLocale, "PatchExport.targetLocale");
  assertArray(patch.entries, "PatchExport.entries");
}

export function assertRuntimeVerificationReport(
  value: unknown,
): asserts value is RuntimeVerificationReport {
  const report = asRecord(value, "RuntimeVerificationReport");
  assertEqual(report.schemaVersion, "0.1.0", "RuntimeVerificationReport.schemaVersion");
  assertString(report.runtimeReportId, "RuntimeVerificationReport.runtimeReportId");
  assertArray(report.textEvents, "RuntimeVerificationReport.textEvents");
  assertArray(report.frameCaptures, "RuntimeVerificationReport.frameCaptures");
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertString(value: unknown, label: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function assertArray(value: unknown, label: string): void {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
}

function assertEqual(value: unknown, expected: string, label: string): void {
  if (value !== expected) {
    throw new Error(`${label} must be ${expected}`);
  }
}
