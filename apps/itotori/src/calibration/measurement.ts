import {
  HumanCalibrationLabelSchema,
  ReviewVerdictSchema,
  type HumanCalibrationLabel,
  type ReviewVerdict,
} from "../contracts/index.js";

const CALIBRATION_LANES = ["Q1", "Q2", "Q3", "Q4", "Q5"] as const;
const LANE_RUBRICS = {
  Q1: "meaning",
  Q2: "voice",
  Q3: "terminology",
  Q4: "continuity",
  Q5: "build-lqa",
} as const;

type CandidateOrder = "A/B" | "B/A";
type CandidateSlot = "A" | "B";
type QualityRubric = "meaning" | "voice";
type VerdictKind = ReviewVerdict["verdict"];

export type CalibrationLane = (typeof CALIBRATION_LANES)[number];

export type FrozenReviewerVerdict = {
  readonly observationId: string;
  /** Binds this verdict to the frozen unit and candidate hash in the human label. */
  readonly labelId: string;
  readonly reviewerModel: string;
  readonly candidateModel: string;
  readonly verdict: ReviewVerdict;
  readonly qaCycle: number;
  readonly pair: {
    readonly comparisonId: string;
    readonly candidateSlot: CandidateSlot;
    readonly order: CandidateOrder;
  } | null;
};

export type HumanQualityScore = {
  readonly labelId: string;
  readonly rubric: QualityRubric;
  readonly verdict: "PASS" | "FAIL";
  /** Build and deterministic-gate defects never contribute to human language quality. */
  readonly origin: "human" | "deterministic-gate";
};

export type FrozenHumanQualityBaseline = {
  readonly sourceLabelSetSha256: string;
  readonly scores: readonly HumanQualityScore[];
};

export type CalibrationInput = {
  readonly labels: readonly HumanCalibrationLabel[];
  readonly verdicts: readonly FrozenReviewerVerdict[];
  readonly frozenMissRateThreshold: number;
  readonly acceptedMeaningVoiceBaseline: FrozenHumanQualityBaseline;
  readonly currentMeaningVoiceScores: readonly HumanQualityScore[];
};

type Rate = number | null;
type AuditScope = "stratum" | "same-rubric-all-strata";

export type CalibrationBucket = {
  readonly lane: CalibrationLane;
  readonly rubric: HumanCalibrationLabel["rubric"];
  readonly stratum: HumanCalibrationLabel["stratum"];
  readonly observationCount: number;
  readonly falseNegativeCount: number;
  readonly falseNegativeRate: Rate;
  readonly falsePositiveCount: number;
  readonly falsePositiveRate: Rate;
  readonly cannotAssessCount: number;
  readonly cannotAssessRate: number;
  readonly qaCycles: { readonly total: number; readonly average: number; readonly maximum: number };
  readonly audit: {
    readonly missRate: Rate;
    readonly frozenThreshold: number;
    readonly scope: AuditScope;
    readonly labelIds: readonly string[];
  };
  readonly positionalBias: {
    readonly firstPositionPassRate: Rate;
    readonly secondPositionPassRate: Rate;
    readonly passRateDelta: Rate;
    readonly reversals: readonly {
      readonly comparisonId: string;
      readonly candidateSlot: CandidateSlot;
      readonly aThenBVerdict: VerdictKind;
      readonly bThenAVerdict: VerdictKind;
      readonly reversed: boolean;
    }[];
  };
  readonly deepSeekSelfEnhancement: {
    readonly selfObservationCount: number;
    readonly otherObservationCount: number;
    readonly selfPassRate: Rate;
    readonly otherPassRate: Rate;
    readonly passRateDelta: Rate;
  };
};

export type MeaningVoiceQualityReport = {
  readonly status: "PASS" | "REGRESSION";
  readonly rubrics: readonly {
    readonly rubric: QualityRubric;
    readonly baselinePassRate: number;
    readonly currentPassRate: number;
    readonly excludedDeterministicFaultCount: number;
    readonly status: "PASS" | "REGRESSION";
  }[];
};

export type CalibrationReport = {
  readonly buckets: readonly CalibrationBucket[];
  readonly meaningVoiceQuality: MeaningVoiceQualityReport;
  /** The report measures supplied frozen verdicts; it never invokes a reviewer. */
  readonly liveReviewerRun: typeof LIVE_REVIEWER_RUN_FOLLOW_UP;
};

