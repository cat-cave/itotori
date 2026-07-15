import {
  ACCEPTANCE_EVIDENCE_BUNDLE_SCHEMA_VERSION,
  ACCEPTED_OUTPUT_SCHEMA_VERSION,
  AcceptanceEvidenceBundleSchema,
  PhysicalStepMemoSchema,
  type AcceptanceEvidenceBundle,
} from "../../src/contracts/index.js";
import { sha256Bytes, stableJson } from "../../src/corpus-manifest/manifest.js";
import { memoExample } from "../contract-fixtures-calls.js";
import type { PinnedAcceptanceArtifacts } from "./artifacts.js";

export function fixtureHash(index: number): `sha256:${string}` {
  return `sha256:${index.toString(16).padStart(64, "0")}`;
}

export function fixtureAttempt(index: number) {
  const memoKey = fixtureHash(index + 1);
  const generationId = `generation:${index + 1}`;
  const memo = structuredClone(memoExample);
  memo.key.memoKey = memoKey;
  memo.key.semanticHash = fixtureHash(index + 10_000);
  memo.value.memoKey = memoKey;
  memo.value.verification.generationId = generationId;
  memo.value.routerAttempts[0]!.generationId = generationId;
  const parsedMemo = PhysicalStepMemoSchema.parse(memo);
  return { stage: "draft" as const, memo: parsedMemo };
}

export function fixtureWireProof(attempt: ReturnType<typeof fixtureAttempt>) {
  const verification = attempt.memo.value.verification;
  if (verification.status !== "verified") throw new Error("fixture memo must be verified");
  const routerAttempt = attempt.memo.value.routerAttempts[0]!;
  if (routerAttempt.provider === null || routerAttempt.generationId === null) {
    throw new Error("fixture router attempt must identify its served route");
  }
  return {
    memoKey: attempt.memo.key.memoKey,
    routerAttemptOrdinal: routerAttempt.ordinal,
    requestHash: fixtureHash(20_000 + routerAttempt.ordinal),
    servedModel: verification.served.model,
    servedProvider: routerAttempt.provider,
    generationId: routerAttempt.generationId,
    policyProofHash: fixtureHash(21_000 + routerAttempt.ordinal),
    zdrRoutingProofHash: fixtureHash(22_000 + routerAttempt.ordinal),
    requestPolicyVerified: true,
    servedPairVerified: true,
    metadataCaptured: true,
    cacheDisabled: true,
    noPlugins: true,
  };
}

export function fixtureAttempts(count: number) {
  const attempts = Array.from({ length: count }, (_, index) => fixtureAttempt(index));
  return { attempts, wireProofs: attempts.map(fixtureWireProof) };
}

