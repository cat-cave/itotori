// benchmark-blind-judge-panel — the subjective scoring layer (§4).
//
// Methodology §4 (docs/itotori-translation-benchmark-methodology.md): multiple
// LLM judges, BLIND, CROSS-FAMILY, scoring each anonymized contestant candidate
// against the quality rubric (§2) per dimension WITH cited reasoning (§4.3), and
// reporting inter-judge agreement (§4.4). This module is the panel ORCHESTRATOR
// and its bias guards; the JUDGE itself is abstracted behind `BlindJudgeAdapter`
// so a deterministic FIXTURE judge drives the unit tests while the real
// ZDR-routed multi-family path (blind-judge-zdr-adapter.ts) plugs into the same
// seam. Nothing here makes a network call.
//
// What this module OWNS (per §4):
//   - §4.1 composition guard: ≥2 (target ≥3) judges from DIFFERENT model
//     families; every judge declares its (modelId, providerId) pair and its
//     family. A panel below the family floor is REFUSED.
//   - §4.2 blinding + bias guards: provenance anonymization (a judge never sees
//     a system identity — candidates are relabelled `candidate-A/B/C/…`) and
//     per-judge, per-unit order randomization (seeded, so tests are
//     deterministic yet each judge sees a different order → position bias
//     defused). The de-anonymization map is kept ONLY on the panel side.
//   - §5 feed consumption: the panel consumes the `JudgeUnitInput[]` from
//     `buildDecodedContextFeed` (equal decoded ground truth per unit) and the
//     `BENCHMARK_QUALITY_RUBRIC` artifact, passing BOTH to every judge equally.
//   - §4.3 output contract: per unit per candidate per dimension a 0–4 score +
//     cited reasoning `{ sourceSpan, decodedContextUsed, rationale }`; a sub-4
//     score WITHOUT a complete citation is DROPPED as unscorable. Judge findings
//     are emitted in the `itotori-lqa-1` finding shape (`detectorKind: llm_qa`).
//   - §4.1 cost: judge cost is aggregated from the REAL provider `usage.cost`
//     carried on each judge's `ProviderRunRecord` — never approximated.
//   - §4.4 inter-judge agreement: per-dimension agreement across judges.

import {
  BENCHMARK_QUALITY_RUBRIC,
  BENCHMARK_RUBRIC_CITATION_REQUIRED_BELOW_SCORE,
  assertBenchmarkQualityRubric,
  benchmarkRubricQualitySeverityForScore,
  benchmarkRubricTaxonomyTargetForDimension,
  type BenchmarkFindingRecordV02,
  type BenchmarkQualityRubric,
  type BenchmarkRubricDimensionId,
  type BenchmarkRubricScore,
} from "@itotori/localization-bridge-schema";
import { assertBilledCost } from "../providers/cost.js";
import type { ProviderRunRecord } from "../providers/types.js";
import { deterministicUuid7, sha256Hex } from "./ids.js";
import type { DecodedGroundTruthContext, JudgeUnitInput } from "./decoded-context-feed.js";

const TAXONOMY_ID = "itotori-lqa-1" as const;
const TAXONOMY_VERSION = "itotori-quality-taxonomy-0.1.0" as const;

/** §4.1 — the mandatory model-family floor (≥2). ≥3 is the target when routable. */
export const BLIND_JUDGE_MIN_MODEL_FAMILIES = 2;

export class BlindJudgePanelError extends Error {
  constructor(detail: string) {
    super(`blind-judge-panel refused: ${detail}`);
    this.name = "BlindJudgePanelError";
  }
}

// ---------------------------------------------------------------------------
// §4.3 output contract — score + cited reasoning.
// ---------------------------------------------------------------------------

/**
 * §4.3 cited reasoning: the actionable deliverable attached to a score. All
 * three parts are required and non-empty; a sub-4 score whose citation is
 * missing or incomplete is dropped as unscorable (§2.1 / §4.3).
 */
