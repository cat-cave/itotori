// benchmark-meta-validity-harness — §9 tests (SYNTHETIC, deterministic, NO LLM).
//
// Proves the benchmark validates ITSELF via the three §9 checks, all flowing
// through the REAL §3 metric suite + §4 judge panel (not tautologies):
//   1. SENSITIVITY — a SABOTAGED Itotori output (seeded defects) ranks BELOW
//      fan-MTL, while the CLEAN Itotori does NOT (the demotion is caused by the
//      sabotage). The degraded text is re-scored by the actual panel + metrics.
//   2. ROBUSTNESS — the verdict is stable under judge-swap + order-swap (a
//      text-quality panel), and an ORDER-BIASED panel is correctly caught as
//      unstable.
//   3. CALIBRATION — a panel matching the human anchor passes the correlation
//      floor; a panel anti-correlated with humans fails.
// Plus run-gating: any failing check → `valid: false` naming the culprit.
//
// The judges are deterministic fixture judges that score off OBSERVABLE TEXT
// SIGNALS (residue / register / literalness / omission) — NEVER a system
// identity — so degrading the text genuinely lowers the score, exactly as a
// real ZDR judge reading the text would.

import { describe, expect, it } from "vitest";
import { BENCHMARK_RUBRIC_DIMENSION_IDS } from "@itotori/localization-bridge-schema";
import {
  DEFAULT_META_VALIDITY_THRESHOLDS,
  FixtureJudge,
  MetaValidityHarnessError,
  SABOTAGE_MEANING_MARKER,
  SABOTAGE_REGISTER_MARKER,
  computeContestantRanking,
  rankContestants,
  runCalibrationCheck,
  runMetaValidityHarness,
  runRobustnessCheck,
  runSensitivityCheck,
  sabotageTranslation,
  type DeanonymizedHumanScore,
  type FixtureJudgeScoreFn,
  type MetaValidityScenario,
  type RobustnessSwap,
} from "../../src/benchmark-stages/index.js";
import type { NarrativeStructure } from "../../src/structure/index.js";

// ── contestants ──────────────────────────────────────────────────────────────
const OFFICIAL = "official-localization";
const ITOTORI = "itotori-context-on";
const FAN_MTL = "fan-edited-mtl";
const RAW_MTL = "raw-mtl-baseline";
const ALL = [OFFICIAL, ITOTORI, FAN_MTL, RAW_MTL];

const U1 = "019ed010-0000-7000-8000-0000000000c1";
const U2 = "019ed010-0000-7000-8000-0000000000c2";
const UNITS = [U1, U2];

// Clean (un-sabotaged) target texts. The quality judge (below) scores these off
// intrinsic signals: itotori/official are natural (no markers → 4), fan-MTL is
// literal ("(lit.)" → 3), raw-MTL is literal AND awkward ("(lit.) (awk.)" → 2).
const CLEAN_TEXT: Record<string, Record<string, string>> = {
  [U1]: {
    [OFFICIAL]: "Good morning, Rin.",
    [ITOTORI]: "Mornin' there, Rin.",
    [FAN_MTL]: "Good morning, Rin. (lit.)",
    [RAW_MTL]: "Good morning greeting, Rin. (lit.) (awk.)",
  },
  [U2]: {
    [OFFICIAL]: "Yeah, good morning.",
    [ITOTORI]: "Mm, mornin' back.",
    [FAN_MTL]: "Yes, good morning. (lit.)",
    [RAW_MTL]: "Yes, it is good morning. (lit.) (awk.)",
  },
};

// The per-contestant clean quality the humans + a matching panel agree on.
const CLEAN_TRUTH: Record<string, number> = {
  [OFFICIAL]: 4,
  [ITOTORI]: 4,
  [FAN_MTL]: 3,
  [RAW_MTL]: 2,
};

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

