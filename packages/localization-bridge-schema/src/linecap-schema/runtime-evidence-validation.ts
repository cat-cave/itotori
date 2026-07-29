import {
  BRIDGE_SCHEMA_VERSION_V02,
  RUNTIME_APPROXIMATION_TIERS_V02,
  RUNTIME_EVIDENCE_TIERS_V02,
  RUNTIME_FIDELITY_TIERS_V02,
  RUNTIME_TRACE_EVENT_KINDS_V02,
  RUNTIME_VALIDATION_FINDING_KINDS_V02,
  RuntimeVerificationReport,
  TRIAGE_SEVERITIES,
  Uuid7,
} from "./bridge-core-types.js";
import {
  RuntimeApproximationV02,
  RuntimeBranchOptionV02,
  RuntimeBranchPointEventV02,
  RuntimeCaptureV02,
  RuntimeRecordingV02,
  RuntimeReferenceComparisonV02,
  RuntimeTraceEventV02,
  RuntimeValidationFindingV02,
} from "./bridge-context-types.js";
import {
  ControlledPlaybackSessionV02,
  ObservationHookEvent,
  RuntimeCapabilityContractV02,
  RuntimeEvidenceReportV02,
} from "./patch-and-runtime-types.js";
import { assertRuntimeVerificationReport } from "./patch-compatibility-validation.js";
import {
  assertControlledPlaybackSessionV02,
  assertObservationHookEvent,
  assertRuntimeArtifactRefV02,
  assertRuntimeBridgeUnitRefV02,
  assertRuntimeCapabilityContractV02,
  assertRuntimeReferenceComparisonV02,
} from "./runtime-observation-validation.js";
import {
  assertControlledPlaybackSessionEvidenceSurfaceV02,
  assertMaximumRuntimeEvidenceTierV02,
  assertMinimumRuntimeEvidenceTierV02,
  assertRuntimeCapabilitySupportsFeatureV02,
  assertRuntimeEvidenceTierWithinFidelityV02,
} from "./runtime-capability-and-unit-validation.js";
import {
  asArray,
  asRecord,
  assertOptionalHashStringV02,
  assertOptionalString,
  assertRfc3339Instant,
  assertString,
  assertStringArray,
} from "./fixture-utility-validation.js";
import {
  assertEnum,
  assertEqual,
  assertNonNegativeInteger,
  assertOptionalUuid7,
  assertPixelRegionV02,
  assertPositiveInteger,
  assertUuid7,
} from "./validation-primitives.js";

