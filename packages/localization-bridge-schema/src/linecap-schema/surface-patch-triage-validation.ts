import {
  BRIDGE_SCHEMA_VERSION_V02,
  POLICY_ACTIONS,
  POLICY_RECORD_KINDS,
  POLICY_SCOPES,
  SurfaceKindV02,
} from "./bridge-core-types.js";
import {
  PATCH_COMPATIBILITY_STATUSES_V02,
  PATCH_INCOMPATIBILITY_REASONS_V02,
  PATCH_WRITE_MODES,
  RUNTIME_EXPECTATION_KINDS,
  TRIAGE_EVENT_KINDS,
  TRIAGE_TASK_KINDS,
  UI_AREAS,
} from "./schema-enums.js";
import {
  ChoiceContextV02,
  DATABASE_KINDS,
  DatabaseContextV02,
  IMAGE_REPLACEMENT_MODES,
  ImageTextContextV02,
  METADATA_SCOPES,
  METADATA_VISIBILITIES,
  MetadataContextV02,
  PatchRefV02,
  RouteContextV02,
  RuntimeExpectationV02,
  SPEAKER_NAME_DISPLAY_CONTEXTS,
  SongContextV02,
  SpeakerNameContextV02,
  SurfaceContextV02,
  TutorialContextV02,
  UiContextV02,
} from "./bridge-context-types.js";
import {
  LocalizationUnitV02,
  PolicyRecordV02,
  TriageEventV02,
  TriageTaskV02,
} from "./localization-triage-types.js";
import {
  PatchExportEntryV02,
  PatchSourceCompatibilityReportV02,
  UnitSourceCompatibilityV02,
} from "./patch-and-runtime-types.js";
import {
  assertAssetRefV02,
  assertSourceRevisionV02,
} from "./asset-policy-and-source-validation.js";
import {
  assertCausalLinksV02,
  assertProvenanceArrayV02,
  assertTriageActorV02,
  assertTriageSubjectRefsV02,
} from "./triage-reference-validation.js";
import {
  asArray,
  asRecord,
  assertHashStringV02,
  assertOptionalHashStringV02,
  assertOptionalString,
  assertRfc3339Instant,
  assertString,
  assertStringArray,
} from "./fixture-utility-validation.js";
import {
  assertBoolean,
  assertEnum,
  assertEqual,
  assertNoMutableEventBucketFields,
  assertNonNegativeInteger,
  assertOptionalNonNegativeInteger,
  assertOptionalUuid7,
  assertPixelRegionV02,
  assertUuid7,
} from "./validation-primitives.js";

export function assertSurfaceContextV02(
  value: unknown,
  label: string,
  surfaceKind: SurfaceKindV02,
): asserts value is SurfaceContextV02 {
  const context = asRecord(value, label);
  if (context.route !== undefined) {
    assertRouteContextV02(context.route, `${label}.route`);
  }
  if (context.choice !== undefined) {
    assertChoiceContextV02(context.choice, `${label}.choice`);
  }
  if (context.ui !== undefined) {
    assertUiContextV02(context.ui, `${label}.ui`);
  }
  if (context.tutorial !== undefined) {
    assertTutorialContextV02(context.tutorial, `${label}.tutorial`);
  }
  if (context.database !== undefined) {
    assertDatabaseContextV02(context.database, `${label}.database`);
  }
  if (context.song !== undefined) {
    assertSongContextV02(context.song, `${label}.song`);
  }
  if (context.imageText !== undefined) {
    assertImageTextContextV02(context.imageText, `${label}.imageText`);
  }
  if (context.metadata !== undefined) {
    assertMetadataContextV02(context.metadata, `${label}.metadata`);
  }
  if (context.speakerName !== undefined) {
    assertSpeakerNameContextV02(context.speakerName, `${label}.speakerName`);
  }

  assertContextForSurfaceKind(context, surfaceKind, label);
}

export function assertContextForSurfaceKind(
  context: Record<string, unknown>,
  surfaceKind: SurfaceKindV02,
  label: string,
): void {
  const requiredContexts: Partial<Record<SurfaceKindV02, keyof SurfaceContextV02>> = {
    choice_label: "choice",
    ui_label: "ui",
    tutorial_text: "tutorial",
    database_entry: "database",
    song_title: "song",
    image_text: "imageText",
    metadata_text: "metadata",
    speaker_name: "speakerName",
  };
  const requiredContext = requiredContexts[surfaceKind];
  if (requiredContext !== undefined && context[requiredContext] === undefined) {
    throw new Error(`${label}.${requiredContext} is required for ${surfaceKind}`);
  }
}

