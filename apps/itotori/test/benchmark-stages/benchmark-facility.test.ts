// benchmark-facility — the ONE true end-to-end composition test.
//
// This is the test the general audit found MISSING: every benchmark node passed
// its own unit tests only with HAND-BUILT single-id fixtures that bypassed the
// contestant harness. The harness keys its two downstream streams in DIFFERENT id
// spaces (judge = per-unit candidate handle; metric = per-system handle), so on
// REAL harness output §10 `buildActionableBacklog` + §9 `rankContestants` cannot
// select ONE `systemUnderTestId` matching BOTH tables — the judge ladder for the
// system under test is empty and the facility does NOT compose.
//
// Here we run REAL `runContestantHarness` output (synthetic contestants via
// fixture runners + a fixture judge — NO real LLM calls) through the whole
// `runBenchmarkFacility` driver and assert:
//   - the two blind id spaces are genuinely DISJOINT (the gap is real);
//   - the pre-fix path (raw streams → buildActionableBacklog) yields an EMPTY
//     judge ladder → this is what the missing test would have caught;
//   - the scoring-aggregation adapter reconciles BOTH streams to the real
//     `contestantKind`, so the backlog + ranking + cost-latency + meta-validity
//     all compose on a consistent identity;
//   - the judge still saw ONLY blind handles — de-anon happens at aggregation.

import { describe, expect, it } from "vitest";
import {
  FixtureJudge,
  aggregateScoring,
  buildActionableBacklog,
  buildDecodedContextFeed,
  runBenchmarkFacility,
  runBlindJudgePanel,
  runDeterministicMetricSuite,
  makeRawMtlBaselineRunner,
  type BacklogUnitScope,
  type BenchmarkFacilityInput,
  type ContestantCorpusUnit,
  type ContestantHarnessInput,
  type DeanonymizedHumanScore,
  type FixtureJudgeScoreFn,
  type GenerativeContestantRunner,
  type RobustnessSwap,
} from "../../src/benchmark-stages/index.js";
import { FakeModelProvider } from "../../src/providers/fake.js";
import type { NarrativeStructure } from "../../src/agents/structure-informed-context/index.js";

const U1 = "019ed010-0000-7000-8000-0000000000c1";
const U2 = "019ed010-0000-7000-8000-0000000000c2";

function corpus(): ContestantCorpusUnit[] {
  return [
    { unitId: U1, label: "script/prologue#line-001", sourceText: "おはよう、りん。" },
    { unitId: U2, label: "script/prologue#line-002", sourceText: "朝の光が差し込む。" },
  ];
}

/** A tagged fake-provider runner: each contestant renders `[tag] <source>` so the
 * fixture judge can score by TEXT (never by identity). Cost is the fake run's
 * zero — read verbatim, never fabricated. */
function taggedRunner(tag: string): GenerativeContestantRunner {
  const provider = new FakeModelProvider({
    providerName: `fixture-${tag}`,
    generate: (request) => {
      const last = [...request.messages].reverse().find((m) => m.role === "user");
      return `[${tag}] ${typeof last?.content === "string" ? last.content : ""}`;
    },
  });
  return makeRawMtlBaselineRunner({
    provider,
    modelId: `itotori-fake-${tag}`,
    providerId: "fake-fixture",
    targetLocale: "en-US",
    sourceLocale: "ja-JP",
    inputClassification: "synthetic_public",
  });
}

function contestantInput(): ContestantHarnessInput {
  return {
    targetLocale: "en-US",
    corpus: corpus(),
    generativeRunners: {
      raw_mtl_baseline: taggedRunner("mtl"),
      itotori_context_on: taggedRunner("ion"),
      itotori_context_off: taggedRunner("ioff"),
    },
    corpusContestants: {
      fan_edited_mtl: [
        { unitId: U1, targetText: "Morning, Rin." },
        { unitId: U2, targetText: "Morning light streams in." },
      ],
      official_localization: [
        { unitId: U1, targetText: "Good morning, Rin." },
        { unitId: U2, targetText: "The morning light pours in." },
      ],
    },
    anonymizationSalt: "facility-run-secret-2026-07-05",
  };
}