export function assertRuntimeEvidenceReportV02(
  value: unknown,
): asserts value is RuntimeEvidenceReportV02 {
  const report = asRecord(value, "RuntimeEvidenceReportV02");
  assertEqual(
    report.schemaVersion,
    BRIDGE_SCHEMA_VERSION_V02,
    "RuntimeEvidenceReportV02.schemaVersion",
  );
  assertUuid7(report.runtimeReportId, "RuntimeEvidenceReportV02.runtimeReportId");
  assertOptionalUuid7(report.sourceBridgeId, "RuntimeEvidenceReportV02.sourceBridgeId");
  assertOptionalHashStringV02(report.sourceBundleHash, "RuntimeEvidenceReportV02.sourceBundleHash");
  assertOptionalString(report.sourceLocale, "RuntimeEvidenceReportV02.sourceLocale");
  assertOptionalString(report.targetLocale, "RuntimeEvidenceReportV02.targetLocale");
  assertString(report.adapterName, "RuntimeEvidenceReportV02.adapterName");
  assertString(report.adapterVersion, "RuntimeEvidenceReportV02.adapterVersion");
  assertEnum(
    report.fidelityTier,
    RUNTIME_FIDELITY_TIERS_V02,
    "RuntimeEvidenceReportV02.fidelityTier",
  );
  assertEnum(
    report.evidenceTier,
    RUNTIME_EVIDENCE_TIERS_V02,
    "RuntimeEvidenceReportV02.evidenceTier",
  );
  assertRuntimeEvidenceTierWithinFidelityV02(
    report.evidenceTier,
    report.fidelityTier,
    "RuntimeEvidenceReportV02",
  );
  const reportStatus = report.status;
  assertEnum(reportStatus, ["passed", "failed"] as const, "RuntimeEvidenceReportV02.status");
  if (report.runtimeCapabilities !== undefined) {
    assertRuntimeCapabilityContractV02(
      report.runtimeCapabilities,
      "RuntimeEvidenceReportV02.runtimeCapabilities",
      report.fidelityTier,
      report.evidenceTier,
    );
  }
  if (report.controlledPlaybackSession !== undefined) {
    assertControlledPlaybackSessionV02(
      report.controlledPlaybackSession,
      "RuntimeEvidenceReportV02.controlledPlaybackSession",
      report,
      reportStatus,
    );
  }
  assertRfc3339Instant(report.createdAt, "RuntimeEvidenceReportV02.createdAt");

  const traceEvents = asArray(report.traceEvents, "RuntimeEvidenceReportV02.traceEvents");
  for (const [index, event] of traceEvents.entries()) {
    assertRuntimeTraceEventV02(event, `RuntimeEvidenceReportV02.traceEvents[${index}]`);
  }

  const branchEvents = asArray(report.branchEvents, "RuntimeEvidenceReportV02.branchEvents");
  for (const [index, event] of branchEvents.entries()) {
    assertRuntimeBranchPointEventV02(event, `RuntimeEvidenceReportV02.branchEvents[${index}]`);
  }

  const observationHookEvents =
    report.observationHookEvents === undefined
      ? []
      : asArray(report.observationHookEvents, "RuntimeEvidenceReportV02.observationHookEvents");
  for (const [index, event] of observationHookEvents.entries()) {
    const label = `RuntimeEvidenceReportV02.observationHookEvents[${index}]`;
    assertObservationHookEvent(event, label);
    assertMaximumRuntimeEvidenceTierV02(
      (event as ObservationHookEvent).evidenceTier,
      report.evidenceTier,
      `${label}.evidenceTier`,
    );
  }

  const captures = asArray(report.captures, "RuntimeEvidenceReportV02.captures");
  for (const [index, capture] of captures.entries()) {
    assertRuntimeCaptureV02(capture, `RuntimeEvidenceReportV02.captures[${index}]`);
  }

  const recordings = asArray(report.recordings, "RuntimeEvidenceReportV02.recordings");
  for (const [index, recording] of recordings.entries()) {
    assertRuntimeRecordingV02(recording, `RuntimeEvidenceReportV02.recordings[${index}]`);
  }

  const approximations = asArray(report.approximations, "RuntimeEvidenceReportV02.approximations");
  for (const [index, approximation] of approximations.entries()) {
    assertRuntimeApproximationV02(
      approximation,
      `RuntimeEvidenceReportV02.approximations[${index}]`,
    );
  }

  const validationFindings = asArray(
    report.validationFindings,
    "RuntimeEvidenceReportV02.validationFindings",
  );
  for (const [index, finding] of validationFindings.entries()) {
    assertRuntimeValidationFindingV02(
      finding,
      `RuntimeEvidenceReportV02.validationFindings[${index}]`,
    );
  }

  const referenceComparisons =
    report.referenceComparisons === undefined
      ? []
      : asArray(report.referenceComparisons, "RuntimeEvidenceReportV02.referenceComparisons");
  for (const [index, comparison] of referenceComparisons.entries()) {
    assertRuntimeReferenceComparisonV02(
      comparison,
      `RuntimeEvidenceReportV02.referenceComparisons[${index}]`,
    );
  }
  const validatedReferenceComparisons = referenceComparisons as RuntimeReferenceComparisonV02[];

  assertStringArray(report.limitations, "RuntimeEvidenceReportV02.limitations");
  if (report.controlledPlaybackSession !== undefined) {
    assertControlledPlaybackSessionEvidenceSurfaceV02(
      (report.controlledPlaybackSession as ControlledPlaybackSessionV02).requestedOperation,
      {
        branchEvents,
        captures,
        recordings,
        referenceComparisons,
      },
      "RuntimeEvidenceReportV02.controlledPlaybackSession.requestedOperation",
    );
  }
  if (
    traceEvents.length === 0 &&
    observationHookEvents.length === 0 &&
    captures.length === 0 &&
    recordings.length === 0
  ) {
    throw new Error(
      "RuntimeEvidenceReportV02 must contain trace, observation hook, capture, or recording evidence",
    );
  }
  if (captures.length > 0) {
    assertMinimumRuntimeEvidenceTierV02(
      report.evidenceTier,
      "E2",
      "RuntimeEvidenceReportV02.evidenceTier",
    );
    if (report.runtimeCapabilities !== undefined) {
      assertRuntimeCapabilitySupportsFeatureV02(
        report.runtimeCapabilities as RuntimeCapabilityContractV02,
        "frame_capture",
        "RuntimeEvidenceReportV02.runtimeCapabilities",
      );
    }
  }
  if (recordings.length > 0) {
    assertMinimumRuntimeEvidenceTierV02(
      report.evidenceTier,
      "E3",
      "RuntimeEvidenceReportV02.evidenceTier",
    );
    if (report.runtimeCapabilities !== undefined) {
      assertRuntimeCapabilitySupportsFeatureV02(
        report.runtimeCapabilities as RuntimeCapabilityContractV02,
        "recording",
        "RuntimeEvidenceReportV02.runtimeCapabilities",
      );
    }
  }
  if (traceEvents.length > 0 && report.runtimeCapabilities !== undefined) {
    assertRuntimeCapabilitySupportsFeatureV02(
      report.runtimeCapabilities as RuntimeCapabilityContractV02,
      "text_trace",
      "RuntimeEvidenceReportV02.runtimeCapabilities",
    );
  }
  if (branchEvents.length > 0 && report.runtimeCapabilities !== undefined) {
    assertRuntimeCapabilitySupportsFeatureV02(
      report.runtimeCapabilities as RuntimeCapabilityContractV02,
      "branch_discovery",
      "RuntimeEvidenceReportV02.runtimeCapabilities",
    );
  }
  if (observationHookEvents.length > 0) {
    if (report.runtimeCapabilities === undefined) {
      throw new Error(
        "RuntimeEvidenceReportV02.runtimeCapabilities is required when observationHookEvents are present",
      );
    }
    assertRuntimeCapabilitySupportsFeatureV02(
      report.runtimeCapabilities as RuntimeCapabilityContractV02,
      "instrumentation_hooks",
      "RuntimeEvidenceReportV02.runtimeCapabilities",
    );
  }
  if (report.fidelityTier !== "reference_fidelity" && approximations.length === 0) {
    throw new Error(
      "RuntimeEvidenceReportV02.approximations must document non-reference runtime limits",
    );
  }
  if (
    (report.fidelityTier === "reference_fidelity" || report.evidenceTier === "E4") &&
    !validatedReferenceComparisons.some((comparison) => comparison.status === "passed")
  ) {
    throw new Error(
      "RuntimeEvidenceReportV02.referenceComparisons must include passed reference-runtime or conformance comparison evidence for E4/reference_fidelity claims",
    );
  }
  if (referenceComparisons.length > 0 && report.runtimeCapabilities !== undefined) {
    assertRuntimeCapabilitySupportsFeatureV02(
      report.runtimeCapabilities as RuntimeCapabilityContractV02,
      "reference_comparison",
      "RuntimeEvidenceReportV02.runtimeCapabilities",
    );
  }
  if (report.status === "failed" && validationFindings.length === 0) {
    throw new Error(
      "RuntimeEvidenceReportV02.validationFindings must explain failed runtime evidence",
    );
  }
}