export function assertRouteContextV02(
  value: unknown,
  label: string,
): asserts value is RouteContextV02 {
  const route = asRecord(value, label);
  assertOptionalUuid7(route.routeId, `${label}.routeId`);
  assertOptionalString(route.routeKey, `${label}.routeKey`);
  if (route.sceneId !== undefined) {
    assertString(route.sceneId, `${label}.sceneId`);
    if (route.sceneId.trim() === "") {
      throw new Error(`${label}.sceneId must be a non-empty producer-declared coordinate`);
    }
  }
  assertOptionalString(route.sceneKey, `${label}.sceneKey`);
  assertOptionalUuid7(route.branchId, `${label}.branchId`);
  assertOptionalString(route.branchKey, `${label}.branchKey`);
  assertOptionalString(route.position, `${label}.position`);
}

export function assertChoiceContextV02(
  value: unknown,
  label: string,
): asserts value is ChoiceContextV02 {
  const choice = asRecord(value, label);
  assertUuid7(choice.choiceGroupId, `${label}.choiceGroupId`);
  assertUuid7(choice.choiceId, `${label}.choiceId`);
  assertNonNegativeInteger(choice.optionIndex, `${label}.optionIndex`);
  assertOptionalString(choice.routeTargetRef, `${label}.routeTargetRef`);
}

export function assertUiContextV02(value: unknown, label: string): asserts value is UiContextV02 {
  const ui = asRecord(value, label);
  assertEnum(ui.uiArea, UI_AREAS, `${label}.uiArea`);
  assertOptionalString(ui.controlRef, `${label}.controlRef`);
  assertOptionalString(ui.layoutConstraint, `${label}.layoutConstraint`);
}

export function assertTutorialContextV02(
  value: unknown,
  label: string,
): asserts value is TutorialContextV02 {
  const tutorial = asRecord(value, label);
  assertString(tutorial.tutorialStepRef, `${label}.tutorialStepRef`);
  if (tutorial.inputActionRefs !== undefined) {
    assertStringArray(tutorial.inputActionRefs, `${label}.inputActionRefs`);
  }
  assertOptionalString(tutorial.platformCondition, `${label}.platformCondition`);
}

export function assertDatabaseContextV02(
  value: unknown,
  label: string,
): asserts value is DatabaseContextV02 {
  const database = asRecord(value, label);
  assertEnum(database.databaseKind, DATABASE_KINDS, `${label}.databaseKind`);
  assertString(database.entryId, `${label}.entryId`);
  assertString(database.fieldKey, `${label}.fieldKey`);
  assertOptionalString(database.sortKey, `${label}.sortKey`);
}

export function assertSongContextV02(
  value: unknown,
  label: string,
): asserts value is SongContextV02 {
  const song = asRecord(value, label);
  if (song.audioAssetRef !== undefined) {
    assertAssetRefV02(song.audioAssetRef, `${label}.audioAssetRef`);
  }
  assertOptionalString(song.trackId, `${label}.trackId`);
  assertString(song.titleField, `${label}.titleField`);
  if (song.creditRefs !== undefined) {
    assertStringArray(song.creditRefs, `${label}.creditRefs`);
  }
}

export function assertImageTextContextV02(
  value: unknown,
  label: string,
): asserts value is ImageTextContextV02 {
  const imageText = asRecord(value, label);
  assertPixelRegionV02(imageText.region, `${label}.region`);
  assertOptionalString(imageText.ocrText, `${label}.ocrText`);
  assertBoolean(imageText.editable, `${label}.editable`);
  assertEnum(imageText.replacementMode, IMAGE_REPLACEMENT_MODES, `${label}.replacementMode`);
}

export function assertMetadataContextV02(
  value: unknown,
  label: string,
): asserts value is MetadataContextV02 {
  const metadata = asRecord(value, label);
  assertEnum(metadata.metadataScope, METADATA_SCOPES, `${label}.metadataScope`);
  assertString(metadata.fieldKey, `${label}.fieldKey`);
  assertEnum(metadata.visibility, METADATA_VISIBILITIES, `${label}.visibility`);
}

