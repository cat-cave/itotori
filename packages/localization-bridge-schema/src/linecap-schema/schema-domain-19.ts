import { Uuid7 } from "./schema-domain-01.js";
import {
  BENCHMARK_COST_KINDS,
  BENCHMARK_INPUT_KINDS,
  BENCHMARK_PROVIDER_FAMILIES,
  BENCHMARK_PROVIDER_RUN_STATUSES,
  BENCHMARK_SYSTEM_KINDS,
  BENCHMARK_TOKEN_COUNT_SOURCES,
  LOCALIZATION_ADJUDICATION_STATES,
  LOCALIZATION_QUALITY_CATEGORIES,
  LOCALIZATION_QUALITY_SEVERITIES,
  LOCALIZATION_QUALITY_TAXONOMY_ID,
  LOCALIZATION_QUALITY_TAXONOMY_VERSION,
  LOCALIZATION_ROOT_CAUSES,
  QUALITY_DETECTOR_KINDS,
  TRIAGE_TASK_KINDS,
} from "./schema-domain-02.js";
import {
  BenchmarkArtifactRefV02,
  BenchmarkCommandLineV02,
  BenchmarkComparedSystemV02,
  BenchmarkCostAmountV02,
  BenchmarkCostLedgerTotalV02,
  BenchmarkCostLedgerV02,
  BenchmarkInputRefV02,
  BenchmarkPromptIdentityV02,
  BenchmarkProviderIdentityV02,
  BenchmarkProviderRunV02,
  BenchmarkTokenUsageV02,
  BenchmarkToolVersionV02,
  FindingRecordV02,
} from "./schema-domain-04.js";
import {
  BenchmarkCountBucketV02,
  BenchmarkFindingRecordV02,
  BenchmarkSeededDefectOracleV02,
} from "./schema-domain-05.js";
import { assertPortableArtifactUriV02 } from "./schema-domain-15.js";
import {
  assertEvidenceArrayV02,
  assertProvenanceArrayV02,
  assertTriageSubjectRefsV02,
} from "./schema-domain-18.js";
import { assertKnownStringRefV02 } from "./schema-domain-20.js";
import {
  asArray,
  asRecord,
  assertOptionalBoolean,
  assertOptionalHashStringV02,
  assertOptionalString,
  assertRfc3339Instant,
  assertStartedCompletedInstantsV02,
  assertString,
  assertStringArray,
  assertUuid7Array,
} from "./schema-domain-21.js";
import {
  assertBoolean,
  assertEnum,
  assertEqual,
  assertNonNegativeInteger,
  assertOptionalNonNegativeInteger,
  assertOptionalUuid7,
  assertPositiveInteger,
  assertUuid7,
} from "./schema-domain-22.js";

export function assertFindingRecordEvidenceReferencesOwnProvenanceV02(
  finding: FindingRecordV02,
  label: string,
): void {
  const provenanceIds = new Set(finding.provenance.map((record) => record.provenanceId));
  for (const [evidenceIndex, evidence] of finding.evidence.entries()) {
    const evidenceLabel = `${label}.evidence[${evidenceIndex}]`;
    if (evidence.provenanceIds.length === 0) {
      throw new Error(`${evidenceLabel}.provenanceIds must contain at least one provenance id`);
    }
    for (const [provenanceIndex, provenanceId] of evidence.provenanceIds.entries()) {
      if (!provenanceIds.has(provenanceId)) {
        throw new Error(
          `${evidenceLabel}.provenanceIds[${provenanceIndex}] must reference provenance on the same finding`,
        );
      }
    }
  }
}

export function assertBenchmarkInputRefV02(
  value: unknown,
  label: string,
): asserts value is BenchmarkInputRefV02 {
  const inputRef = asRecord(value, label);
  assertString(inputRef.corpusRefId, `${label}.corpusRefId`);
  assertEnum(inputRef.corpusKind, BENCHMARK_INPUT_KINDS, `${label}.corpusKind`);
  assertString(inputRef.label, `${label}.label`);
  if (inputRef.manifestUri !== undefined) {
    assertPortableArtifactUriV02(inputRef.manifestUri, `${label}.manifestUri`);
  }
  assertOptionalHashStringV02(inputRef.manifestHash, `${label}.manifestHash`);
  assertOptionalHashStringV02(inputRef.sourceBundleHash, `${label}.sourceBundleHash`);
  assertString(inputRef.sourceLocale, `${label}.sourceLocale`);
  assertString(inputRef.targetLocale, `${label}.targetLocale`);
  assertString(inputRef.engineProfile, `${label}.engineProfile`);
  assertString(inputRef.benchmarkSplit, `${label}.benchmarkSplit`);
  assertPositiveInteger(inputRef.sourceUnitCount, `${label}.sourceUnitCount`);
  assertPositiveInteger(inputRef.sourceCharacterCount, `${label}.sourceCharacterCount`);
  assertBoolean(inputRef.publicContent, `${label}.publicContent`);
  if (inputRef.corpusKind === "private_local_corpus" && inputRef.publicContent) {
    throw new Error(`${label}.publicContent must be false for private_local_corpus`);
  }
}

