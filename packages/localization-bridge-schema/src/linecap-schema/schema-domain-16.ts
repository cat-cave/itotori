import {
  ASSET_KINDS,
  AssetKindV02,
  AssetPolicyPatchModeV02,
  AssetPolicySurfaceKindV02,
  POLICY_ACTIONS,
  PRESERVE_MODES,
  REGION_PATCH_ASSET_KINDS,
  SPAN_KINDS,
  Uuid7,
} from "./schema-domain-01.js";
import {
  HASH_ALGORITHMS,
  HASH_NORMALIZATIONS,
  HashNormalizationV02,
  HashScopeV02,
  SOURCE_REVISION_KINDS,
  SPEAKER_KNOWLEDGE_STATES,
  SPEAKER_REVEAL_STATES,
} from "./schema-domain-02.js";
import {
  AssetRefV02,
  BridgeAssetV02,
  BridgeSpanV02,
  HashRuleV02,
  HashStrategyV02,
  LocalizationPolicyV02,
  SourceGameRevisionV02,
  SourceLocationV02,
  SourceRevisionV02,
  SpeakerContextV02,
  SpeakerRevealStateV02,
  SpeakerTextColorV02,
} from "./schema-domain-03.js";
import { AssetPolicyDecisionV02 } from "./schema-domain-04.js";
import {
  asRecord,
  assertHashStringV02,
  assertOptionalBoolean,
  assertOptionalRfc3339Instant,
  assertOptionalString,
  assertString,
  assertStringArray,
} from "./schema-domain-21.js";
import {
  asByteRangeNumbers,
  assertByteRangeV02,
  assertEnum,
  assertEqual,
  assertOptionalUuid7,
  assertPixelRegionV02,
  assertSpanRawMatchesSource,
  assertUuid7,
} from "./schema-domain-22.js";

export function assertAssetPolicyDecisionAssetRefsExist(
  decision: AssetPolicyDecisionV02,
  label: string,
  assetsById: ReadonlyMap<Uuid7, BridgeAssetV02>,
): void {
  const sourceAsset = assetsById.get(decision.sourceAssetRef.assetId);
  if (sourceAsset === undefined) {
    throw new Error(
      `${label}.sourceAssetRef.assetId must reference an asset in asset policy assets`,
    );
  }
  assertAssetRefMatchesBridgeAssetV02(
    decision.sourceAssetRef,
    sourceAsset,
    `${label}.sourceAssetRef`,
  );
  assertAssetPolicySurfaceMatchesAssetKindV02(decision, sourceAsset, label);
  if (
    decision.sourceRevision.revisionId !== sourceAsset.sourceRevision.revisionId ||
    decision.sourceRevision.value !== sourceAsset.sourceRevision.value
  ) {
    throw new Error(`${label}.sourceRevision must match the referenced source asset revision`);
  }

  if (decision.patchRef !== undefined) {
    const patchAsset = assetsById.get(decision.patchRef.assetId);
    if (patchAsset === undefined) {
      throw new Error(`${label}.patchRef.assetId must reference an asset in asset policy assets`);
    }
    if (
      decision.patchRef.sourceRevision.revisionId !== patchAsset.sourceRevision.revisionId ||
      decision.patchRef.sourceRevision.value !== patchAsset.sourceRevision.value
    ) {
      throw new Error(`${label}.patchRef.sourceRevision must match the patch asset revision`);
    }
    assertAssetPolicyPatchAssetKindV02(decision, patchAsset, label);
  }
}

export function assertAssetRefMatchesBridgeAssetV02(
  ref: AssetRefV02,
  asset: BridgeAssetV02,
  label: string,
): void {
  if (ref.assetKey !== undefined && ref.assetKey !== asset.assetKey) {
    throw new Error(`${label}.assetKey must match the referenced asset`);
  }
}

export function assertAssetPolicySurfaceMatchesAssetKindV02(
  decision: AssetPolicyDecisionV02,
  sourceAsset: BridgeAssetV02,
  label: string,
): void {
  const allowedKinds = assetKindsForAssetPolicySurfaceKindV02(decision.assetSurfaceKind);
  if (!allowedKinds.includes(sourceAsset.assetKind)) {
    throw new Error(
      `${label}.assetSurfaceKind ${decision.assetSurfaceKind} is not valid for assetKind ${sourceAsset.assetKind}`,
    );
  }
}

