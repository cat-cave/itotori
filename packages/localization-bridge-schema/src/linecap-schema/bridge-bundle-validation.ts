import { BRIDGE_FORMAT_STABILITY, assertFormatVersion } from "./dependencies.js";
import {
  BRIDGE_SCHEMA_VERSION_V02,
  BridgeBundle,
  BridgeUnit,
  LEGACY_PROTECTED_SPAN_KINDS,
  PRESERVE_MODES,
  ProtectedSpan,
  Uuid7,
} from "./bridge-core-types.js";
import { ContractCompatibilityStatusV02, ContractFixtureKindV02 } from "./schema-enums.js";
import { BridgeAssetV02 } from "./bridge-context-types.js";
import {
  AssetPolicyBundleV02,
  FindingRecordV02,
  TriageBundleV02,
  TriageEventV02,
  TriageTaskV02,
} from "./localization-triage-types.js";
import { BridgeBundleV02 } from "./benchmark-rubric-and-bundle-types.js";
import {
  assertAssetPolicyDecisionV02,
  assertBridgeAssetV02,
  assertLocaleBranchScopeV02,
  assertLocalizationUnitAssetRefsExist,
  assertLocalizationUnitV02,
} from "./runtime-capability-and-unit-validation.js";
import {
  assertAssetPolicyDecisionAssetRefsExist,
  assertHashStrategyV02,
  assertRevisionHashMatchesV02,
  assertSourceGameRevisionV02,
  assertSourceRevisionV02,
} from "./asset-policy-and-source-validation.js";
import {
  assertPatchRefMatchesUnitV02,
  assertPolicyRecordV02,
  assertTriageEventV02,
  assertTriageTaskV02,
} from "./surface-patch-triage-validation.js";
import {
  assertEventLinksReferToPriorEvents,
  assertFindingRecordV02,
  assertTriageBundleReferencesV02,
  buildTriageBundleReferenceIndexV02,
} from "./triage-reference-validation.js";
import {
  asArray,
  asRecord,
  assertExtractor,
  assertHashStringV02,
  assertOptionalHashStringV02,
  assertOptionalString,
  assertString,
  assertStringArray,
} from "./fixture-utility-validation.js";
import {
  asByteRangeNumbers,
  assertEnum,
  assertEqual,
  assertNoConfidenceFields,
  assertOptionalUuid7,
  assertSpanRawMatchesSource,
  assertUuid7,
} from "./validation-primitives.js";

export type ContractCompatibilityCoverageV02 = {
  kind: ContractFixtureKindV02;
  typescriptValidator: string;
  rustValidator: string;
  validFixtures: string[];
  invalidFixtures: string[];
  status: ContractCompatibilityStatusV02;
};

export type ContractCompatibilityCrossRefV02 = {
  from: string;
  to: string;
  rule: string;
};

export type ContractCompatibilityReportV02 = {
  schemaVersion: typeof BRIDGE_SCHEMA_VERSION_V02;
  reportId: Uuid7;
  generatedAt: string;
  suiteManifestPath: string;
  sourceOfTruth: string;
  typescriptCommand: string[];
  rustCommand: string[];
  overallStatus: ContractCompatibilityStatusV02;
  coverage: ContractCompatibilityCoverageV02[];
  crossContractRefs: ContractCompatibilityCrossRefV02[];
  notes: string[];
};

export function assertBridgeBundle(value: unknown): asserts value is BridgeBundle {
  const bundle = asRecord(value, "BridgeBundle");
  assertEqual(bundle.schemaVersion, "0.1.0", "BridgeBundle.schemaVersion");
  assertString(bundle.bridgeId, "BridgeBundle.bridgeId");
  assertString(bundle.sourceBundleHash, "BridgeBundle.sourceBundleHash");
  assertString(bundle.sourceLocale, "BridgeBundle.sourceLocale");
  const units = asArray(bundle.units, "BridgeBundle.units");
  for (const [index, unit] of units.entries()) {
    assertBridgeUnit(unit, `BridgeBundle.units[${index}]`);
  }
}

export function assertBridgeUnit(value: unknown, label: string): asserts value is BridgeUnit {
  const unit = asRecord(value, label);
  assertString(unit.bridgeUnitId, `${label}.bridgeUnitId`);
  assertString(unit.sourceUnitKey, `${label}.sourceUnitKey`);
  assertString(unit.occurrenceId, `${label}.occurrenceId`);
  assertString(unit.sourceHash, `${label}.sourceHash`);
  assertString(unit.sourceLocale, `${label}.sourceLocale`);
  assertString(unit.sourceText, `${label}.sourceText`);
  if (unit.speaker !== undefined && typeof unit.speaker !== "string") {
    throw new Error(`${label}.speaker must be a string`);
  }
  assertString(unit.textSurface, `${label}.textSurface`);
  const spans = asArray(unit.protectedSpans, `${label}.protectedSpans`);
  for (const [index, span] of spans.entries()) {
    assertProtectedSpan(span, `${label}.protectedSpans[${index}]`, unit.sourceText);
  }
  if (unit.context !== undefined) {
    const context = asRecord(unit.context, `${label}.context`);
    const route = asRecord(context.route, `${label}.context.route`);
    assertString(route.sceneId, `${label}.context.route.sceneId`);
  }
  const patchRef = asRecord(unit.patchRef, `${label}.patchRef`);
  assertString(patchRef.assetId, `${label}.patchRef.assetId`);
  assertEqual(patchRef.writeMode, "replace", `${label}.patchRef.writeMode`);
  assertString(patchRef.sourceUnitKey, `${label}.patchRef.sourceUnitKey`);
}