export function assertSpeakerNameContextV02(
  value: unknown,
  label: string,
): asserts value is SpeakerNameContextV02 {
  const speakerName = asRecord(value, label);
  assertEnum(speakerName.displayContext, SPEAKER_NAME_DISPLAY_CONTEXTS, `${label}.displayContext`);
  assertOptionalString(speakerName.canonicalNameRef, `${label}.canonicalNameRef`);
}

export function assertRuntimeExpectationV02(
  value: unknown,
  label: string,
): asserts value is RuntimeExpectationV02 {
  const expectation = asRecord(value, label);
  assertEnum(expectation.expectationKind, RUNTIME_EXPECTATION_KINDS, `${label}.expectationKind`);
  if (expectation.region !== undefined) {
    assertPixelRegionV02(expectation.region, `${label}.region`);
  }
  assertOptionalString(expectation.traceKey, `${label}.traceKey`);
}

export function assertPatchRefV02(value: unknown, label: string): asserts value is PatchRefV02 {
  const patchRef = asRecord(value, label);
  assertUuid7(patchRef.assetId, `${label}.assetId`);
  assertEnum(patchRef.writeMode, PATCH_WRITE_MODES, `${label}.writeMode`);
  assertString(patchRef.sourceUnitKey, `${label}.sourceUnitKey`);
  assertSourceRevisionV02(patchRef.sourceRevision, `${label}.sourceRevision`);
  if (patchRef.constraints !== undefined) {
    assertStringArray(patchRef.constraints, `${label}.constraints`);
  }
}

export function assertPatchRefMatchesUnitV02(unit: LocalizationUnitV02, label: string): void {
  if (unit.patchRef.sourceUnitKey !== unit.sourceUnitKey) {
    throw new Error(`${label}.patchRef.sourceUnitKey must match ${label}.sourceUnitKey`);
  }
  if (unit.patchRef.sourceRevision.revisionId !== unit.sourceRevision.revisionId) {
    throw new Error(`${label}.patchRef.sourceRevision.revisionId must match unit sourceRevision`);
  }
  if (unit.patchRef.sourceRevision.value !== unit.sourceRevision.value) {
    throw new Error(`${label}.patchRef.sourceRevision.value must match unit sourceRevision`);
  }
}

export function assertPatchExportEntryV02(
  value: unknown,
  label: string,
): asserts value is PatchExportEntryV02 {
  const entry = asRecord(value, label);
  assertUuid7(entry.entryId, `${label}.entryId`);
  assertUuid7(entry.bridgeUnitId, `${label}.bridgeUnitId`);
  assertString(entry.sourceUnitKey, `${label}.sourceUnitKey`);
  assertHashStringV02(entry.sourceHash, `${label}.sourceHash`);
  assertSourceRevisionV02(entry.sourceRevision, `${label}.sourceRevision`);
  assertString(entry.targetText, `${label}.targetText`);
  const mappings = asArray(entry.protectedSpanMappings, `${label}.protectedSpanMappings`);
  // Optional v0.2 source identities identify one source occurrence when they
  // are supplied. Reusing an identity would make two target ranges claim that
  // occurrence; raw-only mappings intentionally carry no identity to track.
  const seenSourceSpanIds = new Set<string>();
  for (const [index, mapping] of mappings.entries()) {
    const mappingLabel = `${label}.protectedSpanMappings[${index}]`;
    const sourceSpanId = asRecord(mapping, mappingLabel).sourceSpanId;
    assertProtectedSpanMappingV02(mapping, mappingLabel);
    if (typeof sourceSpanId === "string") {
      if (seenSourceSpanIds.has(sourceSpanId)) {
        throw new Error(
          `${mappingLabel}.sourceSpanId duplicates an earlier protected-span source identity within ${label}: kaifuu.patch_export.duplicate_source_span_identity`,
        );
      }
      seenSourceSpanIds.add(sourceSpanId);
    }
  }
}