function scenario(): MetaValidityScenario {
  return {
    corpus: [
      { unitId: U1, label: "scene-2031#0", sourceText: "おはよう、りん。" },
      { unitId: U2, label: "scene-2031#1", sourceText: "うん、おはよう。" },
    ],
    contestants: ALL.map((contestantId) => ({
      contestantId,
      outputs: UNITS.map((unitId) => ({ unitId, targetText: CLEAN_TEXT[unitId]![contestantId]! })),
    })),
    structure: syntheticStructure(),
    unitRefs: [
      { unitId: U1, sceneId: 2031, messageOrder: 0 },
      { unitId: U2, sceneId: 2031, messageOrder: 1 },
    ],
    glossary: [],
    canonNames: [],
  };
}

// ── a text-quality fixture judge (scores off the TEXT, never an identity) ──────
const JP_RE = /[぀-ヿ㐀-䶿一-鿿]/u;

const qualityScoreFn: FixtureJudgeScoreFn = ({ candidate, dimensionId }) => {
  const text = candidate.candidateText;
  let score = 4;
  if (JP_RE.test(text)) {
    score -= 2; // untranslated source-script residue
  }
  if (text.includes(SABOTAGE_REGISTER_MARKER)) {
    score -= 1; // broken register / voice drift
  }
  if (text.includes(SABOTAGE_MEANING_MARKER)) {
    score -= 1; // meaning inverted
  }
  if (text.includes("(lit.)")) {
    score -= 1; // over-literal
  }
  if (text.includes("(awk.)")) {
    score -= 1; // awkward phrasing
  }
  if (text.split(/\s+/).filter((w) => w.length > 0).length <= 2) {
    score -= 1; // suspicious omission
  }
  score = Math.max(0, Math.min(4, score));
  const citation =
    score < 4
      ? {
          sourceSpan: text.slice(0, 12),
          decodedContextUsed: "speaker 和人, scene 2031",
          rationale: `${dimensionId}: text-quality signals lowered the score`,
        }
      : null;
  return { score: score as 0 | 1 | 2 | 3 | 4, citation };
};

function qualityJudge(judgeId: string, modelFamily: string): FixtureJudge {
  return new FixtureJudge({
    judgeId,
    modelFamily,
    modelId: `${modelFamily}/x`,
    providerId: `${modelFamily}-p`,
    scoreFn: qualityScoreFn,
  });
}

function qualityPanel(): FixtureJudge[] {
  return [qualityJudge("judge-deepseek", "deepseek"), qualityJudge("judge-qwen", "qwen")];
}

// An ORDER-BIASED judge: scores by BLIND LABEL (position), so a different order
// seed produces a different ranking — the kind of instability §9.2 must catch.
const orderBiasScoreFn: FixtureJudgeScoreFn = ({ candidate, dimensionId }) => {
  // candidate-a → 4, candidate-b → 3, candidate-c → 2, candidate-d → 1 …
  const letter = candidate.blindLabel.replace("candidate-", "");
  const index = letter.charCodeAt(0) - "a".charCodeAt(0);
  const score = Math.max(0, Math.min(4, 4 - index));
  const citation =
    score < 4
      ? {
          sourceSpan: candidate.candidateText.slice(0, 12),
          decodedContextUsed: "speaker 和人, scene 2031",
          rationale: `${dimensionId}: position ${index}`,
        }
      : null;
  return { score: score as 0 | 1 | 2 | 3 | 4, citation };
};

function orderBiasedPanel(): FixtureJudge[] {
  return [
    new FixtureJudge({
      judgeId: "judge-biased-a",
      modelFamily: "deepseek",
      modelId: "deepseek/x",
      providerId: "deepseek-p",
      scoreFn: orderBiasScoreFn,
    }),
    new FixtureJudge({
      judgeId: "judge-biased-b",
      modelFamily: "qwen",
      modelId: "qwen/x",
      providerId: "qwen-p",
      scoreFn: orderBiasScoreFn,
    }),
  ];
}