export function assertRuntimeReport(
  value: unknown,
): asserts value is RuntimeVerificationReport | RuntimeEvidenceReportV02 {
  const report = asRecord(value, "RuntimeReport");
  if (report.schemaVersion === BRIDGE_SCHEMA_VERSION_V02) {
    assertRuntimeEvidenceReportV02(report);
    return;
  }
  assertRuntimeVerificationReport(report);
}

export function isUuid7(value: unknown): value is Uuid7 {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  );
}

export function assertRuntimeTraceEventV02(
  value: unknown,
  label: string,
): asserts value is RuntimeTraceEventV02 {
  const event = asRecord(value, label);
  assertUuid7(event.traceEventId, `${label}.traceEventId`);
  assertEnum(event.eventKind, RUNTIME_TRACE_EVENT_KINDS_V02, `${label}.eventKind`);
  assertRuntimeBridgeUnitRefV02(event.bridgeUnitRef, `${label}.bridgeUnitRef`);
  assertNonNegativeInteger(event.frame, `${label}.frame`);
  assertOptionalString(event.traceKey, `${label}.traceKey`);
  assertOptionalString(event.observedText, `${label}.observedText`);
  if (event.artifactRef !== undefined) {
    assertRuntimeArtifactRefV02(event.artifactRef, `${label}.artifactRef`);
  }
}

