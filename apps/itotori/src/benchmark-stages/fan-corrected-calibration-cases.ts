// benchmark-fan-corrected-calibration-cases — the contested-quality calibration
// crucible (§11.2).
//
// Methodology §11.2 (docs/itotori-translation-benchmark-methodology.md, the
// "fan-corrected-official calibration cases" bullet; Appendix A maps this node to
// §11.2). Chaos;Head NOAH (Committee of Zero fan patch) and Steins;Gate are cases
// where a FAN patch was made specifically to FIX a bad OFFICIAL localization over
// identical source text. They run on the MAGES engine, which is UNSUPPORTED here
// → TEXT-ONLY quality scoring, **no decode, no patchback** (see
// `FAN_CORRECTED_ENGINE`).
//
// TREVOR'S PRINCIPLE (the crux): do NOT assume pro = good and fan = bad, but
// ALSO do NOT lock in fans-know-best. On a genuinely contested line the "right"
// answer is CONTESTED and HUMAN-ADJUDICATED — it is NOT readable from provenance
// (which side is official vs fan). These cases therefore serve as the panel's
// CONTESTED-QUALITY calibration anchors: run the BLIND judge panel on the pair
// (the panel never learns which candidate is official vs fan) and compare its
// preference against the settled HUMAN adjudication. Does the panel agree with
// humans on hard, provenance-neutral cases? That agreement — not the provenance —
// is the signal. This pairs with §8 (human anchor) and §4.4 (a low-agreement
// dimension routes to human adjudication).
//
// What this module OWNS (per §11.2):
//   1. The fan-corrected CASE model (`FanCorrectedCase`): for a contested line,
//      the SOURCE, the OFFICIAL rendering, the FAN-CORRECTED rendering, and the
//      settled HUMAN-ADJUDICATED verdict on which is better (or that both fail /
//      both work / tie). The ground truth is the human adjudication — NOT which
//      rendering is fan vs official.
//   2. The blind judge-unit projection (`fanCorrectedJudgeUnits`): each case
//      becomes a `JudgeUnitInput` the §4 panel scores BLIND. MAGES is unsupported
//      so there is no decoded structure — the context is TEXT-ONLY (source line +
//      known speaker); the scene-dispatch fields are honest placeholders (no
//      decode). The panel's own §4.2 anonymization strips the official/fan
//      provenance before any judge sees a candidate.
//   3. The calibration flow (`buildFanCorrectedCalibration` /
//      `runFanCorrectedCalibration`): derive the panel's BLIND preference per
//      case (higher aggregate score wins; within `PANEL_PREFERENCE_TIE_THRESHOLD`
//      → tie) and compare it against the human adjudication → per-case + aggregate
//      agreement. This is contested-quality calibration.
//   4. Encoded NEUTRALITY (`FAN_CORRECTED_CALIBRATION_POLICY`,
//      `swapProvenanceRoles`, `assertPanelBlindToProvenance`): nothing in the flow
//      assumes official = correct or fan = correct. The panel input is blind to
//      provenance, and the panel-vs-human comparison is invariant under swapping
//      which side is labelled "official" — proven by `swapProvenanceRoles` + a
//      test.
//
// Copyright: the real C;H NOAH / Steins;Gate text is sourced PRIVATELY later
// (read-only-never-publish, identical to the vault policy). This module builds the
// STRUCTURE + calibration logic and is exercised with SYNTHETIC contested-line
// fixtures; NO copyrighted game text is committed. The private text plugs in by
// supplying real `FanCorrectedCase` values to the same functions — the shape and
// the flow do not change.
//
// Nothing here makes a network call; the calibration math is deterministic. Only
// `runFanCorrectedCalibration` drives the panel, and in tests that panel is the
// deterministic `FixtureJudge`.

import { BENCHMARK_QUALITY_RUBRIC } from "@itotori/localization-bridge-schema";
import {
  assertBlindJudgeInputHasNoProvenance,
  blindUnitForJudge,
  runBlindJudgePanel,
  type BlindJudgeAdapter,
  type BlindJudgePanelResult,
  type ContestantDimensionScore,
} from "./blind-judge-panel.js";
import type {
  ContestantCandidate,
  DecodedGroundTruthContext,
  JudgeUnitInput,
} from "./decoded-context-feed.js";