export function assertBenchmarkToolVersionV02(
  value: unknown,
  label: string,
): asserts value is BenchmarkToolVersionV02 {
  const toolVersion = asRecord(value, label);
  assertString(toolVersion.name, `${label}.name`);
  assertString(toolVersion.version, `${label}.version`);
  assertOptionalString(toolVersion.gitCommit, `${label}.gitCommit`);
}

export function assertBenchmarkCommandLineV02(
  value: unknown,
  label: string,
): asserts value is BenchmarkCommandLineV02 {
  const commandLine = asRecord(value, label);
  assertString(commandLine.commandId, `${label}.commandId`);
  const argv = asArray(commandLine.argv, `${label}.argv`);
  if (argv.length === 0) {
    throw new Error(`${label}.argv must contain at least one command token`);
  }
  for (const [index, token] of argv.entries()) {
    assertString(token, `${label}.argv[${index}]`);
  }
}

export function assertBenchmarkComparedSystemV02(
  value: unknown,
  label: string,
): asserts value is BenchmarkComparedSystemV02 {
  const system = asRecord(value, label);
  assertString(system.systemId, `${label}.systemId`);
  assertEnum(system.systemKind, BENCHMARK_SYSTEM_KINDS, `${label}.systemKind`);
  assertString(system.displayName, `${label}.displayName`);
  assertRfc3339Instant(system.generatedAt, `${label}.generatedAt`);
  assertUuid7Array(system.providerRunIds, `${label}.providerRunIds`);
  assertOptionalString(system.promptPresetId, `${label}.promptPresetId`);
  assertOptionalString(system.promptPresetVersion, `${label}.promptPresetVersion`);
  if (system.outputArtifactRef !== undefined) {
    assertBenchmarkArtifactRefV02(system.outputArtifactRef, `${label}.outputArtifactRef`);
  }
  if (system.providerRunIds.length > 0 && system.promptPresetId === undefined) {
    throw new Error(`${label}.promptPresetId is required when providerRunIds are present`);
  }
}

export function assertBenchmarkArtifactRefV02(
  value: unknown,
  label: string,
): asserts value is BenchmarkArtifactRefV02 {
  const ref = asRecord(value, label);
  assertUuid7(ref.artifactId, `${label}.artifactId`);
  assertString(ref.artifactKind, `${label}.artifactKind`);
  assertPortableArtifactUriV02(ref.uri, `${label}.uri`);
  assertOptionalHashStringV02(ref.hash, `${label}.hash`);
  assertOptionalString(ref.mediaType, `${label}.mediaType`);
}

export function assertBenchmarkProviderRunV02(
  value: unknown,
  label: string,
): asserts value is BenchmarkProviderRunV02 {
  const run = asRecord(value, label);
  assertUuid7(run.providerRunId, `${label}.providerRunId`);
  assertString(run.systemId, `${label}.systemId`);
  assertEnum(run.taskKind, TRIAGE_TASK_KINDS, `${label}.taskKind`);
  assertStartedCompletedInstantsV02(run.startedAt, run.completedAt, label);
  if (run.latencyMs !== undefined) {
    assertNonNegativeInteger(run.latencyMs, `${label}.latencyMs`);
  }
  assertEnum(run.status, BENCHMARK_PROVIDER_RUN_STATUSES, `${label}.status`);
  assertBenchmarkProviderIdentityV02(run.provider, `${label}.provider`);
  assertBenchmarkPromptIdentityV02(run.prompt, `${label}.prompt`);
  assertString(run.structuredOutputMode, `${label}.structuredOutputMode`);
  assertNonNegativeInteger(run.retryCount, `${label}.retryCount`);
  assertStringArray(run.errorClasses, `${label}.errorClasses`);
  assertBoolean(run.fallbackUsed, `${label}.fallbackUsed`);
  if (run.fallbackPlan !== undefined) {
    assertStringArray(run.fallbackPlan, `${label}.fallbackPlan`);
  }
  assertBenchmarkTokenUsageV02(run.tokenUsage, `${label}.tokenUsage`);
  assertBenchmarkCostAmountV02(run.cost, `${label}.cost`);
  if (run.status === "failed" && run.errorClasses.length === 0) {
    throw new Error(`${label}.errorClasses must explain failed provider runs`);
  }
}

