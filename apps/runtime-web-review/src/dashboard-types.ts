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