export function assertProtectedSpanMappingV02(value: unknown, label: string): void {
  const mapping = asRecord(value, label);
  assertString(mapping.raw, `${label}.raw`);
  assertOptionalUuid7(mapping.sourceSpanId, `${label}.sourceSpanId`);
  const sourceStartByte = mapping.sourceStartByte;
  const sourceEndByte = mapping.sourceEndByte;
  assertOptionalNonNegativeInteger(sourceStartByte, `${label}.sourceStartByte`);
  assertOptionalNonNegativeInteger(sourceEndByte, `${label}.sourceEndByte`);
  if ((sourceStartByte === undefined) !== (sourceEndByte === undefined)) {
    throw new Error(
      `${label}.sourceStartByte and ${label}.sourceEndByte must be provided together`,
    );
  }
  if (
    sourceStartByte !== undefined &&
    sourceEndByte !== undefined &&
    sourceEndByte <= sourceStartByte
  ) {
    throw new Error(`${label}.sourceEndByte must be greater than ${label}.sourceStartByte`);
  }
  const targetStart = mapping.targetStart;
  const targetEnd = mapping.targetEnd;
  assertNonNegativeInteger(targetStart, `${label}.targetStart`);
  assertNonNegativeInteger(targetEnd, `${label}.targetEnd`);
  if (targetEnd <= targetStart) {
    throw new Error(`${label}.targetEnd must be greater than ${label}.targetStart`);
  }
}

export function assertPatchSourceCompatibilityReportV02(
  value: unknown,
  label: string,
): asserts value is PatchSourceCompatibilityReportV02 {
  const report = asRecord(value, label);
  assertEqual(report.schemaVersion, BRIDGE_SCHEMA_VERSION_V02, `${label}.schemaVersion`);
  assertUuid7(report.patchExportId, `${label}.patchExportId`);
  assertUuid7(report.sourceBridgeId, `${label}.sourceBridgeId`);
  assertEnum(report.status, PATCH_COMPATIBILITY_STATUSES_V02, `${label}.status`);
  assertHashStringV02(report.expectedSourceBundleHash, `${label}.expectedSourceBundleHash`);
  assertHashStringV02(report.actualSourceBundleHash, `${label}.actualSourceBundleHash`);
  assertBoolean(report.sourceBundleHashMatches, `${label}.sourceBundleHashMatches`);
  if (
    report.sourceBundleHashMatches !==
    (report.expectedSourceBundleHash === report.actualSourceBundleHash)
  ) {
    throw new Error(`${label}.sourceBundleHashMatches must match source bundle hashes`);
  }
  const compatibleUnits = asArray(report.compatibleUnits, `${label}.compatibleUnits`);
  for (const [index, unit] of compatibleUnits.entries()) {
    const unitLabel = `${label}.compatibleUnits[${index}]`;
    assertUnitSourceCompatibilityV02(unit, unitLabel);
    if (unit.status !== "compatible") {
      throw new Error(`${unitLabel}.status must be compatible`);
    }
  }
  const incompatibleUnits = asArray(report.incompatibleUnits, `${label}.incompatibleUnits`);
  for (const [index, unit] of incompatibleUnits.entries()) {
    const unitLabel = `${label}.incompatibleUnits[${index}]`;
    assertUnitSourceCompatibilityV02(unit, unitLabel);
    if (unit.status !== "incompatible") {
      throw new Error(`${unitLabel}.status must be incompatible`);
    }
  }
  if (report.status === "compatible" && incompatibleUnits.length > 0) {
    throw new Error(`${label}.status cannot be compatible with incompatibleUnits`);
  }
  if (report.status === "incompatible" && incompatibleUnits.length === 0) {
    throw new Error(`${label}.status cannot be incompatible with empty incompatibleUnits`);
  }
}

