import { describe, expect, it } from "vitest";
import {
  AcceptanceScoreResultSchema,
  HumanCalibrationLabelSetSchema,
} from "../../src/contracts/index.js";
import {
  PINNED_CORPUS_MANIFEST_SHA256,
  PINNED_HUMAN_CALIBRATION_SHA256,
  PINNED_SCORECARD_SHA256,
  addressedArtifactHash,
  assertPinnedContentAddress,
  loadPinnedAcceptanceArtifacts,
} from "./artifacts.js";
import { fixtureAttempts, fixtureHash, passingEvidence } from "./fixtures.js";
import { scoreAcceptance } from "./score.js";

const PINNED = loadPinnedAcceptanceArtifacts();

type MutableObject = Record<string | number, unknown>;

function deleteAtPath(value: unknown, path: readonly (string | number)[]): unknown {
  const clone = structuredClone(value) as MutableObject;
  let cursor: unknown = clone;
  for (const part of path.slice(0, -1)) {
    cursor = (cursor as MutableObject)[part];
  }
  delete (cursor as MutableObject)[path.at(-1)!];
  return clone;
}

function dimensionStatus(value: unknown, dimension: string) {
  return scoreAcceptance(value, PINNED).dimensions.find((result) => result.dimension === dimension)
    ?.status;
}

function replaceAttempts(value: ReturnType<typeof passingEvidence>, count: number) {
  const changed = structuredClone(value);
  const { attempts, wireProofs, scorecardAttempts } = fixtureAttempts(count);
  changed.efficiency.attempts = attempts;
  changed.scorecardTelemetry.attempts = scorecardAttempts;
  changed.zdr.wireProofs = wireProofs;
  const memoKeys = attempts.map((attempt) => attempt.memo.key.memoKey);
  for (const proof of changed.sys1.restartProofs) {
    proof.acceptedMemoKeysBefore = memoKeys;
    proof.acceptedMemoKeysAfter = memoKeys;
  }
  return changed;
}

describe("pinned acceptance artifacts", () => {
  it("locks the reviewed scorecard, corpus, and human calibration addresses", () => {
    expect(PINNED.definition.contentAddress.sha256).toBe(PINNED_SCORECARD_SHA256);
    expect(PINNED.labels.contentAddress.sha256).toBe(PINNED_HUMAN_CALIBRATION_SHA256);
    expect(PINNED.corpus.contentAddress.manifestSha256).toBe(PINNED_CORPUS_MANIFEST_SHA256);
    expect(PINNED.definition.dimensions.completion.requiredUnitCount).toBe(129);
    expect(PINNED.definition.dimensions.efficiency).toMatchObject({
      baselinePhysicalAttempts: 762,
      reductionDivisor: 5,
      maximumPhysicalAttempts: 152,
    });
  });

  it("covers every human rubric with high-risk and representative clean labels", () => {
    const expectedRubrics = new Set(["meaning", "voice", "terminology", "continuity"]);
    for (const stratum of ["high-risk", "representative-clean"] as const) {
      expect(
        new Set(
          PINNED.labels.labels
            .filter((label) => label.stratum === stratum)
            .map((label) => label.rubric),
        ),
      ).toEqual(expectedRubrics);
    }
    expect(PINNED.labels.labels.filter((label) => label.expected.verdict === "PASS")).toHaveLength(
      4,
    );
    expect(PINNED.labels.policy.modelTuningAllowed).toBe(false);
  });

  it("rejects stale-address and deliberately readdressed scorecard drift", () => {
    const stale = structuredClone(PINNED.definition);
    stale.dimensions.completion.requiredUnitCount = 128;
    expect(() => assertPinnedContentAddress(stale, PINNED_SCORECARD_SHA256)).toThrow(
      /content hash/u,
    );

    const readdressed = structuredClone(stale);
    readdressed.contentAddress.sha256 = addressedArtifactHash(readdressed);
    expect(() => assertPinnedContentAddress(readdressed, PINNED_SCORECARD_SHA256)).toThrow(
      /reviewed pin/u,
    );

    const staleLabels = structuredClone(PINNED.labels);
    staleLabels.labels[0]!.candidate.hash = fixtureHash(60_000);
    expect(() => assertPinnedContentAddress(staleLabels, PINNED_HUMAN_CALIBRATION_SHA256)).toThrow(
      /content hash/u,
    );

    const readdressedLabels = structuredClone(staleLabels);
    readdressedLabels.contentAddress.sha256 = addressedArtifactHash(readdressedLabels);
    expect(() =>
      assertPinnedContentAddress(readdressedLabels, PINNED_HUMAN_CALIBRATION_SHA256),
    ).toThrow(/reviewed pin/u);
  });

  it("keeps the human label set strict", () => {
    expect(
      HumanCalibrationLabelSetSchema.safeParse({ ...PINNED.labels, unreviewedLabel: true }).success,
    ).toBe(false);
    const missingCandidate = deleteAtPath(PINNED.labels, ["labels", 0, "candidate"]);
    expect(HumanCalibrationLabelSetSchema.safeParse(missingCandidate).success).toBe(false);
  });
});