export function assertRuntimeBranchPointEventV02(
  value: unknown,
  label: string,
): asserts value is RuntimeBranchPointEventV02 {
  const event = asRecord(value, label);
  assertUuid7(event.branchEventId, `${label}.branchEventId`);
  assertRuntimeBridgeUnitRefV02(event.bridgeUnitRef, `${label}.bridgeUnitRef`);
  assertNonNegativeInteger(event.frame, `${label}.frame`);
  assertOptionalString(event.branchPointKey, `${label}.branchPointKey`);
  assertOptionalString(event.promptText, `${label}.promptText`);
  const options = asArray(event.options, `${label}.options`);
  if (options.length === 0) {
    throw new Error(`${label}.options must contain at least one branch option`);
  }
  const optionIds = new Set<Uuid7>();
  for (const [index, option] of options.entries()) {
    const optionLabel = `${label}.options[${index}]`;
    assertRuntimeBranchOptionV02(option, optionLabel);
    if (optionIds.has(option.optionId)) {
      throw new Error(`${optionLabel}.optionId must be unique within ${label}.options`);
    }
    optionIds.add(option.optionId);
  }
  assertOptionalUuid7(event.selectedOptionId, `${label}.selectedOptionId`);
  if (event.selectedOptionId !== undefined && !optionIds.has(event.selectedOptionId)) {
    throw new Error(`${label}.selectedOptionId must reference an option in ${label}.options`);
  }
}

export function assertRuntimeBranchOptionV02(
  value: unknown,
  label: string,
): asserts value is RuntimeBranchOptionV02 {
  const option = asRecord(value, label);
  assertUuid7(option.optionId, `${label}.optionId`);
  assertOptionalString(option.label, `${label}.label`);
  if (option.labelBridgeUnitRef !== undefined) {
    assertRuntimeBridgeUnitRefV02(option.labelBridgeUnitRef, `${label}.labelBridgeUnitRef`);
  }
  assertOptionalString(option.targetRouteKey, `${label}.targetRouteKey`);
  if (option.targetBridgeUnitRef !== undefined) {
    assertRuntimeBridgeUnitRefV02(option.targetBridgeUnitRef, `${label}.targetBridgeUnitRef`);
  }
}