export function assertAssetPolicyPatchAssetKindV02(
  decision: AssetPolicyDecisionV02,
  patchAsset: BridgeAssetV02,
  label: string,
): void {
  const allowedKinds = assetKindsForAssetPolicyPatchRefV02(decision);
  if (!allowedKinds.includes(patchAsset.assetKind)) {
    throw new Error(
      `${label}.patchRef.assetId assetKind ${patchAsset.assetKind} is not valid for ${decision.patchMode} on ${decision.assetSurfaceKind}`,
    );
  }
}

export function assetKindsForAssetPolicyPatchRefV02(
  decision: AssetPolicyDecisionV02,
): readonly AssetKindV02[] {
  const surfaceKinds = assetKindsForAssetPolicySurfaceKindV02(decision.assetSurfaceKind);
  const modeKinds = assetKindsForAssetPolicyPatchModeV02(decision.patchMode);
  return surfaceKinds.filter((kind) => modeKinds.includes(kind));
}

export function assetKindsForAssetPolicyPatchModeV02(
  patchMode: AssetPolicyPatchModeV02,
): readonly AssetKindV02[] {
  switch (patchMode) {
    case "metadata_only":
    case "asset_replacement_required":
      return ASSET_KINDS;
    case "region_redraw_required":
      return REGION_PATCH_ASSET_KINDS;
    case "font_substitution_required":
      return ["font"];
    case "no_patch_required":
    case "unsupported":
      return [];
  }
}

export function assetKindsForAssetPolicySurfaceKindV02(
  surfaceKind: AssetPolicySurfaceKindV02,
): readonly AssetKindV02[] {
  switch (surfaceKind) {
    case "image_text":
      return ["image", "ui_texture", "video"];
    case "ui_art":
      return ["ui_texture", "image"];
    case "song_title":
      return ["audio", "metadata"];
    case "font":
      return ["font"];
    case "credits":
      return ["metadata", "video"];
    case "video":
      return ["video"];
  }
}

export function assertHashStrategyV02(
  value: unknown,
  label: string,
): asserts value is HashStrategyV02 {
  const strategy = asRecord(value, label);
  const sourceProfile = strategy.sourceProfile;
  const sourceBundle = strategy.sourceBundle;
  const sourceAsset = strategy.sourceAsset;
  const sourceUnit = strategy.sourceUnit;
  const patchExport = strategy.patchExport;
  const deltaPackage = strategy.deltaPackage;
  assertHashRuleV02(sourceProfile, `${label}.sourceProfile`, "source_profile");
  assertHashRuleV02(sourceBundle, `${label}.sourceBundle`, "source_bundle");
  assertHashRuleV02(sourceAsset, `${label}.sourceAsset`, "source_asset");
  assertHashRuleV02(sourceUnit, `${label}.sourceUnit`, "source_unit");
  assertHashRuleV02(patchExport, `${label}.patchExport`, "patch_export");
  assertHashRuleV02(deltaPackage, `${label}.deltaPackage`, "delta_package");
  assertHashRuleNormalizationV02(sourceProfile, `${label}.sourceProfile`, [
    "utf8-lf-json-stable-v1",
  ]);
  assertHashRuleNormalizationV02(sourceBundle, `${label}.sourceBundle`, ["utf8-lf-json-stable-v1"]);
  assertHashRuleNormalizationV02(sourceAsset, `${label}.sourceAsset`, ["bytes"]);
  assertHashRuleNormalizationV02(sourceUnit, `${label}.sourceUnit`, ["utf8-lf-json-stable-v1"]);
  assertHashRuleNormalizationV02(patchExport, `${label}.patchExport`, ["utf8-lf-json-stable-v1"]);
  assertHashRuleNormalizationV02(deltaPackage, `${label}.deltaPackage`, ["utf8-lf-json-stable-v1"]);
  assertRequiredHashRuleFieldsV02(sourceUnit, `${label}.sourceUnit`);
}

export function assertHashRuleV02<Scope extends HashScopeV02>(
  value: unknown,
  label: string,
  scope: Scope,
): asserts value is HashRuleV02<Scope> {
  const rule = asRecord(value, label);
  assertEqual(rule.scope, scope, `${label}.scope`);
  assertEnum(rule.algorithm, HASH_ALGORITHMS, `${label}.algorithm`);
  assertEnum(rule.normalization, HASH_NORMALIZATIONS, `${label}.normalization`);
  if (rule.fields !== undefined) {
    assertStringArray(rule.fields, `${label}.fields`);
  }
}

export function assertHashRuleNormalizationV02(
  rule: HashRuleV02,
  label: string,
  allowedNormalizations: readonly HashNormalizationV02[],
): void {
  if (!allowedNormalizations.includes(rule.normalization)) {
    throw new Error(`${label}.normalization must be ${allowedNormalizations.join(" or ")}`);
  }
}

