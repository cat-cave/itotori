import { describe, expect, it } from "vitest";
import {
  HumanCalibrationLabelSchema,
  ReviewVerdictSchema,
  type HumanCalibrationLabel,
  type ReviewVerdict,
} from "../src/contracts/index.js";
import {
  LIVE_REVIEWER_RUN_FOLLOW_UP,
  humanScoresFromLabels,
  measureReviewerCalibration,
  type CalibrationInput,
  type CalibrationLane,
  type FrozenReviewerVerdict,
} from "../src/calibration/index.js";
import {
  PINNED_HUMAN_CALIBRATION_SHA256,
  loadPinnedAcceptanceArtifacts,
} from "./scorecard/artifacts.js";

const PINNED = loadPinnedAcceptanceArtifacts();
const SNAPSHOT_HASH = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const laneRubrics = {
  Q1: "meaning",
  Q2: "voice",
  Q3: "terminology",
  Q4: "continuity",
  Q5: "build-lqa",
} as const;

const labels = [
  ...PINNED.labels.labels,
  buildLqaLabel("high-risk"),
  buildLqaLabel("representative-clean"),
];

function buildLqaLabel(stratum: HumanCalibrationLabel["stratum"]): HumanCalibrationLabel {
  const source = PINNED.labels.labels.find((label) => label.stratum === stratum);
  if (source === undefined) throw new Error(`fixture requires a ${stratum} frozen label`);
  return HumanCalibrationLabelSchema.parse({
    ...source,
    labelId: `calibration:build-lqa:${stratum}`,
    rubric: "build-lqa",
    expected:
      stratum === "high-risk"
        ? { verdict: "FAIL", severity: "major", category: "onscreen-language" }
        : { verdict: "PASS", severity: "none", category: null },
  });
}

function label(rubric: HumanCalibrationLabel["rubric"], stratum: HumanCalibrationLabel["stratum"]) {
  const selected = labels.find(
    (candidate) => candidate.rubric === rubric && candidate.stratum === stratum,
  );
  if (selected === undefined) throw new Error(`fixture requires ${rubric} ${stratum} label`);
  return selected;
}

function verdictFor(
  lane: CalibrationLane,
  labelValue: HumanCalibrationLabel,
  verdict: ReviewVerdict["verdict"],
  reviewId: string,
): ReviewVerdict {
  const base = {
    schemaVersion: "itotori.review-verdict.v1" as const,
    reviewId,
    localizationSnapshotId: SNAPSHOT_HASH,
    roleId: lane,
    rubric: laneRubrics[lane],
    unitId: labelValue.unit.id,
    basis: { kind: "wiki-first" as const, bibleRenderingIds: ["fixture:bible"] },
  };
  if (verdict === "PASS") {
    return ReviewVerdictSchema.parse({
      ...base,
      verdict,
      severity: "none",
      span: null,
      category: null,
      evidenceIds: ["fixture:evidence"],
      repairConstraint: null,
    });
  }
  if (verdict === "FAIL") {
    return ReviewVerdictSchema.parse({
      ...base,
      verdict,
      severity: "major",
      span: { spanId: "fixture:span", surface: "target", text: "Frozen candidate text" },
      category:
        labelValue.expected.verdict === "FAIL" ? labelValue.expected.category : failCategory(lane),
      evidenceIds: ["fixture:evidence"],
      repairConstraint: "Revise the frozen candidate.",
    });
  }
  return ReviewVerdictSchema.parse({
    ...base,
    verdict,
    severity: "none",
    span: null,
    category: "insufficient-evidence",
    evidenceIds: [],
    repairConstraint: null,
    requestedEvidence: ["A wider frozen source window."],
  });
}

function failCategory(lane: CalibrationLane) {
  return {
    Q1: "mistranslation",
    Q2: "character-voice",
    Q3: "term-sense",
    Q4: "callback",
    Q5: "onscreen-language",
  }[lane] as NonNullable<ReviewVerdict["category"]>;
}

