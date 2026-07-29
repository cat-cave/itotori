import { createHash } from "./dependencies.js";
import { BRIDGE_SCHEMA_VERSION_V02, PatchExport, Uuid7 } from "./bridge-core-types.js";
import {
  BENCHMARK_RUN_STATUSES,
  LOCALIZATION_ADJUDICATION_STATES,
  LOCALIZATION_QUALITY_CATEGORIES,
  LOCALIZATION_QUALITY_SEVERITIES,
  LOCALIZATION_QUALITY_TAXONOMY_ID,
  LOCALIZATION_QUALITY_TAXONOMY_VERSION,
  LOCALIZATION_ROOT_CAUSES,
  LocalizationAdjudicationStateV02,
  LocalizationQualityCategoryV02,
  LocalizationQualitySeverityV02,
  LocalizationRootCauseV02,
  PATCH_FAILURE_CATEGORIES_V02,
  QUALITY_DETECTOR_KINDS,
  QualityDetectorKindV02,
} from "./schema-enums.js";
import { BenchmarkProviderRunV02 } from "./localization-triage-types.js";
import {
  BenchmarkReportV02,
  BenchmarkSeededDefectOracleV02,
  computeBenchmarkCostLedgerV02,
} from "./benchmark-types.js";
import {
  PatchExportV02,
  PatchFailureV02,
  PatchTouchedAssetV02,
} from "./patch-and-runtime-types.js";
import {
  assertHashStrategyV02,
  assertRevisionHashMatchesV02,
  assertSourceGameRevisionV02,
  assertSourceLocationV02,
  assertSourceRevisionV02,
} from "./asset-policy-and-source-validation.js";
import { assertPatchExportEntryV02 } from "./surface-patch-triage-validation.js";
import {
  assertBenchmarkCommandLineV02,
  assertBenchmarkComparedSystemV02,
  assertBenchmarkCostLedgerV02,
  assertBenchmarkCountBucketsV02,
  assertBenchmarkFindingRecordV02,
  assertBenchmarkInputRefV02,
  assertBenchmarkProviderRunV02,
  assertBenchmarkSeededDefectOracleV02,
  assertBenchmarkToolVersionV02,
} from "./benchmark-provenance-validation.js";
import {
  addToSetMap,
  assertBenchmarkPenaltySummaryV02,
  assertCountBucketsMatchV02,
  assertDeterministicQaResultV02,
  assertHumanEvaluationResultV02,
  assertKnownStringRefV02,
  assertKnownUuid7RefsV02,
  assertQaAgentCoverageV02,
  assertQaAgentEvaluationV02,
} from "./benchmark-quality-validation.js";
import {
  asArray,
  asRecord,
  assertArray,
  assertHashStringV02,
  assertOptionalHashStringV02,
  assertOptionalRfc3339Instant,
  assertOptionalString,
  assertRfc3339Instant,
  assertString,
  assertStringArray,
} from "./fixture-utility-validation.js";
import {
  assertEnum,
  assertEqual,
  assertNoConfidenceFields,
  assertOptionalUuid7,
  assertUuid7,
} from "./validation-primitives.js";

