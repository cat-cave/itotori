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

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
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
    (value.frame === null || isNonnegativeInteger(value.frame)) &&
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
    (value.byteSize === null || isNonnegativeInteger(value.byteSize)) &&
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
    isNonnegativeInteger(value.textEventCount) &&
    isNonnegativeInteger(value.recordingArtifactCount) &&
    isNonnegativeInteger(value.validationFindingCount) &&
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
    throw new Error(`invalid runtime status response: ${invalidRuntimeStatusField(value)}`);
  }
  return value;
}

function invalidRuntimeStatusField(value: unknown): string {
  if (!isRecord(value)) return "response";
  const fields: readonly [string, (value: unknown) => boolean][] = [
    ["finalStatus", isString],
    ["runtimeRunId", isNullableString],
    ["runtimeReportId", isNullableString],
    ["runtimeStatus", isNullableString],
    ["fidelityTier", isNullableString],
    ["evidenceTier", isNullableString],
    ["textEventCount", isNonnegativeInteger],
    ["recordingArtifactCount", isNonnegativeInteger],
    ["validationFindingCount", isNonnegativeInteger],
    ["limitations", isStringArray],
  ];
  for (const [field, validator] of fields) {
    if (!validator(value[field])) return field;
  }
  const traceEvents = invalidArrayMember(value.traceEvents, isRuntimeTraceRow, "traceEvents");
  if (traceEvents !== undefined) return traceEvents;
  const findings = invalidArrayMember(value.findings, isRuntimeFinding, "findings");
  if (findings !== undefined) return findings;
  const artifacts = invalidArrayMember(value.artifacts, isRuntimeArtifact, "artifacts");
  if (artifacts !== undefined) return artifacts;
  const approximations = invalidArrayMember(
    value.approximations,
    isRuntimeApproximation,
    "approximations",
  );
  if (approximations !== undefined) return approximations;
  const unsupportedCapabilities = invalidArrayMember(
    value.unsupportedCapabilities,
    isRuntimeUnsupportedCapability,
    "unsupportedCapabilities",
  );
  return unsupportedCapabilities ?? "response";
}

function invalidArrayMember<T>(
  value: unknown,
  isMember: (value: unknown) => value is T,
  field: string,
): string | undefined {
  if (!Array.isArray(value)) return field;
  for (const [index, member] of value.entries()) {
    if (!isMember(member)) {
      if (
        field === "traceEvents" &&
        isRecord(member) &&
        member.frame !== null &&
        !isNonnegativeInteger(member.frame)
      ) {
        return `${field}[${index}].frame`;
      }
      if (
        field === "artifacts" &&
        isRecord(member) &&
        member.byteSize !== null &&
        !isNonnegativeInteger(member.byteSize)
      ) {
        return `${field}[${index}].byteSize`;
      }
      return `${field}[${index}]`;
    }
  }
  return undefined;
}
