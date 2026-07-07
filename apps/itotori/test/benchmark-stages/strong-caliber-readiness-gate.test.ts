// itotori-strong-caliber-readiness-gate — the CONTINUE-vs-STRONG-CALIBER-DONE
// verdict tests (deterministic, NO LLM).
//
// Proves the gate folds benchmark + regression + QA + human-anchor signals into
// ONE actionable confidence call, evidence-backed:
//   1. DONE when every signal crosses its threshold (self >= human anchor,
//      regressions clean, QA F1 met, quorum met).
//   2. CONTINUE when the self-score is below the human anchor.
//   3. CONTINUE when a regression is present EVEN THOUGH the score is high
//      (the regression veto holds against a flattering score).
//   4. CONTINUE when QA F1 is below floor; CONTINUE when the human-anchor
//      quorum is unmet; the verdict carries its full evidence + findings.
//
// The fixtures are pure data shapes (no LLM, no provider) — the gate is a pure
// function over already-computed signals, exactly as in production.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_STRONG_CALIBER_THRESHOLDS,
  STRONG_CALIBER_READINESS_SCHEMA_VERSION,
  StrongCaliberReadinessGateError,
  decideStrongCaliberReadiness,
  type BacklogRegressionRef,
  type ContestantRanking,
  type DeanonymizedHumanScore,
  type PanelHumanCalibrationReport,
  type StrongCaliberReadinessGateInput,
} from "../../src/benchmark-stages/index.js";

// ── fixture builders (pure data, no scoring) ─────────────────────────────────

const SELF = "itotori-context-on";

/** A ranking whose system-under-test entry has the given judge mean (0–4). */
function ranking(selfJudgeMean: number, aggregate = selfJudgeMean / 4): ContestantRanking {
  return {
    entries: [
      {
        contestantId: SELF,
        judgeMean: selfJudgeMean,
        metricMean: aggregate,
        aggregateScore: aggregate,
        rank: 0,
      },
      {
        contestantId: "fan-edited-mtl",
        judgeMean: 2,
        metricMean: 0.5,
        aggregateScore: 0.5,
        rank: 1,
      },
    ],
    order: [SELF, "fan-edited-mtl"],
  };
}

/**
 * A §8 panel↔human calibration report whose per-dimension human means average to
 * `humanMean`. Only the fields the gate reads are populated (`overall.pearson`
 * + `byDimension[].humanMean`).
 */
function humanAnchorReport(
  humanMean: number,
  pearson: number | null = 0.9,
): PanelHumanCalibrationReport {
  return {
    anchorPolicy: {
      role: "external_calibration_anchor",
      fullyOutsideLlmPipelineLoop: true,
      usage: "calibrate_or_validate_panel_only",
      usedForItotoriTuning: false,
      methodologyRef:
        "docs/itotori-translation-benchmark-methodology.md#8-human-calibration-anchors",
    },
    raters: ["trevor"],
    judgeIds: ["fixture-judge"],
    byDimension: [
      {
        dimensionId: "adequacy",
        itemsCompared: 2,
        panelMean: humanMean,
        humanMean,
        meanAbsDiff: 0,
        normalizedAgreement: 1,
        signedMeanDiff: 0,
        divergence: "aligned",
        pearson,
      },
    ],
    divergentDimensions: [],
    overall: {
      itemsCompared: 2,
      meanAbsDiff: 0,
      normalizedAgreement: 1,
      signedMeanDiff: 0,
      pearson,
    },
  };
}

function humanRatings(count: number): DeanonymizedHumanScore[] {
  const out: DeanonymizedHumanScore[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push({
      raterId: "trevor",
      unitId: `019ed010-0000-7000-8000-0000000000c${i + 1}`,
      contestantId: SELF,
      dimensionId: "adequacy",
      score: 4,
      notes: null,
    });
  }
  return out;
}

function regression(
  overrides: Partial<BacklogRegressionRef> & { direction: BacklogRegressionRef["direction"] },
): BacklogRegressionRef {
  return {
    signalSource: "blind_judge_panel",
    key: "adequacy",
    currentScore: 0.9,
    priorScore: 0.8,
    delta: 0.1,
    direction: overrides.direction,
    summary: "adequacy: 0.800 → 0.900 (improved +0.100)",
    ...overrides,
  };
}