/** Reviewer dispatch belongs to the live lane after frozen-fixture calibration passes. */
export const LIVE_REVIEWER_RUN_FOLLOW_UP = "downstream-live-lane" as const;

/** Projects the frozen human labels into the meaning/voice quality comparison input. */
export function humanScoresFromLabels(
  labels: readonly HumanCalibrationLabel[],
): readonly HumanQualityScore[] {
  return labels
    .filter(
      (label): label is HumanCalibrationLabel & { rubric: QualityRubric } =>
        label.rubric === "meaning" || label.rubric === "voice",
    )
    .map((label) => ({
      labelId: label.labelId,
      rubric: label.rubric,
      verdict: label.expected.verdict,
      origin: "human" as const,
    }))
    .sort(compareByLabel);
}

/**
 * Compares human-scored meaning and voice quality with the accepted frozen
 * baseline. Deterministic build defects are reported but excluded from both
 * quality numerators and denominators.
 */
export function compareMeaningVoiceQuality(
  baseline: FrozenHumanQualityBaseline,
  currentScores: readonly HumanQualityScore[],
): MeaningVoiceQualityReport {
  const rubrics = (["meaning", "voice"] as const).map((rubric) => {
    const baselineRate = humanPassRate(baseline.scores, rubric, "baseline");
    const currentRate = humanPassRate(currentScores, rubric, "current");
    const excludedDeterministicFaultCount = currentScores.filter(
      (score) => score.rubric === rubric && score.origin === "deterministic-gate",
    ).length;
    const status: "PASS" | "REGRESSION" = currentRate < baselineRate ? "REGRESSION" : "PASS";
    return {
      rubric,
      baselinePassRate: baselineRate,
      currentPassRate: currentRate,
      excludedDeterministicFaultCount,
      status,
    };
  });
  return {
    status: rubrics.some((rubric) => rubric.status === "REGRESSION") ? "REGRESSION" : "PASS",
    rubrics,
  };
}

/**
 * Measures frozen reviewer verdicts against frozen human labels. This pure
 * function intentionally accepts verdict records rather than dispatching a
 * model, keeping the calibration calculation deterministic and offline.
 */
export function measureReviewerCalibration(input: CalibrationInput): CalibrationReport {
  assertThreshold(input.frozenMissRateThreshold);
  const labels = labelsById(input.labels);
  const grouped = new Map<
    string,
    Array<{ label: HumanCalibrationLabel; record: FrozenReviewerVerdict }>
  >();

  for (const record of input.verdicts) {
    const label = labels.get(record.labelId);
    if (label === undefined)
      throw new Error(`calibration verdict references unknown label ${record.labelId}`);
    validateRecord(label, record);
    const lane = record.verdict.roleId as CalibrationLane;
    const key = bucketKey(lane, label.rubric, label.stratum);
    const entries = grouped.get(key) ?? [];
    entries.push({ label, record });
    grouped.set(key, entries);
  }

  const buckets = [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, entries]) => measureBucket(entries, input.labels, input.frozenMissRateThreshold));
  return {
    buckets,
    meaningVoiceQuality: compareMeaningVoiceQuality(
      input.acceptedMeaningVoiceBaseline,
      input.currentMeaningVoiceScores,
    ),
    liveReviewerRun: LIVE_REVIEWER_RUN_FOLLOW_UP,
  };
}

