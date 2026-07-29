export type RuntimeStatus = {
  finalStatus: string;
  runtimeRunId: string | null;
  runtimeReportId: string | null;
  runtimeStatus: string | null;
  fidelityTier: string | null;
  evidenceTier: string | null;
  textEventCount: number;
  recordingArtifactCount: number;
  validationFindingCount: number;
  traceEvents: RuntimeTraceRow[];
  findings: RuntimeFinding[];
  artifacts: RuntimeArtifact[];
  approximations: RuntimeApproximation[];
  unsupportedCapabilities: RuntimeUnsupportedCapability[];
  limitations: string[];
};

export type RuntimeTraceRow = {
  runtimeEventId: string;
  eventKind: string;
  bridgeUnitId: string | null;
  sourceUnitKey: string | null;
  draftId: string | null;
  runtimeTargetId: string | null;
  evidenceTier: string | null;
  frame: number | null;
  textPreview: string | null;
  artifactIds: string[];
};

export type RuntimeFinding = {
  findingId: string;
  findingKind: string;
  severity: string;
  message: string;
  evidenceTier: string;
  bridgeUnitId: string | null;
  sourceUnitKey: string | null;
  artifactId: string | null;
};

export type RuntimeArtifact = {
  artifactId: string;
  artifactKind: string;
  uri: string | null;
  hash: string | null;
  hashProvenance: string | null;
  mediaType: string | null;
  byteSize: number | null;
  bridgeUnitId: string | null;
  sourceUnitKey: string | null;
  diagnostic: string | null;
};

export type RuntimeApproximation = {
  approximationId: string;
  approximationTier: string;
  scope: string;
  description: string;
  evidenceTierCeiling: string;
  bridgeUnitIds: string[];
};

export type RuntimeUnsupportedCapability = {
  feature: string;
  status: string;
  fidelityTierCeiling: string | null;
  evidenceTierCeiling: string | null;
  limitations: string[];
};

export const DEFAULT_RUNTIME_STATUS_ENDPOINT = "/api/runtime/v0.2/status";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isString(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isRuntimeTraceRow(value: unknown): value is RuntimeTraceRow {
  return (
    isRecord(value) &&
    isString(value.runtimeEventId) &&
    isString(value.eventKind) &&
    isNullableString(value.bridgeUnitId) &&
    isNullableString(value.sourceUnitKey) &&
    isNullableString(value.draftId) &&
    isNullableString(value.runtimeTargetId) &&
    isNullableString(value.evidenceTier) &&
    (value.frame === null || isNumber(value.frame)) &&
    isNullableString(value.textPreview) &&
    isStringArray(value.artifactIds)
  );
}

function isRuntimeFinding(value: unknown): value is RuntimeFinding {
  return (
    isRecord(value) &&
    isString(value.findingId) &&
    isString(value.findingKind) &&
    isString(value.severity) &&
    isString(value.message) &&
    isString(value.evidenceTier) &&
    isNullableString(value.bridgeUnitId) &&
    isNullableString(value.sourceUnitKey) &&
    isNullableString(value.artifactId)
  );
}

function isRuntimeArtifact(value: unknown): value is RuntimeArtifact {
  return (
    isRecord(value) &&
    isString(value.artifactId) &&
    isString(value.artifactKind) &&
    isNullableString(value.uri) &&
    isNullableString(value.hash) &&
    isNullableString(value.hashProvenance) &&
    isNullableString(value.mediaType) &&
    (value.byteSize === null || isNumber(value.byteSize)) &&
    isNullableString(value.bridgeUnitId) &&
    isNullableString(value.sourceUnitKey) &&
    isNullableString(value.diagnostic)
  );
}

function isRuntimeApproximation(value: unknown): value is RuntimeApproximation {
  return (
    isRecord(value) &&
    isString(value.approximationId) &&
    isString(value.approximationTier) &&
    isString(value.scope) &&
    isString(value.description) &&
    isString(value.evidenceTierCeiling) &&
    isStringArray(value.bridgeUnitIds)
  );
}

function isRuntimeUnsupportedCapability(value: unknown): value is RuntimeUnsupportedCapability {
  return (
    isRecord(value) &&
    isString(value.feature) &&
    isString(value.status) &&
    isNullableString(value.fidelityTierCeiling) &&
    isNullableString(value.evidenceTierCeiling) &&
    isStringArray(value.limitations)
  );
}

function isRuntimeStatus(value: unknown): value is RuntimeStatus {
  return (
    isRecord(value) &&
    isString(value.finalStatus) &&
    isNullableString(value.runtimeRunId) &&
    isNullableString(value.runtimeReportId) &&
    isNullableString(value.runtimeStatus) &&
    isNullableString(value.fidelityTier) &&
    isNullableString(value.evidenceTier) &&
    isNumber(value.textEventCount) &&
    isNumber(value.recordingArtifactCount) &&
    isNumber(value.validationFindingCount) &&
    Array.isArray(value.traceEvents) &&
    value.traceEvents.every(isRuntimeTraceRow) &&
    Array.isArray(value.findings) &&
    value.findings.every(isRuntimeFinding) &&
    Array.isArray(value.artifacts) &&
    value.artifacts.every(isRuntimeArtifact) &&
    Array.isArray(value.approximations) &&
    value.approximations.every(isRuntimeApproximation) &&
    Array.isArray(value.unsupportedCapabilities) &&
    value.unsupportedCapabilities.every(isRuntimeUnsupportedCapability) &&
    isStringArray(value.limitations)
  );
}

/** Reject malformed server data before it reaches the dashboard renderer. */
export function parseRuntimeStatus(value: unknown): RuntimeStatus {
  if (!isRuntimeStatus(value)) {
    throw new Error("invalid runtime status response");
  }
  return value;
}
