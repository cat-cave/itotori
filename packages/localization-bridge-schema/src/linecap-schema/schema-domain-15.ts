import {
  ASSET_KINDS,
  ASSET_POLICY_PATCH_MODES,
  ASSET_POLICY_SURFACE_KINDS,
  ASSET_POLICY_TEXT_SOURCE_KINDS,
  AssetPolicyPatchModeV02,
  POLICY_ACTIONS,
  RUNTIME_EVIDENCE_TIERS_V02,
  RUNTIME_FIDELITY_TIERS_V02,
  RuntimeCapabilityClassV02,
  RuntimeEvidenceTierV02,
  RuntimeFidelityTierV02,
  RuntimePlaybackFeatureV02,
  RuntimeRequestedOperationV02,
  SURFACE_KINDS,
  TEXTLESS_ASSET_POLICY_SURFACE_KINDS,
  Uuid7,
} from "./schema-domain-01.js";
import { PATCH_WRITE_MODES, PatchWriteModeV02 } from "./schema-domain-02.js";
import { AssetPolicyPatchRefV02, BridgeAssetV02 } from "./schema-domain-03.js";
import {
  AssetPolicyDecisionV02,
  LocaleBranchScopeV02,
  LocalizationUnitV02,
} from "./schema-domain-04.js";
import { RuntimeCapabilityContractV02 } from "./schema-domain-07.js";
import {
  RuntimeControlledPlaybackEvidenceSurfaceV02,
  assertRuntimeBridgeUnitRefV02,
} from "./schema-domain-14.js";
import {
  assertAssetRefV02,
  assertBridgeSpanV02,
  assertLocalizationPolicyV02,
  assertRevisionHashMatchesV02,
  assertSourceLocationV02,
  assertSourceRevisionV02,
  assertSpeakerContextV02,
} from "./schema-domain-16.js";
import {
  assertPatchRefV02,
  assertRuntimeExpectationV02,
  assertSurfaceContextV02,
} from "./schema-domain-17.js";
import {
  asArray,
  asRecord,
  assertHashStringV02,
  assertOptionalString,
  assertString,
  assertStringArray,
} from "./schema-domain-21.js";
import { assertBoolean, assertEnum, assertUuid7 } from "./schema-domain-22.js";

export function assertControlledPlaybackSessionEvidenceSurfaceV02(
  requestedOperation: RuntimeRequestedOperationV02,
  evidence: Record<RuntimeControlledPlaybackEvidenceSurfaceV02, readonly unknown[]>,
  label: string,
): void {
  const forbiddenEvidenceByOperation: Record<
    RuntimeRequestedOperationV02,
    readonly RuntimeControlledPlaybackEvidenceSurfaceV02[]
  > = {
    trace: ["branchEvents", "captures", "recordings", "referenceComparisons"],
    branch_discovery: ["captures", "recordings", "referenceComparisons"],
    capture: ["branchEvents", "recordings", "referenceComparisons"],
    smoke_validation: [],
  };
  const evidenceLabelBySurface: Record<RuntimeControlledPlaybackEvidenceSurfaceV02, string> = {
    branchEvents: "branch event",
    captures: "capture",
    recordings: "recording",
    referenceComparisons: "reference comparison",
  };

  for (const surface of forbiddenEvidenceByOperation[requestedOperation]) {
    if (evidence[surface].length > 0) {
      throw new Error(
        `${label} ${requestedOperation} must not carry ${evidenceLabelBySurface[surface]} evidence`,
      );
    }
  }
}

export function assertRuntimeCapabilitySupportsFeatureV02(
  contract: RuntimeCapabilityContractV02,
  feature: RuntimePlaybackFeatureV02,
  label: string,
): void {
  const declaration = contract.features.find((entry) => entry.feature === feature);
  if (declaration === undefined || declaration.status === "unsupported") {
    throw new Error(`${label} must advertise supported or partial ${feature} capability`);
  }
}

export function assertRuntimeCapabilityClassCeilingV02(
  capabilityClass: RuntimeCapabilityClassV02,
  fidelityTierCeiling: RuntimeFidelityTierV02,
  evidenceTierCeiling: RuntimeEvidenceTierV02,
  label: string,
): void {
  const fidelityCeilingByClass: Record<RuntimeCapabilityClassV02, RuntimeFidelityTierV02> = {
    static_trace: "trace_only",
    launch_capture: "layout_probe",
    instrumented_runtime: "replay_review",
    partial_vm: "replay_review",
    reference_vm: "reference_fidelity",
  };
  const evidenceCeilingByClass: Record<RuntimeCapabilityClassV02, RuntimeEvidenceTierV02> = {
    static_trace: "E1",
    launch_capture: "E2",
    instrumented_runtime: "E3",
    partial_vm: "E3",
    reference_vm: "E4",
  };
  assertMaximumRuntimeFidelityTierV02(
    fidelityTierCeiling,
    fidelityCeilingByClass[capabilityClass],
    `${label}.fidelityTierCeiling`,
  );
  assertMaximumRuntimeEvidenceTierV02(
    evidenceTierCeiling,
    evidenceCeilingByClass[capabilityClass],
    `${label}.evidenceTierCeiling`,
  );
}

