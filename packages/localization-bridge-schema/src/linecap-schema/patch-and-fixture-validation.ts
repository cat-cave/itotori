import { BRIDGE_FORMAT_STABILITY, assertFormatVersion } from "./dependencies.js";
import { BRIDGE_SCHEMA_VERSION_V02, Uuid7 } from "./bridge-core-types.js";
import {
  PERMISSION_VALUES_V02,
  PATCH_FAILURE_CATEGORIES_V02,
  PATCH_PARTIAL_WRITE_DISPOSITIONS_V02,
  PATCH_RESULT_STATUSES_V02,
  PatchFailureCategoryV02,
} from "./schema-enums.js";
import {
  DeltaPackageMetadataV02,
  FindingRecordFixtureV02,
  PatchFailureV02,
  PatchPartialWriteAccountingV02,
  PatchResultV02,
  PatchTouchedAssetV02,
  PermissionLocalUserFixtureV02,
} from "./patch-and-runtime-types.js";
import {
  assertPatchFailureV02,
  computePatchResultOutputHashRollupV02,
} from "./benchmark-and-patch-validation.js";
import {
  assertHashStrategyV02,
  assertRevisionHashMatchesV02,
  assertSourceGameRevisionV02,
  assertSourceRevisionV02,
} from "./asset-policy-and-source-validation.js";
import { assertPatchSourceCompatibilityReportV02 } from "./surface-patch-triage-validation.js";
import { assertFindingRecordV02 } from "./triage-reference-validation.js";
import { assertFindingRecordEvidenceReferencesOwnProvenanceV02 } from "./benchmark-provenance-validation.js";
import {
  asArray,
  asRecord,
  assertEnumArrayV02,
  assertExactStringSetV02,
  assertHashStringV02,
  assertOptionalHashStringV02,
  assertOptionalRfc3339Instant,
  assertString,
  assertStringArray,
} from "./fixture-utility-validation.js";
import {
  assertEnum,
  assertEqual,
  assertNoConfidenceFields,
  assertNonNegativeInteger,
  assertOptionalUuid7,
  assertUuid7,
} from "./validation-primitives.js";

export function assertPatchFailuresV02(value: unknown, label: string): PatchFailureV02[] {
  const array = asArray(value, label);
  const failures: PatchFailureV02[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of array.entries()) {
    const failure = assertPatchFailureV02(entry, `${label}[${index}]`);
    if (seen.has(failure.failureId)) {
      throw new Error(`${label}[${index}].failureId must not duplicate ${failure.failureId}`);
    }
    seen.add(failure.failureId);
    failures.push(failure);
  }
  return failures;
}

export function assertPatchTouchedAssetV02(value: unknown, label: string): PatchTouchedAssetV02 {
  const asset = asRecord(value, label);
  assertUuid7(asset.assetId, `${label}.assetId`);
  assertHashStringV02(asset.outputHash, `${label}.outputHash`);
  assertNonNegativeInteger(asset.byteSize, `${label}.byteSize`);
  return asset as PatchTouchedAssetV02;
}

export function assertPatchTouchedAssetsV02(value: unknown, label: string): PatchTouchedAssetV02[] {
  const array = asArray(value, label);
  const assets: PatchTouchedAssetV02[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of array.entries()) {
    const asset = assertPatchTouchedAssetV02(entry, `${label}[${index}]`);
    if (seen.has(asset.assetId)) {
      throw new Error(`${label}[${index}].assetId must not duplicate ${asset.assetId}`);
    }
    seen.add(asset.assetId);
    assets.push(asset);
  }
  return assets;
}

