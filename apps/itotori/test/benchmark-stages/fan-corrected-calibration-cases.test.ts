// benchmark-fan-corrected-calibration-cases — §11.2 tests (SYNTHETIC contested
// lines, deterministic FixtureJudge, NO LLM, NO copyrighted game text).
//
// Proves: (a) the CASE model — source/official/fan-corrected/human-verdict — is
// validated and rejects malformed cases; (b) the calibration FLOW — the BLIND
// panel scores the contested pair (provenance-anonymized) and its preference is
// compared against the settled human adjudication → per-case + aggregate
// agreement, incl. the crux cases (pro-better AND fan-better); (c) NEUTRALITY —
// nothing assumes official=correct or fan=correct: the panel input is
// provenance-blind, and the panel-vs-human agreement is INVARIANT under swapping
// which side is "official". Text-only: no decode, no patchback.

import { describe, expect, it } from "vitest";
import { BENCHMARK_RUBRIC_DIMENSION_IDS } from "@itotori/localization-bridge-schema";
import {
  FAN_CORRECTED_CALIBRATION_POLICY,
  FAN_CORRECTED_ENGINE,
  FanCorrectedCalibrationError,
  FixtureJudge,
  adjudicationPreferredRole,
  assertFanCorrectedCase,
  assertPanelBlindToProvenance,
  buildFanCorrectedCalibration,
  fanCorrectedJudgeUnits,
  runFanCorrectedCalibration,
  swapProvenanceRoles,
  type ContestedVerdict,
  type FanCorrectedCase,
  type FixtureJudgeScoreFn,
} from "../../src/benchmark-stages/index.js";

// ── synthetic contested-line fixtures (NO copyrighted text) ───────────────────
// Two invented "games" standing in for C;H NOAH / Steins;Gate. Each line is a
// contested pair with a settled human verdict. The fixtures deliberately cover
// BOTH crux directions: a fan-better line AND a pro-better line.
const U_FAN_WINS = "019ed011-0000-7000-8000-0000000000f1";
const U_PRO_WINS = "019ed011-0000-7000-8000-0000000000f2";
const U_TIE = "019ed011-0000-7000-8000-0000000000f3";

// The synthetic quality "truth" the fixture judge encodes, keyed on the TEXT.
// This is what a blind judge would score — it knows nothing of provenance.
const TEXT_QUALITY: Record<string, number> = {
  // U_FAN_WINS — the official is a bad, stiff rendering; the fan fix is better.
  "The situation has become quite bad, I think.": 1, // official (bad)
  "This is a total disaster.": 4, // fan-corrected (good)
  // U_PRO_WINS — the official reads naturally; the fan "fix" over-eggs it.
  "No way. You've got to be kidding me.": 4, // official (good)
  "Impossible. Surely you jest, comrade.": 1, // fan-corrected (worse)
  // U_TIE — both are fine, different phrasings.
  "See you later.": 3, // official
  "Catch you later.": 3, // fan-corrected
};

function caseFanWins(): FanCorrectedCase {
  return {
    caseId: "chn-fan-wins",
    unitId: U_FAN_WINS,
    gameTitle: "Chaos;Head NOAH (synthetic stand-in)",
    speaker: "Takumi",
    source: "かなりまずいことになった、と思う。",
    official: "The situation has become quite bad, I think.",
    fanCorrected: "This is a total disaster.",
    humanVerdict: "fan_corrected_better",
    adjudicationRationale:
      "The official is stilted and hedged; the fan fix matches the panic in the scene.",
    adjudicatedBy: "rater-trevor",
  };
}

function caseProWins(): FanCorrectedCase {
  return {
    caseId: "sg-pro-wins",
    unitId: U_PRO_WINS,
    gameTitle: "Steins;Gate (synthetic stand-in)",
    speaker: "Okabe",
    source: "ありえない。冗談だろ。",
    official: "No way. You've got to be kidding me.",
    fanCorrected: "Impossible. Surely you jest, comrade.",
    humanVerdict: "official_better",
    adjudicationRationale:
      "The fan rewrite injects a register that is not in the source; the official is truer.",
    adjudicatedBy: "rater-trevor",
  };
}