export class FanCorrectedCalibrationError extends Error {
  constructor(detail: string) {
    super(`fan-corrected-calibration refused: ${detail}`);
    this.name = "FanCorrectedCalibrationError";
  }
}

// ---------------------------------------------------------------------------
// Engine posture + neutrality policy (the §11.2 invariants, stamped in code).
// ---------------------------------------------------------------------------

/**
 * §11.2 — the fan-corrected cases are on the MAGES engine, which Itotori does
 * NOT support. They are TEXT-ONLY quality-scoring cases: NO decode, NO patchback.
 * Stamped on every calibration report so a consumer cannot mistake these for
 * decoded triple-tier contestants.
 */
export const FAN_CORRECTED_ENGINE = {
  engineFamily: "mages",
  supported: false,
  textOnly: true,
  decode: false,
  patchback: false,
  methodologyRef: "docs/itotori-translation-benchmark-methodology.md#112-corpus",
} as const;

/**
 * §11.2 NEUTRALITY invariant (Trevor's principle): the human adjudication is the
 * ground truth; NEITHER provenance is assumed authoritative. Do not assume
 * pro = good, do not lock in fan = best. Stamped on the calibration report and
 * asserted by `swapProvenanceRoles` invariance + `assertPanelBlindToProvenance`.
 */
export const FAN_CORRECTED_CALIBRATION_POLICY = {
  groundTruth: "human_adjudication",
  officialAssumedAuthoritative: false,
  fanAssumedAuthoritative: false,
  panelBlindToProvenance: true,
  methodologyRef: "docs/itotori-translation-benchmark-methodology.md#112-corpus",
} as const;

/**
 * §11.2 — the panel's aggregate scores for the two renderings must differ by at
 * least this many rubric points for the panel to be said to PREFER one; within it
 * the panel is "no clear winner" (a tie). Symmetric — it never breaks ties toward
 * either provenance. A quarter of a rubric point is the reasoned default (§12
 * meta-validity floors stay Trevor's; this is a reporting threshold).
 */
export const PANEL_PREFERENCE_TIE_THRESHOLD = 0.25;

// ---------------------------------------------------------------------------
// 1. The fan-corrected CASE model.
// ---------------------------------------------------------------------------

/**
 * The two provenance ROLES on a fan-corrected case. This is METADATA about where
 * a rendering came from — it is explicitly NOT a quality ordering (the whole
 * point of §11.2 is that provenance does not decide quality).
 */
export type FanCorrectedRenderingRole = "official" | "fan_corrected";

/**
 * The settled HUMAN adjudication of a contested line (§11.2). `official_better`
 * and `fan_corrected_better` are BOTH legitimate outcomes (that is the crux —
 * pro can be better, fan can be better); `tie` / `both_work` / `both_fail` are
 * the non-decisive outcomes. The verdict is a human JUDGMENT, never derived from
 * which rendering is official vs fan.
 */
export type ContestedVerdict =
  | "official_better"
  | "fan_corrected_better"
  | "tie"
  | "both_work"
  | "both_fail";

const CONTESTED_VERDICTS: ReadonlySet<string> = new Set<ContestedVerdict>([
  "official_better",
  "fan_corrected_better",
  "tie",
  "both_work",
  "both_fail",
]);

/**
 * One contested line: the source, the OFFICIAL rendering, the FAN-CORRECTED
 * rendering, and the settled HUMAN-ADJUDICATED verdict (§11.2). The private real
 * C;H NOAH / Steins;Gate text plugs in as real values of this same shape.
 */
export type FanCorrectedCase = {
  /** Stable case id (e.g. `chn-<hash>` / `sg-<hash>`). */
  caseId: string;
  /** UUID7 bridge-unit id the panel keys scores by. */
  unitId: string;
  /** The game (e.g. "Chaos;Head NOAH", "Steins;Gate") — metadata. */
  gameTitle: string;
  /**
   * The decoded speaker, when known from the script even absent full decode;
   * null for narration / unknown. Text-only — no scene-dispatch decode (MAGES
   * unsupported).
   */
  speaker: string | null;
  /** The decoded SOURCE line (untranslated). Held privately for real cases. */
  source: string;
  /** The OFFICIAL localization rendering of this line. Private for real cases. */
  official: string;
  /** The FAN-CORRECTED rendering (the fix). Private for real cases. */
  fanCorrected: string;
  /** The settled HUMAN-adjudicated verdict — the ground truth (§11.2). */
  humanVerdict: ContestedVerdict;
  /** The human adjudicator's rationale (why this verdict). */
  adjudicationRationale: string;
  /** Who adjudicated (rater id / panel id). */
  adjudicatedBy: string;
};

