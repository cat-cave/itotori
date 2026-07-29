import {
  BRIDGE_SCHEMA_VERSION_V02,
  OBSERVATION_HOOK_EVENT_KINDS,
  OBSERVATION_HOOK_SCHEMA_VERSION,
  OBSERVATION_REDACTION_STATUSES,
  ObservationHookEventKind,
  RUNTIME_ARTIFACT_KINDS_V02,
  RUNTIME_CAPABILITY_CLASSES_V02,
  RUNTIME_EVIDENCE_TIERS_V02,
  RUNTIME_FEATURE_STATUSES_V02,
  RUNTIME_FIDELITY_TIERS_V02,
  RUNTIME_PLAYBACK_FEATURES_V02,
  RUNTIME_REFERENCE_COMPARISON_KINDS_V02,
  RUNTIME_REFERENCE_COMPARISON_STATUSES_V02,
  RUNTIME_REQUESTED_OPERATIONS_V02,
  RuntimeArtifactKindV02,
  RuntimeEvidenceTierV02,
  RuntimeFidelityTierV02,
  RuntimePlaybackFeatureV02,
} from "./bridge-core-types.js";
import {
  RuntimeArtifactRefV02,
  RuntimeBridgeUnitRefV02,
  RuntimeReferenceComparisonV02,
} from "./bridge-context-types.js";
import {
  ControlledPlaybackSessionV02,
  ObservationAdapterId,
  ObservationArtifactRef,
  ObservationBridgeRef,
  ObservationChoiceOption,
  ObservationEnvironment,
  ObservationHookEvent,
  ObservationRedactionMetadata,
  ObservationSourceRevision,
  RuntimeCapabilityContractV02,
  RuntimeFeatureSupportV02,
} from "./patch-and-runtime-types.js";
import {
  assertMaximumRuntimeEvidenceTierV02,
  assertMaximumRuntimeFidelityTierV02,
  assertPortableArtifactUriV02,
  assertPortableRuntimeArtifactUriV02,
  assertRuntimeCapabilityClassCeilingV02,
  assertRuntimeCapabilitySupportsFeatureV02,
  assertRuntimeEvidenceTierWithinFidelityV02,
  runtimeEvidenceTierRankV02,
} from "./runtime-capability-and-unit-validation.js";
import {
  asArray,
  asRecord,
  assertNonBlankString,
  assertOptionalHashStringV02,
  assertOptionalString,
  assertRfc3339Instant,
  assertString,
  assertStringArray,
  isBlankString,
} from "./fixture-utility-validation.js";
import {
  assertBoolean,
  assertEnum,
  assertEqual,
  assertNonNegativeInteger,
  assertPositiveInteger,
  assertUuid7,
} from "./validation-primitives.js";

export function assertRuntimeReferenceComparisonV02(
  value: unknown,
  label: string,
): asserts value is RuntimeReferenceComparisonV02 {
  const comparison = asRecord(value, label);
  assertUuid7(comparison.comparisonId, `${label}.comparisonId`);
  assertEnum(
    comparison.comparisonKind,
    RUNTIME_REFERENCE_COMPARISON_KINDS_V02,
    `${label}.comparisonKind`,
  );
  assertEnum(comparison.status, RUNTIME_REFERENCE_COMPARISON_STATUSES_V02, `${label}.status`);
  assertString(comparison.scope, `${label}.scope`);
  const refs = asArray(comparison.coveredBridgeUnitRefs, `${label}.coveredBridgeUnitRefs`);
  if (refs.length === 0) {
    throw new Error(`${label}.coveredBridgeUnitRefs must contain at least one bridge unit ref`);
  }
  for (const [index, ref] of refs.entries()) {
    assertRuntimeBridgeUnitRefV02(ref, `${label}.coveredBridgeUnitRefs[${index}]`);
  }
  assertRuntimeArtifactRefV02(
    comparison.artifactRef,
    `${label}.artifactRef`,
    "reference_comparison",
  );
}