function caseTie(): FanCorrectedCase {
  return {
    caseId: "chn-tie",
    unitId: U_TIE,
    gameTitle: "Chaos;Head NOAH (synthetic stand-in)",
    speaker: null,
    source: "またな。",
    official: "See you later.",
    fanCorrected: "Catch you later.",
    humanVerdict: "both_work",
    adjudicationRationale: "Both are natural, equivalent renderings of a casual sign-off.",
    adjudicatedBy: "rater-trevor",
  };
}

// A fixture judge that scores each candidate purely from its TEXT quality — it
// is BLIND to provenance (it never receives official/fan labels).
const scoreFromText: FixtureJudgeScoreFn = ({ candidate, dimensionId }) => {
  const score = TEXT_QUALITY[candidate.candidateText];
  if (score === undefined) {
    throw new Error(`fixture judge saw unknown candidate text '${candidate.candidateText}'`);
  }
  return {
    score: score as 0 | 1 | 2 | 3 | 4,
    citation:
      score < 4
        ? {
            sourceSpan: candidate.candidateText.slice(0, 8),
            decodedContextUsed: "text-only (MAGES, no decode)",
            rationale: `${dimensionId}: judged blind on text quality`,
          }
        : null,
  };
};

function panel(): FixtureJudge[] {
  return [
    new FixtureJudge({
      judgeId: "judge-deepseek",
      modelFamily: "deepseek",
      modelId: "deepseek/x",
      providerId: "deepseek-p",
      scoreFn: scoreFromText,
    }),
    new FixtureJudge({
      judgeId: "judge-qwen",
      modelFamily: "qwen",
      modelId: "qwen/x",
      providerId: "qwen-p",
      scoreFn: scoreFromText,
    }),
  ];
}

// ── 1. The case model ─────────────────────────────────────────────────────────
describe("§11.2 fan-corrected case model", () => {
  it("validates a well-formed contested case", () => {
    expect(() => assertFanCorrectedCase(caseFanWins())).not.toThrow();
    expect(() => assertFanCorrectedCase(caseProWins())).not.toThrow();
    expect(() => assertFanCorrectedCase(caseTie())).not.toThrow();
  });

  it("rejects identical renderings (not a contested line)", () => {
    const c = caseFanWins();
    expect(() => assertFanCorrectedCase({ ...c, fanCorrected: c.official })).toThrow(
      FanCorrectedCalibrationError,
    );
  });

  it("rejects an unknown verdict and a missing rationale", () => {
    const c = caseFanWins();
    expect(() =>
      assertFanCorrectedCase({ ...c, humanVerdict: "fan_is_law" as ContestedVerdict }),
    ).toThrow(FanCorrectedCalibrationError);
    expect(() => assertFanCorrectedCase({ ...c, adjudicationRationale: "  " })).toThrow(
      FanCorrectedCalibrationError,
    );
  });

  it("maps verdict → directional preference without privileging a provenance", () => {
    expect(adjudicationPreferredRole("official_better")).toBe("official");
    expect(adjudicationPreferredRole("fan_corrected_better")).toBe("fan_corrected");
    expect(adjudicationPreferredRole("tie")).toBeNull();
    expect(adjudicationPreferredRole("both_work")).toBeNull();
    expect(adjudicationPreferredRole("both_fail")).toBeNull();
  });

  it("is text-only — MAGES, no decode, no patchback", () => {
    expect(FAN_CORRECTED_ENGINE.textOnly).toBe(true);
    expect(FAN_CORRECTED_ENGINE.decode).toBe(false);
    expect(FAN_CORRECTED_ENGINE.patchback).toBe(false);
    expect(FAN_CORRECTED_ENGINE.supported).toBe(false);
    // The judge feed carries the source line but NO decoded scene graph.
    const feed = fanCorrectedJudgeUnits([caseFanWins()]);
    expect(feed[0]!.decodedContext.sourceLine).toBe(caseFanWins().source);
    expect(feed[0]!.decodedContext.scene.dispatchOrderLength).toBe(0);
    expect(feed[0]!.decodedContext.scene.dispatchPosition).toBeNull();
  });
});