export function assertBenchmarkReportV02(value: unknown): asserts value is BenchmarkReportV02 {
  assertNoConfidenceFields(value, "BenchmarkReportV02");
  const report = asRecord(value, "BenchmarkReportV02");
  assertEqual(report.schemaVersion, BRIDGE_SCHEMA_VERSION_V02, "BenchmarkReportV02.schemaVersion");
  assertUuid7(report.benchmarkRunId, "BenchmarkReportV02.benchmarkRunId");
  assertEqual(report.taxonomyId, LOCALIZATION_QUALITY_TAXONOMY_ID, "BenchmarkReportV02.taxonomyId");
  assertEqual(
    report.taxonomyVersion,
    LOCALIZATION_QUALITY_TAXONOMY_VERSION,
    "BenchmarkReportV02.taxonomyVersion",
  );
  assertRfc3339Instant(report.createdAt, "BenchmarkReportV02.createdAt");
  assertString(report.benchmarkName, "BenchmarkReportV02.benchmarkName");
  assertEnum(report.status, BENCHMARK_RUN_STATUSES, "BenchmarkReportV02.status");
  assertString(report.sourceLocale, "BenchmarkReportV02.sourceLocale");
  assertString(report.targetLocale, "BenchmarkReportV02.targetLocale");
  assertOptionalUuid7(report.localeBranchId, "BenchmarkReportV02.localeBranchId");
  assertString(report.engineProfile, "BenchmarkReportV02.engineProfile");
  assertString(report.gitCommit, "BenchmarkReportV02.gitCommit");
  assertEqual(
    report.bridgeSchemaVersion,
    BRIDGE_SCHEMA_VERSION_V02,
    "BenchmarkReportV02.bridgeSchemaVersion",
  );
  assertOptionalString(report.deterministicSeed, "BenchmarkReportV02.deterministicSeed");

  const inputRefs = asArray(report.fixtureOrCorpusRefs, "BenchmarkReportV02.fixtureOrCorpusRefs");
  if (inputRefs.length === 0) {
    throw new Error("BenchmarkReportV02.fixtureOrCorpusRefs must contain at least one ref");
  }
  const inputRefIds = new Set<string>();
  let totalSourceUnitCount = 0;
  let totalSourceCharacterCount = 0;
  for (const [index, inputRef] of inputRefs.entries()) {
    const label = `BenchmarkReportV02.fixtureOrCorpusRefs[${index}]`;
    assertBenchmarkInputRefV02(inputRef, label);
    if (inputRefIds.has(inputRef.corpusRefId)) {
      throw new Error(`${label}.corpusRefId must be unique within fixtureOrCorpusRefs`);
    }
    inputRefIds.add(inputRef.corpusRefId);
    totalSourceUnitCount += inputRef.sourceUnitCount;
    totalSourceCharacterCount += inputRef.sourceCharacterCount;
  }

  const toolVersions = asArray(report.toolVersions, "BenchmarkReportV02.toolVersions");
  for (const [index, toolVersion] of toolVersions.entries()) {
    assertBenchmarkToolVersionV02(toolVersion, `BenchmarkReportV02.toolVersions[${index}]`);
  }

  const commandLines = asArray(report.commandLines, "BenchmarkReportV02.commandLines");
  for (const [index, commandLine] of commandLines.entries()) {
    assertBenchmarkCommandLineV02(commandLine, `BenchmarkReportV02.commandLines[${index}]`);
  }

  const systemsInput = asArray(report.systemsCompared, "BenchmarkReportV02.systemsCompared");
  if (systemsInput.length === 0) {
    throw new Error("BenchmarkReportV02.systemsCompared must contain at least one system");
  }
  const systemIds = new Set<string>();
  const declaredProviderRunIds = new Set<Uuid7>();
  for (const [index, system] of systemsInput.entries()) {
    const label = `BenchmarkReportV02.systemsCompared[${index}]`;
    assertBenchmarkComparedSystemV02(system, label);
    if (systemIds.has(system.systemId)) {
      throw new Error(`${label}.systemId must be unique within systemsCompared`);
    }
    systemIds.add(system.systemId);
    for (const providerRunId of system.providerRunIds) {
      declaredProviderRunIds.add(providerRunId);
    }
  }

  const providerRunsInput = asArray(
    report.providerModelCostRecords,
    "BenchmarkReportV02.providerModelCostRecords",
  );
  const providerRunIds = new Set<Uuid7>();
  const providerRunSystemIds = new Map<Uuid7, string>();
  const llmQaProviderRunSystemIds = new Map<Uuid7, string>();
  for (const [index, providerRun] of providerRunsInput.entries()) {
    const label = `BenchmarkReportV02.providerModelCostRecords[${index}]`;
    assertBenchmarkProviderRunV02(providerRun, label);
    if (providerRunIds.has(providerRun.providerRunId)) {
      throw new Error(`${label}.providerRunId must be unique within providerModelCostRecords`);
    }
    providerRunIds.add(providerRun.providerRunId);
    providerRunSystemIds.set(providerRun.providerRunId, providerRun.systemId);
    if (providerRun.taskKind === "llm_qa") {
      llmQaProviderRunSystemIds.set(providerRun.providerRunId, providerRun.systemId);
    }
    assertKnownStringRefV02(providerRun.systemId, `${label}.systemId`, "system", systemIds);
  }
  for (const providerRunId of declaredProviderRunIds) {
    if (!providerRunIds.has(providerRunId)) {
      throw new Error(
        `BenchmarkReportV02.systemsCompared providerRunId ${providerRunId} must reference providerModelCostRecords`,
      );
    }
  }
  // Recompute the authoritative ledger from the now-validated provider runs and
  // assert the report's `costLedger` matches it byte-for-byte — the same
  // arithmetic the renderer used to build the field, single-sourced here.
  const expectedLedger = computeBenchmarkCostLedgerV02(
    providerRunsInput as BenchmarkProviderRunV02[],
  );
  const expectedTotalsBySystem = new Map<string, number>(
    expectedLedger.totalsBySystem.map((total) => [total.systemId, total.totalMicrosUsd]),
  );
  assertBenchmarkCostLedgerV02(
    report.costLedger,
    "BenchmarkReportV02.costLedger",
    systemIds,
    expectedLedger.reportTotalMicrosUsd,
    expectedTotalsBySystem,
    expectedLedger.includesUnknownCost,
    report.localeBranchId as Uuid7 | undefined,
  );

  const seededDefectOracle = asArray(
    report.seededDefectOracle,
    "BenchmarkReportV02.seededDefectOracle",
  );
  const seededDefectIds = new Set<string>();
  for (const [index, seed] of seededDefectOracle.entries()) {
    const label = `BenchmarkReportV02.seededDefectOracle[${index}]`;
    assertBenchmarkSeededDefectOracleV02(seed, label);
    assertKnownStringRefV02(
      seed.fixtureOrCorpusRefId,
      `${label}.fixtureOrCorpusRefId`,
      "fixtureOrCorpusRef",
      inputRefIds,
    );
    if (seededDefectIds.has(seed.seededDefectId)) {
      throw new Error(`${label}.seededDefectId must be unique within seededDefectOracle`);
    }
    seededDefectIds.add(seed.seededDefectId);
  }

  const findingRecords = asArray(report.findingRecords, "BenchmarkReportV02.findingRecords");
  const findingIds = new Set<Uuid7>();
  const findingQualitySeverities: LocalizationQualitySeverityV02[] = [];
  const findingCategories: LocalizationQualityCategoryV02[] = [];
  const findingRootCauses: LocalizationRootCauseV02[] = [];
  const findingDetectorKinds: QualityDetectorKindV02[] = [];
  const findingAdjudicationStates: LocalizationAdjudicationStateV02[] = [];
  const findingSystemIds = new Map<Uuid7, string>();
  const llmQaFindingSystemIds = new Map<Uuid7, string>();
  for (const [index, finding] of findingRecords.entries()) {
    const label = `BenchmarkReportV02.findingRecords[${index}]`;
    assertBenchmarkFindingRecordV02(finding, label);
    assertKnownStringRefV02(finding.systemId, `${label}.systemId`, "system", systemIds);
    if (findingIds.has(finding.findingId)) {
      throw new Error(`${label}.findingId must be unique within findingRecords`);
    }
    if (finding.seededDefectId !== undefined && !seededDefectIds.has(finding.seededDefectId)) {
      throw new Error(`${label}.seededDefectId must reference seededDefectOracle`);
    }
    findingIds.add(finding.findingId);
    findingSystemIds.set(finding.findingId, finding.systemId);
    findingQualitySeverities.push(finding.qualitySeverity);
    findingCategories.push(finding.category);
    findingRootCauses.push(finding.rootCause);
    findingDetectorKinds.push(finding.detectorKind);
    findingAdjudicationStates.push(finding.adjudicationState);
    if (finding.detectorKind === "llm_qa") {
      llmQaFindingSystemIds.set(finding.findingId, finding.systemId);
    }
  }

  for (const [index, seed] of (seededDefectOracle as BenchmarkSeededDefectOracleV02[]).entries()) {
    for (const [matchIndex, findingId] of seed.matchedFindingIds.entries()) {
      if (!findingIds.has(findingId)) {
        throw new Error(
          `BenchmarkReportV02.seededDefectOracle[${index}].matchedFindingIds[${matchIndex}] must reference findingRecords`,
        );
      }
    }
  }

  assertCountBucketsMatchV02(
    findingQualitySeverities,
    assertBenchmarkCountBucketsV02(
      report.countsByQualitySeverity,
      LOCALIZATION_QUALITY_SEVERITIES,
      "BenchmarkReportV02.countsByQualitySeverity",
    ),
    "BenchmarkReportV02.countsByQualitySeverity",
  );
  assertCountBucketsMatchV02(
    findingCategories,
    assertBenchmarkCountBucketsV02(
      report.countsByCategory,
      LOCALIZATION_QUALITY_CATEGORIES,
      "BenchmarkReportV02.countsByCategory",
    ),
    "BenchmarkReportV02.countsByCategory",
  );
  assertCountBucketsMatchV02(
    findingRootCauses,
    assertBenchmarkCountBucketsV02(
      report.countsByRootCause,
      LOCALIZATION_ROOT_CAUSES,
      "BenchmarkReportV02.countsByRootCause",
    ),
    "BenchmarkReportV02.countsByRootCause",
  );
  assertCountBucketsMatchV02(
    findingDetectorKinds,
    assertBenchmarkCountBucketsV02(
      report.countsByDetectorKind,
      QUALITY_DETECTOR_KINDS,
      "BenchmarkReportV02.countsByDetectorKind",
    ),
    "BenchmarkReportV02.countsByDetectorKind",
  );
  assertCountBucketsMatchV02(
    findingAdjudicationStates,
    assertBenchmarkCountBucketsV02(
      report.countsByAdjudicationState,
      LOCALIZATION_ADJUDICATION_STATES,
      "BenchmarkReportV02.countsByAdjudicationState",
    ),
    "BenchmarkReportV02.countsByAdjudicationState",
  );

  assertBenchmarkPenaltySummaryV02(
    report.penaltySummary,
    "BenchmarkReportV02.penaltySummary",
    findingQualitySeverities,
    totalSourceCharacterCount,
    totalSourceUnitCount,
  );

  const deterministicQaResults = asArray(
    report.deterministicQaResults,
    "BenchmarkReportV02.deterministicQaResults",
  );
  for (const [index, result] of deterministicQaResults.entries()) {
    const label = `BenchmarkReportV02.deterministicQaResults[${index}]`;
    assertDeterministicQaResultV02(result, label);
    assertKnownStringRefV02(
      result.evaluatedSystemId,
      `${label}.evaluatedSystemId`,
      "system",
      systemIds,
    );
    assertKnownUuid7RefsV02(result.findingIds, `${label}.findingIds`, "finding", findingIds);
  }

  const qaAgentEvaluations = asArray(
    report.qaAgentEvaluations,
    "BenchmarkReportV02.qaAgentEvaluations",
  );
  const qaAgentProviderRunIdsBySystem = new Map<string, Set<Uuid7>>();
  const qaAgentFindingIdsBySystem = new Map<string, Set<Uuid7>>();
  for (const [index, evaluation] of qaAgentEvaluations.entries()) {
    const label = `BenchmarkReportV02.qaAgentEvaluations[${index}]`;
    assertQaAgentEvaluationV02(evaluation, label);
    assertKnownStringRefV02(
      evaluation.evaluatedSystemId,
      `${label}.evaluatedSystemId`,
      "system",
      systemIds,
    );
    assertKnownUuid7RefsV02(
      evaluation.providerRunIds,
      `${label}.providerRunIds`,
      "providerRun",
      providerRunIds,
    );
    assertKnownUuid7RefsV02(evaluation.findingIds, `${label}.findingIds`, "finding", findingIds);
    for (const providerRunId of evaluation.providerRunIds) {
      const providerRunSystemId = providerRunSystemIds.get(providerRunId);
      if (providerRunSystemId !== evaluation.evaluatedSystemId) {
        throw new Error(
          `${label}.providerRunIds must reference providerModelCostRecords for evaluatedSystemId ${evaluation.evaluatedSystemId}`,
        );
      }
      addToSetMap(qaAgentProviderRunIdsBySystem, evaluation.evaluatedSystemId, providerRunId);
    }
    for (const findingId of evaluation.findingIds) {
      const findingSystemId = findingSystemIds.get(findingId);
      if (findingSystemId !== evaluation.evaluatedSystemId) {
        throw new Error(
          `${label}.findingIds must reference findingRecords for evaluatedSystemId ${evaluation.evaluatedSystemId}`,
        );
      }
      addToSetMap(qaAgentFindingIdsBySystem, evaluation.evaluatedSystemId, findingId);
    }
  }
  assertQaAgentCoverageV02(
    llmQaProviderRunSystemIds,
    llmQaFindingSystemIds,
    qaAgentProviderRunIdsBySystem,
    qaAgentFindingIdsBySystem,
  );

  const humanEvaluationResults = asArray(
    report.humanEvaluationResults,
    "BenchmarkReportV02.humanEvaluationResults",
  );
  for (const [index, evaluation] of humanEvaluationResults.entries()) {
    const label = `BenchmarkReportV02.humanEvaluationResults[${index}]`;
    assertHumanEvaluationResultV02(evaluation, label);
    for (const [systemIndex, systemId] of evaluation.evaluatedSystemIds.entries()) {
      assertKnownStringRefV02(
        systemId,
        `${label}.evaluatedSystemIds[${systemIndex}]`,
        "system",
        systemIds,
      );
    }
    assertKnownUuid7RefsV02(
      evaluation.adjudicatedFindingIds,
      `${label}.adjudicatedFindingIds`,
      "finding",
      findingIds,
    );
  }

  assertStringArray(report.knownBlindSpots, "BenchmarkReportV02.knownBlindSpots");
}