/**
 * Validate one fan-corrected case: ids/game present, both renderings present and
 * DISTINCT (a "correction" that equals the official is not a contested case), a
 * valid verdict, and a non-empty rationale. Throws on any violation. Does NOT
 * assume either provenance is authoritative — it only checks the case is
 * well-formed and adjudicated.
 */
export function assertFanCorrectedCase(input: FanCorrectedCase): void {
  if (input.caseId.trim().length === 0) {
    throw new FanCorrectedCalibrationError("case has an empty caseId");
  }
  if (input.unitId.trim().length === 0) {
    throw new FanCorrectedCalibrationError(`case '${input.caseId}' has an empty unitId`);
  }
  if (input.gameTitle.trim().length === 0) {
    throw new FanCorrectedCalibrationError(`case '${input.caseId}' has an empty gameTitle`);
  }
  if (input.source.trim().length === 0) {
    throw new FanCorrectedCalibrationError(`case '${input.caseId}' has an empty source line`);
  }
  if (input.official.trim().length === 0) {
    throw new FanCorrectedCalibrationError(
      `case '${input.caseId}' has an empty official rendering`,
    );
  }
  if (input.fanCorrected.trim().length === 0) {
    throw new FanCorrectedCalibrationError(
      `case '${input.caseId}' has an empty fan-corrected rendering`,
    );
  }
  if (input.official.trim() === input.fanCorrected.trim()) {
    throw new FanCorrectedCalibrationError(
      `case '${input.caseId}' official and fan-corrected renderings are identical — not a contested line`,
    );
  }
  if (!CONTESTED_VERDICTS.has(input.humanVerdict)) {
    throw new FanCorrectedCalibrationError(
      `case '${input.caseId}' carries unknown human verdict '${input.humanVerdict}'`,
    );
  }
  if (input.adjudicationRationale.trim().length === 0) {
    throw new FanCorrectedCalibrationError(
      `case '${input.caseId}' has no adjudication rationale — the verdict must be a reasoned HUMAN call (§11.2)`,
    );
  }
  if (input.adjudicatedBy.trim().length === 0) {
    throw new FanCorrectedCalibrationError(`case '${input.caseId}' has no adjudicator`);
  }
}

/**
 * The human's PREFERRED role for a case, or null when the verdict is not decisive
 * (`tie` / `both_work` / `both_fail`). This maps the verdict to a directional
 * preference for the calibration comparison; it does NOT privilege either role.
 */
export function adjudicationPreferredRole(
  verdict: ContestedVerdict,
): FanCorrectedRenderingRole | null {
  switch (verdict) {
    case "official_better":
      return "official";
    case "fan_corrected_better":
      return "fan_corrected";
    case "tie":
    case "both_work":
    case "both_fail":
      return null;
  }
}

// ---------------------------------------------------------------------------
// Neutrality helper — swap which side is "official" vs "fan".
// ---------------------------------------------------------------------------

/**
 * Return a case with the OFFICIAL and FAN-CORRECTED renderings relabelled
 * (swapped) while the SAME TEXT keeps the SAME human judgment — the decisive
 * verdict flips direction (`official_better` ↔ `fan_corrected_better`),
 * non-decisive verdicts are unchanged. This models "what if the official studio
 * had shipped the fan text and vice-versa": the actual texts, and which text the
 * human prefers, are unchanged; only the provenance label moves. Used to PROVE
 * the calibration is provenance-neutral (agreement is invariant under this swap).
 */
export function swapProvenanceRoles(input: FanCorrectedCase): FanCorrectedCase {
  return {
    ...input,
    caseId: `${input.caseId}#swapped`,
    official: input.fanCorrected,
    fanCorrected: input.official,
    humanVerdict: swapVerdict(input.humanVerdict),
  };
}

function swapVerdict(verdict: ContestedVerdict): ContestedVerdict {
  if (verdict === "official_better") {
    return "fan_corrected_better";
  }
  if (verdict === "fan_corrected_better") {
    return "official_better";
  }
  return verdict;
}

// ---------------------------------------------------------------------------
// 2. The blind judge-unit projection (TEXT-ONLY, no decode).
// ---------------------------------------------------------------------------