// ── 2. The calibration flow ───────────────────────────────────────────────────
describe("§11.2 contested-quality calibration flow", () => {
  it("panel agrees with humans across BOTH crux directions (pro-better AND fan-better)", async () => {
    const { report } = await runFanCorrectedCalibration({
      cases: [caseFanWins(), caseProWins(), caseTie()],
      judges: panel(),
      panelSeed: "seed",
    });
    expect(report.policy).toBe(FAN_CORRECTED_CALIBRATION_POLICY);
    expect(report.judgeIds).toEqual(["judge-deepseek", "judge-qwen"]);

    const fan = report.byCase.find((c) => c.unitId === U_FAN_WINS)!;
    expect(fan.humanPreferredRole).toBe("fan_corrected");
    expect(fan.panel.preferredRole).toBe("fan_corrected"); // panel found the fan fix better
    expect(fan.agrees).toBe(true);

    const pro = report.byCase.find((c) => c.unitId === U_PRO_WINS)!;
    expect(pro.humanPreferredRole).toBe("official");
    expect(pro.panel.preferredRole).toBe("official"); // panel found the official better
    expect(pro.agrees).toBe(true);

    const tie = report.byCase.find((c) => c.unitId === U_TIE)!;
    expect(tie.humanPreferredRole).toBeNull();
    expect(tie.panel.preferredRole).toBeNull(); // within the tie threshold
    expect(tie.agrees).toBe(true);

    expect(report.aggregate.casesCompared).toBe(3);
    expect(report.aggregate.agreements).toBe(3);
    expect(report.aggregate.agreementRate).toBe(1);
    expect(report.aggregate.decisiveHumanCases).toBe(2);
    expect(report.aggregate.decisiveAgreements).toBe(2);
    expect(report.aggregate.decisiveAgreementRate).toBe(1);
  });

  it("surfaces DISAGREEMENT when the panel diverges from the human adjudication", async () => {
    // Panel that ALWAYS prefers whichever text scores higher — but we feed it a
    // case whose HUMAN verdict contradicts the blind text quality: humans say the
    // official (low-quality-looking) text is better for a reason the blind panel
    // can't see. The calibration must FLAG the disagreement, not paper over it.
    const contrarian: FanCorrectedCase = {
      ...caseFanWins(),
      caseId: "chn-human-overrules",
      humanVerdict: "official_better", // human overrules the blind panel
      adjudicationRationale: "Context the blind panel lacks makes the official correct here.",
    };
    const { report } = await runFanCorrectedCalibration({
      cases: [contrarian],
      judges: panel(),
      panelSeed: "seed",
    });
    const only = report.byCase[0]!;
    expect(only.panel.preferredRole).toBe("fan_corrected"); // blind panel prefers the fan text
    expect(only.humanPreferredRole).toBe("official"); // human disagrees
    expect(only.agrees).toBe(false);
    expect(report.aggregate.agreementRate).toBe(0);
    expect(report.aggregate.decisiveAgreementRate).toBe(0);
  });

  it("refuses an empty case list", () => {
    expect(() => buildFanCorrectedCalibration({ cases: [], panelScores: [] })).toThrow(
      FanCorrectedCalibrationError,
    );
    expect(() => fanCorrectedJudgeUnits([])).toThrow(FanCorrectedCalibrationError);
  });
});