export function assertProtectedSpan(
  value: unknown,
  label: string,
  sourceText: string,
): asserts value is ProtectedSpan {
  const span = asRecord(value, label);
  assertEnum(span.kind, LEGACY_PROTECTED_SPAN_KINDS, `${label}.kind`);
  assertString(span.raw, `${label}.raw`);
  const [startByte, endByte] = asByteRangeNumbers(span.start, span.end, label);
  assertEnum(span.preserveMode, PRESERVE_MODES, `${label}.preserveMode`);
  assertOptionalString(span.parsedName, `${label}.parsedName`);
  if (span.arguments !== undefined) {
    assertStringArray(span.arguments, `${label}.arguments`);
  }
  assertOptionalString(span.variableName, `${label}.variableName`);
  assertOptionalString(span.formatHint, `${label}.formatHint`);
  if (span.exampleValues !== undefined) {
    assertStringArray(span.exampleValues, `${label}.exampleValues`);
  }
  assertSpanRawMatchesSource(sourceText, span.raw, startByte, endByte, label);

  if (span.kind === "ruby_annotation") {
    asByteRangeNumbers(span.baseStartByte, span.baseEndByte, `${label}.base`);
    asByteRangeNumbers(span.annotationStartByte, span.annotationEndByte, `${label}.annotation`);
    assertString(span.annotationText, `${label}.annotationText`);
    assertOptionalString(span.annotationLocale, `${label}.annotationLocale`);
    assertOptionalString(span.displayMode, `${label}.displayMode`);
  }
}

export function assertBridgeBundleV02(value: unknown): asserts value is BridgeBundleV02 {
  const bundle = asRecord(value, "BridgeBundleV02");
  // Version-negotiation on load (beta-schema-stability-policy): a version
  // mismatch is a typed FormatVersionMismatchError carrying a migration path,
  // raised before any structural work. Replaces the bare assertEqual while
  // preserving the `schemaVersion must be 0.2.0` substring existing regex
  // tests pin. See docs/format-stability-and-compatibility-policy.md.
  assertFormatVersion(
    BRIDGE_FORMAT_STABILITY,
    bundle.schemaVersion,
    "BridgeBundleV02.schemaVersion",
  );
  assertUuid7(bundle.bridgeId, "BridgeBundleV02.bridgeId");
  assertSourceGameRevisionV02(bundle.sourceGame, "BridgeBundleV02.sourceGame");
  assertHashStringV02(bundle.sourceBundleHash, "BridgeBundleV02.sourceBundleHash");
  assertSourceRevisionV02(bundle.sourceBundleRevision, "BridgeBundleV02.sourceBundleRevision");
  assertRevisionHashMatchesV02(
    bundle.sourceBundleRevision,
    bundle.sourceBundleHash,
    "BridgeBundleV02.sourceBundleRevision",
  );
  assertString(bundle.sourceLocale, "BridgeBundleV02.sourceLocale");
  assertHashStrategyV02(bundle.hashStrategy, "BridgeBundleV02.hashStrategy");
  assertExtractor(bundle.extractor, "BridgeBundleV02.extractor");

  const assets = asArray(bundle.assets, "BridgeBundleV02.assets");
  const assetIds = new Set<Uuid7>();
  for (const [index, asset] of assets.entries()) {
    const label = `BridgeBundleV02.assets[${index}]`;
    assertBridgeAssetV02(asset, label);
    if (assetIds.has(asset.assetId)) {
      throw new Error(`${label}.assetId must be unique within BridgeBundleV02.assets`);
    }
    assetIds.add(asset.assetId);
  }

  const units = asArray(bundle.units, "BridgeBundleV02.units");
  const bridgeUnitIds = new Set<Uuid7>();
  for (const [index, unit] of units.entries()) {
    const label = `BridgeBundleV02.units[${index}]`;
    assertLocalizationUnitV02(unit, label);
    if (bridgeUnitIds.has(unit.bridgeUnitId)) {
      throw new Error(`${label}.bridgeUnitId must be unique within BridgeBundleV02.units`);
    }
    bridgeUnitIds.add(unit.bridgeUnitId);
    assertLocalizationUnitAssetRefsExist(unit, label, assetIds);
    assertPatchRefMatchesUnitV02(unit, label);
  }

  const policyRecords = asArray(bundle.policyRecords, "BridgeBundleV02.policyRecords");
  for (const [index, record] of policyRecords.entries()) {
    assertPolicyRecordV02(record, `BridgeBundleV02.policyRecords[${index}]`);
  }
}