export function assertRuntimeCaptureV02(
  value: unknown,
  label: string,
): asserts value is RuntimeCaptureV02 {
  const capture = asRecord(value, label);
  assertUuid7(capture.captureId, `${label}.captureId`);
  assertRuntimeBridgeUnitRefV02(capture.bridgeUnitRef, `${label}.bridgeUnitRef`);
  assertEnum(capture.evidenceTier, RUNTIME_EVIDENCE_TIERS_V02, `${label}.evidenceTier`);
  assertMinimumRuntimeEvidenceTierV02(capture.evidenceTier, "E2", `${label}.evidenceTier`);
  assertNonNegativeInteger(capture.frame, `${label}.frame`);
  assertPositiveInteger(capture.width, `${label}.width`);
  assertPositiveInteger(capture.height, `${label}.height`);
  if (capture.nonZeroPixels !== undefined) {
    assertNonNegativeInteger(capture.nonZeroPixels, `${label}.nonZeroPixels`);
  }
  if (capture.region !== undefined) {
    assertPixelRegionV02(capture.region, `${label}.region`);
  }
  assertRuntimeArtifactRefV02(capture.artifactRef, `${label}.artifactRef`, "screenshot");
}

export function assertRuntimeRecordingV02(
  value: unknown,
  label: string,
): asserts value is RuntimeRecordingV02 {
  const recording = asRecord(value, label);
  assertUuid7(recording.recordingId, `${label}.recordingId`);
  assertRuntimeBridgeUnitRefV02(recording.bridgeUnitRef, `${label}.bridgeUnitRef`);
  assertEnum(recording.evidenceTier, RUNTIME_EVIDENCE_TIERS_V02, `${label}.evidenceTier`);
  assertMinimumRuntimeEvidenceTierV02(recording.evidenceTier, "E3", `${label}.evidenceTier`);
  assertNonNegativeInteger(recording.startedAtFrame, `${label}.startedAtFrame`);
  assertPositiveInteger(recording.frameCount, `${label}.frameCount`);
  assertPositiveInteger(recording.width, `${label}.width`);
  assertPositiveInteger(recording.height, `${label}.height`);
  assertString(recording.encoding, `${label}.encoding`);
  assertRuntimeArtifactRefV02(recording.artifactRef, `${label}.artifactRef`, "recording");
}

export function assertRuntimeApproximationV02(
  value: unknown,
  label: string,
): asserts value is RuntimeApproximationV02 {
  const approximation = asRecord(value, label);
  assertUuid7(approximation.approximationId, `${label}.approximationId`);
  assertEnum(
    approximation.approximationTier,
    RUNTIME_APPROXIMATION_TIERS_V02,
    `${label}.approximationTier`,
  );
  assertString(approximation.scope, `${label}.scope`);
  assertString(approximation.description, `${label}.description`);
  const refs = asArray(approximation.affectedBridgeUnitRefs, `${label}.affectedBridgeUnitRefs`);
  if (refs.length === 0) {
    throw new Error(`${label}.affectedBridgeUnitRefs must contain at least one bridge unit ref`);
  }
  for (const [index, ref] of refs.entries()) {
    assertRuntimeBridgeUnitRefV02(ref, `${label}.affectedBridgeUnitRefs[${index}]`);
  }
  assertEnum(
    approximation.evidenceTierCeiling,
    RUNTIME_EVIDENCE_TIERS_V02,
    `${label}.evidenceTierCeiling`,
  );
}

export function assertRuntimeValidationFindingV02(
  value: unknown,
  label: string,
): asserts value is RuntimeValidationFindingV02 {
  const finding = asRecord(value, label);
  assertUuid7(finding.findingId, `${label}.findingId`);
  assertEnum(finding.findingKind, RUNTIME_VALIDATION_FINDING_KINDS_V02, `${label}.findingKind`);
  assertEnum(finding.severity, TRIAGE_SEVERITIES, `${label}.severity`);
  if (finding.bridgeUnitRef !== undefined) {
    assertRuntimeBridgeUnitRefV02(finding.bridgeUnitRef, `${label}.bridgeUnitRef`);
  }
  if (finding.artifactRef !== undefined) {
    assertRuntimeArtifactRefV02(finding.artifactRef, `${label}.artifactRef`);
  }
  assertString(finding.message, `${label}.message`);
  assertEnum(finding.evidenceTier, RUNTIME_EVIDENCE_TIERS_V02, `${label}.evidenceTier`);
}
