import { Uuid7 } from "./schema-domain-01.js";
import {
  ALPHA_VERTICAL_PROOF_ARTIFACT_KINDS_V02,
  ALPHA_VERTICAL_PROOF_HASH_SCOPES_V02,
  AlphaVerticalProofArtifactKindV02,
  BENCHMARK_NORMALIZED_PENALTY_TOLERANCE,
  LOCALIZATION_QUALITY_SEVERITY_WEIGHTS,
  LOCALIZATION_QUALITY_TAXONOMY_ID,
  LocalizationQualitySeverityV02,
} from "./schema-domain-02.js";
import {
  BenchmarkCountBucketV02,
  BenchmarkPenaltySummaryV02,
  DeterministicQaResultV02,
  HumanEvaluationResultV02,
  QaAgentEvaluationV02,
  QaAgentMetricsV02,
} from "./schema-domain-05.js";
import {
  AlphaVerticalProofArtifactRefV02,
  AlphaVerticalProofArtifactRefsV02,
  AlphaVerticalProofBenchmarkOutputRefV02,
  AlphaVerticalProofBridgeUnitRefV02,
  AlphaVerticalProofContentHashV02,
  AlphaVerticalProofEngineProfileV02,
  AlphaVerticalProofFixtureRefV02,
} from "./schema-domain-07.js";
import { assertPortablePublicArtifactUriV02 } from "./schema-domain-15.js";
import { assertBenchmarkArtifactRefV02 } from "./schema-domain-19.js";
import {
  asArray,
  asRecord,
  assertAllowedKeysV02,
  assertHashStringV02,
  assertOptionalString,
  assertPublicFixtureIdV02,
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
  assertNonNegativeNumber,
  assertNumberWithinTolerance,
  assertPositiveInteger,
  assertRatio,
  assertUuid7,
} from "./schema-domain-22.js";

export function assertCountBucketsMatchV02<T extends string>(
  actualValues: readonly T[],
  buckets: readonly BenchmarkCountBucketV02<T>[],
  label: string,
): void {
  const actualCounts = new Map<T, number>();
  for (const value of actualValues) {
    actualCounts.set(value, (actualCounts.get(value) ?? 0) + 1);
  }
  const reportedBuckets = new Set<T>();
  for (const bucket of buckets) {
    reportedBuckets.add(bucket.bucket);
    const actualCount = actualCounts.get(bucket.bucket) ?? 0;
    if (bucket.count !== actualCount) {
      throw new Error(`${label}.${bucket.bucket} count must match findingRecords`);
    }
  }
  for (const [bucket, actualCount] of actualCounts) {
    if (actualCount > 0 && !reportedBuckets.has(bucket)) {
      throw new Error(`${label} must include bucket ${bucket}`);
    }
  }
}

export function assertBenchmarkPenaltySummaryV02(
  value: unknown,
  label: string,
  qualitySeverities: readonly LocalizationQualitySeverityV02[],
  totalSourceCharacterCount: number,
  totalSourceUnitCount: number,
): asserts value is BenchmarkPenaltySummaryV02 {
  const summary = asRecord(value, label);
  assertNonNegativeNumber(summary.penaltyTotal, `${label}.penaltyTotal`);
  assertNonNegativeNumber(
    summary.penaltyPerThousandSourceChars,
    `${label}.penaltyPerThousandSourceChars`,
  );
  assertNonNegativeNumber(
    summary.penaltyPerHundredSourceUnits,
    `${label}.penaltyPerHundredSourceUnits`,
  );
  const expectedPenaltyTotal = qualitySeverities.reduce(
    (total, severity) => total + LOCALIZATION_QUALITY_SEVERITY_WEIGHTS[severity],
    0,
  );
  if (summary.penaltyTotal !== expectedPenaltyTotal) {
    throw new Error(
      `${label}.penaltyTotal must match findingRecords qualitySeverity weights from ${LOCALIZATION_QUALITY_TAXONOMY_ID}`,
    );
  }
  assertNumberWithinTolerance(
    summary.penaltyPerThousandSourceChars,
    (expectedPenaltyTotal / totalSourceCharacterCount) * 1000,
    BENCHMARK_NORMALIZED_PENALTY_TOLERANCE,
    `${label}.penaltyPerThousandSourceChars`,
    "findingRecords qualitySeverity weights normalized by fixtureOrCorpusRefs.sourceCharacterCount",
  );
  assertNumberWithinTolerance(
    summary.penaltyPerHundredSourceUnits,
    (expectedPenaltyTotal / totalSourceUnitCount) * 100,
    BENCHMARK_NORMALIZED_PENALTY_TOLERANCE,
    `${label}.penaltyPerHundredSourceUnits`,
    "findingRecords qualitySeverity weights normalized by fixtureOrCorpusRefs.sourceUnitCount",
  );
}