/**
 * The text-only decoded context for a MAGES case. There is NO decoded
 * scene-dispatch graph (engine unsupported), so `scene` carries honest
 * placeholders: `dispatchOrderLength: 0` and null positions signal "no decode".
 * The judge still gets the meaningful ground truth it can use: the source line
 * and (when known) the speaker.
 */
function textOnlyContext(input: FanCorrectedCase): DecodedGroundTruthContext {
  return {
    unitId: input.unitId,
    speaker: input.speaker,
    sourceLine: input.source,
    textSurface: null,
    scene: {
      // MAGES is unsupported — there is no decoded scene id/graph. These are
      // placeholders marking "text-only, no decode" (§11.2).
      sceneId: 0,
      dispatchPosition: null,
      dispatchOrderLength: 0,
      nextScene: null,
    },
    branch: null,
  };
}

/**
 * Project fan-corrected cases into the §4 panel's `JudgeUnitInput[]`. Each case
 * becomes one unit with two candidates keyed by the provenance ROLE as the real
 * contestant id (`official` / `fan_corrected`) — the panel's own §4.2
 * anonymization then strips that role to `candidate-a/b` before any judge sees
 * it. Validates every case first. Not built via `buildDecodedContextFeed`
 * (there is no `NarrativeStructure` for an unsupported engine — text-only).
 */
export function fanCorrectedJudgeUnits(cases: readonly FanCorrectedCase[]): JudgeUnitInput[] {
  if (cases.length === 0) {
    throw new FanCorrectedCalibrationError("no fan-corrected cases supplied");
  }
  const seenCaseIds = new Set<string>();
  const seenUnitIds = new Set<string>();
  const feed: JudgeUnitInput[] = [];
  for (const input of cases) {
    assertFanCorrectedCase(input);
    if (seenCaseIds.has(input.caseId)) {
      throw new FanCorrectedCalibrationError(`duplicate case id '${input.caseId}'`);
    }
    seenCaseIds.add(input.caseId);
    if (seenUnitIds.has(input.unitId)) {
      throw new FanCorrectedCalibrationError(`duplicate unit id '${input.unitId}'`);
    }
    seenUnitIds.add(input.unitId);

    const candidates: ContestantCandidate[] = [
      { contestantId: "official", unitId: input.unitId, candidateText: input.official },
      { contestantId: "fan_corrected", unitId: input.unitId, candidateText: input.fanCorrected },
    ];
    feed.push({ unitId: input.unitId, decodedContext: textOnlyContext(input), candidates });
  }
  return feed;
}

/**
 * §4.2 / §11.2 blindness guard, made explicit for the fan-corrected flow: run the
 * REAL panel blinding (`blindUnitForJudge`) over each unit and prove the resulting
 * judge-facing input leaks NO `official` / `fan_corrected` provenance role — the
 * judge sees `candidate-a/b` + text only, exactly as the panel guarantees. Throws
 * on any leak. Exposed so a test can assert the panel input is provenance-blind
 * for the fan-corrected cases specifically.
 */
export function assertPanelBlindToProvenance(feed: readonly JudgeUnitInput[]): void {
  const roles: readonly string[] = ["official", "fan_corrected"];
  for (const unit of feed) {
    const blinded = blindUnitForJudge(unit, BENCHMARK_QUALITY_RUBRIC, "blindness-probe", "probe");
    assertBlindJudgeInputHasNoProvenance(blinded.input, roles);
  }
}

// ---------------------------------------------------------------------------
// 3. The calibration flow — panel BLIND preference vs HUMAN adjudication.
// ---------------------------------------------------------------------------

/** The panel's aggregate preference on one case, derived from BLIND scores. */
export type PanelCasePreference = {
  /** Mean panel score for the official rendering (over judges × dimensions). */
  officialMean: number | null;
  /** Mean panel score for the fan-corrected rendering. */
  fanCorrectedMean: number | null;
  /** Which role the panel preferred, or null within the tie threshold. */
  preferredRole: FanCorrectedRenderingRole | null;
  /** Number of (judge × dimension) scores backing the means. */
  itemsScored: number;
};