export function assertRuntimeBridgeUnitRefV02(
  value: unknown,
  label: string,
): asserts value is RuntimeBridgeUnitRefV02 {
  const ref = asRecord(value, label);
  assertString(ref.bridgeUnitId, `${label}.bridgeUnitId`);
  assertOptionalString(ref.sourceUnitKey, `${label}.sourceUnitKey`);
}

export function assertRuntimeArtifactRefV02(
  value: unknown,
  label: string,
  expectedKind?: RuntimeArtifactKindV02,
): asserts value is RuntimeArtifactRefV02 {
  const ref = asRecord(value, label);
  assertUuid7(ref.artifactId, `${label}.artifactId`);
  assertEnum(ref.artifactKind, RUNTIME_ARTIFACT_KINDS_V02, `${label}.artifactKind`);
  if (expectedKind !== undefined && ref.artifactKind !== expectedKind) {
    throw new Error(`${label}.artifactKind must be ${expectedKind}`);
  }
  assertPortableRuntimeArtifactUriV02(ref.uri, `${label}.uri`);
  assertOptionalHashStringV02(ref.hash, `${label}.hash`);
  assertOptionalString(ref.mediaType, `${label}.mediaType`);
  if (ref.byteSize !== undefined) {
    assertPositiveInteger(ref.byteSize, `${label}.byteSize`);
  }
}

export function assertObservationHookEvent(
  value: unknown,
  label: string,
): asserts value is ObservationHookEvent {
  const event = asRecord(value, label);
  assertEqual(event.schemaVersion, OBSERVATION_HOOK_SCHEMA_VERSION, `${label}.schemaVersion`);
  assertString(event.eventId, `${label}.eventId`);
  assertRfc3339Instant(event.observedAt, `${label}.observedAt`);
  assertEnum(event.eventKind, OBSERVATION_HOOK_EVENT_KINDS, `${label}.eventKind`);
  assertString(event.runtimeTargetId, `${label}.runtimeTargetId`);
  assertObservationAdapterId(event.adapterId, `${label}.adapterId`);
  assertEnum(event.evidenceTier, RUNTIME_EVIDENCE_TIERS_V02, `${label}.evidenceTier`);
  assertObservationEnvironment(event.environment, `${label}.environment`);
  if (event.sourceRevision !== undefined) {
    assertObservationSourceRevision(event.sourceRevision, `${label}.sourceRevision`);
  }
  if (event.bridgeRefs !== undefined) {
    const bridgeRefs = asArray(event.bridgeRefs, `${label}.bridgeRefs`);
    for (const [index, bridgeRef] of bridgeRefs.entries()) {
      assertObservationBridgeRef(bridgeRef, `${label}.bridgeRefs[${index}]`);
    }
  }
  assertObservationRedactionMetadata(event.redaction, `${label}.redaction`);
  const payloadKind = assertObservationHookPayload(event.payload, `${label}.payload`);
  if (event.eventKind !== payloadKind) {
    throw new Error(`${label}.eventKind must match ${label}.payload.payloadKind`);
  }
}

export function assertObservationAdapterId(
  value: unknown,
  label: string,
): asserts value is ObservationAdapterId {
  const adapterId = asRecord(value, label);
  assertString(adapterId.name, `${label}.name`);
  assertString(adapterId.version, `${label}.version`);
}

export function assertObservationEnvironment(
  value: unknown,
  label: string,
): asserts value is ObservationEnvironment {
  const environment = asRecord(value, label);
  assertString(environment.runtime, `${label}.runtime`);
  assertOptionalString(environment.engine, `${label}.engine`);
  assertOptionalString(environment.platform, `${label}.platform`);
  assertOptionalString(environment.display, `${label}.display`);
  assertOptionalString(environment.locale, `${label}.locale`);
}

export function assertObservationSourceRevision(
  value: unknown,
  label: string,
): asserts value is ObservationSourceRevision {
  const sourceRevision = asRecord(value, label);
  assertString(sourceRevision.sourceId, `${label}.sourceId`);
  assertOptionalString(sourceRevision.revisionId, `${label}.revisionId`);
  assertOptionalString(sourceRevision.contentHash, `${label}.contentHash`);
}

