import {
  AdapterCapabilityMatrixV02,
  BRIDGE_SCHEMA_VERSION_V02,
  CAPABILITY_LEVELS_V02,
  CAPABILITY_LEVEL_STATUS_KINDS_V02,
  CapabilityLevelStatusV02,
  Uuid7,
} from "./schema-domain-01.js";
import {
  CONTRACT_COMPATIBILITY_STATUSES_V02,
  CONTRACT_FIXTURE_KINDS_V02,
  ContractFixtureKindV02,
} from "./schema-domain-02.js";
import {
  AlphaVerticalProofBridgeUnitRefV02,
  AlphaVerticalProofManifestV02,
  ContractFixtureManifestV02,
} from "./schema-domain-07.js";
import {
  ContractCompatibilityReportV02,
  assertAssetPolicyBundleV02,
  assertBridgeBundleV02,
  assertTriageBundleV02,
} from "./schema-domain-08.js";
import { assertBenchmarkReportV02, assertPatchExportV02 } from "./schema-domain-09.js";
import {
  assertDeltaPackageMetadataV02,
  assertFindingRecordFixtureV02,
  assertPatchResultV02,
  assertPermissionLocalUserFixtureV02,
} from "./schema-domain-10.js";
import { assertRuntimeEvidenceReportV02 } from "./schema-domain-13.js";
import { assertRevisionHashMatchesV02, assertSourceRevisionV02 } from "./schema-domain-16.js";
import {
  assertAlphaVerticalProofArtifactRefsV02,
  assertAlphaVerticalProofBenchmarkOutputRefV02,
  assertAlphaVerticalProofBridgeUnitRefV02,
  assertAlphaVerticalProofContentHashesV02,
  assertAlphaVerticalProofEngineProfileV02,
  assertAlphaVerticalProofFixtureRefV02,
} from "./schema-domain-20.js";
import {
  alphaVerticalProofHashScopeForArtifactKindV02,
  asArray,
  asRecord,
  assertAllowedKeysV02,
  assertAlphaVerticalProofHashCoveredV02,
  assertAlphaVerticalProofHashScopeContentIdV02,
  assertAlphaVerticalProofRequiredHashScopesV02,
  assertCommandTokensV02,
  assertContractCompatibilityCoverageV02,
  assertContractFixtureManifestEntryV02,
  assertContractFixturePathV02,
  assertExactStringSetV02,
  assertHashStringV02,
  assertInvalidContractFixtureManifestEntryV02,
  assertRfc3339Instant,
  assertString,
  assertStringArray,
  assertUniqueFixturePathV02,
  assertUniqueNonEmptyStringArrayV02,
} from "./schema-domain-21.js";
import {
  assertEnum,
  assertEqual,
  assertNoConfidenceFields,
  assertNoRawPrivateOrSecretFieldsV02,
  assertUniqueUuid7ArrayV02,
  assertUuid7,
} from "./schema-domain-22.js";