export function assertBenchmarkProviderIdentityV02(
  value: unknown,
  label: string,
): asserts value is BenchmarkProviderIdentityV02 {
  const provider = asRecord(value, label);
  assertEnum(provider.providerFamily, BENCHMARK_PROVIDER_FAMILIES, `${label}.providerFamily`);
  assertString(provider.endpointFamily, `${label}.endpointFamily`);
  assertString(provider.providerName, `${label}.providerName`);
  assertString(provider.requestedModelId, `${label}.requestedModelId`);
  assertString(provider.actualModelId, `${label}.actualModelId`);
  assertOptionalString(provider.upstreamProvider, `${label}.upstreamProvider`);
  assertOptionalHashStringV02(provider.routeSettingsHash, `${label}.routeSettingsHash`);
}

export function assertBenchmarkPromptIdentityV02(
  value: unknown,
  label: string,
): asserts value is BenchmarkPromptIdentityV02 {
  const prompt = asRecord(value, label);
  assertString(prompt.promptPresetId, `${label}.promptPresetId`);
  assertString(prompt.promptTemplateVersion, `${label}.promptTemplateVersion`);
  assertOptionalHashStringV02(prompt.promptHash, `${label}.promptHash`);
  assertOptionalString(prompt.remotePresetSlug, `${label}.remotePresetSlug`);
  assertOptionalString(prompt.remotePresetVersion, `${label}.remotePresetVersion`);
  assertOptionalHashStringV02(prompt.remotePresetConfigHash, `${label}.remotePresetConfigHash`);
}

export function assertBenchmarkTokenUsageV02(
  value: unknown,
  label: string,
): asserts value is BenchmarkTokenUsageV02 {
  const usage = asRecord(value, label);
  assertEnum(usage.tokenCountSource, BENCHMARK_TOKEN_COUNT_SOURCES, `${label}.tokenCountSource`);
  assertOptionalNonNegativeInteger(usage.promptTokens, `${label}.promptTokens`);
  assertOptionalNonNegativeInteger(usage.completionTokens, `${label}.completionTokens`);
  assertOptionalNonNegativeInteger(usage.reasoningTokens, `${label}.reasoningTokens`);
  assertOptionalNonNegativeInteger(usage.cachedInputTokens, `${label}.cachedInputTokens`);
  assertOptionalNonNegativeInteger(usage.totalTokens, `${label}.totalTokens`);
  if (usage.tokenCountSource === "unknown" && usage.totalTokens !== undefined) {
    throw new Error(`${label}.totalTokens must be omitted when tokenCountSource is unknown`);
  }
  if (usage.tokenCountSource !== "unknown" && usage.totalTokens === undefined) {
    throw new Error(`${label}.totalTokens is required unless tokenCountSource is unknown`);
  }
  const countedTotal =
    (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0) + (usage.reasoningTokens ?? 0);
  if (usage.totalTokens !== undefined && countedTotal > usage.totalTokens) {
    throw new Error(`${label}.totalTokens must be at least prompt + completion + reasoning tokens`);
  }
}

export function assertBenchmarkCostAmountV02(
  value: unknown,
  label: string,
): asserts value is BenchmarkCostAmountV02 {
  const cost = asRecord(value, label);
  assertEnum(cost.costKind, BENCHMARK_COST_KINDS, `${label}.costKind`);
  assertEqual(cost.currency, "USD", `${label}.currency`);
  assertOptionalNonNegativeInteger(cost.amountMicrosUsd, `${label}.amountMicrosUsd`);
  assertOptionalString(cost.pricingSnapshotId, `${label}.pricingSnapshotId`);
  if (cost.costKind === "unknown" && cost.amountMicrosUsd !== undefined) {
    throw new Error(`${label}.amountMicrosUsd must be omitted when costKind is unknown`);
  }
  if (cost.costKind !== "unknown" && cost.amountMicrosUsd === undefined) {
    throw new Error(`${label}.amountMicrosUsd is required unless costKind is unknown`);
  }
  if (cost.costKind === "zero" && cost.amountMicrosUsd !== 0) {
    throw new Error(`${label}.amountMicrosUsd must be 0 when costKind is zero`);
  }
}