export function assertObservationBridgeRef(
  value: unknown,
  label: string,
): asserts value is ObservationBridgeRef {
  const bridgeRef = asRecord(value, label);
  assertOptionalString(bridgeRef.bridgeUnitId, `${label}.bridgeUnitId`);
  assertOptionalString(bridgeRef.sourceUnitKey, `${label}.sourceUnitKey`);
  assertOptionalString(bridgeRef.runtimeObjectId, `${label}.runtimeObjectId`);
  if (
    isBlankString(bridgeRef.bridgeUnitId) &&
    isBlankString(bridgeRef.sourceUnitKey) &&
    isBlankString(bridgeRef.runtimeObjectId)
  ) {
    throw new Error(`${label} must identify a bridge unit, source unit, or runtime object`);
  }
}

export function assertObservationRedactionMetadata(
  value: unknown,
  label: string,
): asserts value is ObservationRedactionMetadata {
  const redaction = asRecord(value, label);
  assertEnum(redaction.status, OBSERVATION_REDACTION_STATUSES, `${label}.status`);
  const rules = redaction.rules === undefined ? [] : asArray(redaction.rules, `${label}.rules`);
  const redactedFields =
    redaction.redactedFields === undefined
      ? []
      : asArray(redaction.redactedFields, `${label}.redactedFields`);
  for (const [index, rule] of rules.entries()) {
    assertNonBlankString(rule, `${label}.rules[${index}]`);
  }
  for (const [index, field] of redactedFields.entries()) {
    assertNonBlankString(field, `${label}.redactedFields[${index}]`);
  }
  if (redaction.status === "not_required" && (rules.length > 0 || redactedFields.length > 0)) {
    throw new Error(`${label} with status not_required must not declare redaction rules or fields`);
  }
  if (redaction.status === "redacted" && (rules.length === 0 || redactedFields.length === 0)) {
    throw new Error(`${label} with status redacted must declare rules and redactedFields`);
  }
}

export function assertObservationHookPayload(
  value: unknown,
  label: string,
): ObservationHookEventKind {
  const payload = asRecord(value, label);
  assertEnum(payload.payloadKind, OBSERVATION_HOOK_EVENT_KINDS, `${label}.payloadKind`);
  switch (payload.payloadKind) {
    case "text":
      assertString(payload.text, `${label}.text`);
      assertOptionalString(payload.speaker, `${label}.speaker`);
      assertOptionalString(payload.textSurface, `${label}.textSurface`);
      return "text";
    case "choice": {
      assertOptionalString(payload.prompt, `${label}.prompt`);
      const options = asArray(payload.options, `${label}.options`);
      if (options.length === 0) {
        throw new Error(`${label}.options must include at least one option`);
      }
      for (const [index, option] of options.entries()) {
        assertObservationChoiceOption(option, `${label}.options[${index}]`);
      }
      return "choice";
    }
    case "branch":
      assertString(payload.branchId, `${label}.branchId`);
      assertOptionalString(payload.label, `${label}.label`);
      assertOptionalString(payload.destination, `${label}.destination`);
      if (payload.taken !== undefined) {
        assertBoolean(payload.taken, `${label}.taken`);
      }
      return "branch";
    case "scene":
      assertString(payload.sceneId, `${label}.sceneId`);
      assertOptionalString(payload.sceneName, `${label}.sceneName`);
      return "scene";
    case "frame":
      assertNonNegativeInteger(payload.frame, `${label}.frame`);
      if (payload.width !== undefined) {
        assertPositiveInteger(payload.width, `${label}.width`);
      }
      if (payload.height !== undefined) {
        assertPositiveInteger(payload.height, `${label}.height`);
      }
      if (payload.artifactRef !== undefined) {
        assertObservationArtifactRef(payload.artifactRef, `${label}.artifactRef`);
      }
      return "frame";
    case "error":
      assertString(payload.errorType, `${label}.errorType`);
      assertString(payload.message, `${label}.message`);
      assertBoolean(payload.fatal, `${label}.fatal`);
      assertOptionalString(payload.stack, `${label}.stack`);
      return "error";
  }
}