function record(
  observationId: string,
  lane: CalibrationLane,
  rubric: HumanCalibrationLabel["rubric"],
  stratum: HumanCalibrationLabel["stratum"],
  verdict: ReviewVerdict["verdict"],
  qaCycle: number,
  reviewerModel = "deepseek-reviewer",
  candidateModel = "deepseek-candidate",
  pair: FrozenReviewerVerdict["pair"] = null,
): FrozenReviewerVerdict {
  const labelValue = label(rubric, stratum);
  return {
    observationId,
    labelId: labelValue.labelId,
    reviewerModel,
    candidateModel,
    verdict: verdictFor(lane, labelValue, verdict, `review:${observationId}`),
    qaCycle,
    pair,
  };
}

function fixtureInput(): CalibrationInput {
  const currentMeaningVoiceScores = [
    ...humanScoresFromLabels(PINNED.labels.labels),
    {
      labelId: "deterministic:render:001",
      rubric: "meaning" as const,
      verdict: "FAIL" as const,
      origin: "deterministic-gate" as const,
    },
  ];
  return {
    labels,
    frozenMissRateThreshold: 0.2,
    acceptedMeaningVoiceBaseline: {
      sourceLabelSetSha256: PINNED_HUMAN_CALIBRATION_SHA256,
      scores: humanScoresFromLabels(PINNED.labels.labels),
    },
    currentMeaningVoiceScores,
    verdicts: [
      record(
        "meaning-ab",
        "Q1",
        "meaning",
        "high-risk",
        "PASS",
        1,
        "deepseek-reviewer",
        "deepseek-candidate",
        {
          comparisonId: "meaning-order-001",
          candidateSlot: "A",
          order: "A/B",
        },
      ),
      record(
        "meaning-ba",
        "Q1",
        "meaning",
        "high-risk",
        "FAIL",
        2,
        "deepseek-reviewer",
        "deepseek-candidate",
        {
          comparisonId: "meaning-order-001",
          candidateSlot: "A",
          order: "B/A",
        },
      ),
      record(
        "meaning-external-one",
        "Q1",
        "meaning",
        "high-risk",
        "FAIL",
        3,
        "deepseek-reviewer",
        "other-candidate",
      ),
      record(
        "meaning-external-two",
        "Q1",
        "meaning",
        "high-risk",
        "FAIL",
        4,
        "deepseek-reviewer",
        "other-candidate",
      ),
      record(
        "meaning-clean",
        "Q1",
        "meaning",
        "representative-clean",
        "FAIL",
        3,
        "deepseek-reviewer",
        "other-candidate",
      ),
      record("voice-risk", "Q2", "voice", "high-risk", "CANNOT_ASSESS", 2),
      record("voice-clean", "Q2", "voice", "representative-clean", "PASS", 1),
      record("term-risk", "Q3", "terminology", "high-risk", "FAIL", 1),
      record("term-clean", "Q3", "terminology", "representative-clean", "PASS", 1),
      record("continuity-risk", "Q4", "continuity", "high-risk", "FAIL", 2),
      record("continuity-clean", "Q4", "continuity", "representative-clean", "PASS", 2),
      record("build-risk", "Q5", "build-lqa", "high-risk", "PASS", 1),
      record("build-clean", "Q5", "build-lqa", "representative-clean", "FAIL", 1),
    ],
  };
}

function bucket(
  report: ReturnType<typeof measureReviewerCalibration>,
  lane: CalibrationLane,
  stratum: HumanCalibrationLabel["stratum"],
) {
  const selected = report.buckets.find(
    (candidate) => candidate.lane === lane && candidate.stratum === stratum,
  );
  if (selected === undefined) throw new Error(`fixture requires ${lane} ${stratum} bucket`);
  return selected;
}