export function assertAssetPolicyBundleV02(value: unknown): asserts value is AssetPolicyBundleV02 {
  const bundle = asRecord(value, "AssetPolicyBundleV02");
  assertEqual(
    bundle.schemaVersion,
    BRIDGE_SCHEMA_VERSION_V02,
    "AssetPolicyBundleV02.schemaVersion",
  );
  assertUuid7(bundle.assetPolicyBundleId, "AssetPolicyBundleV02.assetPolicyBundleId");
  assertUuid7(bundle.sourceBridgeId, "AssetPolicyBundleV02.sourceBridgeId");
  assertOptionalHashStringV02(bundle.sourceBundleHash, "AssetPolicyBundleV02.sourceBundleHash");
  assertString(bundle.sourceLocale, "AssetPolicyBundleV02.sourceLocale");
  assertLocaleBranchScopeV02(bundle.localeBranch, "AssetPolicyBundleV02.localeBranch");

  const assets = asArray(bundle.assets, "AssetPolicyBundleV02.assets");
  const assetsById = new Map<Uuid7, BridgeAssetV02>();
  for (const [index, asset] of assets.entries()) {
    const label = `AssetPolicyBundleV02.assets[${index}]`;
    assertBridgeAssetV02(asset, label);
    if (assetsById.has(asset.assetId)) {
      throw new Error(`${label}.assetId must be unique within AssetPolicyBundleV02.assets`);
    }
    assetsById.set(asset.assetId, asset);
  }

  const decisions = asArray(bundle.decisions, "AssetPolicyBundleV02.decisions");
  if (decisions.length === 0) {
    throw new Error("AssetPolicyBundleV02.decisions must contain at least one policy decision");
  }
  const decisionIds = new Set<Uuid7>();
  for (const [index, decision] of decisions.entries()) {
    const label = `AssetPolicyBundleV02.decisions[${index}]`;
    assertAssetPolicyDecisionV02(decision, label);
    if (decisionIds.has(decision.assetPolicyDecisionId)) {
      throw new Error(
        `${label}.assetPolicyDecisionId must be unique within AssetPolicyBundleV02.decisions`,
      );
    }
    decisionIds.add(decision.assetPolicyDecisionId);
    assertAssetPolicyDecisionAssetRefsExist(decision, label, assetsById);
  }

  assertStringArray(bundle.compatibilityNotes, "AssetPolicyBundleV02.compatibilityNotes");
}

export function assertTriageBundleV02(value: unknown): asserts value is TriageBundleV02 {
  assertNoConfidenceFields(value, "TriageBundleV02");
  const bundle = asRecord(value, "TriageBundleV02");
  assertEqual(bundle.schemaVersion, BRIDGE_SCHEMA_VERSION_V02, "TriageBundleV02.schemaVersion");
  assertUuid7(bundle.triageBundleId, "TriageBundleV02.triageBundleId");
  assertOptionalUuid7(bundle.projectId, "TriageBundleV02.projectId");
  assertOptionalUuid7(bundle.sourceBridgeId, "TriageBundleV02.sourceBridgeId");
  assertOptionalUuid7(bundle.localeBranchId, "TriageBundleV02.localeBranchId");

  const events = asArray(bundle.events, "TriageBundleV02.events");
  const triageEvents: TriageEventV02[] = [];
  const seenEventIds = new Set<Uuid7>();
  for (const [index, event] of events.entries()) {
    const label = `TriageBundleV02.events[${index}]`;
    assertTriageEventV02(event, label);
    if (seenEventIds.has(event.eventId)) {
      throw new Error(`${label}.eventId must be unique within TriageBundleV02.events`);
    }
    assertEventLinksReferToPriorEvents(event, label, seenEventIds);
    seenEventIds.add(event.eventId);
    triageEvents.push(event);
  }

  const tasks = asArray(bundle.tasks, "TriageBundleV02.tasks");
  const triageTasks: TriageTaskV02[] = [];
  const taskIds = new Set<Uuid7>();
  for (const [index, task] of tasks.entries()) {
    const label = `TriageBundleV02.tasks[${index}]`;
    assertTriageTaskV02(task, label);
    if (taskIds.has(task.taskId)) {
      throw new Error(`${label}.taskId must be unique within TriageBundleV02.tasks`);
    }
    taskIds.add(task.taskId);
    triageTasks.push(task);
  }

  const findings = asArray(bundle.findings, "TriageBundleV02.findings");
  const triageFindings: FindingRecordV02[] = [];
  const findingIds = new Set<Uuid7>();
  for (const [index, finding] of findings.entries()) {
    const label = `TriageBundleV02.findings[${index}]`;
    assertFindingRecordV02(finding, label);
    if (findingIds.has(finding.findingId)) {
      throw new Error(`${label}.findingId must be unique within TriageBundleV02.findings`);
    }
    findingIds.add(finding.findingId);
    triageFindings.push(finding);
  }

  const referenceIndex = buildTriageBundleReferenceIndexV02(
    triageEvents,
    triageTasks,
    triageFindings,
  );
  assertTriageBundleReferencesV02(triageEvents, triageTasks, triageFindings, referenceIndex);
}