export function assertPatchPartialWriteAccountingV02(
  value: unknown,
  label: string,
): PatchPartialWriteAccountingV02 {
  const accounting = asRecord(value, label);
  const attempted = assertUuid7ArrayUnique(
    accounting.attemptedAssetIds,
    `${label}.attemptedAssetIds`,
  );
  const written = assertUuid7ArrayUnique(accounting.writtenAssetIds, `${label}.writtenAssetIds`);
  const skipped = assertUuid7ArrayUnique(accounting.skippedAssetIds, `${label}.skippedAssetIds`);
  assertEnum(accounting.disposition, PATCH_PARTIAL_WRITE_DISPOSITIONS_V02, `${label}.disposition`);
  if (accounting.rollbackDiagnosticCode !== undefined) {
    assertString(accounting.rollbackDiagnosticCode, `${label}.rollbackDiagnosticCode`);
  }
  const attemptedSet = new Set(attempted);
  const writtenSet = new Set(written);
  const skippedSet = new Set(skipped);
  if (writtenSet.size + skippedSet.size !== attemptedSet.size) {
    throw new Error(
      `${label}.attemptedAssetIds must equal disjoint union of writtenAssetIds and skippedAssetIds: kaifuu.patch_result.silent_partial_write`,
    );
  }
  for (const id of writtenSet) {
    if (skippedSet.has(id)) {
      throw new Error(
        `${label}.writtenAssetIds must not overlap skippedAssetIds: kaifuu.patch_result.silent_partial_write`,
      );
    }
    if (!attemptedSet.has(id)) {
      throw new Error(
        `${label}.attemptedAssetIds must equal disjoint union of writtenAssetIds and skippedAssetIds: kaifuu.patch_result.silent_partial_write`,
      );
    }
  }
  for (const id of skippedSet) {
    if (!attemptedSet.has(id)) {
      throw new Error(
        `${label}.attemptedAssetIds must equal disjoint union of writtenAssetIds and skippedAssetIds: kaifuu.patch_result.silent_partial_write`,
      );
    }
  }
  if (accounting.disposition === "retained_partial") {
    if (accounting.rollbackDiagnosticCode !== undefined) {
      throw new Error(
        `${label}.rollbackDiagnosticCode must be omitted when disposition is retained_partial`,
      );
    }
  } else {
    if (accounting.rollbackDiagnosticCode === undefined) {
      throw new Error(
        `${label}.rollbackDiagnosticCode is required when disposition is ${accounting.disposition}: kaifuu.patch_result.rollback_diagnostic_required`,
      );
    }
  }
  return accounting as PatchPartialWriteAccountingV02;
}

export function assertUuid7ArrayUnique(value: unknown, label: string): Uuid7[] {
  const array = asArray(value, label);
  const seen = new Set<Uuid7>();
  const ids: Uuid7[] = [];
  for (const [index, item] of array.entries()) {
    assertUuid7(item, `${label}[${index}]`);
    if (seen.has(item)) {
      throw new Error(`${label}[${index}] must not duplicate ${item}`);
    }
    seen.add(item);
    ids.push(item);
  }
  return ids;
}