// ── 3. Neutrality — pro-isn't-good, fan-isn't-best (encoded + tested) ─────────
describe("§11.2 provenance neutrality", () => {
  it("policy stamps neither provenance as authoritative", () => {
    expect(FAN_CORRECTED_CALIBRATION_POLICY.officialAssumedAuthoritative).toBe(false);
    expect(FAN_CORRECTED_CALIBRATION_POLICY.fanAssumedAuthoritative).toBe(false);
    expect(FAN_CORRECTED_CALIBRATION_POLICY.groundTruth).toBe("human_adjudication");
  });

  it("the panel input is BLIND to which candidate is official vs fan", () => {
    const feed = fanCorrectedJudgeUnits([caseFanWins(), caseProWins(), caseTie()]);
    // The blinded judge input leaks neither role — proven via the real panel path.
    expect(() => assertPanelBlindToProvenance(feed)).not.toThrow();
    // And the raw candidate contestant ids ARE the roles (which the panel strips).
    expect(feed[0]!.candidates.map((c) => c.contestantId).sort()).toEqual([
      "fan_corrected",
      "official",
    ]);
  });

  it("agreement is INVARIANT under swapping which side is official (pro≠good, fan≠best)", async () => {
    const cases = [caseFanWins(), caseProWins(), caseTie()];
    const base = await runFanCorrectedCalibration({ cases, judges: panel(), panelSeed: "seed" });

    // Relabel every case's provenance (the SAME texts, the human still prefers the
    // SAME text — only the official/fan label moves). If the flow secretly favored
    // a provenance, the agreement would change. It must NOT.
    const swapped = cases.map(swapProvenanceRoles);
    const swappedRun = await runFanCorrectedCalibration({
      cases: swapped,
      judges: panel(),
      panelSeed: "seed",
    });

    expect(swappedRun.report.aggregate.agreementRate).toBe(base.report.aggregate.agreementRate);
    expect(swappedRun.report.aggregate.decisiveAgreementRate).toBe(
      base.report.aggregate.decisiveAgreementRate,
    );
    // Per case: the human's preferred TEXT still wins, just under the flipped role.
    const fanBase = base.report.byCase.find((c) => c.unitId === U_FAN_WINS)!;
    const fanSwap = swappedRun.report.byCase.find((c) => c.unitId === U_FAN_WINS)!;
    expect(fanBase.agrees).toBe(true);
    expect(fanSwap.agrees).toBe(true);
    // The winning ROLE flipped (fan→official) because the label moved, but the
    // human/panel still agree — proving provenance carries no weight.
    expect(fanBase.panel.preferredRole).toBe("fan_corrected");
    expect(fanSwap.panel.preferredRole).toBe("official");
  });

  it("swapProvenanceRoles moves the label but preserves the human judgment of the text", () => {
    const swapped = swapProvenanceRoles(caseFanWins());
    // The texts are relabelled…
    expect(swapped.official).toBe(caseFanWins().fanCorrected);
    expect(swapped.fanCorrected).toBe(caseFanWins().official);
    // …and the verdict direction flips so the SAME text still wins.
    expect(swapped.humanVerdict).toBe("official_better");
    expect(adjudicationPreferredRole(swapped.humanVerdict)).toBe("official");
  });
});

// ── 4. Rubric-shape sanity (all dimensions scored per candidate) ──────────────
describe("§11.2 panel scores every rubric dimension per candidate", () => {
  it("produces a score for each (dimension, candidate) on a case", async () => {
    const { panel: panelResult } = await runFanCorrectedCalibration({
      cases: [caseFanWins()],
      judges: panel(),
      panelSeed: "seed",
    });
    const dims = new Set(
      panelResult.contestantDimensionScores
        .filter((s) => s.contestantId === "official")
        .map((s) => s.dimensionId),
    );
    // Every rubric dimension the official rendering was scored on (across judges).
    for (const dimId of BENCHMARK_RUBRIC_DIMENSION_IDS) {
      expect(dims.has(dimId)).toBe(true);
    }
  });
});
