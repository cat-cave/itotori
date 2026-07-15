import {
  ACCEPTANCE_SCORE_RESULT_SCHEMA_VERSION,
  AcceptanceEvidenceBundleSchema,
  AcceptanceScoreResultSchema,
  type AcceptanceDimensionResult,
  type AcceptanceEvidenceBundle,
  type AcceptanceScoreResult,
} from "../../src/contracts/index.js";
import { sha256Bytes, stableJson } from "../../src/corpus-manifest/manifest.js";
import type { PinnedAcceptanceArtifacts } from "./artifacts.js";

function hash(value: unknown) {
  return sha256Bytes(stableJson(value));
}

function hasExactSet(actual: readonly string[], expected: ReadonlySet<string>): boolean {
  return actual.length === expected.size && new Set(actual).size === actual.length
    ? actual.every((value) => expected.has(value))
    : false;
}

function sameOrderedValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function passed(value: boolean): "PASS" | "FAIL" {
  return value ? "PASS" : "FAIL";
}

export function scoreAcceptance(
  input: unknown,
  pinned: PinnedAcceptanceArtifacts,
): AcceptanceScoreResult {
  const evidence = AcceptanceEvidenceBundleSchema.parse(input);
  const { definition, labels, corpus } = pinned;
  if (
    evidence.scorecardDefinitionHash !== definition.contentAddress.sha256 ||
    evidence.humanCalibrationLabelsHash !== labels.contentAddress.sha256 ||
    evidence.corpusManifestHash !== corpus.contentAddress.manifestSha256
  ) {
    throw new Error("acceptance evidence addresses a different scoring contract");
  }

  const expectedUnits = new Map(
    corpus.outputScope.units.map((unit) => [unit.bridgeUnitId, unit.sourceHash]),
  );
  if (
    expectedUnits.size !== definition.dimensions.completion.requiredUnitCount ||
    corpus.outputScope.bridge.unitsProjectionSha256 !== definition.corpus.unitsProjectionSha256
  ) {
    throw new Error("frozen scorecard scope does not match its corpus projection");
  }

  const attempts = evidence.efficiency.attempts;
  const attemptMemoKeys = attempts.map((attempt) => attempt.memo.key.memoKey);
  const attemptMemoKeySet = new Set(attemptMemoKeys);
  const uniqueAttempts = attemptMemoKeySet.size === attemptMemoKeys.length;
  const physicalCalls = attempts.flatMap((attempt) =>
    attempt.memo.value.routerAttempts.map((routerAttempt) => ({ attempt, routerAttempt })),
  );

  const unitOutputs = evidence.completion.acceptedOutputs.filter(
    (output) => output.subjectType === "unit",
  );
  const outputByUnit = new Map(unitOutputs.map((output) => [output.subjectId, output]));
  const outputHashes = new Map(unitOutputs.map((output) => [output.outputId, hash(output)]));
  const acceptedStages = new Set(definition.dimensions.completion.acceptedStages);
  const completionPass =
    evidence.completion.acceptedOutputs.length === expectedUnits.size &&
    unitOutputs.length === expectedUnits.size &&
    outputByUnit.size === expectedUnits.size &&
    outputHashes.size === expectedUnits.size &&
    [...outputByUnit.entries()].every(
      ([unitId, output]) =>
        expectedUnits.get(unitId) === output.sourceHash &&
        acceptedStages.has(output.stage as "final" | "build-lqa") &&
        output.releaseEligibility.kind === "shippable" &&
        output.memoKeys.length > 0 &&
        output.memoKeys.every((memoKey) => attemptMemoKeySet.has(memoKey)),
    );

  const physicalAttemptCount = physicalCalls.length;
  const efficiencyPass =
    evidence.efficiency.lineage === definition.dimensions.efficiency.lineage &&
    uniqueAttempts &&
    physicalAttemptCount <= definition.dimensions.efficiency.maximumPhysicalAttempts;

  const wireProofKeys = evidence.zdr.wireProofs.map(
    (proof) => `${proof.memoKey}:${proof.routerAttemptOrdinal}`,
  );
  const wireProofByKey = new Map(
    evidence.zdr.wireProofs.map((proof) => [
      `${proof.memoKey}:${proof.routerAttemptOrdinal}`,
      proof,
    ]),
  );
  let verifiedCallCount = 0;
  for (const { attempt, routerAttempt } of physicalCalls) {
    const memo = attempt.memo;
    const proof = wireProofByKey.get(`${memo.key.memoKey}:${routerAttempt.ordinal}`);
    const verification = memo.value.verification;
    const finalPairMatches =
      verification.status === "verified" &&
      (routerAttempt.generationId !== verification.generationId ||
        (proof?.servedModel === verification.served.model &&
          proof.servedProvider === verification.served.provider));
    if (
      proof !== undefined &&
      routerAttempt.provider !== null &&
      routerAttempt.generationId !== null &&
      proof.servedProvider === routerAttempt.provider &&
      proof.generationId === routerAttempt.generationId &&
      proof.requestPolicyVerified &&
      proof.servedPairVerified &&
      proof.metadataCaptured &&
      proof.cacheDisabled &&
      proof.noPlugins &&
      finalPairMatches
    ) {
      verifiedCallCount += 1;
    }
  }
  const zdrPass =
    evidence.zdr.account.verified &&
    evidence.zdr.guardrail.verified &&
    wireProofByKey.size === physicalAttemptCount &&
    wireProofKeys.length === wireProofByKey.size &&
    verifiedCallCount === physicalAttemptCount;

  const acceptedOutputHashSet = new Set(outputHashes.values());
  const requiredRestartKinds = new Set(definition.dimensions.sys1.requiredRestartKinds);
  let passingRestartProofCount = 0;
  for (const proof of evidence.sys1.restartProofs) {
    const beforeMemoKeys = new Set(proof.acceptedMemoKeysBefore);
    const afterMemoKeys = new Set(proof.acceptedMemoKeysAfter);
    const beforeOutputHashes = new Set(proof.acceptedOutputHashesBefore);
    const afterOutputHashes = new Set(proof.acceptedOutputHashesAfter);
    const scopedOutput = proof.kind === "unit-restart" ? outputByUnit.get(proof.unitId) : undefined;
    const expectedMemoKeys =
      proof.kind === "pipeline-restart" ? attemptMemoKeySet : new Set(scopedOutput?.memoKeys ?? []);
    const expectedOutputHashes =
      proof.kind === "pipeline-restart"
        ? acceptedOutputHashSet
        : new Set(scopedOutput === undefined ? [] : [outputHashes.get(scopedOutput.outputId)!]);
    if (
      beforeMemoKeys.size > 0 &&
      beforeOutputHashes.size > 0 &&
      beforeMemoKeys.size === proof.acceptedMemoKeysBefore.length &&
      afterMemoKeys.size === proof.acceptedMemoKeysAfter.length &&
      beforeOutputHashes.size === proof.acceptedOutputHashesBefore.length &&
      afterOutputHashes.size === proof.acceptedOutputHashesAfter.length &&
      hasExactSet(proof.acceptedMemoKeysBefore, expectedMemoKeys) &&
      hasExactSet(proof.acceptedMemoKeysAfter, expectedMemoKeys) &&
      hasExactSet(proof.acceptedOutputHashesBefore, expectedOutputHashes) &&
      hasExactSet(proof.acceptedOutputHashesAfter, expectedOutputHashes) &&
      proof.redispatchedMemoKeys.length <=
        definition.dimensions.sys1.maximumRedispatchedMemoizedCalls &&
      proof.discardedAcceptedOutputHashes.length <=
        definition.dimensions.sys1.maximumDiscardedAcceptedOutputs
    ) {
      passingRestartProofCount += 1;
    }
  }
  const restartKinds = evidence.sys1.restartProofs.map((proof) => proof.kind);
  const sys1Pass =
    hasExactSet(restartKinds, requiredRestartKinds) &&
    passingRestartProofCount === requiredRestartKinds.size;

  const expectedCitations = new Set(
    unitOutputs.flatMap((output) =>
      output.evidenceIds.map((evidenceId) => `${output.outputId}:${evidenceId}`),
    ),
  );
  const citationKeys = evidence.grounding.citationChecks.map(
    (check) => `${check.outputId}:${check.evidenceId}`,
  );
  const passingCitationCount = evidence.grounding.citationChecks.filter((check) => {
    const output = unitOutputs.find((candidate) => candidate.outputId === check.outputId);
    return (
      output !== undefined &&
      check.snapshotId === output.localizationSnapshotId &&
      check.exists &&
      check.visibleInSnapshot &&
      check.scopeMatches &&
      check.hashMatches
    );
  }).length;
  const groundingPass =
    evidence.grounding.strictTerminalSchemas &&
    evidence.grounding.noRawJsonSalvage &&
    unitOutputs.every((output) => output.evidenceIds.length > 0) &&
    hasExactSet(citationKeys, expectedCitations) &&
    passingCitationCount === expectedCitations.size;

  let consistentUnitCount = 0;
  const bibleUnits: string[] = [];
  const bibleHeadHashes = new Set<string>();
  for (const receipt of evidence.bibleConsistency.receipts) {
    const output = outputByUnit.get(receipt.unitId);
    bibleUnits.push(receipt.unitId);
    bibleHeadHashes.add(receipt.bibleHeadHash);
    if (
      output !== undefined &&
      output.outputId === receipt.outputId &&
      output.value.basis.kind === "wiki-first" &&
      sameOrderedValues(output.value.basis.bibleRenderingIds, receipt.bibleRenderingIds) &&
      receipt.consistent
    ) {
      consistentUnitCount += 1;
    }
  }
  const biblePass =
    hasExactSet(bibleUnits, new Set(expectedUnits.keys())) &&
    bibleHeadHashes.size === 1 &&
    consistentUnitCount === expectedUnits.size;

  let coveredUnitCount = 0;
  const patchUnits: string[] = [];
  for (const receipt of evidence.patchCoverage.receipts) {
    const output = outputByUnit.get(receipt.unitId);
    patchUnits.push(receipt.unitId);
    if (
      output !== undefined &&
      output.outputId === receipt.outputId &&
      output.sourceHash === receipt.sourceHash &&
      output.value.targetHash === receipt.targetHash &&
      receipt.covered &&
      receipt.protectedSpansPassed &&
      receipt.shiftJisPassed
    ) {
      coveredUnitCount += 1;
    }
  }
  const patchPass =
    !evidence.patchCoverage.partial &&
    hasExactSet(patchUnits, new Set(expectedUnits.keys())) &&
    coveredUnitCount === definition.dimensions.patchCoverage.requiredUnitCount;

  let replayedUnitCount = 0;
  const replayUnits: string[] = [];
  for (const receipt of evidence.translatedByteReplay.receipts) {
    const output = outputByUnit.get(receipt.unitId);
    replayUnits.push(receipt.unitId);
    if (
      output !== undefined &&
      receipt.acceptedTargetHash === output.value.targetHash &&
      receipt.observedTargetHash === output.value.targetHash &&
      receipt.fromPatchedTargetBytes &&
      receipt.replayPassed
    ) {
      replayedUnitCount += 1;
    }
  }
  const translatedReplayPass =
    evidence.translatedByteReplay.patchHash === evidence.patchCoverage.patchHash &&
    evidence.translatedByteReplay.sourceBytesHash !==
      evidence.translatedByteReplay.patchedBytesHash &&
    hasExactSet(replayUnits, new Set(expectedUnits.keys())) &&
    replayedUnitCount === definition.dimensions.translatedByteReplay.requiredUnitCount;

  const acceptedOutputsHash = hash(
    [...unitOutputs].sort((left, right) => left.outputId.localeCompare(right.outputId)),
  );
  const replayStateMatches =
    stableJson(evidence.zeroCallReplay.before) === stableJson(evidence.zeroCallReplay.after);
  const zeroCallReplayPass =
    evidence.zeroCallReplay.newPhysicalAttempts <=
      definition.dimensions.zeroCallReplay.maximumNewPhysicalAttempts &&
    replayStateMatches &&
    evidence.zeroCallReplay.before.acceptedOutputsHash === acceptedOutputsHash &&
    bibleHeadHashes.has(evidence.zeroCallReplay.before.bibleHash) &&
    evidence.zeroCallReplay.before.patchHash === evidence.patchCoverage.patchHash &&
    evidence.zeroCallReplay.before.replayArtifactHash ===
      evidence.translatedByteReplay.replayArtifactHash;

  const dimensions: AcceptanceDimensionResult[] = [
    {
      dimension: "completion",
      status: passed(completionPass),
      evidenceHash: hash(evidence.completion),
      requiredUnitCount: definition.dimensions.completion.requiredUnitCount,
      writtenUnitCount: outputByUnit.size,
    },
    {
      dimension: "cold-lineage-physical-attempts",
      status: passed(efficiencyPass),
      evidenceHash: hash(evidence.efficiency),
      maximumPhysicalAttempts: definition.dimensions.efficiency.maximumPhysicalAttempts,
      physicalAttemptCount,
      coldLineage: evidence.efficiency.lineage === "cold",
    },
    {
      dimension: "zdr",
      status: passed(zdrPass),
      evidenceHash: hash(evidence.zdr),
      physicalCallCount: physicalAttemptCount,
      verifiedCallCount,
      accountVerified: evidence.zdr.account.verified,
      guardrailVerified: evidence.zdr.guardrail.verified,
    },
    {
      dimension: "sys1-durability",
      status: passed(sys1Pass),
      evidenceHash: hash(evidence.sys1),
      requiredRestartProofCount: requiredRestartKinds.size,
      passingRestartProofCount,
    },
    {
      dimension: "strict-grounding",
      status: passed(groundingPass),
      evidenceHash: hash(evidence.grounding),
      citationCount: expectedCitations.size,
      passingCitationCount,
      strictTerminalSchemas: evidence.grounding.strictTerminalSchemas,
      noRawJsonSalvage: evidence.grounding.noRawJsonSalvage,
    },
    {
      dimension: "bible-consistency",
      status: passed(biblePass),
      evidenceHash: hash(evidence.bibleConsistency),
      requiredUnitCount: definition.dimensions.completion.requiredUnitCount,
      consistentUnitCount,
    },
    {
      dimension: "patch-coverage",
      status: passed(patchPass),
      evidenceHash: hash(evidence.patchCoverage),
      requiredUnitCount: definition.dimensions.patchCoverage.requiredUnitCount,
      coveredUnitCount,
      patchHash: evidence.patchCoverage.patchHash,
    },
    {
      dimension: "translated-byte-replay",
      status: passed(translatedReplayPass),
      evidenceHash: hash(evidence.translatedByteReplay),
      requiredUnitCount: definition.dimensions.translatedByteReplay.requiredUnitCount,
      replayedUnitCount,
      patchedBytesHash: evidence.translatedByteReplay.patchedBytesHash,
    },
    {
      dimension: "zero-call-deterministic-replay",
      status: passed(zeroCallReplayPass),
      evidenceHash: hash(evidence.zeroCallReplay),
      newPhysicalAttempts: evidence.zeroCallReplay.newPhysicalAttempts,
      identicalArtifacts: replayStateMatches,
    },
  ];

  return AcceptanceScoreResultSchema.parse({
    schemaVersion: ACCEPTANCE_SCORE_RESULT_SCHEMA_VERSION,
    runId: evidence.runId,
    scorecardDefinitionHash: evidence.scorecardDefinitionHash,
    humanCalibrationLabelsHash: evidence.humanCalibrationLabelsHash,
    corpusManifestHash: evidence.corpusManifestHash,
    evidenceBundleHash: hash(evidence),
    status: dimensions.every((dimension) => dimension.status === "PASS") ? "PASS" : "FAIL",
    dimensions,
  });
}

export type { AcceptanceEvidenceBundle };