export function assertUnitSourceCompatibilityV02(
  value: unknown,
  label: string,
): asserts value is UnitSourceCompatibilityV02 {
  const unit = asRecord(value, label);
  assertUuid7(unit.entryId, `${label}.entryId`);
  assertUuid7(unit.bridgeUnitId, `${label}.bridgeUnitId`);
  assertOptionalUuid7(unit.actualBridgeUnitId, `${label}.actualBridgeUnitId`);
  assertString(unit.sourceUnitKey, `${label}.sourceUnitKey`);
  assertEnum(unit.status, PATCH_COMPATIBILITY_STATUSES_V02, `${label}.status`);
  assertHashStringV02(unit.expectedSourceHash, `${label}.expectedSourceHash`);
  assertOptionalHashStringV02(unit.actualSourceHash, `${label}.actualSourceHash`);
  if (unit.reason !== undefined) {
    assertEnum(unit.reason, PATCH_INCOMPATIBILITY_REASONS_V02, `${label}.reason`);
  }
  if (unit.status === "incompatible" && unit.reason === undefined) {
    throw new Error(`${label}.reason is required for incompatible units`);
  }
  if (unit.status === "compatible" && unit.reason !== undefined) {
    throw new Error(`${label}.reason is only valid for incompatible units`);
  }
  if (unit.reason === "bridge_unit_id_mismatch" && unit.actualBridgeUnitId === undefined) {
    throw new Error(`${label}.actualBridgeUnitId is required for bridge_unit_id_mismatch`);
  }
  if (unit.reason !== "bridge_unit_id_mismatch" && unit.actualBridgeUnitId !== undefined) {
    throw new Error(`${label}.actualBridgeUnitId is only valid for bridge_unit_id_mismatch`);
  }
  if (unit.actualBridgeUnitId !== undefined && unit.actualBridgeUnitId === unit.bridgeUnitId) {
    throw new Error(`${label}.actualBridgeUnitId must differ from ${label}.bridgeUnitId`);
  }
}

export function assertPolicyRecordV02(
  value: unknown,
  label: string,
): asserts value is PolicyRecordV02 {
  const record = asRecord(value, label);
  assertUuid7(record.policyRecordId, `${label}.policyRecordId`);
  assertEnum(record.policyRecordKind, POLICY_RECORD_KINDS, `${label}.policyRecordKind`);
  assertEnum(record.policyAction, POLICY_ACTIONS, `${label}.policyAction`);
  assertString(record.termKey, `${label}.termKey`);
  assertString(record.sourceText, `${label}.sourceText`);
  assertOptionalString(record.targetLocale, `${label}.targetLocale`);
  assertOptionalUuid7(record.localeBranchId, `${label}.localeBranchId`);
  assertOptionalString(record.romanizationSystem, `${label}.romanizationSystem`);
  assertOptionalString(record.preserveForm, `${label}.preserveForm`);
  if (record.scope !== undefined) {
    assertEnum(record.scope, POLICY_SCOPES, `${label}.scope`);
  }
  assertString(record.policyReason, `${label}.policyReason`);
  if (record.reviewRequired !== undefined) {
    assertBoolean(record.reviewRequired, `${label}.reviewRequired`);
  }
  if (record.targetLocale === undefined && record.localeBranchId === undefined) {
    throw new Error(`${label} must include targetLocale or localeBranchId`);
  }
}

export function assertTriageEventV02(
  value: unknown,
  label: string,
): asserts value is TriageEventV02 {
  assertNoMutableEventBucketFields(value, label);
  const event = asRecord(value, label);
  assertUuid7(event.eventId, `${label}.eventId`);
  assertEnum(event.eventKind, TRIAGE_EVENT_KINDS, `${label}.eventKind`);
  assertRfc3339Instant(event.occurredAt, `${label}.occurredAt`);
  assertTriageActorV02(event.actor, `${label}.actor`);
  assertOptionalUuid7(event.taskId, `${label}.taskId`);
  assertOptionalUuid7(event.findingId, `${label}.findingId`);
  assertTriageSubjectRefsV02(event.subjectRefs, `${label}.subjectRefs`);
  assertProvenanceArrayV02(event.provenance, `${label}.provenance`);
  assertCausalLinksV02(event.causalLinks, `${label}.causalLinks`);
  if (event.payload !== undefined) {
    asRecord(event.payload, `${label}.payload`);
  }
}

export function assertTriageTaskV02(value: unknown, label: string): asserts value is TriageTaskV02 {
  const task = asRecord(value, label);
  assertUuid7(task.taskId, `${label}.taskId`);
  assertEnum(task.taskKind, TRIAGE_TASK_KINDS, `${label}.taskKind`);
  assertRfc3339Instant(task.createdAt, `${label}.createdAt`);
  assertString(task.summary, `${label}.summary`);
  assertOptionalUuid7(task.createdByEventId, `${label}.createdByEventId`);
  assertTriageSubjectRefsV02(task.inputRefs, `${label}.inputRefs`);
  assertProvenanceArrayV02(task.provenance, `${label}.provenance`);
  assertCausalLinksV02(task.causalLinks, `${label}.causalLinks`);
}