// De-anonymized human anchor scores from a per-contestant truth table.
function humanScoresFrom(truth: Record<string, number>): DeanonymizedHumanScore[] {
  const out: DeanonymizedHumanScore[] = [];
  for (const raterId of ["rater-trevor", "rater-b"]) {
    for (const unitId of UNITS) {
      for (const contestantId of ALL) {
        for (const dimensionId of BENCHMARK_RUBRIC_DIMENSION_IDS) {
          out.push({
            raterId,
            unitId,
            contestantId,
            dimensionId,
            score: truth[contestantId]! as 0 | 1 | 2 | 3 | 4,
            notes: null,
          });
        }
      }
    }
  }
  return out;
}

// ── ranking primitive ─────────────────────────────────────────────────────────
describe("§9 ranking primitive", () => {
  it("combines judge + metric signals, best→worst, deterministic tie-break", () => {
    const ranking = rankContestants({
      judgeScores: [
        {
          unitId: U1,
          contestantId: "a",
          dimensionId: "adequacy",
          judgeId: "j",
          score: 4,
          citation: null,
        },
        {
          unitId: U1,
          contestantId: "b",
          dimensionId: "adequacy",
          judgeId: "j",
          score: 2,
          citation: null,
        },
      ],
      metricScores: [
        {
          systemId: "a",
          metricId: "m",
          checkName: "m",
          score: 1,
          ruleCount: 1,
          passedRuleCount: 1,
          failedRuleCount: 0,
          detail: {},
        },
        {
          systemId: "b",
          metricId: "m",
          checkName: "m",
          score: 0.5,
          ruleCount: 1,
          passedRuleCount: 0,
          failedRuleCount: 1,
          detail: {},
        },
      ],
      contestantIds: ["a", "b"],
    });
    expect(ranking.order).toEqual(["a", "b"]);
    expect(ranking.entries[0]!.rank).toBe(0);
    expect(ranking.entries[0]!.aggregateScore).toBeGreaterThan(ranking.entries[1]!.aggregateScore);
  });

  it("refuses a contestant with no signal", () => {
    expect(() =>
      rankContestants({ judgeScores: [], metricScores: [], contestantIds: ["ghost"] }),
    ).toThrow(MetaValidityHarnessError);
  });
});

// ── sabotage injector ─────────────────────────────────────────────────────────
describe("§9.1 sabotage injector", () => {
  it("injects residue + register markers deterministically", () => {
    const bad = sabotageTranslation("Morning, Rin.", {
      kinds: ["untranslated_residue", "voice_drift"],
    });
    expect(JP_RE.test(bad)).toBe(true);
    expect(bad).toContain(SABOTAGE_REGISTER_MARKER);
    expect(
      sabotageTranslation("Morning, Rin.", { kinds: ["untranslated_residue", "voice_drift"] }),
    ).toBe(bad);
  });

  it("omission drops the tail; requires at least one kind", () => {
    expect(
      sabotageTranslation("one two three four five", { kinds: ["omission"] }).split(/\s+/).length,
    ).toBeLessThan(5);
    expect(() => sabotageTranslation("x", { kinds: [] })).toThrow(MetaValidityHarnessError);
  });
});