export function assertObservationChoiceOption(
  value: unknown,
  label: string,
): asserts value is ObservationChoiceOption {
  const option = asRecord(value, label);
  assertString(option.optionId, `${label}.optionId`);
  assertString(option.label, `${label}.label`);
  if (option.bridgeRef !== undefined) {
    assertObservationBridgeRef(option.bridgeRef, `${label}.bridgeRef`);
  }
}

export function assertObservationArtifactRef(
  value: unknown,
  label: string,
): asserts value is ObservationArtifactRef {
  const artifactRef = asRecord(value, label);
  assertString(artifactRef.artifactId, `${label}.artifactId`);
  assertString(artifactRef.artifactKind, `${label}.artifactKind`);
  assertPortableArtifactUriV02(artifactRef.uri, `${label}.uri`);
  assertOptionalString(artifactRef.mediaType, `${label}.mediaType`);
}

export function assertRuntimeCapabilityContractV02(
  value: unknown,
  label: string,
  reportFidelityTier: RuntimeFidelityTierV02,
  reportEvidenceTier: RuntimeEvidenceTierV02,
): asserts value is RuntimeCapabilityContractV02 {
  const contract = asRecord(value, label);
  assertEqual(contract.contractVersion, BRIDGE_SCHEMA_VERSION_V02, `${label}.contractVersion`);
  assertEnum(contract.capabilityClass, RUNTIME_CAPABILITY_CLASSES_V02, `${label}.capabilityClass`);
  assertEnum(
    contract.fidelityTierCeiling,
    RUNTIME_FIDELITY_TIERS_V02,
    `${label}.fidelityTierCeiling`,
  );
  assertEnum(
    contract.evidenceTierCeiling,
    RUNTIME_EVIDENCE_TIERS_V02,
    `${label}.evidenceTierCeiling`,
  );
  assertRuntimeCapabilityClassCeilingV02(
    contract.capabilityClass,
    contract.fidelityTierCeiling,
    contract.evidenceTierCeiling,
    label,
  );
  assertRuntimeEvidenceTierWithinFidelityV02(
    contract.evidenceTierCeiling,
    contract.fidelityTierCeiling,
    label,
  );
  assertMaximumRuntimeFidelityTierV02(
    reportFidelityTier,
    contract.fidelityTierCeiling,
    "RuntimeEvidenceReportV02.fidelityTier",
  );
  assertMaximumRuntimeEvidenceTierV02(
    reportEvidenceTier,
    contract.evidenceTierCeiling,
    "RuntimeEvidenceReportV02.evidenceTier",
  );

  const features = asArray(contract.features, `${label}.features`);
  if (features.length === 0) {
    throw new Error(`${label}.features must include at least one runtime feature declaration`);
  }
  const seenFeatures = new Set<string>();
  for (const [index, feature] of features.entries()) {
    const featureLabel = `${label}.features[${index}]`;
    const featureRecord = assertRuntimeFeatureSupportV02(feature, featureLabel);
    if (seenFeatures.has(featureRecord.feature)) {
      throw new Error(`${featureLabel}.feature must be unique within runtime capability contract`);
    }
    seenFeatures.add(featureRecord.feature);
    if (
      featureRecord.evidenceTierCeiling !== undefined &&
      runtimeEvidenceTierRankV02(featureRecord.evidenceTierCeiling) >
        runtimeEvidenceTierRankV02(contract.evidenceTierCeiling)
    ) {
      throw new Error(
        `${featureLabel}.evidenceTierCeiling must not exceed contract evidenceTierCeiling`,
      );
    }
  }
  assertStringArray(contract.limitations, `${label}.limitations`);
}