export function assertRuntimeEvidenceTierWithinFidelityV02(
  evidenceTier: RuntimeEvidenceTierV02,
  fidelityTier: RuntimeFidelityTierV02,
  label: string,
): void {
  const ceilingByFidelity: Record<RuntimeFidelityTierV02, RuntimeEvidenceTierV02> = {
    trace_only: "E1",
    layout_probe: "E2",
    replay_review: "E3",
    reference_fidelity: "E4",
  };
  assertMaximumRuntimeEvidenceTierV02(
    evidenceTier,
    ceilingByFidelity[fidelityTier],
    `${label}.evidenceTier`,
  );
}

export function assertMaximumRuntimeFidelityTierV02(
  actual: RuntimeFidelityTierV02,
  maximum: RuntimeFidelityTierV02,
  label: string,
): void {
  if (runtimeFidelityTierRankV02(actual) > runtimeFidelityTierRankV02(maximum)) {
    throw new Error(`${label} must not exceed ${maximum} for the declared runtime capability`);
  }
}

export function assertMinimumRuntimeEvidenceTierV02(
  actual: RuntimeEvidenceTierV02,
  minimum: RuntimeEvidenceTierV02,
  label: string,
): void {
  if (runtimeEvidenceTierRankV02(actual) < runtimeEvidenceTierRankV02(minimum)) {
    throw new Error(`${label} must be at least ${minimum}`);
  }
}

export function assertMaximumRuntimeEvidenceTierV02(
  actual: RuntimeEvidenceTierV02,
  maximum: RuntimeEvidenceTierV02,
  label: string,
): void {
  if (runtimeEvidenceTierRankV02(actual) > runtimeEvidenceTierRankV02(maximum)) {
    throw new Error(`${label} must not exceed ${maximum} for the declared fidelityTier`);
  }
}

export function runtimeEvidenceTierRankV02(tier: RuntimeEvidenceTierV02): number {
  return RUNTIME_EVIDENCE_TIERS_V02.indexOf(tier);
}

export function runtimeFidelityTierRankV02(tier: RuntimeFidelityTierV02): number {
  return RUNTIME_FIDELITY_TIERS_V02.indexOf(tier);
}

export function assertPortableArtifactUriV02(
  value: unknown,
  label: string,
): asserts value is string {
  assertString(value, label);
  if (value.startsWith("data:")) {
    throw new Error(`${label} must reference an artifact, not embed artifact bytes`);
  }
  if (value.startsWith("file:") || value.startsWith("/")) {
    throw new Error(`${label} must be portable and must not be an absolute local path`);
  }
  if (/^[A-Za-z]:[\\/]/.test(value) || value.includes("\\")) {
    throw new Error(`${label} must use portable forward-slash artifact paths`);
  }
}

export function assertPortableRuntimeArtifactUriV02(
  value: unknown,
  label: string,
): asserts value is string {
  assertPortableArtifactUriV02(value, label);
  const hasScheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
  const hasDotSegment = value.split("/").some((segment) => segment === "." || segment === "..");
  if (hasScheme || hasDotSegment) {
    throw new Error(`${label} must be a portable relative runtime artifact path`);
  }
}

export function assertPortablePublicArtifactUriV02(
  value: unknown,
  label: string,
): asserts value is string {
  assertPortableArtifactUriV02(value, label);
  if ((value as string).includes("fixtures/private-local/")) {
    throw new Error(`${label} must not reference fixtures/private-local`);
  }
}

export function assertBridgeAssetV02(
  value: unknown,
  label: string,
): asserts value is BridgeAssetV02 {
  const asset = asRecord(value, label);
  assertUuid7(asset.assetId, `${label}.assetId`);
  assertString(asset.assetKey, `${label}.assetKey`);
  assertEnum(asset.assetKind, ASSET_KINDS, `${label}.assetKind`);
  assertHashStringV02(asset.sourceHash, `${label}.sourceHash`);
  assertSourceRevisionV02(asset.sourceRevision, `${label}.sourceRevision`);
  assertRevisionHashMatchesV02(asset.sourceRevision, asset.sourceHash, `${label}.sourceRevision`);
  assertOptionalString(asset.path, `${label}.path`);
}