export type JudgeCitation = {
  /** The cited source span the judgment is about (from the decoded source line). */
  sourceSpan: string;
  /** Which decoded ground-truth context (speaker/scene/branch) informed the call. */
  decodedContextUsed: string;
  /** The judge's rationale for the score. */
  rationale: string;
};

/** One dimension's 0–4 score for one candidate, with its §4.3 citation (or null). */
export type JudgeDimensionScore = {
  dimensionId: BenchmarkRubricDimensionId;
  score: BenchmarkRubricScore;
  /** Required for a sub-4 score (§2.1); may be null for a 4 (no defect → no cite). */
  citation: JudgeCitation | null;
};

/** One judge's scoring of ONE anonymized candidate (keyed by BLIND label only). */
export type JudgeCandidateScoring = {
  /** The anonymized `candidate-A/B/…` label — NEVER a system identity. */
  blindLabel: string;
  dimensions: JudgeDimensionScore[];
};

/** One judge's scoring of one unit's blinded candidate set, with real cost. */
export type JudgeUnitScoring = {
  unitId: string;
  candidates: JudgeCandidateScoring[];
  /** The REAL provider run for this judge call — the sole cost source (§4.1). */
  providerRun: ProviderRunRecord;
};

// ---------------------------------------------------------------------------
// §4.2 blinding — the judge only ever sees this (no system identity).
// ---------------------------------------------------------------------------

/** One anonymized candidate as the judge sees it — blind label + text ONLY. */
export type BlindCandidate = {
  blindLabel: string;
  candidateText: string;
};

/**
 * The per-unit input handed to a `BlindJudgeAdapter`. It carries the shared
 * decoded ground truth (§5), the rubric (§2), and the anonymized candidates in a
 * RANDOMIZED order (§4.2) — and, by construction, NO contestant/system identity.
 * `assertBlindJudgeInputHasNoProvenance` proves that in the test path.
 */
export type BlindJudgeUnitInput = {
  unitId: string;
  decodedContext: DecodedGroundTruthContext;
  rubric: BenchmarkQualityRubric;
  candidates: BlindCandidate[];
};

/**
 * The judge behind the panel. Implemented by a deterministic FIXTURE judge in
 * tests and by the real ZDR ModelProvider-backed adapter on the live path. The
 * adapter receives ONLY `BlindJudgeUnitInput` (no provenance) and returns scores
 * keyed by blind label — it can never learn which system produced a candidate.
 */
export interface BlindJudgeAdapter {
  readonly judgeId: string;
  readonly modelId: string;
  readonly providerId: string;
  /** §4.1 cross-family axis — the distinct model family (e.g. `deepseek`, `qwen`). */
  readonly modelFamily: string;
  scoreUnit(input: BlindJudgeUnitInput): Promise<JudgeUnitScoring>;
}

// ---------------------------------------------------------------------------
// §4.2 — provenance-anonymization guard (test-provable).
// ---------------------------------------------------------------------------

/**
 * Asserts a judge input leaks NO system identity: no field carries a real
 * contestant id, and (defensively) the blind labels are the `candidate-…`
 * shape. Throws `BlindJudgePanelError` on any leak. The panel runs this on
 * every input before a judge sees it; the test path also calls it directly to
 * prove the guard bites.
 */