export function assertRequiredHashRuleFieldsV02(rule: HashRuleV02, label: string): void {
  if (rule.fields === undefined || rule.fields.length === 0) {
    throw new Error(`${label}.fields must not be empty`);
  }
}

export function assertSourceRevisionV02(
  value: unknown,
  label: string,
): asserts value is SourceRevisionV02 {
  const revision = asRecord(value, label);
  assertUuid7(revision.revisionId, `${label}.revisionId`);
  assertEnum(revision.revisionKind, SOURCE_REVISION_KINDS, `${label}.revisionKind`);
  assertString(revision.value, `${label}.value`);
  if (revision.revisionKind === "content_hash") {
    assertHashStringV02(revision.value, `${label}.value`);
  }
  assertOptionalRfc3339Instant(revision.createdAt, `${label}.createdAt`);
}

export function assertSourceGameRevisionV02(
  value: unknown,
  label: string,
): asserts value is SourceGameRevisionV02 {
  const sourceGame = asRecord(value, label);
  assertString(sourceGame.gameId, `${label}.gameId`);
  assertString(sourceGame.gameVersion, `${label}.gameVersion`);
  assertString(sourceGame.sourceProfileId, `${label}.sourceProfileId`);
  assertSourceRevisionV02(sourceGame.sourceProfileRevision, `${label}.sourceProfileRevision`);
}

export function assertRevisionHashMatchesV02(
  revision: SourceRevisionV02,
  hash: string,
  label: string,
): void {
  if (revision.revisionKind === "content_hash" && revision.value !== hash) {
    throw new Error(`${label}.value must equal the matching content hash`);
  }
}

export function assertAssetRefV02(value: unknown, label: string): asserts value is AssetRefV02 {
  const ref = asRecord(value, label);
  assertUuid7(ref.assetId, `${label}.assetId`);
  assertOptionalString(ref.assetKey, `${label}.assetKey`);
}

export function assertSourceLocationV02(
  value: unknown,
  label: string,
): asserts value is SourceLocationV02 {
  const location = asRecord(value, label);
  assertOptionalString(location.containerKey, `${label}.containerKey`);
  if (location.entryPath !== undefined) {
    assertStringArray(location.entryPath, `${label}.entryPath`);
  }
  if (location.range !== undefined) {
    assertByteRangeV02(location.range, `${label}.range`);
  }
  if (location.region !== undefined) {
    assertPixelRegionV02(location.region, `${label}.region`);
  }
}

export function assertSpeakerContextV02(
  value: unknown,
  label: string,
): asserts value is SpeakerContextV02 {
  const speaker = asRecord(value, label);
  assertEnum(speaker.knowledgeState, SPEAKER_KNOWLEDGE_STATES, `${label}.knowledgeState`);
  switch (speaker.knowledgeState) {
    case "known":
      assertUuid7(speaker.speakerId, `${label}.speakerId`);
      assertString(speaker.displayName, `${label}.displayName`);
      assertOptionalString(speaker.canonicalNameRef, `${label}.canonicalNameRef`);
      // `known` ⇒ `revealed` when present: a `concealed` label would leak the
      // real displayName through consumer fallbacks as a "reader-safe" string.
      assertOptionalSpeakerRevealState(speaker.revealState, `${label}.revealState`, "revealed");
      assertOptionalSpeakerTextColor(speaker.textColor, `${label}.textColor`);
      break;
    case "parser_unknown":
      assertOptionalString(speaker.rawSpeakerText, `${label}.rawSpeakerText`);
      assertOptionalString(speaker.evidence, `${label}.evidence`);
      // Genuinely unresolved speakers must not carry resolved-name fields; those
      // would invent an identity the producer never resolved.
      assertSpeakerFieldAbsent(speaker, "speakerId", label);
      assertSpeakerFieldAbsent(speaker, "displayName", label);
      assertSpeakerFieldAbsent(speaker, "readerLabel", label);
      assertSpeakerFieldAbsent(speaker, "canonicalNameRef", label);
      assertSpeakerFieldAbsent(speaker, "revealState", label);
      assertSpeakerFieldAbsent(speaker, "textColor", label);
      break;
    case "reader_unknown":
      assertUuid7(speaker.speakerId, `${label}.speakerId`);
      assertString(speaker.displayName, `${label}.displayName`);
      assertString(speaker.readerLabel, `${label}.readerLabel`);
      assertOptionalString(speaker.canonicalNameRef, `${label}.canonicalNameRef`);
      // `reader_unknown` ⇒ `concealed` when present.
      assertOptionalSpeakerRevealState(speaker.revealState, `${label}.revealState`, "concealed");
      assertOptionalSpeakerTextColor(speaker.textColor, `${label}.textColor`);
      break;
    case "not_applicable":
      break;
  }
}