function structure(): NarrativeStructure {
  return {
    schemaVersion: "utsushi.narrative-structure.v1",
    entryScene: 2031,
    sceneDispatchOrder: [2031],
    scenes: [
      {
        sceneId: 2031,
        selectionControl: "text-window",
        nextScene: null,
        messages: [
          { order: 0, speaker: "和人", text: "おはよう、りん。", textSurface: null },
          { order: 1, speaker: null, text: "朝の光が差し込む。", textSurface: null },
        ],
        choices: [],
      },
    ],
  };
}

// The fixture judge reads the candidate TEXT (legitimate — it judges the text).
// Itotori's rendered text carries the `[ion]` fixture tag → the judge marks its
// register defective. Every other contestant scores a clean 4 (no citation).
const scoreFn: FixtureJudgeScoreFn = ({ candidate, dimensionId }) => {
  if (dimensionId === "register_politeness" && candidate.candidateText.includes("[ion]")) {
    return {
      score: 2,
      citation: {
        sourceSpan: candidate.candidateText,
        decodedContextUsed: "register on a casual line",
        rationale: "stiff register on a casual greeting",
      },
    };
  }
  return { score: 4, citation: null };
};

function judges(): FixtureJudge[] {
  return [
    new FixtureJudge({
      judgeId: "judge-deepseek",
      modelFamily: "deepseek",
      modelId: "deepseek/x",
      providerId: "deepseek-p",
      scoreFn,
    }),
    new FixtureJudge({
      judgeId: "judge-qwen",
      modelFamily: "qwen",
      modelId: "qwen/x",
      providerId: "qwen-p",
      scoreFn,
    }),
  ];
}

const UNIT_SCOPES: BacklogUnitScope[] = [
  { unitId: U1, label: "script/prologue#line-001", sceneId: "prologue", speakerId: "kazuto" },
  { unitId: U2, label: "script/prologue#line-002", sceneId: "prologue", speakerId: "narration" },
];

// The glossary forces a metric finding: the itotori text never renders "Rin"
// (it is `[ion] おはよう、りん。`), so glossary-consistency flags it.
const GLOSSARY = [{ sourceTerm: "りん", targetForm: "Rin" }];

function humanScores(): DeanonymizedHumanScore[] {
  // De-anonymized (keyed by real contestant KIND), a couple of anchor rows so the
  // §9.3 calibration leg has data to correlate. Pass/fail is not asserted — only
  // that the meta-validity harness RUNS on real harness output.
  const rows: DeanonymizedHumanScore[] = [];
  for (const unitId of [U1, U2]) {
    rows.push({
      raterId: "trevor",
      unitId,
      contestantId: "itotori_context_on",
      dimensionId: "register_politeness",
      score: 2,
      notes: null,
    });
    rows.push({
      raterId: "trevor",
      unitId,
      contestantId: "official_localization",
      dimensionId: "register_politeness",
      score: 4,
      notes: null,
    });
  }
  return rows;
}

function facilityInput(withMetaValidity: boolean): BenchmarkFacilityInput {
  const swaps: RobustnessSwap[] = [
    { swapId: "order-swap", swapKind: "order", judges: judges(), panelSeed: "alt-seed" },
    { swapId: "judge-swap", swapKind: "judge", judges: judges(), panelSeed: "seed-facility" },
  ];
  return {
    contestant: contestantInput(),
    structure: structure(),
    unitRefs: [
      { unitId: U1, sceneId: 2031, messageOrder: 0 },
      { unitId: U2, sceneId: 2031, messageOrder: 1 },
    ],
    judges: judges(),
    panelSeed: "seed-facility",
    glossary: GLOSSARY,
    canonNames: [],
    systemUnderTestKind: "itotori_context_on",
    fanMtlKind: "fan_edited_mtl",
    professionalKind: "official_localization",
    unitScopes: UNIT_SCOPES,
    ...(withMetaValidity
      ? {
          metaValidity: {
            itotoriKind: "itotori_context_on",
            fanMtlKind: "fan_edited_mtl",
            sabotage: { kinds: ["untranslated_residue", "omission"] },
            robustnessSwaps: swaps,
            baseline: { judges: judges(), panelSeed: "seed-facility" },
            humanScores: humanScores(),
          },
        }
      : {}),
  };
}