export function assertPatchExport(value: unknown): asserts value is PatchExport {
  const patch = asRecord(value, "PatchExport");
  assertEqual(patch.schemaVersion, "0.1.0", "PatchExport.schemaVersion");
  assertString(patch.patchExportId, "PatchExport.patchExportId");
  assertString(patch.sourceBridgeId, "PatchExport.sourceBridgeId");
  assertString(patch.targetLocale, "PatchExport.targetLocale");
  assertArray(patch.entries, "PatchExport.entries");
}

export function assertPatchExportV02(value: unknown): asserts value is PatchExportV02 {
  const patch = asRecord(value, "PatchExportV02");
  assertEqual(patch.schemaVersion, BRIDGE_SCHEMA_VERSION_V02, "PatchExportV02.schemaVersion");
  assertUuid7(patch.patchExportId, "PatchExportV02.patchExportId");
  assertUuid7(patch.sourceBridgeId, "PatchExportV02.sourceBridgeId");
  assertSourceGameRevisionV02(patch.sourceGame, "PatchExportV02.sourceGame");
  assertHashStringV02(patch.sourceBundleHash, "PatchExportV02.sourceBundleHash");
  assertSourceRevisionV02(patch.sourceBundleRevision, "PatchExportV02.sourceBundleRevision");
  assertRevisionHashMatchesV02(
    patch.sourceBundleRevision,
    patch.sourceBundleHash,
    "PatchExportV02.sourceBundleRevision",
  );
  assertString(patch.sourceLocale, "PatchExportV02.sourceLocale");
  assertString(patch.targetLocale, "PatchExportV02.targetLocale");
  assertHashStrategyV02(patch.hashStrategy, "PatchExportV02.hashStrategy");
  assertOptionalHashStringV02(patch.patchExportHash, "PatchExportV02.patchExportHash");
  assertOptionalRfc3339Instant(patch.generatedAt, "PatchExportV02.generatedAt");
  const entries = asArray(patch.entries, "PatchExportV02.entries");
  const entryKeys = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const label = `PatchExportV02.entries[${index}]`;
    assertPatchExportEntryV02(entry, label);
    const entryKey = `${entry.bridgeUnitId}\0${entry.sourceUnitKey}`;
    if (entryKeys.has(entryKey)) {
      throw new Error(`${label} must be unique by bridgeUnitId and sourceUnitKey`);
    }
    entryKeys.add(entryKey);
  }
}