export function assertBlindJudgeInputHasNoProvenance(
  input: BlindJudgeUnitInput,
  realContestantIds: readonly string[],
): void {
  const serialized = JSON.stringify({
    unitId: input.unitId,
    decodedContext: input.decodedContext,
    candidates: input.candidates,
  });
  for (const contestantId of realContestantIds) {
    if (contestantId.length > 0 && serialized.includes(contestantId)) {
      throw new BlindJudgePanelError(
        `unit '${input.unitId}' judge input leaks contestant/system identity '${contestantId}' (provenance must be anonymized per §4.2)`,
      );
    }
  }
  for (const candidate of input.candidates) {
    if (!/^candidate-[a-z]+$/u.test(candidate.blindLabel)) {
      throw new BlindJudgePanelError(
        `unit '${input.unitId}' candidate carries a non-anonymized label '${candidate.blindLabel}'`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// §4.2 — seeded order randomization (deterministic for tests, varied per judge).
// ---------------------------------------------------------------------------

/** A deterministic 32-bit PRNG (mulberry32) so shuffles are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 32-bit FNV-1a hash of a string — the seed material for the per-call PRNG. */
function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * A Fisher-Yates permutation of `[0..n)` seeded from `(panelSeed, judgeId,
 * unitId)`. Deterministic (tests reproduce it) yet different per judge (so each
 * judge sees a different contestant order — §4.2 position-bias guard).
 */
export function seededOrderPermutation(
  panelSeed: string,
  judgeId: string,
  unitId: string,
  count: number,
): number[] {
  const rng = mulberry32(fnv1a32(`${panelSeed} ${judgeId} ${unitId}`));
  const order = Array.from({ length: count }, (_, i) => i);
  for (let i = count - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = order[i]!;
    order[i] = order[j]!;
    order[j] = tmp;
  }
  return order;
}

const BLIND_LABEL_ALPHABET = "abcdefghijklmnopqrstuvwxyz";

/** `0 -> candidate-a`, `25 -> candidate-z`, `26 -> candidate-aa`, … */
export function blindLabelForIndex(index: number): string {
  let n = index;
  let label = "";
  do {
    label = BLIND_LABEL_ALPHABET[n % 26]! + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return `candidate-${label}`;
}

/** The blinding of one unit for one judge: the blind input + the de-anon map. */
export type BlindedUnitForJudge = {
  input: BlindJudgeUnitInput;
  /** blindLabel → real contestant id. Kept ONLY on the panel side. */
  deanonymize: Map<string, string>;
};

/**
 * Blind one unit for one judge: strip provenance, randomize order (§4.2), and
 * relabel candidates `candidate-A/B/…` in the shuffled order. Returns the
 * judge-facing input plus the panel-only de-anonymization map.
 */
export function blindUnitForJudge(
  unit: JudgeUnitInput,
  rubric: BenchmarkQualityRubric,
  judgeId: string,
  panelSeed: string,
): BlindedUnitForJudge {
  const permutation = seededOrderPermutation(
    panelSeed,
    judgeId,
    unit.unitId,
    unit.candidates.length,
  );
  const deanonymize = new Map<string, string>();
  const candidates: BlindCandidate[] = permutation.map((sourceIndex, position) => {
    const source = unit.candidates[sourceIndex]!;
    const blindLabel = blindLabelForIndex(position);
    deanonymize.set(blindLabel, source.contestantId);
    return { blindLabel, candidateText: source.candidateText };
  });
  return {
    input: { unitId: unit.unitId, decodedContext: unit.decodedContext, rubric, candidates },
    deanonymize,
  };
}

// ---------------------------------------------------------------------------
// §4.4 inter-judge agreement.
// ---------------------------------------------------------------------------

/** Per-dimension inter-judge agreement (§4.4). */
export type DimensionAgreement = {
  dimensionId: BenchmarkRubricDimensionId;
  /** Items (unit × contestant) at least two judges scored on this dimension. */
  itemsScored: number;
  /** Number of judge PAIRS that co-scored at least one item. */
  judgePairCount: number;
  /** Mean pairwise |Δscore| over co-scored items (0 = perfect, 4 = maximal). */
  meanPairwiseAbsDiff: number | null;
  /** `1 − meanPairwiseAbsDiff/4` — bounded [0,1]; null when no item is co-scored. */
  normalizedAgreement: number | null;
  /** Fraction of co-scored item-pairs with identical scores. */
  exactAgreementRate: number | null;
};

/**
 * Compute per-dimension inter-judge agreement (§4.4) from the de-anonymized
 * per-judge scores. Agreement is measured over ITEMS = (unitId, contestantId);
 * an item counts only where ≥2 judges gave it a (retained) score on that
 * dimension. Low agreement is itself a §4.4 diagnostic — reported, never hidden.
 */
export function interJudgeAgreementByDimension(
  scoresByDimension: ReadonlyMap<
    BenchmarkRubricDimensionId,
    ReadonlyArray<{ itemKey: string; judgeId: string; score: number }>
  >,
): DimensionAgreement[] {
  const out: DimensionAgreement[] = [];
  for (const [dimensionId, rows] of scoresByDimension) {
    const byItem = new Map<string, Array<{ judgeId: string; score: number }>>();
    for (const row of rows) {
      const list = byItem.get(row.itemKey) ?? [];
      list.push({ judgeId: row.judgeId, score: row.score });
      byItem.set(row.itemKey, list);
    }
    let itemsScored = 0;
    let pairTotal = 0;
    let absDiffSum = 0;
    let exactMatches = 0;
    const judgePairs = new Set<string>();
    for (const scores of byItem.values()) {
      if (scores.length < 2) {
        continue;
      }
      itemsScored += 1;
      for (let i = 0; i < scores.length; i += 1) {
        for (let j = i + 1; j < scores.length; j += 1) {
          const a = scores[i]!;
          const b = scores[j]!;
          pairTotal += 1;
          const diff = Math.abs(a.score - b.score);
          absDiffSum += diff;
          if (diff === 0) {
            exactMatches += 1;
          }
          judgePairs.add([a.judgeId, b.judgeId].sort().join(" "));
        }
      }
    }
    const meanAbsDiff = pairTotal === 0 ? null : absDiffSum / pairTotal;
    out.push({
      dimensionId,
      itemsScored,
      judgePairCount: judgePairs.size,
      meanPairwiseAbsDiff: meanAbsDiff === null ? null : round(meanAbsDiff),
      normalizedAgreement: meanAbsDiff === null ? null : round(1 - meanAbsDiff / 4),
      exactAgreementRate: pairTotal === 0 ? null : round(exactMatches / pairTotal),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The panel orchestrator.
// ---------------------------------------------------------------------------

export type BlindJudgePanelInput = {
  /** §5 feed — one entry per unit, equal decoded context across candidates. */
  feed: JudgeUnitInput[];
  /** The judges (adapters). Must span ≥ `minModelFamilies` distinct families. */
  judges: BlindJudgeAdapter[];
  /** §2 rubric artifact. Defaults to the frozen `BENCHMARK_QUALITY_RUBRIC`. */
  rubric?: BenchmarkQualityRubric;
  /** Deterministic seed for the §4.2 order randomization. */
  panelSeed: string;
  /** §4.1 family floor (default {@link BLIND_JUDGE_MIN_MODEL_FAMILIES}). */
  minModelFamilies?: number;
};

/** One (unit, contestant, dimension) score with the judge that gave it (§4.3). */
export type ContestantDimensionScore = {
  unitId: string;
  contestantId: string;
  dimensionId: BenchmarkRubricDimensionId;
  judgeId: string;
  score: BenchmarkRubricScore;
  citation: JudgeCitation | null;
};

/** A score dropped as unscorable (sub-4 without a complete citation, §4.3). */
export type UnscorableDrop = {
  unitId: string;
  contestantId: string;
  dimensionId: BenchmarkRubricDimensionId;
  judgeId: string;
  score: BenchmarkRubricScore;
  reason: "missing_citation";
};

export type JudgeCostRecord = {
  judgeId: string;
  modelId: string;
  providerId: string;
  costMicrosUsd: number;
  /** The wire ZDR flag from the judge's provider run (§4.1). */
  zdr: boolean;
};

export type BlindJudgePanelResult = {
  panelSeed: string;
  judges: Array<{ judgeId: string; modelId: string; providerId: string; modelFamily: string }>;
  /** Distinct model families on the panel (§4.1 cross-family). */
  modelFamilies: string[];
  /** Retained per-(unit,contestant,dimension) scores (§4.3 output contract). */
  contestantDimensionScores: ContestantDimensionScore[];
  /** Scores dropped as unscorable (§4.3). */
  unscorable: UnscorableDrop[];
  /** §4.4 inter-judge agreement per dimension. */
  agreementByDimension: DimensionAgreement[];
  /** §4.3 judge findings in the itotori-lqa-1 shape (detectorKind: llm_qa). */
  findings: BenchmarkFindingRecordV02[];
  /** §4.1 real judge cost, aggregated from usage.cost only. */
  cost: { totalMicrosUsd: number; perJudge: JudgeCostRecord[] };
  /**
   * §4.2 blinding audit: for each (judge, unit), the blind→real map plus the
   * fact the judge input carried no provenance. Proof the guards ran.
   */
  blindingAudit: Array<{
    judgeId: string;
    unitId: string;
    deanonymize: Record<string, string>;
    provenanceStripped: true;
  }>;
};

export async function runBlindJudgePanel(
  input: BlindJudgePanelInput,
): Promise<BlindJudgePanelResult> {
  const rubric = input.rubric ?? BENCHMARK_QUALITY_RUBRIC;
  assertBenchmarkQualityRubric(rubric);

  if (input.feed.length === 0) {
    throw new BlindJudgePanelError("no units in the judge feed");
  }
  if (input.judges.length === 0) {
    throw new BlindJudgePanelError("no judges on the panel");
  }

  // §4.1 cross-family guard — ≥ minModelFamilies DISTINCT families.
  const minFamilies = input.minModelFamilies ?? BLIND_JUDGE_MIN_MODEL_FAMILIES;
  const judgeIds = new Set<string>();
  for (const judge of input.judges) {
    if (judgeIds.has(judge.judgeId)) {
      throw new BlindJudgePanelError(`duplicate judge id '${judge.judgeId}'`);
    }
    judgeIds.add(judge.judgeId);
  }
  const families = [...new Set(input.judges.map((j) => j.modelFamily))].sort();
  if (families.length < minFamilies) {
    throw new BlindJudgePanelError(
      `panel spans ${families.length} model family/ies (${families.join(", ") || "none"}); §4.1 requires ≥ ${minFamilies} DIFFERENT families`,
    );
  }

  const realContestantIdsByUnit = new Map<string, string[]>();
  for (const unit of input.feed) {
    realContestantIdsByUnit.set(
      unit.unitId,
      unit.candidates.map((c) => c.contestantId),
    );
  }
  const allContestantIds = [
    ...new Set(input.feed.flatMap((u) => u.candidates.map((c) => c.contestantId))),
  ];

  const contestantDimensionScores: ContestantDimensionScore[] = [];
  const unscorable: UnscorableDrop[] = [];
  const findings: BenchmarkFindingRecordV02[] = [];
  const perJudgeCost: JudgeCostRecord[] = [];
  const blindingAudit: BlindJudgePanelResult["blindingAudit"] = [];
  // dimension → rows for the agreement computation.
  const scoresByDimension = new Map<
    BenchmarkRubricDimensionId,
    Array<{ itemKey: string; judgeId: string; score: number }>
  >();

  for (const judge of input.judges) {
    let judgeCostMicros = 0n;
    let judgeZdr = true;

    for (const unit of input.feed) {
      const blinded = blindUnitForJudge(unit, rubric, judge.judgeId, input.panelSeed);
      // §4.2 — prove NO provenance reaches the judge before it is invoked.
      assertBlindJudgeInputHasNoProvenance(blinded.input, allContestantIds);

      const scoring = await judge.scoreUnit(blinded.input);
      if (scoring.unitId !== unit.unitId) {
        throw new BlindJudgePanelError(
          `judge '${judge.judgeId}' returned scoring for unit '${scoring.unitId}', expected '${unit.unitId}'`,
        );
      }

      // §4.1 — cost from the REAL provider run only (usage.cost), never approximated.
      const run = scoring.providerRun;
      judgeCostMicros += assertBilledCost(run.cost);
      if (run.routingPosture.zdr !== true) {
        judgeZdr = false;
      }

      const scoredLabels = new Set<string>();
      for (const candidate of scoring.candidates) {
        const contestantId = blinded.deanonymize.get(candidate.blindLabel);
        if (contestantId === undefined) {
          throw new BlindJudgePanelError(
            `judge '${judge.judgeId}' scored unknown blind label '${candidate.blindLabel}' on unit '${unit.unitId}'`,
          );
        }
        if (scoredLabels.has(candidate.blindLabel)) {
          throw new BlindJudgePanelError(
            `judge '${judge.judgeId}' scored blind label '${candidate.blindLabel}' twice on unit '${unit.unitId}'`,
          );
        }
        scoredLabels.add(candidate.blindLabel);

        const seenDimensions = new Set<BenchmarkRubricDimensionId>();
        for (const dim of candidate.dimensions) {
          if (seenDimensions.has(dim.dimensionId)) {
            throw new BlindJudgePanelError(
              `judge '${judge.judgeId}' scored dimension '${dim.dimensionId}' twice for '${candidate.blindLabel}' on unit '${unit.unitId}'`,
            );
          }
          seenDimensions.add(dim.dimensionId);

          const citation = normalizeCitation(dim.citation);
          // §4.3 / §2.1 — a sub-4 score without a complete citation is dropped.
          if (dim.score < BENCHMARK_RUBRIC_CITATION_REQUIRED_BELOW_SCORE && citation === null) {
            unscorable.push({
              unitId: unit.unitId,
              contestantId,
              dimensionId: dim.dimensionId,
              judgeId: judge.judgeId,
              score: dim.score,
              reason: "missing_citation",
            });
            continue;
          }

          contestantDimensionScores.push({
            unitId: unit.unitId,
            contestantId,
            dimensionId: dim.dimensionId,
            judgeId: judge.judgeId,
            score: dim.score,
            citation,
          });

          const rows = scoresByDimension.get(dim.dimensionId) ?? [];
          rows.push({
            itemKey: `${unit.unitId} ${contestantId}`,
            judgeId: judge.judgeId,
            score: dim.score,
          });
          scoresByDimension.set(dim.dimensionId, rows);

          // §4.3 — a sub-4 (cited) score composes as an itotori-lqa-1 llm_qa finding.
          if (dim.score < BENCHMARK_RUBRIC_CITATION_REQUIRED_BELOW_SCORE && citation !== null) {
            findings.push(
              buildJudgeFinding({
                judge,
                unitId: unit.unitId,
                contestantId,
                dimensionId: dim.dimensionId,
                score: dim.score,
                citation,
                decodedContext: unit.decodedContext,
                providerRun: run,
              }),
            );
          }
        }
      }

      blindingAudit.push({
        judgeId: judge.judgeId,
        unitId: unit.unitId,
        deanonymize: Object.fromEntries(blinded.deanonymize),
        provenanceStripped: true,
      });
    }

    const micros = Number(judgeCostMicros);
    perJudgeCost.push({
      judgeId: judge.judgeId,
      modelId: judge.modelId,
      providerId: judge.providerId,
      costMicrosUsd: micros,
      zdr: judgeZdr,
    });
  }

  const totalMicrosUsd = perJudgeCost.reduce((sum, j) => sum + j.costMicrosUsd, 0);

  return {
    panelSeed: input.panelSeed,
    judges: input.judges.map((j) => ({
      judgeId: j.judgeId,
      modelId: j.modelId,
      providerId: j.providerId,
      modelFamily: j.modelFamily,
    })),
    modelFamilies: families,
    contestantDimensionScores,
    unscorable,
    agreementByDimension: interJudgeAgreementByDimension(scoresByDimension),
    findings,
    cost: { totalMicrosUsd, perJudge: perJudgeCost },
    blindingAudit,
  };
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/** A citation is retained only if all three parts are present and non-empty. */
function normalizeCitation(citation: JudgeCitation | null): JudgeCitation | null {
  if (citation === null) {
    return null;
  }
  const sourceSpan = citation.sourceSpan.trim();
  const decodedContextUsed = citation.decodedContextUsed.trim();
  const rationale = citation.rationale.trim();
  if (sourceSpan.length === 0 || decodedContextUsed.length === 0 || rationale.length === 0) {
    return null;
  }
  return { sourceSpan, decodedContextUsed, rationale };
}

function buildJudgeFinding(args: {
  judge: BlindJudgeAdapter;
  unitId: string;
  contestantId: string;
  dimensionId: BenchmarkRubricDimensionId;
  score: BenchmarkRubricScore;
  citation: JudgeCitation;
  decodedContext: DecodedGroundTruthContext;
  providerRun: ProviderRunRecord;
}): BenchmarkFindingRecordV02 {
  const severity = benchmarkRubricQualitySeverityForScore(args.score);
  if (severity === null) {
    // A 4 never reaches here (only sub-4 scores build findings).
    throw new BlindJudgePanelError(
      `internal: score ${args.score} on '${args.dimensionId}' has no defect severity`,
    );
  }
  const target = benchmarkRubricTaxonomyTargetForDimension(args.dimensionId);
  const findingId = deterministicUuid7(
    "blind-judge-finding",
    args.judge.judgeId,
    args.contestantId,
    args.unitId,
    args.dimensionId,
  );
  const provenanceId = deterministicUuid7("blind-judge-provenance", findingId);
  const evidenceId = deterministicUuid7("blind-judge-evidence", findingId);
  const label = `${args.dimensionId} score ${args.score} (judge ${args.judge.judgeId})`;
  return {
    findingId,
    systemId: args.contestantId,
    taxonomyId: TAXONOMY_ID,
    taxonomyVersion: TAXONOMY_VERSION,
    detectorKind: "llm_qa",
    category: target.category,
    ...(target.subcategory !== undefined ? { qualitySubcategory: target.subcategory } : {}),
    qualitySeverity: severity,
    // The judge scores QUALITY; root-cause attribution is the §10 backlog node's
    // job, not §4's — so a fresh judge finding is honestly unadjudicated.
    rootCause: "unknown_unadjudicated",
    adjudicationState: "unreviewed",
    affectedRefs: [{ subjectKind: "bridge_unit", subjectId: args.unitId, label }],
    evidence: [
      {
        evidenceId,
        evidenceKind: "text_excerpt",
        summary: args.citation.rationale,
        subjectRef: { subjectKind: "bridge_unit", subjectId: args.unitId, label },
        expectedValue: args.citation.decodedContextUsed,
        observedValue: args.citation.sourceSpan,
        provenanceIds: [provenanceId],
      },
    ],
    provenance: [
      {
        provenanceId,
        provenanceKind: "model_output",
        modelOutputId: deterministicUuid7("blind-judge-model-output", findingId),
        provider: args.providerRun.provider.requestedProviderId,
        model: args.providerRun.provider.actualModelId,
        outputHash: sha256HashOfScore(args),
      },
    ],
    reviewerRationale: args.citation.rationale,
  };
}

function sha256HashOfScore(args: {
  judge: BlindJudgeAdapter;
  unitId: string;
  contestantId: string;
  dimensionId: BenchmarkRubricDimensionId;
  score: BenchmarkRubricScore;
}): string {
  return `sha256:${sha256Hex(
    `${args.judge.judgeId}|${args.unitId}|${args.contestantId}|${args.dimensionId}|${args.score}`,
  )}`;
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