export function assertAlphaVerticalProofManifestV02(
  value: unknown,
): asserts value is AlphaVerticalProofManifestV02 {
  assertNoConfidenceFields(value, "AlphaVerticalProofManifestV02");
  assertNoRawPrivateOrSecretFieldsV02(value, "AlphaVerticalProofManifestV02");
  const manifest = asRecord(value, "AlphaVerticalProofManifestV02");
  assertAllowedKeysV02(
    manifest,
    [
      "schemaVersion",
      "proofManifestId",
      "createdAt",
      "fixture",
      "engineProfile",
      "sourceRevision",
      "sourceBridgeId",
      "sourceBundleHash",
      "bridgeUnitRefs",
      "runtimeTargetIds",
      "artifactRefs",
      "providerProofIds",
      "benchmarkOutputRefs",
      "contentHashes",
      "compatibilityNotes",
    ],
    "AlphaVerticalProofManifestV02",
  );
  assertEqual(
    manifest.schemaVersion,
    BRIDGE_SCHEMA_VERSION_V02,
    "AlphaVerticalProofManifestV02.schemaVersion",
  );
  assertUuid7(manifest.proofManifestId, "AlphaVerticalProofManifestV02.proofManifestId");
  assertRfc3339Instant(manifest.createdAt, "AlphaVerticalProofManifestV02.createdAt");
  assertAlphaVerticalProofFixtureRefV02(manifest.fixture, "AlphaVerticalProofManifestV02.fixture");
  assertAlphaVerticalProofEngineProfileV02(
    manifest.engineProfile,
    "AlphaVerticalProofManifestV02.engineProfile",
  );
  assertSourceRevisionV02(manifest.sourceRevision, "AlphaVerticalProofManifestV02.sourceRevision");
  assertUuid7(manifest.sourceBridgeId, "AlphaVerticalProofManifestV02.sourceBridgeId");
  assertHashStringV02(manifest.sourceBundleHash, "AlphaVerticalProofManifestV02.sourceBundleHash");
  assertRevisionHashMatchesV02(
    manifest.sourceRevision,
    manifest.sourceBundleHash,
    "AlphaVerticalProofManifestV02.sourceRevision",
  );

  const bridgeUnitRefs = asArray(
    manifest.bridgeUnitRefs,
    "AlphaVerticalProofManifestV02.bridgeUnitRefs",
  );
  if (bridgeUnitRefs.length === 0) {
    throw new Error("AlphaVerticalProofManifestV02.bridgeUnitRefs must contain at least one ref");
  }
  const bridgeUnitRefKeys = new Set<string>();
  const validatedBridgeUnitRefs: AlphaVerticalProofBridgeUnitRefV02[] = [];
  for (const [index, ref] of bridgeUnitRefs.entries()) {
    const label = `AlphaVerticalProofManifestV02.bridgeUnitRefs[${index}]`;
    assertAlphaVerticalProofBridgeUnitRefV02(ref, label);
    const refKey = `${ref.bridgeUnitId}\0${ref.sourceUnitKey}`;
    if (bridgeUnitRefKeys.has(refKey)) {
      throw new Error(`${label} must be unique by bridgeUnitId and sourceUnitKey`);
    }
    bridgeUnitRefKeys.add(refKey);
    validatedBridgeUnitRefs.push(ref);
  }

  assertUniqueNonEmptyStringArrayV02(
    manifest.runtimeTargetIds,
    "AlphaVerticalProofManifestV02.runtimeTargetIds",
  );
  assertAlphaVerticalProofArtifactRefsV02(
    manifest.artifactRefs,
    "AlphaVerticalProofManifestV02.artifactRefs",
  );
  const artifactRefs = manifest.artifactRefs;
  const providerProofIds = assertUniqueUuid7ArrayV02(
    manifest.providerProofIds,
    "AlphaVerticalProofManifestV02.providerProofIds",
  );
  if (providerProofIds.length === 0) {
    throw new Error("AlphaVerticalProofManifestV02.providerProofIds must contain at least one id");
  }

  const benchmarkOutputRefs = asArray(
    manifest.benchmarkOutputRefs,
    "AlphaVerticalProofManifestV02.benchmarkOutputRefs",
  );
  if (benchmarkOutputRefs.length === 0) {
    throw new Error(
      "AlphaVerticalProofManifestV02.benchmarkOutputRefs must contain at least one ref",
    );
  }
  const benchmarkRunIds = new Set<Uuid7>();
  for (const [index, ref] of benchmarkOutputRefs.entries()) {
    const label = `AlphaVerticalProofManifestV02.benchmarkOutputRefs[${index}]`;
    assertAlphaVerticalProofBenchmarkOutputRefV02(ref, label);
    if (benchmarkRunIds.has(ref.benchmarkRunId)) {
      throw new Error(`${label}.benchmarkRunId must be unique within benchmarkOutputRefs`);
    }
    benchmarkRunIds.add(ref.benchmarkRunId);
  }

  const contentHashes = assertAlphaVerticalProofContentHashesV02(
    manifest.contentHashes,
    "AlphaVerticalProofManifestV02.contentHashes",
  );
  assertAlphaVerticalProofRequiredHashScopesV02(contentHashes);
  if (manifest.fixture.publicManifestUri !== artifactRefs.publicFixtureManifest.uri) {
    throw new Error(
      "AlphaVerticalProofManifestV02.fixture.publicManifestUri must match AlphaVerticalProofManifestV02.artifactRefs.publicFixtureManifest.uri",
    );
  }
  if (manifest.fixture.publicManifestHash !== artifactRefs.publicFixtureManifest.hash) {
    throw new Error(
      "AlphaVerticalProofManifestV02.fixture.publicManifestHash must match AlphaVerticalProofManifestV02.artifactRefs.publicFixtureManifest.hash",
    );
  }
  assertAlphaVerticalProofHashCoveredV02(
    contentHashes,
    "source_bundle",
    `${manifest.fixture.fixtureId}:source-bundle`,
    manifest.sourceBundleHash,
    "AlphaVerticalProofManifestV02.sourceBundleHash",
  );
  for (const [index, ref] of validatedBridgeUnitRefs.entries()) {
    assertAlphaVerticalProofHashCoveredV02(
      contentHashes,
      "bridge_unit",
      ref.bridgeUnitId,
      ref.sourceHash,
      `AlphaVerticalProofManifestV02.bridgeUnitRefs[${index}].sourceHash`,
    );
  }
  for (const [index, providerProofId] of providerProofIds.entries()) {
    assertAlphaVerticalProofHashScopeContentIdV02(
      contentHashes,
      "provider_proof",
      providerProofId,
      `AlphaVerticalProofManifestV02.providerProofIds[${index}]`,
    );
  }
  for (const artifactRef of Object.values(artifactRefs)) {
    if (artifactRef === undefined) {
      continue;
    }
    assertAlphaVerticalProofHashCoveredV02(
      contentHashes,
      alphaVerticalProofHashScopeForArtifactKindV02(artifactRef.artifactKind),
      artifactRef.uri,
      artifactRef.hash,
      `AlphaVerticalProofManifestV02.artifactRefs.${artifactRef.artifactKind}.hash`,
    );
  }
  assertStringArray(
    manifest.compatibilityNotes,
    "AlphaVerticalProofManifestV02.compatibilityNotes",
  );
}