export function assertRuntimeFeatureSupportV02(
  value: unknown,
  label: string,
): RuntimeFeatureSupportV02 {
  const feature = asRecord(value, label);
  assertEnum(feature.feature, RUNTIME_PLAYBACK_FEATURES_V02, `${label}.feature`);
  assertEnum(feature.status, RUNTIME_FEATURE_STATUSES_V02, `${label}.status`);
  if (feature.evidenceTierCeiling !== undefined) {
    assertEnum(
      feature.evidenceTierCeiling,
      RUNTIME_EVIDENCE_TIERS_V02,
      `${label}.evidenceTierCeiling`,
    );
  }
  if (feature.status === "unsupported" && feature.evidenceTierCeiling !== undefined) {
    throw new Error(
      `${label}.evidenceTierCeiling must be omitted for unsupported runtime features`,
    );
  }
  if (feature.status !== "unsupported" && feature.evidenceTierCeiling === undefined) {
    throw new Error(`${label}.evidenceTierCeiling is required for supported runtime features`);
  }
  assertString(feature.description, `${label}.description`);
  assertStringArray(feature.limitations, `${label}.limitations`);
  return feature as RuntimeFeatureSupportV02;
}

export function assertControlledPlaybackSessionV02(
  value: unknown,
  label: string,
  report: Record<string, unknown>,
  reportStatus: "passed" | "failed",
): asserts value is ControlledPlaybackSessionV02 {
  const session = asRecord(value, label);
  assertUuid7(session.sessionId, `${label}.sessionId`);
  assertString(session.adapterName, `${label}.adapterName`);
  assertString(session.adapterVersion, `${label}.adapterVersion`);
  if (session.adapterName !== report.adapterName) {
    throw new Error(`${label}.adapterName must match RuntimeEvidenceReportV02.adapterName`);
  }
  if (session.adapterVersion !== report.adapterVersion) {
    throw new Error(`${label}.adapterVersion must match RuntimeEvidenceReportV02.adapterVersion`);
  }
  assertEnum(session.capabilityClass, RUNTIME_CAPABILITY_CLASSES_V02, `${label}.capabilityClass`);
  assertEnum(
    session.requestedOperation,
    RUNTIME_REQUESTED_OPERATIONS_V02,
    `${label}.requestedOperation`,
  );
  assertEnum(session.status, ["passed", "failed"] as const, `${label}.status`);
  if (session.status !== reportStatus) {
    throw new Error(`${label}.status must match RuntimeEvidenceReportV02.status`);
  }
  assertEnum(session.fidelityTier, RUNTIME_FIDELITY_TIERS_V02, `${label}.fidelityTier`);
  assertEnum(session.evidenceTier, RUNTIME_EVIDENCE_TIERS_V02, `${label}.evidenceTier`);
  assertRuntimeEvidenceTierWithinFidelityV02(session.evidenceTier, session.fidelityTier, label);
  assertMaximumRuntimeFidelityTierV02(
    session.fidelityTier,
    report.fidelityTier as RuntimeFidelityTierV02,
    `${label}.fidelityTier`,
  );
  assertMaximumRuntimeEvidenceTierV02(
    session.evidenceTier,
    report.evidenceTier as RuntimeEvidenceTierV02,
    `${label}.evidenceTier`,
  );
  const featuresUsed = asArray(session.featuresUsed, `${label}.featuresUsed`);
  for (const [index, feature] of featuresUsed.entries()) {
    assertEnum(feature, RUNTIME_PLAYBACK_FEATURES_V02, `${label}.featuresUsed[${index}]`);
    if (report.runtimeCapabilities !== undefined) {
      assertRuntimeCapabilitySupportsFeatureV02(
        report.runtimeCapabilities as RuntimeCapabilityContractV02,
        feature as RuntimePlaybackFeatureV02,
        "RuntimeEvidenceReportV02.runtimeCapabilities",
      );
    }
  }
  if (
    report.runtimeCapabilities !== undefined &&
    session.capabilityClass !==
      (report.runtimeCapabilities as RuntimeCapabilityContractV02).capabilityClass
  ) {
    throw new Error(`${label}.capabilityClass must match runtimeCapabilities.capabilityClass`);
  }
  assertStringArray(session.limitations, `${label}.limitations`);
}

export type RuntimeControlledPlaybackEvidenceSurfaceV02 =
  | "branchEvents"
  | "captures"
  | "recordings"
  | "referenceComparisons";