export function assertDeterministicQaResultV02(
  value: unknown,
  label: string,
): asserts value is DeterministicQaResultV02 {
  const result = asRecord(value, label);
  assertUuid7(result.deterministicQaRunId, `${label}.deterministicQaRunId`);
  assertString(result.evaluatedSystemId, `${label}.evaluatedSystemId`);
  assertString(result.checkName, `${label}.checkName`);
  assertString(result.checkVersion, `${label}.checkVersion`);
  assertStartedCompletedInstantsV02(result.startedAt, result.completedAt, label);
  assertNonNegativeInteger(result.ruleCount, `${label}.ruleCount`);
  assertNonNegativeInteger(result.passedRuleCount, `${label}.passedRuleCount`);
  assertNonNegativeInteger(result.failedRuleCount, `${label}.failedRuleCount`);
  if (result.passedRuleCount + result.failedRuleCount !== result.ruleCount) {
    throw new Error(`${label}.passedRuleCount plus failedRuleCount must equal ruleCount`);
  }
  assertUuid7Array(result.findingIds, `${label}.findingIds`);
  const artifactRefs = asArray(result.artifactRefs, `${label}.artifactRefs`);
  for (const [index, artifactRef] of artifactRefs.entries()) {
    assertBenchmarkArtifactRefV02(artifactRef, `${label}.artifactRefs[${index}]`);
  }
}

export function assertQaAgentEvaluationV02(
  value: unknown,
  label: string,
): asserts value is QaAgentEvaluationV02 {
  const evaluation = asRecord(value, label);
  assertUuid7(evaluation.qaAgentEvaluationId, `${label}.qaAgentEvaluationId`);
  assertString(evaluation.qaAgentId, `${label}.qaAgentId`);
  assertString(evaluation.qaAgentVersion, `${label}.qaAgentVersion`);
  assertString(evaluation.evaluatedSystemId, `${label}.evaluatedSystemId`);
  assertUuid7Array(evaluation.providerRunIds, `${label}.providerRunIds`);
  assertUuid7Array(evaluation.findingIds, `${label}.findingIds`);
  assertQaAgentMetricsV02(evaluation.metrics, `${label}.metrics`);
  assertStringArray(evaluation.limitations, `${label}.limitations`);
}

export function assertQaAgentMetricsV02(
  value: unknown,
  label: string,
): asserts value is QaAgentMetricsV02 {
  const metrics = asRecord(value, label);
  assertRatio(metrics.seededRecall, `${label}.seededRecall`);
  assertRatio(metrics.seededPrecision, `${label}.seededPrecision`);
  assertRatio(metrics.f1, `${label}.f1`);
  assertRatio(metrics.categoryAccuracy, `${label}.categoryAccuracy`);
  assertRatio(metrics.qualitySeverityAccuracy, `${label}.qualitySeverityAccuracy`);
  assertRatio(metrics.rootCauseAccuracy, `${label}.rootCauseAccuracy`);
  assertRatio(metrics.criticalRecall, `${label}.criticalRecall`);
  assertRatio(metrics.unscorableRate, `${label}.unscorableRate`);
  if (metrics.humanConfirmedPrecision !== undefined) {
    assertRatio(metrics.humanConfirmedPrecision, `${label}.humanConfirmedPrecision`);
  }
  assertNonNegativeInteger(metrics.findingsEmitted, `${label}.findingsEmitted`);
  assertNonNegativeInteger(metrics.scorableFindings, `${label}.scorableFindings`);
  assertNonNegativeInteger(metrics.adjudicatedFindings, `${label}.adjudicatedFindings`);
  if (metrics.scorableFindings > metrics.findingsEmitted) {
    throw new Error(`${label}.scorableFindings must not exceed findingsEmitted`);
  }
  if (metrics.adjudicatedFindings > metrics.findingsEmitted) {
    throw new Error(`${label}.adjudicatedFindings must not exceed findingsEmitted`);
  }
}

export function assertHumanEvaluationResultV02(
  value: unknown,
  label: string,
): asserts value is HumanEvaluationResultV02 {
  const evaluation = asRecord(value, label);
  assertUuid7(evaluation.humanEvaluationId, `${label}.humanEvaluationId`);
  assertUuid7(evaluation.reviewSessionId, `${label}.reviewSessionId`);
  const evaluatedSystemIds = asArray(evaluation.evaluatedSystemIds, `${label}.evaluatedSystemIds`);
  if (evaluatedSystemIds.length === 0) {
    throw new Error(`${label}.evaluatedSystemIds must contain at least one system id`);
  }
  for (const [index, systemId] of evaluatedSystemIds.entries()) {
    assertString(systemId, `${label}.evaluatedSystemIds[${index}]`);
  }
  assertPositiveInteger(evaluation.reviewerCount, `${label}.reviewerCount`);
  assertPositiveInteger(evaluation.sampleUnitCount, `${label}.sampleUnitCount`);
  assertPositiveInteger(
    evaluation.sampleSourceCharacterCount,
    `${label}.sampleSourceCharacterCount`,
  );
  assertBoolean(evaluation.blindReview, `${label}.blindReview`);
  assertUuid7Array(evaluation.adjudicatedFindingIds, `${label}.adjudicatedFindingIds`);
  assertOptionalString(evaluation.reviewerAgreementNotes, `${label}.reviewerAgreementNotes`);
}