export function assertContractFixtureManifestV02(
  value: unknown,
): asserts value is ContractFixtureManifestV02 {
  const manifest = asRecord(value, "ContractFixtureManifestV02");
  assertEqual(
    manifest.schemaVersion,
    BRIDGE_SCHEMA_VERSION_V02,
    "ContractFixtureManifestV02.schemaVersion",
  );
  assertUuid7(manifest.suiteId, "ContractFixtureManifestV02.suiteId");
  assertRfc3339Instant(manifest.generatedAt, "ContractFixtureManifestV02.generatedAt");
  const validFixtures = asArray(manifest.validFixtures, "ContractFixtureManifestV02.validFixtures");
  const invalidFixtures = asArray(
    manifest.invalidFixtures,
    "ContractFixtureManifestV02.invalidFixtures",
  );
  const paths = new Set<string>();
  const validKinds = new Set<ContractFixtureKindV02>();
  for (const [index, fixture] of validFixtures.entries()) {
    const label = `ContractFixtureManifestV02.validFixtures[${index}]`;
    assertContractFixtureManifestEntryV02(fixture, label);
    validKinds.add(fixture.kind);
    assertUniqueFixturePathV02(fixture.path, label, paths);
  }
  for (const [index, fixture] of invalidFixtures.entries()) {
    const label = `ContractFixtureManifestV02.invalidFixtures[${index}]`;
    assertInvalidContractFixtureManifestEntryV02(fixture, label);
    assertString(fixture.expectedSemanticError, `${label}.expectedSemanticError`);
    assertUniqueFixturePathV02(fixture.path, label, paths);
  }
  assertExactStringSetV02(
    [...validKinds],
    CONTRACT_FIXTURE_KINDS_V02,
    "ContractFixtureManifestV02.validFixtures.kind",
  );
}

export function assertContractCompatibilityReportV02(
  value: unknown,
): asserts value is ContractCompatibilityReportV02 {
  const report = asRecord(value, "ContractCompatibilityReportV02");
  assertEqual(
    report.schemaVersion,
    BRIDGE_SCHEMA_VERSION_V02,
    "ContractCompatibilityReportV02.schemaVersion",
  );
  assertUuid7(report.reportId, "ContractCompatibilityReportV02.reportId");
  assertRfc3339Instant(report.generatedAt, "ContractCompatibilityReportV02.generatedAt");
  assertContractFixturePathV02(
    report.suiteManifestPath,
    "ContractCompatibilityReportV02.suiteManifestPath",
  );
  assertString(report.sourceOfTruth, "ContractCompatibilityReportV02.sourceOfTruth");
  assertCommandTokensV02(
    report.typescriptCommand,
    "ContractCompatibilityReportV02.typescriptCommand",
  );
  assertCommandTokensV02(report.rustCommand, "ContractCompatibilityReportV02.rustCommand");
  assertEnum(
    report.overallStatus,
    CONTRACT_COMPATIBILITY_STATUSES_V02,
    "ContractCompatibilityReportV02.overallStatus",
  );

  const coverage = asArray(report.coverage, "ContractCompatibilityReportV02.coverage");
  const coveredKinds = new Set<ContractFixtureKindV02>();
  for (const [index, entry] of coverage.entries()) {
    const label = `ContractCompatibilityReportV02.coverage[${index}]`;
    assertContractCompatibilityCoverageV02(entry, label);
    if (coveredKinds.has(entry.kind)) {
      throw new Error(
        `${label}.kind must be unique within ContractCompatibilityReportV02.coverage`,
      );
    }
    coveredKinds.add(entry.kind);
    if (report.overallStatus === "compatible" && entry.status !== "compatible") {
      throw new Error(`${label}.status must be compatible when overallStatus is compatible`);
    }
  }
  assertExactStringSetV02(
    [...coveredKinds],
    CONTRACT_FIXTURE_KINDS_V02,
    "ContractCompatibilityReportV02.coverage.kind",
  );

  const crossRefs = asArray(
    report.crossContractRefs,
    "ContractCompatibilityReportV02.crossContractRefs",
  );
  for (const [index, ref] of crossRefs.entries()) {
    const label = `ContractCompatibilityReportV02.crossContractRefs[${index}]`;
    const crossRef = asRecord(ref, label);
    assertString(crossRef.from, `${label}.from`);
    assertString(crossRef.to, `${label}.to`);
    assertString(crossRef.rule, `${label}.rule`);
  }
  if (
    !crossRefs.some(
      (ref) => asRecord(ref, "crossContractRef").from === "./permission-local-user-v0.2.json",
    )
  ) {
    throw new Error(
      "ContractCompatibilityReportV02.crossContractRefs must document permission-local-user-v0.2.json",
    );
  }
  assertStringArray(report.notes, "ContractCompatibilityReportV02.notes");
}