export function assertLocalizationUnitV02(
  value: unknown,
  label: string,
): asserts value is LocalizationUnitV02 {
  const unit = asRecord(value, label);
  assertUuid7(unit.bridgeUnitId, `${label}.bridgeUnitId`);
  assertUuid7(unit.surfaceId, `${label}.surfaceId`);
  assertEnum(unit.surfaceKind, SURFACE_KINDS, `${label}.surfaceKind`);
  assertString(unit.sourceUnitKey, `${label}.sourceUnitKey`);
  assertString(unit.occurrenceId, `${label}.occurrenceId`);
  assertString(unit.sourceLocale, `${label}.sourceLocale`);
  assertString(unit.sourceText, `${label}.sourceText`);
  assertHashStringV02(unit.sourceHash, `${label}.sourceHash`);
  assertSourceRevisionV02(unit.sourceRevision, `${label}.sourceRevision`);
  assertAssetRefV02(unit.sourceAssetRef, `${label}.sourceAssetRef`);
  assertSourceLocationV02(unit.sourceLocation, `${label}.sourceLocation`);
  if (unit.speaker !== undefined) {
    assertSpeakerContextV02(unit.speaker, `${label}.speaker`);
  }
  assertSurfaceContextV02(unit.context, `${label}.context`, unit.surfaceKind);
  if (unit.policy !== undefined) {
    assertLocalizationPolicyV02(unit.policy, `${label}.policy`);
  }
  const spans = asArray(unit.spans, `${label}.spans`);
  for (const [index, span] of spans.entries()) {
    assertBridgeSpanV02(span, `${label}.spans[${index}]`, unit.sourceText);
  }
  assertPatchRefV02(unit.patchRef, `${label}.patchRef`);
  assertRuntimeExpectationV02(unit.runtimeExpectation, `${label}.runtimeExpectation`);
}

export function assertLocalizationUnitAssetRefsExist(
  unit: LocalizationUnitV02,
  label: string,
  assetIds: ReadonlySet<Uuid7>,
): void {
  assertKnownAssetIdV02(unit.sourceAssetRef.assetId, `${label}.sourceAssetRef.assetId`, assetIds);
  assertKnownAssetIdV02(unit.patchRef.assetId, `${label}.patchRef.assetId`, assetIds);

  const audioAssetRef = unit.context.song?.audioAssetRef;
  if (audioAssetRef !== undefined) {
    assertKnownAssetIdV02(
      audioAssetRef.assetId,
      `${label}.context.song.audioAssetRef.assetId`,
      assetIds,
    );
  }
}

export function assertKnownAssetIdV02(
  assetId: Uuid7,
  label: string,
  assetIds: ReadonlySet<Uuid7>,
): void {
  if (!assetIds.has(assetId)) {
    throw new Error(`${label} must reference an asset in BridgeBundleV02.assets`);
  }
}

export function assertLocaleBranchScopeV02(
  value: unknown,
  label: string,
): asserts value is LocaleBranchScopeV02 {
  const scope = asRecord(value, label);
  assertUuid7(scope.localeBranchId, `${label}.localeBranchId`);
  assertString(scope.targetLocale, `${label}.targetLocale`);
  assertOptionalString(scope.localeBranchKey, `${label}.localeBranchKey`);
}

export function assertAssetPolicyDecisionV02(
  value: unknown,
  label: string,
): asserts value is AssetPolicyDecisionV02 {
  const decision = asRecord(value, label);
  assertUuid7(decision.assetPolicyDecisionId, `${label}.assetPolicyDecisionId`);
  assertEnum(decision.assetSurfaceKind, ASSET_POLICY_SURFACE_KINDS, `${label}.assetSurfaceKind`);
  assertAssetRefV02(decision.sourceAssetRef, `${label}.sourceAssetRef`);
  if (decision.sourceLocation !== undefined) {
    assertSourceLocationV02(decision.sourceLocation, `${label}.sourceLocation`);
  }
  assertOptionalString(decision.sourceText, `${label}.sourceText`);
  assertHashStringV02(decision.sourceHash, `${label}.sourceHash`);
  assertSourceRevisionV02(decision.sourceRevision, `${label}.sourceRevision`);
  assertEnum(decision.policyAction, POLICY_ACTIONS, `${label}.policyAction`);
  assertOptionalString(decision.targetText, `${label}.targetText`);
  assertOptionalString(decision.romanizationSystem, `${label}.romanizationSystem`);
  assertOptionalString(decision.preserveForm, `${label}.preserveForm`);
  assertString(decision.policyReason, `${label}.policyReason`);
  assertEnum(decision.textSourceKind, ASSET_POLICY_TEXT_SOURCE_KINDS, `${label}.textSourceKind`);
  assertEnum(decision.patchMode, ASSET_POLICY_PATCH_MODES, `${label}.patchMode`);
  if (decision.patchRef !== undefined) {
    assertAssetPolicyPatchRefV02(decision.patchRef, `${label}.patchRef`);
  }
  assertRuntimeExpectationV02(decision.runtimeExpectation, `${label}.runtimeExpectation`);
  if (decision.reviewRequired !== undefined) {
    assertBoolean(decision.reviewRequired, `${label}.reviewRequired`);
  }
  if (decision.linkedBridgeUnitRefs !== undefined) {
    const refs = asArray(decision.linkedBridgeUnitRefs, `${label}.linkedBridgeUnitRefs`);
    for (const [index, ref] of refs.entries()) {
      assertRuntimeBridgeUnitRefV02(ref, `${label}.linkedBridgeUnitRefs[${index}]`);
    }
  }
  if (decision.notes !== undefined) {
    assertStringArray(decision.notes, `${label}.notes`);
  }

  const validatedDecision = decision as AssetPolicyDecisionV02;
  assertAssetPolicyActionFieldsV02(validatedDecision, label);
  assertAssetPolicyTextSourceV02(validatedDecision, label);
  assertAssetPolicyPatchModeV02(validatedDecision, label);
}

