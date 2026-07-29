import { HttpResponse } from "msw";
import { assertItotoriApiResponse } from "../../itotori/src/api-schema.js";

export type RuntimeDashboardStatus = Parameters<typeof assertRuntimeStatus>[0];

export function apiRuntimeStatus(body: RuntimeDashboardStatus): HttpResponse {
  assertItotoriApiResponse("runtime.status", body);
  return HttpResponse.json(body);
}

function assertRuntimeStatus(value: {
  finalStatus: string;
  runtimeRunId: string | null;
  runtimeReportId: string | null;
  runtimeStatus: string | null;
  fidelityTier: string | null;
  evidenceTier: string | null;
  textEventCount: number;
  frameCaptureCount: number;
  screenshotArtifactCount: number;
  recordingArtifactCount: number;
  validationFindingCount: number;
  traceEvents: {
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
  }[];
  findings: {
    findingId: string;
    findingKind: string;
    severity: string;
    message: string;
    evidenceTier: string;
    bridgeUnitId: string | null;
    sourceUnitKey: string | null;
    artifactId: string | null;
  }[];
  artifacts: {
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
  }[];
  approximations: {
    approximationId: string;
    approximationTier: string;
    scope: string;
    description: string;
    evidenceTierCeiling: string;
    bridgeUnitIds: string[];
  }[];
  unsupportedCapabilities: {
    feature: string;
    status: string;
    fidelityTierCeiling: string | null;
    evidenceTierCeiling: string | null;
    limitations: string[];
  }[];
  limitations: string[];
}): void {
  void value;
}

export function frameArtifact(id: string): RuntimeDashboardStatus["artifacts"][number] {
  return {
    artifactId: `frame:${id}`,
    artifactKind: "frame_capture",
    uri: `artifacts/utsushi/runtime/run-passed-e2-capture/frames/${id}.png`,
    hash: `sha256:${id}`,
    hashProvenance: "content",
    mediaType: "image/png",
    byteSize: 4096,
    bridgeUnitId: "bridge-unit-1",
    sourceUnitKey: "hello.scene.001.line.001",
    diagnostic: null,
  };
}