describe("acceptance scoring", () => {
  it("produces a strict complete PASS from evidence, never a partial result", () => {
    const result = scoreAcceptance(passingEvidence(PINNED), PINNED);
    expect(AcceptanceScoreResultSchema.safeParse(result).success).toBe(true);
    expect(result.status).toBe("PASS");
    expect(result.dimensions).toHaveLength(9);
    expect(result.dimensions.every((dimension) => dimension.status === "PASS")).toBe(true);
    expect(result.dimensions.find((result) => result.dimension === "completion")).toMatchObject({
      writtenUnitCount: 129,
      requiredUnitCount: 129,
    });
    expect(
      AcceptanceScoreResultSchema.safeParse({ ...result, optimisticSummary: true }).success,
    ).toBe(false);
  });

  it("pins the inclusive physical-attempt boundary at 152", () => {
    const evidence = passingEvidence(PINNED);
    expect(dimensionStatus(replaceAttempts(evidence, 152), "cold-lineage-physical-attempts")).toBe(
      "PASS",
    );
    expect(dimensionStatus(replaceAttempts(evidence, 153), "cold-lineage-physical-attempts")).toBe(
      "FAIL",
    );
  });

  it("fails a pipeline restart proof that covers only one accepted output", () => {
    const evidence = passingEvidence(PINNED);
    const pipelineProof = evidence.sys1.restartProofs.find(
      (proof) => proof.kind === "pipeline-restart",
    );
    if (pipelineProof === undefined) throw new Error("fixture requires a pipeline restart proof");
    pipelineProof.acceptedOutputHashesBefore = [pipelineProof.acceptedOutputHashesBefore[0]!];
    pipelineProof.acceptedOutputHashesAfter = [pipelineProof.acceptedOutputHashesAfter[0]!];

    const result = scoreAcceptance(evidence, PINNED);
    expect(
      result.dimensions.find((dimension) => dimension.dimension === "sys1-durability")?.status,
    ).toBe("FAIL");
    expect(result.status).toBe("FAIL");
  });

  it.each([
    [
      "completion",
      (value: ReturnType<typeof passingEvidence>) => value.completion.acceptedOutputs.pop(),
    ],
    [
      "cold-lineage-physical-attempts",
      (value: ReturnType<typeof passingEvidence>) => {
        value.efficiency.lineage = "warm";
      },
    ],
    ["zdr", (value: ReturnType<typeof passingEvidence>) => (value.zdr.account.verified = false)],
    [
      "sys1-durability",
      (value: ReturnType<typeof passingEvidence>) =>
        value.sys1.restartProofs[0]!.discardedAcceptedOutputHashes.push(fixtureHash(60_001)),
    ],
    [
      "strict-grounding",
      (value: ReturnType<typeof passingEvidence>) =>
        (value.grounding.citationChecks[0]!.hashMatches = false),
    ],
    [
      "bible-consistency",
      (value: ReturnType<typeof passingEvidence>) =>
        (value.bibleConsistency.receipts[0]!.consistent = false),
    ],
    [
      "patch-coverage",
      (value: ReturnType<typeof passingEvidence>) =>
        (value.patchCoverage.receipts[0]!.covered = false),
    ],
    [
      "translated-byte-replay",
      (value: ReturnType<typeof passingEvidence>) =>
        (value.translatedByteReplay.receipts[0]!.fromPatchedTargetBytes = false),
    ],
    [
      "zero-call-deterministic-replay",
      (value: ReturnType<typeof passingEvidence>) => (value.zeroCallReplay.newPhysicalAttempts = 1),
    ],
  ])("scores %s as FAIL when its complete evidence disproves acceptance", (dimension, mutate) => {
    const evidence = passingEvidence(PINNED);
    mutate(evidence);
    expect(dimensionStatus(evidence, dimension)).toBe("FAIL");
  });

  it("throws when any whole dimension is absent", () => {
    const evidence = passingEvidence(PINNED);
    const dimensions = [
      "completion",
      "efficiency",
      "scorecardTelemetry",
      "zdr",
      "sys1",
      "grounding",
      "bibleConsistency",
      "patchCoverage",
      "translatedByteReplay",
      "zeroCallReplay",
    ] as const;
    for (const dimension of dimensions) {
      expect(
        () => scoreAcceptance(deleteAtPath(evidence, [dimension]), PINNED),
        dimension,
      ).toThrow();
    }
  });

  it("throws for every missing scorecard-specific evidence field", () => {
    const evidence = passingEvidence(PINNED);
    const paths: Array<Array<string | number>> = [
      ...[
        "schemaVersion",
        "runId",
        "scorecardDefinitionHash",
        "humanCalibrationLabelsHash",
        "corpusManifestHash",
      ].map((key) => [key]),
      ...["acceptedOutputs"].map((key) => ["completion", key]),
      ...["lineage", "attempts"].map((key) => ["efficiency", key]),
      ...["stage", "memo"].map((key) => ["efficiency", "attempts", 0, key]),
      ...["lineage", "attempts"].map((key) => ["scorecardTelemetry", key]),
      ...Object.keys(evidence.scorecardTelemetry.attempts[0]!).map((key) => [
        "scorecardTelemetry",
        "attempts",
        0,
        key,
      ]),
      ...["account", "guardrail", "wireProofs"].map((key) => ["zdr", key]),
      ...["attestationHash", "verified"].map((key) => ["zdr", "account", key]),
      ...Object.keys(evidence.zdr.wireProofs[0]!).map((key) => ["zdr", "wireProofs", 0, key]),
      ["sys1", "restartProofs"],
      ...Object.keys(evidence.sys1.restartProofs[0]!).map((key) => [
        "sys1",
        "restartProofs",
        0,
        key,
      ]),
      ...["strictTerminalSchemas", "noRawJsonSalvage", "citationChecks"].map((key) => [
        "grounding",
        key,
      ]),
      ...Object.keys(evidence.grounding.citationChecks[0]!).map((key) => [
        "grounding",
        "citationChecks",
        0,
        key,
      ]),
      ["bibleConsistency", "receipts"],
      ...Object.keys(evidence.bibleConsistency.receipts[0]!).map((key) => [
        "bibleConsistency",
        "receipts",
        0,
        key,
      ]),
      ...["patchHash", "partial", "receipts"].map((key) => ["patchCoverage", key]),
      ...Object.keys(evidence.patchCoverage.receipts[0]!).map((key) => [
        "patchCoverage",
        "receipts",
        0,
        key,
      ]),
      ...["patchHash", "sourceBytesHash", "patchedBytesHash", "replayArtifactHash", "receipts"].map(
        (key) => ["translatedByteReplay", key],
      ),
      ...Object.keys(evidence.translatedByteReplay.receipts[0]!).map((key) => [
        "translatedByteReplay",
        "receipts",
        0,
        key,
      ]),
      ...["replayRunId", "newPhysicalAttempts", "before", "after"].map((key) => [
        "zeroCallReplay",
        key,
      ]),
      ...Object.keys(evidence.zeroCallReplay.before).map((key) => [
        "zeroCallReplay",
        "before",
        key,
      ]),
    ];
    for (const path of paths) {
      expect(() => scoreAcceptance(deleteAtPath(evidence, path), PINNED), path.join(".")).toThrow();
    }
  });

  it("throws on extra evidence and mismatched contract pins", () => {
    const evidence = passingEvidence(PINNED);
    expect(() => scoreAcceptance({ ...evidence, partialScoreAllowed: true }, PINNED)).toThrow();
    expect(() =>
      scoreAcceptance({ ...evidence, scorecardDefinitionHash: fixtureHash(61_001) }, PINNED),
    ).toThrow(/different scoring contract/u);
  });
});
