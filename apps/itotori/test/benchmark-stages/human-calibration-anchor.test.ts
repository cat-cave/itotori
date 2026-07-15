// benchmark-human-calibration-anchors — §8 tests (SYNTHETIC ratings, NO LLM).
//
// Proves: (a) the blind human-rating CAPTURE mechanism — bundles carry blind
// handles + text ONLY (no system identity), and rating records are validated
// rubric-aligned + blind; (b) the LOCKED external anchor — validated, frozen,
// policy-stamped, de-anonymized only on the panel side; (c) the CALIBRATION
// report — a panel that MATCHES humans → high agreement + ~0 divergence + high
// correlation, a systematically-BIASED panel → the divergence is SURFACED
// (signed gap + flagged dimension + direction). Deterministic synthetic fixtures.

import { describe, expect, it } from "vitest";
import {
  BENCHMARK_RUBRIC_DIMENSION_IDS,
  type BenchmarkRubricScore,
} from "@itotori/localization-bridge-schema";
import {
  FixtureJudge,
  HumanCalibrationAnchorError,
  HUMAN_CALIBRATION_ANCHOR_POLICY,
  assertHumanRatingRecord,
  assertHumanRatingRecordIsBlind,
  buildDecodedContextFeed,
  buildHumanRatingBundles,
  buildPanelHumanCalibrationReport,
  deanonymizeHumanRatings,
  lockHumanRatingAnchor,
  runBlindJudgePanel,
  type ContestantCandidate,
  type DecodedContextFeedInput,
  type FixtureJudgeScoreFn,
  type HumanRatingBlinding,
  type HumanRatingRecord,
  type JudgeCitation,
} from "../../src/benchmark-stages/index.js";
import type { NarrativeStructure } from "../../src/structure/index.js";

// ── synthetic decode + provenance-laden contestants (mirrors the panel test) ──
const U1 = "019ed010-0000-7000-8000-0000000000c1";
const U2 = "019ed010-0000-7000-8000-0000000000c2";

const OFFICIAL = "official-en";
const ITOTORI_ON = "itotori-context-on";
const RAW_MTL = "raw-mtl-baseline";
const ALL_CONTESTANTS = [OFFICIAL, ITOTORI_ON, RAW_MTL];

// The "ground truth" per-contestant quality all fixtures agree on (has VARIANCE
// across contestants so correlation is well-defined).
const CONTESTANT_TRUTH: Record<string, BenchmarkRubricScore> = {
  [OFFICIAL]: 4,
  [ITOTORI_ON]: 3,
  [RAW_MTL]: 1,
};

const TEXTS: Record<string, Record<string, string>> = {
  [U1]: {
    [OFFICIAL]: "Morning, Rin.",
    [ITOTORI_ON]: "Mornin', Rin.",
    [RAW_MTL]: "Good morning, Rin.",
  },
  [U2]: {
    [OFFICIAL]: "Yeah, morning.",
    [ITOTORI_ON]: "Mm, mornin'.",
    [RAW_MTL]: "Yes, good morning.",
  },
};
// text → contestant (so a text-keyed judge maps back to the ground-truth score).
const CONTESTANT_FOR_TEXT: Record<string, string> = {};
for (const unitId of [U1, U2]) {
  for (const contestantId of ALL_CONTESTANTS) {
    CONTESTANT_FOR_TEXT[TEXTS[unitId]![contestantId]!] = contestantId;
  }
}

function syntheticStructure(): NarrativeStructure {
  return {
    schemaVersion: "utsushi.narrative-structure.v1",
    entryScene: 2031,
    sceneDispatchOrder: [2031, 2040],
    scenes: [
      {
        sceneId: 2031,
        selectionControl: "text-window",
        nextScene: 2040,
        messages: [
          { order: 0, speaker: "和人", text: "おはよう、りん。", textSurface: null },
          { order: 1, speaker: "りん", text: "うん、おはよう。", textSurface: null },
        ],
        choices: [],
      },
      {
        sceneId: 2040,
        selectionControl: "none",
        nextScene: null,
        messages: [{ order: 0, speaker: "りん", text: "着いたよ。", textSurface: null }],
        choices: [],
      },
    ],
  };
}