export function assertBenchmarkCostLedgerV02(
  value: unknown,
  label: string,
  systemIds: ReadonlySet<string>,
  expectedReportTotalMicrosUsd: number,
  expectedTotalsBySystem: ReadonlyMap<string, number>,
  expectedIncludesUnknownCost: boolean,
  expectedLocaleBranchId: Uuid7 | undefined,
): asserts value is BenchmarkCostLedgerV02 {
  const ledger = asRecord(value, label);
  assertEqual(ledger.currency, "USD", `${label}.currency`);
  // the ledger's locale branch MUST match its report's. A
  // present-vs-absent mismatch or a different branch id is a conflation of
  // cost across target locale branches and is rejected.
  assertOptionalUuid7(ledger.localeBranchId, `${label}.localeBranchId`);
  if (ledger.localeBranchId !== expectedLocaleBranchId) {
    throw new Error(
      `${label}.localeBranchId must equal BenchmarkReportV02.localeBranchId (cost cannot be merged across target locale branches)`,
    );
  }
  assertNonNegativeInteger(ledger.reportTotalMicrosUsd, `${label}.reportTotalMicrosUsd`);
  if (ledger.reportTotalMicrosUsd !== expectedReportTotalMicrosUsd) {
    throw new Error(`${label}.reportTotalMicrosUsd must equal providerModelCostRecords total`);
  }
  assertBoolean(ledger.includesUnknownCost, `${label}.includesUnknownCost`);
  if (ledger.includesUnknownCost !== expectedIncludesUnknownCost) {
    throw new Error(`${label}.includesUnknownCost must match providerModelCostRecords`);
  }
  const totals = asArray(ledger.totalsBySystem, `${label}.totalsBySystem`);
  const seenSystemIds = new Set<string>();
  for (const [index, total] of totals.entries()) {
    const totalLabel = `${label}.totalsBySystem[${index}]`;
    assertBenchmarkCostLedgerTotalV02(total, totalLabel);
    assertKnownStringRefV02(total.systemId, `${totalLabel}.systemId`, "system", systemIds);
    if (seenSystemIds.has(total.systemId)) {
      throw new Error(`${totalLabel}.systemId must be unique within totalsBySystem`);
    }
    seenSystemIds.add(total.systemId);
    const expectedTotal = expectedTotalsBySystem.get(total.systemId) ?? 0;
    if (total.totalMicrosUsd !== expectedTotal) {
      throw new Error(`${totalLabel}.totalMicrosUsd must equal providerModelCostRecords total`);
    }
  }
  for (const [systemId, expectedTotal] of expectedTotalsBySystem) {
    if (expectedTotal > 0 && !seenSystemIds.has(systemId)) {
      throw new Error(`${label}.totalsBySystem must include system ${systemId}`);
    }
  }
}

export function assertBenchmarkCostLedgerTotalV02(
  value: unknown,
  label: string,
): asserts value is BenchmarkCostLedgerTotalV02 {
  const total = asRecord(value, label);
  assertString(total.systemId, `${label}.systemId`);
  assertNonNegativeInteger(total.totalMicrosUsd, `${label}.totalMicrosUsd`);
}

export function assertBenchmarkSeededDefectOracleV02(
  value: unknown,
  label: string,
): asserts value is BenchmarkSeededDefectOracleV02 {
  const seed = asRecord(value, label);
  assertString(seed.seededDefectId, `${label}.seededDefectId`);
  assertString(seed.fixtureOrCorpusRefId, `${label}.fixtureOrCorpusRefId`);
  assertString(seed.seedKind, `${label}.seedKind`);
  assertString(seed.targetLocale, `${label}.targetLocale`);
  assertTriageSubjectRefsV02(seed.affectedRefs, `${label}.affectedRefs`);
  assertEnum(seed.category, LOCALIZATION_QUALITY_CATEGORIES, `${label}.category`);
  assertOptionalString(seed.qualitySubcategory, `${label}.qualitySubcategory`);
  assertEnum(seed.qualitySeverity, LOCALIZATION_QUALITY_SEVERITIES, `${label}.qualitySeverity`);
  assertEnum(seed.expectedRootCause, LOCALIZATION_ROOT_CAUSES, `${label}.expectedRootCause`);
  const expectedDetectorKinds = asArray(
    seed.expectedDetectorKinds,
    `${label}.expectedDetectorKinds`,
  );
  if (expectedDetectorKinds.length === 0) {
    throw new Error(`${label}.expectedDetectorKinds must contain at least one detector kind`);
  }
  for (const [index, detectorKind] of expectedDetectorKinds.entries()) {
    assertEnum(detectorKind, QUALITY_DETECTOR_KINDS, `${label}.expectedDetectorKinds[${index}]`);
  }
  assertUuid7Array(seed.matchedFindingIds, `${label}.matchedFindingIds`);
  assertBoolean(seed.publicContent, `${label}.publicContent`);
}