describe("runBenchmarkFacility — the whole facility composes on REAL harness output", () => {
  it("joins the per-unit judge stream + per-system metric stream to the real contestantKind", async () => {
    const result = await runBenchmarkFacility(facilityInput(true));

    // (1) The backlog is keyed to the REAL system-under-test kind + is non-empty.
    expect(result.backlog.systemUnderTestId).toBe("itotori_context_on");
    expect(result.backlog.items.length).toBeGreaterThan(0);

    // Both streams contributed failure modes for the real system under test.
    const sources = new Set(result.backlog.items.map((i) => i.signalSource));
    expect(sources.has("blind_judge_panel")).toBe(true);
    expect(sources.has("deterministic_metric")).toBe(true);

    // The judge register defect surfaced (proves the judge ladder is NON-empty).
    const register = result.backlog.items.find((i) => i.dimension === "register_politeness");
    expect(register).toBeDefined();
    expect(register!.signalSource).toBe("blind_judge_panel");
    // Every referenced finding id resolves in the adjudicated set (the re-keyed
    // judge findingIds line up with what §10 re-derives from the un-blinded score).
    const adjudicatedIds = new Set(result.backlog.adjudicatedFindings.map((f) => f.findingId));
    for (const item of result.backlog.items) {
      for (const fid of item.findingIds) {
        expect(adjudicatedIds.has(fid)).toBe(true);
      }
    }

    // (2) The ranking (the §9 meta-validity ranking primitive) is a full ladder.
    expect(result.ranking.order.length).toBe(5);
    expect(new Set(result.ranking.order)).toEqual(new Set(result.aggregated.contestantKinds));
    expect(result.ranking.order).toContain("itotori_context_on");

    // (3) Cost/latency dimensions are present + single-sourced from the harness.
    expect(result.costLatency.perSystem.length).toBe(5);
    const itotoriCost = result.costLatency.perSystem.find(
      (s) => s.contestantKind === "itotori_context_on",
    );
    expect(itotoriCost).toBeDefined();
    expect(itotoriCost!.isGenerative).toBe(true);
    expect(itotoriCost!.totalCostMicrosUsd).not.toBeNull();

    // (4) Meta-validity RAN on the real harness output (all three checks present).
    expect(result.metaValidity).not.toBeNull();
    expect(result.metaValidity!.sensitivity.check).toBe("sensitivity");
    expect(result.metaValidity!.robustness.check).toBe("robustness");
    expect(result.metaValidity!.calibration.check).toBe("calibration");
    expect(typeof result.metaValidity!.valid).toBe("boolean");
  });

  it("aggregation un-blinds BOTH streams to contestantKind (judge + metric consistent)", async () => {
    const result = await runBenchmarkFacility(facilityInput(false));
    const kinds = new Set([
      "raw_mtl_baseline",
      "fan_edited_mtl",
      "official_localization",
      "itotori_context_on",
      "itotori_context_off",
    ]);
    // Judge scores are now keyed by real contestant kind, not per-unit handles.
    for (const row of result.aggregated.judgeScores) {
      expect(kinds.has(row.contestantId)).toBe(true);
    }
    // Metric scores are now keyed by real contestant kind, not per-system handles.
    for (const row of result.aggregated.metricScores) {
      expect(kinds.has(row.systemId)).toBe(true);
    }
    // itotori_context_on appears in BOTH tables under the SAME id — the join.
    expect(result.aggregated.judgeScores.some((r) => r.contestantId === "itotori_context_on")).toBe(
      true,
    );
    expect(result.aggregated.metricScores.some((r) => r.systemId === "itotori_context_on")).toBe(
      true,
    );
  });

  it("the judge stays BLIND — de-anon happens only at aggregation, not during judging", async () => {
    const panel = judges();
    await runBenchmarkFacility({ ...facilityInput(false), judges: panel });

    for (const judge of panel) {
      expect(judge.receivedInputs.length).toBeGreaterThan(0);
      for (const input of judge.receivedInputs) {
        // The judge only ever saw `candidate-a/b/…` blind labels…
        for (const candidate of input.candidates) {
          expect(candidate.blindLabel).toMatch(/^candidate-[a-z]+$/);
        }
        // …and never a real contestant KIND anywhere in its input.
        const serialized = JSON.stringify(input);
        for (const kind of [
          "raw_mtl_baseline",
          "fan_edited_mtl",
          "official_localization",
          "itotori_context_on",
          "itotori_context_off",
        ]) {
          expect(serialized).not.toContain(kind);
        }
      }
    }
  });
});

