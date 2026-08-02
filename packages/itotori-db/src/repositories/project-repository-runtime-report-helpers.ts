import * as deps from "./project-repository-dependencies.js";
import * as api from "./project-repository-types.js";
import * as helpers from "./project-repository-helpers.js";

export type RuntimeReportInput = deps.RuntimeEvidenceReportV02;

export type RuntimeArtifactLink = {
  artifactId: string;
  artifactKind: string;
  uri: string;
  hash: string | undefined;
  hashProvenance: api.RuntimeArtifactHashProvenance | null;
  bridgeUnitId: string | undefined;
  metadata: Record<string, unknown>;
};

export type RuntimeBridgeUnitRef = {
  bridgeUnitId: string;
  sourceUnitKey?: string;
};

export type RuntimeBridgeUnitLink = helpers.RuntimeBridgeUnitRef & {
  refRole: deps.RuntimeBridgeUnitRefRole;
  metadata?: Record<string, unknown>;
};

export type RuntimeEvidenceItemInput = {
  runtimeEvidenceId: string;
  evidenceKind: deps.RuntimeEvidenceKind;
  bridgeUnitId: string | undefined;
  artifactId: string | undefined;
  artifactKind: string | undefined;
  portableArtifactUri: string | undefined;
  evidenceTier: string | null | undefined;
  frame: number | undefined;
  metadata: Record<string, unknown>;
  bridgeUnitRefs: helpers.RuntimeBridgeUnitLink[];
};

export type RuntimeValidationFindingRecord = {
  findingId: string;
  adapterLocalFindingId: string;
  findingKind: string;
  severity: string;
  message: string;
  evidenceTier: string;
  bridgeUnitId: string | undefined;
  artifactRef: deps.RuntimeArtifactRefV02 | undefined;
  title: string;
  impact: string;
  affectedRefs: unknown[];
  evidence: unknown[];
  provenance: unknown[];
  metadata: Record<string, unknown>;
};

export function runtimeProjectionArtifactIds(
  runtimeReportId: string,
  patchResultId: string,
  artifactLinks: helpers.RuntimeArtifactLink[],
  validationRecords: helpers.RuntimeValidationFindingRecord[],
): string[] {
  return Array.from(
    new Set([
      runtimeReportId,
      patchResultId,
      ...artifactLinks.map((artifact) => artifact.artifactId),
      ...validationRecords.flatMap((validation) =>
        validation.artifactRef === undefined ? [] : [validation.artifactRef.artifactId],
      ),
    ]),
  );
}

export async function cleanupRuntimeReportProjection(
  tx: helpers.ItotoriTransaction,
  runtimeReportId: string,
  projectId: string,
  retainedArtifactIds: string[],
): Promise<void> {
  await tx.execute(deps.sql`
    delete from ${deps.findings}
    where finding_id in (
      select finding_id
      from ${deps.runtimeValidationFindings}
      where runtime_run_id = ${runtimeReportId}
    )
  `);

  await tx
    .delete(deps.runtimeEvidenceItems)
    .where(deps.eq(deps.runtimeEvidenceItems.runtimeRunId, runtimeReportId));

  await tx
    .delete(deps.artifacts)
    .where(
      deps.and(
        deps.eq(deps.artifacts.projectId, projectId),
        deps.sql`${deps.artifacts.metadata}->>'runtimeReportId' = ${runtimeReportId}`,
        deps.not(deps.inArray(deps.artifacts.artifactId, retainedArtifactIds)),
      ),
    );
}

export function runtimeReportIdFor(report: helpers.RuntimeReportInput): string {
  return report.runtimeReportId;
}

export function runtimeAdapterName(report: helpers.RuntimeReportInput): string {
  return report.adapterName;
}

export function runtimeAdapterVersion(report: helpers.RuntimeReportInput): string | null {
  return report.adapterVersion;
}

export function runtimeReportStatus(report: helpers.RuntimeReportInput): "passed" | "failed" {
  return report.status;
}