function measureBucket(
  entries: readonly { label: HumanCalibrationLabel; record: FrozenReviewerVerdict }[],
  allLabels: readonly HumanCalibrationLabel[],
  frozenThreshold: number,
): CalibrationBucket {
  const first = entries[0];
  if (first === undefined) throw new Error("calibration bucket cannot be empty");
  const lane = first.record.verdict.roleId as CalibrationLane;
  const { rubric, stratum } = first.label;
  const falseNegativeCount = entries.filter(isFalseNegative).length;
  const falsePositiveCount = entries.filter(isFalsePositive).length;
  const expectedFailureCount = entries.filter(
    ({ label }) => label.expected.verdict === "FAIL",
  ).length;
  const expectedPassCount = entries.filter(({ label }) => label.expected.verdict === "PASS").length;
  const cannotAssessCount = entries.filter(
    ({ record }) => record.verdict.verdict === "CANNOT_ASSESS",
  ).length;
  const missRate = rate(falseNegativeCount, expectedFailureCount);
  const widened = missRate !== null && missRate > frozenThreshold;
  const auditLabels = widened
    ? allLabels.filter((label) => label.rubric === rubric)
    : allLabels.filter((label) => label.rubric === rubric && label.stratum === stratum);
  const qaCycleTotal = entries.reduce((total, { record }) => total + record.qaCycle, 0);

  return {
    lane,
    rubric,
    stratum,
    observationCount: entries.length,
    falseNegativeCount,
    falseNegativeRate: rate(falseNegativeCount, expectedFailureCount),
    falsePositiveCount,
    falsePositiveRate: rate(falsePositiveCount, expectedPassCount),
    cannotAssessCount,
    cannotAssessRate: cannotAssessCount / entries.length,
    qaCycles: {
      total: qaCycleTotal,
      average: qaCycleTotal / entries.length,
      maximum: Math.max(...entries.map(({ record }) => record.qaCycle)),
    },
    audit: {
      missRate,
      frozenThreshold,
      scope: widened ? "same-rubric-all-strata" : "stratum",
      labelIds: auditLabels.map((label) => label.labelId).sort(),
    },
    positionalBias: positionalBias(entries),
    deepSeekSelfEnhancement: deepSeekSelfEnhancement(entries),
  };
}

function positionalBias(
  entries: readonly { label: HumanCalibrationLabel; record: FrozenReviewerVerdict }[],
): CalibrationBucket["positionalBias"] {
  const positioned = entries.filter(
    (
      entry,
    ): entry is {
      label: HumanCalibrationLabel;
      record: FrozenReviewerVerdict & { pair: NonNullable<FrozenReviewerVerdict["pair"]> };
    } => entry.record.pair !== null,
  );
  const pairs = new Map<string, typeof positioned>();
  for (const entry of positioned) {
    const pair = entry.record.pair;
    const key = `${pair.comparisonId}\u0000${pair.candidateSlot}`;
    const members = pairs.get(key) ?? [];
    members.push(entry);
    pairs.set(key, members);
  }

  const reversals = [...pairs.values()]
    .map((members) => reversalForPair(members))
    .sort((left, right) => {
      const comparison = left.comparisonId.localeCompare(right.comparisonId);
      return comparison === 0 ? left.candidateSlot.localeCompare(right.candidateSlot) : comparison;
    });
  const firstPosition = positioned.filter(({ record }) => positionOf(record.pair) === "first");
  const secondPosition = positioned.filter(({ record }) => positionOf(record.pair) === "second");
  const firstPositionPassRate = passRate(firstPosition);
  const secondPositionPassRate = passRate(secondPosition);
  return {
    firstPositionPassRate,
    secondPositionPassRate,
    passRateDelta:
      firstPositionPassRate === null || secondPositionPassRate === null
        ? null
        : firstPositionPassRate - secondPositionPassRate,
    reversals,
  };
}

function reversalForPair(
  members: readonly {
    label: HumanCalibrationLabel;
    record: FrozenReviewerVerdict & { pair: NonNullable<FrozenReviewerVerdict["pair"]> };
  }[],
): CalibrationBucket["positionalBias"]["reversals"][number] {
  const aThenB = members.filter(({ record }) => record.pair.order === "A/B");
  const bThenA = members.filter(({ record }) => record.pair.order === "B/A");
  if (aThenB.length !== 1 || bThenA.length !== 1) {
    throw new Error("every recorded positional comparison requires one A/B and one B/A verdict");
  }
  const aThenBRecord = aThenB[0]!.record;
  const bThenARecord = bThenA[0]!.record;
  if (
    aThenBRecord.pair.comparisonId !== bThenARecord.pair.comparisonId ||
    aThenBRecord.pair.candidateSlot !== bThenARecord.pair.candidateSlot
  ) {
    throw new Error("positional comparison members must identify the same candidate");
  }
  return {
    comparisonId: aThenBRecord.pair.comparisonId,
    candidateSlot: aThenBRecord.pair.candidateSlot,
    aThenBVerdict: aThenBRecord.verdict.verdict,
    bThenAVerdict: bThenARecord.verdict.verdict,
    reversed: aThenBRecord.verdict.verdict !== bThenARecord.verdict.verdict,
  };
}