export function runtimeFixture(
  state:
    | "passed-e2-capture"
    | "failed-text-mismatch"
    | "unsupported-runtime-feature"
    | "missing-capture"
    | "missing-managed-hash"
    | "stale-artifact-hash"
    | "repository-fallback-hash",
): RuntimeDashboardStatus {
  const runId = `run-${state}`;
  const reportId = `report-${state}`;
  const traceArtifactId = `${runId}:trace-artifact`;
  const screenshotArtifactId = `${runId}:screenshot`;
  const base: RuntimeDashboardStatus = {
    finalStatus: "hello_world_passed",
    runtimeRunId: runId,
    runtimeReportId: reportId,
    runtimeStatus: "passed",
    fidelityTier: "layout_probe",
    evidenceTier: "E2",
    textEventCount: 1,
    frameCaptureCount: 0,
    screenshotArtifactCount: 1,
    recordingArtifactCount: 0,
    validationFindingCount: 0,
    traceEvents: [
      {
        runtimeEventId: `trace-${state}`,
        eventKind: "text_seen",
        bridgeUnitId: "bridge-unit-1",
        sourceUnitKey: "hello.scene.001.line.001",
        draftId: "locale-1:bridge-unit-1",
        runtimeTargetId: "hello.scene.001.line.001",
        evidenceTier: "E2",
        frame: 12,
        textPreview: "Hello, reviewer.",
        artifactIds: [traceArtifactId],
      },
    ],
    findings: [],
    artifacts: [
      {
        artifactId: traceArtifactId,
        artifactKind: "trace_log",
        uri: `artifacts/utsushi/runtime/${runId}/traces/trace.json`,
        hash: `sha256:trace-${state}`,
        hashProvenance: "content",
        mediaType: "application/json",
        byteSize: 512,
        bridgeUnitId: "bridge-unit-1",
        sourceUnitKey: "hello.scene.001.line.001",
        diagnostic: null,
      },
      {
        artifactId: screenshotArtifactId,
        artifactKind: "screenshot",
        uri: `artifacts/utsushi/runtime/${runId}/screenshots/frame.png`,
        hash: `sha256:screen-${state}`,
        hashProvenance: "content",
        mediaType: "image/png",
        byteSize: 4096,
        bridgeUnitId: "bridge-unit-1",
        sourceUnitKey: "hello.scene.001.line.001",
        diagnostic: null,
      },
    ],
    approximations: [
      {
        approximationId: `${runId}:approximation`,
        approximationTier: "synthetic_fixture",
        scope: "capture",
        description: "Fixture capture approximates a host runtime frame.",
        evidenceTierCeiling: "E2",
        bridgeUnitIds: ["bridge-unit-1"],
      },
    ],
    unsupportedCapabilities: [],
    limitations: [],
  };

  if (state === "failed-text-mismatch") {
    return {
      ...base,
      finalStatus: "hello_world_failed",
      runtimeStatus: "failed",
      validationFindingCount: 1,
      findings: [
        {
          findingId: `${runId}:finding-text-mismatch`,
          findingKind: "text_mismatch",
          severity: "error",
          message: "Observed text was Hello, reviewer. but the draft expected Bonjour.",
          evidenceTier: "E2",
          bridgeUnitId: "bridge-unit-1",
          sourceUnitKey: "hello.scene.001.line.001",
          artifactId: traceArtifactId,
        },
      ],
    };
  }

  if (state === "unsupported-runtime-feature") {
    return {
      ...base,
      unsupportedCapabilities: [
        {
          feature: "recording",
          status: "unsupported",
          fidelityTierCeiling: null,
          evidenceTierCeiling: null,
          limitations: ["Fixture runtime cannot produce a replay recording."],
        },
      ],
      limitations: ["Recording capability is not available for this adapter."],
    };
  }

  if (state === "missing-capture") {
    return {
      ...base,
      finalStatus: "hello_world_failed",
      runtimeStatus: "failed",
      frameCaptureCount: 0,
      screenshotArtifactCount: 0,
      validationFindingCount: 1,
      findings: [
        {
          findingId: `${runId}:finding-missing-capture`,
          findingKind: "missing_capture",
          severity: "error",
          message: "Expected screenshot capture is missing.",
          evidenceTier: "E2",
          bridgeUnitId: "bridge-unit-1",
          sourceUnitKey: "hello.scene.001.line.001",
          artifactId: screenshotArtifactId,
        },
      ],
      artifacts: [
        {
          ...base.artifacts[0]!,
          uri: null,
          diagnostic: "redacted fields: uri",
        },
        {
          ...base.artifacts[1]!,
          uri: null,
          diagnostic: "artifact record has no managed artifact-store URI",
        },
      ],
    };
  }

  if (state === "missing-managed-hash") {
    return {
      ...base,
      artifacts: base.artifacts.map((artifact) =>
        artifact.artifactId === screenshotArtifactId
          ? {
              ...artifact,
              hash: null,
            }
          : artifact,
      ),
    };
  }

  if (state === "stale-artifact-hash") {
    return {
      ...base,
      validationFindingCount: 1,
      findings: [
        {
          findingId: `${runId}:finding-stale-hash`,
          findingKind: "stale_artifact_hash",
          severity: "warning",
          message: "Managed artifact content hash no longer matches the runtime report.",
          evidenceTier: "E2",
          bridgeUnitId: "bridge-unit-1",
          sourceUnitKey: "hello.scene.001.line.001",
          artifactId: screenshotArtifactId,
        },
      ],
      artifacts: base.artifacts.map((artifact) =>
        artifact.artifactId === screenshotArtifactId
          ? {
              ...artifact,
              hash: "sha256:old-screen",
              diagnostic: "stale artifact hash: expected sha256:new-screen",
            }
          : artifact,
      ),
    };
  }

  if (state === "repository-fallback-hash") {
    // The screenshot artifact's hash is a deterministic placeholder generated
    // by the repository from managed-artifact metadata, not authentic adapter
    // content evidence. The dashboard must surface it as a generated
    // placeholder hash rather than content proof.
    return {
      ...base,
      artifacts: base.artifacts.map((artifact) =>
        artifact.artifactId === screenshotArtifactId
          ? {
              ...artifact,
              hash: "sha256:repository-fallback-screen",
              hashProvenance: "repository_fallback",
            }
          : artifact,
      ),
    };
  }

  return base;
}