function candidates(): ContestantCandidate[] {
  const out: ContestantCandidate[] = [];
  for (const unitId of [U1, U2]) {
    for (const contestantId of ALL_CONTESTANTS) {
      out.push({ contestantId, unitId, candidateText: TEXTS[unitId]![contestantId]! });
    }
  }
  return out;
}

function feedInput(): DecodedContextFeedInput {
  return {
    structure: syntheticStructure(),
    unitRefs: [
      { unitId: U1, sceneId: 2031, messageOrder: 0 },
      { unitId: U2, sceneId: 2031, messageOrder: 1 },
    ],
    candidates: candidates(),
  };
}

function citationFor(candidateText: string, dimensionId: string): JudgeCitation {
  return {
    sourceSpan: "おはよう",
    decodedContextUsed: "speaker 和人, scene 2031",
    rationale: `${dimensionId}: '${candidateText}' judged in context`,
  };
}

// A judge that scores each candidate by a per-contestant score table (resolved
// from the candidate TEXT, stable regardless of blind order).
function judgeFromContestantScores(
  scoreFor: (contestantId: string) => BenchmarkRubricScore,
): FixtureJudgeScoreFn {
  return ({ candidate, dimensionId }) => {
    const contestantId = CONTESTANT_FOR_TEXT[candidate.candidateText]!;
    const score = scoreFor(contestantId);
    return {
      score,
      citation: score < 4 ? citationFor(candidate.candidateText, dimensionId) : null,
    };
  };
}

function panelFrom(scoreFor: (contestantId: string) => BenchmarkRubricScore): FixtureJudge[] {
  const fn = judgeFromContestantScores(scoreFor);
  return [
    new FixtureJudge({
      judgeId: "judge-deepseek",
      modelFamily: "deepseek",
      modelId: "deepseek/x",
      providerId: "deepseek-p",
      scoreFn: fn,
    }),
    new FixtureJudge({
      judgeId: "judge-qwen",
      modelFamily: "qwen",
      modelId: "qwen/x",
      providerId: "qwen-p",
      scoreFn: fn,
    }),
  ];
}

// Author SYNTHETIC human rating records through the blind handles: for each
// (rater, unit) the human "saw" blind labels; we emit a record per candidate
// with per-dimension scores decided by the (panel-side-known) contestant. This
// simulates a human rating the blind bundle.
function authorHumanRecords(
  blindings: readonly HumanRatingBlinding[],
  scoreFor: (contestantId: string) => BenchmarkRubricScore,
): HumanRatingRecord[] {
  const out: HumanRatingRecord[] = [];
  for (const blinding of blindings) {
    for (const [blindLabel, contestantId] of blinding.deanonymize) {
      out.push({
        raterId: blinding.raterId,
        unitId: blinding.unitId,
        blindLabel,
        dimensions: BENCHMARK_RUBRIC_DIMENSION_IDS.map((dimensionId) => ({
          dimensionId,
          score: scoreFor(contestantId),
        })),
      });
    }
  }
  return out;
}

const RATERS = ["rater-trevor", "rater-b"];

async function calibrate(args: {
  panelScoreFor: (contestantId: string) => BenchmarkRubricScore;
  humanScoreFor: (contestantId: string) => BenchmarkRubricScore;
}) {
  const feed = buildDecodedContextFeed(feedInput());
  const panel = await runBlindJudgePanel({
    feed,
    judges: panelFrom(args.panelScoreFor),
    panelSeed: "panel-seed",
  });
  const { blindings } = buildHumanRatingBundles({
    feed,
    raterIds: RATERS,
    panelSeed: "human-seed",
  });
  const anchor = lockHumanRatingAnchor(authorHumanRecords(blindings, args.humanScoreFor), {
    realContestantIds: ALL_CONTESTANTS,
  });
  const humanScores = deanonymizeHumanRatings(anchor, blindings);
  const report = buildPanelHumanCalibrationReport({
    panelScores: panel.contestantDimensionScores,
    humanScores,
  });
  return { panel, blindings, anchor, humanScores, report };
}

