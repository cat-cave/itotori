// benchmark-actionable-backlog-output (§10) — deterministic unit tests.
//
// Proves the §10 primary artifact. The backlog CONSUMES two real upstream
// streams — the §3 deterministic metric suite (`runDeterministicMetricSuite`)
// and the §4 blind judge panel (`runBlindJudgePanel` with fixture judges, NO
// real LLM calls) — and turns them into:
//   (§10.1) per-failure-mode findings, each tied to a CAUSE + FIX-CANDIDATE with
//           cited evidence (the judge stream's `unknown_unadjudicated` root cause
//           is adjudicated here);
//   (§10.2) a ranking ladder (trailing fan-MTL → top; trailing pro → backlog;
//           beating fan-MTL / matching pro → regression protection);
//   (§10.3) routable DAG findings/nodes + per-dimension regression telemetry.
// Everything is a pure function of synthetic input — same input → identical out.

import { describe, expect, it } from "vitest";
import { LOCALIZATION_ROOT_CAUSES } from "@itotori/localization-bridge-schema";
import {
  FixtureJudge,
  buildActionableBacklog,
  buildDecodedContextFeed,
  runBlindJudgePanel,
  runDeterministicMetricSuite,
  type ActionableBacklogInput,
  type BacklogSignalScore,
  type BacklogUnitScope,
  type ContestantCandidate,
  type DecodedContextFeedInput,
  type FixtureJudgeScoreFn,
  type MetricSystemInput,
} from "../../src/benchmark-stages/index.js";
import type { NarrativeStructure } from "../../src/agents/structure-informed-context/index.js";

// ── contestant ids ────────────────────────────────────────────────────────────
const ITOTORI = "itotori-context-on"; // the system under test.
const FAN = "fan-edited-mtl";
const PRO = "official-en";
const ALL = [ITOTORI, FAN, PRO];

// ── judge units (scene / speaker scope) ─────────────────────────────────────────
const U1 = "019ed010-0000-7000-8000-0000000000a1"; // scene casual-01, speaker rin
const U2 = "019ed010-0000-7000-8000-0000000000a2"; // scene casual-01, speaker rin
const U3 = "019ed010-0000-7000-8000-0000000000a3"; // scene formal-02, speaker kaho

// ── metric units (itotori misses a glossary term on the casual scene) ───────────
const MU_IT = "019ed010-0000-7000-8000-0000000000b1";
const MU_FAN = "019ed010-0000-7000-8000-0000000000b2";
const MU_PRO = "019ed010-0000-7000-8000-0000000000b3";

function structure(): NarrativeStructure {
  return {
    schemaVersion: "utsushi.narrative-structure.v1",
    entryScene: 100,
    sceneDispatchOrder: [100, 200],
    scenes: [
      {
        sceneId: 100,
        selectionControl: "text-window",
        nextScene: 200,
        messages: [
          { order: 0, speaker: "りん", text: "おはよう。", textSurface: null },
          { order: 1, speaker: "りん", text: "いこう。", textSurface: null },
        ],
        choices: [],
      },
      {
        sceneId: 200,
        selectionControl: "none",
        nextScene: null,
        messages: [{ order: 0, speaker: "かほ", text: "こんにちは。", textSurface: null }],
        choices: [],
      },
    ],
  };
}

// Per (unit, contestant) UNIQUE candidate text so the fixture judge can score
// each cell independently (it is keyed on candidate text, not unit id).
const TEXT: Record<string, Record<string, string>> = {
  [U1]: { [ITOTORI]: "it-u1", [FAN]: "fan-u1", [PRO]: "pro-u1" },
  [U2]: { [ITOTORI]: "it-u2", [FAN]: "fan-u2", [PRO]: "pro-u2" },
  [U3]: { [ITOTORI]: "it-u3", [FAN]: "fan-u3", [PRO]: "pro-u3" },
};

function candidates(): ContestantCandidate[] {
  const out: ContestantCandidate[] = [];
  for (const unitId of [U1, U2, U3]) {
    for (const contestantId of ALL) {
      out.push({ contestantId, unitId, candidateText: TEXT[unitId]![contestantId]! });
    }
  }
  return out;
}