export function runtimeFinalStatus(
  status: "passed" | "failed",
): "hello_world_passed" | "hello_world_failed" {
  return status === "passed" ? "hello_world_passed" : "hello_world_failed";
}

export function runtimeFidelityTier(report: helpers.RuntimeReportInput): string {
  return report.fidelityTier;
}

export function runtimeEvidenceTier(report: helpers.RuntimeReportInput): string | null {
  return report.evidenceTier;
}

export function runtimeTextEventCount(report: helpers.RuntimeReportInput): number {
  return report.traceEvents.length;
}

export function runtimeBranchEventCount(report: helpers.RuntimeReportInput): number {
  return report.branchEvents.length;
}

export function runtimeFrameCaptureCount(_report: helpers.RuntimeReportInput): number {
  // V02 captures are persisted as `screenshot` artifacts (see
  // localization-bridge-schema assertRuntimeArtifactRefV02(capture.artifactRef,
  // ..., "screenshot")), so a V02 run contributes zero frame_capture
  // artifacts — its captures are screenshots.
  return 0;
}

export function runtimeScreenshotArtifactCount(report: helpers.RuntimeReportInput): number {
  return report.captures.length;
}

export function runtimeRecordingArtifactCount(report: helpers.RuntimeReportInput): number {
  return report.recordings.length;
}

export function runtimeValidationFindingCount(report: helpers.RuntimeReportInput): number {
  return report.validationFindings.length;
}

export function runtimeReferenceComparisonCount(report: helpers.RuntimeReportInput): number {
  return (report.referenceComparisons ?? []).length;
}

export function runtimeReportCreatedAt(report: helpers.RuntimeReportInput): Date {
  return new Date(report.createdAt);
}

export function runtimeApproximations(report: helpers.RuntimeReportInput): unknown[] {
  return report.approximations;
}

export function runtimeReportMetadataFor(
  report: helpers.RuntimeReportInput,
  summary: {
    adapterName: string;
    adapterVersion: string | null;
    finalStatus: string;
    runtimeStatus: string;
    fidelityTier: string;
    evidenceTier: string | null;
    textEventCount: number;
    branchEventCount: number;
    frameCaptureCount: number;
    screenshotArtifactCount: number;
    recordingArtifactCount: number;
    validationFindingCount: number;
    referenceComparisonCount: number;
  },
): Record<string, unknown> {
  return {
    schemaVersion: report.schemaVersion,
    adapterName: summary.adapterName,
    adapterVersion: summary.adapterVersion,
    sourceBridgeId: report.sourceBridgeId ?? null,
    sourceBundleHash: report.sourceBundleHash ?? null,
    sourceLocale: report.sourceLocale ?? null,
    targetLocale: report.targetLocale ?? null,
    fidelityTier: summary.fidelityTier,
    evidenceTier: summary.evidenceTier,
    status: summary.runtimeStatus,
    finalStatus: summary.finalStatus,
    textEventCount: summary.textEventCount,
    branchEventCount: summary.branchEventCount,
    frameCaptureCount: summary.frameCaptureCount,
    screenshotArtifactCount: summary.screenshotArtifactCount,
    recordingArtifactCount: summary.recordingArtifactCount,
    validationFindingCount: summary.validationFindingCount,
    referenceComparisonCount: summary.referenceComparisonCount,
    approximations: helpers.runtimeApproximations(report),
    runtimeCapabilities: report.runtimeCapabilities ?? null,
    controlledPlaybackSession: report.controlledPlaybackSession ?? null,
    limitations: report.limitations,
    reportCreatedAt: helpers.runtimeReportCreatedAt(report).toISOString(),
  };
}