/**
 * Validate a per-rung {@link CapabilityLevelStatusV02}.
 *
 * Enforces the same shape the Postgres CHECK constraint guards in
 * migration `0028_engine_capability_reports.sql`:
 *
 * - `supported`: no `limitations`, no `reason`.
 * - `partial`: `limitations` non-empty string array; no `reason`.
 * - `unsupported`: `reason` non-empty string; no `limitations`.
 */
export function assertCapabilityLevelStatusV02(
  value: unknown,
  label: string,
): asserts value is CapabilityLevelStatusV02 {
  const record = asRecord(value, label);
  assertEnum(record.kind, CAPABILITY_LEVEL_STATUS_KINDS_V02, `${label}.kind`);
  switch (record.kind) {
    case "supported":
      if ("limitations" in record) {
        throw new Error(`${label}.limitations must not be present when kind is supported`);
      }
      if ("reason" in record) {
        throw new Error(`${label}.reason must not be present when kind is supported`);
      }
      return;
    case "partial": {
      assertStringArray(record.limitations, `${label}.limitations`);
      const limitations = record.limitations as string[];
      if (limitations.length === 0) {
        throw new Error(
          `${label}.limitations must contain at least one entry when kind is partial`,
        );
      }
      if ("reason" in record) {
        throw new Error(`${label}.reason must not be present when kind is partial`);
      }
      return;
    }
    case "unsupported": {
      assertString(record.reason, `${label}.reason`);
      if ((record.reason as string).trim().length === 0) {
        throw new Error(`${label}.reason must not be empty when kind is unsupported`);
      }
      if ("limitations" in record) {
        throw new Error(`${label}.limitations must not be present when kind is unsupported`);
      }
      return;
    }
  }
}

/**
 * Validate an {@link AdapterCapabilityMatrixV02} fixture.
 */
export function assertAdapterCapabilityMatrixV02(
  value: unknown,
): asserts value is AdapterCapabilityMatrixV02 {
  const record = asRecord(value, "AdapterCapabilityMatrixV02");
  assertString(record.adapterId, "AdapterCapabilityMatrixV02.adapterId");
  for (const level of CAPABILITY_LEVELS_V02) {
    assertCapabilityLevelStatusV02(record[level], `AdapterCapabilityMatrixV02.${level}`);
  }
}

export function assertContractFixtureV02(kind: string, value: unknown): void {
  assertEnum(kind, CONTRACT_FIXTURE_KINDS_V02, "ContractFixtureV02.kind");
  switch (kind) {
    case "alpha-vertical-proof-manifest-v0.2":
      assertAlphaVerticalProofManifestV02(value);
      return;
    case "asset-policy-v0.2":
      assertAssetPolicyBundleV02(value);
      return;
    case "benchmark-report-v0.2":
      assertBenchmarkReportV02(value);
      return;
    case "bridge-v0.2":
      assertBridgeBundleV02(value);
      return;
    case "contract-compatibility-v0.2":
      assertContractCompatibilityReportV02(value);
      return;
    case "contract-fixtures-v0.2":
      assertContractFixtureManifestV02(value);
      return;
    case "delta-package-v0.2":
      assertDeltaPackageMetadataV02(value);
      return;
    case "finding-v0.2":
      assertFindingRecordFixtureV02(value);
      return;
    case "patch-export-v0.2":
      assertPatchExportV02(value);
      return;
    case "patch-result-v0.2":
      assertPatchResultV02(value);
      return;
    case "permission-local-user-v0.2":
      assertPermissionLocalUserFixtureV02(value);
      return;
    case "runtime-evidence-v0.2":
      assertRuntimeEvidenceReportV02(value);
      return;
    case "triage-v0.2":
      assertTriageBundleV02(value);
      return;
  }
}