/** A passing baseline: every signal crosses its threshold → DONE. */
function passingInput(): StrongCaliberReadinessGateInput {
  return {
    systemUnderTestId: SELF,
    ranking: ranking(3.8),
    humanAnchor: humanAnchorReport(3.5),
    humanRatings: humanRatings(5),
    regression: { perDimensionRegression: [regression({ direction: "improved" })] },
    qa: { f1: 0.85, seededRecall: 0.9, seededPrecision: 0.8, findingsEmitted: 9 },
    metaValidity: { valid: true, failedChecks: [] },
  };
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("strong-caliber-readiness-gate", () => {
  it("returns STRONG_CALIBER_DONE when every signal crosses its threshold", () => {
    const verdict = decideStrongCaliberReadiness(passingInput());

    expect(verdict.decision).toBe("STRONG_CALIBER_DONE");
    expect(verdict.confidence).toBe("strong_caliber");
    expect(verdict.systemUnderTestId).toBe(SELF);
    expect(verdict.schemaVersion).toBe(STRONG_CALIBER_READINESS_SCHEMA_VERSION);
    expect(verdict.failedGateIds).toEqual([]);
    expect(verdict.findings).toEqual([]);

    // The verdict carries its full evidence — every signal value the gates
    // reasoned over — so a reviewer can audit the call without re-running.
    expect(verdict.evidence).toEqual({
      selfJudgeScore: 3.8,
      selfAggregateScore: 0.95,
      humanAnchorScore: 3.5,
      selfMeetsHumanAnchor: true,
      regressionCount: 0,
      regressionSignalCount: 1,
      qaF1: 0.85,
      humanRatingCount: 5,
      panelHumanPearson: 0.9,
      metaValidityValid: true,
    });

    // Every gate passed and names the values that drove it.
    const gateIds = verdict.gates.map((g) => g.id);
    expect(gateIds).toEqual([
      "self-score-meets-human-anchor",
      "regressions-clean",
      "qa-accuracy-threshold",
      "human-anchor-quorum",
      "panel-calibrated",
      "meta-validity-valid",
    ]);
    for (const gate of verdict.gates) {
      expect(gate.status).toBe("pass");
      expect(gate.detail.length).toBeGreaterThan(0);
    }
  });

  it("returns CONTINUE when the self-score is below the human anchor", () => {
    const verdict = decideStrongCaliberReadiness({
      ...passingInput(),
      ranking: ranking(2.8), // below the 3.5 human anchor
    });

    expect(verdict.decision).toBe("CONTINUE");
    expect(verdict.confidence).toBe("keep_iterating");
    // The PRIMARY overfitting-kill gate is the one that failed.
    expect(verdict.failedGateIds).toContain("self-score-meets-human-anchor");
    expect(verdict.evidence.selfMeetsHumanAnchor).toBe(false);
    expect(verdict.evidence.selfJudgeScore).toBe(2.8);
    expect(verdict.evidence.humanAnchorScore).toBe(3.5);
    // The self-score gate's detail names the gap.
    const selfGate = verdict.gates.find((g) => g.id === "self-score-meets-human-anchor")!;
    expect(selfGate.status).toBe("fail");
    expect(selfGate.detail).toContain("2.800");
    expect(selfGate.detail).toContain("3.500");
    expect(selfGate.detail).toContain("margin floor");
  });

  it("forces CONTINUE when a regression is present, even with a high score", () => {
    // Self-score is excellent (3.9 >= human anchor 3.5) — but a prior-strength
    // dimension regressed. The regression veto must hold against the flattering
    // score: a strong-caliber claim must not come at the cost of a regression.
    const verdict = decideStrongCaliberReadiness({
      ...passingInput(),
      ranking: ranking(3.9),
      regression: {
        perDimensionRegression: [
          regression({
            direction: "regressed",
            key: "character_voice_consistency",
            currentScore: 0.6,
            priorScore: 0.9,
            delta: -0.3,
          }),
        ],
      },
    });

    expect(verdict.decision).toBe("CONTINUE");
    expect(verdict.failedGateIds).toContain("regressions-clean");
    expect(verdict.failedGateIds).not.toContain("self-score-meets-human-anchor");
    expect(verdict.evidence.regressionCount).toBe(1);
    expect(verdict.evidence.selfMeetsHumanAnchor).toBe(true);
    const regGate = verdict.gates.find((g) => g.id === "regressions-clean")!;
    expect(regGate.status).toBe("fail");
    expect(regGate.detail).toContain("1 regressed");
  });

  it("returns CONTINUE when the QA F1 is below the floor", () => {
    const verdict = decideStrongCaliberReadiness({
      ...passingInput(),
      qa: { f1: 0.4, findingsEmitted: 3 },
    });

    expect(verdict.decision).toBe("CONTINUE");
    expect(verdict.failedGateIds).toContain("qa-accuracy-threshold");
    expect(verdict.evidence.qaF1).toBe(0.4);
    const qaGate = verdict.gates.find((g) => g.id === "qa-accuracy-threshold")!;
    expect(qaGate.status).toBe("fail");
    expect(qaGate.detail).toContain("0.400");
  });

  it("returns CONTINUE when the human-anchor quorum is unmet", () => {
    const verdict = decideStrongCaliberReadiness({
      ...passingInput(),
      humanRatings: humanRatings(0), // no human ratings
    });

    expect(verdict.decision).toBe("CONTINUE");
    expect(verdict.failedGateIds).toContain("human-anchor-quorum");
    expect(verdict.evidence.humanRatingCount).toBe(0);
  });

  it("fails the self-score gate when no human anchor is supplied (the primary kill cannot run)", () => {
    const verdict = decideStrongCaliberReadiness({
      ...passingInput(),
      humanAnchor: null,
    });

    expect(verdict.decision).toBe("CONTINUE");
    expect(verdict.failedGateIds).toContain("self-score-meets-human-anchor");
    expect(verdict.evidence.humanAnchorScore).toBeNull();
    expect(verdict.evidence.selfMeetsHumanAnchor).toBeNull();
    // The absence is recorded as a structured finding (the common CONTINUE cause).
    expect(verdict.findings.some((f) => f.kind === "no_human_anchor")).toBe(true);
  });

  it("fails the QA gate when no QA signal is supplied (QA not run)", () => {
    const verdict = decideStrongCaliberReadiness({
      ...passingInput(),
      qa: null,
    });

    expect(verdict.decision).toBe("CONTINUE");
    expect(verdict.failedGateIds).toContain("qa-accuracy-threshold");
    expect(verdict.evidence.qaF1).toBeNull();
    expect(verdict.findings.some((f) => f.kind === "qa_not_run")).toBe(true);
  });

  it("fails when §9 meta-validity is supplied but invalid", () => {
    const verdict = decideStrongCaliberReadiness({
      ...passingInput(),
      metaValidity: { valid: false, failedChecks: ["sensitivity", "calibration"] },
    });

    expect(verdict.decision).toBe("CONTINUE");
    expect(verdict.failedGateIds).toContain("meta-validity-valid");
    expect(verdict.evidence.metaValidityValid).toBe(false);
    const metaGate = verdict.gates.find((g) => g.id === "meta-validity-valid")!;
    expect(metaGate.status).toBe("fail");
    expect(metaGate.detail).toContain("sensitivity");
    expect(metaGate.detail).toContain("calibration");
  });

  it("fails the panel-calibrated gate when the panel↔human pearson is below floor", () => {
    const verdict = decideStrongCaliberReadiness({
      ...passingInput(),
      humanAnchor: humanAnchorReport(3.5, 0.2), // low correlation
    });

    expect(verdict.decision).toBe("CONTINUE");
    expect(verdict.failedGateIds).toContain("panel-calibrated");
    expect(verdict.evidence.panelHumanPearson).toBe(0.2);
  });

  it("is deterministic — same input yields the byte-identical verdict", () => {
    const a = decideStrongCaliberReadiness(passingInput());
    const b = decideStrongCaliberReadiness(passingInput());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("respects threshold overrides and records them on the verdict", () => {
    // Raise the self-score floor so a previously-passing score now fails.
    const verdict = decideStrongCaliberReadiness({
      ...passingInput(),
      thresholds: { selfScoreVsHumanAnchorFloor: 0.5 }, // demand a 0.5 margin
    });

    // self 3.8 vs human 3.5 = +0.3 margin < 0.5 floor → fail.
    expect(verdict.decision).toBe("CONTINUE");
    expect(verdict.failedGateIds).toContain("self-score-meets-human-anchor");
    expect(verdict.thresholds.selfScoreVsHumanAnchorFloor).toBe(0.5);
    // The non-overridden defaults are preserved.
    expect(verdict.thresholds.minQaF1).toBe(DEFAULT_STRONG_CALIBER_THRESHOLDS.minQaF1);
    expect(verdict.thresholdProvenance.section12OpenDecision).toBe(true);
  });

  it("throws when the system under test is absent from the ranking", () => {
    expect(() =>
      decideStrongCaliberReadiness({
        ...passingInput(),
        systemUnderTestId: "not-a-contestant",
      }),
    ).toThrow(StrongCaliberReadinessGateError);
  });

  it("throws when systemUnderTestId is empty", () => {
    expect(() =>
      decideStrongCaliberReadiness({ ...passingInput(), systemUnderTestId: "" }),
    ).toThrow(StrongCaliberReadinessGateError);
  });

  it("the verdict evidence summarizes EVERY gate's driving signal", () => {
    // A CONTINUE verdict with several failing gates — every evidence field is
    // populated so a reviewer sees the full picture without re-running.
    const verdict = decideStrongCaliberReadiness({
      systemUnderTestId: SELF,
      ranking: ranking(2.0),
      humanAnchor: humanAnchorReport(3.5, 0.3),
      humanRatings: [],
      regression: {
        perDimensionRegression: [
          regression({ direction: "regressed" }),
          regression({ direction: "improved", key: "adequacy" }),
        ],
      },
      qa: { f1: 0.2 },
      metaValidity: { valid: false, failedChecks: ["robustness"] },
    });

    expect(verdict.decision).toBe("CONTINUE");
    expect(verdict.evidence).toEqual({
      selfJudgeScore: 2,
      selfAggregateScore: 0.5,
      humanAnchorScore: 3.5,
      selfMeetsHumanAnchor: false,
      regressionCount: 1,
      regressionSignalCount: 2,
      qaF1: 0.2,
      humanRatingCount: 0,
      panelHumanPearson: 0.3,
      metaValidityValid: false,
    });
    // Every failing gate is both in failedGateIds AND has a structured finding.
    expect(verdict.findings.filter((f) => f.kind === "gate_failed").length).toBe(
      verdict.failedGateIds.length,
    );
  });
});