export function computePatchResultOutputHashRollupV02(
  touchedAssets: readonly PatchTouchedAssetV02[],
): string {
  const sorted = [...touchedAssets].sort((a, b) =>
    a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0,
  );
  const payload = sorted.map((asset) => `${asset.assetId}\n${asset.outputHash}\n`).join("");
  const digest = createHash("sha256").update(payload, "utf8").digest("hex");
  return `sha256:${digest}`;
}

export function assertPatchFailureV02(value: unknown, label: string): PatchFailureV02 {
  const failure = asRecord(value, label);
  assertUuid7(failure.failureId, `${label}.failureId`);
  assertEnum(failure.category, PATCH_FAILURE_CATEGORIES_V02, `${label}.category`);
  assertString(failure.diagnosticCode, `${label}.diagnosticCode`);
  assertString(failure.cause, `${label}.cause`);
  assertUuid7(failure.assetId, `${label}.assetId`);
  assertUuid7(failure.bridgeUnitId, `${label}.bridgeUnitId`);
  assertString(failure.adapterId, `${label}.adapterId`);
  assertString(failure.command, `${label}.command`);
  assertOptionalUuid7(failure.patchExportEntryId, `${label}.patchExportEntryId`);
  if (failure.sourceLocation !== undefined) {
    assertSourceLocationV02(failure.sourceLocation, `${label}.sourceLocation`);
  }
  return failure as PatchFailureV02;
}