// ── 1. Blind capture mechanism ────────────────────────────────────────────────
describe("§8 blind human-rating capture", () => {
  it("presents blind handles + text ONLY (no system identity), per-rater order", () => {
    const feed = buildDecodedContextFeed(feedInput());
    const { bundles, blindings } = buildHumanRatingBundles({
      feed,
      raterIds: RATERS,
      panelSeed: "human-seed",
    });
    // 2 raters × 2 units.
    expect(bundles.length).toBe(4);
    for (const bundle of bundles) {
      const serialized = JSON.stringify({
        decodedContext: bundle.decodedContext,
        candidates: bundle.candidates,
      });
      for (const contestantId of ALL_CONTESTANTS) {
        expect(serialized).not.toContain(contestantId);
      }
      for (const candidate of bundle.candidates) {
        expect(candidate.blindLabel).toMatch(/^candidate-[a-z]+$/);
      }
    }
    // Each blinding is a complete map over the real contestants.
    for (const blinding of blindings) {
      expect(new Set(blinding.deanonymize.values())).toEqual(new Set(ALL_CONTESTANTS));
    }
    // Different raters see different orders for the same unit (position guard).
    const u1 = blindings.filter((b) => b.unitId === U1);
    const differs = ["candidate-a", "candidate-b", "candidate-c"].some(
      (label) => u1[0]!.deanonymize.get(label) !== u1[1]!.deanonymize.get(label),
    );
    expect(differs).toBe(true);
  });

  it("validates a rating record against the rubric + rejects bad records", () => {
    const good: HumanRatingRecord = {
      raterId: "rater-trevor",
      unitId: U1,
      blindLabel: "candidate-a",
      dimensions: [{ dimensionId: "adequacy", score: 3, notes: "slightly stiff" }],
    };
    expect(() => assertHumanRatingRecord(good)).not.toThrow();

    // Out-of-range score.
    expect(() =>
      assertHumanRatingRecord({
        ...good,
        dimensions: [{ dimensionId: "adequacy", score: 7 as BenchmarkRubricScore }],
      }),
    ).toThrow(HumanCalibrationAnchorError);
    // Unknown dimension.
    expect(() =>
      assertHumanRatingRecord({
        ...good,
        dimensions: [{ dimensionId: "made_up_dim" as never, score: 3 }],
      }),
    ).toThrow(HumanCalibrationAnchorError);
    // Non-blind handle (a raw system identity).
    expect(() => assertHumanRatingRecord({ ...good, blindLabel: ITOTORI_ON })).toThrow(
      HumanCalibrationAnchorError,
    );
    // Duplicate dimension.
    expect(() =>
      assertHumanRatingRecord({
        ...good,
        dimensions: [
          { dimensionId: "adequacy", score: 3 },
          { dimensionId: "adequacy", score: 2 },
        ],
      }),
    ).toThrow(HumanCalibrationAnchorError);
  });

  it("guards blindness — throws when a note leaks a system identity", () => {
    const leaky: HumanRatingRecord = {
      raterId: "rater-trevor",
      unitId: U1,
      blindLabel: "candidate-a",
      dimensions: [{ dimensionId: "adequacy", score: 3, notes: `looks like ${OFFICIAL}` }],
    };
    expect(() => assertHumanRatingRecordIsBlind(leaky, ALL_CONTESTANTS)).toThrow(
      HumanCalibrationAnchorError,
    );
    const clean: HumanRatingRecord = {
      ...leaky,
      dimensions: [{ dimensionId: "adequacy", score: 3, notes: "reads well" }],
    };
    expect(() => assertHumanRatingRecordIsBlind(clean, ALL_CONTESTANTS)).not.toThrow();
  });
});