/** Per-case calibration: panel BLIND preference vs the HUMAN adjudication. */
export type FanCorrectedCaseCalibration = {
  caseId: string;
  unitId: string;
  gameTitle: string;
  /** The settled human verdict (the ground truth). */
  humanVerdict: ContestedVerdict;
  /** The human's directional preference (null = non-decisive verdict). */
  humanPreferredRole: FanCorrectedRenderingRole | null;
  /** The panel's BLIND aggregate preference. */
  panel: PanelCasePreference;
  /**
   * Whether the panel's BLIND preference matched the human adjudication. Both
   * "no clear winner" (panel tie + non-decisive human verdict) counts as a match.
   */
  agrees: boolean;
};

export type FanCorrectedCalibrationReport = {
  /** §11.2 neutrality policy — neither provenance is assumed authoritative. */
  policy: typeof FAN_CORRECTED_CALIBRATION_POLICY;
  /** MAGES text-only posture — no decode, no patchback. */
  engine: typeof FAN_CORRECTED_ENGINE;
  /** The symmetric tie threshold used to derive the panel preference. */
  tieThreshold: number;
  /** The judge ids whose BLIND scores backed this calibration. */
  judgeIds: string[];
  /** Per-case panel-vs-human calibration. */
  byCase: FanCorrectedCaseCalibration[];
  aggregate: {
    /** Cases with at least one panel score (both renderings scored). */
    casesCompared: number;
    /** Cases where the panel preference matched the human adjudication. */
    agreements: number;
    /** agreements / casesCompared, or null when nothing was compared. */
    agreementRate: number | null;
    /** Cases where the HUMAN saw a clear winner (decisive verdict). */
    decisiveHumanCases: number;
    /** Of the decisive cases, how many the panel also called for that winner. */
    decisiveAgreements: number;
    /** decisiveAgreements / decisiveHumanCases, or null when none are decisive. */
    decisiveAgreementRate: number | null;
  };
};

export type BuildFanCorrectedCalibrationInput = {
  cases: readonly FanCorrectedCase[];
  /** §4 panel scores (`BlindJudgePanelResult.contestantDimensionScores`). */
  panelScores: readonly ContestantDimensionScore[];
  /** Override the symmetric tie threshold (default {@link PANEL_PREFERENCE_TIE_THRESHOLD}). */
  tieThreshold?: number;
};

/**
 * Compare the §4 panel's BLIND per-case preference against the settled HUMAN
 * adjudication (§11.2). For each case, aggregate the panel's scores for the
 * `official` and `fan_corrected` renderings (mean over judges × dimensions),
 * derive the panel's preferred role via the SYMMETRIC tie threshold, and check it
 * against the human verdict. Reports per-case + aggregate agreement, including a
 * decisive-only cut (cases where the human saw a clear winner) — the sharpest
 * read on whether the panel tracks humans on genuinely contested lines.
 *
 * The panel scores are consumed BLIND (they arrive keyed by the de-anonymized
 * role, but the panel never saw the role — §4.2). Nothing here privileges either
 * provenance.
 */