describe("frozen reviewer calibration", () => {
  it("returns the same report when frozen input order changes", () => {
    const input = fixtureInput();

    expect(
      measureReviewerCalibration({
        ...input,
        labels: [...input.labels].reverse(),
        verdicts: [...input.verdicts].reverse(),
      }),
    ).toEqual(measureReviewerCalibration(input));
  });

  it("computes known lane and stratum rates from schema-valid frozen labels and verdicts", () => {
    const report = measureReviewerCalibration(fixtureInput());
    const meaningRisk = bucket(report, "Q1", "high-risk");
    const meaningClean = bucket(report, "Q1", "representative-clean");
    const voiceRisk = bucket(report, "Q2", "high-risk");
    const buildRisk = bucket(report, "Q5", "high-risk");
    const buildClean = bucket(report, "Q5", "representative-clean");

    expect(new Set(report.buckets.map((value) => value.lane))).toEqual(
      new Set(["Q1", "Q2", "Q3", "Q4", "Q5"]),
    );
    expect(meaningRisk).toMatchObject({
      falseNegativeCount: 1,
      falseNegativeRate: 0.25,
      falsePositiveCount: 0,
      cannotAssessCount: 0,
      qaCycles: { total: 10, average: 2.5, maximum: 4 },
    });
    expect(meaningClean).toMatchObject({ falsePositiveCount: 1, falsePositiveRate: 1 });
    expect(voiceRisk).toMatchObject({ cannotAssessCount: 1, cannotAssessRate: 1 });
    expect(buildRisk).toMatchObject({ falseNegativeCount: 1, falseNegativeRate: 1 });
    expect(buildClean).toMatchObject({ falsePositiveCount: 1, falsePositiveRate: 1 });
    expect(report.liveReviewerRun).toBe(LIVE_REVIEWER_RUN_FOLLOW_UP);
  });

  it("widens a stratum audit when its frozen miss threshold is exceeded", () => {
    const report = measureReviewerCalibration(fixtureInput());
    const meaningRisk = bucket(report, "Q1", "high-risk");

    expect(meaningRisk.audit).toEqual({
      missRate: 0.25,
      frozenThreshold: 0.2,
      scope: "same-rubric-all-strata",
      labelIds: ["calibration:meaning:clean:001", "calibration:meaning:risk:001"],
    });
  });

  it("measures an A/B to B/A reversal and positional pass-rate delta", () => {
    const meaningRisk = bucket(measureReviewerCalibration(fixtureInput()), "Q1", "high-risk");

    expect(meaningRisk.positionalBias).toEqual({
      firstPositionPassRate: 1,
      secondPositionPassRate: 0,
      passRateDelta: 1,
      reversals: [
        {
          comparisonId: "meaning-order-001",
          candidateSlot: "A",
          aThenBVerdict: "PASS",
          bThenAVerdict: "FAIL",
          reversed: true,
        },
      ],
    });
    expect(meaningRisk.deepSeekSelfEnhancement).toMatchObject({
      selfObservationCount: 2,
      selfPassRate: 0.5,
      otherObservationCount: 2,
      otherPassRate: 0,
      passRateDelta: 0.5,
    });
    const meaningClean = bucket(
      measureReviewerCalibration(fixtureInput()),
      "Q1",
      "representative-clean",
    );
    expect(meaningClean.deepSeekSelfEnhancement).toMatchObject({
      selfObservationCount: 0,
      otherObservationCount: 1,
      otherPassRate: 0,
      passRateDelta: null,
    });
  });

  it("excludes a deterministic gate fault from meaning and voice quality", () => {
    const report = measureReviewerCalibration(fixtureInput());
    const meaning = report.meaningVoiceQuality.rubrics.find((value) => value.rubric === "meaning");

    expect(meaning).toEqual({
      rubric: "meaning",
      baselinePassRate: 0.5,
      currentPassRate: 0.5,
      excludedDeterministicFaultCount: 1,
      status: "PASS",
    });
    expect(report.meaningVoiceQuality.status).toBe("PASS");
  });

  it("flags a human-scored voice regression against the frozen accepted baseline", () => {
    const input = fixtureInput();
    const currentMeaningVoiceScores = input.currentMeaningVoiceScores.map((score) =>
      score.labelId === "calibration:voice:clean:001" && score.origin === "human"
        ? { ...score, verdict: "FAIL" as const }
        : score,
    );
    const report = measureReviewerCalibration({ ...input, currentMeaningVoiceScores });

    expect(report.meaningVoiceQuality).toMatchObject({ status: "REGRESSION" });
    expect(report.meaningVoiceQuality.rubrics).toContainEqual({
      rubric: "voice",
      baselinePassRate: 0.5,
      currentPassRate: 0,
      excludedDeterministicFaultCount: 0,
      status: "REGRESSION",
    });
  });
});