export function assertBenchmarkFindingRecordV02(
  value: unknown,
  label: string,
): asserts value is BenchmarkFindingRecordV02 {
  const finding = asRecord(value, label);
  assertUuid7(finding.findingId, `${label}.findingId`);
  assertString(finding.systemId, `${label}.systemId`);
  assertEqual(finding.taxonomyId, LOCALIZATION_QUALITY_TAXONOMY_ID, `${label}.taxonomyId`);
  assertEqual(
    finding.taxonomyVersion,
    LOCALIZATION_QUALITY_TAXONOMY_VERSION,
    `${label}.taxonomyVersion`,
  );
  assertEnum(finding.detectorKind, QUALITY_DETECTOR_KINDS, `${label}.detectorKind`);
  assertEnum(finding.category, LOCALIZATION_QUALITY_CATEGORIES, `${label}.category`);
  assertOptionalString(finding.qualitySubcategory, `${label}.qualitySubcategory`);
  assertEnum(finding.qualitySeverity, LOCALIZATION_QUALITY_SEVERITIES, `${label}.qualitySeverity`);
  assertEnum(finding.rootCause, LOCALIZATION_ROOT_CAUSES, `${label}.rootCause`);
  assertEnum(
    finding.adjudicationState,
    LOCALIZATION_ADJUDICATION_STATES,
    `${label}.adjudicationState`,
  );
  assertTriageSubjectRefsV02(finding.affectedRefs, `${label}.affectedRefs`);
  assertEvidenceArrayV02(finding.evidence, `${label}.evidence`);
  assertProvenanceArrayV02(finding.provenance, `${label}.provenance`);
  assertBenchmarkFindingEvidenceProvenanceV02(finding as BenchmarkFindingRecordV02, label);
  assertOptionalString(finding.seededDefectId, `${label}.seededDefectId`);
  assertOptionalString(finding.reviewerRationale, `${label}.reviewerRationale`);
  // the LLM QA evaluation stage stamps unscorable findings so
  // downstream calibration can mirror the in-memory harness and exclude them
  // from the false-positive count. Optional on the wire; when present, must
  // be a boolean.
  assertOptionalBoolean(finding.unscorable, `${label}.unscorable`);
  if (
    finding.rootCause === "unknown_unadjudicated" &&
    finding.adjudicationState !== "unreviewed" &&
    finding.adjudicationState !== "needs_more_context"
  ) {
    throw new Error(`${label}.rootCause cannot be unknown_unadjudicated after adjudication`);
  }
}

export function assertBenchmarkFindingEvidenceProvenanceV02(
  finding: BenchmarkFindingRecordV02,
  label: string,
): void {
  const provenanceIds = new Set(finding.provenance.map((record) => record.provenanceId));
  for (const [evidenceIndex, evidence] of finding.evidence.entries()) {
    const evidenceLabel = `${label}.evidence[${evidenceIndex}]`;
    if (evidence.provenanceIds.length === 0) {
      throw new Error(`${evidenceLabel}.provenanceIds must contain at least one provenance id`);
    }
    for (const [provenanceIndex, provenanceId] of evidence.provenanceIds.entries()) {
      if (!provenanceIds.has(provenanceId)) {
        throw new Error(
          `${evidenceLabel}.provenanceIds[${provenanceIndex}] must reference provenance on the same finding`,
        );
      }
    }
  }
}

export function assertBenchmarkCountBucketsV02<T extends string>(
  value: unknown,
  allowedBuckets: readonly T[],
  label: string,
): BenchmarkCountBucketV02<T>[] {
  const records = asArray(value, label);
  const buckets: BenchmarkCountBucketV02<T>[] = [];
  const seenBuckets = new Set<T>();
  for (const [index, record] of records.entries()) {
    const bucketLabel = `${label}[${index}]`;
    const bucketRecord = asRecord(record, bucketLabel);
    assertEnum(bucketRecord.bucket, allowedBuckets, `${bucketLabel}.bucket`);
    assertNonNegativeInteger(bucketRecord.count, `${bucketLabel}.count`);
    if (seenBuckets.has(bucketRecord.bucket)) {
      throw new Error(`${bucketLabel}.bucket must be unique within ${label}`);
    }
    seenBuckets.add(bucketRecord.bucket);
    buckets.push({
      bucket: bucketRecord.bucket,
      count: bucketRecord.count,
    });
  }
  return buckets;
}