// ── 1. SENSITIVITY ────────────────────────────────────────────────────────────
describe("§9.1 sensitivity — sabotaged Itotori ranks BELOW fan-MTL", () => {
  it("sabotaged Itotori loses to fan-MTL; clean Itotori does NOT (non-tautology)", async () => {
    const result = await runSensitivityCheck({
      scenario: scenario(),
      itotoriContestantId: ITOTORI,
      fanMtlContestantId: FAN_MTL,
      sabotage: { kinds: ["untranslated_residue", "voice_drift", "meaning_shift"] },
      judges: qualityPanel(),
      panelSeed: "meta-seed",
    });
    expect(result.passed).toBe(true);
    // Sabotaged Itotori ranks strictly worse than fan-MTL.
    expect(result.sabotagedItotoriRanksBelowFanMtl).toBe(true);
    expect(result.sabotagedItotoriRank).toBeGreaterThan(result.fanMtlRank);
    // The control: CLEAN Itotori is NOT below fan-MTL — the demotion is caused
    // by the sabotage, so the benchmark isn't just biased against Itotori.
    expect(result.controlItotoriRanksBelowFanMtl).toBe(false);
    expect(result.controlItotoriRank).toBeLessThan(result.controlFanMtlRank);
  });

  it("does NOT falsely fail: with a NO-OP-equivalent judge, clean Itotori stays ahead", async () => {
    // Re-run just the base ranking to prove the clean instrument ranks Itotori
    // at/above fan-MTL (the sensitivity control).
    const base = await computeContestantRanking({
      scenario: scenario(),
      judges: qualityPanel(),
      panelSeed: "meta-seed",
    });
    const itotori = base.ranking.entries.find((e) => e.contestantId === ITOTORI)!;
    const fan = base.ranking.entries.find((e) => e.contestantId === FAN_MTL)!;
    expect(itotori.rank).toBeLessThan(fan.rank);
  });
});

// ── 2. ROBUSTNESS ─────────────────────────────────────────────────────────────
describe("§9.2 robustness — verdict stable under judge/order swap", () => {
  it("a text-quality panel is stable under judge-swap + order-swap", async () => {
    const swaps: RobustnessSwap[] = [
      {
        swapId: "judge-swap-mistral",
        swapKind: "judge",
        judges: [
          qualityJudge("judge-deepseek", "deepseek"),
          qualityJudge("judge-mistral", "mistral"),
        ],
        panelSeed: "meta-seed",
      },
      {
        swapId: "order-swap-seed2",
        swapKind: "order",
        judges: qualityPanel(),
        panelSeed: "different-seed",
      },
    ];
    const result = await runRobustnessCheck({
      scenario: scenario(),
      baseline: { judges: qualityPanel(), panelSeed: "meta-seed" },
      swaps,
      maxInstability: DEFAULT_META_VALIDITY_THRESHOLDS.robustnessMaxInstability,
    });
    expect(result.passed).toBe(true);
    expect(result.maxInstability).toBe(0);
    for (const swap of result.swaps) {
      expect(swap.order).toEqual(result.baselineOrder);
    }
  });

  it("an ORDER-BIASED panel is caught as unstable (fails robustness)", async () => {
    const result = await runRobustnessCheck({
      scenario: scenario(),
      baseline: { judges: orderBiasedPanel(), panelSeed: "meta-seed" },
      swaps: [
        {
          swapId: "order-swap",
          swapKind: "order",
          judges: orderBiasedPanel(),
          panelSeed: "wildly-different-seed",
        },
      ],
      maxInstability: DEFAULT_META_VALIDITY_THRESHOLDS.robustnessMaxInstability,
    });
    expect(result.passed).toBe(false);
    expect(result.maxInstability).toBeGreaterThan(
      DEFAULT_META_VALIDITY_THRESHOLDS.robustnessMaxInstability,
    );
  });
});

// ── 3. CALIBRATION ────────────────────────────────────────────────────────────
describe("§9.3 calibration — ranking correlates with human anchor", () => {
  async function panelScores(judges = qualityPanel()) {
    const run = await computeContestantRanking({
      scenario: scenario(),
      judges,
      panelSeed: "meta-seed",
    });
    return run.panel.contestantDimensionScores;
  }

  it("a MATCHING panel meets the correlation floor", async () => {
    const result = runCalibrationCheck({
      panelScores: await panelScores(),
      humanScores: humanScoresFrom(CLEAN_TRUTH),
      minPearson: DEFAULT_META_VALIDITY_THRESHOLDS.calibrationMinPearson,
    });
    expect(result.passed).toBe(true);
    expect(result.pearson).not.toBeNull();
    expect(result.pearson!).toBeGreaterThanOrEqual(
      DEFAULT_META_VALIDITY_THRESHOLDS.calibrationMinPearson,
    );
  });

  it("an ANTI-correlated human anchor fails the floor", async () => {
    const reversed: Record<string, number> = {
      [OFFICIAL]: 1,
      [ITOTORI]: 1,
      [FAN_MTL]: 3,
      [RAW_MTL]: 4,
    };
    const result = runCalibrationCheck({
      panelScores: await panelScores(),
      humanScores: humanScoresFrom(reversed),
      minPearson: DEFAULT_META_VALIDITY_THRESHOLDS.calibrationMinPearson,
    });
    expect(result.passed).toBe(false);
    expect(result.pearson!).toBeLessThan(DEFAULT_META_VALIDITY_THRESHOLDS.calibrationMinPearson);
  });
});