export function assertAssetPolicyPatchRefV02(
  value: unknown,
  label: string,
): asserts value is AssetPolicyPatchRefV02 {
  const patchRef = asRecord(value, label);
  assertUuid7(patchRef.assetId, `${label}.assetId`);
  assertEnum(patchRef.writeMode, PATCH_WRITE_MODES, `${label}.writeMode`);
  assertOptionalString(patchRef.sourceUnitKey, `${label}.sourceUnitKey`);
  assertSourceRevisionV02(patchRef.sourceRevision, `${label}.sourceRevision`);
  if (patchRef.constraints !== undefined) {
    assertStringArray(patchRef.constraints, `${label}.constraints`);
  }
}

export function assertAssetPolicyActionFieldsV02(
  decision: AssetPolicyDecisionV02,
  label: string,
): void {
  const hasTextSource = decision.textSourceKind !== "not_applicable";
  if (
    (decision.policyAction === "localize" || decision.policyAction === "romanize") &&
    hasTextSource &&
    decision.targetText === undefined
  ) {
    throw new Error(`${label}.targetText is required for localized or romanized asset text`);
  }
  if (decision.policyAction === "romanize" && decision.romanizationSystem === undefined) {
    throw new Error(`${label}.romanizationSystem is required for romanize asset policies`);
  }
  if (
    decision.policyAction === "do_not_translate" &&
    hasTextSource &&
    decision.preserveForm === undefined &&
    decision.sourceText === undefined
  ) {
    throw new Error(`${label}.preserveForm or sourceText is required for do_not_translate`);
  }
}

export function assertAssetPolicyTextSourceV02(
  decision: AssetPolicyDecisionV02,
  label: string,
): void {
  if (
    decision.textSourceKind === "not_applicable" &&
    !TEXTLESS_ASSET_POLICY_SURFACE_KINDS.includes(decision.assetSurfaceKind)
  ) {
    throw new Error(
      `${label}.textSourceKind not_applicable is only valid for textless asset policy surfaces`,
    );
  }
  if (decision.textSourceKind !== "not_applicable" && decision.sourceText === undefined) {
    throw new Error(`${label}.sourceText is required when textSourceKind is text-bearing`);
  }
  if (
    decision.textSourceKind === "ocr_hint" &&
    !["image_text", "ui_art", "video"].includes(decision.assetSurfaceKind)
  ) {
    throw new Error(`${label}.textSourceKind ocr_hint is only valid for visual asset surfaces`);
  }
}

export function assertAssetPolicyPatchModeV02(
  decision: AssetPolicyDecisionV02,
  label: string,
): void {
  if (
    decision.patchMode === "metadata_only" &&
    decision.runtimeExpectation.expectationKind !== "metadata_only"
  ) {
    throw new Error(
      `${label}.patchMode metadata_only requires runtimeExpectation.expectationKind metadata_only`,
    );
  }

  if (decision.patchRef === undefined) {
    return;
  }

  const expectedWriteModes: Partial<Record<AssetPolicyPatchModeV02, PatchWriteModeV02[]>> = {
    metadata_only: ["metadata"],
    region_redraw_required: ["update_region"],
    asset_replacement_required: ["replace_asset"],
    font_substitution_required: ["replace_asset", "metadata"],
  };
  const writeModes = expectedWriteModes[decision.patchMode];
  if (writeModes !== undefined && !writeModes.includes(decision.patchRef.writeMode)) {
    throw new Error(
      `${label}.patchRef.writeMode must be ${writeModes.join(" or ")} for ${decision.patchMode}`,
    );
  }
  if (decision.patchMode === "unsupported" || decision.patchMode === "no_patch_required") {
    throw new Error(`${label}.patchRef must be omitted for ${decision.patchMode}`);
  }
}