export function runtimeArtifactLinks(
  report: helpers.RuntimeReportInput,
): helpers.RuntimeArtifactLink[] {
  return [
    ...report.traceEvents.flatMap((event) =>
      event.artifactRef === undefined
        ? []
        : [
            helpers.artifactLinkFromRef(
              report.runtimeReportId,
              event.artifactRef,
              event.bridgeUnitRef.bridgeUnitId,
              {
                evidenceKind: deps.runtimeEvidenceKindValues.traceEvent,
                traceEventId: event.traceEventId,
                frame: event.frame,
                traceKey: event.traceKey,
              },
            ),
          ],
    ),
    ...report.captures.map((capture) => ({
      ...artifactLinkFromRef(
        report.runtimeReportId,
        capture.artifactRef,
        capture.bridgeUnitRef.bridgeUnitId,
        {
          evidenceKind: deps.runtimeEvidenceKindValues.capture,
          captureId: capture.captureId,
          evidenceTier: capture.evidenceTier,
          frame: capture.frame,
          width: capture.width,
          height: capture.height,
          nonZeroPixels: capture.nonZeroPixels,
          region: capture.region ?? null,
        },
      ),
    })),
    ...report.recordings.map((recording) => ({
      ...artifactLinkFromRef(
        report.runtimeReportId,
        recording.artifactRef,
        recording.bridgeUnitRef.bridgeUnitId,
        {
          evidenceKind: deps.runtimeEvidenceKindValues.recording,
          recordingId: recording.recordingId,
          evidenceTier: recording.evidenceTier,
          startedAtFrame: recording.startedAtFrame,
          frameCount: recording.frameCount,
          width: recording.width,
          height: recording.height,
          encoding: recording.encoding,
        },
      ),
    })),
    ...(report.referenceComparisons ?? []).map((comparison) =>
      helpers.artifactLinkFromRef(
        report.runtimeReportId,
        comparison.artifactRef,
        comparison.coveredBridgeUnitRefs[0]?.bridgeUnitId,
        {
          evidenceKind: deps.runtimeEvidenceKindValues.referenceComparison,
          comparisonId: comparison.comparisonId,
          comparisonKind: comparison.comparisonKind,
          status: comparison.status,
          scope: comparison.scope,
        },
      ),
    ),
  ];
}

export function artifactLinkFromRef(
  runtimeReportId: string,
  artifactRef: deps.RuntimeArtifactRefV02,
  bridgeUnitId: string | undefined,
  metadata: Record<string, unknown>,
): helpers.RuntimeArtifactLink {
  helpers.assertPortableRuntimeSchemaArtifactUri(artifactRef.uri);
  const hashProvenance = helpers.runtimeArtifactHashProvenance(artifactRef);
  const storedArtifactRef = helpers.runtimeArtifactRefForDb(artifactRef, runtimeReportId);
  const adapterLocalArtifactRef = helpers.runtimeArtifactRefForDb(artifactRef);
  return {
    artifactId: storedArtifactRef.artifactId,
    artifactKind: storedArtifactRef.artifactKind,
    uri: storedArtifactRef.uri,
    hash: storedArtifactRef.hash,
    hashProvenance,
    bridgeUnitId,
    metadata: {
      ...metadata,
      artifactRef: storedArtifactRef,
      adapterLocalArtifactId: adapterLocalArtifactRef.artifactId,
      adapterLocalArtifactRef,
      hashProvenance,
      mediaType: storedArtifactRef.mediaType ?? null,
      byteSize: storedArtifactRef.byteSize ?? null,
    },
  };
}

/**
 * Returns the provenance discriminator for a runtime artifact ref's hash.
 * `content` means the adapter supplied an authentic content hash
 * (artifactRef.hash !== undefined); `repository_fallback` means the repository
 * will generate a deterministic placeholder hash over managed-artifact
 * metadata. The discriminator is recorded at save time so the dashboard can
 * distinguish content proof from generated placeholders.
 */
export function runtimeArtifactHashProvenance(
  artifactRef: deps.RuntimeArtifactRefV02,
): api.RuntimeArtifactHashProvenance {
  return artifactRef.hash === undefined ? "repository_fallback" : "content";
}
