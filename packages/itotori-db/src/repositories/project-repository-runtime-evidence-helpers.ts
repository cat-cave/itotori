import * as deps from "./project-repository-dependencies.js";
import * as api from "./project-repository-types.js";
import * as helpers from "./project-repository-helpers.js";

export function runtimeEvidenceItemsFor(
  report: helpers.RuntimeReportInput,
): helpers.RuntimeEvidenceItemInput[] {
  if (!helpers.isRuntimeEvidenceReportV02(report)) {
    return [
      ...report.textEvents.map((event) => ({
        runtimeEvidenceId: helpers.runtimeChildIdFor(
          report.runtimeReportId,
          event.runtimeTextEventId,
        ),
        evidenceKind: deps.runtimeEvidenceKindValues.traceEvent,
        bridgeUnitId: event.bridgeUnitId,
        artifactId: undefined,
        artifactKind: undefined,
        portableArtifactUri: undefined,
        evidenceTier: null,
        frame: event.frame,
        metadata: { adapterLocalEvidenceId: event.runtimeTextEventId, event },
        bridgeUnitRefs: [
          {
            bridgeUnitId: event.bridgeUnitId,
            refRole: deps.runtimeBridgeUnitRefRoleValues.primary,
          },
        ],
      })),
      ...report.frameCaptures.map((frame) => ({
        runtimeEvidenceId: helpers.runtimeChildIdFor(report.runtimeReportId, frame.frameCaptureId),
        evidenceKind: deps.runtimeEvidenceKindValues.capture,
        bridgeUnitId: frame.bridgeUnitId,
        artifactId: helpers.runtimeChildIdFor(report.runtimeReportId, frame.frameCaptureId),
        artifactKind: "frame_capture",
        portableArtifactUri: undefined,
        evidenceTier: null,
        frame: undefined,
        metadata: {
          adapterLocalEvidenceId: frame.frameCaptureId,
          capture: frame,
          width: frame.width,
          height: frame.height,
          nonZeroPixels: frame.nonZeroPixels,
        },
        bridgeUnitRefs: [
          {
            bridgeUnitId: frame.bridgeUnitId,
            refRole: deps.runtimeBridgeUnitRefRoleValues.primary,
          },
        ],
      })),
    ];
  }

  return [
    ...report.traceEvents.map((event) => {
      const artifactRef = event.artifactRef;
      if (artifactRef !== undefined) {
        helpers.assertPortableRuntimeSchemaArtifactUri(artifactRef.uri);
      }
      const storedArtifactRef =
        artifactRef === undefined
          ? undefined
          : helpers.runtimeArtifactRefForDb(artifactRef, report.runtimeReportId);
      return {
        runtimeEvidenceId: helpers.runtimeChildIdFor(report.runtimeReportId, event.traceEventId),
        evidenceKind: deps.runtimeEvidenceKindValues.traceEvent,
        bridgeUnitId: event.bridgeUnitRef.bridgeUnitId,
        artifactId: storedArtifactRef?.artifactId,
        artifactKind: artifactRef?.artifactKind ?? "runtime_trace_event",
        portableArtifactUri: storedArtifactRef?.uri,
        evidenceTier: null,
        frame: event.frame,
        metadata: {
          adapterLocalEvidenceId: event.traceEventId,
          eventKind: event.eventKind,
          traceKey: event.traceKey,
          observedText: event.observedText,
          artifactRef: storedArtifactRef ?? null,
          adapterLocalArtifactRef:
            artifactRef === undefined ? null : helpers.runtimeArtifactRefForDb(artifactRef),
          event: helpers.runtimeTraceEventForDb(event),
        },
        bridgeUnitRefs: [
          helpers.bridgeUnitLink(event.bridgeUnitRef, deps.runtimeBridgeUnitRefRoleValues.primary),
        ],
      };
    }),
    ...report.branchEvents.map((event) => ({
      runtimeEvidenceId: helpers.runtimeChildIdFor(report.runtimeReportId, event.branchEventId),
      evidenceKind: deps.runtimeEvidenceKindValues.branchEvent,
      bridgeUnitId: event.bridgeUnitRef.bridgeUnitId,
      artifactId: undefined,
      artifactKind: "runtime_branch_event",
      portableArtifactUri: undefined,
      evidenceTier: null,
      frame: event.frame,
      metadata: {
        adapterLocalEvidenceId: event.branchEventId,
        branchPointKey: event.branchPointKey,
        selectedOptionId: event.selectedOptionId,
        event: helpers.runtimeBranchEventForDb(event),
      },
      bridgeUnitRefs: helpers.runtimeBranchEventBridgeUnitLinks(event),
    })),
    ...report.captures.map((capture) => {
      helpers.assertPortableRuntimeSchemaArtifactUri(capture.artifactRef.uri);
      const storedArtifactRef = helpers.runtimeArtifactRefForDb(
        capture.artifactRef,
        report.runtimeReportId,
      );
      return {
        runtimeEvidenceId: helpers.runtimeChildIdFor(report.runtimeReportId, capture.captureId),
        evidenceKind: deps.runtimeEvidenceKindValues.capture,
        bridgeUnitId: capture.bridgeUnitRef.bridgeUnitId,
        artifactId: storedArtifactRef.artifactId,
        artifactKind: capture.artifactRef.artifactKind,
        portableArtifactUri: storedArtifactRef.uri,
        evidenceTier: capture.evidenceTier,
        frame: capture.frame,
        metadata: {
          adapterLocalEvidenceId: capture.captureId,
          width: capture.width,
          height: capture.height,
          nonZeroPixels: capture.nonZeroPixels,
          region: capture.region ?? null,
          artifactRef: storedArtifactRef,
          adapterLocalArtifactRef: helpers.runtimeArtifactRefForDb(capture.artifactRef),
          capture: helpers.runtimeCaptureForDb(capture),
        },
        bridgeUnitRefs: [
          helpers.bridgeUnitLink(
            capture.bridgeUnitRef,
            deps.runtimeBridgeUnitRefRoleValues.primary,
          ),
        ],
      };
    }),
    ...report.recordings.map((recording) => {
      helpers.assertPortableRuntimeSchemaArtifactUri(recording.artifactRef.uri);
      const storedArtifactRef = helpers.runtimeArtifactRefForDb(
        recording.artifactRef,
        report.runtimeReportId,
      );
      return {
        runtimeEvidenceId: helpers.runtimeChildIdFor(report.runtimeReportId, recording.recordingId),
        evidenceKind: deps.runtimeEvidenceKindValues.recording,
        bridgeUnitId: recording.bridgeUnitRef.bridgeUnitId,
        artifactId: storedArtifactRef.artifactId,
        artifactKind: recording.artifactRef.artifactKind,
        portableArtifactUri: storedArtifactRef.uri,
        evidenceTier: recording.evidenceTier,
        frame: recording.startedAtFrame,
        metadata: {
          adapterLocalEvidenceId: recording.recordingId,
          recording: helpers.runtimeRecordingForDb(recording),
          frameCount: recording.frameCount,
          width: recording.width,
          height: recording.height,
          encoding: recording.encoding,
          artifactRef: storedArtifactRef,
          adapterLocalArtifactRef: helpers.runtimeArtifactRefForDb(recording.artifactRef),
        },
        bridgeUnitRefs: [
          helpers.bridgeUnitLink(
            recording.bridgeUnitRef,
            deps.runtimeBridgeUnitRefRoleValues.primary,
          ),
        ],
      };
    }),
    ...report.approximations.map((approximation) => ({
      runtimeEvidenceId: helpers.runtimeChildIdFor(
        report.runtimeReportId,
        approximation.approximationId,
      ),
      evidenceKind: deps.runtimeEvidenceKindValues.approximation,
      bridgeUnitId: approximation.affectedBridgeUnitRefs[0]?.bridgeUnitId,
      artifactId: undefined,
      artifactKind: undefined,
      portableArtifactUri: undefined,
      evidenceTier: approximation.evidenceTierCeiling,
      frame: undefined,
      metadata: { adapterLocalEvidenceId: approximation.approximationId, approximation },
      bridgeUnitRefs: approximation.affectedBridgeUnitRefs.map((ref) =>
        helpers.bridgeUnitLink(ref, deps.runtimeBridgeUnitRefRoleValues.affected),
      ),
    })),
    ...(report.referenceComparisons ?? []).map((comparison) => {
      helpers.assertPortableRuntimeSchemaArtifactUri(comparison.artifactRef.uri);
      const storedArtifactRef = helpers.runtimeArtifactRefForDb(
        comparison.artifactRef,
        report.runtimeReportId,
      );
      return {
        runtimeEvidenceId: helpers.runtimeChildIdFor(
          report.runtimeReportId,
          comparison.comparisonId,
        ),
        evidenceKind: deps.runtimeEvidenceKindValues.referenceComparison,
        bridgeUnitId: comparison.coveredBridgeUnitRefs[0]?.bridgeUnitId,
        artifactId: storedArtifactRef.artifactId,
        artifactKind: comparison.artifactRef.artifactKind,
        portableArtifactUri: storedArtifactRef.uri,
        evidenceTier: "E4",
        frame: undefined,
        metadata: {
          adapterLocalEvidenceId: comparison.comparisonId,
          comparison: helpers.runtimeReferenceComparisonForDb(comparison),
          artifactRef: storedArtifactRef,
          adapterLocalArtifactRef: helpers.runtimeArtifactRefForDb(comparison.artifactRef),
        },
        bridgeUnitRefs: comparison.coveredBridgeUnitRefs.map((ref) =>
          helpers.bridgeUnitLink(ref, deps.runtimeBridgeUnitRefRoleValues.covered),
        ),
      };
    }),
  ].map((item) => ({
    ...item,
    bridgeUnitRefs: helpers.uniqueBridgeUnitLinks(item.bridgeUnitRefs),
  }));
}