function deepSeekSelfEnhancement(
  entries: readonly { label: HumanCalibrationLabel; record: FrozenReviewerVerdict }[],
): CalibrationBucket["deepSeekSelfEnhancement"] {
  const deepSeekReviewer = entries.filter(({ record }) => isDeepSeek(record.reviewerModel));
  const self = deepSeekReviewer.filter(({ record }) => isDeepSeek(record.candidateModel));
  const other = deepSeekReviewer.filter(({ record }) => !isDeepSeek(record.candidateModel));
  const selfPassRate = passRate(self);
  const otherPassRate = passRate(other);
  return {
    selfObservationCount: self.length,
    otherObservationCount: other.length,
    selfPassRate,
    otherPassRate,
    passRateDelta:
      selfPassRate === null || otherPassRate === null ? null : selfPassRate - otherPassRate,
  };
}

function labelsById(
  labels: readonly HumanCalibrationLabel[],
): ReadonlyMap<string, HumanCalibrationLabel> {
  const byId = new Map<string, HumanCalibrationLabel>();
  for (const rawLabel of labels) {
    const label = HumanCalibrationLabelSchema.parse(rawLabel);
    if (byId.has(label.labelId))
      throw new Error(`duplicate frozen calibration label ${label.labelId}`);
    byId.set(label.labelId, label);
  }
  return byId;
}

function validateRecord(label: HumanCalibrationLabel, record: FrozenReviewerVerdict): void {
  if (
    record.observationId.length === 0 ||
    record.reviewerModel.length === 0 ||
    record.candidateModel.length === 0
  ) {
    throw new Error("calibration records require stable observation and model identities");
  }
  if (!Number.isInteger(record.qaCycle) || record.qaCycle < 1) {
    throw new Error("calibration qaCycle must be a positive integer");
  }
  const verdict = ReviewVerdictSchema.parse(record.verdict);
  if (!CALIBRATION_LANES.includes(verdict.roleId as CalibrationLane)) {
    throw new Error("calibration accepts reviewer lanes Q1 through Q5 only");
  }
  if (label.unit.id !== verdict.unitId) {
    throw new Error("calibration verdict does not match the frozen label unit");
  }
  if (
    LANE_RUBRICS[verdict.roleId as CalibrationLane] !== label.rubric ||
    verdict.rubric !== label.rubric
  ) {
    throw new Error("calibration verdict lane and frozen human rubric must agree");
  }
}

function humanPassRate(
  scores: readonly HumanQualityScore[],
  rubric: QualityRubric,
  source: "baseline" | "current",
): number {
  const humanScores = scores.filter((score) => score.rubric === rubric && score.origin === "human");
  if (humanScores.length === 0)
    throw new Error(`${source} human quality requires ${rubric} scores`);
  return humanScores.filter((score) => score.verdict === "PASS").length / humanScores.length;
}

function isFalseNegative(entry: {
  label: HumanCalibrationLabel;
  record: FrozenReviewerVerdict;
}): boolean {
  return entry.label.expected.verdict === "FAIL" && entry.record.verdict.verdict === "PASS";
}

function isFalsePositive(entry: {
  label: HumanCalibrationLabel;
  record: FrozenReviewerVerdict;
}): boolean {
  return entry.label.expected.verdict === "PASS" && entry.record.verdict.verdict === "FAIL";
}

function bucketKey(
  lane: CalibrationLane,
  rubric: HumanCalibrationLabel["rubric"],
  stratum: HumanCalibrationLabel["stratum"],
): string {
  return `${lane}\u0000${rubric}\u0000${stratum}`;
}

function compareByLabel(left: HumanQualityScore, right: HumanQualityScore): number {
  return left.labelId.localeCompare(right.labelId);
}

function positionOf(pair: NonNullable<FrozenReviewerVerdict["pair"]>): "first" | "second" {
  return (pair.order === "A/B") === (pair.candidateSlot === "A") ? "first" : "second";
}

function passRate(
  entries: readonly { label: HumanCalibrationLabel; record: FrozenReviewerVerdict }[],
): Rate {
  return rate(
    entries.filter(({ record }) => record.verdict.verdict === "PASS").length,
    entries.length,
  );
}

function rate(numerator: number, denominator: number): Rate {
  return denominator === 0 ? null : numerator / denominator;
}

function isDeepSeek(model: string): boolean {
  return model.toLocaleLowerCase("en-US").includes("deepseek");
}

function assertThreshold(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("frozen miss-rate threshold must be between zero and one");
  }
}