// ── 4. RUN-GATING (the whole harness) ─────────────────────────────────────────
describe("§9 run-gating MetaValidityReport", () => {
  function harnessInput(humanTruth: Record<string, number>, robustJudges = qualityPanel) {
    return {
      sensitivity: {
        scenario: scenario(),
        itotoriContestantId: ITOTORI,
        fanMtlContestantId: FAN_MTL,
        sabotage: { kinds: ["untranslated_residue", "voice_drift"] as const },
        judges: qualityPanel(),
        panelSeed: "meta-seed",
      },
      robustness: {
        scenario: scenario(),
        baseline: { judges: robustJudges(), panelSeed: "meta-seed" },
        swaps: [
          {
            swapId: "order",
            swapKind: "order" as const,
            judges: robustJudges(),
            panelSeed: "seed-2",
          },
        ],
      },
      calibration: {
        panelScores: [] as never,
        humanScores: humanScoresFrom(humanTruth),
      },
    };
  }

  it("all three pass → valid: true, no failed checks", async () => {
    const input = harnessInput(CLEAN_TRUTH);
    // Fill the calibration panel scores from a real run.
    const base = await computeContestantRanking({
      scenario: scenario(),
      judges: qualityPanel(),
      panelSeed: "meta-seed",
    });
    input.calibration.panelScores = base.panel.contestantDimensionScores as never;

    const report = await runMetaValidityHarness(input);
    expect(report.valid).toBe(true);
    expect(report.failedChecks).toEqual([]);
    // Thresholds are RECORDED (§12).
    expect(report.thresholds).toEqual(DEFAULT_META_VALIDITY_THRESHOLDS);
    expect(report.thresholdProvenance.section12OpenDecision).toBe(true);
    expect(report.sensitivity.passed).toBe(true);
    expect(report.robustness.passed).toBe(true);
    expect(report.calibration.passed).toBe(true);
  });

  it("a failing CALIBRATION marks the run INVALID and names the culprit", async () => {
    const reversed: Record<string, number> = {
      [OFFICIAL]: 1,
      [ITOTORI]: 1,
      [FAN_MTL]: 3,
      [RAW_MTL]: 4,
    };
    const input = harnessInput(reversed);
    const base = await computeContestantRanking({
      scenario: scenario(),
      judges: qualityPanel(),
      panelSeed: "meta-seed",
    });
    input.calibration.panelScores = base.panel.contestantDimensionScores as never;

    const report = await runMetaValidityHarness(input);
    expect(report.valid).toBe(false);
    expect(report.failedChecks).toContain("calibration");
    expect(report.calibration.passed).toBe(false);
  });

  it("a failing ROBUSTNESS (order-biased panel) marks the run INVALID", async () => {
    const input = harnessInput(CLEAN_TRUTH, orderBiasedPanel);
    const base = await computeContestantRanking({
      scenario: scenario(),
      judges: qualityPanel(),
      panelSeed: "meta-seed",
    });
    input.calibration.panelScores = base.panel.contestantDimensionScores as never;

    const report = await runMetaValidityHarness(input);
    expect(report.valid).toBe(false);
    expect(report.failedChecks).toContain("robustness");
  });
});