export function assertPatchResultV02(value: unknown): asserts value is PatchResultV02 {
  const result = asRecord(value, "PatchResultV02");
  assertEqual(result.schemaVersion, BRIDGE_SCHEMA_VERSION_V02, "PatchResultV02.schemaVersion");
  assertUuid7(result.patchResultId, "PatchResultV02.patchResultId");
  assertUuid7(result.patchExportId, "PatchResultV02.patchExportId");
  assertString(result.adapterId, "PatchResultV02.adapterId");
  assertEnum(result.status, PATCH_RESULT_STATUSES_V02, "PatchResultV02.status");
  assertOptionalHashStringV02(result.outputHash, "PatchResultV02.outputHash");
  const failures = assertPatchFailuresV02(result.failures, "PatchResultV02.failures");
  const touchedAssets =
    result.touchedAssets !== undefined
      ? assertPatchTouchedAssetsV02(result.touchedAssets, "PatchResultV02.touchedAssets")
      : undefined;
  let declaredCategories: PatchFailureCategoryV02[] | undefined;
  if (result.failureCategories !== undefined) {
    const categoriesArray = asArray(result.failureCategories, "PatchResultV02.failureCategories");
    const seenCategories = new Set<string>();
    const declared: PatchFailureCategoryV02[] = [];
    for (const [index, entry] of categoriesArray.entries()) {
      assertEnum(entry, PATCH_FAILURE_CATEGORIES_V02, `PatchResultV02.failureCategories[${index}]`);
      if (seenCategories.has(entry)) {
        throw new Error(`PatchResultV02.failureCategories[${index}] must not duplicate ${entry}`);
      }
      seenCategories.add(entry);
      declared.push(entry);
    }
    declaredCategories = declared;
  }
  const partialWrite =
    result.partialWrite !== undefined
      ? assertPatchPartialWriteAccountingV02(result.partialWrite, "PatchResultV02.partialWrite")
      : undefined;

  if (result.sourceCompatibility !== undefined) {
    assertPatchSourceCompatibilityReportV02(
      result.sourceCompatibility,
      "PatchResultV02.sourceCompatibility",
    );
    if (result.sourceCompatibility.patchExportId !== result.patchExportId) {
      throw new Error(
        "PatchResultV02.sourceCompatibility.patchExportId must match PatchResultV02.patchExportId",
      );
    }
    if (
      result.sourceCompatibility.status === "incompatible" &&
      result.status !== "incompatible_source"
    ) {
      throw new Error(
        "PatchResultV02.status must be incompatible_source when sourceCompatibility.status is incompatible",
      );
    }
  }
  if (result.status === "incompatible_source" && result.sourceCompatibility === undefined) {
    throw new Error("PatchResultV02.sourceCompatibility is required for incompatible_source");
  }
  if (
    result.status === "incompatible_source" &&
    result.sourceCompatibility !== undefined &&
    result.sourceCompatibility.status !== "incompatible"
  ) {
    throw new Error(
      "PatchResultV02.sourceCompatibility.status must be incompatible for incompatible_source",
    );
  }

  if (result.status === "passed") {
    if (result.outputHash === undefined) {
      throw new Error(
        "PatchResultV02.outputHash is required when status is passed: kaifuu.patch_result.passed_requires_output_hash",
      );
    }
    if (touchedAssets === undefined || touchedAssets.length === 0) {
      throw new Error(
        "PatchResultV02.touchedAssets must include at least one asset when status is passed: kaifuu.patch_result.passed_requires_touched_assets",
      );
    }
    if (failures.length !== 0) {
      throw new Error(
        "PatchResultV02.failures must be empty when status is passed: kaifuu.patch_result.passed_must_have_no_failures",
      );
    }
    if (declaredCategories !== undefined) {
      throw new Error(
        "PatchResultV02.failureCategories must be omitted when status is passed: kaifuu.patch_result.passed_must_omit_failure_categories",
      );
    }
    if (partialWrite !== undefined) {
      throw new Error(
        "PatchResultV02.partialWrite must be omitted when status is passed: kaifuu.patch_result.passed_must_omit_partial_write",
      );
    }
    const rollup = computePatchResultOutputHashRollupV02(touchedAssets);
    if (rollup !== result.outputHash) {
      throw new Error(
        `PatchResultV02.outputHash must equal rollup of touchedAssets[].outputHash (expected ${rollup}): kaifuu.patch_result.output_hash_drift`,
      );
    }
  }

  if (result.status === "failed" || result.status === "incompatible_source") {
    if (failures.length === 0) {
      throw new Error(
        `PatchResultV02.failures must include at least one entry when status is ${result.status}: kaifuu.patch_result.non_passed_requires_failures`,
      );
    }
    if (declaredCategories === undefined) {
      throw new Error(
        `PatchResultV02.failureCategories is required when status is ${result.status}: kaifuu.patch_result.missing_failure_category`,
      );
    }
    const observedSet = new Set<PatchFailureCategoryV02>();
    for (const failure of failures) {
      observedSet.add(failure.category);
    }
    const declaredSet = new Set(declaredCategories);
    for (const observed of observedSet) {
      if (!declaredSet.has(observed)) {
        throw new Error(
          `PatchResultV02.failureCategories is missing ${observed}: kaifuu.patch_result.missing_failure_category`,
        );
      }
    }
    for (const declared of declaredSet) {
      if (!observedSet.has(declared)) {
        throw new Error(
          `PatchResultV02.failureCategories contains unobserved ${declared}: kaifuu.patch_result.unknown_failure_category`,
        );
      }
    }
    if (result.outputHash !== undefined) {
      throw new Error(`PatchResultV02.outputHash must be omitted when status is ${result.status}`);
    }
    if (touchedAssets !== undefined) {
      throw new Error(
        `PatchResultV02.touchedAssets must be omitted when status is ${result.status}`,
      );
    }
  }

  if (result.status === "incompatible_source") {
    for (const failure of failures) {
      if (failure.category !== "source_incompatible") {
        throw new Error(
          `PatchResultV02.failures[*].category must be source_incompatible when status is incompatible_source: kaifuu.patch_result.incompatible_source_category_required`,
        );
      }
    }
  }

  if (partialWrite !== undefined) {
    if (result.status === "passed") {
      throw new Error(
        "PatchResultV02.partialWrite must be omitted when status is passed: kaifuu.patch_result.passed_must_omit_partial_write",
      );
    }
    const attemptedSet = new Set(partialWrite.attemptedAssetIds);
    for (const failure of failures) {
      if (!attemptedSet.has(failure.assetId)) {
        throw new Error(
          `PatchResultV02.failures asset ${failure.assetId} must appear in partialWrite.attemptedAssetIds: kaifuu.patch_result.silent_partial_write`,
        );
      }
    }
  }
}