export function assertQaAgentCoverageV02(
  llmQaProviderRunSystemIds: ReadonlyMap<Uuid7, string>,
  llmQaFindingSystemIds: ReadonlyMap<Uuid7, string>,
  qaAgentProviderRunIdsBySystem: ReadonlyMap<string, ReadonlySet<Uuid7>>,
  qaAgentFindingIdsBySystem: ReadonlyMap<string, ReadonlySet<Uuid7>>,
): void {
  for (const [providerRunId, systemId] of llmQaProviderRunSystemIds) {
    if (!qaAgentProviderRunIdsBySystem.get(systemId)?.has(providerRunId)) {
      throw new Error(
        `BenchmarkReportV02.qaAgentEvaluations.providerRunIds must cover llm_qa providerModelCostRecords run ${providerRunId} for evaluatedSystemId ${systemId}`,
      );
    }
  }
  for (const [findingId, systemId] of llmQaFindingSystemIds) {
    if (!qaAgentFindingIdsBySystem.get(systemId)?.has(findingId)) {
      throw new Error(
        `BenchmarkReportV02.qaAgentEvaluations.findingIds must cover llm_qa findingRecords finding ${findingId} for evaluatedSystemId ${systemId}`,
      );
    }
  }
}

export function addToSetMap<Key, Value>(map: Map<Key, Set<Value>>, key: Key, value: Value): void {
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, new Set([value]));
    return;
  }
  existing.add(value);
}

export function assertKnownStringRefV02(
  id: string,
  label: string,
  targetName: string,
  knownIds: ReadonlySet<string>,
): void {
  if (!knownIds.has(id)) {
    throw new Error(`${label} must reference an existing ${targetName}`);
  }
}

export function assertKnownUuid7RefsV02(
  ids: readonly Uuid7[],
  label: string,
  targetName: string,
  knownIds: ReadonlySet<Uuid7>,
): void {
  for (const [index, id] of ids.entries()) {
    if (!knownIds.has(id)) {
      throw new Error(`${label}[${index}] must reference an existing ${targetName}`);
    }
  }
}

export function assertAlphaVerticalProofFixtureRefV02(
  value: unknown,
  label: string,
): asserts value is AlphaVerticalProofFixtureRefV02 {
  const fixture = asRecord(value, label);
  assertAllowedKeysV02(
    fixture,
    ["fixtureId", "publicManifestUri", "publicManifestHash", "publicRedistribution"],
    label,
  );
  assertPublicFixtureIdV02(fixture.fixtureId, `${label}.fixtureId`);
  assertPortablePublicArtifactUriV02(fixture.publicManifestUri, `${label}.publicManifestUri`);
  assertHashStringV02(fixture.publicManifestHash, `${label}.publicManifestHash`);
  assertEqual(fixture.publicRedistribution, "allowed", `${label}.publicRedistribution`);
}

export function assertAlphaVerticalProofEngineProfileV02(
  value: unknown,
  label: string,
): asserts value is AlphaVerticalProofEngineProfileV02 {
  const profile = asRecord(value, label);
  assertAllowedKeysV02(
    profile,
    [
      "engineProfileId",
      "engineKind",
      "kaifuuProfileId",
      "itotoriWorkflowId",
      "utsushiRuntimeProfileId",
    ],
    label,
  );
  assertString(profile.engineProfileId, `${label}.engineProfileId`);
  assertString(profile.engineKind, `${label}.engineKind`);
  assertString(profile.kaifuuProfileId, `${label}.kaifuuProfileId`);
  assertString(profile.itotoriWorkflowId, `${label}.itotoriWorkflowId`);
  assertString(profile.utsushiRuntimeProfileId, `${label}.utsushiRuntimeProfileId`);
}

export function assertAlphaVerticalProofBridgeUnitRefV02(
  value: unknown,
  label: string,
): asserts value is AlphaVerticalProofBridgeUnitRefV02 {
  const ref = asRecord(value, label);
  assertAllowedKeysV02(ref, ["bridgeUnitId", "sourceUnitKey", "sourceHash"], label);
  assertUuid7(ref.bridgeUnitId, `${label}.bridgeUnitId`);
  assertString(ref.sourceUnitKey, `${label}.sourceUnitKey`);
  assertHashStringV02(ref.sourceHash, `${label}.sourceHash`);
}