/** Reject a field that must not appear on this speaker variant. */
export function assertSpeakerFieldAbsent(
  speaker: Record<string, unknown>,
  field: string,
  label: string,
): void {
  if (speaker[field] !== undefined) {
    throw new Error(
      `${label}.${field} must not be present when knowledgeState is ${String(speaker.knowledgeState)}`,
    );
  }
}

/** Validate the additive `revealState` extension when present: it must be one
 * of the reveal enum values AND match the knowledge-state invariant
 * (`known` ⇒ `revealed`, `reader_unknown` ⇒ `concealed`). A wrong value now
 * fails the contract rather than silently leaking a real name. */
export function assertOptionalSpeakerRevealState(
  value: unknown,
  label: string,
  required: SpeakerRevealStateV02,
): asserts value is SpeakerRevealStateV02 | undefined {
  if (value === undefined) {
    return;
  }
  assertEnum(value, SPEAKER_REVEAL_STATES, label);
  if (value !== required) {
    throw new Error(
      `${label} must be "${required}" for this knowledgeState, got ${JSON.stringify(value)}`,
    );
  }
}

/** Validate the additive `textColor` extension when present: exactly three
 * 8-bit RGB channels. A malformed triple now fails the contract rather than
 * surviving as an ignored unknown property, so the field round-trips through
 * a typed consumer. */
export function assertOptionalSpeakerTextColor(
  value: unknown,
  label: string,
): asserts value is SpeakerTextColorV02 | undefined {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error(`${label} must be an [r, g, b] triple`);
  }
  value.forEach((channel, index) => {
    if (typeof channel !== "number" || !Number.isInteger(channel) || channel < 0 || channel > 255) {
      throw new Error(`${label}[${index}] must be an integer in 0..=255`);
    }
  });
}

export function assertLocalizationPolicyV02(
  value: unknown,
  label: string,
): asserts value is LocalizationPolicyV02 {
  const policy = asRecord(value, label);
  assertEnum(policy.policyAction, POLICY_ACTIONS, `${label}.policyAction`);
  assertOptionalString(policy.targetLocale, `${label}.targetLocale`);
  assertOptionalUuid7(policy.localeBranchId, `${label}.localeBranchId`);
  assertOptionalString(policy.targetText, `${label}.targetText`);
  assertOptionalString(policy.romanizationSystem, `${label}.romanizationSystem`);
  assertOptionalString(policy.policyReason, `${label}.policyReason`);
  if (policy.targetLocale === undefined && policy.localeBranchId === undefined) {
    throw new Error(`${label} must include targetLocale or localeBranchId`);
  }
}

export function assertBridgeSpanV02(
  value: unknown,
  label: string,
  sourceText: string,
): asserts value is BridgeSpanV02 {
  const span = asRecord(value, label);
  assertUuid7(span.spanId, `${label}.spanId`);
  assertEnum(span.spanKind, SPAN_KINDS, `${label}.spanKind`);
  assertString(span.raw, `${label}.raw`);
  const [startByte, endByte] = asByteRangeNumbers(span.startByte, span.endByte, label);
  assertEnum(span.preserveMode, PRESERVE_MODES, `${label}.preserveMode`);
  assertOptionalString(span.parsedName, `${label}.parsedName`);
  assertOptionalBoolean(span.outOfBand, `${label}.outOfBand`);
  if (span.arguments !== undefined) {
    assertStringArray(span.arguments, `${label}.arguments`);
  }
  assertOptionalString(span.variableName, `${label}.variableName`);
  assertOptionalString(span.formatHint, `${label}.formatHint`);
  if (span.exampleValues !== undefined) {
    assertStringArray(span.exampleValues, `${label}.exampleValues`);
  }
  if (span.policy !== undefined) {
    assertLocalizationPolicyV02(span.policy, `${label}.policy`);
  }
  assertSpanRawMatchesSource(sourceText, span.raw, startByte, endByte, label);

  if (span.spanKind === "ruby_annotation") {
    asByteRangeNumbers(span.baseStartByte, span.baseEndByte, `${label}.base`);
    asByteRangeNumbers(span.annotationStartByte, span.annotationEndByte, `${label}.annotation`);
    assertString(span.annotationText, `${label}.annotationText`);
    assertOptionalString(span.annotationLocale, `${label}.annotationLocale`);
    assertOptionalString(span.displayMode, `${label}.displayMode`);
  }
}