export function runtimeBranchEventBridgeUnitLinks(
  event: deps.RuntimeEvidenceReportV02["branchEvents"][number],
): helpers.RuntimeBridgeUnitLink[] {
  const refs = [
    helpers.bridgeUnitLink(event.bridgeUnitRef, deps.runtimeBridgeUnitRefRoleValues.primary),
  ];
  for (const option of event.options) {
    if (option.labelBridgeUnitRef !== undefined) {
      refs.push(
        helpers.bridgeUnitLink(
          option.labelBridgeUnitRef,
          deps.runtimeBridgeUnitRefRoleValues.branchLabel,
          {
            optionId: option.optionId,
          },
        ),
      );
    }
    if (option.targetBridgeUnitRef !== undefined) {
      refs.push(
        helpers.bridgeUnitLink(
          option.targetBridgeUnitRef,
          deps.runtimeBridgeUnitRefRoleValues.branchTarget,
          {
            optionId: option.optionId,
          },
        ),
      );
    }
  }
  return helpers.uniqueBridgeUnitLinks(refs);
}

export function bridgeUnitLink(
  ref: deps.RuntimeBridgeUnitRefV02,
  refRole: deps.RuntimeBridgeUnitRefRole,
  metadata?: Record<string, unknown>,
): helpers.RuntimeBridgeUnitLink {
  return {
    bridgeUnitId: ref.bridgeUnitId,
    refRole,
    ...(ref.sourceUnitKey === undefined ? {} : { sourceUnitKey: ref.sourceUnitKey }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

export function uniqueBridgeUnitLinks(
  refs: helpers.RuntimeBridgeUnitLink[],
): helpers.RuntimeBridgeUnitLink[] {
  const uniqueRefs = new Map<string, helpers.RuntimeBridgeUnitLink>();
  for (const ref of refs) {
    uniqueRefs.set(`${ref.bridgeUnitId}\0${ref.sourceUnitKey ?? ""}\0${ref.refRole}`, ref);
  }
  return Array.from(uniqueRefs.values());
}

export function runtimeValidationFindingRecords(
  report: helpers.RuntimeReportInput,
): helpers.RuntimeValidationFindingRecord[] {
  if (!helpers.isRuntimeEvidenceReportV02(report)) {
    return [];
  }

  return report.validationFindings.map((finding) =>
    helpers.runtimeValidationFindingRecord(report, finding),
  );
}

export function runtimeValidationFindingRecord(
  report: deps.RuntimeEvidenceReportV02,
  finding: deps.RuntimeValidationFindingV02,
): helpers.RuntimeValidationFindingRecord {
  const findingId = helpers.runtimeChildIdFor(report.runtimeReportId, finding.findingId);
  const artifactRef =
    finding.artifactRef === undefined
      ? undefined
      : helpers.runtimeArtifactRefForDb(finding.artifactRef, report.runtimeReportId);
  if (finding.artifactRef !== undefined) {
    helpers.assertPortableRuntimeSchemaArtifactUri(finding.artifactRef.uri);
  }
  const runtimeReportRef = {
    subjectKind: "runtime_report",
    subjectId: report.runtimeReportId,
  };
  const bridgeUnitRef =
    finding.bridgeUnitRef === undefined
      ? undefined
      : {
          subjectKind: "bridge_unit",
          subjectId: finding.bridgeUnitRef.bridgeUnitId,
          sourceUnitKey: finding.bridgeUnitRef.sourceUnitKey,
        };
  const affectedRefs =
    bridgeUnitRef === undefined ? [runtimeReportRef] : [runtimeReportRef, bridgeUnitRef];
  const evidence = [
    {
      evidenceKind: "runtime_validation",
      runtimeReportId: report.runtimeReportId,
      evidenceTier: finding.evidenceTier,
      artifactRef: artifactRef ?? null,
    },
  ];
  const provenance = [
    {
      provenanceKind: "runtime_evidence",
      runtimeReportId: report.runtimeReportId,
      adapterName: report.adapterName,
      adapterVersion: report.adapterVersion,
    },
  ];

  return {
    findingId,
    adapterLocalFindingId: finding.findingId,
    findingKind: finding.findingKind,
    severity: finding.severity,
    message: finding.message,
    evidenceTier: finding.evidenceTier,
    bridgeUnitId: finding.bridgeUnitRef?.bridgeUnitId,
    artifactRef,
    title: `Runtime validation: ${finding.findingKind}`,
    impact: "Runtime evidence may be incomplete or invalid for this report.",
    affectedRefs,
    evidence,
    provenance,
    metadata: {
      schemaVersion: report.schemaVersion,
      runtimeReportId: report.runtimeReportId,
      adapterLocalFindingId: finding.findingId,
      finding: helpers.runtimeValidationFindingForDb(finding),
      bridgeUnitRef: finding.bridgeUnitRef ?? null,
      artifactRef: artifactRef ?? null,
      adapterLocalArtifactRef:
        finding.artifactRef === undefined
          ? null
          : helpers.runtimeArtifactRefForDb(finding.artifactRef),
    },
  };
}