function feedInput(): DecodedContextFeedInput {
  return {
    structure: structure(),
    unitRefs: [
      { unitId: U1, sceneId: 100, messageOrder: 0 },
      { unitId: U2, sceneId: 100, messageOrder: 1 },
      { unitId: U3, sceneId: 200, messageOrder: 0 },
    ],
    candidates: candidates(),
  };
}

// Per-dimension score table by candidate text; anything absent scores 4.
//   register: itotori 2 on casual-scene lines → trails fan(4)/pro(4)  → top_priority
//   fluency:  itotori 3 on U3; fan 2 everywhere; pro 4 → beats fan, below pro → backlog
//   voice:    itotori 3 on U1(rin); fan 2; pro 3 → beats fan, matches pro → regression
const JUDGE_TABLE: Record<string, Record<string, number>> = {
  register_politeness: { "it-u1": 2, "it-u2": 2 },
  fluency: { "it-u3": 3, "fan-u1": 2, "fan-u2": 2, "fan-u3": 2 },
  character_voice_consistency: {
    "it-u1": 3,
    "fan-u1": 2,
    "fan-u2": 2,
    "fan-u3": 2,
    "pro-u1": 3,
    "pro-u2": 3,
    "pro-u3": 3,
  },
};

const scoreFn: FixtureJudgeScoreFn = ({ candidate, dimensionId }) => {
  const score = (JUDGE_TABLE[dimensionId]?.[candidate.candidateText] ?? 4) as 0 | 1 | 2 | 3 | 4;
  return {
    score,
    citation:
      score < 4
        ? {
            sourceSpan: candidate.candidateText,
            decodedContextUsed: `dim ${dimensionId}`,
            rationale: `${dimensionId} scored ${score} for ${candidate.candidateText}`,
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

function metricSystem(systemId: string, unitId: string, targetText: string): MetricSystemInput {
  return {
    systemId,
    systemKind: "deterministic_fixture",
    units: [{ unitId, label: "casual/line-001", sourceText: "剣を持つ。", targetText }],
  };
}

function metricSuite() {
  return runDeterministicMetricSuite({
    systems: [
      // itotori MISSES the glossary term; fan + pro render it → itotori trails both.
      metricSystem(ITOTORI, MU_IT, "He holds the sword."),
      metricSystem(FAN, MU_FAN, "He holds the Longblade."),
      metricSystem(PRO, MU_PRO, "He holds the Longblade."),
    ],
    glossary: [{ sourceTerm: "剣", targetForm: "Longblade" }],
    canonNames: [],
    startedAt: "2026-07-05T00:00:00.000Z",
    completedAt: "2026-07-05T00:00:01.000Z",
  });
}

const UNIT_SCOPES: BacklogUnitScope[] = [
  { unitId: U1, label: "casual/line-001", sceneId: "casual-01", speakerId: "rin" },
  { unitId: U2, label: "casual/line-002", sceneId: "casual-01", speakerId: "rin" },
  { unitId: U3, label: "formal/line-001", sceneId: "formal-02", speakerId: "kaho" },
  { unitId: MU_IT, label: "casual/line-001", sceneId: "casual-01" },
];

async function buildInput(priorRun?: {
  perSignalScores: BacklogSignalScore[];
}): Promise<ActionableBacklogInput> {
  const feed = buildDecodedContextFeed(feedInput());
  const judge = await runBlindJudgePanel({ feed, judges: panel(), panelSeed: "seed-backlog" });
  const metrics = metricSuite();
  return {
    systemUnderTestId: ITOTORI,
    fanMtlSystemId: FAN,
    professionalSystemId: PRO,
    judgeScores: judge.contestantDimensionScores,
    judgeFindings: judge.findings,
    metricScores: metrics.scores,
    metricFindings: metrics.findings,
    unitScopes: UNIT_SCOPES,
    ...(priorRun !== undefined ? { priorRun } : {}),
  };
}

describe("buildActionableBacklog — §10.1 failure-mode decomposition", () => {
  it("decomposes metric + judge findings into failure modes with cause, fix, and cited evidence", async () => {
    const backlog = buildActionableBacklog(await buildInput());

    // Four distinct failure modes: three judge dimensions + one metric (glossary).
    expect(backlog.items.length).toBe(4);

    for (const item of backlog.items) {
      // Every failure mode carries a cause (real, not unadjudicated), a fix, and evidence.
      expect(LOCALIZATION_ROOT_CAUSES).toContain(item.cause);
      expect(item.cause).not.toBe("unknown_unadjudicated");
      expect(item.fixCandidate.length).toBeGreaterThan(0);
      expect(item.evidence.length).toBeGreaterThan(0);
      for (const cite of item.evidence) {
        expect(cite.findingId.length).toBeGreaterThan(0);
        expect(cite.rationale.length).toBeGreaterThan(0);
      }
      // Every referenced finding id resolves in the adjudicated set (routable).
      const ids = new Set(backlog.adjudicatedFindings.map((f) => f.findingId));
      for (const fid of item.findingIds) {
        expect(ids.has(fid)).toBe(true);
      }
    }

    // The register failure mode (judge stream): adjudicated cause, casual-scene scope.
    const register = backlog.items.find((i) => i.dimension === "register_politeness");
    expect(register).toBeDefined();
    expect(register!.signalSource).toBe("blind_judge_panel");
    expect(register!.causeAdjudicated).toBe(true);
    expect(register!.cause).toBe("style_guide_gap");
    expect(register!.scope.scopeKind).toBe("scene");
    expect(register!.scope.scopeId).toBe("casual-01");
    expect(register!.scope.unitCount).toBe(2);

    // The glossary failure mode (metric stream): PRESERVED (not re-adjudicated) cause.
    const glossary = backlog.items.find((i) => i.signalSource === "deterministic_metric");
    expect(glossary).toBeDefined();
    expect(glossary!.causeAdjudicated).toBe(false);
    expect(glossary!.cause).toBe("glossary_policy_gap");
    expect(glossary!.dimension).toBe("terminology");

    // A long-range dimension (voice) buckets by SPEAKER, not scene.
    const voice = backlog.items.find((i) => i.dimension === "character_voice_consistency");
    expect(voice!.scope.scopeKind).toBe("speaker");
    expect(voice!.scope.scopeId).toBe("rin");
  });

  it("adjudicates the judge stream's unknown root cause into the composed findings", async () => {
    const input = await buildInput();
    // The raw judge findings are honestly unadjudicated (§4).
    for (const f of input.judgeFindings) {
      expect(f.rootCause).toBe("unknown_unadjudicated");
      expect(f.adjudicationState).toBe("unreviewed");
    }
    const backlog = buildActionableBacklog(input);
    // Every judge (llm_qa) finding is adjudicated to a real cause + confirmed.
    const llmFindings = backlog.adjudicatedFindings.filter((f) => f.detectorKind === "llm_qa");
    expect(llmFindings.length).toBe(input.judgeFindings.length);
    for (const f of llmFindings) {
      expect(f.rootCause).not.toBe("unknown_unadjudicated");
      expect(f.adjudicationState).toBe("confirmed");
    }
    // The metric findings pass through verbatim (already adjudicated).
    const metricFindings = backlog.adjudicatedFindings.filter(
      (f) => f.detectorKind === "deterministic_qa",
    );
    expect(metricFindings.length).toBe(input.metricFindings.length);
  });
});

describe("buildActionableBacklog — §10.2 ranking ladder", () => {
  it("ranks by the fan-MTL / pro ladder and orders top priority first", async () => {
    const backlog = buildActionableBacklog(await buildInput());

    const rankOf = (dim: string) => backlog.items.find((i) => i.dimension === dim)!.rank;
    // Trailing even fan-MTL → top priority (a blind spot).
    expect(rankOf("register_politeness")).toBe("top_priority");
    // Trailing pro but beating fan-MTL → improvement backlog.
    expect(rankOf("fluency")).toBe("improvement_backlog");
    // Beating fan-MTL / matching pro → regression protection.
    expect(rankOf("character_voice_consistency")).toBe("regression_protection");
    // The metric glossary blind spot (itotori 0 vs fan/pro 1.0) → top priority.
    expect(rankOf("terminology")).toBe("top_priority");

    // Ladder comparison is recorded with the real scores.
    const register = backlog.items.find((i) => i.dimension === "register_politeness")!;
    expect(register.ladder.scale).toBe("judge_mean_0_4");
    expect(register.ladder.beatsFanMtl).toBe(false);

    // Counts + ordering: two top-priority items sort before the rest.
    expect(backlog.countsByRank.top_priority).toBe(2);
    expect(backlog.countsByRank.improvement_backlog).toBe(1);
    expect(backlog.countsByRank.regression_protection).toBe(1);
    expect(backlog.items[0]!.rank).toBe("top_priority");
    expect(backlog.items[3]!.rank).toBe("regression_protection");
    backlog.items.forEach((item, index) => expect(item.priorityOrder).toBe(index));
  });
});

describe("buildActionableBacklog — §10.3 DAG emission + regression telemetry", () => {
  it("emits one routable DAG node per ranked failure mode, findings resolvable", async () => {
    const backlog = buildActionableBacklog(await buildInput());
    expect(backlog.dag.nodes.length).toBe(backlog.items.length);

    const nodeIds = new Set<string>();
    for (const node of backlog.dag.nodes) {
      expect(node.nodeId.length).toBeGreaterThan(0);
      nodeIds.add(node.nodeId);
      expect(node.findingIds.length).toBeGreaterThan(0);
    }
    // Node ids are distinct and match the backlog items.
    expect(nodeIds.size).toBe(backlog.items.length);
    // The DAG findings are exactly the ones the nodes reference.
    const referenced = new Set(backlog.dag.nodes.flatMap((n) => n.findingIds));
    expect(new Set(backlog.dag.findings.map((f) => f.findingId))).toEqual(referenced);
  });

  it("reports per-dimension regression deltas across runs", async () => {
    // A prior run: register was HIGHER (0.9), fluency LOWER (0.5), glossary the same (0.0).
    const prior: BacklogSignalScore[] = [
      { signalSource: "blind_judge_panel", key: "register_politeness", label: "", score: 0.9 },
      { signalSource: "blind_judge_panel", key: "fluency", label: "", score: 0.5 },
      { signalSource: "deterministic_metric", key: "glossary-consistency", label: "", score: 0 },
    ];
    const backlog = buildActionableBacklog(await buildInput({ perSignalScores: prior }));

    const dirOf = (source: string, key: string) =>
      backlog.perDimensionRegression.find((r) => r.signalSource === source && r.key === key)!;

    expect(dirOf("blind_judge_panel", "register_politeness").direction).toBe("regressed");
    expect(dirOf("blind_judge_panel", "fluency").direction).toBe("improved");
    expect(dirOf("deterministic_metric", "glossary-consistency").direction).toBe("unchanged");
    // A dimension with no prior score is telemetried as "new".
    expect(dirOf("blind_judge_panel", "adequacy").direction).toBe("new");

    // The regression datum is attached to the matching backlog item's regression_ref.
    const register = backlog.items.find((i) => i.dimension === "register_politeness")!;
    expect(register.regressionRef?.direction).toBe("regressed");
    expect(register.regressionRef?.priorScore).toBe(0.9);

    // This run's per-signal scores round-trip as the next run's prior.
    const keys = backlog.perSignalScores.map((s) => `${s.signalSource}::${s.key}`);
    expect(keys).toContain("blind_judge_panel::register_politeness");
    expect(keys).toContain("deterministic_metric::glossary-consistency");
  });

  it("is a pure function — identical input yields byte-identical backlog", async () => {
    const a = buildActionableBacklog(await buildInput());
    const b = buildActionableBacklog(await buildInput());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