export function buildFanCorrectedCalibration(
  input: BuildFanCorrectedCalibrationInput,
): FanCorrectedCalibrationReport {
  if (input.cases.length === 0) {
    throw new FanCorrectedCalibrationError("no fan-corrected cases to calibrate");
  }
  const tieThreshold = input.tieThreshold ?? PANEL_PREFERENCE_TIE_THRESHOLD;
  if (!(tieThreshold >= 0)) {
    throw new FanCorrectedCalibrationError(`tie threshold must be ≥ 0, got ${tieThreshold}`);
  }

  // Index panel scores by (unitId, contestantId).
  const byUnitRole = new Map<string, number[]>();
  const judgeIds = new Set<string>();
  for (const score of input.panelScores) {
    judgeIds.add(score.judgeId);
    const key = `${score.unitId} ${score.contestantId}`;
    const list = byUnitRole.get(key) ?? [];
    list.push(score.score);
    byUnitRole.set(key, list);
  }

  const byCase: FanCorrectedCaseCalibration[] = [];
  let casesCompared = 0;
  let agreements = 0;
  let decisiveHumanCases = 0;
  let decisiveAgreements = 0;

  const seenUnitIds = new Set<string>();
  for (const fanCase of input.cases) {
    assertFanCorrectedCase(fanCase);
    if (seenUnitIds.has(fanCase.unitId)) {
      throw new FanCorrectedCalibrationError(`duplicate unit id '${fanCase.unitId}'`);
    }
    seenUnitIds.add(fanCase.unitId);

    const officialScores = byUnitRole.get(`${fanCase.unitId} official`) ?? [];
    const fanScores = byUnitRole.get(`${fanCase.unitId} fan_corrected`) ?? [];
    const officialMean = officialScores.length === 0 ? null : mean(officialScores);
    const fanCorrectedMean = fanScores.length === 0 ? null : mean(fanScores);
    const preferredRole = panelPreferredRole(officialMean, fanCorrectedMean, tieThreshold);
    const panel: PanelCasePreference = {
      officialMean: nullableRound(officialMean),
      fanCorrectedMean: nullableRound(fanCorrectedMean),
      preferredRole,
      itemsScored: officialScores.length + fanScores.length,
    };

    const humanPreferredRole = adjudicationPreferredRole(fanCase.humanVerdict);
    const compared = officialMean !== null && fanCorrectedMean !== null;
    const agrees = compared && preferredRole === humanPreferredRole;

    if (compared) {
      casesCompared += 1;
      if (agrees) {
        agreements += 1;
      }
      if (humanPreferredRole !== null) {
        decisiveHumanCases += 1;
        if (agrees) {
          decisiveAgreements += 1;
        }
      }
    }

    byCase.push({
      caseId: fanCase.caseId,
      unitId: fanCase.unitId,
      gameTitle: fanCase.gameTitle,
      humanVerdict: fanCase.humanVerdict,
      humanPreferredRole,
      panel,
      agrees,
    });
  }

  return {
    policy: FAN_CORRECTED_CALIBRATION_POLICY,
    engine: FAN_CORRECTED_ENGINE,
    tieThreshold,
    judgeIds: [...judgeIds].sort(),
    byCase,
    aggregate: {
      casesCompared,
      agreements,
      agreementRate: casesCompared === 0 ? null : round(agreements / casesCompared),
      decisiveHumanCases,
      decisiveAgreements,
      decisiveAgreementRate:
        decisiveHumanCases === 0 ? null : round(decisiveAgreements / decisiveHumanCases),
    },
  };
}

export type RunFanCorrectedCalibrationInput = {
  cases: readonly FanCorrectedCase[];
  /** The §4 judges (must span ≥ `minModelFamilies` families — the panel enforces). */
  judges: BlindJudgeAdapter[];
  /** Deterministic seed for the §4.2 order randomization. */
  panelSeed: string;
  /** Optional §4.1 family floor override (the panel defaults to ≥2). */
  minModelFamilies?: number;
  /** Optional symmetric tie threshold override. */
  tieThreshold?: number;
};

export type RunFanCorrectedCalibrationResult = {
  panel: BlindJudgePanelResult;
  report: FanCorrectedCalibrationReport;
};

/**
 * End-to-end contested-quality calibration (§11.2): project the cases into the
 * §4 judge feed (text-only), run the BLIND judge panel over them, and calibrate
 * its preference against the human adjudication. The panel anonymizes provenance
 * itself, so no judge ever learns which candidate is official vs fan.
 */
export async function runFanCorrectedCalibration(
  input: RunFanCorrectedCalibrationInput,
): Promise<RunFanCorrectedCalibrationResult> {
  const feed = fanCorrectedJudgeUnits(input.cases);
  const panel = await runBlindJudgePanel({
    feed,
    judges: input.judges,
    panelSeed: input.panelSeed,
    ...(input.minModelFamilies !== undefined ? { minModelFamilies: input.minModelFamilies } : {}),
  });
  const report = buildFanCorrectedCalibration({
    cases: input.cases,
    panelScores: panel.contestantDimensionScores,
    ...(input.tieThreshold !== undefined ? { tieThreshold: input.tieThreshold } : {}),
  });
  return { panel, report };
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/**
 * The panel's preferred role from the two aggregate means, applying the SYMMETRIC
 * tie threshold. Returns null (no clear winner) when either mean is missing or the
 * gap is below the threshold. Symmetric: it never breaks a tie toward either
 * provenance.
 */
function panelPreferredRole(
  officialMean: number | null,
  fanCorrectedMean: number | null,
  tieThreshold: number,
): FanCorrectedRenderingRole | null {
  if (officialMean === null || fanCorrectedMean === null) {
    return null;
  }
  const diff = officialMean - fanCorrectedMean;
  if (Math.abs(diff) < tieThreshold) {
    return null;
  }
  return diff > 0 ? "official" : "fan_corrected";
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function nullableRound(value: number | null): number | null {
  return value === null ? null : round(value);
}