export function assertAlphaVerticalProofArtifactRefsV02(
  value: unknown,
  label: string,
): asserts value is AlphaVerticalProofArtifactRefsV02 {
  const refs = asRecord(value, label);
  assertAllowedKeysV02(
    refs,
    [
      "publicFixtureManifest",
      "bridgeBundle",
      "patchExport",
      "patchResult",
      "deltaPackage",
      "runtimeReport",
      "findingReport",
      "benchmarkReport",
    ],
    label,
  );
  assertAlphaVerticalProofArtifactRefV02(
    refs.publicFixtureManifest,
    `${label}.publicFixtureManifest`,
    "public_fixture_manifest",
  );
  assertAlphaVerticalProofArtifactRefV02(
    refs.bridgeBundle,
    `${label}.bridgeBundle`,
    "bridge_bundle",
  );
  assertAlphaVerticalProofArtifactRefV02(refs.patchExport, `${label}.patchExport`, "patch_export");
  assertAlphaVerticalProofArtifactRefV02(refs.patchResult, `${label}.patchResult`, "patch_result");
  assertAlphaVerticalProofArtifactRefV02(
    refs.deltaPackage,
    `${label}.deltaPackage`,
    "delta_package",
  );
  assertAlphaVerticalProofArtifactRefV02(
    refs.runtimeReport,
    `${label}.runtimeReport`,
    "runtime_report",
  );
  if (refs.findingReport !== undefined) {
    assertAlphaVerticalProofArtifactRefV02(
      refs.findingReport,
      `${label}.findingReport`,
      "finding_report",
    );
  }
  assertAlphaVerticalProofArtifactRefV02(
    refs.benchmarkReport,
    `${label}.benchmarkReport`,
    "benchmark_report",
  );
}

export function assertAlphaVerticalProofArtifactRefV02(
  value: unknown,
  label: string,
  expectedKind: AlphaVerticalProofArtifactKindV02,
): asserts value is AlphaVerticalProofArtifactRefV02 {
  const ref = asRecord(value, label);
  assertAllowedKeysV02(
    ref,
    ["artifactId", "artifactKind", "uri", "hash", "mediaType", "byteSize"],
    label,
  );
  assertUuid7(ref.artifactId, `${label}.artifactId`);
  assertEnum(ref.artifactKind, ALPHA_VERTICAL_PROOF_ARTIFACT_KINDS_V02, `${label}.artifactKind`);
  if (ref.artifactKind !== expectedKind) {
    throw new Error(`${label}.artifactKind must be ${expectedKind}`);
  }
  assertPortablePublicArtifactUriV02(ref.uri, `${label}.uri`);
  assertHashStringV02(ref.hash, `${label}.hash`);
  assertOptionalString(ref.mediaType, `${label}.mediaType`);
  if (ref.byteSize !== undefined) {
    assertPositiveInteger(ref.byteSize, `${label}.byteSize`);
  }
}

export function assertAlphaVerticalProofBenchmarkOutputRefV02(
  value: unknown,
  label: string,
): asserts value is AlphaVerticalProofBenchmarkOutputRefV02 {
  const ref = asRecord(value, label);
  assertAllowedKeysV02(ref, ["benchmarkRunId", "artifactRef"], label);
  assertUuid7(ref.benchmarkRunId, `${label}.benchmarkRunId`);
  assertAlphaVerticalProofArtifactRefV02(
    ref.artifactRef,
    `${label}.artifactRef`,
    "benchmark_report",
  );
}

export function assertAlphaVerticalProofContentHashesV02(
  value: unknown,
  label: string,
): AlphaVerticalProofContentHashV02[] {
  const hashes = asArray(value, label);
  if (hashes.length === 0) {
    throw new Error(`${label} must contain at least one content hash`);
  }
  const entries: AlphaVerticalProofContentHashV02[] = [];
  const keys = new Set<string>();
  for (const [index, hash] of hashes.entries()) {
    const hashLabel = `${label}[${index}]`;
    const entry = asRecord(hash, hashLabel);
    assertAllowedKeysV02(entry, ["scope", "contentId", "hash"], hashLabel);
    assertEnum(entry.scope, ALPHA_VERTICAL_PROOF_HASH_SCOPES_V02, `${hashLabel}.scope`);
    assertString(entry.contentId, `${hashLabel}.contentId`);
    assertHashStringV02(entry.hash, `${hashLabel}.hash`);
    const key = `${entry.scope}\0${entry.contentId}`;
    if (keys.has(key)) {
      throw new Error(`${hashLabel} must be unique by scope and contentId`);
    }
    keys.add(key);
    entries.push(entry as AlphaVerticalProofContentHashV02);
  }
  return entries;
}