// ── 2. Locked external anchor ─────────────────────────────────────────────────
describe("§8 locked external anchor", () => {
  it("is policy-stamped as calibrate-panel-only and NOT an Itotori tuning input", () => {
    expect(HUMAN_CALIBRATION_ANCHOR_POLICY.usedForItotoriTuning).toBe(false);
    expect(HUMAN_CALIBRATION_ANCHOR_POLICY.usage).toBe("calibrate_or_validate_panel_only");
  });

  it("locks + deep-freezes the records; de-anonymizes only on the panel side", async () => {
    const feed = buildDecodedContextFeed(feedInput());
    const { blindings } = buildHumanRatingBundles({
      feed,
      raterIds: RATERS,
      panelSeed: "human-seed",
    });
    const anchor = lockHumanRatingAnchor(
      authorHumanRecords(blindings, (c) => CONTESTANT_TRUTH[c]!),
      { realContestantIds: ALL_CONTESTANTS },
    );
    expect(anchor.locked).toBe(true);
    expect(Object.isFrozen(anchor)).toBe(true);
    expect(Object.isFrozen(anchor.records)).toBe(true);
    expect(Object.isFrozen(anchor.records[0])).toBe(true);

    const humanScores = deanonymizeHumanRatings(anchor, blindings);
    // Every de-anonymized score resolves to a real contestant + rubric dimension.
    for (const s of humanScores) {
      expect(ALL_CONTESTANTS).toContain(s.contestantId);
      expect(s.score).toBe(CONTESTANT_TRUTH[s.contestantId]);
    }
    // De-anonymization needs the panel-held maps — a missing blinding is refused.
    expect(() => deanonymizeHumanRatings(anchor, [])).toThrow(HumanCalibrationAnchorError);
  });

  it("refuses to lock an empty anchor", () => {
    expect(() => lockHumanRatingAnchor([])).toThrow(HumanCalibrationAnchorError);
  });
});

// ── 3. Calibration report ─────────────────────────────────────────────────────
describe("§8 calibration report — panel vs human anchor", () => {
  it("MATCHING panel → high agreement, ~0 divergence, high correlation", async () => {
    const { report } = await calibrate({
      panelScoreFor: (c) => CONTESTANT_TRUTH[c]!,
      humanScoreFor: (c) => CONTESTANT_TRUTH[c]!,
    });
    expect(report.anchorPolicy.usedForItotoriTuning).toBe(false);
    expect(report.raters).toEqual([...RATERS].sort());
    expect(report.byDimension.length).toBe(BENCHMARK_RUBRIC_DIMENSION_IDS.length);
    for (const dim of report.byDimension) {
      expect(dim.normalizedAgreement).toBe(1);
      expect(dim.signedMeanDiff).toBe(0);
      expect(dim.divergence).toBe("aligned");
      expect(dim.pearson).toBe(1); // variance across contestants → correlation defined
    }
    expect(report.divergentDimensions).toEqual([]);
    expect(report.overall.normalizedAgreement).toBe(1);
    expect(report.overall.signedMeanDiff).toBe(0);
    expect(report.overall.pearson).toBe(1);
  });

  it("BIASED (lenient) panel → divergence SURFACED as panel over-scoring", async () => {
    // Panel scores EVERYTHING 4; humans keep the ground truth (4/3/1).
    const { report } = await calibrate({
      panelScoreFor: () => 4 as BenchmarkRubricScore,
      humanScoreFor: (c) => CONTESTANT_TRUTH[c]!,
    });
    // Every dimension is over-scored by the panel.
    expect(report.divergentDimensions.length).toBe(BENCHMARK_RUBRIC_DIMENSION_IDS.length);
    for (const dim of report.byDimension) {
      expect(dim.signedMeanDiff).toBeGreaterThan(0);
      expect(dim.divergence).toBe("panel_over_scores");
      // agreement is strictly worse than the matching case (which was 1).
      expect(dim.normalizedAgreement).toBeLessThan(1);
    }
    expect(report.overall.signedMeanDiff!).toBeGreaterThan(0);
    expect(report.overall.normalizedAgreement!).toBeLessThan(1);
  });

  it("BIASED (harsh) panel → divergence SURFACED as panel under-scoring", async () => {
    const { report } = await calibrate({
      panelScoreFor: () => 0 as BenchmarkRubricScore,
      humanScoreFor: (c) => CONTESTANT_TRUTH[c]!,
    });
    for (const dim of report.byDimension) {
      expect(dim.signedMeanDiff).toBeLessThan(0);
      expect(dim.divergence).toBe("panel_under_scores");
    }
    expect(report.overall.signedMeanDiff!).toBeLessThan(0);
  });
});
