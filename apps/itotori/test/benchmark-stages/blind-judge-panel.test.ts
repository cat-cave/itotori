// benchmark-blind-judge-panel — §4 fixture-judge tests (NO real LLM calls).
//
// Proves the panel: (a) consumes the rubric (§2) + decoded-context feed (§5);
// (b) applies the bias guards — provenance anonymization (a judge input carries
// NO system identity) and per-judge order randomization (§4.2); (c) enforces the
// ≥2-model-family floor (§4.1); (d) applies the §4.3 output contract (per-
// dimension 0–4 + cited reasoning; sub-4 without a citation dropped as
// unscorable; sub-4 cited → itotori-lqa-1 llm_qa finding); (e) computes inter-
// judge agreement (§4.4); (f) aggregates cost from usage.cost only (§4.1),
// which is $0 for the zero-cost fixture judges. Deterministic fixtures only.

import { describe, expect, it } from "vitest";
import {
  BENCHMARK_QUALITY_RUBRIC,
  BENCHMARK_RUBRIC_DIMENSION_IDS,
  type BenchmarkRubricScore,
} from "@itotori/localization-bridge-schema";
import {
  BlindJudgePanelError,
  FixtureJudge,
  assertBlindJudgeInputHasNoProvenance,
  blindLabelForIndex,
  blindUnitForJudge,
  buildDecodedContextFeed,
  runBlindJudgePanel,
  seededOrderPermutation,
  type BlindJudgeUnitInput,
  type ContestantCandidate,
  type DecodedContextFeedInput,
  type FixtureJudgeScoreFn,
  type JudgeCitation,
} from "../../src/benchmark-stages/index.js";
import type { NarrativeStructure } from "../../src/agents/structure-informed-context/index.js";

// ── synthetic decode + provenance-laden contestants ───────────────────────────
const U1 = "019ed010-0000-7000-8000-0000000000c1";
const U2 = "019ed010-0000-7000-8000-0000000000c2";