export function passingEvidence(pinned: PinnedAcceptanceArtifacts): AcceptanceEvidenceBundle {
  const { definition, labels, corpus } = pinned;
  const { attempts, wireProofs } = fixtureAttempts(1);
  const memoKey = attempts[0]!.memo.key.memoKey;
  const acceptedOutputs = corpus.outputScope.units.map((unit, index) => ({
    schemaVersion: ACCEPTED_OUTPUT_SCHEMA_VERSION,
    outputId: `output:${unit.bridgeUnitId}`,
    version: 1,
    parentOutputIds: [],
    memoKeys: [memoKey],
    evidenceIds: [`evidence:${unit.bridgeUnitId}`],
    acceptedAt: "2026-07-14T12:00:00Z",
    releaseEligibility: {
      kind: "shippable" as const,
      runMode: "production" as const,
      contextScope: "whole-game" as const,
      basis: "wiki-first" as const,
    },
    subjectType: "unit" as const,
    subjectId: unit.bridgeUnitId,
    localizationSnapshotId: "snapshot:localization:qualifying",
    stage: "final" as const,
    sourceHash: unit.sourceHash,
    value: {
      targetSkeleton: `Synthetic target fixture ${index}.`,
      targetHash: fixtureHash(1_000 + index),
      translationObjectId: `translation:${index}`,
      translationObjectVersion: 1,
      parentDraftBatchId: `draft-batch:${index}`,
      basis: { kind: "wiki-first" as const, bibleRenderingIds: [`rendering:${index}`] },
      gateReceipts: [
        {
          gate: "protected-spans" as const,
          evidenceHash: fixtureHash(2_000 + index),
          status: "PASS" as const,
        },
      ],
      reviewVerdictIds: [`review:${index}`],
    },
  }));
  const acceptedOutputHashes = acceptedOutputs.map((output) => sha256Bytes(stableJson(output)));
  const acceptedOutputsHash = sha256Bytes(
    stableJson(
      [...acceptedOutputs].sort((left, right) => left.outputId.localeCompare(right.outputId)),
    ),
  );
  const patchHash = fixtureHash(30_001);
  const replayArtifactHash = fixtureHash(30_002);
  const bibleHeadHash = fixtureHash(34_001);
  const replayState = {
    wikiHash: fixtureHash(30_003),
    bibleHash: bibleHeadHash,
    acceptedOutputsHash,
    patchHash,
    replayArtifactHash,
  };
  const restartProof = (kind: "unit-restart" | "pipeline-restart", index: number) => ({
    kind,
    faultProofHash: fixtureHash(31_000 + index),
    acceptedMemoKeysBefore: [memoKey],
    acceptedMemoKeysAfter: [memoKey],
    acceptedOutputHashesBefore: acceptedOutputHashes,
    acceptedOutputHashesAfter: acceptedOutputHashes,
    redispatchedMemoKeys: [],
    discardedAcceptedOutputHashes: [],
  });

  return AcceptanceEvidenceBundleSchema.parse({
    schemaVersion: ACCEPTANCE_EVIDENCE_BUNDLE_SCHEMA_VERSION,
    runId: "run:qualifying",
    scorecardDefinitionHash: definition.contentAddress.sha256,
    humanCalibrationLabelsHash: labels.contentAddress.sha256,
    corpusManifestHash: corpus.contentAddress.manifestSha256,
    completion: { acceptedOutputs },
    efficiency: { lineage: "cold", attempts },
    zdr: {
      account: { attestationHash: fixtureHash(32_001), verified: true },
      guardrail: { attestationHash: fixtureHash(32_002), verified: true },
      wireProofs,
    },
    sys1: {
      restartProofs: [restartProof("unit-restart", 1), restartProof("pipeline-restart", 2)],
    },
    grounding: {
      strictTerminalSchemas: true,
      noRawJsonSalvage: true,
      citationChecks: acceptedOutputs.map((output, index) => ({
        outputId: output.outputId,
        evidenceId: output.evidenceIds[0]!,
        evidenceHash: fixtureHash(33_000 + index),
        snapshotId: output.localizationSnapshotId,
        exists: true,
        visibleInSnapshot: true,
        scopeMatches: true,
        hashMatches: true,
      })),
    },
    bibleConsistency: {
      receipts: acceptedOutputs.map((output) => ({
        unitId: output.subjectId,
        outputId: output.outputId,
        bibleRenderingIds: output.value.basis.bibleRenderingIds,
        bibleHeadHash,
        consistent: true,
      })),
    },
    patchCoverage: {
      patchHash,
      partial: false,
      receipts: acceptedOutputs.map((output) => ({
        unitId: output.subjectId,
        outputId: output.outputId,
        sourceHash: output.sourceHash,
        targetHash: output.value.targetHash,
        covered: true,
        protectedSpansPassed: true,
        shiftJisPassed: true,
      })),
    },
    translatedByteReplay: {
      patchHash,
      sourceBytesHash: fixtureHash(35_001),
      patchedBytesHash: fixtureHash(35_002),
      replayArtifactHash,
      receipts: acceptedOutputs.map((output) => ({
        unitId: output.subjectId,
        acceptedTargetHash: output.value.targetHash,
        observedTargetHash: output.value.targetHash,
        fromPatchedTargetBytes: true,
        replayPassed: true,
      })),
    },
    zeroCallReplay: {
      replayRunId: "run:zero-call-replay",
      newPhysicalAttempts: 0,
      before: replayState,
      after: replayState,
    },
  });
}