export function assertDeltaPackageMetadataV02(
  value: unknown,
): asserts value is DeltaPackageMetadataV02 {
  const metadata = asRecord(value, "DeltaPackageMetadataV02");
  // Version-negotiation on load (beta-schema-stability-policy): see the note
  // in assertBridgeBundleV02 above. The delta-metadata record rides the same
  // bridge v0.2 schemaVersion axis.
  assertFormatVersion(
    BRIDGE_FORMAT_STABILITY,
    metadata.schemaVersion,
    "DeltaPackageMetadataV02.schemaVersion",
  );
  assertUuid7(metadata.deltaPackageId, "DeltaPackageMetadataV02.deltaPackageId");
  assertUuid7(metadata.sourceBridgeId, "DeltaPackageMetadataV02.sourceBridgeId");
  assertSourceGameRevisionV02(metadata.sourceGame, "DeltaPackageMetadataV02.sourceGame");
  assertHashStringV02(metadata.sourceBundleHash, "DeltaPackageMetadataV02.sourceBundleHash");
  assertSourceRevisionV02(
    metadata.sourceBundleRevision,
    "DeltaPackageMetadataV02.sourceBundleRevision",
  );
  assertRevisionHashMatchesV02(
    metadata.sourceBundleRevision,
    metadata.sourceBundleHash,
    "DeltaPackageMetadataV02.sourceBundleRevision",
  );
  assertUuid7(metadata.generatedPatchExportId, "DeltaPackageMetadataV02.generatedPatchExportId");
  assertHashStringV02(
    metadata.generatedPatchExportHash,
    "DeltaPackageMetadataV02.generatedPatchExportHash",
  );
  assertString(metadata.targetLocale, "DeltaPackageMetadataV02.targetLocale");
  assertHashStrategyV02(metadata.hashStrategy, "DeltaPackageMetadataV02.hashStrategy");
  assertOptionalRfc3339Instant(metadata.createdAt, "DeltaPackageMetadataV02.createdAt");
}

export function assertFindingRecordFixtureV02(
  value: unknown,
): asserts value is FindingRecordFixtureV02 {
  assertNoConfidenceFields(value, "FindingRecordFixtureV02");
  const fixture = asRecord(value, "FindingRecordFixtureV02");
  assertEqual(
    fixture.schemaVersion,
    BRIDGE_SCHEMA_VERSION_V02,
    "FindingRecordFixtureV02.schemaVersion",
  );
  assertUuid7(fixture.findingFixtureId, "FindingRecordFixtureV02.findingFixtureId");
  assertOptionalUuid7(fixture.sourceTriageBundleId, "FindingRecordFixtureV02.sourceTriageBundleId");
  assertFindingRecordV02(fixture.finding, "FindingRecordFixtureV02.finding");
  assertFindingRecordEvidenceReferencesOwnProvenanceV02(
    fixture.finding,
    "FindingRecordFixtureV02.finding",
  );
  assertStringArray(fixture.compatibilityNotes, "FindingRecordFixtureV02.compatibilityNotes");
}

export function assertPermissionLocalUserFixtureV02(
  value: unknown,
): asserts value is PermissionLocalUserFixtureV02 {
  const fixture = asRecord(value, "PermissionLocalUserFixtureV02");
  assertEqual(
    fixture.schemaVersion,
    BRIDGE_SCHEMA_VERSION_V02,
    "PermissionLocalUserFixtureV02.schemaVersion",
  );
  assertUuid7(fixture.permissionFixtureId, "PermissionLocalUserFixtureV02.permissionFixtureId");
  const user = asRecord(fixture.user, "PermissionLocalUserFixtureV02.user");
  assertEqual(user.userId, "local-user", "PermissionLocalUserFixtureV02.user.userId");
  assertEqual(user.displayName, "Local user", "PermissionLocalUserFixtureV02.user.displayName");
  const grants = assertEnumArrayV02(
    fixture.grants,
    PERMISSION_VALUES_V02,
    "PermissionLocalUserFixtureV02.grants",
  );
  assertExactStringSetV02(grants, PERMISSION_VALUES_V02, "PermissionLocalUserFixtureV02.grants");
  assertStringArray(fixture.compatibilityNotes, "PermissionLocalUserFixtureV02.compatibilityNotes");
}