// Contestant ids carry PROVENANCE on purpose (official / itotori / raw-mtl) so
// the anonymization test has something real to catch leaking.
const OFFICIAL = "official-en";
const ITOTORI_ON = "itotori-context-on";
const RAW_MTL = "raw-mtl-baseline";
const ALL_CONTESTANTS = [OFFICIAL, ITOTORI_ON, RAW_MTL];

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
  const texts: Record<string, Record<string, string>> = {
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
  for (const unitId of [U1, U2]) {
    for (const contestantId of ALL_CONTESTANTS) {
      out.push({ contestantId, unitId, candidateText: texts[unitId]![contestantId]! });
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

// A citation keyed on the STABLE candidate text so it never carries provenance.
function citationFor(candidateText: string, dimensionId: string): JudgeCitation {
  return {
    sourceSpan: "おはよう",
    decodedContextUsed: "speaker 和人, scene 2031",
    rationale: `${dimensionId}: '${candidateText}' judged in context`,
  };
}

// Score by candidate TEXT (stable per real contestant) so judges agree on the
// same contestant regardless of the randomized blind order they each saw.
function scoreByText(base: Record<string, BenchmarkRubricScore>): FixtureJudgeScoreFn {
  return ({ candidate, dimensionId }) => {
    const score = base[candidate.candidateText] ?? (4 as BenchmarkRubricScore);
    return {
      score,
      citation: score < 4 ? citationFor(candidate.candidateText, dimensionId) : null,
    };
  };
}

function makeJudge(judgeId: string, family: string, scoreFn: FixtureJudgeScoreFn): FixtureJudge {
  return new FixtureJudge({
    judgeId,
    modelFamily: family,
    modelId: `${family}/model-x`,
    providerId: `${family}-provider`,
    scoreFn,
  });
}

// Two judges from DIFFERENT families that broadly AGREE (same score table).
function agreeingPanel(): FixtureJudge[] {
  const table: Record<string, BenchmarkRubricScore> = {
    "Good morning, Rin.": 2,
    "Yes, good morning.": 2,
  };
  return [
    makeJudge("judge-deepseek", "deepseek", scoreByText(table)),
    makeJudge("judge-qwen", "qwen", scoreByText(table)),
  ];
}

describe("runBlindJudgePanel — rubric + feed consumption, output contract", () => {
  it("scores every candidate on every rubric dimension with cited sub-4 reasoning", async () => {
    const feed = buildDecodedContextFeed(feedInput());
    const result = await runBlindJudgePanel({
      feed,
      judges: agreeingPanel(),
      panelSeed: "seed-1",
    });

    expect(result.modelFamilies).toEqual(["deepseek", "qwen"]);
    // 2 units × 3 contestants × 11 dimensions × 2 judges.
    const expectedScores = 2 * 3 * BENCHMARK_RUBRIC_DIMENSION_IDS.length * 2;
    expect(result.contestantDimensionScores.length).toBe(expectedScores);

    // Every dimension of the rubric was scored.
    const scoredDims = new Set(result.contestantDimensionScores.map((s) => s.dimensionId));
    expect([...scoredDims].sort()).toEqual([...BENCHMARK_RUBRIC_DIMENSION_IDS].sort());

    // The raw-MTL baseline got a 2 (with citation) from both judges → findings.
    const rawMtlScores = result.contestantDimensionScores.filter((s) => s.contestantId === RAW_MTL);
    expect(rawMtlScores.length).toBeGreaterThan(0);
    for (const s of rawMtlScores) {
      expect(s.score).toBe(2);
      expect(s.citation).not.toBeNull();
    }
    // A sub-4 cited score composes an itotori-lqa-1 llm_qa finding per (§4.3).
    expect(result.findings.length).toBe(rawMtlScores.length);
    for (const finding of result.findings) {
      expect(finding.detectorKind).toBe("llm_qa");
      expect(finding.systemId).toBe(RAW_MTL);
      expect(finding.rootCause).toBe("unknown_unadjudicated");
      expect(finding.evidence[0]?.summary.length).toBeGreaterThan(0);
    }
  });

  it("drops a sub-4 score with NO citation as unscorable (§4.3), no finding emitted", async () => {
    const feed = buildDecodedContextFeed(feedInput());
    // A judge that returns score 1 but omits the citation for RAW_MTL.
    const noCiteFn: FixtureJudgeScoreFn = ({ candidate }) => {
      if (
        candidate.candidateText.startsWith("Good morning") ||
        candidate.candidateText.startsWith("Yes, good")
      ) {
        return { score: 1 as BenchmarkRubricScore, citation: null };
      }
      return { score: 4 as BenchmarkRubricScore, citation: null };
    };
    const result = await runBlindJudgePanel({
      feed,
      judges: [
        makeJudge("judge-a", "deepseek", noCiteFn),
        makeJudge("judge-b", "qwen", scoreByText({})),
      ],
      panelSeed: "seed-drop",
    });

    const dropped = result.unscorable.filter((u) => u.contestantId === RAW_MTL);
    expect(dropped.length).toBeGreaterThan(0);
    for (const d of dropped) {
      expect(d.reason).toBe("missing_citation");
      expect(d.judgeId).toBe("judge-a");
    }
    // No finding was emitted for the dropped, uncited RAW_MTL scores from judge-a.
    const judgeAFindings = result.findings.filter(
      (f) => f.findingId.length > 0 && f.systemId === RAW_MTL,
    );
    // judge-b scored RAW_MTL at 4 (no finding); judge-a's 1s were dropped → 0 findings.
    expect(judgeAFindings.length).toBe(0);
  });
});

describe("§4.2 bias guards — provenance anonymization + order randomization", () => {
  it("hands the judge NO system identity (provenance stripped)", async () => {
    const feed = buildDecodedContextFeed(feedInput());
    const judges = agreeingPanel();
    await runBlindJudgePanel({ feed, judges, panelSeed: "seed-anon" });

    for (const judge of judges) {
      expect(judge.receivedInputs.length).toBe(2); // one per unit
      for (const input of judge.receivedInputs) {
        const serialized = JSON.stringify(input);
        // NONE of the real, provenance-laden contestant ids appear anywhere.
        for (const contestantId of ALL_CONTESTANTS) {
          expect(serialized).not.toContain(contestantId);
        }
        // Candidates are anonymized candidate-A/B/C labels only.
        for (const candidate of input.candidates) {
          expect(candidate.blindLabel).toMatch(/^candidate-[a-z]+$/);
        }
        // The guard itself passes for a real blinded input.
        expect(() => assertBlindJudgeInputHasNoProvenance(input, ALL_CONTESTANTS)).not.toThrow();
      }
    }
  });

  it("assertBlindJudgeInputHasNoProvenance THROWS when a system identity leaks", () => {
    const leaky: BlindJudgeUnitInput = {
      unitId: U1,
      decodedContext: {
        unitId: U1,
        speaker: "和人",
        // A leak: the real contestant id smuggled into a context string.
        sourceLine: `from ${ITOTORI_ON}: おはよう`,
        textSurface: null,
        scene: { sceneId: 2031, dispatchPosition: 1, dispatchOrderLength: 2, nextScene: 2040 },
        branch: null,
      },
      rubric: BENCHMARK_QUALITY_RUBRIC,
      candidates: [{ blindLabel: "candidate-a", candidateText: "Morning." }],
    };
    expect(() => assertBlindJudgeInputHasNoProvenance(leaky, ALL_CONTESTANTS)).toThrow(
      BlindJudgePanelError,
    );
  });

  it("randomizes contestant order PER JUDGE (different judges see different orders)", () => {
    const feed = buildDecodedContextFeed(feedInput());
    const unit = feed.find((u) => u.unitId === U1)!;
    const a = blindUnitForJudge(unit, BENCHMARK_QUALITY_RUBRIC, "judge-deepseek", "seed-x");
    const b = blindUnitForJudge(unit, BENCHMARK_QUALITY_RUBRIC, "judge-qwen", "seed-x");

    // Both are complete blindings of the SAME 3 contestants...
    expect(new Set(a.deanonymize.values())).toEqual(new Set(ALL_CONTESTANTS));
    expect(new Set(b.deanonymize.values())).toEqual(new Set(ALL_CONTESTANTS));
    // ...but the candidate-a slot maps to a DIFFERENT contestant across judges
    // (position-bias guard). At least one label→contestant mapping differs.
    const differs = ["candidate-a", "candidate-b", "candidate-c"].some(
      (label) => a.deanonymize.get(label) !== b.deanonymize.get(label),
    );
    expect(differs).toBe(true);
  });

  it("order randomization is DETERMINISTIC for a given (seed, judge, unit)", () => {
    const p1 = seededOrderPermutation("seed-y", "judge-a", U1, 5);
    const p2 = seededOrderPermutation("seed-y", "judge-a", U1, 5);
    expect(p1).toEqual(p2);
    expect([...p1].sort()).toEqual([0, 1, 2, 3, 4]);
    // A different judge yields a different permutation (with high probability).
    const p3 = seededOrderPermutation("seed-y", "judge-b", U1, 5);
    expect(p3).not.toEqual(p1);
    expect(blindLabelForIndex(0)).toBe("candidate-a");
    expect(blindLabelForIndex(2)).toBe("candidate-c");
  });
});

describe("§4.1 cross-family floor", () => {
  it("REFUSES a panel that does not span ≥2 model families", async () => {
    const feed = buildDecodedContextFeed(feedInput());
    const sameFamily = [
      makeJudge("judge-1", "deepseek", scoreByText({})),
      makeJudge("judge-2", "deepseek", scoreByText({})),
    ];
    await expect(runBlindJudgePanel({ feed, judges: sameFamily, panelSeed: "s" })).rejects.toThrow(
      /≥ 2 DIFFERENT families/,
    );
  });

  it("accepts a ≥2-family panel and reports the distinct families", async () => {
    const feed = buildDecodedContextFeed(feedInput());
    const result = await runBlindJudgePanel({ feed, judges: agreeingPanel(), panelSeed: "s" });
    expect(result.modelFamilies.length).toBeGreaterThanOrEqual(2);
  });
});

describe("§4.4 inter-judge agreement", () => {
  it("reports HIGH agreement when judges score alike, LOW when they diverge", async () => {
    const feed = buildDecodedContextFeed(feedInput());

    // Agreeing panel: identical score tables → perfect agreement.
    const agree = await runBlindJudgePanel({
      feed,
      judges: agreeingPanel(),
      panelSeed: "agree",
    });
    const adequacyAgree = agree.agreementByDimension.find((d) => d.dimensionId === "adequacy")!;
    expect(adequacyAgree.itemsScored).toBeGreaterThan(0);
    expect(adequacyAgree.normalizedAgreement).toBe(1);
    expect(adequacyAgree.exactAgreementRate).toBe(1);

    // Diverging panel: judge-a scores RAW_MTL 0, judge-b scores it 3 → low agreement.
    const diverge = await runBlindJudgePanel({
      feed,
      judges: [
        makeJudge(
          "judge-a",
          "deepseek",
          scoreByText({ "Good morning, Rin.": 0, "Yes, good morning.": 0 }),
        ),
        makeJudge(
          "judge-b",
          "qwen",
          scoreByText({ "Good morning, Rin.": 3, "Yes, good morning.": 3 }),
        ),
      ],
      panelSeed: "diverge",
    });
    const adequacyDiverge = diverge.agreementByDimension.find((d) => d.dimensionId === "adequacy")!;
    // A 3-point gap on the RAW_MTL items pulls agreement below the agreeing case.
    expect(adequacyDiverge.normalizedAgreement!).toBeLessThan(adequacyAgree.normalizedAgreement!);
    expect(adequacyDiverge.exactAgreementRate!).toBeLessThan(1);
  });
});

describe("§4.1 cost — aggregated from usage.cost only", () => {
  it("aggregates zero-cost for fixture judges (no fabricated billed amount)", async () => {
    const feed = buildDecodedContextFeed(feedInput());
    const result = await runBlindJudgePanel({ feed, judges: agreeingPanel(), panelSeed: "s" });
    expect(result.cost.totalMicrosUsd).toBe(0);
    expect(result.cost.perJudge.length).toBe(2);
    for (const judgeCost of result.cost.perJudge) {
      expect(judgeCost.costMicrosUsd).toBe(0);
      expect(judgeCost.zdr).toBe(true); // local-only posture is trivially ZDR
    }
  });
});