describe("runBenchmarkFacility — the gap the missing test would have caught", () => {
  it("the two blind id spaces are DISJOINT — no single systemUnderTestId matches both", async () => {
    // Reproduce the pre-adapter path: score the REAL harness output through the
    // real panel + metric suite, then feed the RAW (un-reconciled) streams to the
    // backlog — exactly what a naive driver would do.
    const { runContestantHarness } = await import("../../src/benchmark-stages/index.js");
    const harness = await runContestantHarness(contestantInput());
    const feed = buildDecodedContextFeed({
      structure: structure(),
      unitRefs: [
        { unitId: U1, sceneId: 2031, messageOrder: 0 },
        { unitId: U2, sceneId: 2031, messageOrder: 1 },
      ],
      candidates: harness.anonymizedBundle.candidates,
    });
    const panel = await runBlindJudgePanel({ feed, judges: judges(), panelSeed: "seed-facility" });
    const metric = runDeterministicMetricSuite({
      systems: harness.anonymizedBundle.metricInputs,
      glossary: GLOSSARY,
      canonNames: [],
      startedAt: "1970-01-01T00:00:00.000Z",
      completedAt: "1970-01-01T00:00:00.000Z",
    });

    const judgeIds = new Set(panel.contestantDimensionScores.map((s) => s.contestantId));
    const metricIds = new Set(metric.scores.map((s) => s.systemId));
    // The judge (per-unit handle) and metric (per-system handle) id spaces do not
    // intersect at all — this is the structural gap.
    for (const id of judgeIds) {
      expect(metricIds.has(id)).toBe(false);
    }

    // Pre-fix: pick the metric-space handle for itotori as the systemUnderTestId
    // (the only place its metric scores live) → the JUDGE ladder is empty because
    // no judge score is keyed by a per-system handle. The facility does NOT compose.
    const itotoriSystemHandle = harness.deanonymizationKey.systems.find(
      (s) => s.contestantKind === "itotori_context_on",
    )!.systemHandle;
    const preFix = buildActionableBacklog({
      systemUnderTestId: itotoriSystemHandle,
      fanMtlSystemId: harness.deanonymizationKey.systems.find(
        (s) => s.contestantKind === "fan_edited_mtl",
      )!.systemHandle,
      professionalSystemId: harness.deanonymizationKey.systems.find(
        (s) => s.contestantKind === "official_localization",
      )!.systemHandle,
      judgeScores: panel.contestantDimensionScores,
      judgeFindings: panel.findings,
      metricScores: metric.scores,
      metricFindings: metric.findings,
      unitScopes: UNIT_SCOPES,
    });
    const preFixJudgeItems = preFix.items.filter((i) => i.signalSource === "blind_judge_panel");
    expect(preFixJudgeItems.length).toBe(0);

    // Post-fix: the SAME streams, reconciled by the adapter, DO compose — a judge
    // failure mode appears for the real system-under-test kind.
    const aggregated = aggregateScoring({
      deanonymizationKey: harness.deanonymizationKey,
      judgeScores: panel.contestantDimensionScores,
      judgeFindings: panel.findings,
      metricScores: metric.scores,
      metricFindings: metric.findings,
    });
    const postFix = buildActionableBacklog({
      systemUnderTestId: "itotori_context_on",
      fanMtlSystemId: "fan_edited_mtl",
      professionalSystemId: "official_localization",
      judgeScores: aggregated.judgeScores,
      judgeFindings: aggregated.judgeFindings,
      metricScores: aggregated.metricScores,
      metricFindings: aggregated.metricFindings,
      unitScopes: UNIT_SCOPES,
    });
    const postFixJudgeItems = postFix.items.filter((i) => i.signalSource === "blind_judge_panel");
    expect(postFixJudgeItems.length).toBeGreaterThan(0);
  });
});
